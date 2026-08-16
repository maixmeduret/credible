<?php
/**
 * First-party proxy: serve the tracker and receive events on this domain.
 *
 * WHY THIS EXISTS
 * Content blockers filter requests by hostname. A tracker loaded from
 * stats.example.com is missing from a real slice of a site's traffic, while
 * the same file loaded from example.com is not. Pasting a snippet cannot fix
 * that; a plugin running inside the site can, and it is the single reason
 * most people install an analytics plugin instead of copying four lines of
 * HTML. So this class answers two URLs on the site's own domain:
 *
 *   https://example.com/<slug>/js/cr.js    the tracker, cached and passed through
 *   https://example.com/<slug>/api/event   events, forwarded server-side
 *
 * TWO ROUTES TO THE SAME HANDLERS
 * Rewrite rules give the pretty paths above, which is what you want: they
 * look like part of the site and carry no recognisable word. They need
 * permalinks to be anything other than "Plain", so REST routes are registered
 * as well and used automatically when they are not available. Both call the
 * same two methods.
 *
 * WHAT IS FORWARDED, AND WHY IT MATTERS
 * The visitor's User-Agent (the instance drops anything that does not look
 * like a browser, so sending WordPress's own agent would drop every event),
 * the visitor's IP as X-Forwarded-For (the visitor hash and the per-site IP
 * exclusions are derived from it), and the edge geography headers a CDN may
 * have added. Requires CREDIBLE_TRUST_PROXY=true on the instance.
 *
 * @package CredibleAnalytics
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Serves the tracker and forwards events from this site's own domain.
 */
class Credible_Analytics_Proxy {

	/** Query variable the rewrite rules resolve to. */
	const QUERY_VAR = 'credible_proxy';

	/** REST namespace used when pretty permalinks are unavailable. */
	const REST_NS = 'credible/v1';

	/** Option set when the rewrite rules need regenerating. */
	const FLUSH_FLAG = 'credible_analytics_flush_rewrites';

	/** Option holding the cached tracker. */
	const CACHE_OPTION = 'credible_analytics_script_cache';

	/** How long a cached tracker is served before it is refetched. */
	const CACHE_TTL = 12 * HOUR_IN_SECONDS;

	/** Largest event body accepted, mirroring the instance's own 32 KB cap. */
	const MAX_BODY = 32768;

	/** Seconds to wait for the instance before giving up on one event. */
	const FORWARD_TIMEOUT = 4;

	/**
	 * Most tracker bytes we will read from the instance, and store.
	 *
	 * The tracker is around 13 KB. This is not a defence against the configured
	 * instance — an administrator who points the plugin at a hostile host has
	 * already lost, since whatever comes back is served as JavaScript on their
	 * own origin. It is a cap on how badly a misconfigured or compromised URL
	 * can go wrong: without it, wp_remote_get() will read a response of any
	 * size into memory and script_body() will then write it into an option.
	 */
	const MAX_SCRIPT_BYTES = 262144;

	/**
	 * Hook everything up.
	 *
	 * @return void
	 */
	public function register() {
		add_action( 'init', array( $this, 'add_rewrite_rules' ) );
		add_action( 'init', array( $this, 'maybe_flush_rules' ), 20 );
		add_filter( 'query_vars', array( $this, 'add_query_var' ) );
		add_action( 'parse_request', array( $this, 'maybe_handle' ) );
		add_action( 'rest_api_init', array( $this, 'register_routes' ) );
	}

	/* ------------------------------------------------------------------ *
	 * State
	 * ------------------------------------------------------------------ */

	/**
	 * Is the proxy switched on and usable?
	 *
	 * @return bool
	 */
	public function is_active() {
		return (bool) Credible_Analytics_Settings::get( 'proxy_enabled' )
			&& Credible_Analytics_Settings::is_configured();
	}

	/**
	 * Can we use the pretty paths, or do we fall back to the REST routes?
	 *
	 * @return bool
	 */
	public function has_pretty_permalinks() {
		return '' !== (string) get_option( 'permalink_structure' );
	}

