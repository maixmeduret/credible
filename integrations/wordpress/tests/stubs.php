<?php
/**
 * Just enough WordPress to run the plugin's pure logic outside WordPress.
 *
 * WHAT THIS IS FOR
 * The interesting, breakable parts of the plugin are the sanitisers and the
 * script-tag builder: given this input, is the stored value safe, and is the
 * markup on the page correct? Those are pure functions of their arguments,
 * and testing them needs a handful of WordPress helpers rather than a
 * WordPress installation.
 *
 * WHAT THIS IS NOT
 * These stubs approximate WordPress; they are not WordPress. esc_url in
 * particular is far simpler here than core's. So a test passing here means
 * "the plugin's own logic is right", not "core would agree byte for byte" —
 * the assertions below are written to stay true under both.
 *
 * @package CredibleAnalytics
 */

define( 'ABSPATH', __DIR__ . '/' );
define( 'MINUTE_IN_SECONDS', 60 );
define( 'HOUR_IN_SECONDS', 3600 );

/** Option store, reset between test groups. */
$GLOBALS['cr_options'] = array();

/** Settings errors raised through add_settings_error(). */
$GLOBALS['cr_settings_errors'] = array();

/** Callbacks registered through add_filter(), by hook name. */
$GLOBALS['cr_filters'] = array();

/** Values the conditional tags should report. */
$GLOBALS['cr_state'] = array(
	'home_url'            => 'https://example.com',
	'rest_url'            => 'https://example.com/wp-json/',
	'is_admin'            => false,
	'is_user_logged_in'   => false,
	'is_preview'          => false,
	'is_customize_preview' => false,
);

/**
 * Reset every piece of shared state.
 *
 * @param array $options Options to start from.
 * @return void
 */
function cr_reset( $options = array() ) {
	$GLOBALS['cr_options']         = $options;
	$GLOBALS['cr_settings_errors'] = array();
	$GLOBALS['cr_filters']         = array();
	$GLOBALS['cr_state']           = array(
		'home_url'             => 'https://example.com',
		'rest_url'             => 'https://example.com/wp-json/',
		'is_admin'             => false,
		'is_user_logged_in'    => false,
		'is_preview'           => false,
		'is_customize_preview' => false,
	);
}

/* -------------------------------------------------------------------- *
 * Options
 * -------------------------------------------------------------------- */

function get_option( $name, $default = false ) {
	return array_key_exists( $name, $GLOBALS['cr_options'] ) ? $GLOBALS['cr_options'][ $name ] : $default;
}

function update_option( $name, $value, $autoload = null ) {
	$GLOBALS['cr_options'][ $name ] = $value;
	return true;
}

function delete_option( $name ) {
	unset( $GLOBALS['cr_options'][ $name ] );
	return true;
}

function get_transient( $name ) {
	return get_option( '_transient_' . $name, false );
}

function set_transient( $name, $value, $ttl = 0 ) {
	return update_option( '_transient_' . $name, $value );
}

function delete_transient( $name ) {
	return delete_option( '_transient_' . $name );
}

/* -------------------------------------------------------------------- *
 * Strings and escaping
 * -------------------------------------------------------------------- */

function sanitize_text_field( $value ) {
	$value = wp_strip_all_tags( (string) $value );
	$value = preg_replace( '/[\r\n\t ]+/', ' ', $value );
	return trim( $value );
}

function wp_strip_all_tags( $value ) {
	$value = preg_replace( '@<(script|style)[^>]*?>.*?</\\1>@si', '', (string) $value );
	return strip_tags( $value );
}

function sanitize_title( $value ) {
	$value = strtolower( wp_strip_all_tags( (string) $value ) );
	$value = preg_replace( '/[^a-z0-9]+/', '-', $value );
	return trim( (string) $value, '-' );
}

function sanitize_key( $value ) {
	return preg_replace( '/[^a-z0-9_\-]/', '', strtolower( (string) $value ) );
}

function esc_attr( $value ) {
	return htmlspecialchars( (string) $value, ENT_QUOTES, 'UTF-8' );
}

function esc_html( $value ) {
	return htmlspecialchars( (string) $value, ENT_QUOTES, 'UTF-8' );
}

function esc_textarea( $value ) {
	return htmlspecialchars( (string) $value, ENT_QUOTES, 'UTF-8' );
}

/**
 * A deliberately strict stand-in for esc_url_raw.
 *
 * Core allows a longer protocol list and does more normalising; everything
 * this rejects, core rejects too, which is the direction that matters for a
 * value the plugin will later fetch over HTTP.
 */
