import { createClient } from '@supabase/supabase-js';
import { h, setupShell, showError, svg } from './console-shell.mjs';
import {
  CONTENT_FIELDS,
  countByStatus,
  formatDate,
  initials,
  matchesQuery,
  SLUG_PATTERN,
  slugify,
  validateAvatar,
  validateGrant,
  validateNewPassword,
} from '../lib/admin-helpers.mjs';

const BUCKET = 'admin-avatars';
const EMPTY_TEXT = {
  pending: 'No applications are waiting for review.',
  approved: 'No approved affiliates yet.',
  rejected: 'No rejected applications.',
  all: 'No applications yet.',
};
const STATUS = {
  pending: { icon: 'clock', label: 'Pending' },
  approved: { icon: 'check', label: 'Approved' },
  rejected: { icon: 'x', label: 'Rejected' },
};

export function setupAdmin(root, client) {
  const $ = (selector) => root.querySelector(selector);
  const state = { user: null, rows: [], filter: 'pending', query: '', content: {}, avatarUrl: null };

  const setView = (view) => { root.dataset.state = view; };
  const say = (message) => { $('#admin-status').textContent = message; };
  const shell = setupShell(root, {
    onAction(action) {
      if (action === 'signout') signOut();
      if (action === 'password') openDialog('#dlg-password');
      if (action === 'photo') openDialog('#dlg-photo');
    },
  });
  const toast = (message, kind) => { shell.toast(message, kind); say(message); };
  const closeMenu = shell.closeMenu;

  /* ---------- Sign in ---------- */
  const loginForm = $('#admin-login');
  const loginError = $('#login-error');

  loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    showError(loginError, '');
    const email = loginForm.elements.email.value.trim();
    const password = loginForm.elements.password.value;
    if (!email || !password) return showError(loginError, 'Enter your email address and password.');
    const button = loginForm.querySelector('button[type="submit"]');
    button.disabled = true;
    button.textContent = 'Signing in…';
    try {
      const { data, error } = await client.auth.signInWithPassword({ email, password });
      loginForm.elements.password.value = '';
      if (error) return showError(loginError, 'Those details did not work. Check your email and password.');
      await enter(data.user);
    } catch {
      showError(loginError, 'Could not connect. Check your connection and try again.');
    } finally {
      button.disabled = false;
      button.textContent = 'Sign in';
    }
  });

  async function boot() {
    const { data: { user } } = await client.auth.getUser();
    if (!user) return setView('login');
    await enter(user);
  }

  async function enter(user) {
    const { data, error } = await client.rpc('admin_applications');
    if (error) {
      await client.auth.signOut();
      setView('login');
      return showError(loginError, 'This account is not an owner account.');
    }
    state.user = user;
    state.rows = data;
    await Promise.all([loadAvatar(), loadContent()]);
    paintProfile();
    renderApps();
    renderContent();
    shell.route();
    setView('app');
    say('Signed in.');
  }

  async function signOut() {
    const { error } = await client.auth.signOut();
    if (error) return toast('Could not sign out. Please try again.', 'error');
    Object.assign(state, { user: null, rows: [], content: {}, avatarUrl: null });
    closeMenu();
    setView('login');
    loginForm.elements.email.focus();
  }

  /* ---------- Applications ---------- */
  for (const button of root.querySelectorAll('[data-filter]')) {
    button.addEventListener('click', () => { state.filter = button.dataset.filter; renderApps(); });
  }

  let searchTimer;
  $('#app-search').addEventListener('input', (event) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.query = event.target.value; renderApps(); }, 150);
  });

  $('#apps-refresh').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    const { data, error } = await client.rpc('admin_applications');
    button.disabled = false;
    button.removeAttribute('aria-busy');
    if (error) return toast('Could not refresh. Please try again.', 'error');
    state.rows = data;
    renderApps();
    toast('Applications are up to date.');
  });

  function renderApps() {
    const counts = countByStatus(state.rows);
    for (const button of root.querySelectorAll('[data-filter]')) {
      const key = button.dataset.filter;
      button.querySelector('[data-count]').textContent = counts[key];
      button.setAttribute('aria-pressed', String(state.filter === key));
    }
    const badge = $('#tab-badge');
    badge.textContent = counts.pending;
    badge.hidden = counts.pending === 0;

    const list = $('#apps');
    list.replaceChildren();
    const rows = state.rows.filter((row) => (state.filter === 'all' || row.status === state.filter) && matchesQuery(row, state.query));
    const query = state.query.trim();
    $('#apps-summary').textContent = query
      ? `${rows.length} result${rows.length === 1 ? '' : 's'} for “${query}”`
      : `Showing ${rows.length} ${state.filter === 'all' ? 'applications' : state.filter}`;
    if (!rows.length) {
      const text = query ? `No applications match “${query}”.` : EMPTY_TEXT[state.filter];
      list.append(h('div', { class: 'empty' }, svg(query ? 'search' : 'file'), h('p', { text })));
      return;
    }
    for (const row of rows) list.append(appRow(row));
  }

  function appRow(row) {
    const status = STATUS[row.status] ?? STATUS.pending;
    const meta = [row.role, row.location, formatDate(row.created_at)].filter(Boolean).join(' · ');
    const isOrg = row.type === 'organisation';
    const extra = [
      row.contact_name && `Contact: ${row.contact_name}`,
      row.languages && `Languages: ${row.languages}`,
    ].filter(Boolean).join(' · ');
    const main = h('div', {},
      h('h3', { class: 'app__name' }, row.name,
        row.type && h('span', { class: `type-tag type-tag--${isOrg ? 'org' : 'ind'}` }, svg(isOrg ? 'building' : 'user'), isOrg ? 'Organisation' : 'Individual')),
      h('p', { class: 'app__line', text: row.email }),
      meta && h('p', { class: 'app__line', text: meta }),
      extra && h('p', { class: 'app__line', text: extra }),
      row.website && h('p', { class: 'app__line' },
        h('a', { href: row.website, target: '_blank', rel: 'noopener noreferrer nofollow', text: row.website })),
      row.introduction && h('details', { class: 'app__intro' },
        h('summary', { text: 'Read introduction' }),
        h('p', { text: row.introduction })),
      partnerControls(row),
    );
    const side = h('div', { class: 'app__side' },
      h('span', { class: `chip chip--${row.status}` }, svg(status.icon), status.label),
      row.status === 'pending' && h('div', { class: 'app__actions' }, approveButton(row), rejectButton(row)),
    );
    return h('article', { class: 'app-row' }, h('span', { class: 'avatar', 'aria-hidden': 'true', text: initials(row.name) }), main, side);
  }

  async function decide(row, decision, buttons) {
    buttons.forEach((button) => { button.disabled = true; });
    const { error } = await client.rpc('admin_decide_application', { applicant_id: row.user_id, decision });
    if (error) {
      buttons.forEach((button) => { button.disabled = false; });
      return toast('Could not update this application. Refresh the page and try again.', 'error');
    }
    row.status = decision;
    renderApps();
    toast(`${row.name} ${decision === 'approved' ? 'approved' : 'rejected'}.`);
  }

  function approveButton(row) {
    const button = h('button', { type: 'button', class: 'btn btn--gold-compact', text: 'Approve' });
    button.addEventListener('click', () => decide(row, 'approved', [...button.parentElement.children]));
    return button;
  }

  // Asks twice before consequential actions (reject, publish, suspend).
  function twoStep(label, confirmLabel, className, action) {
    const button = h('button', { type: 'button', class: className, text: label });
    let timer;
    const reset = () => { clearTimeout(timer); delete button.dataset.confirm; button.textContent = label; };
    button.addEventListener('click', () => {
      if (button.dataset.confirm) { reset(); return action(button); }
      button.dataset.confirm = 'true';
      button.textContent = confirmLabel;
      timer = setTimeout(reset, 4000);
    });
    button.addEventListener('blur', reset);
    return button;
  }

  // Rejecting cannot be undone from this screen.
  function rejectButton(row) {
    return twoStep('Reject', 'Confirm reject', 'btn btn--danger', (button) => decide(row, 'rejected', [...button.parentElement.children]));
  }

  /* ---------- Partner pages (same template for every partner, content differs) ---------- */
  const PAGE_STATUS = { draft: 'Draft', review: 'In review', preview: 'Preview', live: 'Live', suspended: 'Suspended', retired: 'Retired' };
  const PAGE_NEXT = {
    preview: { to: 'live', label: 'Go live', confirm: 'Confirm go live', done: 'Page is going live. It appears on the site in about 2 minutes.' },
    live: { to: 'suspended', label: 'Suspend page', confirm: 'Confirm suspend', done: 'Page suspended. It is removed from the site in about 2 minutes.' },
    suspended: { to: 'live', label: 'Restore page', confirm: 'Confirm restore', done: 'Page restored. It returns to the site in about 2 minutes.' },
  };

  function partnerControls(row) {
    if (row.status !== 'approved') return null;
    if (!row.partner_slug) {
      return h('div', { class: 'app__page' },
        h('button', { type: 'button', class: 'btn btn--outline-navy', onclick: () => openGrant(row) }, svg('link'), 'Grant partner page'));
    }
    const url = `/partners/${row.partner_slug}/`;
    const next = PAGE_NEXT[row.partner_status];
    return h('div', { class: 'app__page' },
      row.partner_status === 'live'
        ? h('a', { class: 'page-url', href: url, target: '_blank', rel: 'noopener noreferrer' }, svg('globe'), url)
        : h('span', { class: 'page-url' }, svg('globe'), url),
      h('span', { class: `chip chip--page-${row.partner_status}`, text: PAGE_STATUS[row.partner_status] ?? row.partner_status }),
      next && twoStep(next.label, next.confirm, 'btn btn--outline-navy', (button) => setPageStatus(row, next, button)),
    );
  }

  async function setPageStatus(row, next, button) {
    button.disabled = true;
    const { error } = await client.rpc('admin_set_partner_status', { page_slug: row.partner_slug, new_status: next.to });
    if (error) { button.disabled = false; return toast('Could not change this page. Refresh and try again.', 'error'); }
    row.partner_status = next.to;
    renderApps();
    toast(next.done);
  }

  const grantForm = $('#grant-form');
  let granting = null;

  function openGrant(row) {
    granting = row;
    grantForm.reset();
    showError($('#grant-error'), '');
    $('#grant-for').textContent = `For ${row.name} · ${row.email}`;
    grantForm.elements.slug.value = slugify(row.name);
    grantForm.elements.role.value = row.role ?? '';
    grantForm.elements.location.value = row.location ?? '';
    grantForm.elements.bio.value = row.introduction ?? '';
    for (const radio of grantForm.querySelectorAll('input[name="type"]')) radio.checked = radio.value === (row.type ?? 'individual');
    $('#dlg-grant').showModal();
    grantForm.elements.slug.focus();
  }

  grantForm.elements.slug.addEventListener('blur', (event) => {
    if (!SLUG_PATTERN.test(event.target.value)) event.target.value = slugify(event.target.value);
  });

  grantForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!granting) return;
    const f = grantForm.elements;
    const values = {
      slug: f.slug.value.trim().toLowerCase(),
      type: grantForm.querySelector('input[name="type"]:checked')?.value ?? '',
      role: f.role.value.trim(),
      location: f.location.value.trim(),
      bio: f.bio.value.trim(),
      referralCode: f.referralCode.value.trim(),
    };
    const problem = validateGrant(values);
    if (problem) return showError($('#grant-error'), problem);
    const submit = grantForm.querySelector('button[type="submit"]');
    submit.disabled = true;
    const { error } = await client.rpc('admin_grant_partner_page', {
      applicant_id: granting.user_id,
      page_slug: values.slug,
      page_type: values.type,
      page_role: values.role,
      page_location: values.location,
      page_bio: values.bio,
      page_referral_code: values.referralCode,
    });
    submit.disabled = false;
    if (error) {
      return showError($('#grant-error'), error.code === '23505'
        ? 'That page address or account already has a partner page. Choose another address.'
        : 'Could not create the page. Check the details and try again.');
    }
    granting.partner_slug = values.slug;
    granting.partner_status = 'preview';
    $('#dlg-grant').close();
    renderApps();
    toast(`Partner page /partners/${values.slug}/ created as a preview.`);
  });

  /* ---------- Content (CMS) ---------- */
  async function loadContent() {
    const { data } = await client.from('site_content').select('key,value');
    state.content = Object.fromEntries((data ?? []).map((row) => [row.key, row.value]));
  }

  function renderContent() {
    const list = $('#content-list');
    list.replaceChildren();
    for (const field of CONTENT_FIELDS) {
      const saved = () => state.content[field.key] ?? '';
      const area = h('textarea', { id: `cms-${field.key}`, rows: field.rows, maxlength: field.max, placeholder: 'Using the built-in text' });
      area.value = saved();
      const count = h('span', { class: 'cms__count' });
      const save = h('button', { type: 'button', class: 'btn btn--gold-compact', text: 'Publish', disabled: true });
      const live = h('p', { class: 'cms__live' }, svg('check'), 'Live on the site');
      const sync = () => {
        count.textContent = `${area.value.length} / ${field.max}`;
        save.disabled = area.value.trim() === saved();
        live.hidden = !saved();
      };
      area.addEventListener('input', sync);
      save.addEventListener('click', async () => {
        save.disabled = true;
        const value = area.value.trim();
        const { error } = await client.rpc('admin_save_content', { content_key: field.key, content_value: value });
        if (error) { sync(); return toast('Could not publish. Please try again.', 'error'); }
        if (value) state.content[field.key] = value; else delete state.content[field.key];
        area.value = value;
        sync();
        toast(value ? `${field.label} published.` : `${field.label} reset to the built-in text.`);
      });
      sync();
      list.append(h('div', { class: 'cms__item' },
        h('div', {}, h('h2', { text: field.label }), h('p', { class: 'muted', text: field.hint }), live),
        h('div', {}, h('label', { class: 'sr-only', for: area.id, text: field.label }), area, h('div', { class: 'cms__row' }, count, save)),
      ));
    }
  }

  function paintProfile() {
    const email = state.user?.email ?? '';
    $('#profile-name').textContent = email.split('@')[0];
    $('#menu-email').textContent = email;
    for (const el of root.querySelectorAll('[data-avatar]')) {
      el.replaceChildren();
      if (state.avatarUrl) el.append(h('img', { src: state.avatarUrl, alt: '' }));
      else el.textContent = initials(email.split('@')[0].replace(/[._-]+/g, ' '));
    }
    $('#photo-remove').hidden = !state.user?.user_metadata?.avatar_path;
  }

  async function loadAvatar() {
    const path = state.user?.user_metadata?.avatar_path;
    state.avatarUrl = null;
    if (!path) return;
    const { data } = await client.storage.from(BUCKET).createSignedUrl(path, 3600);
    state.avatarUrl = data?.signedUrl ?? null;
  }

  /* ---------- Dialogs ---------- */
  function openDialog(selector) {
    const dialog = $(selector);
    dialog.querySelectorAll('.form-error').forEach((el) => { el.hidden = true; });
    dialog.querySelector('form').reset();
    paintProfile();
    dialog.showModal();
  }
  $('#password-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const problem = validateNewPassword(form.elements.password.value, form.elements.confirm.value);
    if (problem) return showError($('#password-error'), problem);
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    const { error } = await client.auth.updateUser({ password: form.elements.password.value });
    submit.disabled = false;
    if (error) return showError($('#password-error'), 'Could not change your password. Please try again.');
    form.reset();
    $('#dlg-password').close();
    toast('Password updated.');
  });

  const photoInput = $('#photo-file');
  photoInput.addEventListener('change', () => {
    const file = photoInput.files[0];
    const problem = file ? validateAvatar(file) : '';
    showError($('#photo-error'), problem);
    if (file && !problem) {
      const preview = $('#photo-preview');
      preview.replaceChildren(h('img', { src: URL.createObjectURL(file), alt: '' }));
    }
  });

  async function refreshUser() {
    const { data: { user } } = await client.auth.getUser();
    if (user) state.user = user;
    await loadAvatar();
    paintProfile();
  }

  $('#photo-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const file = photoInput.files[0];
    const problem = validateAvatar(file);
    if (problem) return showError($('#photo-error'), problem);
    const submit = event.currentTarget.querySelector('button[type="submit"]');
    submit.disabled = true;
    const path = `${state.user.id}/avatar`;
    const upload = await client.storage.from(BUCKET).upload(path, file, { upsert: true, contentType: file.type });
    const update = upload.error ? upload : await client.auth.updateUser({ data: { avatar_path: path } });
    submit.disabled = false;
    if (update.error) return showError($('#photo-error'), 'Could not save your photo. Please try again.');
    await refreshUser();
    $('#dlg-photo').close();
    toast('Profile photo updated.');
  });

  $('#photo-remove').addEventListener('click', async () => {
    const path = state.user?.user_metadata?.avatar_path;
    if (!path) return;
    await client.storage.from(BUCKET).remove([path]);
    const { error } = await client.auth.updateUser({ data: { avatar_path: null } });
    if (error) return showError($('#photo-error'), 'Could not remove your photo. Please try again.');
    await refreshUser();
    $('#dlg-photo').close();
    toast('Profile photo removed.');
  });

  boot().catch(() => {
    setView('login');
    showError(loginError, 'Could not connect. Check your connection and try again.');
  });
}

if (typeof document !== 'undefined') {
  const root = document.querySelector('[data-admin-dashboard]');
  if (root) {
    const { supabaseUrl, supabaseKey } = root.dataset;
    if (supabaseUrl && supabaseKey) {
      setupAdmin(root, createClient(supabaseUrl, supabaseKey));
    } else {
      root.dataset.state = 'login';
      root.querySelector('#login-error').textContent = 'The console is not configured.';
      root.querySelector('#login-error').hidden = false;
      root.querySelector('#admin-login button[type="submit"]').disabled = true;
    }
  }
}
