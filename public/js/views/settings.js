/** Site settings and the account screen. */
import { clear, h, icon, modal, replace, toast } from '../dom.js';
import { showSnippet } from './sites.js';

function section(title, description, ...children) {
  return h(
    'section',
    { class: 'card settings-section' },
    h('h3', {}, title),
    description ? h('p', {}, description) : null,
    ...children,
  );
}

export async function renderSiteSettings(container, ctx) {
  const { api, domain } = ctx;
  const payload = await api.site(domain);

  container.appendChild(
    h(
      'div',
      { class: 'section-title' },
      h(
        'div',
        {},
        h('h2', {}, domain),
        h('p', { class: 'notice', style: { margin: 0 } }, 'Site settings'),
      ),
      h('a', { class: 'btn', href: `/${domain}`, onClick: ctx.link(`/${domain}`) }, 'Back to dashboard'),
    ),
  );

  // ------------------------------------------------------------- install --
  const installed = payload.data_range?.first;
  container.appendChild(
    section(
      'Install',
      'One script tag in the <head>. No cookies, no consent banner, nothing else to configure.',
      h('pre', { class: 'snippet' }, payload.snippet),
      h(
        'div',
        { style: { display: 'flex', gap: '8px', marginTop: '12px', alignItems: 'center' } },
        h(
          'button',
          {
            class: 'btn',
            type: 'button',
            onClick: async () => {
              await navigator.clipboard.writeText(payload.snippet);
              toast('Snippet copied');
            },
          },
          icon('copy', 15),
          'Copy',
        ),
        h('button', { class: 'btn ghost', type: 'button', onClick: () => showSnippet(domain, payload.snippet, ctx) }, 'Show instructions'),
        h(
          'span',
          { class: 'notice' },
          installed ? '✓ Receiving data' : 'Waiting for the first pageview…',
        ),
      ),
    ),
  );

  // ------------------------------------------------------------- general --
  const timezone = h('input', { type: 'text', value: payload.site.timezone });
  const currency = h('input', { type: 'text', value: payload.site.currency, maxlength: '3' });
  const isPublic = h('input', { type: 'checkbox', checked: payload.site.public, style: { width: 'auto' } });
  const excludedPaths = h('textarea', { rows: '3', placeholder: '/admin/*\n/preview/**' }, payload.settings.excluded_paths);
  const excludedIps = h('textarea', { rows: '2', placeholder: '203.0.113.4' }, payload.settings.excluded_ips);

  container.appendChild(
    section(
      'General',
      'Reporting timezone, revenue currency, and what to leave out of the numbers.',
      h('div', { class: 'field' }, h('label', {}, 'Timezone'), timezone),
      h('div', { class: 'field' }, h('label', {}, 'Revenue currency'), currency),
      h(
        'div',
        { class: 'field' },
        h('label', { style: { display: 'flex', gap: '8px', alignItems: 'center' } }, isPublic, 'Make the dashboard public — anyone with the URL can read it'),
      ),
      h('div', { class: 'field' }, h('label', {}, 'Excluded pages'), excludedPaths, h('small', {}, 'One glob per line. * matches within a segment, ** across segments.')),
      h('div', { class: 'field' }, h('label', {}, 'Excluded IP addresses'), excludedIps, h('small', {}, 'Your office IP, for example. IPs are never stored — they are only compared at ingest.')),
      h(
        'div',
        { class: 'form-actions' },
        h(
          'button',
          {
            class: 'btn primary',
            type: 'button',
            onClick: async (event) => {
              event.target.disabled = true;
              try {
                await api.updateSite(domain, {
                  timezone: timezone.value.trim(),
                  currency: currency.value.trim(),
                  public: isPublic.checked,
                  excluded_paths: excludedPaths.value,
                  excluded_ips: excludedIps.value,
                });
                toast('Saved');
              } catch (err) {
                toast(err.message);
              }
              event.target.disabled = false;
            },
          },
          'Save changes',
        ),
      ),
    ),
  );

  // --------------------------------------------------------------- goals --
  const goalsList = h('ul', { class: 'list' });
  const drawGoals = (goals) => {
    clear(goalsList);
    if (!goals.length) {
      goalsList.appendChild(h('li', { class: 'notice' }, 'No goals yet.'));
      return;
    }
    for (const goal of goals) {
      goalsList.appendChild(
        h(
          'li',
          {},
          h(
            'div',
            { class: 'grow' },
            goal.display_name || goal.event_name || goal.page_path,
            h('small', {}, goal.type === 'page' ? `Pageview · ${goal.page_path}` : `Custom event · ${goal.event_name}`),
          ),
          h(
            'button',
            {
              class: 'btn danger',
              type: 'button',
              onClick: async () => {
                await api.deleteGoal(domain, goal.id);
                payload.goals = payload.goals.filter((g) => g.id !== goal.id);
                drawGoals(payload.goals);
              },
            },
            icon('trash', 15),
          ),
        ),
      );
    }
  };
  drawGoals(payload.goals);

  container.appendChild(
    section(
      'Goals',
      'A goal is a custom event or a page. Conversions and conversion rates show up on the dashboard.',
      goalsList,
      payload.suggested_goals?.length
        ? h(
            'p',
            { class: 'notice', style: { marginTop: '12px' } },
            'Seen recently: ',
            ...payload.suggested_goals.slice(0, 6).flatMap((suggestion, index) => [
              index ? ', ' : '',
              h(
                'button',
                {
                  class: 'link-btn',
                  type: 'button',
                  onClick: async () => {
                    const goal = await api.createGoal(domain, { type: 'event', event_name: suggestion.name });
                    payload.goals.push(goal.goal);
                    drawGoals(payload.goals);
                  },
                },
                suggestion.name,
              ),
            ]),
          )
        : null,
      h(
        'div',
        { class: 'form-actions' },
        h('button', { class: 'btn', type: 'button', onClick: () => addGoal(ctx, domain, payload, drawGoals) }, icon('plus', 15), 'Add goal'),
      ),
    ),
  );

  // ------------------------------------------------------------- funnels --
  const funnelsList = h('ul', { class: 'list' });
  const drawFunnels = (funnels) => {
    clear(funnelsList);
    if (!funnels.length) {
      funnelsList.appendChild(h('li', { class: 'notice' }, 'No funnels yet.'));
      return;
    }
    for (const funnel of funnels) {
      funnelsList.appendChild(
        h(
          'li',
          {},
          h('div', { class: 'grow' }, funnel.name, h('small', {}, funnel.steps.map((s) => s.display_name).join(' → '))),
          h(
            'button',
            {
              class: 'btn danger',
              type: 'button',
              onClick: async () => {
                await api.deleteFunnel(domain, funnel.id);
                payload.funnels = payload.funnels.filter((f) => f.id !== funnel.id);
                drawFunnels(payload.funnels);
              },
            },
            icon('trash', 15),
          ),
        ),
      );
    }
  };
  drawFunnels(payload.funnels);

  container.appendChild(
    section(
      'Funnels',
      'Chain two or more goals to see where people drop off.',
      funnelsList,
      h(
        'div',
        { class: 'form-actions' },
        h(
          'button',
          {
            class: 'btn',
            type: 'button',
            onClick: () => addFunnel(ctx, domain, payload, drawFunnels),
          },
          icon('plus', 15),
          'Create funnel',
        ),
      ),
    ),
  );

  // -------------------------------------------------------- shared links --
  const linksList = h('ul', { class: 'list' });
  const drawLinks = (links) => {
    clear(linksList);
    if (!links.length) {
      linksList.appendChild(h('li', { class: 'notice' }, 'No shared links yet.'));
      return;
    }
    for (const shared of links) {
      const url = `${location.origin}/share/${domain}?auth=${shared.slug}`;
      linksList.appendChild(
        h(
          'li',
          {},
          h('div', { class: 'grow' }, shared.name || 'Shared dashboard', h('small', {}, url)),
          shared.protected ? h('span', { class: 'notice' }, 'password') : null,
          h(
            'button',
            {
              class: 'btn',
              type: 'button',
              onClick: async () => {
                await navigator.clipboard.writeText(url);
                toast('Link copied');
              },
            },
            icon('copy', 15),
          ),
          h(
            'button',
            {
              class: 'btn danger',
              type: 'button',
              onClick: async () => {
                await api.deleteSharedLink(domain, shared.slug);
                payload.shared_links = payload.shared_links.filter((l) => l.slug !== shared.slug);
                drawLinks(payload.shared_links);
              },
            },
            icon('trash', 15),
          ),
        ),
      );
    }
  };
  drawLinks(payload.shared_links);

  const linkName = h('input', { type: 'text', placeholder: 'Marketing team' });
  const linkPassword = h('input', { type: 'password', placeholder: 'Optional password' });
  container.appendChild(
    section(
      'Shared dashboards',
      'Read-only links, with an optional password. No account required to view them.',
      linksList,
      h('div', { class: 'field', style: { marginTop: '14px' } }, h('label', {}, 'Name'), linkName),
      h('div', { class: 'field' }, h('label', {}, 'Password'), linkPassword),
      h(
        'div',
        { class: 'form-actions' },
        h(
          'button',
          {
            class: 'btn',
            type: 'button',
            onClick: async () => {
              const created = await api.createSharedLink(domain, linkName.value, linkPassword.value);
              payload.shared_links.push({ slug: created.slug, name: linkName.value, protected: Boolean(linkPassword.value) });
              linkName.value = '';
              linkPassword.value = '';
              drawLinks(payload.shared_links);
            },
          },
          'Create link',
        ),
      ),
    ),
  );

  // -------------------------------------------------------------- people --
  const memberEmail = h('input', { type: 'email', placeholder: 'teammate@example.com' });
  const memberRole = h('select', {}, h('option', { value: 'viewer' }, 'Viewer'), h('option', { value: 'admin' }, 'Admin'));
  container.appendChild(
    section(
      'People',
      'Everyone listed here can open this dashboard.',
      h(
        'ul',
        { class: 'list' },
        ...payload.members.map((member) =>
          h('li', {}, h('div', { class: 'grow' }, member.name || member.email, h('small', {}, member.email)), h('span', { class: 'notice' }, member.role)),
        ),
      ),
      h('div', { class: 'field', style: { marginTop: '14px' } }, h('label', {}, 'Add someone who already has an account'), memberEmail),
      h('div', { class: 'field' }, h('label', {}, 'Role'), memberRole),
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
                await api.addMember(domain, memberEmail.value, memberRole.value);
                toast('Added');
                ctx.navigate(`/${domain}/settings`);
              } catch (err) {
                toast(err.message);
              }
            },
          },
          'Add',
        ),
      ),
    ),
  );

  // ---------------------------------------------------------- danger zone --
  container.appendChild(
    section(
      'Delete this site',
      'Removes the site and every event ever recorded for it. This cannot be undone.',
      h(
        'button',
        {
          class: 'btn danger',
          type: 'button',
          onClick: () => {
            const body = h('div', {});
            const confirmInput = h('input', { type: 'text', placeholder: domain });
            body.append(
              h('h2', {}, 'Delete this site?'),
              h('p', { class: 'hint' }, `Type ${domain} to confirm. Every event will be deleted.`),
              h('div', { class: 'field' }, confirmInput),
              h(
                'div',
                { class: 'form-actions' },
                h('button', { class: 'btn', type: 'button', onClick: () => close() }, 'Cancel'),
                h(
                  'button',
                  {
                    class: 'btn danger',
                    type: 'button',
                    onClick: async () => {
                      if (confirmInput.value.trim() !== domain) return;
                      await api.deleteSite(domain);
                      await ctx.refreshSession();
                      close();
                      ctx.navigate('/');
                    },
                  },
                  'Delete permanently',
                ),
              ),
            );
            const close = modal(body);
          },
        },
        'Delete site',
      ),
    ),
  );
}