	/**
	 * URL the tracker is served from.
	 *
	 * @return string
	 */
	public function script_url() {
		if ( $this->has_pretty_permalinks() ) {
			return home_url( '/' . Credible_Analytics_Settings::proxy_slug() . '/js/cr.js' );
		}
		return rest_url( self::REST_NS . '/script' );
	}

	/**
	 * URL events are posted to.
	 *
	 * The tracker would normally derive this from its own src by swapping the
	 * trailing /js/<file> for /api/event, which the pretty path is shaped for.
	 * The plugin sets data-api explicitly anyway, so the REST fallback — whose
	 * path has no /js/ segment to swap — works identically.
	 *
	 * @return string
	 */
	public function event_url() {
		if ( $this->has_pretty_permalinks() ) {
			return home_url( '/' . Credible_Analytics_Settings::proxy_slug() . '/api/event' );
		}
		return rest_url( self::REST_NS . '/event' );
	}

	/* ------------------------------------------------------------------ *
	 * Routing
	 * ------------------------------------------------------------------ */

	/**
	 * Register the two pretty paths.
	 *
	 * @return void
	 */
	public function add_rewrite_rules() {
		if ( ! $this->is_active() ) {
			return;
		}
		// WP interpolates these into a `#^...#` match, so the slug is quoted
		// against that delimiter even though sanitize_title only ever returns
		// [a-z0-9-].
		$slug = preg_quote( Credible_Analytics_Settings::proxy_slug(), '#' );
		add_rewrite_rule( '^' . $slug . '/js/cr\.js$', 'index.php?' . self::QUERY_VAR . '=script', 'top' );
		add_rewrite_rule( '^' . $slug . '/api/event$', 'index.php?' . self::QUERY_VAR . '=event', 'top' );
	}

	/**
	 * Regenerate the rules after the slug or the switch changed.
	 *
	 * A soft flush: the rules resolve to index.php, which WordPress already
	 * routes everything through, so there is nothing to write to .htaccess and
	 * no reason to require it to be writable.
	 *
	 * @return void
	 */
	public function maybe_flush_rules() {
		if ( ! get_option( self::FLUSH_FLAG ) ) {
			return;
		}
		delete_option( self::FLUSH_FLAG );
		flush_rewrite_rules( false );
	}

	/**
	 * Make the query variable visible to WP::parse_request.
	 *
	 * @param array $vars Public query variables.
	 * @return array
	 */
	public function add_query_var( $vars ) {
		$vars[] = self::QUERY_VAR;
		return $vars;
	}

	/**
	 * Answer a proxied request, if this is one.
	 *
	 * @param WP $wp Current request.
	 * @return void
	 */
	public function maybe_handle( $wp ) {
		if ( empty( $wp->query_vars[ self::QUERY_VAR ] ) || ! $this->is_active() ) {
			return; // Not ours, or switched off: let WordPress 404 it normally.
		}
		$this->do_not_cache();

		$what = sanitize_key( $wp->query_vars[ self::QUERY_VAR ] );
		if ( 'script' === $what ) {
			$this->serve_script();
		} elseif ( 'event' === $what ) {
			$this->forward_event( null );
		}
	}

	/**
	 * Keep page-cache plugins out of these two responses.
	 *
	 * DONOTCACHEPAGE is the constant WP Super Cache, W3 Total Cache, WP Rocket
	 * and LiteSpeed all honour. Without it a cache that buffers output from
	 * `init` onwards can store the tracker as though it were a page and serve
	 * it back with an HTML content type, which breaks it in a way that is
	 * genuinely hard to diagnose from the browser.
	 *
	 * @return void
	 */
	private function do_not_cache() {
		if ( ! defined( 'DONOTCACHEPAGE' ) ) {
			define( 'DONOTCACHEPAGE', true );
		}
	}

