<?php
/**
 * Option storage, sanitisation and the Settings -> Credible screen.
 *
 * Everything the plugin knows lives in one option, `credible_analytics_settings`,
 * as a flat array. One option means one sanitise callback, one autoloaded row,
 * and no chance of the pieces disagreeing after a partial save.
 *
 * @package CredibleAnalytics
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Settings storage and admin UI.
 */
class Credible_Analytics_Settings {

	/** Option holding every setting. */
	const OPTION = 'credible_analytics_settings';

	/** Settings API group, and the slug of the admin page. */
	const GROUP = 'credible_analytics';

	/** Admin page slug under Settings. */
	const PAGE = 'credible-analytics';

	/** Transient holding the result of the last "Verify installation" run. */
	const CHECKS = 'credible_analytics_checks';

	/**
	 * First-party proxy.
	 *
	 * @var Credible_Analytics_Proxy
	 */
	private $proxy;

	/**
	 * Script tag builder, used to preview the exact markup that will be output.
	 *
	 * @var Credible_Analytics_Tracker
	 */
	private $tracker;

	/**
	 * Constructor.
	 *
	 * @param Credible_Analytics_Proxy   $proxy   First-party proxy.
	 * @param Credible_Analytics_Tracker $tracker Script tag builder.
	 */
	public function __construct( $proxy, $tracker ) {
		$this->proxy   = $proxy;
		$this->tracker = $tracker;
	}

	/* ------------------------------------------------------------------ *
	 * Storage
	 * ------------------------------------------------------------------ */

	/**
	 * Every setting with its default value.
	 *
	 * Booleans are stored as 0/1 rather than false/true so a round trip
	 * through the options table cannot turn them into the strings "" and "1"
	 * and change how they compare.
	 *
	 * @return array
	 */
	public static function defaults() {
		return array(
			'instance_url'    => '',
			'domain'          => '',
			'hash'            => 0,
			'track_logged_in' => 0,
			'exclude'         => '',
			'respect_dnt'     => 0,
			'track_localhost' => 0,
			'debug'           => 0,
			'proxy_enabled'   => 0,
			'proxy_slug'      => '',
			'custom_api'      => '',
		);
	}

	/**
	 * All settings, with defaults filled in for anything missing.
	 *
	 * @return array
	 */
	public static function all() {
		$stored = get_option( self::OPTION, array() );
		if ( ! is_array( $stored ) ) {
			$stored = array();
		}
		return array_merge( self::defaults(), $stored );
	}

	/**
	 * Read one setting.
	 *
	 * @param string $key Setting name.
	 * @return mixed Null when the key is unknown.
	 */
	public static function get( $key ) {
		$all = self::all();
		return isset( $all[ $key ] ) ? $all[ $key ] : null;
	}

	/**
	 * Origin of the Credible instance, without a trailing slash.
	 *
	 * @return string Empty when the plugin has not been configured.
	 */
	public static function instance_url() {
		$url = trim( (string) self::get( 'instance_url' ) );
		return '' === $url ? '' : untrailingslashit( $url );
	}

	/**
	 * The value for data-domain.
	 *
	 * Falls back to this site's own hostname, which is right often enough that
	 * a fresh install works after filling in one field instead of two.
	 *
	 * @return string
	 */
	public static function domain() {
		$domain = trim( (string) self::get( 'domain' ) );
		return '' === $domain ? self::default_domain() : $domain;
	}

	/**
	 * This site's hostname, normalised the way the ingestion endpoint does it.
	 *
	 * @return string
	 */
	public static function default_domain() {
		$host = wp_parse_url( home_url(), PHP_URL_HOST );
		if ( ! is_string( $host ) || '' === $host ) {
			return '';
		}
		return preg_replace( '~^www\.~i', '', strtolower( $host ) );
	}

	/**
	 * Is there enough configuration to emit a working script tag?
	 *
	 * @return bool
	 */
	public static function is_configured() {
		$url = self::instance_url();
		return '' !== $url && (bool) preg_match( '~^https?://~i', $url ) && '' !== self::domain();
	}

	/**
	 * Path segment the first-party proxy answers on.
	 *
	 * @return string
	 */
	public static function proxy_slug() {
		$slug = sanitize_title( (string) self::get( 'proxy_slug' ) );
		return '' === $slug ? 'cr-stats' : $slug;
	}