function addGoal(ctx, domain, payload, redraw) {
  const body = h('form', {});
  const type = h('select', {}, h('option', { value: 'event' }, 'Custom event'), h('option', { value: 'page' }, 'Page visit'));
  const value = h('input', { type: 'text', placeholder: 'Signup', required: true });
  const display = h('input', { type: 'text', placeholder: 'Optional display name' });
  const error = h('p', { class: 'error', style: { display: 'none' } });

  type.addEventListener('change', () => {
    value.placeholder = type.value === 'page' ? '/thanks or /blog/*' : 'Signup';
  });

  body.append(
    h('h2', {}, 'Add a goal'),
    error,
    h('div', { class: 'field' }, h('label', {}, 'Goal type'), type),
    h('div', { class: 'field' }, h('label', {}, 'Event name or page path'), value),
    h('div', { class: 'field' }, h('label', {}, 'Display name'), display),
    h('div', { class: 'form-actions' }, h('button', { class: 'btn', type: 'button', onClick: () => close() }, 'Cancel'), h('button', { class: 'btn primary', type: 'submit' }, 'Add goal')),
  );
  const close = modal(body);

  body.onsubmit = async (event) => {
    event.preventDefault();
    try {
      const created = await ctx.api.createGoal(domain, {
        type: type.value,
        event_name: type.value === 'event' ? value.value : '',
        page_path: type.value === 'page' ? value.value : '',
        display_name: display.value,
      });
      payload.goals.push(created.goal);
      redraw(payload.goals);
      close();
    } catch (err) {
      error.textContent = err.message;
      error.style.display = 'block';
    }
  };
}

