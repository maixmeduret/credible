<?php
/**
 * Deciding whether to print the script tag, and what it says.
 *
 * The tag is built from scratch in the script_loader_tag filter rather than
 * patched with a string replacement: every attribute goes through esc_attr and
 * the src through esc_url, and there is exactly one place to read to know what
 * ends up on the page.
 *
 * @package CredibleAnalytics
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Enqueues the Credible tracker with the right data-* attributes.
 */
class Credible_Analytics_Tracker {

	/** Script handle, and the basis of the tag's id. */
	const HANDLE = 'credible-analytics';

	/**
	 * First-party proxy, which owns the URLs when it is switched on.
	 *
	 * @var Credible_Analytics_Proxy
	 */
	private $proxy;

	/**
	 * Constructor.
	 *
	 * @param Credible_Analytics_Proxy $proxy First-party proxy.
	 */
	public function __construct( $proxy ) {
		$this->proxy = $proxy;
	}

	/**
	 * Hook into the front end.
	 *
	 * @return void
	 */
	public function register() {
		add_action( 'wp_enqueue_scripts', array( $this, 'enqueue' ) );
		add_filter( 'script_loader_tag', array( $this, 'script_tag' ), 10, 3 );
	}

	/**
	 * Queue the tracker for the head of the page.
	 *
	 * @return void
	 */
	public function enqueue() {
		if ( ! $this->should_track() ) {
			return;
		}
		$src = $this->script_url();
		if ( '' === $src ) {
			return;
		}
		// No version argument: a ?ver= query string on a third-party script
		// buys nothing and defeats the CDN caching in front of the instance.
		wp_enqueue_script( self::HANDLE, $src, array(), null, false );
	}

	/**
	 * Replace WordPress's generic tag with ours.
	 *
	 * @param string $tag    The tag WordPress generated.
	 * @param string $handle Script handle.
	 * @param string $src    Script source.
	 * @return string
	 */
	public function script_tag( $tag, $handle, $src ) {
		if ( self::HANDLE !== $handle ) {
			return $tag;
		}
		return $this->build_tag( $src );
	}

	/**
	 * The exact markup shown on the settings screen.
	 *
	 * Built by the same method that prints it, so the preview cannot drift
	 * away from reality.
	 *
	 * @return string
	 */
	public function script_tag_preview() {
		$src = $this->script_url();
		return '' === $src ? '' : $this->build_tag( $src );
	}

	/**
	 * Attributes this method writes itself, which a filter must not restate.
	 *
	 * HTML keeps the *first* occurrence of a duplicated attribute, and the
	 * filtered attributes are written before these — so a filter returning
	 * 'src' would quietly win over the URL the plugin computed.
	 *
	 * @var array
	 */
	private static $reserved = array( 'src', 'id', 'defer' );

	/**
	 * Assemble the script tag.
	 *
	 * @param string $src Script source.
	 * @return string
	 */
	private function build_tag( $src ) {
		$out = '<script defer';
		foreach ( $this->attributes() as $name => $value ) {
			$name = strtolower( trim( (string) $name ) );
			if ( ! self::is_safe_attribute_name( $name ) ) {
				continue;
			}
			$out .= ' ' . $name . '="' . esc_attr( $value ) . '"';
		}
		$out .= ' src="' . esc_url( $src ) . '" id="' . esc_attr( self::HANDLE ) . '-js"></script>' . "\n";
		return $out;
	}

	/**
	 * May this name be written into the tag as an attribute name?
	 *
	 * esc_attr() is the right tool for a *value* and the wrong one for a
	 * *name*: character references are not decoded in attribute-name position,
	 * so escaping a quote there leaves a literal `&quot;` in the markup and the
	 * name simply ends at the following space. A filter returning
	 * `data-x" onerror="alert(1)` would therefore tokenise into a live onerror
	 * handler on this very script tag — verified against a real HTML parser,
	 * which reports `onerror` as an attribute of its own.
	 *
	 * Only site code can register that filter, so this is not a way in from
	 * outside; it is there so a careless integrator cannot turn the tracker
	 * into an event handler by accident. Names that do not look like
	 * attributes are dropped rather than mangled, because the one thing this
	 * method must always produce is a well-formed tag.
	 *
	 * @param string $name Lower-cased, trimmed attribute name.
	 * @return bool
	 */
	private static function is_safe_attribute_name( $name ) {
		if ( in_array( $name, self::$reserved, true ) ) {
			return false;
		}
		return 1 === preg_match( '~^[a-z][a-z0-9-]*$~', $name );
	}