	/**
	 * A slug nobody can add to a blocklist in advance.
	 *
	 * The whole value of first-party proxying is that the request looks like
	 * part of the site, so a predictable path such as /credible/js/cr.js would
	 * give most of it back.
	 *
	 * @return string
	 */
	public static function generate_slug() {
		return 'cr-' . strtolower( wp_generate_password( 8, false, false ) );
	}

	/**
	 * Fill in the values a fresh install cannot guess at, on activation.
	 *
	 * @return void
	 */
	public static function seed_defaults() {
		$settings = self::all();
		if ( '' === $settings['proxy_slug'] ) {
			$settings['proxy_slug'] = self::generate_slug();
		}
		if ( '' === $settings['domain'] ) {
			$settings['domain'] = self::default_domain();
		}
		update_option( self::OPTION, $settings );
	}

	/* ------------------------------------------------------------------ *
	 * Sanitisation
	 * ------------------------------------------------------------------ */

	/**
	 * Clean a submitted settings array.
	 *
	 * Registered as the Settings API sanitise callback, so this is the only
	 * path by which user input reaches the option — nothing else writes it.
	 * Values that fail validation keep their previous value and raise a
	 * settings error rather than being silently blanked.
	 *
	 * @param mixed $input Raw $_POST value for the option.
	 * @return array
	 */
	public static function sanitize( $input ) {
		$current = self::all();
		$clean   = self::defaults();

		if ( ! is_array( $input ) ) {
			$input = array();
		}

		// Instance URL. esc_url_raw strips control characters and refuses
		// dangerous schemes, returning an empty string for them — so the test
		// has to be against the *raw* input. Otherwise pasting
		// "javascript:alert(1)" would look identical to clearing the field and
		// would silently switch tracking off with no explanation.
		$raw = isset( $input['instance_url'] ) ? trim( (string) $input['instance_url'] ) : '';
		$url = '' === $raw ? '' : esc_url_raw( $raw );
		if ( '' !== $raw && ( '' === $url || ! preg_match( '~^https?://~i', $url ) ) ) {
			add_settings_error(
				self::OPTION,
				'instance_url',
				esc_html__( 'The instance URL must be an http:// or https:// address. The previous value was kept.', 'credible-analytics' )
			);
			$url = $current['instance_url'];
		}
		$clean['instance_url'] = '' === $url ? '' : untrailingslashit( $url );

		$clean['domain'] = self::clean_domains( isset( $input['domain'] ) ? $input['domain'] : '' );

		foreach ( array( 'hash', 'track_logged_in', 'respect_dnt', 'track_localhost', 'debug', 'proxy_enabled' ) as $flag ) {
			$clean[ $flag ] = empty( $input[ $flag ] ) ? 0 : 1;
		}

		$clean['exclude'] = self::clean_exclusions( isset( $input['exclude'] ) ? $input['exclude'] : '' );

		// Same reasoning as the instance URL: judge the raw input, not what is
		// left of it after esc_url_raw has thrown the bad parts away.
		$raw_api = isset( $input['custom_api'] ) ? trim( (string) $input['custom_api'] ) : '';
		$api     = '' === $raw_api ? '' : esc_url_raw( $raw_api );
		if ( '' !== $raw_api && ( '' === $api || ! preg_match( '~^(https?://|/)~i', $api ) ) ) {
			add_settings_error(
				self::OPTION,
				'custom_api',
				esc_html__( 'The custom event endpoint must be an http:// or https:// address, or a path starting with a slash. The previous value was kept.', 'credible-analytics' )
			);
			$api = $current['custom_api'];
		}
		$clean['custom_api'] = $api;

		$slug = isset( $input['proxy_slug'] ) ? sanitize_title( $input['proxy_slug'] ) : '';
		if ( '' === $slug ) {
			$slug = '' !== $current['proxy_slug'] ? $current['proxy_slug'] : self::generate_slug();
		}
		$clean['proxy_slug'] = $slug;

		// Rewrite rules are built from the slug on `init`, so a change to
		// either the slug or the switch is only live after a flush. Flushing
		// here would be too early — the rules for the new slug do not exist
		// yet — so leave a flag and let the next request do it.
		if ( $clean['proxy_slug'] !== $current['proxy_slug'] || $clean['proxy_enabled'] !== $current['proxy_enabled'] ) {
			update_option( Credible_Analytics_Proxy::FLUSH_FLAG, 1 );
		}

		// A changed instance means the cached tracker belongs to the old one.
		if ( $clean['instance_url'] !== $current['instance_url'] ) {
			delete_option( Credible_Analytics_Proxy::CACHE_OPTION );
		}

		return $clean;
	}

