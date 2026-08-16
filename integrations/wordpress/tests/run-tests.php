<?php
/**
 * Behavioural tests for the Credible Analytics plugin.
 *
 *   php integrations/wordpress/tests/run-tests.php
 *
 * Or, on a machine with Docker but no PHP:
 *   docker run --rm -v "$PWD:/app" -w /app php:7.4-cli-alpine \
 *     php integrations/wordpress/tests/run-tests.php
 *
 * Exits 0 when everything passes, 1 otherwise, and prints a TAP-ish summary.
 * The node:test suite in plugin.test.js runs this file when a PHP binary is
 * available and skips it — loudly — when there is none.
 *
 * Only pure logic is covered: sanitising input, building the script tag,
 * choosing URLs, deciding whether to track. Anything that needs a database,
 * an HTTP client or the rewrite engine is out of scope here and is covered by
 * `php -l` plus a manual install.
 *
 * @package CredibleAnalytics
 */

require_once __DIR__ . '/stubs.php';

$plugin = dirname( __DIR__ ) . '/credible-analytics/includes/';
require_once $plugin . 'class-credible-analytics-settings.php';
require_once $plugin . 'class-credible-analytics-proxy.php';
require_once $plugin . 'class-credible-analytics-tracker.php';

$GLOBALS['cr_passed'] = 0;
$GLOBALS['cr_failed'] = array();

/**
 * Assert two values are identical.
 *
 * @param mixed  $expected Expected value.
 * @param mixed  $actual   Actual value.
 * @param string $label    What is being checked.
 * @return void
 */
function is_same( $expected, $actual, $label ) {
	if ( $expected === $actual ) {
		++$GLOBALS['cr_passed'];
		return;
	}
	$GLOBALS['cr_failed'][] = sprintf(
		"%s\n      expected: %s\n      actual:   %s",
		$label,
		var_export( $expected, true ),
		var_export( $actual, true )
	);
}

/**
 * Assert a value is truthy.
 *
 * @param mixed  $actual Value under test.
 * @param string $label  What is being checked.
 * @return void
 */
function is_true( $actual, $label ) {
	is_same( true, (bool) $actual, $label );
}

/**
 * Assert a haystack contains a needle.
 *
 * @param string $needle   Substring expected.
 * @param string $haystack String to search.
 * @param string $label    What is being checked.
 * @return void
 */
function has_text( $needle, $haystack, $label ) {
	if ( false !== strpos( $haystack, $needle ) ) {
		++$GLOBALS['cr_passed'];
		return;
	}
	$GLOBALS['cr_failed'][] = sprintf( "%s\n      %s\n      is not in: %s", $label, $needle, $haystack );
}

/**
 * Assert a haystack does not contain a needle.
 *
 * @param string $needle   Substring that must be absent.
 * @param string $haystack String to search.
 * @param string $label    What is being checked.
 * @return void
 */
function lacks_text( $needle, $haystack, $label ) {
	if ( false === strpos( $haystack, $needle ) ) {
		++$GLOBALS['cr_passed'];
		return;
	}
	$GLOBALS['cr_failed'][] = sprintf( "%s\n      %s\n      should not be in: %s", $label, $needle, $haystack );
}

/**
 * Store a settings array and return a configured tracker plus proxy.
 *
 * @param array $settings Settings to store.
 * @return array{0:Credible_Analytics_Proxy,1:Credible_Analytics_Tracker}
 */
function with_settings( $settings ) {
	cr_reset(
		array(
			Credible_Analytics_Settings::OPTION => array_merge( Credible_Analytics_Settings::defaults(), $settings ),
			'permalink_structure'               => '/%postname%/',
		)
	);
	$proxy = new Credible_Analytics_Proxy();
	return array( $proxy, new Credible_Analytics_Tracker( $proxy ) );
}

/* ==================================================================== *
 * Domain normalisation
 * ==================================================================== */

cr_reset();

