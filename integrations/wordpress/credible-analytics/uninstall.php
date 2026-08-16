<?php
/**
 * Runs when the plugin is deleted from the Plugins screen.
 *
 * Everything the plugin ever wrote is removed: the settings, the cached copy
 * of the tracker and the rewrite-flush flag. Analytics data itself lives on
 * the Credible instance and is not touched — deleting a WordPress plugin must
 * never delete a year of somebody's traffic history.
 *
 * The cached rewrite rules are dropped rather than regenerated: WordPress
 * rebuilds that option automatically on the next request, and doing it here
 * would mean depending on $wp_rewrite being initialised in the uninstall
 * context, which is not guaranteed.
 *
 * @package CredibleAnalytics
 */

// WordPress defines this only when it is genuinely uninstalling this plugin.
if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
	exit;
}

/**
 * Remove this plugin's data from the current site.
 *
 * @return void
 */
function credible_analytics_uninstall_site() {
	delete_option( 'credible_analytics_settings' );
	delete_option( 'credible_analytics_script_cache' );
	delete_option( 'credible_analytics_flush_rewrites' );
	delete_transient( 'credible_analytics_checks' );
	delete_option( 'rewrite_rules' );
}

if ( is_multisite() ) {
	$credible_sites = get_sites(
		array(
			'fields' => 'ids',
			'number' => 0,
		)
	);
	foreach ( $credible_sites as $credible_site_id ) {
		switch_to_blog( $credible_site_id );
		credible_analytics_uninstall_site();
		restore_current_blog();
	}
	unset( $credible_sites, $credible_site_id );
} else {
	credible_analytics_uninstall_site();
}