function esc_url_raw( $url ) {
	$url = trim( preg_replace( '/[\s\x00-\x1f\x7f]+/', '', (string) $url ) );
	if ( '' === $url ) {
		return '';
	}
	if ( preg_match( '~^(https?|ftp)://~i', $url ) || '/' === substr( $url, 0, 1 ) ) {
		return $url;
	}
	return '';
}

function esc_url( $url ) {
	return esc_attr( esc_url_raw( $url ) );
}

function untrailingslashit( $value ) {
	return rtrim( (string) $value, '/\\' );
}

function trailingslashit( $value ) {
	return untrailingslashit( $value ) . '/';
}

function wp_parse_url( $url, $component = -1 ) {
	return parse_url( $url, $component );
}

function wp_generate_password( $length = 12, $special = true, $extra = false ) {
	$alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
	$out      = '';
	for ( $i = 0; $i < $length; $i++ ) {
		$out .= $alphabet[ random_int( 0, strlen( $alphabet ) - 1 ) ];
	}
	return $out;
}

function number_format_i18n( $number ) {
	return number_format( (float) $number );
}

/* -------------------------------------------------------------------- *
 * Translation
 * -------------------------------------------------------------------- */

function __( $text, $domain = 'default' ) {
	return $text;
}

function esc_html__( $text, $domain = 'default' ) {
	return esc_html( $text );
}

function esc_html_e( $text, $domain = 'default' ) {
	echo esc_html( $text );
}

function esc_attr__( $text, $domain = 'default' ) {
	return esc_attr( $text );
}

/* -------------------------------------------------------------------- *
 * URLs and conditional tags
 * -------------------------------------------------------------------- */

function home_url( $path = '' ) {
	return untrailingslashit( $GLOBALS['cr_state']['home_url'] ) . $path;
}

function admin_url( $path = '' ) {
	return home_url( '/wp-admin/' . ltrim( $path, '/' ) );
}

function rest_url( $path = '' ) {
	return $GLOBALS['cr_state']['rest_url'] . ltrim( $path, '/' );
}

function is_admin() {
	return (bool) $GLOBALS['cr_state']['is_admin'];
}

function is_user_logged_in() {
	return (bool) $GLOBALS['cr_state']['is_user_logged_in'];
}

function is_preview() {
	return (bool) $GLOBALS['cr_state']['is_preview'];
}

function is_customize_preview() {
	return (bool) $GLOBALS['cr_state']['is_customize_preview'];
}

function is_multisite() {
	return false;
}

/* -------------------------------------------------------------------- *
 * Hooks — recorded, never fired
 * -------------------------------------------------------------------- */

function add_action( $hook, $callback, $priority = 10, $args = 1 ) {
	return true;
}

/**
 * Register a filter.
 *
 * Really registers it, rather than recording and discarding it: the plugin
 * exposes two filters as public API, and a stub that never fires them leaves
 * both completely untested. Priority is ignored — nothing here registers two
 * callbacks on one hook where the order matters.
 *
 * @param string   $hook     Hook name.
 * @param callable $callback Callback.
 * @param int      $priority Ignored.
 * @param int      $args     Ignored.
 * @return bool
 */
function add_filter( $hook, $callback, $priority = 10, $args = 1 ) {
	$GLOBALS['cr_filters'][ $hook ][] = $callback;
	return true;
}

/**
 * Run a value through every registered filter.
 *
 * @param string $hook  Hook name.
 * @param mixed  $value Value to filter.
 * @return mixed
 */
function apply_filters( $hook, $value ) {
	if ( empty( $GLOBALS['cr_filters'][ $hook ] ) ) {
		return $value;
	}
	foreach ( $GLOBALS['cr_filters'][ $hook ] as $callback ) {
		$value = call_user_func( $callback, $value );
	}
	return $value;
}

function add_rewrite_rule( $regex, $query, $after = 'bottom' ) {
	$GLOBALS['cr_state']['rewrite_rules'][ $regex ] = $query;
	return true;
}

function flush_rewrite_rules( $hard = true ) {
	return true;
}

function add_settings_error( $setting, $code, $message, $type = 'error' ) {
	$GLOBALS['cr_settings_errors'][] = array(
		'setting' => $setting,
		'code'    => $code,
		'message' => $message,
	);
}

function register_setting( $group, $name, $args = array() ) {
	return true;
}

function plugin_dir_path( $file ) {
	return dirname( $file ) . '/';
}

function plugin_basename( $file ) {
	return basename( dirname( $file ) ) . '/' . basename( $file );
}