is_same( 'example.com', Credible_Analytics_Settings::clean_domains( 'https://WWW.Example.com/blog?x=1' ), 'a pasted URL becomes a bare domain' );
is_same( 'example.com', Credible_Analytics_Settings::clean_domains( '  Example.com  ' ), 'whitespace and case are normalised' );
is_same( 'a.com,b.com', Credible_Analytics_Settings::clean_domains( 'a.com, b.com , a.com' ), 'a comma list is kept and de-duplicated' );
is_same( 'localhost:8000', Credible_Analytics_Settings::clean_domains( 'localhost:8000' ), 'a port survives, for development instances' );
is_same( '', Credible_Analytics_Settings::clean_domains( 'ex ample.com' ), 'a domain with a space is dropped, not mangled' );
is_same( '', Credible_Analytics_Settings::clean_domains( '' ), 'empty stays empty, so the site host is used' );
is_same( '', Credible_Analytics_Settings::clean_domains( '"><script>alert(1)</script>' ), 'an injection attempt survives nothing' );

/* ==================================================================== *
 * Exclusion globs
 * ==================================================================== */

is_same(
	'/admin/*,/private/**,/x',
	Credible_Analytics_Settings::clean_exclusions( "admin/*\n/private/**, /x" ),
	'newlines and commas both separate, and a leading slash is added'
);
is_same( '/a', Credible_Analytics_Settings::clean_exclusions( "/a\n\n/a\n" ), 'blank lines and duplicates are removed' );
is_same( '', Credible_Analytics_Settings::clean_exclusions( "\n  \n" ), 'a textarea of whitespace stores nothing' );

/* ==================================================================== *
 * Settings sanitisation
 * ==================================================================== */

cr_reset();
$clean = Credible_Analytics_Settings::sanitize(
	array(
		'instance_url'    => '  https://stats.example.com/  ',
		'domain'          => 'Example.com',
		'hash'            => '1',
		'track_logged_in' => '',
		'exclude'         => "/admin/*\n",
		'proxy_enabled'   => '1',
		'proxy_slug'      => 'My Slug!',
	)
);
is_same( 'https://stats.example.com', $clean['instance_url'], 'the instance URL loses its trailing slash' );
is_same( 'example.com', $clean['domain'], 'the domain is normalised on save' );
is_same( 1, $clean['hash'], 'a ticked box stores 1' );
is_same( 0, $clean['track_logged_in'], 'an unticked box stores 0' );
is_same( 0, $clean['respect_dnt'], 'a box absent from the POST stores 0' );
is_same( '/admin/*', $clean['exclude'], 'exclusions are stored as a comma list' );
is_same( 'my-slug', $clean['proxy_slug'], 'the proxy slug is slugified' );
is_true( get_option( Credible_Analytics_Proxy::FLUSH_FLAG ), 'turning the proxy on schedules a rewrite flush' );

cr_reset(
	array(
		Credible_Analytics_Settings::OPTION => array_merge(
			Credible_Analytics_Settings::defaults(),
			array( 'instance_url' => 'https://good.example' )
		),
	)
);
$clean = Credible_Analytics_Settings::sanitize( array( 'instance_url' => 'javascript:alert(1)' ) );
is_same( 'https://good.example', $clean['instance_url'], 'a javascript: URL is refused and the old value kept' );
is_same( 1, count( $GLOBALS['cr_settings_errors'] ), 'refusing the URL tells the user why' );

cr_reset(
	array(
		Credible_Analytics_Settings::OPTION => array_merge(
			Credible_Analytics_Settings::defaults(),
			array( 'instance_url' => 'https://good.example' )
		),
	)
);
$clean = Credible_Analytics_Settings::sanitize( array( 'instance_url' => 'stats.example.com' ) );
is_same( 'https://good.example', $clean['instance_url'], 'a scheme-less URL is refused rather than guessed at' );

cr_reset(
	array(
		Credible_Analytics_Settings::OPTION => array_merge(
			Credible_Analytics_Settings::defaults(),
			array( 'instance_url' => 'https://good.example' )
		),
	)
);
$clean = Credible_Analytics_Settings::sanitize( array( 'instance_url' => '' ) );
is_same( '', $clean['instance_url'], 'deliberately emptying the field does clear it' );
is_same( 0, count( $GLOBALS['cr_settings_errors'] ), 'clearing the field is not an error' );

cr_reset(
	array(
		Credible_Analytics_Settings::OPTION => array_merge(
			Credible_Analytics_Settings::defaults(),
			array( 'custom_api' => 'https://example.com/collect' )
		),
	)
);
$clean = Credible_Analytics_Settings::sanitize( array( 'custom_api' => 'javascript:alert(1)' ) );
is_same( 'https://example.com/collect', $clean['custom_api'], 'a bad custom endpoint keeps the previous one' );
is_same( 1, count( $GLOBALS['cr_settings_errors'] ), 'and says so' );