	/**
	 * Normalise a comma-separated domain list the way the server does.
	 *
	 * Lowercased, scheme and path removed, leading `www.` dropped — which is
	 * exactly what recordEvent() does before looking the site up, so
	 * "https://WWW.Example.com/" and "example.com" both match the same site.
	 *
	 * @param mixed $value Raw input.
	 * @return string Comma-separated list, or '' to fall back to the site host.
	 */
	public static function clean_domains( $value ) {
		$parts = explode( ',', sanitize_text_field( (string) $value ) );
		$out   = array();
		foreach ( $parts as $part ) {
			$part = strtolower( trim( $part ) );
			$part = preg_replace( '~^[a-z][a-z0-9+.-]*://~', '', $part );
			$part = preg_replace( '~[/?].*$~', '', $part );
			$part = preg_replace( '~^www\.~', '', $part );
			if ( '' !== $part && preg_match( '~^[a-z0-9.:-]+$~', $part ) && ! in_array( $part, $out, true ) ) {
				$out[] = $part;
			}
		}
		return implode( ',', $out );
	}

	/**
	 * Turn a textarea of path globs into the comma list data-exclude expects.
	 *
	 * A leading slash is added where it is missing, matching what the tracker
	 * does on its side, so the field behaves the way the box's help text says.
	 *
	 * @param mixed $value Raw input, newline or comma separated.
	 * @return string
	 */
	public static function clean_exclusions( $value ) {
		$parts = preg_split( '~[\r\n,]+~', (string) $value );
		$out   = array();
		if ( ! is_array( $parts ) ) {
			return '';
		}
		foreach ( $parts as $part ) {
			$part = sanitize_text_field( trim( $part ) );
			if ( '' === $part ) {
				continue;
			}
			if ( '/' !== substr( $part, 0, 1 ) ) {
				$part = '/' . $part;
			}
			if ( ! in_array( $part, $out, true ) ) {
				$out[] = $part;
			}
		}
		return implode( ',', $out );
	}

	/* ------------------------------------------------------------------ *
	 * Admin wiring
	 * ------------------------------------------------------------------ */

	/**
	 * Register the admin screen and its actions.
	 *
	 * @return void
	 */
	public function register() {
		add_action( 'admin_menu', array( $this, 'add_menu' ) );
		add_action( 'admin_init', array( $this, 'register_setting' ) );
		add_action( 'admin_post_credible_analytics_verify', array( $this, 'handle_verify' ) );
		add_action( 'admin_post_credible_analytics_clear_cache', array( $this, 'handle_clear_cache' ) );
		add_filter(
			'plugin_action_links_' . plugin_basename( CREDIBLE_ANALYTICS_FILE ),
			array( $this, 'action_links' )
		);
	}

	/**
	 * Add Settings -> Credible.
	 *
	 * @return void
	 */
	public function add_menu() {
		add_options_page(
			__( 'Credible Analytics', 'credible-analytics' ),
			__( 'Credible', 'credible-analytics' ),
			'manage_options',
			self::PAGE,
			array( $this, 'render_page' )
		);
	}

	/**
	 * Register the option with the Settings API.
	 *
	 * @return void
	 */
	public function register_setting() {
		register_setting(
			self::GROUP,
			self::OPTION,
			array(
				'type'              => 'array',
				'sanitize_callback' => array( __CLASS__, 'sanitize' ),
				'default'           => self::defaults(),
			)
		);
	}