	/**
	 * Where the tracker is loaded from.
	 *
	 * @return string Empty when the plugin is not configured.
	 */
	public function script_url() {
		if ( ! Credible_Analytics_Settings::is_configured() ) {
			return '';
		}
		if ( $this->proxy->is_active() ) {
			return $this->proxy->script_url();
		}
		return Credible_Analytics_Settings::instance_url() . '/js/cr.js';
	}

	/**
	 * Where events are posted.
	 *
	 * Empty means "say nothing": with no data-api the tracker derives the
	 * endpoint from its own src, which is correct for the direct case.
	 *
	 * @return string
	 */
	public function api_url() {
		$custom = trim( (string) Credible_Analytics_Settings::get( 'custom_api' ) );
		if ( '' !== $custom ) {
			return $custom;
		}
		if ( $this->proxy->is_active() ) {
			return $this->proxy->event_url();
		}
		return '';
	}

	/**
	 * The data-* attributes for the tag.
	 *
	 * Flags are emitted as the string "true" and left out entirely when off.
	 * The tracker reads a present attribute valued "", "true" or "1" as on and
	 * anything else as off, so an attribute is never written with a falsy
	 * value that could be misread later.
	 *
	 * @return array
	 */
	public function attributes() {
		$attributes = array( 'data-domain' => Credible_Analytics_Settings::domain() );

		$api = $this->api_url();
		if ( '' !== $api ) {
			$attributes['data-api'] = $api;
		}

		$exclude = trim( (string) Credible_Analytics_Settings::get( 'exclude' ) );
		if ( '' !== $exclude ) {
			$attributes['data-exclude'] = $exclude;
		}

		foreach ( array(
			'hash'            => 'data-hash',
			'respect_dnt'     => 'data-respect-dnt',
			'track_localhost' => 'data-track-localhost',
			'debug'           => 'data-debug',
		) as $setting => $attribute ) {
			if ( Credible_Analytics_Settings::get( $setting ) ) {
				$attributes[ $attribute ] = 'true';
			}
		}

		/**
		 * Filter the attributes printed on the tracker's script tag.
		 *
		 * Values are escaped afterwards, so they may contain anything. Names
		 * are validated instead of escaped and must look like `data-thing`:
		 * anything else — including `src`, `id` and `defer`, which the tag
		 * writes itself — is dropped. See is_safe_attribute_name().
		 *
		 * @param array $attributes Attribute name => value.
		 */
		$filtered = apply_filters( 'credible_analytics_script_attributes', $attributes );
		return is_array( $filtered ) ? $filtered : $attributes;
	}

	/**
	 * Should this request be counted?
	 *
	 * Previews and the customizer are excluded because they are the author
	 * looking at their own draft, not a visit. Logged-in users are excluded by
	 * default for the same reason, and that is the one part of this a
	 * membership site will want to change.
	 *
	 * @return bool
	 */
	public function should_track() {
		$track = true;

		if ( ! Credible_Analytics_Settings::is_configured() ) {
			$track = false;
		} elseif ( is_admin() ) {
			$track = false;
		} elseif ( ! Credible_Analytics_Settings::get( 'track_logged_in' ) && is_user_logged_in() ) {
			$track = false;
		} elseif ( is_preview() || is_customize_preview() ) {
			$track = false;
		}

		/**
		 * Filter whether the tracker is printed for this request.
		 *
		 * Lets a site exclude a role, a post type or a staging hostname
		 * without touching the plugin.
		 *
		 * @param bool $track Whether to print the tracker.
		 */
		return (bool) apply_filters( 'credible_analytics_should_track', $track );
	}
}