cr_reset();
$clean = Credible_Analytics_Settings::sanitize( array() );
is_true( '' !== $clean['proxy_slug'], 'an empty slug is generated rather than left blank' );
is_true( (bool) preg_match( '~^cr-[a-z0-9]{8}$~', $clean['proxy_slug'] ), 'the generated slug is unguessable and URL safe' );

cr_reset(
	array(
		Credible_Analytics_Settings::OPTION       => array_merge(
			Credible_Analytics_Settings::defaults(),
			array( 'instance_url' => 'https://old.example' )
		),
		Credible_Analytics_Proxy::CACHE_OPTION    => array( 'body' => 'old tracker' ),
	)
);
Credible_Analytics_Settings::sanitize( array( 'instance_url' => 'https://new.example' ) );
is_same( false, get_option( Credible_Analytics_Proxy::CACHE_OPTION ), 'changing instance throws away the cached tracker' );

cr_reset();
is_same( 'example.com', Credible_Analytics_Settings::default_domain(), 'the site host is the default domain' );

/* ==================================================================== *
 * The script tag, direct mode
 * ==================================================================== */

list( $proxy, $tracker ) = with_settings(
	array(
		'instance_url' => 'https://stats.example.com',
		'domain'       => 'example.com',
	)
);

is_same( 'https://stats.example.com/js/cr.js', $tracker->script_url(), 'the tracker is loaded straight from the instance' );
is_same( '', $tracker->api_url(), 'no data-api: the tracker derives the endpoint from its own src' );
is_same( array( 'data-domain' => 'example.com' ), $tracker->attributes(), 'a default install emits one attribute' );

$tag = $tracker->script_tag_preview();
has_text( '<script defer ', $tag, 'the tag is deferred' );
has_text( 'data-domain="example.com"', $tag, 'the domain is on the tag' );
has_text( 'src="https://stats.example.com/js/cr.js"', $tag, 'the src points at the instance' );
lacks_text( 'data-api', $tag, 'no endpoint override in direct mode' );

/* ==================================================================== *
 * The script tag, every option on
 * ==================================================================== */

list( $proxy, $tracker ) = with_settings(
	array(
		'instance_url'    => 'https://stats.example.com',
		'domain'          => 'example.com,example.org',
		'hash'            => 1,
		'respect_dnt'     => 1,
		'track_localhost' => 1,
		'debug'           => 1,
		'exclude'         => '/admin/*,/private/**',
	)
);
$attributes = $tracker->attributes();
is_same( 'example.com,example.org', $attributes['data-domain'], 'several domains ride on one tag' );
is_same( 'true', $attributes['data-hash'], 'hash mode is the literal string true' );
is_same( 'true', $attributes['data-respect-dnt'], 'do-not-track is the literal string true' );
is_same( 'true', $attributes['data-track-localhost'], 'localhost tracking is the literal string true' );
is_same( 'true', $attributes['data-debug'], 'debug is the literal string true' );
is_same( '/admin/*,/private/**', $attributes['data-exclude'], 'exclusions reach the tag verbatim' );

list( $proxy, $tracker ) = with_settings(
	array(
		'instance_url' => 'https://stats.example.com',
		'domain'       => 'example.com',
		'hash'         => 0,
	)
);
is_true( ! isset( $tracker->attributes()['data-hash'] ), 'an option left off emits no attribute at all' );

/* ==================================================================== *
 * Escaping
 * ==================================================================== */

list( $proxy, $tracker ) = with_settings(
	array(
		'instance_url' => 'https://stats.example.com',
		// Not reachable through the settings form — clean_domains rejects it —
		// but a filter or a hand-edited option could still get it here, and the
		// tag builder must not be the thing that trusts it.
		'domain'       => 'evil.com" onload="alert(1)',
	)
);
$tag = $tracker->script_tag_preview();
lacks_text( 'onload="alert(1)"', $tag, 'a quote in the domain cannot break out of the attribute' );
has_text( '&quot;', $tag, 'the quote is entity encoded instead' );

/* ==================================================================== *
 * The script tag, proxied
 * ==================================================================== */

