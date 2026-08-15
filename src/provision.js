/**
 * Zero-touch setup.
 *
 * One function that takes an instance from "nothing at all" to "ready to
 * install": account, API key, site. Shared by `POST /api/v1/provision` and
 * `credible provision`, so the HTTP and CLI paths can never drift apart.
 *
 * The rules are deliberately friendly to an automated caller:
 *   • no account yet          -> create it (this is the bootstrap case)
 *   • account exists, open    -> create another one
 *   • account exists, locked  -> refuse unless the caller proves who they are
 *   • email already known     -> accept its password, or an API key, then reuse it
 *   • domain already tracked  -> reuse it if the caller owns it, refuse otherwise
 */
import { config } from './config.js';
import {
  authenticate,
  createApiKey,
  createUser,
  findUserByEmail,
  normalizeEmail,
  randomPassword,
  userCount,
} from './auth/index.js';
import { canAccess, createSite, findSiteByDomain, normalizeDomain } from './sites.js';
import { HttpError } from './util/http.js';

/**
 * @param {object} input
 * @param {string} [input.email]      required unless `user` is supplied
 * @param {string} [input.password]   generated (and returned) when absent
 * @param {string} [input.name]
 * @param {string} [input.domain]     site to create; omit to only create the account
 * @param {string} [input.timezone]
 * @param {string} [input.currency]
 * @param {string} [input.keyName]
 * @param {object} [input.user]       an already-authenticated user (e.g. from a Bearer key)
 * @returns {{user: object, password: string|null, apiKey: string, site: object|null,
 *            created: {user: boolean, site: boolean}}}
 */
export function provision({
  email,
  password,
  name = '',
  domain = '',
  timezone = 'UTC',
  currency = 'EUR',
  keyName = 'Provisioned key',
  user = null,
} = {}) {
  let account = user;
  let generatedPassword = null;
  let createdUser = false;

  if (!account) {
    const normalized = normalizeEmail(email);
    const known = findUserByEmail(normalized);

    if (known) {
      if (!password) {
        throw new HttpError(
          409,
          'An account already exists for this email. Send its password, or authenticate with an existing API key.',
        );
      }
      account = authenticate(normalized, password);
    } else {
      if (userCount() > 0 && !config.openRegistration) {
        throw new HttpError(403, 'Registration is closed on this instance');
      }
      generatedPassword = password ? null : randomPassword();
      account = createUser({ email: normalized, password: password || generatedPassword, name });
      createdUser = true;
    }
  }

  const apiKey = createApiKey(account.id, String(keyName).slice(0, 80));

  let site = null;
  let createdSite = false;
  if (domain) {
    const normalizedDomain = normalizeDomain(domain);
    const existing = findSiteByDomain(normalizedDomain);
    if (existing) {
      if (!canAccess(account, existing)) {
        throw new HttpError(409, 'That domain is already tracked by another account');
      }
      site = existing;
    } else {
      site = createSite({ domain: normalizedDomain, timezone, currency, userId: account.id });
      createdSite = true;
    }
  }

  return {
    user: account,
    password: generatedPassword, // null when the caller chose it — never echo a known secret
    apiKey,
    site,
    created: { user: createdUser, site: createdSite },
  };
}

/** The install snippet for a site on a given instance origin. */
export function snippetFor(origin, domain) {
  return `<script defer data-domain="${domain}" src="${origin}/js/cr.js"></script>`;
}

/** What to tell the caller to do next, in order. */
export function nextSteps(origin, site) {
  if (!site) {
    return ['Create a site: POST /api/sites {"domain":"example.com"} with the Bearer key above.'];
  }
  return [
    'Put the snippet in the <head> of every page you want to measure.',
    `Confirm it works: GET ${origin}/api/stats/${site.domain}/realtime`,
    'Keep api_key secret — it can read and change everything in this account.',
  ];
}
