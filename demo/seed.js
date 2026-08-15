/**
 * Demo data generator.
 *
 * Produces traffic that *looks* like a real small SaaS: weekday seasonality, a
 * slow growth trend, a long tail of referrers, a handful of viral days, and
 * conversion funnels that actually converge. Everything goes through the real
 * ingestion pipeline, so the numbers the dashboard shows are computed exactly
 * the way production numbers are.
 */
import { get, transaction } from '../src/db/index.js';
import { createSite, findSiteByDomain, normalizeDomain } from '../src/sites.js';
import { createFunnel, createGoal, listGoals } from '../src/goals.js';
import { recordEvent } from '../src/ingest/index.js';

/** Deterministic PRNG so `credible seed` is reproducible. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PAGES = [
  { path: '/', weight: 30, entry: 40 },
  { path: '/listings', weight: 14, entry: 12 },
  { path: '/analyse-zone', weight: 10, entry: 9 },
  { path: '/dashboard', weight: 9, entry: 4 },
  { path: '/dashboard/profil-investisseur', weight: 6, entry: 2 },
  { path: '/dashboard/alertes', weight: 5, entry: 1 },
  { path: '/hub', weight: 5, entry: 3 },
  { path: '/pricing', weight: 7, entry: 6 },
  { path: '/blog/investir-en-2026', weight: 6, entry: 9 },
  { path: '/blog/rendement-locatif', weight: 5, entry: 8 },
  { path: '/auth/sign-up', weight: 6, entry: 3 },
  { path: '/account', weight: 4, entry: 1 },
  { path: '/docs/api', weight: 3, entry: 2 },
];

const REFERRERS = [
  { url: '', weight: 34 },
  { url: 'https://www.google.com/', weight: 22 },
  { url: 'https://news.ycombinator.com/item?id=41234567', weight: 6 },
  { url: 'https://www.bing.com/search', weight: 3 },
  { url: 'https://duckduckgo.com/', weight: 3 },
  { url: 'https://www.linkedin.com/feed/', weight: 5 },
  { url: 'https://x.com/home', weight: 5 },
  { url: 'https://www.reddit.com/r/vosfinances/', weight: 4 },
  { url: 'https://github.com/credible-analytics/credible', weight: 3 },
  { url: 'https://chatgpt.com/', weight: 3 },
  { url: 'https://www.perplexity.ai/', weight: 2 },
  { url: 'https://www.producthunt.com/posts/credible', weight: 2 },
  { url: 'https://mail.google.com/', weight: 2 },
  { url: 'https://blog.lemonde.fr/immobilier', weight: 2 },
  { url: 'https://www.youtube.com/watch?v=abcdef', weight: 2 },
];

const CAMPAIGNS = [
  '',
  '?utm_source=newsletter&utm_medium=email&utm_campaign=juin-2026',
  '?utm_source=google&utm_medium=cpc&utm_campaign=brand&gclid=EAIaIQobChMI',
  '?utm_source=linkedin&utm_medium=paid-social&utm_campaign=launch',
  '?utm_source=producthunt&utm_medium=referral&utm_campaign=launch-day',
];

const AGENTS = [
  { ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', weight: 20, width: 1680 },
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', weight: 22, width: 1920 },
  { ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15', weight: 11, width: 1440 },
  { ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1', weight: 21, width: 390 },
  { ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36', weight: 12, width: 412 },
  { ua: 'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1', weight: 4, width: 820 },
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0', weight: 5, width: 1600 },
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0', weight: 5, width: 1920 },
];

const PLACES = [
  { country: 'FR', region: 'Île-de-France', city: 'Paris', weight: 34 },
  { country: 'FR', region: 'Auvergne-Rhône-Alpes', city: 'Lyon', weight: 8 },
  { country: 'FR', region: "Provence-Alpes-Côte d'Azur", city: 'Marseille', weight: 6 },
  { country: 'BE', region: 'Brussels', city: 'Brussels', weight: 5 },
  { country: 'CH', region: 'Geneva', city: 'Geneva', weight: 4 },
  { country: 'US', region: 'California', city: 'San Francisco', weight: 9 },
  { country: 'US', region: 'New York', city: 'New York', weight: 7 },
  { country: 'GB', region: 'England', city: 'London', weight: 6 },
  { country: 'DE', region: 'Berlin', city: 'Berlin', weight: 5 },
  { country: 'ES', region: 'Madrid', city: 'Madrid', weight: 4 },
  { country: 'CA', region: 'Quebec', city: 'Montreal', weight: 3 },
  { country: 'NL', region: 'North Holland', city: 'Amsterdam', weight: 3 },
  { country: 'PT', region: 'Lisbon', city: 'Lisbon', weight: 2 },
  { country: 'MA', region: 'Casablanca-Settat', city: 'Casablanca', weight: 2 },
  { country: 'BR', region: 'São Paulo', city: 'São Paulo', weight: 2 },
  { country: 'JP', region: 'Tokyo', city: 'Tokyo', weight: 1 },
  { country: 'AU', region: 'New South Wales', city: 'Sydney', weight: 1 },
  { country: 'IN', region: 'Karnataka', city: 'Bengaluru', weight: 2 },
];

function weightedPick(random, items) {
  const total = items.reduce((sum, item) => sum + (item.weight ?? 1), 0);
  let target = random() * total;
  for (const item of items) {
    target -= item.weight ?? 1;
    if (target <= 0) return item;
  }
  return items[items.length - 1];
}

/**
 * @param {object} options
 * @param {string} options.domain
 * @param {number} options.days           how far back to generate
 * @param {number} options.dailyVisitors  average visitors on a mid-week day
 */
