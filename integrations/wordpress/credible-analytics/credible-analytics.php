<?php
/**
 * Plugin Name:       Credible Analytics
 * Plugin URI:        https://github.com/maixmeduret/credible
 * Description:       Privacy-first, cookieless analytics for WordPress. No cookies, no consent banner, no personal data. Optionally serves the tracker and forwards events through your own domain so content blockers cannot filter them out.
 * Version:           0.1.0
 * Requires at least: 5.6
 * Requires PHP:      7.4
 * Author:            Credible contributors
 * Author URI:        https://github.com/maixmeduret/credible
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       credible-analytics
 *
 * @package CredibleAnalytics
 *
 * ---------------------------------------------------------------------------
 * ON THE LICENCE
 *
 * WordPress.org requires plugins to be GPL-2.0-or-later, and this plugin is.
 * The Credible server it talks to is AGPL-3.0-or-later. The two are separate
 * programs that exchange HTTP requests: no Credible source is copied into,
 * linked against, or distributed with this plugin, so the licences never have
 * to be reconciled. The one file that crosses the boundary — the tracker
 * JavaScript — is fetched from your instance at runtime and passed through
 * untouched; it is never bundled here.
 * ---------------------------------------------------------------------------
 */

// Block direct access. Every entry point in this plugin repeats this check.
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'CREDIBLE_ANALYTICS_VERSION', '0.1.0' );
define( 'CREDIBLE_ANALYTICS_FILE', __FILE__ );
define( 'CREDIBLE_ANALYTICS_DIR', plugin_dir_path( __FILE__ ) );

require_once CREDIBLE_ANALYTICS_DIR . 'includes/class-credible-analytics-settings.php';
require_once CREDIBLE_ANALYTICS_DIR . 'includes/class-credible-analytics-proxy.php';
require_once CREDIBLE_ANALYTICS_DIR . 'includes/class-credible-analytics-tracker.php';

/**
 * Wire the plugin up.
 *
 * Three objects, each owning one concern: where the settings live, how the
 * first-party proxy answers requests, and what the script tag looks like. The
 * tracker needs the proxy because the proxy decides the URLs when it is on.
 *
 * @return void
 */
function credible_analytics_boot() {
	$proxy   = new Credible_Analytics_Proxy();
	$tracker = new Credible_Analytics_Tracker( $proxy );
	$admin   = new Credible_Analytics_Settings( $proxy, $tracker );

	$proxy->register();
	$tracker->register();

	// The settings screen is dead weight on a front-end request.
	if ( is_admin() ) {
		$admin->register();
	}
}
add_action( 'plugins_loaded', 'credible_analytics_boot' );

register_activation_hook( __FILE__, array( 'Credible_Analytics_Proxy', 'on_activate' ) );
register_deactivation_hook( __FILE__, array( 'Credible_Analytics_Proxy', 'on_deactivate' ) );
