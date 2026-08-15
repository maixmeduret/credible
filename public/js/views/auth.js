/** Sign in / sign up. The first account on a fresh instance is always allowed. */
import { h, logo, replace } from '../dom.js';

export async function renderAuth(ctx) {
  const { state, api } = ctx;
  let mode = state.needsSetup ? 'register' : 'login';

  const shell = h('div', { class: 'auth-shell' });
  const card = h('form', { class: 'card auth-card' });
  shell.appendChild(card);

  const draw = () => {
    const isRegister = mode === 'register';
    const error = h('p', { class: 'error', style: { display: 'none' } });
    const email = h('input', { type: 'email', name: 'email', required: true, autocomplete: 'email', placeholder: 'you@example.com' });
    const password = h('input', {
      type: 'password',
      name: 'password',
      required: true,
      minlength: '8',
      autocomplete: isRegister ? 'new-password' : 'current-password',
      placeholder: '••••••••',
    });
    const name = h('input', { type: 'text', name: 'name', autocomplete: 'name', placeholder: 'Jane Doe' });
    const submit = h('button', { class: 'btn primary', type: 'submit', style: { width: '100%', justifyContent: 'center' } },
      isRegister ? (state.needsSetup ? 'Create the first account' : 'Create my account') : 'Sign in');

    replace(
      card,
      logo(32),
      h('h1', {}, isRegister ? (state.needsSetup ? 'Welcome to Credible' : 'Create your account') : 'Sign in to Credible'),
      h(
        'p',
        { class: 'hint' },
        state.needsSetup
          ? 'This instance has no account yet. The one you create now owns it.'
          : isRegister
            ? 'Free, unlimited sites, no card.'
            : 'Simple, privacy-first web analytics.',
      ),
      error,
      isRegister ? h('div', { class: 'field' }, h('label', { for: 'name' }, 'Name'), name) : null,
      h('div', { class: 'field' }, h('label', {}, 'Email'), email),
      h(
        'div',
        { class: 'field' },
        h('label', {}, 'Password'),
        password,
        isRegister ? h('small', {}, 'At least 8 characters.') : null,
      ),
      submit,
      state.registrationOpen || state.needsSetup
        ? h(
            'p',
            { class: 'auth-switch' },
            isRegister ? 'Already have an account? ' : "Don't have an account? ",
            h(
              'button',
              {
                type: 'button',
                onClick: () => {
                  mode = isRegister ? 'login' : 'register';
                  draw();
                },
              },
              isRegister ? 'Sign in' : 'Sign up',
            ),
          )
        : h('p', { class: 'auth-switch' }, 'Registration is closed on this instance.'),
    );

    card.onsubmit = async (event) => {
      event.preventDefault();
      error.style.display = 'none';
      submit.disabled = true;
      try {
        if (isRegister) await api.register(email.value, password.value, name.value);
        else await api.login(email.value, password.value);
        await ctx.refreshSession();
        ctx.navigate('/');
      } catch (err) {
        error.textContent = err.message;
        error.style.display = 'block';
        submit.disabled = false;
      }
    };
  };

  draw();
  return shell;
}