	/**
	 * Add a Settings link on the Plugins screen.
	 *
	 * @param array $links Existing links.
	 * @return array
	 */
	public function action_links( $links ) {
		$url  = admin_url( 'options-general.php?page=' . self::PAGE );
		$link = '<a href="' . esc_url( $url ) . '">' . esc_html__( 'Settings', 'credible-analytics' ) . '</a>';
		array_unshift( $links, $link );
		return $links;
	}

	/* ------------------------------------------------------------------ *
	 * Actions
	 * ------------------------------------------------------------------ */

	/**
	 * Run the installation checks and come back to the settings page.
	 *
	 * @return void
	 */
	public function handle_verify() {
		$this->assert_can_manage( 'credible_analytics_verify' );
		set_transient( self::CHECKS, $this->run_checks(), 5 * MINUTE_IN_SECONDS );
		$this->redirect_back( 'verified' );
	}

	/**
	 * Drop the cached copy of the tracker so the next request refetches it.
	 *
	 * @return void
	 */
	public function handle_clear_cache() {
		$this->assert_can_manage( 'credible_analytics_clear_cache' );
		delete_option( Credible_Analytics_Proxy::CACHE_OPTION );
		$this->redirect_back( 'cache-cleared' );
	}

	/**
	 * Capability plus nonce, the two checks every admin action needs.
	 *
	 * @param string $action Nonce action name.
	 * @return void
	 */
	private function assert_can_manage( $action ) {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'You do not have permission to change these settings.', 'credible-analytics' ), '', array( 'response' => 403 ) );
		}
		check_admin_referer( $action );
	}

	/**
	 * Send the browser back to the settings page with a status flag.
	 *
	 * @param string $status Value for the credible-status query argument.
	 * @return void
	 */
	private function redirect_back( $status ) {
		wp_safe_redirect(
			add_query_arg(
				array(
					'page'            => self::PAGE,
					'credible-status' => $status,
				),
				admin_url( 'options-general.php' )
			)
		);
		exit;
	}

	/**
	 * Probe the instance, and the proxy when it is on.
	 *
	 * Every check reports one of ok / warn / error. A loopback request to your
	 * own site is the flakiest thing here — plenty of hosts block it while the
	 * same URL works perfectly from a browser — so a failure there is a
	 * warning to go and look, never a hard error.
	 *
	 * @return array List of array{status:string,label:string,detail:string}.
	 */
	public function run_checks() {
		$results = array();

		$instance = self::instance_url();
		if ( '' === $instance ) {
			$results[] = array(
				'status' => 'error',
				'label'  => __( 'Instance URL', 'credible-analytics' ),
				'detail' => __( 'Not set. Nothing is being tracked.', 'credible-analytics' ),
			);
			return $results;
		}

		$response = wp_remote_get( $instance . '/js/cr.js', array( 'timeout' => 8 ) );
		if ( is_wp_error( $response ) ) {
			$results[] = array(
				'status' => 'error',
				'label'  => __( 'Instance reachable', 'credible-analytics' ),
				/* translators: %s: error message from the HTTP request. */
				'detail' => sprintf( __( 'Could not fetch the tracker: %s', 'credible-analytics' ), $response->get_error_message() ),
			);
		} else {
			$code = (int) wp_remote_retrieve_response_code( $response );
			$body = (string) wp_remote_retrieve_body( $response );
			if ( 200 === $code && false !== strpos( $body, 'Credible' ) ) {
				$results[] = array(
					'status' => 'ok',
					'label'  => __( 'Instance reachable', 'credible-analytics' ),
					/* translators: %s: size in bytes. */
					'detail' => sprintf( __( 'The tracker was served, %s bytes.', 'credible-analytics' ), number_format_i18n( strlen( $body ) ) ),
				);
			} else {
				$results[] = array(
					'status' => 'error',
					'label'  => __( 'Instance reachable', 'credible-analytics' ),
					/* translators: %d: HTTP status code. */
					'detail' => sprintf( __( 'Answered HTTP %d, and the body does not look like the Credible tracker. Check the URL.', 'credible-analytics' ), $code ),
				);
			}
		}

		$domain    = self::domain();
		$results[] = array(
			'status' => '' === $domain ? 'error' : 'ok',
			'label'  => __( 'Site domain', 'credible-analytics' ),
			'detail' => '' === $domain
				? __( 'Empty. Every event will be dropped by the browser.', 'credible-analytics' )
				/* translators: %s: the configured domain. */
				: sprintf( __( 'Events are attributed to %s. It must match a site on your instance exactly.', 'credible-analytics' ), $domain ),
		);

		if ( ! $this->proxy->is_active() ) {
			return $results;
		}

		$proxied = wp_remote_get( $this->proxy->script_url(), array( 'timeout' => 8 ) );
		if ( is_wp_error( $proxied ) ) {
			$results[] = array(
				'status' => 'warn',
				'label'  => __( 'First-party proxy', 'credible-analytics' ),
				/* translators: %s: error message from the HTTP request. */
				'detail' => sprintf( __( 'This server could not call itself (%s). That is often a host blocking loopback requests rather than a real fault — open the proxy URL in a browser to be sure.', 'credible-analytics' ), $proxied->get_error_message() ),
			);
		} else {
			$code = (int) wp_remote_retrieve_response_code( $proxied );
			$type = (string) wp_remote_retrieve_header( $proxied, 'content-type' );
			$ok   = 200 === $code && false !== strpos( strtolower( $type ), 'javascript' );
			$results[] = array(
				'status' => $ok ? 'ok' : 'warn',
				'label'  => __( 'First-party proxy', 'credible-analytics' ),
				'detail' => $ok
					? __( 'The tracker is being served from this domain.', 'credible-analytics' )
					/* translators: 1: HTTP status code, 2: content type header. */
					: sprintf( __( 'The proxy URL answered HTTP %1$d with content type "%2$s". If you just turned the proxy on, re-save your permalinks and try again.', 'credible-analytics' ), $code, $type ),
			);
		}

		$results[] = array(
			'status' => 'warn',
			'label'  => __( 'Instance configuration', 'credible-analytics' ),
			'detail' => __( 'With the proxy on, every event reaches your instance from this server. Set CREDIBLE_TRUST_PROXY=true there, or all your visitors will be counted as one person.', 'credible-analytics' ),
		);

		return $results;
	}

	/* ------------------------------------------------------------------ *
	 * The page
	 * ------------------------------------------------------------------ */

	/**
	 * Render Settings -> Credible.
	 *
	 * @return void
	 */
	public function render_page() {
		if ( ! current_user_can( 'manage_options' ) ) {
			return;
		}

		$settings = self::all();
		$checks   = get_transient( self::CHECKS );
		$status   = isset( $_GET['credible-status'] ) ? sanitize_key( wp_unslash( $_GET['credible-status'] ) ) : '';

		?>
		<div class="wrap">
			<h1><?php esc_html_e( 'Credible Analytics', 'credible-analytics' ); ?></h1>
			<p class="description">
				<?php esc_html_e( 'Privacy-first, cookieless analytics. No cookies are set on your visitors and no personal data is collected, so you do not need a consent banner for this plugin.', 'credible-analytics' ); ?>
			</p>

			<?php
			settings_errors( self::OPTION );

			if ( 'cache-cleared' === $status ) {
				echo '<div class="notice notice-success is-dismissible"><p>'
					. esc_html__( 'The cached tracker was cleared. The next visitor fetches a fresh copy.', 'credible-analytics' )
					. '</p></div>';
			}

			if ( ! self::is_configured() ) {
				echo '<div class="notice notice-warning"><p>'
					. esc_html__( 'Nothing is being tracked yet. Fill in your instance URL below.', 'credible-analytics' )
					. '</p></div>';
			}

			if ( is_array( $checks ) && $checks ) {
				$this->render_checks( $checks );
			}
			?>

			<form method="post" action="options.php">
				<?php settings_fields( self::GROUP ); ?>

				<h2 class="title"><?php esc_html_e( 'Connection', 'credible-analytics' ); ?></h2>
				<table class="form-table" role="presentation">
					<tr>
						<th scope="row">
							<label for="credible-instance-url"><?php esc_html_e( 'Instance URL', 'credible-analytics' ); ?></label>
						</th>
						<td>
							<input
								type="url"
								class="regular-text code"
								id="credible-instance-url"
								name="<?php echo esc_attr( self::OPTION ); ?>[instance_url]"
								value="<?php echo esc_attr( $settings['instance_url'] ); ?>"
								placeholder="https://stats.example.com"
							/>
							<p class="description">
								<?php esc_html_e( 'Where your Credible instance lives. An instance under a sub-path, such as https://example.com/stats, works too.', 'credible-analytics' ); ?>
							</p>
						</td>
					</tr>
					<tr>
						<th scope="row">
							<label for="credible-domain"><?php esc_html_e( 'Site domain', 'credible-analytics' ); ?></label>
						</th>
						<td>
							<input
								type="text"
								class="regular-text code"
								id="credible-domain"
								name="<?php echo esc_attr( self::OPTION ); ?>[domain]"
								value="<?php echo esc_attr( $settings['domain'] ); ?>"
								placeholder="<?php echo esc_attr( self::default_domain() ); ?>"
							/>
							<p class="description">
								<?php
								printf(
									/* translators: %s: the site's own hostname. */
									esc_html__( 'The site exactly as you added it in the Credible dashboard. Leave empty to use %s. Separate several domains with commas.', 'credible-analytics' ),
									'<code>' . esc_html( self::default_domain() ) . '</code>'
								);
								?>
							</p>
						</td>
					</tr>
				</table>

				<h2 class="title"><?php esc_html_e( 'What gets tracked', 'credible-analytics' ); ?></h2>
				<table class="form-table" role="presentation">
					<?php
					$this->checkbox_row(
						'hash',
						$settings['hash'],
						__( 'Hash-based routing', 'credible-analytics' ),
						__( 'Count #fragments as separate pages. Turn this on for hash routers, and only for those — otherwise #section-2 becomes a pageview.', 'credible-analytics' )
					);
					$this->checkbox_row(
						'track_logged_in',
						$settings['track_logged_in'],
						__( 'Track logged-in users', 'credible-analytics' ),
						__( 'Off by default, so your own editing sessions stay out of your numbers. Turn it on for membership sites where signed-in visitors are the audience.', 'credible-analytics' )
					);
					?>
					<tr>
						<th scope="row"><?php esc_html_e( 'Outbound links', 'credible-analytics' ); ?></th>
						<td>
							<label><input type="checkbox" checked disabled /> <?php esc_html_e( 'Always on', 'credible-analytics' ); ?></label>
							<p class="description">
								<?php esc_html_e( 'Clicks on links to another host are recorded as "Outbound Link: Click". Unlike some analytics tools, Credible ships one script with every feature built in, so this is not something the plugin can switch off — the checkbox is here to answer the question, not to hide a setting.', 'credible-analytics' ); ?>
							</p>
						</td>
					</tr>
					<tr>
						<th scope="row"><?php esc_html_e( 'File downloads', 'credible-analytics' ); ?></th>
						<td>
							<label><input type="checkbox" checked disabled /> <?php esc_html_e( 'Always on', 'credible-analytics' ); ?></label>
							<p class="description">
								<?php esc_html_e( 'Clicks on links to a PDF, ZIP, MP3 and about twenty other extensions are recorded as "File Download". Built into the same script, and likewise not switchable.', 'credible-analytics' ); ?>
							</p>
						</td>
					</tr>
					<tr>
						<th scope="row">
							<label for="credible-exclude"><?php esc_html_e( 'Excluded pages', 'credible-analytics' ); ?></label>
						</th>
						<td>
							<textarea
								id="credible-exclude"
								class="large-text code"
								rows="4"
								name="<?php echo esc_attr( self::OPTION ); ?>[exclude]"
								placeholder="/members/*&#10;/checkout/**"
							><?php echo esc_textarea( str_replace( ',', "\n", $settings['exclude'] ) ); ?></textarea>
							<p class="description">
								<?php esc_html_e( 'One path glob per line. Nothing at all is sent from a matching page. * stays inside one path segment, ** crosses segments — so /members/* matches /members/list but not /members/list/42.', 'credible-analytics' ); ?>
							</p>
						</td>
					</tr>
				</table>

				<h2 class="title"><?php esc_html_e( 'First-party proxy', 'credible-analytics' ); ?></h2>
				<p class="description" style="max-width:46em">
					<?php esc_html_e( 'Content blockers filter requests by hostname, so a tracker loaded from a separate analytics domain is invisible on a slice of your traffic. With the proxy on, this site serves the script and forwards the events itself, from your own domain — which is the one thing a plugin can do that pasting a snippet cannot.', 'credible-analytics' ); ?>
				</p>
				<table class="form-table" role="presentation">
					<?php
					$this->checkbox_row(
						'proxy_enabled',
						$settings['proxy_enabled'],
						__( 'Enable the proxy', 'credible-analytics' ),
						__( 'Serve the tracker and receive events on this domain, then forward them to your instance server-side.', 'credible-analytics' )
					);
					?>
					<tr>
						<th scope="row">
							<label for="credible-proxy-slug"><?php esc_html_e( 'Path prefix', 'credible-analytics' ); ?></label>
						</th>
						<td>
							<input
								type="text"
								class="regular-text code"
								id="credible-proxy-slug"
								name="<?php echo esc_attr( self::OPTION ); ?>[proxy_slug]"
								value="<?php echo esc_attr( $settings['proxy_slug'] ); ?>"
							/>
							<p class="description">
								<?php esc_html_e( 'A random prefix was generated for you. Anything recognisable — "credible", "analytics", "stats" — can be added to a blocklist, which would undo the point of proxying. Change it only if it clashes with a real page.', 'credible-analytics' ); ?>
							</p>
							<?php if ( $this->proxy->is_active() ) : ?>
								<p class="description">
									<strong><?php esc_html_e( 'Script:', 'credible-analytics' ); ?></strong>
									<code><?php echo esc_html( $this->proxy->script_url() ); ?></code><br />
									<strong><?php esc_html_e( 'Events:', 'credible-analytics' ); ?></strong>
									<code><?php echo esc_html( $this->proxy->event_url() ); ?></code>
								</p>
								<?php if ( ! $this->proxy->has_pretty_permalinks() ) : ?>
									<p class="description">
										<?php esc_html_e( 'Your permalinks are set to Plain, so the pretty proxy paths are not available and the REST API routes are used instead. Those work, but the URL contains the plugin name and is easier for a blocker to spot. Switching permalinks to any other setting fixes it.', 'credible-analytics' ); ?>
									</p>
								<?php endif; ?>
							<?php endif; ?>
						</td>
					</tr>
				</table>
				<?php if ( $settings['proxy_enabled'] ) : ?>
					<div class="notice notice-info inline">
						<p>
							<?php
							printf(
								/* translators: %s: the environment variable name, already wrapped in <code>. */
								esc_html__( 'Set %s on your Credible instance. With the proxy on, every event arrives from this server, and without that setting all your visitors collapse into a single person.', 'credible-analytics' ),
								'<code>CREDIBLE_TRUST_PROXY=true</code>'
							);
							?>
						</p>
					</div>
				<?php endif; ?>

				<h2 class="title"><?php esc_html_e( 'Advanced', 'credible-analytics' ); ?></h2>
				<table class="form-table" role="presentation">
					<?php
					$this->checkbox_row(
						'respect_dnt',
						$settings['respect_dnt'],
						__( 'Honour Do Not Track', 'credible-analytics' ),
						__( 'Off by default. Credible sets no cookie and stores no identifier, so a Do Not Track signal has nothing to protect against here — turning this on only hides anonymous traffic from your own reports.', 'credible-analytics' )
					);
					$this->checkbox_row(
						'track_localhost',
						$settings['track_localhost'],
						__( 'Count local traffic', 'credible-analytics' ),
						__( 'Traffic from localhost and .local hostnames is never counted unless you ask. For a development site only.', 'credible-analytics' )
					);
					$this->checkbox_row(
						'debug',
						$settings['debug'],
						__( 'Console debugging', 'credible-analytics' ),
						__( 'Print the reason every dropped event was dropped, in the browser console. Useful once, noisy in production.', 'credible-analytics' )
					);
					?>
					<tr>
						<th scope="row">
							<label for="credible-custom-api"><?php esc_html_e( 'Custom event endpoint', 'credible-analytics' ); ?></label>
						</th>
						<td>
							<input
								type="text"
								class="regular-text code"
								id="credible-custom-api"
								name="<?php echo esc_attr( self::OPTION ); ?>[custom_api]"
								value="<?php echo esc_attr( $settings['custom_api'] ); ?>"
								placeholder="https://example.com/collect"
							/>
							<p class="description">
								<?php esc_html_e( 'Overrides where events are posted, for a proxy you run yourself in front of WordPress. Leave empty unless you have one — the plugin already fills this in when its own proxy is enabled.', 'credible-analytics' ); ?>
							</p>
						</td>
					</tr>
				</table>

				<?php submit_button(); ?>
			</form>

			<h2 class="title"><?php esc_html_e( 'The tag on your pages', 'credible-analytics' ); ?></h2>
			<?php if ( self::is_configured() ) : ?>
				<p class="description">
					<?php esc_html_e( 'This is the exact markup the plugin prints in the head of every tracked page.', 'credible-analytics' ); ?>
				</p>
				<textarea class="large-text code" rows="3" readonly onclick="this.select()"><?php echo esc_textarea( $this->tracker->script_tag_preview() ); ?></textarea>
			<?php else : ?>
				<p class="description"><?php esc_html_e( 'Nothing yet — set an instance URL above.', 'credible-analytics' ); ?></p>
			<?php endif; ?>

			<h2 class="title"><?php esc_html_e( 'Checks', 'credible-analytics' ); ?></h2>
			<p class="description">
				<?php esc_html_e( 'Fetches the tracker from your instance and, when the proxy is on, from this site, and reports what came back.', 'credible-analytics' ); ?>
			</p>
			<div>
				<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" style="display:inline">
					<input type="hidden" name="action" value="credible_analytics_verify" />
					<?php wp_nonce_field( 'credible_analytics_verify' ); ?>
					<?php submit_button( __( 'Verify installation', 'credible-analytics' ), 'secondary', 'submit', false ); ?>
				</form>
				<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" style="display:inline">
					<input type="hidden" name="action" value="credible_analytics_clear_cache" />
					<?php wp_nonce_field( 'credible_analytics_clear_cache' ); ?>
					<?php submit_button( __( 'Clear cached tracker', 'credible-analytics' ), 'secondary', 'submit', false ); ?>
				</form>
			</div>
		</div>
		<?php
	}

	/**
	 * One checkbox row of the settings table.
	 *
	 * @param string $key         Setting name.
	 * @param mixed  $value       Current value.
	 * @param string $label       Row heading.
	 * @param string $description Help text below the control.
	 * @return void
	 */
	private function checkbox_row( $key, $value, $label, $description ) {
		$id = 'credible-' . str_replace( '_', '-', $key );
		?>
		<tr>
			<th scope="row"><?php echo esc_html( $label ); ?></th>
			<td>
				<label for="<?php echo esc_attr( $id ); ?>">
					<input
						type="checkbox"
						id="<?php echo esc_attr( $id ); ?>"
						name="<?php echo esc_attr( self::OPTION ); ?>[<?php echo esc_attr( $key ); ?>]"
						value="1"
						<?php checked( 1, (int) $value ); ?>
					/>
					<?php echo esc_html( $label ); ?>
				</label>
				<p class="description"><?php echo esc_html( $description ); ?></p>
			</td>
		</tr>
		<?php
	}

	/**
	 * Render the result of the last verification run.
	 *
	 * @param array $checks Result rows from run_checks().
	 * @return void
	 */
	private function render_checks( $checks ) {
		$classes = array(
			'ok'    => 'notice-success',
			'warn'  => 'notice-warning',
			'error' => 'notice-error',
		);
		echo '<div class="notice notice-info"><p><strong>' . esc_html__( 'Last check', 'credible-analytics' ) . '</strong></p><ul style="margin:0 0 1em 1em">';
		foreach ( $checks as $check ) {
			$status = isset( $check['status'] ) ? $check['status'] : 'warn';
			$mark   = 'ok' === $status ? '&#10003;' : ( 'error' === $status ? '&#10007;' : '&#33;' );
			echo '<li class="' . esc_attr( isset( $classes[ $status ] ) ? $classes[ $status ] : '' ) . '">'
				. '<strong>' . wp_kses_post( $mark ) . ' ' . esc_html( $check['label'] ) . '</strong> — '
				. esc_html( $check['detail'] ) . '</li>';
		}
		echo '</ul></div>';
	}
}