list( $proxy, $tracker ) = with_settings(
	array(
		'instance_url'  => 'https://stats.example.com',
		'domain'        => 'example.com',
		'proxy_enabled' => 1,
		'proxy_slug'    => 'cr-a1b2c3d4',
	)
);

is_true( $proxy->is_active(), 'the proxy reports itself active once configured' );
is_same( 'https://example.com/cr-a1b2c3d4/js/cr.js', $proxy->script_url(), 'the script is served from this domain' );
is_same( 'https://example.com/cr-a1b2c3d4/api/event', $proxy->event_url(), 'events are received on this domain' );
is_same( $proxy->script_url(), $tracker->script_url(), 'the tag uses the proxied script URL' );
is_same( $proxy->event_url(), $tracker->api_url(), 'the tag pins data-api to the proxied endpoint' );

$tag = $tracker->script_tag_preview();
has_text( 'data-api="https://example.com/cr-a1b2c3d4/api/event"', $tag, 'data-api is explicit when proxying' );
lacks_text( 'stats.example.com', $tag, 'the analytics hostname never appears in the page source' );

// Plain permalinks: the pretty paths do not exist, so REST answers instead.
$GLOBALS['cr_options']['permalink_structure'] = '';
is_same( 'https://example.com/wp-json/credible/v1/script', $proxy->script_url(), 'REST serves the script without pretty permalinks' );
is_same( 'https://example.com/wp-json/credible/v1/event', $proxy->event_url(), 'REST receives events without pretty permalinks' );
is_same( false, $proxy->has_pretty_permalinks(), 'the fallback knows why it is being used' );

/* ==================================================================== *
 * A custom endpoint wins over everything
 * ==================================================================== */

list( $proxy, $tracker ) = with_settings(
	array(
		'instance_url'  => 'https://stats.example.com',
		'domain'        => 'example.com',
		'proxy_enabled' => 1,
		'custom_api'    => 'https://example.com/collect',
	)
);
is_same( 'https://example.com/collect', $tracker->api_url(), 'a hand-configured endpoint overrides the built-in proxy' );

/* ==================================================================== *
 * Rewrite rules
 * ==================================================================== */

list( $proxy, $tracker ) = with_settings(
	array(
		'instance_url'  => 'https://stats.example.com',
		'domain'        => 'example.com',
		'proxy_enabled' => 1,
		'proxy_slug'    => 'cr-a1b2c3d4',
	)
);
$proxy->add_rewrite_rules();
$rules = isset( $GLOBALS['cr_state']['rewrite_rules'] ) ? $GLOBALS['cr_state']['rewrite_rules'] : array();
is_same( 2, count( $rules ), 'exactly two rewrite rules are added' );
foreach ( $rules as $pattern => $target ) {
	is_true( (bool) preg_match( '#' . $pattern . '#', 'cr-a1b2c3d4/js/cr.js' ) || (bool) preg_match( '#' . $pattern . '#', 'cr-a1b2c3d4/api/event' ), 'the rule "' . $pattern . '" matches its own path' );
	has_text( 'index.php?credible_proxy=', $target, 'the rule resolves to the plugin query variable' );
}
is_true( ! preg_match( '#' . array_keys( $rules )[0] . '#', 'cr-a1b2c3d4/js/other.js' ), 'the script rule is anchored and does not serve arbitrary files' );

list( $proxy, $tracker ) = with_settings(
	array(
		'instance_url'  => 'https://stats.example.com',
		'domain'        => 'example.com',
		'proxy_enabled' => 0,
	)
);
$proxy->add_rewrite_rules();
is_true( empty( $GLOBALS['cr_state']['rewrite_rules'] ), 'no rules are registered while the proxy is off' );
is_same( false, $proxy->is_active(), 'the proxy is inactive when the switch is off' );

/* ==================================================================== *
 * Who gets tracked
 * ==================================================================== */

list( $proxy, $tracker ) = with_settings( array() );
is_same( false, $tracker->should_track(), 'an unconfigured plugin tracks nobody' );
is_same( '', $tracker->script_url(), 'and prints no script URL' );
is_same( '', $tracker->script_tag_preview(), 'and no tag at all' );

list( $proxy, $tracker ) = with_settings(
	array(
		'instance_url' => 'https://stats.example.com',
		'domain'       => 'example.com',
	)
);
is_same( true, $tracker->should_track(), 'a configured plugin tracks an anonymous visitor' );

