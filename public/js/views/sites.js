/** The "all sites" screen, plus the add-a-site flow and its install snippet. */
import { h, icon, modal, toast } from '../dom.js';
import { shortNumber } from '../format.js';

const TIMEZONES = (() => {
  try {
    if (typeof Intl.supportedValuesOf === 'function') return Intl.supportedValuesOf('timeZone');
  } catch {
    /* older runtime */
  }
  return ['UTC', 'Europe/Paris', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles', 'Asia/Tokyo'];
})();

export async function renderSites(container, ctx) {
  const { state } = ctx;

  container.appendChild(
    h(
      'div',
      { class: 'section-title' },
      h('h2', {}, state.sites.length ? 'Your sites' : 'Track your first site'),
      h('button', { class: 'btn primary', type: 'button', onClick: () => addSite(ctx) }, icon('plus', 15), 'Add a site'),
    ),
  );

  if (!state.sites.length) {
    container.appendChild(
      h(
        'div',
        { class: 'card', style: { padding: '40px', textAlign: 'center' } },
        h('p', { class: 'notice', style: { marginTop: 0 } },
          'Add a domain, drop one script tag in your <head>, and your dashboard starts filling up. No cookies, no consent banner.'),
        h('button', { class: 'btn primary', type: 'button', onClick: () => addSite(ctx) }, 'Add a site'),
      ),
    );
  } else {
    const grid = h('div', { class: 'site-grid' });
    for (const site of state.sites) {
      grid.appendChild(
        h(
          'a',
          { class: 'card site-card', href: `/${site.domain}`, onClick: ctx.link(`/${site.domain}`) },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' } },
            h('h3', {}, site.domain),
            h('span', { class: 'notice' }, site.timezone),
          ),
          h(
            'div',
            { class: `live${site.current_visitors ? '' : ' idle'}` },
            h('span', { class: 'dot' }),
            `${shortNumber(site.current_visitors || 0)} current visitor${site.current_visitors === 1 ? '' : 's'}`,
          ),
        ),
      );
    }
    container.appendChild(grid);
  }

  if (new URLSearchParams(location.search).get('new')) addSite(ctx);
}

export function addSite(ctx) {
  const form = h('form', {});
  const error = h('p', { class: 'error', style: { display: 'none' } });
  const domain = h('input', { type: 'text', placeholder: 'example.com', required: true, autocapitalize: 'off', spellcheck: 'false' });

  const guessed = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const timezone = h('select', {}, ...TIMEZONES.map((tz) => h('option', { value: tz, selected: tz === guessed }, tz)));
  const currency = h(
    'select',
    {},
    ...['EUR', 'USD', 'GBP', 'CHF', 'CAD', 'AUD', 'JPY', 'BRL', 'INR'].map((code) => h('option', { value: code }, code)),
  );

  const submit = h('button', { class: 'btn primary', type: 'submit' }, 'Add site');

  form.append(
    h('h2', {}, 'Add a site'),
    h('p', { class: 'hint' }, 'Your dashboard is ready the moment the first pageview lands.'),
    error,
    h('div', { class: 'field' }, h('label', {}, 'Domain'), domain, h('small', {}, 'Without http:// and without www.')),
    h('div', { class: 'field' }, h('label', {}, 'Reporting timezone'), timezone),
    h('div', { class: 'field' }, h('label', {}, 'Revenue currency'), currency),
    h('div', { class: 'form-actions' }, h('button', { class: 'btn', type: 'button', onClick: () => close() }, 'Cancel'), submit),
  );

  const close = modal(form);

  form.onsubmit = async (event) => {
    event.preventDefault();
    error.style.display = 'none';
    submit.disabled = true;
    try {
      const { site, snippet } = await ctx.api.createSite(domain.value, timezone.value, currency.value);
      await ctx.refreshSession();
      close();
      showSnippet(site.domain, snippet, ctx);
    } catch (err) {
      error.textContent = err.message;
      error.style.display = 'block';
      submit.disabled = false;
    }
  };
}

export function showSnippet(domain, snippet, ctx) {
  const body = h('div', {});
  const code = h('pre', { class: 'snippet' }, snippet);
  body.append(
    h('h2', {}, `Install Credible on ${domain}`),
    h('p', { class: 'hint' }, 'Paste this in the <head> of every page you want to measure.'),
    code,
    h(
      'div',
      { class: 'form-actions' },
      h(
        'button',
        {
          class: 'btn',
          type: 'button',
          onClick: async () => {
            try {
              await navigator.clipboard.writeText(snippet);
              toast('Snippet copied');
            } catch {
              const range = document.createRange();
              range.selectNodeContents(code);
              window.getSelection().removeAllRanges();
              window.getSelection().addRange(range);
            }
          },
        },
        icon('copy', 15),
        'Copy',
      ),
      h('button', { class: 'btn primary', type: 'button', onClick: () => { close(); ctx.navigate(`/${domain}`); } }, 'Open dashboard'),
    ),
  );
  const close = modal(body);
}
