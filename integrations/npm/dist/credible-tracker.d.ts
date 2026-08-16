/**
 * Type declarations for credible-tracker.
 *
 * Copied verbatim by build.js to dist/credible-tracker.d.ts (ESM) and
 * dist/credible-tracker.d.cts (CommonJS). The two builds expose the same
 * named exports, so one declaration file serves both.
 */

/** A flat property bag. The tracker drops anything that is not a scalar. */
export interface CredibleProps {
  [key: string]: string | number | boolean;
}

/** Monetary value attached to an event. */
export interface CredibleRevenue {
  amount: number | string;
  /** ISO 4217, e.g. 'EUR'. Falls back to the site's configured currency. */
  currency?: string;
}

/** What a `callback` receives once the request has settled. */
export interface CredibleResult {
  /** 202 via sendBeacon, the XHR status otherwise, 0 when nothing was sent. */
  status: number;
  /** True when the event was dropped in the browser (localhost, opt-out, exclusion). */
  ignored?: boolean;
  /** True when the request could not be created at all. */
  error?: boolean;
}

export interface CredibleEventOptions {
  props?: CredibleProps;
  revenue?: CredibleRevenue;
  /** Called once, after every configured domain has settled. */
  callback?: (result: CredibleResult) => void;
  /** Override the reported URL for this event. */
  url?: string;
  /** Override the referrer for this event. `null` reports no referrer. */
  referrer?: string | null;
}

export interface CrediblePageviewOptions extends CredibleEventOptions {}

export interface CredibleInitOptions {
  /** Origin of your Credible instance, e.g. 'https://stats.example.com'. Required unless `src` is set. */
  instanceUrl?: string;
  /** Site domain(s), exactly as added in the dashboard. */
  domain: string | string[];
  /** Full script URL, overriding `instanceUrl` + `scriptPath`. */
  src?: string;
  /** Path the tracker is served from. Defaults to '/js/cr.js'. */
  scriptPath?: string;
  /** `data-api`: the ingestion endpoint, when you proxy events through your own domain. */
  api?: string;
  /** `data-hash`: treat URL fragments as separate pages (hash routers). */
  hash?: boolean;
  /** `data-exclude`: path globs that are never tracked. `*` stays inside a segment, `**` crosses. */
  exclude?: string | string[];
  /** `data-respect-dnt`: honour the browser's Do Not Track signal. Off by default. */
  respectDnt?: boolean;
  /** `data-track-localhost`: count traffic from local hostnames. Development only. */
  trackLocalhost?: boolean;
  /** `data-debug`, plus warnings from this wrapper. */
  debug?: boolean;
  /** Load the script with `defer`. Defaults to true. */
  defer?: boolean;
  /** Called once the tracker has loaded. */
  onLoad?: () => void;
  /** Called when the script fails to load — usually a content blocker. */
  onError?: () => void;
}

/**
 * Load the Credible tracker.
 *
 * Idempotent, and a no-op returning `null` during server-side rendering.
 * Throws when `domain` is missing, or when neither `instanceUrl` nor `src`
 * is given — those are configuration mistakes worth catching in development.
 */
export declare function init(options: CredibleInitOptions): HTMLScriptElement | null;

/**
 * Send a custom event. Queued if the tracker has not loaded yet, dropped on
 * the server, and never throws.
 */
export declare function trackEvent(name: string, options?: CredibleEventOptions): void;

/**
 * Send a pageview and make that URL the one engagement is measured against.
 *
 * The tracker sends one on load and one per history navigation on its own, so
 * this is for virtual pageviews rather than ordinary client-side routing.
 */
export declare function trackPageview(overrides?: CrediblePageviewOptions): void;