export function seed({ domain = 'demo.credible.dev', days = 60, dailyVisitors = 220, seed: seedValue = 20260815 } = {}) {
  const normalized = normalizeDomain(domain);
  const site =
    findSiteByDomain(normalized) ||
    createSite({ domain: normalized, timezone: 'Europe/Paris', currency: 'EUR' });

  const random = mulberry32(seedValue);
  const nowUnix = Math.floor(Date.now() / 1000);
  const events = [];

  // A pool of returning people. Someone who comes back keeps their device and
  // location, and is far more likely to arrive directly — which is what makes
  // "unique visitors" smaller than "total visits" the way it is in real life.
  const audience = [];
  const pickPerson = () => {
    if (audience.length > 80 && random() < 0.42) {
      const recent = Math.min(audience.length, 900);
      return audience[audience.length - 1 - Math.floor(random() * recent)];
    }
    const person = {
      id: `v${audience.length.toString(36)}${Math.floor(random() * 1e9).toString(36)}`,
      agent: weightedPick(random, AGENTS),
      place: weightedPick(random, PLACES),
      returning: false,
    };
    audience.push(person);
    return person;
  };

  for (let dayOffset = days - 1; dayOffset >= 0; dayOffset -= 1) {
    const dayStart = nowUnix - dayOffset * 86400;
    const weekday = new Date(dayStart * 1000).getUTCDay();
    const weekendFactor = weekday === 0 || weekday === 6 ? 0.55 : 1;
    const growth = 1 + ((days - dayOffset) / days) * 0.8;
    const spike = random() < 0.05 ? 2.4 : 1; // the odd Hacker News day
    const visitors = Math.max(3, Math.round(dailyVisitors * weekendFactor * growth * spike * (0.75 + random() * 0.5)));

    for (let v = 0; v < visitors; v += 1) {
      // Today is only partially over — do not generate traffic from the future.
      const maxSecond = dayOffset === 0 ? (nowUnix % 86400) : 86400;
      const secondOfDay = Math.floor(dayHour(random) * 3600 + random() * 3600);
      if (secondOfDay > maxSecond - 60) continue;

      const start = dayStart - (dayStart % 86400) + secondOfDay;
      if (start > nowUnix - 30) continue;

      const person = pickPerson();
      const { agent, place } = person;
      const returning = person.returning;
      person.returning = true;
      const referrer = returning && random() < 0.6 ? '' : weightedPick(random, REFERRERS).url;
      const campaign = !returning && random() < 0.14 ? CAMPAIGNS[Math.floor(random() * CAMPAIGNS.length)] : '';
      const visitorId = person.id;

      const headers = {
        'cf-ipcountry': place.country,
        'x-geo-region': place.region,
        'x-geo-city': place.city,
      };
      const ctx = {
        ip: `203.0.113.${Math.floor(random() * 250)}`,
        userAgent: agent.ua,
        headers,
        visitorId,
      };

      const bounced = random() < 0.42;
      const pageCount = bounced ? 1 : 1 + Math.floor(random() * random() * 7);
      let timestamp = start;
      let entry = weightedPick(random, PAGES.map((p) => ({ ...p, weight: p.entry })));

      for (let i = 0; i < pageCount; i += 1) {
        const page = i === 0 ? entry : weightedPick(random, PAGES);
        const url = `https://${normalized}${page.path}${i === 0 ? campaign : ''}`;

        events.push({
          timestamp,
          body: {
            n: 'pageview',
            d: normalized,
            u: url,
            r: i === 0 ? referrer : `https://${normalized}${entry.path}`,
            w: agent.width,
          },
          ctx,
        });

        const engaged = Math.round((8 + random() * 220) * 1000);
        events.push({
          timestamp: timestamp + Math.round(engaged / 1000),
          body: {
            n: 'engagement',
            d: normalized,
            u: url,
            r: referrer,
            w: agent.width,
            e: { t: engaged, s: Math.round(20 + random() * 80) },
          },
          ctx,
        });

        // Conversions
        if (page.path === '/auth/sign-up' && random() < 0.34) {
          events.push({
            timestamp: timestamp + 20,
            body: {
              n: 'Signup',
              d: normalized,
              u: url,
              w: agent.width,
              p: { plan: random() < 0.3 ? 'pro' : 'free', source: campaign ? 'campaign' : 'organic' },
            },
            ctx,
          });
          if (random() < 0.22) {
            events.push({
              timestamp: timestamp + 90,
              body: {
                n: 'Purchase',
                d: normalized,
                u: `https://${normalized}/account`,
                w: agent.width,
                p: { plan: 'pro' },
                v: { amount: [19, 39, 99][Math.floor(random() * 3)], currency: 'EUR' },
              },
              ctx,
            });
          }
        }
        if (random() < 0.06) {
          events.push({
            timestamp: timestamp + 12,
            body: { n: 'Form: Submission', d: normalized, u: url, w: agent.width },
            ctx,
          });
        }
        if (random() < 0.04) {
          events.push({
            timestamp: timestamp + 15,
            body: {
              n: 'Outbound Link: Click',
              d: normalized,
              u: url,
              w: agent.width,
              p: { url: 'https://www.service-public.fr/particuliers' },
            },
            ctx,
          });
        }
        if (page.path.startsWith('/docs') && random() < 0.2) {
          events.push({
            timestamp: timestamp + 25,
            body: {
              n: 'File Download',
              d: normalized,
              u: url,
              w: agent.width,
              p: { url: `https://${normalized}/files/credible-api.pdf` },
            },
            ctx,
          });
        }

        timestamp += 20 + Math.round(random() * 260);
        entry = i === 0 ? entry : page;
      }
    }
  }

  events.sort((a, b) => a.timestamp - b.timestamp);

  let written = 0;
  const CHUNK = 4000;
  for (let i = 0; i < events.length; i += CHUNK) {
    transaction(() => {
      for (const event of events.slice(i, i + CHUNK)) {
        const result = recordEvent(event.body, { ...event.ctx, timestamp: event.timestamp });
        if (result.status === 'ok') written += 1;
      }
    });
  }

  ensureDemoGoals(site);

  return { site, events: written, visits: countVisits(site.id) };
}