function addFunnel(ctx, domain, payload, redraw) {
  const body = h('form', {});
  const name = h('input', { type: 'text', placeholder: 'Signup funnel', required: true });
  const error = h('p', { class: 'error', style: { display: 'none' } });
  const steps = h('div', { class: 'funnel-steps' });

  const goalOptions = () =>
    payload.goals.map((goal) => h('option', { value: goal.id }, goal.display_name || goal.event_name || goal.page_path));

  const addStep = () => {
    steps.appendChild(h('div', { class: 'field', style: { margin: 0 } }, h('select', {}, ...goalOptions())));
  };

  if (payload.goals.length < 2) {
    const close = modal(
      h(
        'div',
        {},
        h('h2', {}, 'Create a funnel'),
        h('p', { class: 'hint' }, 'You need at least two goals before you can build a funnel.'),
        h('div', { class: 'form-actions' }, h('button', { class: 'btn', type: 'button', onClick: () => close() }, 'Got it')),
      ),
    );
    return;
  }

  addStep();
  addStep();

  body.append(
    h('h2', {}, 'Create a funnel'),
    error,
    h('div', { class: 'field' }, h('label', {}, 'Name'), name),
    h('div', { class: 'field' }, h('label', {}, 'Steps, in order'), steps),
    h('button', { class: 'link-btn', type: 'button', onClick: addStep }, '+ Add a step'),
    h('div', { class: 'form-actions' }, h('button', { class: 'btn', type: 'button', onClick: () => close() }, 'Cancel'), h('button', { class: 'btn primary', type: 'submit' }, 'Create')),
  );
  const close = modal(body);

  body.onsubmit = async (event) => {
    event.preventDefault();
    const goalIds = [...steps.querySelectorAll('select')].map((select) => Number(select.value));
    try {
      const created = await ctx.api.createFunnel(domain, name.value, goalIds);
      payload.funnels.push(created.funnel);
      redraw(payload.funnels);
      close();
    } catch (err) {
      error.textContent = err.message;
      error.style.display = 'block';
    }
  };
}