	/**
	 * Register the fallback REST routes.
	 *
	 * Both are deliberately public: this is an ingestion endpoint for anonymous
	 * visitors, and requiring a nonce would break every cached page.
	 *
	 * @return void
	 */
	public function register_routes() {
		register_rest_route(
			self::REST_NS,
			'/script',
			array(
				'methods'             => 'GET',
				'callback'            => array( $this, 'rest_script' ),
				'permission_callback' => '__return_true',
			)
		);
		register_rest_route(
			self::REST_NS,
			'/event',
			array(
				'methods'             => 'POST',
				'callback'            => array( $this, 'rest_event' ),
				'permission_callback' => '__return_true',
			)
		);
	}

	/**
	 * REST entry point for the tracker.
	 *
	 * Sends its own headers and exits rather than returning a response: the
	 * body is JavaScript, and the REST server would serialise it as JSON.
	 *
	 * @return void
	 */
	public function rest_script() {
		if ( ! $this->is_active() ) {
			status_header( 404 );
			exit;
		}
		$this->do_not_cache();
		$this->serve_script();
	}

	/**
	 * REST entry point for events.
	 *
	 * @param WP_REST_Request $request Incoming request.
	 * @return void
	 */
	public function rest_event( $request ) {
		if ( ! $this->is_active() ) {
			status_header( 404 );
			exit;
		}
		$this->do_not_cache();
		$this->forward_event( $request->get_body() );
	}

	/* ------------------------------------------------------------------ *
	 * Serving the tracker
	 * ------------------------------------------------------------------ */

	/**
	 * Send the tracker to the browser, then stop.
	 *
	 * @return void
	 */
	private function serve_script() {
		$script = $this->script_body();

		if ( null === $script ) {
			// A missing tracker is a lost pageview, never a broken page: answer
			// with valid JavaScript and forbid caching so the next hit retries.
			status_header( 502 );
			nocache_headers();
			header( 'Content-Type: application/javascript; charset=utf-8' );
			echo '/* Credible: the tracker could not be fetched from the instance. */';
			exit;
		}

		status_header( 200 );
		header( 'Content-Type: application/javascript; charset=utf-8' );
		header( 'Cache-Control: public, max-age=3600, must-revalidate' );
		header( 'X-Credible-Proxy: wordpress' );
		header( 'Content-Length: ' . strlen( $script ) );
		// Not escaped on purpose: this is JavaScript fetched from the configured
		// instance and served with a JavaScript content type. It is never
		// interpolated into HTML, so HTML escaping would only corrupt it.
		echo $script; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
		exit;
	}

	/**
	 * The cached tracker, refetched when stale.
	 *
	 * @return string|null Null when there is nothing to serve at all.
	 */
	private function script_body() {
		$cache = get_option( self::CACHE_OPTION );
		$has   = is_array( $cache ) && isset( $cache['body'], $cache['fetched'] );

		if ( $has && ( time() - (int) $cache['fetched'] ) < self::CACHE_TTL ) {
			return (string) $cache['body'];
		}

		$fetched = $this->fetch_script( $has && isset( $cache['etag'] ) ? (string) $cache['etag'] : '', $cache );
		if ( null !== $fetched ) {
			// Not autoloaded: this is 13 KB that only the proxy path ever reads.
			update_option( self::CACHE_OPTION, $fetched, false );
			return (string) $fetched['body'];
		}

		// The instance is unreachable. A tracker a few hours old still counts
		// visitors correctly, so serving the stale copy beats serving nothing.
		return $has ? (string) $cache['body'] : null;
	}