/** Peak hours: a working-day shaped distribution. */
function dayHour(random) {
  const hours = [0.4, 0.2, 0.15, 0.1, 0.1, 0.2, 0.5, 1.2, 2.4, 3.4, 3.8, 3.6, 3.1, 3.4, 3.8, 3.9, 3.6, 3.1, 2.6, 2.2, 1.9, 1.5, 1.0, 0.7];
  const total = hours.reduce((a, b) => a + b, 0);
  let target = random() * total;
  for (let h = 0; h < hours.length; h += 1) {
    target -= hours[h];
    if (target <= 0) return h;
  }
  return 12;
}

function ensureDemoGoals(site) {
  const existing = listGoals(site.id);
  if (existing.length) return;

  const signup = createGoal(site.id, { type: 'event', event_name: 'Signup', display_name: 'Signup' });
  const purchase = createGoal(site.id, { type: 'event', event_name: 'Purchase', display_name: 'Purchase' });
  createGoal(site.id, { type: 'event', event_name: 'Form: Submission', display_name: 'Form: Submission' });
  createGoal(site.id, { type: 'event', event_name: 'Outbound Link: Click', display_name: 'Outbound Link: Click' });
  createGoal(site.id, { type: 'event', event_name: 'File Download', display_name: 'File Download' });
  const pricing = createGoal(site.id, { type: 'page', page_path: '/pricing', display_name: 'Visit /pricing' });
  const signupPage = createGoal(site.id, { type: 'page', page_path: '/auth/sign-up', display_name: 'Visit /auth/sign-up' });

  createFunnel(site.id, {
    name: 'Signup funnel',
    goalIds: [pricing.id, signupPage.id, signup.id, purchase.id],
  });
}

function countVisits(siteId) {
  return Number(get('SELECT count(*) AS c FROM visits WHERE site_id = ?', [siteId]).c);
}