// ------------------------------------------------------------------ account

export async function renderAccount(container, ctx) {
  const { api, state } = ctx;
  container.appendChild(
    h('div', { class: 'section-title' }, h('h2', {}, 'Account'), h('a', { class: 'btn', href: '/', onClick: ctx.link('/') }, 'All sites')),
  );

  const keysList = h('ul', { class: 'list' });
  const drawKeys = (keys) => {
    clear(keysList);
    if (!keys.length) {
      keysList.appendChild(h('li', { class: 'notice' }, 'No API keys yet.'));
      return;
    }
    for (const key of keys) {
      keysList.appendChild(
        h(
          'li',
          {},
          h('div', { class: 'grow' }, key.name || 'API key', h('small', {}, `${key.key_prefix}…`)),
          h(
            'button',
            {
              class: 'btn danger',
              type: 'button',
              onClick: async () => {
                await api.deleteKey(key.id);
                drawKeys((await api.keys()).keys);
              },
            },
            icon('trash', 15),
          ),
        ),
      );
    }
  };
  drawKeys((await api.keys()).keys);

  const keyOutput = h('div', {});
  container.appendChild(
    section(
      'Stats API keys',
      'Query your own numbers from anywhere: Authorization: Bearer <key>. See docs/API for the endpoints.',
      keysList,
      keyOutput,
      h(
        'div',
        { class: 'form-actions' },
        h(
          'button',
          {
            class: 'btn',
            type: 'button',
            onClick: async () => {
              const { key } = await api.createKey('Stats API key');
              replace(
                keyOutput,
                h('p', { class: 'notice', style: { marginTop: '12px' } }, 'Copy it now — it is not shown again.'),
                h('pre', { class: 'snippet' }, key),
              );
              drawKeys((await api.keys()).keys);
            },
          },
          icon('plus', 15),
          'Create key',
        ),
      ),
    ),
  );

  const currentPassword = h('input', { type: 'password', autocomplete: 'current-password' });
  const newPassword = h('input', { type: 'password', autocomplete: 'new-password', minlength: '8' });
  container.appendChild(
    section(
      'Password',
      `Signed in as ${state.user.email}.`,
      h('div', { class: 'field' }, h('label', {}, 'Current password'), currentPassword),
      h('div', { class: 'field' }, h('label', {}, 'New password'), newPassword),
      h(
        'div',
        { class: 'form-actions' },
        h(
          'button',
          {
            class: 'btn primary',
            type: 'button',
            onClick: async () => {
              try {
                const response = await fetch('/api/auth/password', {
                  method: 'PATCH',
                  credentials: 'same-origin',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ current_password: currentPassword.value, password: newPassword.value }),
                });
                const payload = await response.json();
                if (!response.ok) throw new Error(payload.error);
                currentPassword.value = '';
                newPassword.value = '';
                toast('Password changed');
              } catch (err) {
                toast(err.message);
              }
            },
          },
          'Change password',
        ),
      ),
    ),
  );
}