	/**
	 * Fetch the tracker from the instance.
	 *
	 * @param string $etag  ETag of the copy we already hold, if any.
	 * @param mixed  $cache The current cache entry, reused on a 304.
	 * @return array|null array{body:string,etag:string,fetched:int}, or null on failure.
	 */
	private function fetch_script( $etag, $cache ) {
		$instance = Credible_Analytics_Settings::instance_url();
		if ( '' === $instance ) {
			return null;
		}

		$headers = array();
		if ( '' !== $etag ) {
			$headers['If-None-Match'] = $etag;
		}

		// wp_remote_get(), not wp_safe_remote_get(): the safe variant runs the
		// URL through wp_http_validate_url(), which rejects private and
		// loopback addresses. Self-hosting a Credible instance at
		// http://10.0.0.5:3000 or on the same box is exactly the normal case
		// here, so the safe variant would break the setups this plugin exists
		// for. The URL is not attacker-supplied: only manage_options can set
		// it, and the sanitiser already restricts it to http(s).
		$response = wp_remote_get(
			$instance . '/js/cr.js',
			array(
				'timeout'             => 8,
				'headers'             => $headers,
				'limit_response_size' => self::MAX_SCRIPT_BYTES,
			)
		);
		if ( is_wp_error( $response ) ) {
			return null;
		}

		$code = (int) wp_remote_retrieve_response_code( $response );

		if ( 304 === $code && is_array( $cache ) && isset( $cache['body'] ) ) {
			// Unchanged. Keep the body and push the freshness window forward.
			$cache['fetched'] = time();
			return $cache;
		}

		if ( 200 !== $code ) {
			return null;
		}

		$body = wp_remote_retrieve_body( $response );
		if ( ! is_string( $body ) || '' === trim( $body ) ) {
			return null;
		}

		return array(
			'body'    => $body,
			'etag'    => (string) wp_remote_retrieve_header( $response, 'etag' ),
			'fetched' => time(),
		);
	}

	/* ------------------------------------------------------------------ *
	 * Forwarding events
	 * ------------------------------------------------------------------ */

	/**
	 * Pass one event to the instance, then answer the browser.
	 *
	 * The answer is always 202 with an empty body, whatever happened upstream —
	 * the instance itself answers 202 for events it accepts and then drops, and
	 * a visitor's browser has nothing useful to do with a failure here.
	 *
	 * @param string|null $body Raw request body, or null to read it from the input stream.
	 * @return void
	 */
	private function forward_event( $body ) {
		if ( null === $body ) {
			$body = $this->read_input();
		}

		if ( is_string( $body ) && '' !== $body && strlen( $body ) <= self::MAX_BODY ) {
			wp_remote_post(
				Credible_Analytics_Settings::instance_url() . '/api/event',
				array(
					'timeout'     => self::FORWARD_TIMEOUT,
					'redirection' => 0,
					'blocking'    => true,
					'httpversion' => '1.1',
					// The instance rejects any User-Agent that does not look
					// like a browser, so forwarding WordPress's own would drop
					// every single event as a bot.
					'user-agent'  => $this->visitor_user_agent(),
					'headers'     => $this->forwarded_headers(),
					'body'        => $body,
				)
			);
		}

		status_header( 202 );
		nocache_headers();
		header( 'Content-Length: 0' );
		header( 'X-Credible-Proxy: wordpress' );
		exit;
	}

	/**
	 * The raw request body.
	 *
	 * Read from the input stream because the payload is text/plain JSON, which
	 * PHP does not populate $_POST from. It is re-readable, so doing this after
	 * the REST server has already looked is safe.
	 *
	 * Content-Length is checked first, and the read itself is capped, so a
	 * request advertising — or quietly sending — far more than an event can be
	 * does not pull it all into memory only to have forward_event() throw it
	 * away a moment later. php.ini's post_max_size is the usual backstop, but
	 * it defaults to 8 MB, which is 256 times the largest event this endpoint
	 * will ever forward.
	 *
	 * @return string
	 */
	private function read_input() {
		if ( isset( $_SERVER['CONTENT_LENGTH'] ) && (int) $_SERVER['CONTENT_LENGTH'] > self::MAX_BODY ) {
			return '';
		}
		// One byte over the cap, so an oversized body that understated its
		// length still fails the length test in forward_event() rather than
		// being truncated into something that looks valid.
		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents
		$raw = file_get_contents( 'php://input', false, null, 0, self::MAX_BODY + 1 );
		return is_string( $raw ) ? $raw : '';
	}