$GLOBALS['cr_state']['is_user_logged_in'] = true;
is_same( false, $tracker->should_track(), 'logged-in users are excluded by default' );

$GLOBALS['cr_options'][ Credible_Analytics_Settings::OPTION ]['track_logged_in'] = 1;
is_same( true, $tracker->should_track(), 'until the site opts them in' );

$GLOBALS['cr_state']['is_user_logged_in'] = false;
$GLOBALS['cr_state']['is_preview']        = true;
is_same( false, $tracker->should_track(), 'a post preview is the author, not a visit' );

$GLOBALS['cr_state']['is_preview']            = false;
$GLOBALS['cr_state']['is_customize_preview'] = true;
is_same( false, $tracker->should_track(), 'the customizer is not a visit either' );

$GLOBALS['cr_state']['is_customize_preview'] = false;
$GLOBALS['cr_state']['is_admin']             = true;
is_same( false, $tracker->should_track(), 'wp-admin is never tracked' );

/* ==================================================================== *
 * The two public filters
 *
 * Both are documented API, so both are exercised here rather than trusted.
 * The attribute filter is the interesting one: it is the only route by which
 * a name the plugin did not choose reaches the markup, and an attribute name
 * cannot be made safe by escaping it — character references are not decoded
 * in name position, so `data-x" onerror="alert(1)` escaped with esc_attr()
 * still tokenises into a live onerror handler on the script tag. Names are
 * therefore validated and dropped, not escaped.
 * ==================================================================== */

list( $proxy, $tracker ) = with_settings(
	array(
		'instance_url' => 'https://stats.example.com',
		'domain'       => 'example.com',
	)
);

add_filter(
	'credible_analytics_script_attributes',
	function ( $attributes ) {
		$attributes['data-team']                 = 'growth';       // Ordinary use.
		$attributes['data-note']                 = '" onload="x';  // Hostile value.
		$attributes['data-x" onerror="alert(1)'] = 'y';            // Hostile name.
		$attributes['src']                       = 'https://evil.example.com/x.js';
		$attributes['id']                        = 'not-ours';
		return $attributes;
	}
);
$tag = $tracker->script_tag_preview();

has_text( 'data-team="growth"', $tag, 'a filter can add an attribute' );
has_text( 'data-note="&quot; onload=&quot;x"', $tag, 'a hostile attribute value is escaped, not dropped' );
is_true( false === strpos( $tag, 'onerror' ), 'a hostile attribute name is dropped entirely' );
is_true( false === strpos( $tag, 'data-x' ), 'and nothing of it survives' );
is_true( false === strpos( $tag, 'evil.example.com' ), 'a filter cannot repoint src, which HTML would let win' );
is_same( 1, substr_count( $tag, ' src="' ), 'the tag carries exactly one src' );
is_same( 1, substr_count( $tag, ' id="' ), 'and exactly one id' );
has_text( 'id="credible-analytics-js"', $tag, 'the plugin keeps its own id' );
is_same( 1, substr_count( $tag, '<script' ), 'the tag is still a single well-formed element' );

list( $proxy, $tracker ) = with_settings(
	array(
		'instance_url' => 'https://stats.example.com',
		'domain'       => 'example.com',
	)
);
is_same( true, $tracker->should_track(), 'an anonymous visitor is tracked before the filter' );
add_filter(
	'credible_analytics_should_track',
	function () {
		return false;
	}
);
is_same( false, $tracker->should_track(), 'and a site can opt the request out' );

/* ==================================================================== *
 * Summary
 * ==================================================================== */

$failed = count( $GLOBALS['cr_failed'] );
$total  = $GLOBALS['cr_passed'] + $failed;

foreach ( $GLOBALS['cr_failed'] as $index => $failure ) {
	echo 'not ok ' . ( $index + 1 ) . ' - ' . $failure . PHP_EOL;
}

echo PHP_EOL;
echo '# php      ' . PHP_VERSION . PHP_EOL;
echo '# tests    ' . $total . PHP_EOL;
echo '# pass     ' . $GLOBALS['cr_passed'] . PHP_EOL;
echo '# fail     ' . $failed . PHP_EOL;

exit( $failed > 0 ? 1 : 0 );