	/**
	 * The visitor's User-Agent, or an empty string.
	 *
	 * @return string
	 */
	private function visitor_user_agent() {
		if ( empty( $_SERVER['HTTP_USER_AGENT'] ) ) {
			return '';
		}
		return substr( sanitize_text_field( wp_unslash( $_SERVER['HTTP_USER_AGENT'] ) ), 0, 512 );
	}

	/**
	 * Headers to send with the forwarded event.
	 *
	 * @return array
	 */
	private function forwarded_headers() {
		$headers = array( 'Content-Type' => 'text/plain' );

		$ip = $this->client_ip();
		if ( '' !== $ip ) {
			$headers['X-Forwarded-For'] = $ip;
		}

		// A CDN in front of WordPress resolves geography far more accurately
		// than an IP database can. These are the headers the instance reads;
		// without them a proxied site loses its map.
		$edge = array(
			'HTTP_CF_IPCOUNTRY'                        => 'CF-IPCountry',
			'HTTP_CF_REGION'                           => 'CF-Region',
			'HTTP_CF_IPCITY'                           => 'CF-IPCity',
			'HTTP_X_VERCEL_IP_COUNTRY'                 => 'X-Vercel-IP-Country',
			'HTTP_X_VERCEL_IP_COUNTRY_REGION'          => 'X-Vercel-IP-Country-Region',
			'HTTP_X_VERCEL_IP_CITY'                    => 'X-Vercel-IP-City',
			'HTTP_CLOUDFRONT_VIEWER_COUNTRY'           => 'CloudFront-Viewer-Country',
			'HTTP_CLOUDFRONT_VIEWER_COUNTRY_REGION_NAME' => 'CloudFront-Viewer-Country-Region-Name',
			'HTTP_CLOUDFRONT_VIEWER_CITY'              => 'CloudFront-Viewer-City',
			'HTTP_X_NF_CLIENT_CONNECTION_COUNTRY'      => 'X-NF-Client-Connection-Country',
			'HTTP_FASTLY_GEO_COUNTRY'                  => 'Fastly-Geo-Country',
		);
		foreach ( $edge as $server_key => $header ) {
			if ( ! empty( $_SERVER[ $server_key ] ) ) {
				$headers[ $header ] = substr( sanitize_text_field( wp_unslash( $_SERVER[ $server_key ] ) ), 0, 128 );
			}
		}

		return $headers;
	}

	/**
	 * The visitor's IP address.
	 *
	 * Only ever forwarded, never stored: the instance hashes it with a daily
	 * rotating salt and discards it, and this plugin keeps no log of its own.
	 *
	 * @return string Empty when nothing valid was found.
	 */
	private function client_ip() {
		$candidates = array( 'HTTP_CF_CONNECTING_IP', 'HTTP_X_REAL_IP', 'HTTP_X_FORWARDED_FOR', 'REMOTE_ADDR' );
		foreach ( $candidates as $key ) {
			if ( empty( $_SERVER[ $key ] ) ) {
				continue;
			}
			$value = sanitize_text_field( wp_unslash( $_SERVER[ $key ] ) );
			// X-Forwarded-For is a chain; the client is the first entry.
			foreach ( explode( ',', $value ) as $candidate ) {
				$ip = trim( $candidate );
				if ( filter_var( $ip, FILTER_VALIDATE_IP ) ) {
					return $ip;
				}
			}
		}
		return '';
	}

	/* ------------------------------------------------------------------ *
	 * Activation
	 * ------------------------------------------------------------------ */

	/**
	 * Seed the settings and publish the rewrite rules.
	 *
	 * @return void
	 */
	public static function on_activate() {
		Credible_Analytics_Settings::seed_defaults();
		$proxy = new self();
		$proxy->add_rewrite_rules();
		flush_rewrite_rules( false );
	}

	/**
	 * Take the rewrite rules back out again.
	 *
	 * @return void
	 */
	public static function on_deactivate() {
		delete_option( self::FLUSH_FLAG );
		flush_rewrite_rules( false );
	}
}
