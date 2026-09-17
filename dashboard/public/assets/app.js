'use strict';
/* ==========================================================================
   Astra AI , Console (product dashboard) SPA.
   Vanilla JS. Zero dependencies. Hash routing. Talks only to our own /api/*
   so provider keys stay server side. No em dashes anywhere. Use commas or periods.
   ========================================================================== */

/* ---------- tiny DOM helpers ---------- */
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
const el = (tag, attrs, kids) => {
  const n = document.createElement(tag);
  if (attrs) for (const k in attrs) {
    if (k === 'class') n.className = attrs[k];
    else if (k === 'html') n.innerHTML = attrs[k];
    else if (k.slice(0, 2) === 'on' && typeof attrs[k] === 'function') n.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
    else if (attrs[k] != null && attrs[k] !== false) n.setAttribute(k, attrs[k]);
  }
  if (kids != null) (Array.isArray(kids) ? kids : [kids]).forEach((c) => {
    if (c == null || c === false) return;
    n.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  });
  return n;
};

/* XSS guard. Always escape any user supplied string before it touches innerHTML.
   Most rendering uses el()+textContent which is safe by construction. esc() is the
   belt-and-suspenders for the rare html: paths. */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* ---------- app state ---------- */
const State = {
  me: null,            // { user, tenant }
  health: null,        // { ok, providers, model }
  agents: [],
  providers: null,
  usage: null,
  telephony: null,
  phoneNumbers: null,
  availableNumbers: null,
  wallet: null,
  presets: [],
  agentTypes: [],
  tickets: [],
  demoLinks: [],
  activeAgentId: null, // for Talk-to-it
  createDraft: null,   // { step, agentType, presetId } for deploy wizard
  loaded: { agents: false, providers: false, usage: false, telephony: false, phoneNumbers: false, wallet: false, presets: false, agentTypes: false, tickets: false, demoLinks: false }
};

const VOICE_MODELS = ['mulberry', 'muga'];
const SPEAKERS = ['speaker_1', 'speaker_2', 'speaker_3', 'speaker_4'];
const MUGA_TONES = ['neutral', 'happy', 'sad', 'excited', 'angry', 'whisper'];
/* Rs per 1000 chars. Mulberry promo about Rs 0.50 / 1000. Muga slightly higher. */
const RATE = { mulberry: 0.50, muga: 0.99 };

/* ===========================================================================
   FETCH WRAPPER
   credentials:include so the rxv_sess cookie rides along. JSON in, JSON out.
   A 401 on any authed call bounces to the login card.
   =========================================================================== */
async function api(path, opts) {
  opts = opts || {};
  const init = { method: opts.method || 'GET', credentials: 'include', headers: {} };
  const controller = new AbortController();
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 35000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  init.signal = controller.signal;
  if (opts.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch (e) {
    clearTimeout(timeout);
    if (e && e.name === 'AbortError') throw new ApiError(408, 'The agent took too long to respond. Please try again.');
    throw new ApiError(0, 'Network error. Is the server running.');
  }
  clearTimeout(timeout);
  if (res.status === 401 && !opts.allow401) {
    State.me = null;
    if (!path.endsWith('/api/me')) renderAuth();
    throw new ApiError(401, 'Please sign in.');
  }
  const ct = res.headers.get('content-type') || '';
  if (ct.indexOf('application/json') !== -1) {
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, data.error || data.message || ('Request failed (' + res.status + ').'), data);
    return data;
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new ApiError(res.status, txt || ('Request failed (' + res.status + ').'));
  }
  return res; // raw (e.g. audio/wav)
}
function ApiError(status, message, data) { this.status = status; this.message = message; this.data = data || {}; }
ApiError.prototype = Object.create(Error.prototype);

/* ===========================================================================
   TOASTS
   =========================================================================== */
function toast(message, kind, title) {
  kind = kind || 'info';
  const host = $('#toasts');
  const t = el('div', { class: 'toast ' + kind }, [
    el('span', { class: 'ti' }),
    el('div', {}, [title ? el('b', {}, title) : null, el('div', {}, message)])
  ]);
  host.appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 320); }, kind === 'err' ? 5200 : 3400);
}

/* ===========================================================================
   MODAL
   =========================================================================== */
function modal(opts) {
  // opts: { title, body(node), confirmText, confirmKind, onConfirm, cancelText }
  const host = $('#modal-host');
  const close = () => { host.classList.add('hide'); host.setAttribute('aria-hidden', 'true'); host.innerHTML = ''; };
  const confirmBtn = el('button', { class: 'btn ' + (opts.confirmKind === 'danger' ? 'btn-primary' : 'btn-primary') }, opts.confirmText || 'Confirm');
  if (opts.confirmKind === 'danger') confirmBtn.style.background = 'linear-gradient(100deg,#fb7185,#e11d48)';
  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    try { await opts.onConfirm(); close(); }
    catch (e) { confirmBtn.disabled = false; toast(e.message || 'Action failed.', 'err'); }
  });
  const card = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' }, [
    el('h3', {}, opts.title || ''),
    opts.body || null,
    el('div', { class: 'modal-actions' }, [
      el('button', { class: 'btn btn-ghost', onclick: close }, opts.cancelText || 'Cancel'),
      confirmBtn
    ])
  ]);
  host.innerHTML = '';
  host.appendChild(el('div', { onclick: (e) => { if (e.target === e.currentTarget) close(); }, style: 'position:absolute;inset:0' }));
  host.appendChild(card);
  host.classList.remove('hide');
  host.setAttribute('aria-hidden', 'false');
  return close;
}

/* ===========================================================================
   SMALL UTILITIES
   =========================================================================== */
function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]).join('').toUpperCase() || '?';
}
function brandMark(size) {
  // Official ribbon-A mark from logo-mark.png (no invented SVG glyph).
  const img = document.createElement('img');
  img.src = '/assets/logo-mark.png';
  img.alt = '';
  img.width = size || 30;
  img.height = size || 30;
  img.className = 'lm';
  img.decoding = 'async';
  return img;
}
function fmtInr(n) {
  const v = Number(n || 0);
  return v.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}
function skeleton(kind, n) {
  const frag = document.createDocumentFragment();
  for (let i = 0; i < (n || 1); i++) frag.appendChild(el('div', { class: 'sk ' + (kind || 'sk-card') }));
  return frag;
}

/* ===========================================================================
   BOOT
   =========================================================================== */
async function boot() {
  try {
    const me = await api('/api/me', { allow401: true });
    State.me = me;
    renderShell();
  } catch (e) {
    if (e.status === 401) renderAuth();
    else { renderAuth(); }
  }
}

/* ===========================================================================
   AUTH GATE
   =========================================================================== */
function renderAuth() {
  let mode = 'login'; // or 'signup'
  const root = $('#app');
  root.removeAttribute('aria-busy');

  function draw() {
    const errBox = el('div', { class: 'auth-err', id: 'authErr' });
    const fields = [];
    if (mode === 'signup') {
      fields.push(field('Your name', el('input', { class: 'input', id: 'f_name', type: 'text', placeholder: 'Shreyas Raj', autocomplete: 'name' })));
      fields.push(field('Company', el('input', { class: 'input', id: 'f_company', type: 'text', placeholder: 'Acme Co', autocomplete: 'organization' })));
    }
    fields.push(field('Email', el('input', { class: 'input', id: 'f_email', type: 'email', placeholder: 'you@company.com', autocomplete: 'email' })));
    fields.push(field('Password', el('input', { class: 'input', id: 'f_pass', type: 'password', placeholder: '••••••••', autocomplete: mode === 'signup' ? 'new-password' : 'current-password' })));

    const submit = el('button', { class: 'btn btn-primary btn-lg', type: 'submit' }, mode === 'login' ? 'Sign in' : 'Create account');

    const form = el('form', { class: 'auth-form', onsubmit: onSubmit }, fields.concat([errBox, submit]));

    const card = el('div', { class: 'auth-card' }, [
      el('div', { class: 'auth-brand' }, [
        brandMark(36),
        el('span', { class: 'nm' }, [document.createTextNode('astra '), el('em', {}, 'AI')])
      ]),
      el('h1', {}, mode === 'login' ? 'Welcome back' : 'Start building'),
      el('p', { class: 'sub' }, mode === 'login' ? 'Sign in to your voice agent console.' : 'Spin up a tenant and ship AI voice agents from ₹1/min for the AI layer. Telephony is separate.'),
      form,
      el('div', { class: 'auth-toggle' }, [
        document.createTextNode(mode === 'login' ? 'New to Astra AI. ' : 'Already have an account. '),
        el('button', { type: 'button', onclick: () => { mode = mode === 'login' ? 'signup' : 'login'; draw(); } }, mode === 'login' ? 'Create one' : 'Sign in')
      ]),
      mode === 'login' ? el('div', { class: 'auth-demo' }, 'Use your workspace email and password. Test accounts are provisioned securely by the platform admin.') : null
    ]);

    root.innerHTML = '';
    root.appendChild(el('div', { class: 'auth-wrap' }, card));
    const first = $('#' + (mode === 'signup' ? 'f_name' : 'f_email'));
    if (first) first.focus();
  }

  function field(label, input) {
    return el('div', { class: 'field' }, [el('label', {}, label), input]);
  }

  async function onSubmit(e) {
    e.preventDefault();
    const err = $('#authErr');
    err.classList.remove('show');
    const email = ($('#f_email').value || '').trim();
    const password = $('#f_pass').value || '';
    if (!email || !password) { showErr('Email and password are required.'); return; }
    if (mode === 'signup' && password.length < 12) { showErr('Use at least 12 characters for your password.'); return; }
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true; btn.textContent = mode === 'login' ? 'Signing in...' : 'Creating...';
    try {
      let body, route;
      if (mode === 'signup') {
        body = { email: email, password: password, name: ($('#f_name').value || '').trim(), company: ($('#f_company').value || '').trim() };
        route = '/api/auth/signup';
      } else {
        body = { email: email, password: password };
        route = '/api/auth/login';
      }
      const res = await api(route, { method: 'POST', body: body, allow401: true });
      State.me = { user: res.user, tenant: res.tenant };
      resetData();
      toast(mode === 'login' ? 'Signed in.' : 'Account created.', 'ok');
      renderShell();
    } catch (ex) {
      btn.disabled = false; btn.textContent = mode === 'login' ? 'Sign in' : 'Create account';
      if (ex.status === 409) showErr('That email is already registered. Try signing in.');
      else if (ex.status === 401) showErr('Wrong email or password.');
      else showErr(ex.message || 'Something went wrong.');
    }
  }
  function showErr(m) { const err = $('#authErr'); err.textContent = m; err.classList.add('show'); }

  draw();
}
function resetData() {
  State.agents = []; State.providers = null; State.usage = null; State.telephony = null;
  State.phoneNumbers = null; State.availableNumbers = null;
  State.wallet = null; State.presets = []; State.agentTypes = []; State.tickets = [];
  State.demoLinks = [];
  State.workflows = null; State.workflowTemplates = null;
  State.employees = null; State.employeeTemplates = null;
  State.createDraft = null;
  State.loaded = { agents: false, providers: false, usage: false, telephony: false, phoneNumbers: false, calls: false, wallet: false, presets: false, agentTypes: false, tickets: false, demoLinks: false, workflows: false, workflowTemplates: false, employees: false, employeeTemplates: false };
  State.activeAgentId = null;
}

/* ===========================================================================
   CONSOLE SHELL
   =========================================================================== */
const ROUTES = [
  { id: 'overview', label: 'Home', icon: 'grid', group: 'HOME' },
  { id: 'employees', label: 'My Employees', icon: 'users', group: 'JOURNEY' },
  { id: 'leads', label: 'Instant Leads', icon: 'leads', group: 'JOURNEY' },
  { id: 'campaigns', label: 'Campaigns', icon: 'megaphone', group: 'JOURNEY' },
  { id: 'calls', label: 'Conversations', icon: 'calls', group: 'JOURNEY' },
  { id: 'training', label: 'Training', icon: 'book', group: 'JOURNEY' },
  { id: 'numbers', label: 'Phone Numbers', icon: 'phone', group: 'JOURNEY' },
  { id: 'analytics', label: 'Performance', icon: 'chart', group: 'JOURNEY' },
  { id: 'billing', label: 'Billing', icon: 'wallet', group: 'ACCOUNT' },
  { id: 'support', label: 'Support', icon: 'support', group: 'ACCOUNT' },
  { id: 'settings', label: 'Account', icon: 'gear', group: 'ACCOUNT' },
  { id: 'admin', label: 'Admin', icon: 'shield', adminOnly: true, group: 'ACCOUNT' },
  // Provider-era modules demoted. Super Admin keeps diagnostics.
  { id: 'agents', label: 'Agents', icon: 'users', group: 'ADVANCED', advanced: true },
  { id: 'workflows', label: 'Workflows', icon: 'flow', group: 'ADVANCED', advanced: true },
  { id: 'presets', label: 'Presets', icon: 'template', group: 'ADVANCED', advanced: true },
  { id: 'studio', label: 'Voice Studio', icon: 'wave', group: 'ADVANCED', advanced: true },
  { id: 'demos', label: 'Demo links', icon: 'link', ownerOnly: true, group: 'ADVANCED', advanced: true },
  { id: 'talk', label: 'Talk to it', icon: 'mic', group: 'ADVANCED', advanced: true },
  { id: 'knowledge', label: 'Knowledge', icon: 'book', group: 'ADVANCED', advanced: true },
  { id: 'integrations', label: 'Integrations', icon: 'plug', group: 'ADVANCED', advanced: true },
];

function navIcon(name) {
  const paths = {
    grid: '<rect x="3" y="3" width="7" height="7" rx="1.4"/><rect x="14" y="3" width="7" height="7" rx="1.4"/><rect x="3" y="14" width="7" height="7" rx="1.4"/><rect x="14" y="14" width="7" height="7" rx="1.4"/>',
    users: '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 20a5.5 5.5 0 0 1 11 0"/><path d="M16 6.2a3 3 0 0 1 0 5.6"/><path d="M17 14.5a5.5 5.5 0 0 1 3.5 5.5"/>',
    wave: '<path d="M2 12h2l2-6 3 14 3-18 3 14 2-6h2"/>',
    mic: '<rect x="9" y="2.5" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0"/><path d="M12 17.5V21"/><path d="M8.5 21h7"/>',
    phone: '<path d="M5 3.5h3l1.5 4.5-2 1.5a12 12 0 0 0 5.5 5.5l1.5-2 4.5 1.5v3a1.5 1.5 0 0 1-1.6 1.5A16.5 16.5 0 0 1 3.5 5.1 1.5 1.5 0 0 1 5 3.5z"/>',
    calls: '<path d="M4 5h10v10H4z"/><path d="M8 15v4l4-2 4 2v-4"/><path d="M10 8h2M10 11h4"/>',
    leads: '<path d="M12 3v4"/><path d="M8 7h8"/><circle cx="12" cy="14" r="6"/><path d="M10 14h4M12 12v4"/>',
    book: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21.5z"/><path d="M4 5.5V21.5"/><path d="M8 7h8M8 11h6"/>',
    plug: '<path d="M9 3v5M15 3v5M7 8h10v3a5 5 0 0 1-10 0V8z"/><path d="M12 16v5"/>',
    megaphone: '<path d="M4 10v4l8 3V7L4 10z"/><path d="M12 8.5c2 .8 4 2 6 2.5v2c-2 .5-4 1.7-6 2.5"/><path d="M7 14.5v3.2l2 .8"/>',
    chart: '<path d="M4 19h16"/><path d="M7 16V9"/><path d="M12 16V5"/><path d="M17 16v-6"/>',
    gear: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v2.6M12 18.9v2.6M21.5 12h-2.6M5.1 12H2.5M18.5 5.5l-1.8 1.8M7.3 16.7l-1.8 1.8M18.5 18.5l-1.8-1.8M7.3 7.3 5.5 5.5"/>',
    template: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M8 8h8M8 12h8M8 16h5"/>',
    flow: '<circle cx="6" cy="6" r="2.2"/><circle cx="18" cy="6" r="2.2"/><circle cx="12" cy="18" r="2.2"/><path d="M8 6h8M7.2 7.8 10.8 16M16.8 7.8 13.2 16"/>',
    wallet: '<path d="M4 6.5h14a2 2 0 0 1 2 2v9H4a2 2 0 0 1-2-2v-11a2 2 0 0 0 2 2z"/><path d="M15 11h7v4h-7a2 2 0 0 1 0-4z"/>',
    support: '<path d="M4 13a8 8 0 0 1 16 0v5a2 2 0 0 1-2 2h-3"/><path d="M4 13v4H2v-4h2M20 13v4h2v-4h-2"/>',
    shield: '<path d="M12 3 20 6v6c0 5-3.4 8-8 9-4.6-1-8-4-8-9V6l8-3z"/><path d="m9 12 2 2 4-5"/>',
    link: '<path d="M10.5 13.5a4 4 0 0 0 5.7 0l2.3-2.3a4 4 0 0 0-5.7-5.7l-1.3 1.3"/><path d="M13.5 10.5a4 4 0 0 0-5.7 0l-2.3 2.3a4 4 0 0 0 5.7 5.7l1.3-1.3"/>',
    logout: '<path d="M14 3.5H6.5A1.5 1.5 0 0 0 5 5v14a1.5 1.5 0 0 0 1.5 1.5H14"/><path d="M17 8l4 4-4 4"/><path d="M21 12H9"/>'
  };
  return '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + (paths[name] || paths.grid) + '</svg>';
}

function renderShell() {
  const root = $('#app');
  root.removeAttribute('aria-busy');
  const t = State.me.tenant, u = State.me.user;

  const visibleRoutes = ROUTES.filter((r) => {
    if (r.adminOnly && !['super_admin', 'admin'].includes(u.role)) return false;
    if (r.ownerOnly && !['super_admin', 'admin', 'owner'].includes(u.role)) return false;
    if (r.advanced && u.role !== 'super_admin') return false;
    return true;
  });
  const groupOrder = ['HOME', 'JOURNEY', 'ACCOUNT', 'ADVANCED'];
  const groupLabels = { HOME: null, JOURNEY: 'JOURNEY', ACCOUNT: 'ACCOUNT', ADVANCED: 'DIAGNOSTICS' };
  const navChildren = [];
  groupOrder.forEach((group) => {
    const items = visibleRoutes.filter((r) => (r.group || 'HOME') === group);
    if (!items.length) return;
    const label = groupLabels[group];
    if (label) navChildren.push(el('div', { class: 'nav-group' }, label));
    items.forEach((r) => {
      const label = (r.id === 'admin' && u.role === 'super_admin') ? 'Diagnostics' : r.label;
      navChildren.push(el('a', { href: '#/' + r.id, 'data-route': r.id, html: navIcon(r.icon) + '<span>' + esc(label) + '</span>' }));
    });
  });
  const nav = el('nav', { class: 'nav' }, navChildren);

  const side = el('aside', { class: 'side' }, [
    el('div', { class: 'side-brand' }, [
      brandMark(28),
      el('span', { class: 'nm' }, [document.createTextNode('astra '), el('em', {}, 'AI')])
    ]),
    nav,
    el('div', { class: 'side-foot' }, [
      el('div', { class: 'tenant-chip' }, [
        el('div', { class: 'av' }, initials(t.name)),
        el('div', { class: 'meta' }, [
          el('div', { class: 'tn', title: t.name }, t.name),
          el('div', { class: 'tp' }, (t.plan || 'studio') + ' plan')
        ])
      ]),
      el('button', { class: 'side-logout', onclick: doLogout, html: navIcon('logout') + '<span>Sign out</span>' })
    ])
  ]);

  const top = el('header', { class: 'top' }, [
    el('div', { class: 'flex items-center gap-2', style: 'min-width:0' }, [
      el('button', { class: 'menu-btn', 'aria-label': 'Menu', onclick: () => $('.shell').classList.toggle('nav-open'), html: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>' }),
      el('div', { class: 'top-route' }, [
        el('span', { class: 'crumb' }, 'Astra AI'),
        el('span', { class: 'ttl', id: 'routeTitle' }, 'Overview')
      ])
    ]),
    el('div', { class: 'health-row', id: 'healthRow' }, healthChips())
  ]);

  const impersonationBanner = State.me.impersonation ? el('div', { class: 'impersonation-banner' }, [
    el('div', {}, [el('b', {}, 'Viewing as ' + u.email), el('span', {}, 'Read-only safety mode. Reason: ' + (State.me.impersonation.reason || 'Support review'))]),
    el('button', { class: 'btn btn-dark', onclick: exitImpersonation }, 'Exit user view')
  ]) : null;

  const shell = el('div', { class: 'shell' + (impersonationBanner ? ' is-impersonating' : '') }, [
    side, top, impersonationBanner,
    el('main', { class: 'main', id: 'view' }),
    el('div', { class: 'nav-scrim', onclick: () => $('.shell').classList.remove('nav-open') })
  ]);

  root.innerHTML = '';
  root.appendChild(shell);

  window.removeEventListener('hashchange', onRoute);
  window.addEventListener('hashchange', onRoute);
  loadHealth();
  onRoute();
}

async function exitImpersonation() {
  await api('/api/auth/impersonation/exit', { method: 'POST', body: {} });
  State.me = await api('/api/me');
  renderShell();
  toast('Returned to super admin.', 'ok');
}

async function doLogout() {
  try { await api('/api/auth/logout', { method: 'POST', allow401: true }); } catch (e) {}
  State.me = null; resetData();
  toast('Signed out.', 'info');
  renderAuth();
}

/* ---- health chips ---- */
function healthChips() {
  const layers = [
    { key: 'tts', label: 'TTS' },
    { key: 'llm', label: 'Brain' },
    { key: 'telephony', label: 'Telephony' }
  ];
  return layers.map((L) => {
    const chip = el('span', { class: 'hchip loading', 'data-layer': L.key }, [
      el('span', { class: 'dot' }),
      el('span', { class: 'lbl-txt' }, L.label)
    ]);
    return chip;
  });
}
async function loadHealth() {
  try {
    const h = await api('/api/health', { allow401: true });
    State.health = h;
    paintHealth();
  } catch (e) {
    $$('#healthRow .hchip').forEach((c) => { c.className = 'hchip bad'; });
  }
}
function paintHealth() {
  const h = State.health; if (!h) return;
  const map = {
    tts: h.providers && h.providers.tts ? Object.values(h.providers.tts).some(Boolean) : false,
    llm: h.providers && h.providers.llm ? Object.values(h.providers.llm).some(Boolean) : false,
    telephony: h.providers && h.providers.telephony ? Object.values(h.providers.telephony).some(Boolean) : false
  };
  $$('#healthRow .hchip').forEach((c) => {
    const layer = c.getAttribute('data-layer');
    c.classList.remove('loading');
    c.className = 'hchip ' + (map[layer] ? 'ok' : 'bad');
    c.setAttribute('data-layer', layer);
  });
}

/* ===========================================================================
   ROUTER
   =========================================================================== */
function currentRoute() {
  const hash = (location.hash || '').replace(/^#\/?/, '').split('?')[0];
  const found = ROUTES.find((r) => r.id === hash &&
    (!r.adminOnly || (State.me && ['super_admin', 'admin'].includes(State.me.user.role))) &&
    (!r.ownerOnly || (State.me && ['super_admin', 'admin', 'owner'].includes(State.me.user.role))));
  return found ? found.id : 'overview';
}
function onRoute() {
  if (!State.me) return;
  const id = currentRoute();
  $$('.nav a').forEach((a) => a.classList.toggle('active', a.getAttribute('data-route') === id));
  const r = ROUTES.find((x) => x.id === id);
  const tt = $('#routeTitle'); if (tt) tt.textContent = r ? r.label : 'Home';
  $('.shell') && $('.shell').classList.remove('nav-open');
  const view = $('#view');
  view.innerHTML = '';
  const wrap = el('div', { class: 'view' });
  view.appendChild(wrap);
  ({
    overview: viewOverview, employees: viewEmployees, agents: viewAgents, workflows: viewWorkflows, presets: viewPresets, studio: viewStudio, demos: viewDemoLinks,
    talk: viewTalk, numbers: viewPhoneNumbers, telephony: viewPhoneNumbers, calls: viewCalls, leads: viewInstantLeads,
    knowledge: viewKnowledge, integrations: viewIntegrations, campaigns: viewCampaigns, analytics: viewAnalytics,
    training: viewTrainingHub, billing: viewBilling,
    support: viewSupport, admin: viewAdmin, settings: viewSettings
  }[id] || viewOverview)(wrap);
}
function goto(id) { location.hash = '#/' + id; }

/* ---- shared view header ---- */
function viewHead(title, sub, extraClass) {
  return el('div', { class: 'view-head' + (extraClass ? ' ' + extraClass : '') }, [el('h2', {}, title), sub ? el('p', {}, sub) : null]);
}

/* ===========================================================================
   1. OVERVIEW
   =========================================================================== */
async function viewOverview(root) {
  const name = State.me.user.name || State.me.user.email;
  root.appendChild(viewHead(
    'Welcome back, ' + name + '.',
    'Create an AI Employee, teach, assign a Phone Number, connect leads, and go live.',
    'overview-hero'
  ));

  const statsRow = el('div', { class: 'grid grid-3' }, skeleton('sk-stat', 3));
  root.appendChild(statsRow);

  const body = el('div', { class: 'grid grid-12', style: 'margin-top:14px' }, [
    el('div', { class: 'card spark-card', id: 'sparkHost' }, skeleton('sk-card', 1)),
    el('div', { class: 'card qa-card', id: 'qaHost' }, [
      el('h3', {}, 'Quick actions'),
      el('div', { class: 'qa-row' }, [
        el('button', { class: 'btn btn-primary', onclick: () => goto('employees') }, 'My Employees'),
        el('button', { class: 'btn btn-ghost', onclick: () => goto('leads') }, 'Instant Leads'),
        el('button', { class: 'btn btn-ghost', onclick: () => goto('campaigns') }, 'Campaigns'),
        el('button', { class: 'btn btn-ghost', onclick: () => goto('numbers') }, 'Phone Numbers'),
        el('button', { class: 'btn btn-ghost', onclick: () => goto('calls') }, 'Conversations'),
        el('button', { class: 'btn btn-ghost', onclick: () => goto('analytics') }, 'Performance')
      ]),
      el('div', { class: 'qa-foot', id: 'provMini' }, 'Checking providers...')
    ])
  ]);
  root.appendChild(body);

  // load usage + agents in parallel
  try {
    const [usage, agentsRes] = await Promise.all([
      api('/api/usage'),
      State.loaded.agents ? Promise.resolve({ agents: State.agents }) : api('/api/agents')
    ]);
    State.usage = usage;
    State.agents = agentsRes.agents || [];
    State.loaded.agents = true;

    const totals = usage.totals || {};
    statsRow.innerHTML = '';
    statsRow.appendChild(statCard('Agents', String(State.agents.length), 'Live in this tenant'));
    statsRow.appendChild(statCard('Characters synthesized', fmtInr(totals.chars || 0), 'Across all days'));
    statsRow.appendChild(statCard('Estimated spend', '₹' + fmtInr(totals.costInr || estimateCost(usage)), 'At promo rates', true));

    const sh = $('#sparkHost'); sh.innerHTML = '';
    sh.appendChild(sparkPanel(usage.days || []));
  } catch (e) {
    statsRow.innerHTML = '';
    statsRow.appendChild(el('div', { class: 'card card-pad muted' }, 'Could not load usage. ' + esc(e.message)));
  }

  // provider mini summary (customer-facing labels only)
  ensureProviders().then(() => {
    const pm = $('#provMini'); if (!pm) return;
    const reg = State.providers || {};
    const live = [];
    const friendly = {
      rumik: 'Rumik Silk',
      groq: 'Groq',
      gemini: 'Gemini',
      deepgram: 'Deepgram',
      vobiz: 'Telephony'
    };
    ['tts', 'llm', 'telephony'].forEach((layer) => {
      (reg[layer] || []).forEach((p) => {
        if (!p.live) return;
        live.push(friendly[p.id] || String(p.label || p.id).replace(/\s*via\s*Dograh/i, '').replace(/VoBiz/i, 'Telephony'));
      });
    });
    pm.textContent = live.length ? ('Active stack: ' + live.join(', ') + '.') : 'No live providers detected.';
  }).catch(() => {});
}

function statCard(lbl, val, delta, up) {
  return el('div', { class: 'card stat' }, [
    el('div', { class: 'lbl' }, lbl),
    el('div', { class: 'val' }, val),
    el('div', { class: 'delta' + (up ? ' up' : '') }, delta)
  ]);
}
function estimateCost(usage) {
  // fallback if backend does not return costInr in totals
  let c = 0;
  (usage.days || []).forEach((d) => { c += (d.costInr || (d.chars || 0) / 1000 * RATE.mulberry); });
  return Math.round(c * 100) / 100;
}

/* ---- sparkline (inline SVG, no libs) ---- */
function sparkPanel(days) {
  const data = (days || []).map((d) => ({ day: d.day, v: d.chars || 0 }));
  const total = data.reduce((s, d) => s + d.v, 0);
  const hasData = data.some((d) => d.v > 0);
  const head = el('div', { class: 'hd' }, [
    el('div', { class: 't' }, 'Usage, characters per day'),
    el('div', { class: 'v' }, hasData ? (fmtInr(total) + ' total') : 'No data yet')
  ]);
  if (!hasData) {
    return el('div', {}, [
      head,
      el('div', { class: 'spark-empty' }, [
        el('div', { class: 'se-title' }, 'No usage yet'),
        el('div', { class: 'se-sub' }, 'Synthesize in Voice Studio or talk to an agent to see characters per day here.')
      ])
    ]);
  }
  const svg = buildSpark(data);
  const xlabels = el('div', { class: 'spark-x' }, [
    el('span', {}, data.length ? shortDay(data[0].day) : ''),
    el('span', {}, data.length ? shortDay(data[data.length - 1].day) : '')
  ]);
  return el('div', {}, [head, svg, xlabels]);
}
function shortDay(iso) {
  if (!iso) return '';
  const p = iso.split('-'); return p.length === 3 ? (p[2] + '/' + p[1]) : iso;
}
function buildSpark(data) {
  const W = 600, H = 120, pad = 6;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'spark-svg');
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.innerHTML =
    '<defs>' +
    '<linearGradient id="sparkline" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#6B21A8"/><stop offset="0.55" stop-color="#7C3AED"/><stop offset="1" stop-color="#06B6D4"/></linearGradient>' +
    '<linearGradient id="sparkfill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#06B6D4" stop-opacity="0.32"/><stop offset="1" stop-color="#6B21A8" stop-opacity="0"/></linearGradient>' +
    '</defs>';
  if (!data.length) {
    const txt = document.createElementNS(ns, 'text');
    txt.setAttribute('x', W / 2); txt.setAttribute('y', H / 2 + 4); txt.setAttribute('text-anchor', 'middle');
    txt.setAttribute('fill', '#71717A'); txt.setAttribute('font-size', '13');
    txt.setAttribute('font-family', 'Avenir Next, Segoe UI, sans-serif');
    txt.textContent = 'No usage yet';
    svg.appendChild(txt);
    return svg;
  }
  const max = Math.max(1, ...data.map((d) => d.v));
  const n = data.length;
  const x = (i) => pad + (n === 1 ? (W - 2 * pad) / 2 : (i / (n - 1)) * (W - 2 * pad));
  const y = (v) => H - pad - (v / max) * (H - 2 * pad);
  let line = '';
  data.forEach((d, i) => { line += (i === 0 ? 'M' : 'L') + x(i).toFixed(1) + ' ' + y(d.v).toFixed(1) + ' '; });
  const area = 'M' + x(0).toFixed(1) + ' ' + (H - pad) + ' ' + line.replace(/^M/, 'L') + 'L' + x(n - 1).toFixed(1) + ' ' + (H - pad) + ' Z';
  const areaP = document.createElementNS(ns, 'path'); areaP.setAttribute('class', 'area'); areaP.setAttribute('d', area);
  const lineP = document.createElementNS(ns, 'path'); lineP.setAttribute('class', 'ln'); lineP.setAttribute('d', line.trim());
  svg.appendChild(areaP); svg.appendChild(lineP);
  // last point dot
  const c = document.createElementNS(ns, 'circle');
  c.setAttribute('cx', x(n - 1)); c.setAttribute('cy', y(data[n - 1].v)); c.setAttribute('r', 3.2);
  c.setAttribute('fill', '#6B21A8'); c.setAttribute('stroke', '#fff'); c.setAttribute('stroke-width', '1');
  svg.appendChild(c);
  return svg;
}

/* ===========================================================================
   PROVIDERS + AGENTS data loaders
   =========================================================================== */
async function ensureProviders() {
  if (State.loaded.providers) return State.providers;
  const res = await api('/api/providers');
  // res can be { tts:[...], llm:[...], telephony:[...] } or { providers:{...} }
  State.providers = res.providers || res;
  State.loaded.providers = true;
  return State.providers;
}
async function ensureAgents(force) {
  if (State.loaded.agents && !force) return State.agents;
  const res = await api('/api/agents');
  State.agents = res.agents || [];
  State.loaded.agents = true;
  return State.agents;
}
async function ensurePresets(force) {
  if (State.loaded.presets && !force) return State.presets;
  const res = await api('/api/presets');
  State.presets = res.presets || [];
  State.loaded.presets = true;
  return State.presets;
}
async function ensureAgentTypes(force) {
  if (State.loaded.agentTypes && !force) return State.agentTypes;
  const res = await api('/api/agent-types');
  State.agentTypes = res.agentTypes || [];
  State.loaded.agentTypes = true;
  return State.agentTypes;
}
function agentTypeMeta(id) {
  return (State.agentTypes || []).find((t) => t.id === id) || null;
}
function directionLabel(dir) {
  if (dir === 'inbound') return 'Inbound';
  if (dir === 'outbound') return 'Outbound';
  return 'Inbound & outbound';
}
function startDeployWizard(seed) {
  State.createDraft = {
    step: seed && seed.presetId ? 3 : (seed && seed.agentType ? 2 : 1),
    agentType: (seed && seed.agentType) || '',
    presetId: (seed && seed.presetId) || null,
  };
  goto('agents');
}
async function ensureTelephony(force) {
  if (State.loaded.telephony && !force) return State.telephony;
  const res = await api('/api/telephony/status');
  State.telephony = res;
  State.loaded.telephony = true;
  return State.telephony;
}

/* ===========================================================================
   MY EMPLOYEES (Phases 1 to 4)
   =========================================================================== */
async function ensureEmployees(force) {
  if (State.loaded.employees && !force) return State.employees || [];
  const res = await api('/api/employees');
  State.employees = res.employees || [];
  State.loaded.employees = true;
  return State.employees;
}

async function ensureEmployeeTemplates(force) {
  if (State.loaded.employeeTemplates && !force) return State.employeeTemplates || [];
  const res = await api('/api/employees/templates');
  State.employeeTemplates = res.templates || [];
  State.loaded.employeeTemplates = true;
  return State.employeeTemplates;
}

function employeeFilterFromHash() {
  const params = new URLSearchParams((location.hash.split('?')[1] || ''));
  return String(params.get('filter') || 'all').toLowerCase();
}

function employeeIdFromHash() {
  const params = new URLSearchParams((location.hash.split('?')[1] || ''));
  return params.get('id') || '';
}

function employeeCreateMode() {
  const params = new URLSearchParams((location.hash.split('?')[1] || ''));
  return params.get('create') === '1';
}

function channelLabel(ch) {
  const map = {
    inbound: 'Inbound',
    instant_lead: 'Instant Lead',
    campaign: 'Campaign',
    outbound: 'Outbound',
    both: 'Multi-channel',
  };
  return map[ch] || ch || '-';
}

function fmtMetric(n) {
  if (n == null || n === '') return '0';
  return String(n);
}

function fmtLastActive(iso) {
  if (!iso) return '-';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '-';
    return d.toLocaleString();
  } catch (_) { return '-'; }
}

async function viewEmployees(root) {
  const id = employeeIdFromHash();
  if (id) return viewEmployeeStudio(root, id);
  if (employeeCreateMode()) return viewEmployeeCreate(root);

  root.appendChild(viewHead(
    'My Employees',
    'AI employees are composed from your agents, workflows, knowledge, and phone numbers. Metrics are real or empty, never invented.'
  ));

  const filters = ['all', 'inbound', 'instant_lead', 'campaign', 'draft', 'ready', 'live', 'paused'];
  const filterLabels = {
    all: 'All', inbound: 'Inbound', instant_lead: 'Instant Lead', campaign: 'Campaign',
    draft: 'Draft', ready: 'Ready', live: 'Live', paused: 'Paused',
  };
  let activeFilter = employeeFilterFromHash();
  if (!filters.includes(activeFilter)) activeFilter = 'all';

  const toolbar = el('div', { class: 'emp-toolbar' }, [
    el('div', { class: 'emp-filters', id: 'empFilters' }),
    el('button', {
      class: 'btn btn-primary',
      onclick: () => { location.hash = '#/employees?create=1'; },
    }, '+ New Employee'),
  ]);
  root.appendChild(toolbar);

  const host = el('div', { id: 'empGrid', class: 'emp-grid' }, skeleton('sk-card', 3));
  root.appendChild(host);

  function renderFilters() {
    const box = $('#empFilters');
    if (!box) return;
    box.innerHTML = '';
    filters.forEach((f) => {
      const btn = el('button', {
        class: 'emp-filter' + (f === activeFilter ? ' is-active' : ''),
        onclick: () => {
          activeFilter = f;
          location.hash = f === 'all' ? '#/employees' : '#/employees?filter=' + encodeURIComponent(f);
          renderFilters();
          loadEmpGrid();
        },
      }, filterLabels[f] || f);
      box.appendChild(btn);
    });
  }

  async function loadEmpGrid() {
    try {
      const q = activeFilter && activeFilter !== 'all' ? ('?filter=' + encodeURIComponent(activeFilter)) : '';
      const out = await api('/api/employees' + q);
      State.employees = out.employees || [];
      State.loaded.employees = true;
      host.innerHTML = '';
      if (!State.employees.length) {
        host.appendChild(el('div', { class: 'card card-pad empty emp-empty' }, [
          el('div', { class: 'ttl' }, 'No employees yet'),
          el('p', { class: 'muted' }, 'Create an AI employee from a job template. Astra composes an agent and workflow for you.'),
          el('button', {
            class: 'btn btn-primary',
            onclick: () => { location.hash = '#/employees?create=1'; },
          }, '+ New Employee'),
        ]));
        return;
      }
      State.employees.forEach((emp) => host.appendChild(employeeCard(emp)));
    } catch (e) {
      host.innerHTML = '';
      host.appendChild(el('div', { class: 'card card-pad muted' }, 'Could not load employees. ' + esc(e.message)));
    }
  }

  renderFilters();
  await loadEmpGrid();
}

function employeeCard(emp) {
  const open = el('button', { class: 'btn btn-primary' }, 'Open');
  open.onclick = () => { location.hash = '#/employees?id=' + encodeURIComponent(emp.id); };
  const testBtn = el('button', { class: 'btn btn-ghost' }, 'Test');
  testBtn.onclick = () => {
    if (emp.agentId) State.activeAgentId = emp.agentId;
    toast('Opening Talk to it with this employee agent. No live dial.', 'info');
    goto('talk');
  };
  const pauseResume = el('button', { class: 'btn btn-ghost' },
    emp.status === 'LIVE' ? 'Pause' : (emp.status === 'PAUSED' ? 'Resume' : 'Go live'));
  pauseResume.onclick = async () => {
    try {
      if (emp.status === 'LIVE') {
        await api('/api/employees/' + encodeURIComponent(emp.id) + '/pause', { method: 'POST', body: {} });
        toast('Employee paused.', 'ok');
      } else if (emp.status === 'PAUSED') {
        await api('/api/employees/' + encodeURIComponent(emp.id) + '/resume', { method: 'POST', body: {} });
        toast('Employee resumed.', 'ok');
      } else if (emp.status === 'READY' || emp.status === 'DRAFT') {
        await api('/api/employees/' + encodeURIComponent(emp.id) + '/status', {
          method: 'POST', body: { status: 'LIVE' },
        });
        toast('Employee is live.', 'ok');
      } else {
        toast('Archived employees cannot go live directly.', 'info');
        return;
      }
      State.loaded.employees = false;
      onRoute();
    } catch (e) { toast(e.message, 'err'); }
  };

  const numberLabel = (emp.assignedNumber && (emp.assignedNumber.e164 || emp.assignedNumber.label))
    || 'No number';
  const voiceLabel = (emp.language || 'en-IN') + (emp.voice && emp.voice.speaker ? ' · ' + emp.voice.speaker.replace(/_/g, ' ') : '');

  return el('article', { class: 'card emp-card' }, [
    el('div', { class: 'emp-card-top' }, [
      el('div', {}, [
        el('h3', { class: 't-h3' }, emp.name || 'Employee'),
        el('p', { class: 'muted' }, (emp.role || 'Role') + ' · ' + channelLabel(emp.channel)),
      ]),
      el('span', { class: 'pill emp-status emp-status-' + String(emp.status || '').toLowerCase() }, emp.status || 'DRAFT'),
    ]),
    el('div', { class: 'emp-meta' }, [
      el('div', {}, [el('span', { class: 'muted' }, 'Voice / language'), el('b', {}, voiceLabel)]),
      el('div', {}, [el('span', { class: 'muted' }, 'Assigned number'), el('b', {}, numberLabel)]),
      el('div', {}, [el('span', { class: 'muted' }, 'Calls today'), el('b', {}, fmtMetric(emp.callsToday))]),
      el('div', {}, [el('span', { class: 'muted' }, 'Leads'), el('b', {}, fmtMetric(emp.leads))]),
      el('div', {}, [el('span', { class: 'muted' }, 'Qualified'), el('b', {}, fmtMetric(emp.qualified))]),
      el('div', {}, [el('span', { class: 'muted' }, 'Last active'), el('b', {}, fmtLastActive(emp.lastActiveAt))]),
    ]),
    el('div', { class: 'flex gap-2 emp-card-actions' }, [open, testBtn, pauseResume]),
  ]);
}

async function viewEmployeeCreate(root) {
  root.appendChild(viewHead(
    'Create Employee',
    'Pick a job template, describe what this employee should do, and Astra composes an agent and workflow. No provider setup for normal users.'
  ));
  root.appendChild(el('button', {
    class: 'btn btn-ghost',
    style: 'margin-bottom:14px',
    onclick: () => { location.hash = '#/employees'; },
  }, '← Back to My Employees'));

  const templates = await ensureEmployeeTemplates(true).catch(() => []);
  let selectedKey = (templates[0] && templates[0].key) || 'custom';

  const name = el('input', { class: 'input', placeholder: 'Front Desk Maya' });
  const brief = el('textarea', {
    class: 'input textarea',
    placeholder: 'Describe what this employee should do. Example: Answer inbound calls for AstraNova, take messages, and book callbacks.',
  });
  const tplHost = el('div', { class: 'emp-template-grid' });
  const create = el('button', { class: 'btn btn-primary' }, 'Create employee');

  function renderTemplates() {
    tplHost.innerHTML = '';
    (templates || []).forEach((t) => {
      const card = el('button', {
        type: 'button',
        class: 'emp-template' + (t.key === selectedKey ? ' is-active' : ''),
        onclick: () => {
          selectedKey = t.key;
          if (!name.value.trim()) name.placeholder = t.name;
          renderTemplates();
        },
      }, [
        el('b', {}, t.name),
        el('span', { class: 'muted' }, t.description || ''),
        el('span', { class: 'pill' }, channelLabel(t.channel)),
      ]);
      tplHost.appendChild(card);
    });
  }
  renderTemplates();

  create.onclick = async () => {
    create.disabled = true;
    try {
      const out = await api('/api/employees', {
        method: 'POST',
        body: {
          templateKey: selectedKey,
          name: name.value.trim() || undefined,
          description: brief.value.trim(),
        },
      });
      State.loaded.employees = false;
      State.loaded.agents = false;
      State.loaded.workflows = false;
      toast('Employee created' + (out.composed ? ' with agent and workflow.' : '.'), 'ok');
      location.hash = '#/employees?id=' + encodeURIComponent(out.employee.id);
    } catch (e) { toast(e.message, 'err'); }
    finally { create.disabled = false; }
  };

  root.appendChild(el('section', { class: 'card card-pad' }, [
    el('h3', { class: 't-h3', style: 'margin-bottom:12px' }, 'Job template'),
    tplHost,
    field('Name', name),
    field('Describe what this employee should do', brief),
    create,
  ]));
}

async function viewEmployeeStudio(root, id) {
  let detail;
  try {
    detail = await api('/api/employees/' + encodeURIComponent(id));
  } catch (e) {
    root.appendChild(viewHead('Employee', 'Could not open this employee.'));
    root.appendChild(el('div', { class: 'card card-pad muted' }, e.message));
    root.appendChild(el('button', { class: 'btn btn-ghost', onclick: () => { location.hash = '#/employees'; } }, 'Back'));
    return;
  }
  const emp = detail.employee || {};
  const agent = detail.agent || null;
  const workflow = detail.workflow || null;
  const knowledgeEntries = detail.knowledge || [];

  const params = new URLSearchParams((location.hash.split('?')[1] || ''));
  let tab = String(params.get('tab') || 'overview').toLowerCase();
  const tabs = [
    ['overview', 'Overview'],
    ['instructions', 'Instructions'],
    ['workflow', 'Workflow'],
    ['training', 'Training'],
    ['number', 'Assign Number'],
    ['leads', 'Leads'],
    ['timeline', 'Timeline'],
    ['actions', 'Actions'],
    ['outcomes', 'Outcomes'],
    ['voice', 'Voice'],
    ['settings', 'Settings'],
  ];
  if (!tabs.some((t) => t[0] === tab)) tab = 'overview';

  const numberLabel = (emp.assignedNumber && (emp.assignedNumber.e164 || emp.assignedNumber.label)) || 'No number assigned';
  const header = el('div', { class: 'emp-studio-head card card-pad' }, [
    el('div', { class: 'emp-studio-title' }, [
      el('button', { class: 'btn btn-ghost', onclick: () => { location.hash = '#/employees'; } }, '← My Employees'),
      el('h2', {}, emp.name || 'Employee'),
      el('p', { class: 'muted' }, [
        document.createTextNode((emp.role || 'Role') + ' · '),
        el('span', { class: 'pill emp-status emp-status-' + String(emp.status || '').toLowerCase() }, emp.status || 'DRAFT'),
        document.createTextNode(' · ' + channelLabel(emp.channel) + ' · ' + (emp.language || 'en-IN') + ' · ' + numberLabel),
      ]),
    ]),
    el('div', { class: 'flex gap-2 emp-studio-actions' }, [
      el('button', {
        class: 'btn btn-ghost',
        onclick: () => {
          if (emp.agentId) State.activeAgentId = emp.agentId;
          goto('talk');
        },
      }, 'Talk'),
      el('button', {
        class: 'btn btn-ghost',
        onclick: () => {
          if (emp.agentId) State.activeAgentId = emp.agentId;
          toast('Chat uses the Talk to it text path with this employee agent.', 'info');
          goto('talk');
        },
      }, 'Chat'),
      el('button', {
        class: 'btn btn-ghost',
        onclick: () => {
          if (emp.agentId) State.activeAgentId = emp.agentId;
          toast('Test call opens Talk to it. Live outbound dials require Instant Leads confirm.', 'info');
          goto('talk');
        },
      }, 'Test Call'),
      el('button', {
        class: 'btn btn-primary',
        onclick: async () => {
          try {
            if (emp.status === 'LIVE') {
              await api('/api/employees/' + encodeURIComponent(emp.id) + '/pause', { method: 'POST', body: {} });
            } else if (emp.status === 'PAUSED') {
              await api('/api/employees/' + encodeURIComponent(emp.id) + '/resume', { method: 'POST', body: {} });
            } else {
              await api('/api/employees/' + encodeURIComponent(emp.id) + '/status', {
                method: 'POST', body: { status: 'LIVE' },
              });
            }
            onRoute();
          } catch (e) { toast(e.message, 'err'); }
        },
      }, emp.status === 'LIVE' ? 'Pause' : (emp.status === 'PAUSED' ? 'Resume' : 'Go live')),
    ]),
  ]);
  root.appendChild(header);

  const tabBar = el('div', { class: 'emp-tabs' });
  tabs.forEach(([key, label]) => {
    tabBar.appendChild(el('button', {
      class: 'emp-tab' + (key === tab ? ' is-active' : ''),
      onclick: () => {
        location.hash = '#/employees?id=' + encodeURIComponent(id) + '&tab=' + encodeURIComponent(key);
        onRoute();
      },
    }, label));
  });
  root.appendChild(tabBar);

  const body = el('div', { class: 'emp-studio-body card card-pad' });
  root.appendChild(body);

  function emptyStub(title, hint, ctaLabel, ctaHash) {
    body.appendChild(el('div', { class: 'emp-stub' }, [
      el('h3', { class: 't-h3' }, title),
      el('p', { class: 'muted' }, hint),
      ctaLabel ? el('button', {
        class: 'btn btn-ghost',
        onclick: () => { location.hash = ctaHash; },
      }, ctaLabel) : null,
    ]));
  }

  function dash(value) {
    const s = value == null ? '' : String(value).trim();
    return s || '—';
  }

  if (tab === 'overview') {
    body.appendChild(el('h3', { class: 't-h3' }, 'Overview'));
    body.appendChild(el('p', {}, emp.description || 'No brief yet. Add one under Instructions.'));
    body.appendChild(el('div', { class: 'emp-meta', style: 'margin-top:16px' }, [
      el('div', {}, [el('span', { class: 'muted' }, 'Calls today'), el('b', {}, fmtMetric(emp.callsToday))]),
      el('div', {}, [el('span', { class: 'muted' }, 'Leads'), el('b', {}, fmtMetric(emp.leads))]),
      el('div', {}, [el('span', { class: 'muted' }, 'Qualified'), el('b', {}, fmtMetric(emp.qualified))]),
      el('div', {}, [el('span', { class: 'muted' }, 'Last active'), el('b', {}, fmtLastActive(emp.lastActiveAt))]),
      el('div', {}, [el('span', { class: 'muted' }, 'Agent'), el('b', {}, dash(emp.agentName || emp.agentId))]),
      el('div', {}, [el('span', { class: 'muted' }, 'Workflow'), el('b', {}, dash(emp.workflowName || emp.workflowId))]),
    ]));
  } else if (tab === 'instructions') {
    body.appendChild(el('h3', { class: 't-h3' }, 'Instructions'));
    body.appendChild(el('p', { class: 'muted' },
      'Teach this employee how to greet people and what to say. Changes save to the linked agent and brief.'));
    let instr;
    try {
      instr = await api('/api/employees/' + encodeURIComponent(id) + '/instructions');
    } catch (e) {
      body.appendChild(el('p', { class: 'muted' }, 'Could not load instructions. ' + esc(e.message)));
      return;
    }
    if (!instr.hasAgent) {
      emptyStub('No agent linked', 'Create this employee from a job template so Astra can compose an agent to teach.', 'Back to list', '#/employees');
      return;
    }
    const briefIn = el('textarea', { class: 'input textarea', rows: '3' });
    briefIn.value = instr.brief || '';
    const greetIn = el('textarea', { class: 'input textarea', rows: '2' });
    greetIn.value = instr.greeting || '';
    const teachIn = el('textarea', { class: 'input textarea', rows: '6' });
    teachIn.value = instr.instructions || '';
    const stepEditors = [];
    (instr.steps || []).forEach((step) => {
      const ta = el('textarea', { class: 'input textarea', rows: '2' });
      ta.value = step.guidance || '';
      stepEditors.push({ id: step.id, name: step.name, ta });
    });
    body.appendChild(field('Brief', briefIn));
    body.appendChild(field('Greeting', greetIn));
    body.appendChild(field('Instructions', teachIn));
    stepEditors.forEach((s) => {
      body.appendChild(field((s.name || 'Step') + ' guidance', s.ta));
    });
    const save = el('button', { class: 'btn btn-primary' }, 'Save instructions');
    save.onclick = async () => {
      save.disabled = true;
      try {
        await api('/api/employees/' + encodeURIComponent(id) + '/instructions', {
          method: 'PUT',
          body: {
            brief: briefIn.value,
            greeting: greetIn.value,
            instructions: teachIn.value,
            steps: stepEditors.map((s) => ({ id: s.id, guidance: s.ta.value })),
          },
        });
        toast('Instructions saved.', 'ok');
        onRoute();
      } catch (e) { toast(e.message, 'err'); }
      finally { save.disabled = false; }
    };
    body.appendChild(save);
  } else if (tab === 'workflow') {
    body.appendChild(el('h3', { class: 't-h3' }, 'Workflow'));
    body.appendChild(el('p', { class: 'muted' },
      'Edit the steps and guidance this employee follows. Changes save to the linked workflow. No provider config here.'));
    let wfPayload;
    try {
      wfPayload = await api('/api/employees/' + encodeURIComponent(id) + '/workflow');
    } catch (e) {
      body.appendChild(el('p', { class: 'muted' }, 'Could not load workflow. ' + esc(e.message)));
      return;
    }
    if (!wfPayload.hasWorkflow) {
      emptyStub('No workflow linked', 'Compose a workflow from a job template, or link one in Settings.', 'Open Workflows', '#/workflows');
      return;
    }
    const nameIn = el('input', { class: 'input' });
    nameIn.value = wfPayload.name || '';
    const descIn = el('textarea', { class: 'input textarea', rows: '2' });
    descIn.value = wfPayload.description || '';
    const globalIn = el('textarea', { class: 'input textarea', rows: '2' });
    globalIn.value = wfPayload.globalGuidance || '';
    const steps = (wfPayload.steps || []).map((s) => ({
      id: s.id,
      name: s.name || 'Step',
      guidance: s.guidance || '',
    }));
    const stepsHost = el('div', { class: 'emp-workflow-steps' });
    function renderSteps() {
      stepsHost.innerHTML = '';
      if (!steps.length) {
        stepsHost.appendChild(el('p', { class: 'muted' }, 'No steps yet. —'));
        return;
      }
      steps.forEach((s, idx) => {
        const nameStep = el('input', { class: 'input', value: s.name || '' });
        const guideStep = el('textarea', { class: 'input textarea', rows: '3' });
        guideStep.value = s.guidance || '';
        nameStep.oninput = () => { steps[idx].name = nameStep.value; };
        guideStep.oninput = () => { steps[idx].guidance = guideStep.value; };
        const remove = el('button', { class: 'btn btn-ghost' }, 'Remove step');
        remove.onclick = () => { steps.splice(idx, 1); renderSteps(); };
        stepsHost.appendChild(el('div', { class: 'emp-block' }, [
          el('b', {}, 'Step ' + (idx + 1)),
          field('Name', nameStep),
          field('Guidance', guideStep),
          remove,
        ]));
      });
    }
    renderSteps();
    body.appendChild(el('p', { class: 'muted' },
      'Status: ' + dash(wfPayload.status) + ' · Direction: ' + dash(wfPayload.direction)));
    body.appendChild(field('Workflow name', nameIn));
    body.appendChild(field('Description', descIn));
    body.appendChild(el('h4', { class: 't-h3', style: 'margin-top:16px' }, 'Steps'));
    body.appendChild(stepsHost);
    const addStep = el('button', { class: 'btn btn-ghost' }, 'Add step');
    addStep.onclick = () => {
      steps.push({ id: null, name: 'New step', guidance: '' });
      renderSteps();
    };
    body.appendChild(addStep);
    body.appendChild(field('Global guidance', globalIn));
    const save = el('button', { class: 'btn btn-primary' }, 'Save workflow');
    save.onclick = async () => {
      save.disabled = true;
      try {
        await api('/api/employees/' + encodeURIComponent(id) + '/workflow', {
          method: 'PUT',
          body: {
            name: nameIn.value.trim(),
            description: descIn.value,
            globalGuidance: globalIn.value,
            steps: steps.map((s) => ({ id: s.id, name: s.name, guidance: s.guidance })),
          },
        });
        toast('Workflow saved.', 'ok');
        onRoute();
      } catch (e) { toast(e.message, 'err'); }
      finally { save.disabled = false; }
    };
    body.appendChild(el('div', { class: 'flex gap-2', style: 'margin-top:16px;flex-wrap:wrap' }, [
      save,
      el('button', {
        class: 'btn btn-ghost',
        onclick: () => {
          if (wfPayload.workflowId) {
            location.hash = '#/workflows?id=' + encodeURIComponent(wfPayload.workflowId);
          } else {
            location.hash = '#/workflows';
          }
        },
      }, 'Open full Workflow builder'),
    ]));
  } else if (tab === 'timeline') {
    body.appendChild(el('h3', { class: 't-h3' }, 'Timeline'));
    body.appendChild(el('p', { class: 'muted' },
      'Real activity only: leads connected, call jobs, conversations started or ended, outcomes set. Empty means no activity yet.'));
    let tl;
    try {
      tl = await api('/api/employees/' + encodeURIComponent(id) + '/timeline?limit=50');
    } catch (e) {
      body.appendChild(el('p', { class: 'muted' }, 'Could not load timeline. ' + esc(e.message)));
      return;
    }
    const events = tl.events || [];
    if (!events.length) {
      body.appendChild(el('p', { class: 'muted' }, 'No activity yet. —'));
    } else {
      events.forEach((evt) => {
        body.appendChild(el('div', { class: 'emp-block' }, [
          el('b', {}, evt.label || evt.type || 'Event'),
          el('p', { class: 'muted' }, fmtCallTime(evt.at) + (evt.detail ? ' · ' + evt.detail : '')),
          el('p', { class: 'muted' }, [
            evt.leadId ? ('Lead ' + evt.leadId + ' · ') : '',
            evt.callId ? ('Conversation ' + evt.callId + ' · ') : '',
            evt.callJobId ? ('Job ' + evt.callJobId) : '',
          ].join('') || '—'),
        ]));
      });
    }
  } else if (tab === 'training') {
    body.appendChild(el('h3', { class: 't-h3' }, 'Training'));
    body.appendChild(el('p', { class: 'muted' },
      'Attach Knowledge so this employee can use your real docs and FAQs. Empty means no data, not invented content.'));
    let training;
    let available = [];
    try {
      training = await api('/api/employees/' + encodeURIComponent(id) + '/training');
      const allKb = await api('/api/knowledge').catch(() => ({ entries: [] }));
      available = (allKb.entries || []).filter((k) => !(training.knowledgeIds || []).includes(k.id));
    } catch (e) {
      body.appendChild(el('p', { class: 'muted' }, 'Could not load training. ' + esc(e.message)));
      return;
    }
    const entries = training.entries || [];
    if (!entries.length) {
      body.appendChild(el('p', { class: 'muted' }, 'No knowledge linked yet. —'));
    } else {
      entries.forEach((k) => {
        const remove = el('button', { class: 'btn btn-ghost' }, 'Remove');
        remove.onclick = async () => {
          try {
            await api('/api/employees/' + encodeURIComponent(id) + '/knowledge/' + encodeURIComponent(k.id), {
              method: 'DELETE',
            });
            toast('Removed.', 'ok');
            onRoute();
          } catch (e) { toast(e.message, 'err'); }
        };
        body.appendChild(el('div', { class: 'emp-block' }, [
          el('b', {}, k.title || 'Entry'),
          el('p', { class: 'muted' }, (k.content || '').slice(0, 220) || k.sourceUrl || '—'),
          el('p', { class: 'muted' }, 'Status: ' + (k.status || '—')),
          remove,
        ]));
      });
    }

    const attachSelect = el('select', { class: 'select' },
      [el('option', { value: '' }, available.length ? 'Select existing knowledge' : 'No other knowledge available')].concat(
        available.map((k) => el('option', { value: k.id }, k.title || k.id))
      )
    );
    const attachBtn = el('button', { class: 'btn btn-ghost' }, 'Attach');
    attachBtn.onclick = async () => {
      if (!attachSelect.value) return toast('Pick a knowledge entry first.', 'info');
      try {
        await api('/api/employees/' + encodeURIComponent(id) + '/knowledge', {
          method: 'POST',
          body: { knowledgeId: attachSelect.value },
        });
        toast('Attached.', 'ok');
        onRoute();
      } catch (e) { toast(e.message, 'err'); }
    };
    body.appendChild(el('div', { class: 'flex gap-2', style: 'margin-top:16px;align-items:flex-end;flex-wrap:wrap' }, [
      field('Link existing', attachSelect),
      attachBtn,
    ]));

    const titleIn = el('input', { class: 'input', placeholder: 'Title' });
    const contentIn = el('textarea', { class: 'input textarea', rows: '3', placeholder: 'Paste FAQ or notes' });
    const createBtn = el('button', { class: 'btn btn-primary' }, 'Add training note');
    createBtn.onclick = async () => {
      createBtn.disabled = true;
      try {
        await api('/api/employees/' + encodeURIComponent(id) + '/knowledge', {
          method: 'POST',
          body: { title: titleIn.value.trim(), content: contentIn.value.trim(), status: 'published', create: true },
        });
        toast('Training note added.', 'ok');
        onRoute();
      } catch (e) { toast(e.message, 'err'); }
      finally { createBtn.disabled = false; }
    };
    body.appendChild(el('div', { style: 'margin-top:20px' }, [
      el('h4', { class: 't-h3' }, 'Add new'),
      field('Title', titleIn),
      field('Content', contentIn),
      createBtn,
    ]));
  } else if (tab === 'number') {
    body.appendChild(el('h3', { class: 't-h3' }, 'Assign Number'));
    body.appendChild(el('p', { class: 'muted' },
      'Give this employee a Phone Number from your inventory. Configure Inbound answer, greeting, and hours here. Provider portals stay invisible.'));
    const current = emp.assignedNumber;
    body.appendChild(el('div', { class: 'emp-meta', style: 'margin-bottom:16px' }, [
      el('div', {}, [
        el('span', { class: 'muted' }, 'Current Phone Number'),
        el('b', {}, current && current.e164 ? current.e164 : '—'),
      ]),
      el('div', {}, [
        el('span', { class: 'muted' }, 'Astra id'),
        el('b', {}, emp.phoneNumberId || '—'),
      ]),
    ]));
    let pnData;
    try {
      pnData = await ensurePhoneNumbers(true);
    } catch (e) {
      body.appendChild(el('p', { class: 'muted' }, 'Could not load Phone Numbers. ' + esc(e.message)));
      return;
    }
    const available = pnData.available || [];
    const mine = (pnData.numbers || []).filter((n) => n.assignedEmployeeId === emp.id || n.id === emp.phoneNumberId);
    if (mine.length) {
      const unBtn = el('button', { class: 'btn btn-ghost' }, 'Unassign Phone Number');
      unBtn.onclick = () => {
        modal({
          title: 'Unassign Phone Number',
          body: el('p', {}, 'Release this Phone Number back to inventory?'),
          confirmText: 'Unassign',
          confirmKind: 'danger',
          onConfirm: async () => {
            await api('/api/phone-numbers/' + encodeURIComponent(mine[0].id) + '/unassign', { method: 'POST', body: {} });
            State.loaded.phoneNumbers = false;
            State.loaded.employees = false;
            toast('Phone Number unassigned.', 'ok');
            onRoute();
          },
        });
      };
      body.appendChild(unBtn);

      // Phase 17: Inbound ownership on assigned Phone Number → Employee.
      let inboundPayload;
      try {
        inboundPayload = await api('/api/phone-numbers/' + encodeURIComponent(mine[0].id) + '/inbound');
      } catch (e) {
        body.appendChild(el('p', { class: 'muted', style: 'margin-top:14px' },
          'Could not load Inbound settings. ' + esc(e.message)));
        inboundPayload = null;
      }
      if (inboundPayload && inboundPayload.inbound) {
        const inbound = inboundPayload.inbound;
        body.appendChild(el('h4', { class: 't-h3', style: 'margin-top:22px' }, 'Inbound'));
        body.appendChild(el('p', { class: 'muted' },
          'Answer, greeting, and hours for this Phone Number. Routed to this Employee.'));
        const answerIn = el('input', { type: 'checkbox' });
        answerIn.checked = inbound.answer !== false;
        const greetingIn = el('textarea', { class: 'input textarea', rows: '3' });
        greetingIn.value = inbound.greeting || '';
        const hoursMode = el('select', { class: 'select' }, [
          el('option', { value: 'always' }, 'Always answer'),
          el('option', { value: 'schedule' }, 'Scheduled hours'),
        ]);
        hoursMode.value = (inbound.hours && inbound.hours.mode === 'schedule') ? 'schedule' : 'always';
        const tzIn = el('input', { class: 'input', value: (inbound.hours && inbound.hours.timezone) || 'Asia/Kolkata' });
        const saveInbound = el('button', { class: 'btn btn-primary' }, 'Save Inbound');
        saveInbound.onclick = async () => {
          saveInbound.disabled = true;
          try {
            await api('/api/phone-numbers/' + encodeURIComponent(mine[0].id) + '/inbound', {
              method: 'PUT',
              body: {
                answer: !!answerIn.checked,
                greeting: greetingIn.value,
                hours: {
                  timezone: tzIn.value.trim() || 'Asia/Kolkata',
                  mode: hoursMode.value === 'schedule' ? 'schedule' : 'always',
                  windows: (inbound.hours && inbound.hours.windows) || [],
                },
              },
            });
            State.loaded.phoneNumbers = false;
            toast('Inbound saved.', 'ok');
            onRoute();
          } catch (e) { toast(e.message, 'err'); }
          finally { saveInbound.disabled = false; }
        };
        body.appendChild(el('label', { class: 'muted', style: 'display:flex;gap:8px;align-items:center;margin:12px 0' }, [
          answerIn,
          document.createTextNode('Answer inbound calls'),
        ]));
        body.appendChild(field('Greeting', greetingIn));
        body.appendChild(field('Hours', hoursMode));
        body.appendChild(field('Timezone', tzIn));
        body.appendChild(saveInbound);
      }
    }
    if (!available.length && !mine.length) {
      body.appendChild(el('p', { class: 'muted', style: 'margin-top:14px' },
        'No Phone Numbers available. Open Phone Numbers to manage inventory.'));
      body.appendChild(el('button', {
        class: 'btn btn-ghost', style: 'margin-top:10px', onclick: () => goto('numbers'),
      }, 'Open Phone Numbers'));
    } else if (available.length) {
      const sel = el('select', { class: 'select' }, [
        el('option', { value: '' }, 'Select Phone Number'),
      ].concat(available.map((n) => el('option', { value: n.id }, (n.e164 || n.id) + (n.label ? ' · ' + n.label : '')))));
      const assignBtn = el('button', { class: 'btn btn-primary' }, 'Assign Number');
      assignBtn.onclick = async () => {
        if (!sel.value) { toast('Choose a Phone Number.', 'err'); return; }
        if (!emp.agentId) { toast('Employee needs a linked agent before assign.', 'err'); return; }
        assignBtn.disabled = true;
        try {
          await api('/api/phone-numbers/' + encodeURIComponent(sel.value) + '/assign', {
            method: 'POST',
            body: { employeeId: emp.id, inboundEnabled: true, outboundEnabled: true },
          });
          State.loaded.phoneNumbers = false;
          State.loaded.employees = false;
          toast('Phone Number assigned.', 'ok');
          onRoute();
        } catch (e) { toast(e.message, 'err'); }
        finally { assignBtn.disabled = false; }
      };
      body.appendChild(field('Available Phone Numbers', sel));
      body.appendChild(assignBtn);
    }
  } else if (tab === 'leads') {
    body.appendChild(el('h3', { class: 't-h3' }, 'Connect Leads'));
    body.appendChild(el('p', { class: 'muted' },
      'Assign leads to this employee. Outbound dials still require Instant Leads confirm. No unauthorized dials from here.'));
    const nameIn = el('input', { class: 'input', placeholder: 'Lead name' });
    const phoneIn = el('input', { class: 'input', placeholder: 'Phone (+91... or 10-digit IN)' });
    const addBtn = el('button', { class: 'btn btn-primary' }, 'Connect lead');
    const listHost = el('div', { class: 'ticket-list', style: 'margin-top:16px' }, skeleton('sk-card', 2));
    addBtn.onclick = async () => {
      addBtn.disabled = true;
      try {
        await api('/api/leads', {
          method: 'POST',
          body: {
            name: nameIn.value.trim(),
            phone: phoneIn.value.trim(),
            employeeId: emp.id,
          },
        });
        nameIn.value = '';
        phoneIn.value = '';
        toast('Lead connected.', 'ok');
        await refreshEmployeeLeads(listHost, emp.id);
      } catch (e) { toast(e.message, 'err'); }
      finally { addBtn.disabled = false; }
    };
    body.appendChild(el('div', { class: 'support-compose' }, [
      field('Name', nameIn),
      field('Phone', phoneIn),
      addBtn,
    ]));
    body.appendChild(listHost);
    body.appendChild(el('button', {
      class: 'btn btn-ghost',
      style: 'margin-top:12px',
      onclick: () => goto('leads'),
    }, 'Open Instant Leads'));
    await refreshEmployeeLeads(listHost, emp.id);
  } else if (tab === 'actions') {
    body.appendChild(el('h3', { class: 't-h3' }, 'Actions'));
    body.appendChild(el('p', { class: 'muted' },
      'Define what this Employee can do after or during a conversation. Live CRM calls are not enabled in this release.'));
    let actionsPayload;
    try {
      actionsPayload = await api('/api/employees/' + encodeURIComponent(id) + '/actions');
    } catch (e) {
      body.appendChild(el('p', { class: 'muted' }, 'Could not load actions. ' + esc(e.message)));
      return;
    }
    const defs = (actionsPayload.definitions || []).slice();
    const types = actionsPayload.types || [];
    const listHost = el('div', { class: 'emp-actions-editor' });
    function renderActions() {
      listHost.innerHTML = '';
      if (!defs.length) {
        listHost.appendChild(el('p', { class: 'muted' }, 'No actions configured. —'));
        return;
      }
      defs.forEach((d, idx) => {
        const labelIn = el('input', { class: 'input', value: d.label || d.key || '' });
        const descIn = el('input', { class: 'input', value: d.description || '', placeholder: 'Optional description' });
        const enabledIn = el('input', { type: 'checkbox' });
        enabledIn.checked = d.enabled !== false;
        const remove = el('button', { class: 'btn btn-ghost' }, 'Remove');
        remove.onclick = () => { defs.splice(idx, 1); renderActions(); };
        labelIn.oninput = () => { defs[idx].label = labelIn.value; };
        descIn.oninput = () => { defs[idx].description = descIn.value; };
        enabledIn.onchange = () => { defs[idx].enabled = enabledIn.checked; };
        const extra = [];
        if (d.type === 'crm_webhook') {
          const urlIn = el('input', {
            class: 'input',
            value: (d.config && d.config.webhookUrl) || '',
            placeholder: 'https://… (stored only, not called live)',
          });
          urlIn.oninput = () => {
            defs[idx].config = Object.assign({}, defs[idx].config || {}, { webhookUrl: urlIn.value.trim() });
          };
          extra.push(field('Webhook URL', urlIn));
        }
        if (d.type === 'tag_outcome') {
          const okIn = el('input', {
            class: 'input',
            value: (d.config && d.config.outcomeKey) || '',
            placeholder: 'Outcome key (reuse Outcomes)',
          });
          okIn.oninput = () => {
            defs[idx].config = Object.assign({}, defs[idx].config || {}, { outcomeKey: okIn.value.trim() });
          };
          extra.push(field('Outcome key', okIn));
        }
        listHost.appendChild(el('div', { class: 'emp-block' }, [
          el('p', { class: 'muted' }, 'Type: ' + (d.type || '—') + ' · Key: ' + (d.key || '—')),
          field('Label', labelIn),
          field('Description', descIn),
          el('label', { class: 'muted', style: 'display:flex;gap:8px;align-items:center;margin:8px 0' }, [
            enabledIn,
            document.createTextNode('Enabled'),
          ]),
          ...extra,
          remove,
        ]));
      });
    }
    renderActions();
    body.appendChild(listHost);
    const typeSel = el('select', { class: 'select' },
      [el('option', { value: '' }, 'Select action type')].concat(
        types.map((t) => el('option', { value: t.type }, t.label || t.type))
      )
    );
    const addBtn = el('button', { class: 'btn btn-ghost' }, 'Add action');
    addBtn.onclick = () => {
      if (!typeSel.value) return toast('Pick an action type.', 'info');
      const t = types.find((x) => x.type === typeSel.value) || { type: typeSel.value, label: typeSel.value };
      if (defs.some((d) => d.key === t.type)) return toast('That action already exists.', 'info');
      defs.push({
        key: t.type,
        type: t.type,
        label: t.label || t.type,
        description: t.description || '',
        enabled: true,
        config: {},
      });
      renderActions();
    };
    const save = el('button', { class: 'btn btn-primary' }, 'Save actions');
    save.onclick = async () => {
      save.disabled = true;
      try {
        await api('/api/employees/' + encodeURIComponent(id) + '/actions', {
          method: 'PUT',
          body: {
            definitions: defs.map((d) => ({
              key: d.key,
              type: d.type,
              label: d.label,
              description: d.description || '',
              enabled: d.enabled !== false,
              config: d.config || {},
            })),
          },
        });
        toast('Actions saved.', 'ok');
        onRoute();
      } catch (e) { toast(e.message, 'err'); }
      finally { save.disabled = false; }
    };
    body.appendChild(el('div', { class: 'flex gap-2', style: 'margin-top:12px;flex-wrap:wrap;align-items:flex-end' }, [
      field('Add', typeSel),
      addBtn,
      save,
    ]));
    body.appendChild(el('p', { class: 'muted', style: 'margin-top:14px' },
      'Execution hooks are foundation only (queued_foundation). No Phase 2 webhooks. Overlap with Outcomes is intentional for tag outcome.'));
  } else if (tab === 'outcomes') {
    body.appendChild(el('h3', { class: 't-h3' }, 'Outcomes'));
    body.appendChild(el('p', { class: 'muted' },
      'Define what success looks like after a conversation. Live conversation results are not invented here.'));
    let outcomesPayload;
    try {
      outcomesPayload = await api('/api/employees/' + encodeURIComponent(id) + '/outcomes');
    } catch (e) {
      body.appendChild(el('p', { class: 'muted' }, 'Could not load outcomes. ' + esc(e.message)));
      return;
    }
    const defs = (outcomesPayload.definitions || []).slice();
    const listHost = el('div', { class: 'emp-outcomes-editor' });
    function renderDefs() {
      listHost.innerHTML = '';
      if (!defs.length) {
        listHost.appendChild(el('p', { class: 'muted' }, 'No outcomes configured. —'));
        return;
      }
      defs.forEach((d, idx) => {
        const labelIn = el('input', { class: 'input', value: d.label || d.key || '' });
        const descIn = el('input', { class: 'input', value: d.description || '', placeholder: 'Optional description' });
        const successIn = el('input', { type: 'checkbox' });
        successIn.checked = !!d.success;
        const remove = el('button', { class: 'btn btn-ghost' }, 'Remove');
        remove.onclick = () => { defs.splice(idx, 1); renderDefs(); };
        labelIn.oninput = () => { defs[idx].label = labelIn.value; };
        descIn.oninput = () => { defs[idx].description = descIn.value; };
        successIn.onchange = () => { defs[idx].success = successIn.checked; };
        listHost.appendChild(el('div', { class: 'emp-block' }, [
          field('Label', labelIn),
          field('Description', descIn),
          el('label', { class: 'muted', style: 'display:flex;gap:8px;align-items:center;margin:8px 0' }, [
            successIn,
            document.createTextNode('Counts as success'),
          ]),
          el('p', { class: 'muted' }, 'Key: ' + (d.key || '—')),
          remove,
        ]));
      });
    }
    renderDefs();
    body.appendChild(listHost);
    const addLabel = el('input', { class: 'input', placeholder: 'New outcome label' });
    const addBtn = el('button', { class: 'btn btn-ghost' }, 'Add outcome');
    addBtn.onclick = () => {
      const label = addLabel.value.trim();
      if (!label) return toast('Enter a label.', 'info');
      const key = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
      if (!key) return toast('Invalid label.', 'err');
      if (defs.some((d) => d.key === key)) return toast('That outcome already exists.', 'info');
      defs.push({ key, label, description: '', success: false });
      addLabel.value = '';
      renderDefs();
    };
    const save = el('button', { class: 'btn btn-primary' }, 'Save outcomes');
    save.onclick = async () => {
      save.disabled = true;
      try {
        await api('/api/employees/' + encodeURIComponent(id) + '/outcomes', {
          method: 'PUT',
          body: {
            definitions: defs.map((d) => ({
              key: d.key,
              label: d.label,
              description: d.description || '',
              success: !!d.success,
            })),
          },
        });
        toast('Outcomes saved.', 'ok');
        onRoute();
      } catch (e) { toast(e.message, 'err'); }
      finally { save.disabled = false; }
    };
    body.appendChild(el('div', { class: 'flex gap-2', style: 'margin-top:12px;flex-wrap:wrap;align-items:flex-end' }, [
      field('Add', addLabel),
      addBtn,
      save,
    ]));
    body.appendChild(el('p', { class: 'muted', style: 'margin-top:14px' },
      'Qualified count on the card uses real conversation outcomes only. Current qualified: ' + fmtMetric(emp.qualified) + '.'));
  } else if (tab === 'voice') {
    body.appendChild(el('h3', { class: 't-h3' }, 'Voice'));
    const v = emp.voice || {};
    body.appendChild(el('p', { class: 'muted' },
      'Choose the Language this Employee speaks. Only supported languages are listed.'));
    let languages = [];
    try {
      const langRes = await api('/api/employees/languages');
      languages = langRes.languages || [];
    } catch (_) {
      languages = [
        { id: 'en-IN', label: 'English (India)' },
        { id: 'hi-IN', label: 'Hindi' },
        { id: 'te-IN', label: 'Telugu' },
        { id: 'ta-IN', label: 'Tamil' },
      ];
    }
    const currentLang = v.language || emp.language || 'en-IN';
    const langSel = el('select', { class: 'select' },
      languages.map((l) => el('option', {
        value: l.id,
        selected: l.id === currentLang ? 'selected' : null,
      }, l.label + (l.nativeLabel && l.nativeLabel !== l.label ? ' · ' + l.nativeLabel : '')))
    );
    const saveLang = el('button', { class: 'btn btn-primary' }, 'Save Language');
    saveLang.onclick = async () => {
      saveLang.disabled = true;
      try {
        await api('/api/employees/' + encodeURIComponent(emp.id) + '/language', {
          method: 'PUT',
          body: { language: langSel.value },
        });
        State.loaded.employees = false;
        toast('Language saved.', 'ok');
        onRoute();
      } catch (e) { toast(e.message, 'err'); }
      finally { saveLang.disabled = false; }
    };
    body.appendChild(field('Language', langSel));
    body.appendChild(saveLang);
    body.appendChild(el('div', { class: 'emp-meta', style: 'margin-top:18px' }, [
      el('div', {}, [el('span', { class: 'muted' }, 'Speaker'), el('b', {}, (v.speaker || 'speaker_1').replace(/_/g, ' '))]),
      el('div', {}, [el('span', { class: 'muted' }, 'Model'), el('b', {}, v.model || 'mulberry')]),
    ]));
    body.appendChild(el('p', { class: 'muted', style: 'margin-top:12px' },
      'Voice preview and tuning live in Voice Studio and the linked agent. Provider names are not shown here.'));
    body.appendChild(el('div', { class: 'flex gap-2', style: 'margin-top:12px' }, [
      el('button', { class: 'btn btn-ghost', onclick: () => goto('studio') }, 'Open Voice Studio'),
      el('button', { class: 'btn btn-ghost', onclick: () => goto('agents') }, 'Open Agents'),
    ]));
  } else if (tab === 'settings') {
    body.appendChild(el('h3', { class: 't-h3' }, 'Settings'));
    const nameIn = el('input', { class: 'input', value: emp.name || '' });
    const roleIn = el('input', { class: 'input', value: emp.role || '' });
    const descIn = el('textarea', { class: 'input textarea' });
    descIn.value = emp.description || '';
    const save = el('button', { class: 'btn btn-primary' }, 'Save');
    save.onclick = async () => {
      try {
        await api('/api/employees/' + encodeURIComponent(emp.id), {
          method: 'PATCH',
          body: { name: nameIn.value.trim(), role: roleIn.value.trim(), description: descIn.value.trim() },
        });
        toast('Saved.', 'ok');
        onRoute();
      } catch (e) { toast(e.message, 'err'); }
    };
    const archive = el('button', { class: 'btn btn-ghost' }, 'Archive');
    archive.onclick = async () => {
      try {
        await api('/api/employees/' + encodeURIComponent(emp.id) + '/status', {
          method: 'POST', body: { status: 'ARCHIVED' },
        });
        toast('Archived.', 'ok');
        location.hash = '#/employees';
      } catch (e) { toast(e.message, 'err'); }
    };
    body.appendChild(field('Name', nameIn));
    body.appendChild(field('Role', roleIn));
    body.appendChild(field('Brief', descIn));
    body.appendChild(el('div', { class: 'flex gap-2' }, [save, archive]));
    body.appendChild(el('p', { class: 'muted', style: 'margin-top:16px' },
      'Phone Number assignment lives on the Assign Number tab. Linked ids: agent ' + (emp.agentId || '—')
      + ', workflow ' + (emp.workflowId || '—')
      + ', number ' + (emp.phoneNumberId || '—') + '.'));
    body.appendChild(el('button', {
      class: 'btn btn-ghost',
      style: 'margin-top:10px',
      onclick: () => { location.hash = '#/employees?id=' + encodeURIComponent(emp.id) + '&tab=number'; },
    }, 'Open Assign Number'));
  }
}

async function refreshEmployeeLeads(host, employeeId) {
  try {
    const out = await api('/api/employees/' + encodeURIComponent(employeeId) + '/leads');
    host.innerHTML = '';
    const rows = out.leads || [];
    if (!rows.length) {
      host.appendChild(el('div', { class: 'card card-pad muted' }, 'No leads connected yet. —'));
      return;
    }
    rows.forEach((lead) => {
      host.appendChild(el('div', { class: 'card card-pad', style: 'margin-bottom:10px' }, [
        el('div', { class: 'flex items-center justify-between gap-2' }, [
          el('b', {}, lead.name || 'Lead'),
          el('span', { class: 'pill' }, lead.status || 'new'),
        ]),
        el('p', { class: 'muted' }, (lead.phone || '—') + (lead.lastCallId ? ' · conversation ' + lead.lastCallId : '')),
        el('p', { class: 'muted' }, lead.lastError ? ('Last error: ' + lead.lastError) : 'Outcome: ' + (lead.outcomeKey || '—')),
      ]));
    });
  } catch (e) {
    host.innerHTML = '';
    host.appendChild(el('div', { class: 'card card-pad muted' }, 'Could not load leads. ' + esc(e.message)));
  }
}

/* ===========================================================================
   2. AGENTS
   =========================================================================== */
async function viewAgents(root) {
  root.appendChild(viewHead('Agents', 'Pick an agent type, choose a preset, then tweak name, voice, and greeting before you deploy.'));

  const wizardHost = el('div', { id: 'agentWizard', class: 'card builder' }, skeleton('sk-card', 1));
  root.appendChild(wizardHost);

  const gridHost = el('div', { id: 'agentsGrid', class: 'agents-grid', style: 'margin-top:22px' }, skeleton('sk-card', 3));
  root.appendChild(gridHost);

  try {
    await Promise.all([
      ensureAgents(true),
      ensureAgentTypes().catch(() => []),
      ensurePresets().catch(() => []),
      ensureTelephony().catch(() => null),
      ensureProviders().catch(() => null),
    ]);
    if (!State.createDraft) State.createDraft = { step: 1, agentType: '', presetId: null };
    paintAgentWizard();
    refillDidOptions();
    paintAgents();
  } catch (e) {
    wizardHost.innerHTML = '';
    wizardHost.appendChild(el('div', { class: 'muted' }, 'Could not load the create flow. ' + esc(e.message)));
    gridHost.innerHTML = '';
    gridHost.appendChild(el('div', { class: 'empty muted' }, 'Could not load agents. ' + esc(e.message)));
  }
}

function paintAgentWizard() {
  const host = $('#agentWizard'); if (!host) return;
  const draft = State.createDraft || { step: 1, agentType: '', presetId: null };
  const step = Math.max(1, Math.min(3, Number(draft.step) || 1));
  draft.step = step;
  State.createDraft = draft;
  host.innerHTML = '';

  host.appendChild(el('h3', {}, 'Deploy an agent'));
  host.appendChild(el('p', { class: 'hint' }, 'No payment and no API keys required for Astra testing. Type first, then preset, then fine tune.'));
  host.appendChild(el('div', { class: 'wizard-steps' }, [1, 2, 3].map((n) => {
    const labels = { 1: 'Agent type', 2: 'Preset', 3: 'Configure' };
    return el('div', { class: 'wizard-step' + (n === step ? ' on' : '') + (n < step ? ' done' : '') }, [
      el('span', { class: 'wizard-num' }, String(n)),
      el('span', {}, labels[n])
    ]);
  })));

  if (step === 1) {
    const grid = el('div', { class: 'type-pick-grid' });
    (State.agentTypes || []).forEach((t) => {
      const selected = draft.agentType === t.id;
      grid.appendChild(el('button', {
        type: 'button',
        class: 'type-pick' + (selected ? ' on' : ''),
        onclick: () => {
          State.createDraft = { step: 2, agentType: t.id, presetId: null };
          paintAgentWizard();
        }
      }, [
        el('div', { class: 'type-pick-top' }, [
          el('strong', {}, t.label),
          el('span', { class: 'tag' }, directionLabel(t.direction))
        ]),
        el('p', { class: 'muted' }, t.description)
      ]));
    });
    if (!(State.agentTypes || []).length) grid.appendChild(el('div', { class: 'muted' }, 'No agent types are available.'));
    host.appendChild(grid);
    return;
  }

  if (step === 2) {
    const type = agentTypeMeta(draft.agentType);
    const recommended = new Set((type && type.recommendedPresetIds) || []);
    const filtered = (State.presets || []).filter((p) => {
      if (draft.agentType === 'custom') return false;
      return p.agentType === draft.agentType || recommended.has(p.id);
    });
    host.appendChild(el('div', { class: 'flex items-center justify-between gap-2', style: 'margin-bottom:14px' }, [
      el('div', {}, [
        el('div', { class: 'muted', style: 'font-size:.75rem;text-transform:uppercase;letter-spacing:.08em' }, 'Selected type'),
        el('strong', {}, (type && type.label) || draft.agentType || 'Custom')
      ]),
      el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => { State.createDraft = { step: 1, agentType: '', presetId: null }; paintAgentWizard(); } }, 'Change type')
    ]));

    const grid = el('div', { class: 'preset-pick-grid' });
    if (draft.agentType === 'custom') {
      grid.appendChild(el('button', {
        type: 'button',
        class: 'preset-pick on',
        onclick: () => { State.createDraft = { step: 3, agentType: 'custom', presetId: null }; paintAgentWizard(); }
      }, [
        el('strong', {}, 'Blank custom agent'),
        el('p', { class: 'muted' }, 'Start with an empty persona and greeting.')
      ]));
    } else {
      filtered.forEach((p) => {
        grid.appendChild(el('button', {
          type: 'button',
          class: 'preset-pick' + (draft.presetId === p.id ? ' on' : ''),
          onclick: () => { State.createDraft = { step: 3, agentType: draft.agentType, presetId: p.id }; paintAgentWizard(); }
        }, [
          el('div', { class: 'type-pick-top' }, [
            el('strong', {}, p.name),
            el('span', { class: 'tag' }, directionLabel(p.direction))
          ]),
          el('p', { class: 'muted' }, p.description || 'Editable starting point.'),
          recommended.has(p.id) ? el('span', { class: 'badge-ready' }, 'Recommended') : null
        ]));
      });
      if (!filtered.length) grid.appendChild(el('div', { class: 'muted' }, 'No presets match this type yet.'));
    }
    host.appendChild(grid);
    return;
  }

  const preset = (State.presets || []).find((p) => p.id === draft.presetId) || null;
  const type = agentTypeMeta(draft.agentType) || agentTypeMeta(preset && preset.agentType);
  host.appendChild(el('div', { class: 'flex items-center justify-between gap-2', style: 'margin-bottom:14px' }, [
    el('div', {}, [
      el('div', { class: 'muted', style: 'font-size:.75rem;text-transform:uppercase;letter-spacing:.08em' }, 'Creating'),
      el('strong', {}, (preset && preset.name) || ((type && type.label) + ' agent') || 'Custom agent')
    ]),
    el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => { State.createDraft = { step: 2, agentType: draft.agentType, presetId: draft.presetId }; paintAgentWizard(); } }, 'Back to presets')
  ]));
  const form = buildAgentForm(null, {
    createMode: true,
    agentType: draft.agentType || (preset && preset.agentType) || 'custom',
    preset: preset,
    onCreated: () => {
      State.createDraft = { step: 1, agentType: '', presetId: null };
      paintAgentWizard();
      paintAgents();
    }
  });
  form.style.boxShadow = 'none';
  form.style.border = '0';
  form.style.background = 'transparent';
  form.style.padding = '0';
  host.appendChild(form);
}

function dids() {
  const t = State.telephony || {};
  const list = t.dids || (t.did ? [{ number: t.did }] : []);
  return list.map((d) => (typeof d === 'string' ? d : d.number || d.did)).filter(Boolean);
}
function refillDidOptions() {
  const sel = $('#f_did'); if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = '';
  sel.appendChild(el('option', { value: '' }, 'No number assigned'));
  dids().forEach((n) => sel.appendChild(el('option', { value: n }, n)));
  if (cur) sel.value = cur;
}

function buildAgentForm(existing, options) {
  const opts = options || {};
  const preset = opts.preset || null;
  const createMode = !!opts.createMode;
  const e = existing || {};
  const tts = e.tts || {};
  const card = el('div', { class: 'card builder' });
  const state = {
    model: tts.model || 'mulberry',
    speaker: tts.speaker || 'speaker_2',
    f0: tts.f0_up_key != null ? tts.f0_up_key : 0
  };

  const defaultName = e.name || (preset && preset.name) || '';
  const defaultPersona = e.persona || (preset
    ? (preset.name + '. Collect: ' + (preset.fields || []).join(', ') + '. Guardrails: ' + (preset.guardrails || []).join('; ') + '.')
    : '');
  const defaultGreeting = e.greeting || (preset && preset.greeting) || '';

  const nameI = el('input', { class: 'input', id: 'f_name', type: 'text', value: defaultName, placeholder: 'Front Desk', maxlength: 80 });
  const personaI = el('textarea', { class: 'textarea', id: 'f_persona', rows: 4, placeholder: 'You are a warm, sharp receptionist. Answer in 1 to 2 short spoken sentences, qualify the lead, and book a callback.' }, defaultPersona);
  const greetI = el('input', { class: 'input', id: 'f_greeting', type: 'text', value: defaultGreeting, placeholder: 'Hi, thanks for calling Astra AI. How can I help today.', maxlength: 240 });
  const descI = el('input', { class: 'input', id: 'f_desc', type: 'text', value: (tts.description || ''), placeholder: 'Optional voice direction, e.g. calm and confident' });

  const modelSeg = el('div', { class: 'seg', id: 'f_model_seg' }, VOICE_MODELS.map((m) =>
    el('button', { type: 'button', class: m === state.model ? 'on' : '', 'data-m': m, onclick: () => { state.model = m; syncVoice(); } }, m)
  ));
  const speakerSel = el('select', { class: 'select', id: 'f_speaker' }, SPEAKERS.map((s) =>
    el('option', { value: s, selected: s === state.speaker ? 'selected' : false }, s)
  ));
  const f0Val = el('span', { class: 'rv', id: 'f_f0_val' }, String(state.f0));
  const f0Range = el('input', { type: 'range', id: 'f_f0', min: -12, max: 12, step: 1, value: state.f0, oninput: (ev) => { state.f0 = +ev.target.value; f0Val.textContent = (state.f0 > 0 ? '+' : '') + state.f0; } });
  if (state.f0 > 0) f0Val.textContent = '+' + state.f0;

  const didSel = el('select', { class: 'select', id: 'f_did' }, [el('option', { value: '' }, 'No number assigned')]);
  if (e.telephony && e.telephony.did) { /* set after dids load */ setTimeout(() => { try { didSel.value = e.telephony.did; } catch (x) {} }, 0); }

  const speakerField = field('Speaker', speakerSel);
  const descField = field('Voice direction (mulberry)', descI);
  function syncVoice() {
    $$('#f_model_seg button').forEach((b) => b.classList.toggle('on', b.getAttribute('data-m') === state.model));
    const isMul = state.model === 'mulberry';
    speakerField.style.display = isMul ? '' : 'none';
    descField.style.display = isMul ? '' : 'none';
  }

  const submitBtn = el('button', { class: 'btn btn-primary' }, existing ? 'Save changes' : 'Create agent');
  const form = el('form', { onsubmit: onSave }, [
    el('div', { class: 'form-grid' }, [
      field('Agent name', nameI),
      field('Assigned number', didSel),
      (function () { const f = field('Persona', personaI); f.classList.add('full'); return f; })(),
      (function () { const f = field('Greeting', greetI); f.classList.add('full'); return f; })(),
      field('Voice model', modelSeg),
      field('Pitch, f0_up_key', el('div', { class: 'range-row' }, [f0Range, f0Val])),
      speakerField,
      descField
    ]),
    el('div', { class: 'flex gap-2', style: 'margin-top:18px;align-items:center' }, [submitBtn, existing ? el('button', { type: 'button', class: 'btn btn-ghost', onclick: () => modalClose() }, 'Cancel') : null])
  ]);

  if (!createMode) {
    card.appendChild(el('h3', {}, existing ? 'Edit agent' : 'New agent'));
    card.appendChild(el('p', { class: 'hint' }, existing ? 'Update the persona, voice, or assigned number.' : 'Describe the persona and pick a voice. You can preview it instantly before assigning a number.'));
  } else if (preset && (preset.direction === 'inbound' || preset.agentType === 'inbound_receptionist')) {
    card.appendChild(el('p', { class: 'hint' }, 'Starts from the inbound receptionist pattern. Bind an Astra workflow after create.'));
  } else if (preset && (preset.workflowKey || preset.dograhWorkflowKey)) {
    card.appendChild(el('p', { class: 'hint' }, 'Outbound callback pattern: permission, discovery, then reschedule.'));
  }
  card.appendChild(form);
  syncVoice();

  let _modalClose = null;
  function modalClose() { if (_modalClose) _modalClose(); }
  card._setModalClose = (fn) => { _modalClose = fn; };

  async function onSave(ev) {
    ev.preventDefault();
    const name = nameI.value.trim();
    const persona = personaI.value.trim();
    if (!name) { toast('Give the agent a name.', 'err'); nameI.focus(); return; }
    if (!persona) { toast('Add a persona so the agent knows how to behave.', 'err'); personaI.focus(); return; }
    submitBtn.disabled = true; submitBtn.textContent = existing ? 'Saving...' : 'Creating...';
    const payload = {
      name: name,
      persona: persona,
      greeting: greetI.value.trim(),
      did: didSel.value || '',
      tts: { model: state.model, speaker: state.speaker, f0_up_key: state.f0, description: descI.value.trim() }
    };
    if (createMode) {
      payload.agentType = opts.agentType || (preset && preset.agentType) || 'custom';
      if (preset) payload.presetId = preset.id;
    }
    try {
      if (existing) {
        payload.id = existing.id;
        const res = await api('/api/agents/update', { method: 'POST', body: payload });
        const idx = State.agents.findIndex((a) => a.id === existing.id);
        if (idx !== -1) State.agents[idx] = res.agent || Object.assign({}, existing, payload);
        toast('Agent updated.', 'ok');
        modalClose();
      } else {
        const res = await api('/api/agents', { method: 'POST', body: payload });
        if (res.agent) State.agents.push(res.agent);
        toast('Agent created.', 'ok');
        if (typeof opts.onCreated === 'function') opts.onCreated(res.agent);
        else {
          nameI.value = ''; personaI.value = ''; greetI.value = ''; descI.value = ''; didSel.value = '';
        }
      }
      paintAgents();
    } catch (ex) {
      toast(ex.message || 'Could not save agent.', 'err');
    } finally {
      submitBtn.disabled = false; submitBtn.textContent = existing ? 'Save changes' : 'Create agent';
    }
  }

  return card;
}

function paintAgents() {
  const grid = $('#agentsGrid'); if (!grid) return;
  refillDidOptions();
  grid.innerHTML = '';
  if (!State.agents.length) {
    grid.appendChild(el('div', { class: 'empty' }, [
      el('div', { class: 'ttl' }, 'No agents yet'),
      el('div', {}, 'Use the builder above to create your first voice agent.')
    ]));
    return;
  }
  State.agents.forEach((a) => grid.appendChild(agentCard(a)));
}

function agentCard(a) {
  const tts = a.tts || {};
  const voiceLine = (tts.model || 'mulberry') + ' / ' + (tts.speaker || 'speaker') + (tts.f0_up_key ? ' / pitch ' + (tts.f0_up_key > 0 ? '+' : '') + tts.f0_up_key : '');
  const did = a.telephony && a.telephony.did ? a.telephony.did : null;
  const type = agentTypeMeta(a.agentType);

  const previewBtn = el('button', { class: 'btn btn-ghost btn-sm' }, 'Preview voice');
  previewBtn.addEventListener('click', () => previewAgentVoice(a, previewBtn));

  // textContent everywhere = XSS safe for persona/name
  return el('div', { class: 'card card-glow agent-card' }, [
    el('div', { class: 'ac-top' }, [
      el('div', { class: 'ac-av' }, initials(a.name)),
      el('div', { style: 'min-width:0' }, [
        el('div', { class: 'ac-name' }, a.name),
        el('div', { class: 'ac-voice' }, voiceLine)
      ])
    ]),
    el('div', { class: 'ac-persona' }, a.persona || 'No persona set.'),
    el('div', { class: 'ac-meta' }, [
      el('span', { class: 'tag' }, (type && type.label) || a.agentType || 'custom'),
      a.direction ? el('span', { class: 'tag' }, directionLabel(a.direction)) : null,
      did ? el('span', { class: 'tag' }, did) : el('span', { class: 'tag' }, 'no number'),
      el('span', { class: 'tag' }, (tts.model || 'mulberry'))
    ]),
    el('div', { class: 'ac-actions' }, [
      previewBtn,
      el('button', { class: 'btn btn-ghost btn-sm', onclick: () => openEditAgent(a) }, 'Edit'),
      el('button', { class: 'btn btn-ghost btn-sm', onclick: () => confirmDeleteAgent(a) }, 'Delete')
    ])
  ]);
}

async function previewAgentVoice(a, btn) {
  const tts = a.tts || {};
  const text = (a.greeting && a.greeting.trim()) || ('Hi, this is ' + (a.name || 'your agent') + '. How can I help today.');
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = 'Synthesizing...';
  try {
    const body = { text: text, model: tts.model || 'mulberry', speaker: tts.speaker, f0_up_key: tts.f0_up_key, description: tts.description };
    const res = await api('/api/tts', { method: 'POST', body: body });
    const buf = await res.arrayBuffer();
    const url = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
    const audio = new Audio(url);
    audio.onended = () => URL.revokeObjectURL(url);
    await audio.play();
    btn.textContent = 'Playing...';
    audio.onended = () => { btn.textContent = old; btn.disabled = false; URL.revokeObjectURL(url); };
  } catch (ex) {
    toast(ex.message || 'Voice preview failed.', 'err');
    btn.textContent = old; btn.disabled = false;
  }
}

function openEditAgent(a) {
  const form = buildAgentForm(a);
  form.style.boxShadow = 'none'; form.style.border = '0'; form.style.background = 'transparent'; form.style.padding = '0';
  const host = $('#modal-host');
  const close = () => { host.classList.add('hide'); host.setAttribute('aria-hidden', 'true'); host.innerHTML = ''; };
  form._setModalClose(() => { close(); paintAgents(); });
  const card = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', style: 'max-width:600px' }, [form]);
  host.innerHTML = '';
  host.appendChild(el('div', { onclick: (ev) => { if (ev.target === ev.currentTarget) close(); }, style: 'position:absolute;inset:0' }));
  host.appendChild(card);
  host.classList.remove('hide');
  host.setAttribute('aria-hidden', 'false');
  setTimeout(refillDidOptions, 0);
}

function confirmDeleteAgent(a) {
  modal({
    title: 'Delete agent',
    body: el('p', {}, ['Delete ', el('b', {}, a.name), '. This cannot be undone.']),
    confirmText: 'Delete agent', confirmKind: 'danger',
    onConfirm: async () => {
      await api('/api/agents/delete', { method: 'POST', body: { id: a.id } });
      State.agents = State.agents.filter((x) => x.id !== a.id);
      paintAgents();
      toast('Agent deleted.', 'ok');
    }
  });
}

/* helper used by builder */
function field(label, input) { return el('div', { class: 'field' }, [el('label', {}, label), input]); }

/* ===========================================================================
   3. VOICE STUDIO
   =========================================================================== */
function viewStudio(root) {
  root.appendChild(viewHead('Voice Studio', 'Type anything, pick a model, and synthesize. See the waveform, hear it back, and watch the cost in real time.'));

  const st = { model: 'mulberry', tone: 'neutral', speaker: 'speaker_2', f0: 0, stream: false };

  const textArea = el('textarea', { class: 'textarea studio-text', id: 's_text', placeholder: 'Welcome to Astra AI. Production-grade AI voice starts from ₹1 per minute for the AI layer.' }, 'Welcome to Astra AI. Production-grade AI voice starts from ₹1 per minute for the AI layer.');

  // model picker
  const modelSeg = el('div', { class: 'seg' }, VOICE_MODELS.map((m) =>
    el('button', { type: 'button', class: m === st.model ? 'on' : '', 'data-m': m, onclick: () => { st.model = m; syncCtl(); updateCost(); } }, m)
  ));
  // muga tones
  const toneSeg = el('div', { class: 'seg', id: 's_tones' }, MUGA_TONES.map((tn) =>
    el('button', { type: 'button', class: tn === st.tone ? 'on' : '', 'data-t': tn, onclick: () => { st.tone = tn; $$('#s_tones button').forEach((b) => b.classList.toggle('on', b.getAttribute('data-t') === tn)); } }, tn)
  ));
  // mulberry controls
  const speakerSel = el('select', { class: 'select' }, SPEAKERS.map((s) => el('option', { value: s, selected: s === st.speaker ? 'selected' : false }, s)));
  speakerSel.addEventListener('change', () => { st.speaker = speakerSel.value; });
  const f0Val = el('span', { class: 'rv' }, '0');
  const f0Range = el('input', { type: 'range', min: -12, max: 12, step: 1, value: 0, oninput: (ev) => { st.f0 = +ev.target.value; f0Val.textContent = (st.f0 > 0 ? '+' : '') + st.f0; } });
  const descI = el('input', { class: 'input', placeholder: 'Optional voice direction, e.g. warm and reassuring' });
  descI.addEventListener('input', () => { st.desc = descI.value; });

  const mugaCtl = field('Tone (muga)', toneSeg);
  const mulSpeaker = field('Speaker (mulberry)', speakerSel);
  const mulPitch = field('Pitch, f0_up_key', el('div', { class: 'range-row' }, [f0Range, f0Val]));
  const mulDesc = field('Voice direction (mulberry)', descI);
  function syncCtl() {
    $$('.seg button[data-m]').forEach((b) => b.classList.toggle('on', b.getAttribute('data-m') === st.model));
    const isMul = st.model === 'mulberry';
    mugaCtl.style.display = isMul ? 'none' : '';
    [mulSpeaker, mulPitch, mulDesc].forEach((f) => f.style.display = isMul ? '' : 'none');
  }

  const charsEl = el('span', { class: 'c-chars', id: 's_chars' }, '0 chars');
  const costEl = el('span', { class: 'c-cost', id: 's_cost' }, [document.createTextNode('about '), el('b', {}, '₹0.00')]);
  function updateCost() {
    const len = (textArea.value || '').length;
    const capped = Math.min(len, 2000);
    const cost = capped / 1000 * (RATE[st.model] || RATE.mulberry);
    charsEl.textContent = len + ' chars' + (len > 2000 ? ' (capped at 2000)' : '');
    costEl.innerHTML = '';
    costEl.appendChild(document.createTextNode('about '));
    costEl.appendChild(el('b', {}, '₹' + cost.toFixed(2)));
  }
  textArea.addEventListener('input', updateCost);

  const streamToggle = el('label', { class: 'streamtoggle' }, [
    el('input', { type: 'checkbox', onchange: (ev) => { st.stream = ev.target.checked; } }),
    document.createTextNode('Stream progressively (low latency)')
  ]);

  const synthBtn = el('button', { class: 'btn btn-primary' }, 'Synthesize');
  const audioEl = el('audio', { controls: 'controls', preload: 'none' });
  const waveCanvas = el('canvas', { class: 'wave-canvas', id: 's_wave' });
  const playerRow = el('div', { class: 'player-row', style: 'display:none' }, [audioEl]);

  synthBtn.addEventListener('click', () => doSynthesize(st, textArea, synthBtn, audioEl, waveCanvas, playerRow));

  const main = el('div', { class: 'card studio-main' }, [
    field('Text to speak', textArea),
    el('div', { class: 'wave-wrap' }, [waveCanvas, playerRow]),
    el('div', { class: 'flex items-center gap-2', style: 'flex-wrap:wrap' }, [synthBtn, streamToggle])
  ]);

  const side = el('div', { class: 'studio-side' }, [
    el('div', { class: 'card card-pad' }, [
      el('h3', { class: 't-h3', style: 'margin-bottom:14px' }, 'Voice'),
      field('Model', modelSeg),
      mugaCtl, mulSpeaker, mulPitch, mulDesc
    ]),
    el('div', { class: 'card card-pad' }, [
      el('h3', { class: 't-h3', style: 'margin-bottom:14px' }, 'Economics'),
      el('div', { class: 'cost-readout' }, [charsEl, costEl]),
      el('p', { class: 'muted', style: 'font-size:.8rem;margin-top:10px' }, 'Mulberry promo is about Rs 0.50 per 1000 chars, roughly 20x cheaper than ElevenLabs.')
    ])
  ]);

  root.appendChild(el('div', { class: 'studio-grid' }, [main, side]));
  syncCtl(); updateCost();
  // size the canvas after layout
  setTimeout(() => sizeCanvas(waveCanvas), 30);
  window.addEventListener('resize', () => sizeCanvas(waveCanvas), { once: true });
}

async function doSynthesize(st, textArea, btn, audioEl, canvas, playerRow) {
  const raw = (textArea.value || '').trim();
  if (!raw) { toast('Type something to synthesize.', 'err'); textArea.focus(); return; }
  let text = raw.slice(0, 2000);
  // muga tone is applied as a [tone] prefix
  if (st.model === 'muga' && st.tone && st.tone !== 'neutral') text = '[' + st.tone + '] ' + text;

  const old = btn.textContent; btn.disabled = true; btn.textContent = 'Synthesizing...';

  if (st.stream) {
    try {
      await streamSynthesize(text, st, canvas, btn);
      btn.disabled = false; btn.textContent = old;
      refreshUsageSoft();
      return;
    } catch (ex) {
      toast('Stream failed, falling back to file. ' + (ex.message || ''), 'info');
      // fall through to normal synth
    }
  }

  try {
    const body = { text: text, model: st.model };
    if (st.model === 'mulberry') { body.speaker = st.speaker; body.f0_up_key = st.f0; if (st.desc) body.description = st.desc; }
    const res = await api('/api/tts', { method: 'POST', body: body });
    const chars = res.headers.get('X-Chars');
    const credits = res.headers.get('X-Credits-Used');
    const buf = await res.arrayBuffer();
    const blob = new Blob([buf], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);
    audioEl.src = url; playerRow.style.display = '';
    drawWaveformFromBuffer(buf.slice(0), canvas);
    audioEl.play().catch(() => {});
    toast('Synthesized ' + (chars || text.length) + ' chars' + (credits ? ', ' + credits + ' credits.' : '.'), 'ok');
    refreshUsageSoft();
  } catch (ex) {
    toast(ex.message || 'Synthesis failed.', 'err');
  } finally {
    btn.disabled = false; btn.textContent = old;
  }
}

function refreshUsageSoft() {
  // invalidate cached usage so Overview reflects new chars next visit
  State.loaded.usage = false; State.usage = null;
}

/* ---- waveform rendering ---- */
function sizeCanvas(canvas) {
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 560, h = canvas.clientHeight || 90;
  canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // idle baseline
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(110,123,255,0.25)'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();
}
function drawWaveformFromBuffer(arrbuf, canvas) {
  try {
    const samples = decodeWavPcm(arrbuf);
    if (!samples) { sizeCanvas(canvas); return; }
    drawWaveform(samples, canvas);
  } catch (e) { sizeCanvas(canvas); }
}
function decodeWavPcm(arrbuf) {
  const dv = new DataView(arrbuf);
  if (dv.byteLength < 44) return null;
  // verify RIFF/WAVE
  if (dv.getUint32(0, false) !== 0x52494646) return null; // 'RIFF'
  // walk chunks to find fmt + data
  let off = 12, fmt = null, dataOff = -1, dataLen = 0;
  while (off + 8 <= dv.byteLength) {
    const id = dv.getUint32(off, false);
    const sz = dv.getUint32(off + 4, true);
    if (id === 0x666d7420) { // 'fmt '
      fmt = { format: dv.getUint16(off + 8, true), channels: dv.getUint16(off + 10, true), bits: dv.getUint16(off + 22, true) };
    } else if (id === 0x64617461) { // 'data'
      dataOff = off + 8; dataLen = sz; break;
    }
    off += 8 + sz + (sz & 1);
  }
  if (!fmt || dataOff < 0 || fmt.bits !== 16) return null;
  const n = Math.floor(dataLen / 2);
  const ch = fmt.channels || 1;
  const out = new Float32Array(Math.floor(n / ch));
  let j = 0;
  for (let i = 0; i + ch <= n; i += ch) {
    const s = dv.getInt16(dataOff + i * 2, true);
    out[j++] = s / 32768;
  }
  return out;
}
function drawWaveform(samples, canvas) {
  sizeCanvas(canvas);
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.width / dpr, h = canvas.height / dpr;
  ctx.clearRect(0, 0, w, h);
  const bars = Math.max(40, Math.min(180, Math.floor(w / 4)));
  const block = Math.floor(samples.length / bars) || 1;
  const grad = ctx.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, '#6B21A8'); grad.addColorStop(0.55, '#7C3AED'); grad.addColorStop(1, '#06B6D4');
  ctx.fillStyle = grad;
  const bw = w / bars;
  for (let b = 0; b < bars; b++) {
    let peak = 0;
    for (let k = 0; k < block; k++) { const v = Math.abs(samples[b * block + k] || 0); if (v > peak) peak = v; }
    const bh = Math.max(2, peak * (h * 0.92));
    const x = b * bw, y = (h - bh) / 2;
    const r = Math.min(bw * 0.34, 2);
    roundRect(ctx, x + bw * 0.18, y, bw * 0.64, bh, r);
  }
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath(); ctx.fill();
}

/* ---- streaming TTS (PCM int16 LE 24kHz) via /api/ws-connect then wss Rumik ---- */
async function streamSynthesize(text, st, canvas, btn) {
  const mint = await api('/api/ws-connect', { method: 'POST', body: { text: text, model: st.model } });
  if (!mint.ws_url) throw new ApiError(0, 'No ws_url returned.');
  return new Promise((resolve, reject) => {
    let ws, audioCtx, nextTime = 0, started = false, chunks = [];
    const SR = 24000;
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SR }); } catch (e) { return reject(new ApiError(0, 'No Web Audio.')); }
    const url = mint.ws_url + (mint.token && mint.ws_url.indexOf('token=') === -1 ? (mint.ws_url.indexOf('?') === -1 ? '?' : '&') + 'token=' + encodeURIComponent(mint.token) : '');
    try { ws = new WebSocket(url); } catch (e) { return reject(new ApiError(0, 'WebSocket failed.')); }
    ws.binaryType = 'arraybuffer';
    const fail = (m) => { try { ws.close(); } catch (e) {} reject(new ApiError(0, m)); };
    const timeout = setTimeout(() => fail('Stream timed out.'), 20000);
    ws.onopen = () => { try { ws.send(JSON.stringify({ text: text, model: st.model })); } catch (e) {} };
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        try { const m = JSON.parse(ev.data); if (m.type === 'end' || m.done) { clearTimeout(timeout); finish(); } } catch (e) {}
        return;
      }
      const pcm = new Int16Array(ev.data);
      if (!pcm.length) return;
      chunks.push(pcm);
      const f32 = new Float32Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) f32[i] = pcm[i] / 32768;
      const ab = audioCtx.createBuffer(1, f32.length, SR);
      ab.copyToChannel(f32, 0);
      const src = audioCtx.createBufferSource(); src.buffer = ab; src.connect(audioCtx.destination);
      const now = audioCtx.currentTime;
      if (nextTime < now) nextTime = now + 0.04;
      src.start(nextTime); nextTime += ab.duration;
      started = true;
    };
    ws.onclose = () => { clearTimeout(timeout); if (started) finish(); else fail('Stream closed early.'); };
    ws.onerror = () => { clearTimeout(timeout); fail('Stream connection error.'); };
    function finish() {
      // draw the gathered waveform once
      if (chunks.length) {
        let total = 0; chunks.forEach((c) => total += c.length);
        const all = new Float32Array(total); let o = 0;
        chunks.forEach((c) => { for (let i = 0; i < c.length; i++) all[o++] = c[i] / 32768; });
        try { drawWaveform(all, canvas); } catch (e) {}
      }
      try { ws.close(); } catch (e) {}
      resolve();
    }
  });
}

/* ===========================================================================
   4. DEMO LINKS
   =========================================================================== */
async function viewDemoLinks(root) {
  root.appendChild(viewHead('Demo links', 'Create a tenant-branded web voice experience for one agent, then share it without exposing Studio access or provider secrets.'));
  const grid = el('div', { class: 'demo-admin-grid' }, [
    el('div', { class: 'card demo-create-card', id: 'demoCreateHost' }),
    el('div', { class: 'card demo-list-card', id: 'demoListHost' })
  ]);
  root.appendChild(grid);

  const createHost = $('#demoCreateHost', root);
  const listHost = $('#demoListHost', root);
  createHost.appendChild(skeleton('sk-card', 1));
  listHost.appendChild(skeleton('sk-card', 1));

  try {
    await ensureAgents();
    const payload = await api('/api/demo-links');
    State.demoLinks = payload.demoLinks || [];
    State.loaded.demoLinks = true;
  } catch (error) {
    createHost.innerHTML = '';
    listHost.innerHTML = '';
    listHost.appendChild(el('div', { class: 'demo-error', role: 'alert' }, error.message || 'Demo links could not be loaded.'));
    return;
  }

  function ephemeralUrl(id) {
    try { return sessionStorage.getItem('rxv_demo_' + id) || ''; } catch (_) { return ''; }
  }
  function rememberUrl(id, url) {
    try { sessionStorage.setItem('rxv_demo_' + id, url); } catch (_) {}
  }
  async function copyUrl(url) {
    if (!url) return;
    try { await navigator.clipboard.writeText(url); toast('Demo link copied.', 'ok'); }
    catch (_) {
      const input = el('textarea', { style: 'position:fixed;opacity:0;pointer-events:none' }, url);
      document.body.appendChild(input); input.select(); document.execCommand('copy'); input.remove();
      toast('Demo link copied.', 'ok');
    }
  }
  function openUrl(url) {
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
  }
  function redraw() {
    root.innerHTML = '';
    viewDemoLinks(root);
  }

  createHost.innerHTML = '';
  createHost.appendChild(el('div', { class: 'demo-card-head' }, [
    el('div', {}, [el('h3', { class: 't-h3' }, 'Create a share link'), el('p', { class: 'muted' }, 'The full URL is shown once. Only its SHA-256 hash is stored on the server.')])
  ]));
  if (!State.agents.length) {
    createHost.appendChild(el('div', { class: 'empty' }, [
      el('div', { class: 'ttl' }, 'Create an agent first'),
      el('p', {}, 'A demo link must be scoped to one tenant-owned agent.'),
      el('button', { class: 'btn btn-primary', onclick: () => goto('agents') }, 'Open agents')
    ]));
  } else {
    const agent = el('select', { class: 'select', id: 'demoAgent' }, State.agents.map((item) => el('option', { value: item.id }, item.name)));
    const label = el('input', { class: 'input', id: 'demoLabel', maxlength: '80', placeholder: 'Prospect demo' });
    const expiry = el('select', { class: 'select', id: 'demoExpiry' }, [1, 3, 7, 14, 30].map((days) => el('option', { value: days, selected: days === 7 ? 'selected' : false }, days + (days === 1 ? ' day' : ' days'))));
    const duration = el('select', { class: 'select', id: 'demoDuration' }, [60, 180, 300, 600].map((seconds) => el('option', { value: seconds, selected: seconds === 300 ? 'selected' : false }, Math.round(seconds / 60) + (seconds === 60 ? ' minute' : ' minutes'))));
    const starts = el('input', { class: 'input', id: 'demoStarts', type: 'number', min: '1', max: '1000', value: '25', inputmode: 'numeric' });
    const submit = el('button', { class: 'btn btn-primary btn-lg', type: 'submit' }, 'Create demo link');
    const form = el('form', { class: 'demo-create-form' }, [
      el('div', { class: 'field full' }, [el('label', {}, 'Agent'), agent]),
      el('div', { class: 'field full' }, [el('label', {}, 'Internal label'), label]),
      el('div', { class: 'field' }, [el('label', {}, 'Expires after'), expiry]),
      el('div', { class: 'field' }, [el('label', {}, 'Call duration'), duration]),
      el('div', { class: 'field full' }, [el('label', {}, 'Maximum starts'), starts]),
      submit
    ]);
    form.addEventListener('submit', async (event) => {
      event.preventDefault(); submit.disabled = true; submit.textContent = 'Creating...';
      try {
        const result = await api('/api/demo-links', { method: 'POST', body: {
          agentId: agent.value, label: label.value.trim(), expiresInDays: Number(expiry.value),
          maxSessionSeconds: Number(duration.value), maxStarts: Number(starts.value)
        } });
        const fullUrl = location.origin + result.sharePath;
        rememberUrl(result.demoLink.id, fullUrl);
        State.demoLinks.unshift(result.demoLink);
        await copyUrl(fullUrl);
        toast('Created and copied. Open it in a separate tab to test.', 'ok', 'Demo ready');
        redraw();
      } catch (error) {
        toast(error.message || 'Demo link could not be created.', 'err');
        submit.disabled = false; submit.textContent = 'Create demo link';
      }
    });
    createHost.appendChild(form);
  }

  listHost.innerHTML = '';
  listHost.appendChild(el('div', { class: 'demo-card-head' }, [
    el('div', {}, [el('h3', { class: 't-h3' }, 'Distributed demos'), el('p', { class: 'muted' }, 'Revoke access immediately or create a replacement when a one-time URL is no longer available.')]),
    el('span', { class: 'tag' }, State.demoLinks.length + ' total')
  ]));
  if (!State.demoLinks.length) {
    listHost.appendChild(el('div', { class: 'empty' }, [el('div', { class: 'ttl' }, 'No demo links yet'), el('p', {}, 'Create one to share a branded web voice experience.') ]));
  } else {
    const agentNames = Object.fromEntries(State.agents.map((item) => [item.id, item.name]));
    const list = el('div', { class: 'demo-link-list' });
    State.demoLinks.forEach((item) => {
      const url = ephemeralUrl(item.id);
      const status = item.status || 'active';
      const card = el('article', { class: 'demo-link-row' }, [
        el('div', { class: 'demo-link-main' }, [
          el('div', { class: 'demo-link-title' }, [el('strong', {}, item.label), el('span', { class: 'demo-status ' + status }, status)]),
          el('div', { class: 'demo-link-meta' }, [
            el('span', {}, agentNames[item.agentId] || 'Agent'),
            el('span', {}, item.starts + ' of ' + item.maxStarts + ' starts'),
            el('span', {}, 'Expires ' + new Date(item.expiresAt).toLocaleDateString())
          ]),
          !url && status === 'active' ? el('p', { class: 'demo-once-note' }, 'The secret URL is not recoverable after this browser session. Revoke and replace it if needed.') : null
        ]),
        el('div', { class: 'demo-link-actions' }, [
          el('button', { class: 'btn btn-ghost', disabled: !url ? 'disabled' : false, onclick: () => openUrl(url) }, 'Open'),
          el('button', { class: 'btn btn-ghost', disabled: !url ? 'disabled' : false, onclick: () => copyUrl(url) }, 'Copy'),
          status === 'active' ? el('button', { class: 'btn btn-danger-soft', onclick: () => modal({
            title: 'Revoke this demo link?',
            body: el('p', { class: 'muted' }, 'Visitors will no longer be able to start a voice session with this URL.'),
            confirmText: 'Revoke link', confirmKind: 'danger',
            onConfirm: async () => { await api('/api/demo-links/revoke', { method: 'POST', body: { id: item.id } }); try { sessionStorage.removeItem('rxv_demo_' + item.id); } catch (_) {} toast('Demo link revoked.', 'ok'); redraw(); }
          }) }, 'Revoke') : null
        ])
      ]);
      list.appendChild(card);
    });
    listHost.appendChild(list);
  }
}

/* ===========================================================================
   5. TALK TO IT
   =========================================================================== */
async function viewTalk(root) {
  root.appendChild(viewHead('Talk to your agent', 'A direct realtime voice call through the same published Astra workflow runtime used on the phone.'));

  await ensureAgents().catch(() => {});
  if (!State.activeAgentId && State.agents.length) State.activeAgentId = State.agents[0].id;

  const transcript = el('div', { class: 'voice-call-stage', id: 't_voice_call', 'aria-live': 'polite' }, [
    el('div', { class: 'voice-orb', 'aria-hidden': 'true' }, [el('span'), el('span'), el('span'), el('span'), el('span')]),
    el('div', { class: 'voice-call-stage-title' }, 'Ready for a live voice call'),
    el('div', { class: 'voice-call-stage-copy' }, 'Start once. Speak naturally, interrupt the agent, and continue without pressing send.')
  ]);
  const agentSel = el('select', { class: 'select' + (State.agents.length ? '' : ' is-empty') }, State.agents.length
    ? State.agents.map((a) => el('option', { value: a.id, selected: a.id === State.activeAgentId ? 'selected' : false }, a.name))
    : [el('option', { value: '' }, 'No agents yet')]);
  agentSel.addEventListener('change', () => { State.activeAgentId = agentSel.value; });

  const statusDot = el('span', { class: 'conversation-dot', 'aria-hidden': 'true' });
  const statusText = el('span', {}, 'Ready');
  const statusPill = el('div', { class: 'conversation-status idle', role: 'status' }, [statusDot, statusText]);
  const runtimePill = el('div', { class: 'conversation-pipeline' }, 'Realtime voice · Deepgram · Groq · Rumik');
  const timingText = el('div', { class: 'conversation-timing', 'aria-live': 'polite' }, 'Latency is measured inside the live call runtime');
  const sessionBtn = el('button', { class: 'btn btn-primary conversation-btn', 'aria-label': 'Start voice call' }, [
    el('span', { class: 'conversation-btn-icon', 'aria-hidden': 'true', html: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.9v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.12.9.33 1.78.62 2.63a2 2 0 0 1-.45 2.11L8 9.73a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.85.29 1.73.5 2.63.62A2 2 0 0 1 22 16.9z"/></svg>' }),
    el('span', { class: 'conversation-btn-label' }, 'Start voice call')
  ]);
  const audio = el('audio', { autoplay: 'autoplay', playsinline: 'playsinline' });

  let pc = null;
  let ws = null;
  let stream = null;
  let running = false;
  let peerId = '';
  let callStarted = 0;

  function setStatus(phase, label) {
    statusPill.className = 'conversation-status ' + phase;
    statusText.textContent = label;
  }
  function setButton(active) {
    running = active;
    $('.conversation-btn-label', sessionBtn).textContent = active ? 'End voice call' : 'Start voice call';
    sessionBtn.classList.toggle('active', active);
    sessionBtn.setAttribute('aria-label', active ? 'End voice call' : 'Start voice call');
    agentSel.disabled = active;
  }
  function appendBubble(role, text, live) {
    $('.voice-call-stage-title', transcript).textContent = String(text || 'Voice call status');
    return transcript;
  }
  function stopCall(message) {
    setButton(false);
    if (ws && ws.readyState < 2) { try { ws.close(); } catch (_) {} }
    ws = null;
    if (pc) { try { pc.getSenders().forEach((s) => s.track && s.track.stop()); pc.close(); } catch (_) {} }
    pc = null;
    if (stream) stream.getTracks().forEach((track) => track.stop());
    stream = null;
    audio.srcObject = null;
    setStatus('idle', message || 'Ready');
    timingText.textContent = callStarted ? 'Call ended after ' + Math.max(1, Math.round((Date.now() - callStarted) / 1000)) + 's' : 'Latency is measured inside the live call runtime';
    callStarted = 0;
  }
  function securePeerId() {
    const bytes = new Uint8Array(16); crypto.getRandomValues(bytes);
    return 'PC-' + Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  async function fetchTurn(url) {
    try {
      const response = await fetch(url, { credentials: 'include' });
      return response.ok ? await response.json() : null;
    } catch (_) { return null; }
  }
  async function handleSignal(message) {
    if (!pc) return;
    if (message.type === 'answer') {
      await pc.setRemoteDescription({ type: 'answer', sdp: message.payload.sdp });
      return;
    }
    if (message.type === 'ice-candidate') {
      const c = message.payload && message.payload.candidate;
      if (c) await pc.addIceCandidate(c).catch(() => {});
      return;
    }
    if (message.type === 'call-ended') return stopCall('Call ended');
    if (message.type === 'error' || message.type === 'rtf-pipeline-error') {
      const detail = (message.payload && (message.payload.message || message.payload.error)) || 'Realtime voice call failed';
      appendBubble('bot', detail, false);
      setStatus('error', 'Call error');
      return;
    }
    if (message.type === 'rtf-user-transcription') {
      const p = message.payload || {};
      if (p.text) setStatus('thinking', p.final ? 'Agent thinking' : 'Listening');
      return;
    }
    if (message.type === 'rtf-bot-text') {
      return;
    }
    if (message.type === 'rtf-bot-started-speaking') setStatus('speaking', 'Agent speaking');
    if (message.type === 'rtf-bot-stopped-speaking') setStatus('listening', 'Listening');
    if (message.type === 'rtf-ttfb-metric') {
      const p = message.payload || {};
      timingText.textContent = (Number(p.ttfb_seconds || 0) * 1000).toFixed(0) + 'ms first response · ' + String(p.processor || p.model || 'live runtime');
    }
  }
  async function startCall() {
    if (running || !State.activeAgentId) return;
    setButton(true); setStatus('connecting', 'Connecting realtime call');
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      const session = await api('/api/voice/session', { method: 'POST', timeoutMs: 15000, body: { agentId: State.activeAgentId } });
      // Prefer the same-origin session response. A direct credentialed fetch to
      // Dograh can reject browsers when its CORS response uses `*`.
      // Prefer same-origin proxy when available.
      const turn = session.turnCredentials || await fetchTurn(session.turnCredentialsUrl);
      const iceServers = [{ urls: ['stun:stun.l.google.com:19302'] }];
      if (turn && turn.uris && turn.uris.length) {
        iceServers.push({ urls: turn.uris, username: turn.username, credential: turn.password });
      }
      pc = new RTCPeerConnection({ iceServers, iceTransportPolicy: turn ? 'relay' : 'all' });
      window.__rumikPc = pc;
      stream.getTracks().forEach((track) => pc.addTrack(track, stream));
      pc.ontrack = (event) => { if (event.track.kind === 'audio') { audio.srcObject = event.streams[0]; audio.play().catch(() => {}); } };
      pc.onconnectionstatechange = () => {
        if (!pc) return;
        console.log('Rumik WebRTC state', pc.connectionState, pc.iceConnectionState);
        timingText.textContent = 'WebRTC ' + pc.connectionState + ' · ICE ' + pc.iceConnectionState;
        if (pc.connectionState === 'connected') { callStarted = Date.now(); setStatus('listening', 'Live call connected'); }
        if (pc.connectionState === 'failed') { setStatus('error', 'Connection failed'); stopCall('Connection failed'); }
      };
      peerId = securePeerId();
      ws = new WebSocket(session.signalingUrl);
      ws.onmessage = async (event) => {
        try { await handleSignal(JSON.parse(event.data)); }
        catch (error) { setStatus('error', 'Signaling error'); toast(error.message || 'Realtime signaling failed.', 'err'); }
      };
      ws.onclose = (event) => { if (running && event.reason !== 'call ended') stopCall('Call ended'); };
      await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('Realtime signaling connection failed')); });
      pc.onicecandidate = (event) => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        console.log('Rumik WebRTC candidate', event.candidate ? event.candidate.type : 'complete');
        if (event.candidate) timingText.textContent = 'ICE candidate: ' + event.candidate.type + ' · ' + event.candidate.protocol;
        ws.send(JSON.stringify({ type: 'ice-candidate', payload: { candidate: event.candidate ? { candidate: event.candidate.candidate, sdpMid: event.candidate.sdpMid, sdpMLineIndex: event.candidate.sdpMLineIndex } : null, pc_id: peerId } }));
      };
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      ws.send(JSON.stringify({ type: 'offer', payload: { sdp: offer.sdp, type: 'offer', pc_id: peerId, workflow_id: session.workflowId, workflow_run_id: session.workflowRunId } }));
    } catch (error) {
      stopCall('Could not connect');
      setStatus('error', 'Needs attention');
      appendBubble('bot', error.message || 'Could not start the realtime voice call.', false);
      toast(error.message || 'Realtime voice call failed.', 'err');
    }
  }

  sessionBtn.addEventListener('click', () => running ? stopCall('Ready') : startCall());

  const panel = el('div', { class: 'card talk-panel' }, [
    el('div', { class: 'talk-head' }, [
      el('div', { class: 'talk-identity' }, [el('div', { class: 'who' }, ['Phone-runtime conversation ', el('span', {}, '(automatic turn-taking)')]), statusPill, runtimePill, timingText]),
      el('div', { class: 'talk-agent-select' }, [el('span', {}, 'Agent'), agentSel])
    ]),
    transcript,
    el('div', { class: 'talk-input' }, [sessionBtn, audio])
  ]);
  const info = el('div', { class: 'talk-side' }, [el('div', { class: 'card card-pad' }, [
    el('h3', { class: 't-h3' }, 'The actual phone runtime'),
    el('p', { class: 'muted' }, 'Your microphone is connected over WebRTC. The published Astra workflow runs the same Deepgram, Groq and Rumik pipeline used for phone calls.'),
    el('hr', { class: 'divider' }),
    el('p', { class: 'muted' }, 'Turn detection, interruption, agent speech and latency now happen inside the call engine. Transcript text is a live diagnostic view, not the mechanism driving the page.'),
    el('p', { class: 'muted' }, 'Use End voice call to release the microphone and close the peer connection.')
  ])]);
  root.appendChild(el('div', { class: 'talk-grid' }, [panel, info]));
}

async function viewTalkLegacy(root) {
  root.appendChild(viewHead('Talk to it', 'A live loop. Speak or type, the agent thinks with the brain, then answers in its own voice.'));

  await ensureAgents().catch(() => {});
  if (!State.activeAgentId && State.agents.length) State.activeAgentId = State.agents[0].id;

  const convo = []; // { role:'user'|'bot', text }
  const transcript = el('div', { class: 'transcript', id: 't_transcript', 'aria-live': 'polite' }, [
    el('div', { class: 'bubble sys' }, State.agents.length ? 'Start a conversation. The agent will greet you, listen automatically and keep the call going.' : 'Create an agent first, then come back to talk to it.')
  ]);

  const agentSel = el('select', { class: 'select' + (State.agents.length ? '' : ' is-empty') }, State.agents.length
    ? State.agents.map((a) => el('option', { value: a.id, selected: a.id === State.activeAgentId ? 'selected' : false }, a.name))
    : [el('option', { value: '' }, 'No agents yet')]);
  agentSel.addEventListener('change', () => { State.activeAgentId = agentSel.value; });

  const textIn = el('input', { class: 'input', placeholder: State.agents.length ? 'Type a message...' : 'Create an agent to begin', disabled: State.agents.length ? false : 'disabled' });
  const sendBtn = el('button', { class: 'btn btn-primary' }, 'Send');
  const sessionBtn = el('button', { class: 'btn btn-primary conversation-btn', 'aria-label': 'Start conversation' }, [
    el('span', { class: 'conversation-btn-icon', 'aria-hidden': 'true', html: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.9v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.12.9.33 1.78.62 2.63a2 2 0 0 1-.45 2.11L8 9.73a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.85.29 1.73.5 2.63.62A2 2 0 0 1 22 16.9z"/></svg>' }),
    el('span', { class: 'conversation-btn-label' }, 'Start conversation')
  ]);
  const statusDot = el('span', { class: 'conversation-dot', 'aria-hidden': 'true' });
  const statusText = el('span', {}, 'Ready');
  const statusPill = el('div', { class: 'conversation-status idle', role: 'status' }, [statusDot, statusText]);
  const pipelinePill = el('div', { class: 'conversation-pipeline' }, 'Deepgram Nova-3 → Groq Llama 3.3 70B → Rumik Mulberry');
  const timingText = el('div', { class: 'conversation-timing', 'aria-live': 'polite' }, 'Latency appears after the first turn');

  function getActiveAgent() { return State.agents.find((a) => a.id === State.activeAgentId) || State.agents[0]; }

  function addBubble(role, text) {
    if ($('.bubble.sys', transcript)) { const s = $('.bubble.sys', transcript); if (convo.length === 0) s.remove(); }
    const b = el('div', { class: 'bubble ' + (role === 'user' ? 'user' : 'bot') }, text); // textContent = XSS safe
    transcript.appendChild(b);
    transcript.scrollTop = transcript.scrollHeight;
    return b;
  }
  function addTyping() {
    const b = el('div', { class: 'bubble bot', html: '<span class="typing"><i></i><i></i><i></i></span>' });
    transcript.appendChild(b); transcript.scrollTop = transcript.scrollHeight; return b;
  }

  let sessionActive = false;
  let phase = 'idle';
  let busy = false;
  let mediaStream = null;
  let audioCtx = null;
  let analyser = null;
  let mediaRec = null;
  let deepgramSocket = null;
  let vadTimer = null;
  let recChunks = [];
  let discardCapture = false;
  let currentAudio = null;
  let activeSpeechSources = [];
  let liveBubble = null;
  let turnId = 0;
  const turnTiming = { stt: null, llm: null, tts: null };

  const PHASE_LABELS = {
    idle: 'Ready', connecting: 'Connecting microphone', listening: 'Listening',
    transcribing: 'Transcribing', thinking: 'Thinking', speaking: 'Agent speaking', error: 'Needs attention'
  };

  function setPhase(next) {
    phase = next;
    statusPill.className = 'conversation-status ' + next;
    statusText.textContent = PHASE_LABELS[next] || next;
    transcript.setAttribute('data-phase', next);
  }

  function updateTiming() {
    const parts = [];
    if (turnTiming.stt != null) parts.push('STT ' + (turnTiming.stt / 1000).toFixed(2) + 's');
    if (turnTiming.llm != null) parts.push('Groq ' + (turnTiming.llm / 1000).toFixed(2) + 's');
    if (turnTiming.tts != null) parts.push('Rumik ' + (turnTiming.tts / 1000).toFixed(2) + 's');
    timingText.textContent = parts.length ? parts.join('  ·  ') : 'Latency appears after the first turn';
  }

  function setSessionButton(active) {
    const label = $('.conversation-btn-label', sessionBtn);
    label.textContent = active ? 'End conversation' : 'Start conversation';
    sessionBtn.classList.toggle('active', active);
    sessionBtn.setAttribute('aria-label', active ? 'End conversation' : 'Start conversation');
  }

  function clearVad() {
    if (vadTimer) clearInterval(vadTimer);
    vadTimer = null;
  }

  function paintLiveTranscript(text) {
    text = String(text || '').trim();
    if (!text) return;
    if (!liveBubble || !liveBubble.isConnected) {
      liveBubble = el('div', { class: 'bubble user live-transcript' }, text);
      transcript.appendChild(liveBubble);
    } else {
      liveBubble.textContent = text;
    }
    transcript.scrollTop = transcript.scrollHeight;
  }

  function clearLiveTranscript() {
    if (liveBubble && liveBubble.isConnected) liveBubble.remove();
    liveBubble = null;
  }

  async function openDeepgramStream() {
    const wsScheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(wsScheme + '//' + location.host + '/api/stt/stream');
    deepgramSocket = socket;
    const segments = [];
    let interim = '';
    let finalizeStarted = 0;
    let settled = false;
    let resolveFinal;
    let rejectFinal;
    let finalizeTimer = null;
    const finalText = new Promise((resolve, reject) => { resolveFinal = resolve; rejectFinal = reject; });
    const settle = (text) => {
      if (settled) return;
      settled = true;
      if (finalizeTimer) clearTimeout(finalizeTimer);
      if (finalizeStarted) turnTiming.stt = Date.now() - finalizeStarted;
      updateTiming();
      resolveFinal(String(text || '').trim());
    };

    let resolveReady;
    let rejectReady;
    let readyResolved = false;
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });

    socket.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'ProxyReady') { readyResolved = true; resolveReady(); return; }
      if (msg.type === 'ProxyError') {
        const err = new Error(msg.message || 'Deepgram live stream failed.');
        rejectReady(err);
        if (readyResolved && !settled) rejectFinal(err);
        return;
      }
      if (msg.type !== 'Results') return;
      const alt = ((((msg.channel || {}).alternatives) || [])[0]) || {};
      const text = String(alt.transcript || '').trim();
      if (text) {
        if (msg.is_final) {
          if (segments[segments.length - 1] !== text) segments.push(text);
          interim = '';
        } else {
          interim = text;
        }
        paintLiveTranscript(segments.concat(interim ? [interim] : []).join(' '));
      }
      if (msg.from_finalize) settle(segments.concat(interim ? [interim] : []).join(' '));
    };
    socket.onerror = () => {
      const err = new Error('Deepgram live stream failed.');
      if (!readyResolved) rejectReady(err);
      else if (!settled) rejectFinal(err);
    };
    socket.onclose = () => {
      if (!readyResolved) rejectReady(new Error('Deepgram connection closed early.'));
      else if (!settled) settle(segments.concat(interim ? [interim] : []).join(' '));
    };

    const readyTimeout = setTimeout(() => rejectReady(new Error('Deepgram connection timed out.')), 8000);
    socket.addEventListener('error', () => rejectReady(new Error('Deepgram connection failed.')), { once: true });
    try {
      await ready.finally(() => clearTimeout(readyTimeout));
    } catch (e) {
      try { socket.close(); } catch (_) {}
      throw e;
    }

    return {
      socket,
      finalText,
      finalize() {
        if (socket.readyState !== WebSocket.OPEN) return settle(segments.join(' '));
        finalizeStarted = Date.now();
        socket.send(JSON.stringify({ type: 'Finalize' }));
        finalizeTimer = setTimeout(() => settle(segments.concat(interim ? [interim] : []).join(' ')), 2500);
      },
      close() {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'CloseStream' }));
        try { socket.close(); } catch (e) {}
      }
    };
  }

  function cancelCapture() {
    clearVad();
    if (mediaRec && mediaRec.state === 'recording') {
      discardCapture = true;
      try { mediaRec.stop(); } catch (e) {}
    }
    if (deepgramSocket) { try { deepgramSocket.close(); } catch (e) {} deepgramSocket = null; }
    clearLiveTranscript();
  }

  async function runTurn(userText) {
    userText = (userText || '').trim();
    if (!userText || busy) return;
    const agent = getActiveAgent();
    if (!agent) { toast('Pick an agent first.', 'err'); return; }
    cancelCapture();
    const myTurn = ++turnId;
    busy = true;
    addBubble('user', userText);
    convo.push({ role: 'user', text: userText });
    textIn.value = '';
    const typing = addTyping();
    setPhase('thinking');
    try {
      const chat = await api('/api/chat', {
        method: 'POST', timeoutMs: 30000,
        body: { messages: convo.map((m) => ({ role: m.role === 'bot' ? 'model' : 'user', text: m.text })), system: agent.persona }
      });
      turnTiming.llm = Number(chat.latency_ms) || null;
      updateTiming();
      if (myTurn !== turnId) { typing.remove(); return; }
      const reply = (chat.text || '').trim() || 'Sorry, I did not catch that.';
      typing.remove();
      addBubble('bot', reply);
      convo.push({ role: 'bot', text: reply });
      setPhase('speaking');
      await speakReply(reply, agent);
    } catch (ex) {
      typing.remove();
      addBubble('sys', 'The turn failed: ' + (ex.message || 'unknown error'));
      setPhase('error');
      toast(ex.message || 'Chat failed.', 'err');
    } finally {
      busy = false;
      if (sessionActive) listenForTurn();
      else if (phase !== 'error') setPhase('idle');
    }
  }

  async function speakReply(text, agent) {
    const tts = agent.tts || {};
    const ttsStarted = performance.now();
    try {
      const mint = await api('/api/ws-connect', {
        method: 'POST', timeoutMs: 12000,
        body: { text: text.slice(0, 2000), model: tts.model || 'mulberry' }
      });
      if (!mint.ws_url) throw new Error('Rumik stream URL was not returned.');
      const url = mint.ws_url + (mint.token && mint.ws_url.indexOf('token=') === -1
        ? (mint.ws_url.indexOf('?') === -1 ? '?' : '&') + 'token=' + encodeURIComponent(mint.token)
        : '');
      const playbackContext = audioCtx || new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
      if (playbackContext.state === 'suspended') await playbackContext.resume();
      await new Promise((resolve, reject) => {
        const socket = new WebSocket(url);
        socket.binaryType = 'arraybuffer';
        let nextTime = 0;
        let receivedAudio = false;
        let finished = false;
        const timeout = setTimeout(() => finish(new Error('Rumik stream timed out.')), 20000);

        function finish(error) {
          if (finished) return;
          finished = true;
          clearTimeout(timeout);
          try { socket.close(); } catch (_) {}
          if (error) return reject(error);
          const remainingMs = Math.max(0, (nextTime - playbackContext.currentTime) * 1000);
          setTimeout(resolve, remainingMs + 30);
        }

        socket.onopen = () => {
          const frame = { text: text.slice(0, 2000), model: tts.model || 'mulberry' };
          if (frame.model === 'mulberry') {
            if (tts.description) frame.description = tts.description;
            else frame.speaker = tts.speaker || 'speaker_1';
            frame.f0_up_key = Number.isFinite(tts.f0_up_key) ? tts.f0_up_key : 0;
          }
          socket.send(JSON.stringify(frame));
        };
        socket.onmessage = (event) => {
          if (typeof event.data === 'string') {
            try {
              const message = JSON.parse(event.data);
              if (message.type === 'end' || message.type === 'done' || message.done) finish(receivedAudio ? null : new Error('Rumik returned no audio.'));
            } catch (_) {}
            return;
          }
          const pcm = new Int16Array(event.data);
          if (!pcm.length) return;
          if (!receivedAudio) {
            receivedAudio = true;
            turnTiming.tts = Math.round(performance.now() - ttsStarted);
            updateTiming();
          }
          const samples = new Float32Array(pcm.length);
          for (let i = 0; i < pcm.length; i++) samples[i] = pcm[i] / 32768;
          const buffer = playbackContext.createBuffer(1, samples.length, 24000);
          buffer.copyToChannel(samples, 0);
          const source = playbackContext.createBufferSource();
          source.buffer = buffer;
          source.connect(playbackContext.destination);
          source.onended = () => { activeSpeechSources = activeSpeechSources.filter((item) => item !== source); };
          activeSpeechSources.push(source);
          if (nextTime < playbackContext.currentTime) nextTime = playbackContext.currentTime + 0.025;
          source.start(nextTime);
          nextTime += buffer.duration;
        };
        socket.onerror = () => finish(new Error('Rumik stream connection failed.'));
        socket.onclose = () => { if (!finished) finish(receivedAudio ? null : new Error('Rumik stream closed early.')); };
      });
    } catch (streamError) {
      // Keep a reliable batch fallback, but the normal path above starts audio
      // on Rumik's first PCM chunk and is the path reflected in the latency UI.
      try {
        const res = await api('/api/tts', { method: 'POST', timeoutMs: 60000, body: { text: text.slice(0, 2000), model: tts.model || 'mulberry', speaker: tts.speaker, f0_up_key: tts.f0_up_key, description: tts.description } });
        const buf = await res.arrayBuffer();
        turnTiming.tts = Math.round(performance.now() - ttsStarted);
        updateTiming();
        const url = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
        const audio = new Audio(url);
        currentAudio = audio;
        await new Promise((resolve) => {
          const done = () => { URL.revokeObjectURL(url); if (currentAudio === audio) currentAudio = null; resolve(); };
          audio.onended = done;
          audio.onerror = done;
          audio.play().catch(done);
        });
      } catch (_) {
        toast('Voice playback failed, the transcript is still available.', 'err');
      }
    }
  }

  sendBtn.addEventListener('click', () => runTurn(textIn.value));
  textIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') runTurn(textIn.value); });

  async function listenForTurn() {
    if (!sessionActive || busy || !mediaStream || !analyser) return;
    clearVad();
    discardCapture = false;
    recChunks = [];

    setPhase('connecting');
    let dg;
    try {
      dg = await openDeepgramStream();
    } catch (ex) {
      setPhase('error');
      addBubble('sys', 'Deepgram could not open a live transcription stream. Retrying.');
      toast(ex.message || 'Deepgram connection failed.', 'err');
      if (sessionActive) setTimeout(listenForTurn, 900);
      return;
    }

    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
    mediaRec = new MediaRecorder(mediaStream, mime ? { mimeType: mime } : undefined);
    const samples = new Uint8Array(analyser.fftSize);
    const captureStartedAt = Date.now();
    const audioSends = [];
    let speechStarted = false;
    let speechStartedAt = 0;
    let lastVoiceAt = 0;

    mediaRec.ondataavailable = (e) => {
      if (!e.data.size) return;
      recChunks.push(e.data);
      if (dg.socket.readyState === WebSocket.OPEN) {
        const sent = e.data.arrayBuffer().then((buf) => {
          if (dg.socket.readyState === WebSocket.OPEN) dg.socket.send(buf);
        }).catch(() => {});
        audioSends.push(sent);
      }
    };
    mediaRec.onstop = async () => {
      clearVad();
      const chunks = recChunks.slice();
      if (discardCapture) { discardCapture = false; dg.close(); return; }
      if (!sessionActive) return;
      if (!speechStarted || !chunks.length) {
        dg.close();
        setTimeout(listenForTurn, 180);
        return;
      }

      const blob = new Blob(chunks, { type: mediaRec.mimeType || 'audio/webm' });
      if (blob.size < 900) { dg.close(); setTimeout(listenForTurn, 180); return; }
      setPhase('transcribing');
      try {
        await Promise.all(audioSends);
        dg.finalize();
        let words = await dg.finalText;
        dg.close();
        if (!words) {
          const b64 = await blobToBase64(blob);
          const fallback = await api('/api/stt', { method: 'POST', timeoutMs: 45000, body: { audio: b64, mime: blob.type } });
          words = String(fallback.text || '').trim();
          turnTiming.stt = Number(fallback.latency_ms) || turnTiming.stt;
        }
        turnTiming.llm = null;
        turnTiming.tts = null;
        updateTiming();
        clearLiveTranscript();
        if (words) await runTurn(String(words).trim());
        else if (sessionActive) listenForTurn();
      } catch (ex) {
        dg.close();
        clearLiveTranscript();
        addBubble('sys', 'I could not transcribe that turn. I am listening again.');
        toast(ex.message || 'Transcription failed.', 'err');
        if (sessionActive) listenForTurn();
      }
    };

    mediaRec.start(250);
    setPhase('listening');
    vadTimer = setInterval(() => {
      if (!sessionActive || !mediaRec || mediaRec.state !== 'recording') return;
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (let i = 0; i < samples.length; i++) {
        const v = (samples[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / samples.length);
      const now = Date.now();
      if (rms >= 0.022) {
        if (!speechStarted) { speechStarted = true; speechStartedAt = now; }
        lastVoiceAt = now;
      }
      const endedTurn = speechStarted && now - speechStartedAt > 280 && now - lastVoiceAt > 900;
      const maxTurn = now - captureStartedAt > 30000;
      if (endedTurn || maxTurn) {
        try { mediaRec.stop(); } catch (e) {}
      }
    }, 60);
  }

  async function startConversation() {
    if (sessionActive) return;
    if (!window.isSecureContext) {
      toast('A live conversation needs the secure HTTPS Studio URL.', 'err');
      return;
    }
    const agent = getActiveAgent();
    if (!agent) { toast('Create or select an agent first.', 'err'); return; }
    if (!navigator.mediaDevices || !window.MediaRecorder) {
      toast('This browser cannot open an audio call. Use a current Chrome, Brave, Edge or Safari build.', 'err');
      return;
    }

    setPhase('connecting');
    sessionBtn.disabled = true;
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') await audioCtx.resume();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048;
      audioCtx.createMediaStreamSource(mediaStream).connect(analyser);
      sessionActive = true;
      agentSel.disabled = true;
      setSessionButton(true);
      const greeting = String(agent.greeting || 'Hello, how can I help you today?').trim();
      addBubble('bot', greeting);
      convo.push({ role: 'bot', text: greeting });
      setPhase('speaking');
      await speakReply(greeting, agent);
      if (sessionActive) listenForTurn();
    } catch (e) {
      toast('Microphone access failed. Allow the mic for this site, then start again.', 'err');
      endConversation(false);
      setPhase('error');
    } finally {
      sessionBtn.disabled = false;
    }
  }

  function endConversation(showMessage) {
    const wasActive = sessionActive;
    sessionActive = false;
    turnId += 1;
    cancelCapture();
    if (currentAudio) { try { currentAudio.pause(); } catch (e) {} currentAudio = null; }
    activeSpeechSources.forEach((source) => { try { source.stop(); } catch (_) {} });
    activeSpeechSources = [];
    if (mediaStream) mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
    analyser = null;
    if (audioCtx) { try { audioCtx.close(); } catch (e) {} }
    audioCtx = null;
    agentSel.disabled = false;
    setSessionButton(false);
    setPhase('idle');
    if (wasActive && showMessage !== false) addBubble('sys', 'Conversation ended.');
  }

  sessionBtn.addEventListener('click', () => {
    if (sessionActive) endConversation(true);
    else startConversation();
  });

  const panel = el('div', { class: 'card talk-panel' }, [
    el('div', { class: 'talk-head' }, [
      el('div', { class: 'talk-identity' }, [
        el('div', { class: 'who' }, [document.createTextNode('Live conversation '), el('span', {}, '(automatic turn-taking)')]),
        statusPill,
        pipelinePill,
        timingText
      ]),
      el('div', { class: 'talk-agent-select' }, [el('span', {}, 'Agent'), agentSel])
    ]),
    transcript,
    el('div', { class: 'talk-input' }, [sessionBtn, textIn, sendBtn])
  ]);

  const side = el('div', { class: 'talk-side' }, [
    el('div', { class: 'card card-pad' }, [
      el('h3', { class: 't-h3' }, 'How it works'),
      el('p', { class: 'soft', style: 'font-size:.88rem' }, 'Start once. Rumik greets you, then Deepgram streams every word into the transcript while you speak. Groq answers, Rumik speaks, and listening resumes automatically.'),
      el('div', { class: 'divider', style: 'margin:6px 0' }),
      el('div', { class: 'soft', style: 'font-size:.84rem' },
        'The status and measured Deepgram, Groq and Rumik latency make every stage of the turn explicit.'),
      el('div', { class: 'soft', style: 'font-size:.84rem;margin-top:10px' }, 'Use End conversation to release the microphone. Typed messages remain available at any time.')
    ])
  ]);

  root.appendChild(el('div', { class: 'talk-grid' }, [panel, side]));
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => { const s = String(r.result); resolve(s.slice(s.indexOf(',') + 1)); };
    r.onerror = reject; r.readAsDataURL(blob);
  });
}

/* ===========================================================================
   WORKFLOWS (Astra-first control plane)
   =========================================================================== */
async function ensureWorkflows(force) {
  if (State.loaded.workflows && !force) return State.workflows || [];
  const data = await api('/api/workflows');
  State.workflows = data.workflows || [];
  State.loaded.workflows = true;
  return State.workflows;
}

async function ensureWorkflowTemplates(force) {
  if (State.loaded.workflowTemplates && !force) return State.workflowTemplates || [];
  const data = await api('/api/workflow-templates');
  State.workflowTemplates = data.templates || [];
  State.loaded.workflowTemplates = true;
  return State.workflowTemplates;
}

function workflowStatusBadge(status) {
  const s = String(status || 'draft');
  const cls = s === 'published' ? 'badge-live' : (s === 'archived' ? 'badge-ready' : 'badge-ready');
  return el('span', { class: cls }, [el('span', { class: 'd' }), s]);
}

async function viewWorkflows(root) {
  const params = new URLSearchParams((location.hash.split('?')[1] || ''));
  const createMode = params.get('create') === '1';
  const editId = params.get('id');

  if (createMode) return viewWorkflowCreate(root);
  if (editId) return viewWorkflowBuilder(root, editId);

  root.appendChild(viewHead(
    'Workflows',
    'Design call flows in Astra. Publish when ready. Runtime stays behind the scenes.'
  ));

  const actions = el('div', { class: 'flex gap-2', style: 'margin-bottom:16px' }, [
    el('button', { class: 'btn btn-primary', onclick: () => { location.hash = '#/workflows?create=1'; } }, 'Create workflow')
  ]);
  root.appendChild(actions);

  const host = el('div', { class: 'card card-pad', id: 'wfList' }, skeleton('sk-line', 5));
  root.appendChild(host);

  try {
    const list = await ensureWorkflows(true);
    paintWorkflowList(host, list);
  } catch (e) {
    host.innerHTML = '';
    host.appendChild(el('div', { class: 'muted' }, 'Could not load workflows. ' + esc(e.message)));
  }
}

function paintWorkflowList(host, list) {
  host.innerHTML = '';
  host.appendChild(el('div', { class: 'flex items-center justify-between', style: 'margin-bottom:14px' }, [
    el('h3', { class: 't-h3' }, 'Your workflows'),
    el('span', { class: 'pill' }, [el('span', { class: 'dot' }), String((list || []).length) + ' total'])
  ]));

  if (!list || !list.length) {
    host.appendChild(el('div', { class: 'empty', style: 'padding:28px 12px' }, [
      el('div', { class: 'ttl' }, 'No workflows yet'),
      el('p', {}, 'Start from a template. Receptionist and outbound sales are good first picks.')
    ]));
    return;
  }

  const table = el('div', { class: 'wf-table' });
  list.forEach((w) => {
    const openBtn = el('button', { class: 'btn btn-ghost btn-sm' }, 'Open');
    openBtn.onclick = () => { location.hash = '#/workflows?id=' + encodeURIComponent(w.id); };
    const meta = [
      w.direction ? directionLabel(w.direction) : '',
      w.agentName || (w.agentId ? 'Agent' : 'No agent'),
      w.assignedNumberE164 || 'No number'
    ].filter(Boolean).join(' · ');
    table.appendChild(el('div', { class: 'wf-row' }, [
      el('div', { class: 'wf-main' }, [
        el('div', { class: 'wf-name' }, w.name),
        el('div', { class: 'exp' }, meta)
      ]),
      workflowStatusBadge(w.status),
      openBtn
    ]));
  });
  host.appendChild(table);
}

async function viewWorkflowCreate(root) {
  root.appendChild(viewHead(
    'Create workflow',
    'Pick a template first. You can edit stages after the draft is created.'
  ));
  root.appendChild(el('button', {
    class: 'btn btn-ghost btn-sm', style: 'margin-bottom:14px',
    onclick: () => { location.hash = '#/workflows'; }
  }, 'Back to list'));

  const host = el('div', { class: 'preset-grid', id: 'wfTemplates' }, skeleton('sk-card', 4));
  root.appendChild(host);

  try {
    const templates = await ensureWorkflowTemplates(true);
    host.innerHTML = '';
    templates.forEach((t) => {
      const btn = el('button', { class: 'btn btn-primary btn-sm' }, 'Use template');
      btn.onclick = async () => {
        btn.disabled = true;
        try {
          const created = await api('/api/workflows', {
            method: 'POST',
            body: { templateKey: t.key, name: t.name, description: t.description, direction: t.direction }
          });
          State.loaded.workflows = false;
          toast('Draft created from ' + t.name + '.', 'ok');
          location.hash = '#/workflows?id=' + encodeURIComponent(created.workflow.id);
        } catch (ex) {
          toast(ex.message || 'Create failed.', 'err');
          btn.disabled = false;
        }
      };
      host.appendChild(el('article', { class: 'card preset-card wf-template-card' }, [
        el('div', { class: 'preset-icon' }, (t.name || '?').slice(0, 1)),
        el('h3', { class: 't-h3' }, t.name),
        el('p', { class: 'muted' }, t.description || ''),
        el('div', { class: 'preset-meta' }, [
          el('span', {}, directionLabel(t.direction)),
          el('span', {}, t.key)
        ]),
        btn
      ]));
    });
  } catch (e) {
    host.innerHTML = '';
    host.appendChild(el('div', { class: 'muted' }, e.message));
  }
}

async function viewWorkflowBuilder(root, id) {
  root.appendChild(viewHead('Workflow builder', 'Edit stages in order. Save a draft, then publish when the flow is ready.'));
  root.appendChild(el('button', {
    class: 'btn btn-ghost btn-sm', style: 'margin-bottom:14px',
    onclick: () => { location.hash = '#/workflows'; }
  }, 'Back to list'));

  const host = el('div', { class: 'card card-pad' }, skeleton('sk-line', 6));
  root.appendChild(host);

  try {
    await Promise.all([ensureAgents().catch(() => {}), ensureWorkflows()]);
    const data = await api('/api/workflows/' + encodeURIComponent(id));
    const wf = data.workflow;
    paintWorkflowBuilder(host, wf);
  } catch (e) {
    host.innerHTML = '';
    host.appendChild(el('div', { class: 'muted' }, 'Could not open workflow. ' + esc(e.message)));
  }
}

function paintWorkflowBuilder(host, wf) {
  host.innerHTML = '';
  const isSuper = State.me && State.me.user && State.me.user.role === 'super_admin';
  const nameI = el('input', { class: 'input', value: wf.name || '' });
  const descI = el('textarea', { class: 'input', rows: '2' }, wf.description || '');
  const dirSel = el('select', { class: 'select' }, [
    el('option', { value: 'inbound' }, 'Inbound'),
    el('option', { value: 'outbound' }, 'Outbound'),
    el('option', { value: 'both' }, 'Both')
  ]);
  dirSel.value = wf.direction || 'both';
  const agentSel = el('select', { class: 'select' }, [
    el('option', { value: '' }, 'No primary agent')
  ].concat((State.agents || []).map((a) => el('option', { value: a.id }, a.name))));
  if (wf.agentId) agentSel.value = wf.agentId;

  const nodes = ((wf.graphJson && wf.graphJson.nodes) || []).map((n) => ({ ...n }));
  const stagesHost = el('div', { class: 'wf-stages' });

  function paintStages() {
    stagesHost.innerHTML = '';
    nodes.forEach((n, idx) => {
      if (n.type === 'global') return;
      const nameField = el('input', { class: 'input', value: n.name || '' });
      const promptField = el('textarea', { class: 'input', rows: '4' }, n.prompt || '');
      nameField.oninput = () => { n.name = nameField.value; };
      promptField.oninput = () => { n.prompt = promptField.value; };
      const typeLabel = n.type === 'start' ? 'Start' : (n.type === 'end' ? 'End' : ('Stage ' + idx));
      stagesHost.appendChild(el('div', { class: 'wf-stage' }, [
        el('div', { class: 'wf-stage-head' }, [
          el('span', { class: 'tag' }, typeLabel),
          el('span', { class: 'muted' }, n.type || 'agent')
        ]),
        field('Name', nameField),
        field('Prompt', promptField)
      ]));
    });
    const global = nodes.find((n) => n.type === 'global');
    if (global) {
      const gPrompt = el('textarea', { class: 'input', rows: '4' }, global.prompt || '');
      gPrompt.oninput = () => { global.prompt = gPrompt.value; };
      stagesHost.appendChild(el('div', { class: 'wf-stage' }, [
        el('div', { class: 'wf-stage-head' }, [el('span', { class: 'tag' }, 'Global rules')]),
        field('Always-on prompt', gPrompt)
      ]));
    }
  }
  paintStages();

  const addStageBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button' }, 'Add stage');
  addStageBtn.onclick = () => {
    const endIdx = nodes.findIndex((n) => n.type === 'end');
    const id = 'stage_' + Date.now().toString(36);
    const stage = { id, type: 'agent', name: 'New stage', prompt: 'Describe what happens in this stage.', next: endIdx >= 0 ? nodes[endIdx].id : null };
    // Relink previous agent/start next pointers.
    const agents = nodes.filter((n) => n.type === 'start' || n.type === 'agent');
    const last = agents[agents.length - 1];
    if (last) last.next = id;
    if (endIdx >= 0) nodes.splice(endIdx, 0, stage);
    else nodes.push(stage);
    paintStages();
  };

  const saveBtn = el('button', { class: 'btn btn-ghost' }, 'Save draft');
  const publishBtn = el('button', { class: 'btn btn-primary' }, 'Publish');
  const testBtn = el('button', { class: 'btn btn-ghost' }, 'Test');
  testBtn.onclick = () => {
    toast('Open Talk to it with an agent bound to this workflow to test the live voice path.', 'info');
    goto('talk');
  };

  async function collectPayload() {
    return {
      name: nameI.value.trim(),
      description: descI.value.trim(),
      direction: dirSel.value,
      agentId: agentSel.value || null,
      graphJson: { version: 1, nodes: nodes.map((n) => ({
        id: n.id, type: n.type, name: n.name, prompt: n.prompt, next: n.next || null
      })) }
    };
  }

  saveBtn.onclick = async () => {
    saveBtn.disabled = true;
    try {
      const body = await collectPayload();
      if (!body.name) { toast('Name is required.', 'err'); return; }
      await api('/api/workflows/' + encodeURIComponent(wf.id), { method: 'PATCH', body });
      State.loaded.workflows = false;
      toast('Draft saved.', 'ok');
    } catch (ex) {
      toast(ex.message || 'Save failed.', 'err');
    } finally {
      saveBtn.disabled = false;
    }
  };

  publishBtn.onclick = async () => {
    publishBtn.disabled = true;
    try {
      const body = await collectPayload();
      if (!body.name) { toast('Name is required.', 'err'); return; }
      await api('/api/workflows/' + encodeURIComponent(wf.id), { method: 'PATCH', body });
      const pub = await api('/api/workflows/' + encodeURIComponent(wf.id) + '/publish', { method: 'POST', body: {} });
      State.loaded.workflows = false;
      if (pub.syncError) toast('Published. Sync note: ' + pub.syncError, 'info');
      else toast('Published.', 'ok');
      const refreshed = await api('/api/workflows/' + encodeURIComponent(wf.id));
      paintWorkflowBuilder(host, refreshed.workflow);
    } catch (ex) {
      toast(ex.message || 'Publish failed.', 'err');
    } finally {
      publishBtn.disabled = false;
    }
  };

  const metaRow = el('div', { class: 'flex gap-2 items-center', style: 'margin-bottom:12px;flex-wrap:wrap' }, [
    workflowStatusBadge(wf.status),
    el('span', { class: 'tag' }, 'v' + (wf.version || 1)),
    wf.assignedNumberE164 ? el('span', { class: 'tag' }, wf.assignedNumberE164) : null
  ]);

  host.appendChild(metaRow);
  host.appendChild(el('div', { class: 'form-grid' }, [
    field('Name', nameI),
    field('Direction', dirSel),
    (function () { const f = field('Description', descI); f.classList.add('full'); return f; })(),
    field('Primary agent', agentSel)
  ]));
  host.appendChild(el('div', { class: 'flex items-center justify-between', style: 'margin:18px 0 10px' }, [
    el('h3', { class: 't-h3' }, 'Stages'),
    addStageBtn
  ]));
  host.appendChild(stagesHost);
  host.appendChild(el('div', { class: 'flex gap-2', style: 'margin-top:18px;flex-wrap:wrap' }, [saveBtn, testBtn, publishBtn]));

  if (isSuper) {
    host.appendChild(el('div', { class: 'inbound-note', style: 'margin-top:18px' }, [
      el('b', {}, 'Super Admin · provider mapping'),
      el('div', { class: 'muted', style: 'margin-top:6px' },
        'provider=' + esc(wf.provider || 'dograh')
        + ' · providerWorkflowId=' + esc(wf.providerWorkflowId != null ? String(wf.providerWorkflowId) : 'none')
        + ' · sync=' + esc(wf.syncStatus || 'n/a')
        + (wf.syncError ? (' · ' + esc(wf.syncError)) : ''))
    ]));
  }
}

/* ===========================================================================
   5. PHONE NUMBERS (Astra-first inventory + assign)
   =========================================================================== */
async function ensurePhoneNumbers(force) {
  if (State.loaded.phoneNumbers && !force) {
    return { numbers: State.phoneNumbers || [], available: State.availableNumbers || [] };
  }
  const [mine, avail, agentsRes, wfRes] = await Promise.all([
    api('/api/phone-numbers'),
    api('/api/phone-numbers/available'),
    State.loaded.agents ? Promise.resolve({ agents: State.agents }) : api('/api/agents'),
    State.loaded.workflows ? Promise.resolve({ workflows: State.workflows }) : api('/api/workflows').catch(() => ({ workflows: [] })),
  ]);
  State.phoneNumbers = mine.numbers || [];
  State.availableNumbers = avail.numbers || [];
  State.agents = agentsRes.agents || State.agents || [];
  State.workflows = wfRes.workflows || State.workflows || [];
  State.loaded.agents = true;
  State.loaded.workflows = true;
  State.loaded.phoneNumbers = true;
  return { numbers: State.phoneNumbers, available: State.availableNumbers };
}

async function viewPhoneNumbers(root) {
  root.appendChild(viewHead(
    'Phone Numbers',
    'List, search, and assign Phone Numbers to Employees. Provider portals stay invisible.'
  ));

  const search = el('input', {
    class: 'input',
    placeholder: 'Search by number, label, or employee',
    style: 'max-width:360px;margin-bottom:14px',
  });
  const assignedHost = el('div', { class: 'card card-pad', id: 'pnAssigned' }, skeleton('sk-line', 4));
  const availableHost = el('div', { class: 'card card-pad', id: 'pnAvailable' }, skeleton('sk-line', 3));
  const dialHost = el('div', { class: 'card card-pad' }, dialForm());
  root.appendChild(search);
  root.appendChild(el('div', { class: 'tel-grid' }, [assignedHost, availableHost]));
  root.appendChild(el('div', { style: 'margin-top:18px' }, dialHost));

  async function reload(q) {
    try {
      await ensureEmployees();
      const [mine, avail] = await Promise.all([
        api('/api/phone-numbers' + (q ? ('?q=' + encodeURIComponent(q)) : '')),
        api('/api/phone-numbers/available'),
      ]);
      State.phoneNumbers = mine.numbers || [];
      State.availableNumbers = avail.numbers || [];
      State.loaded.phoneNumbers = true;
      paintAssignedNumbers(assignedHost, State.phoneNumbers);
      paintAvailableNumbers(availableHost, State.availableNumbers);
    } catch (e) {
      assignedHost.innerHTML = '';
      assignedHost.appendChild(el('div', { class: 'muted' }, 'Could not load Phone Numbers. ' + esc(e.message)));
      availableHost.innerHTML = '';
    }
  }

  let searchTimer = null;
  search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => reload(search.value.trim()), 220);
  });

  await reload('');
}

function paintAssignedNumbers(host, numbers) {
  host.innerHTML = '';
  host.appendChild(el('div', { class: 'flex items-center justify-between', style: 'margin-bottom:14px' }, [
    el('h3', { class: 't-h3' }, 'Your numbers'),
    el('span', { class: 'pill' }, [
      el('span', { class: 'dot' }),
      String((numbers || []).length) + ' assigned'
    ])
  ]));

  if (!numbers || !numbers.length) {
    host.appendChild(el('div', { class: 'empty', style: 'padding:28px 12px' }, [
      el('div', { class: 'ttl' }, 'No Phone Numbers assigned yet'),
      el('p', {}, 'Pick a Phone Number from available inventory and assign it to an employee.')
    ]));
    return;
  }

  numbers.forEach((n) => {
    const inbound = el('label', { class: 'streamtoggle pn-toggle' }, [
      el('input', { type: 'checkbox', checked: n.inboundEnabled !== false ? 'checked' : null }),
      document.createTextNode('Inbound')
    ]);
    const outbound = el('label', { class: 'streamtoggle pn-toggle' }, [
      el('input', { type: 'checkbox', checked: n.outboundEnabled !== false ? 'checked' : null }),
      document.createTextNode('Outbound')
    ]);
    inbound.querySelector('input').onchange = async (ev) => {
      try {
        await api('/api/phone-numbers/' + encodeURIComponent(n.id), {
          method: 'PATCH', body: { inboundEnabled: ev.target.checked }
        });
        State.loaded.phoneNumbers = false;
        toast('Inbound ' + (ev.target.checked ? 'enabled' : 'disabled') + '.', 'ok');
      } catch (ex) {
        ev.target.checked = !ev.target.checked;
        toast(ex.message || 'Update failed.', 'err');
      }
    };
    outbound.querySelector('input').onchange = async (ev) => {
      try {
        await api('/api/phone-numbers/' + encodeURIComponent(n.id), {
          method: 'PATCH', body: { outboundEnabled: ev.target.checked }
        });
        State.loaded.phoneNumbers = false;
        toast('Outbound ' + (ev.target.checked ? 'enabled' : 'disabled') + '.', 'ok');
      } catch (ex) {
        ev.target.checked = !ev.target.checked;
        toast(ex.message || 'Update failed.', 'err');
      }
    };

    const unassignBtn = el('button', { class: 'btn btn-ghost btn-sm' }, 'Unassign');
    unassignBtn.onclick = () => {
      modal({
        title: 'Unassign number',
        body: el('p', {}, ['Release ', el('b', {}, n.e164), ' back to platform inventory?']),
        confirmText: 'Unassign', confirmKind: 'danger',
        onConfirm: async () => {
          await api('/api/phone-numbers/' + encodeURIComponent(n.id) + '/unassign', { method: 'POST', body: {} });
          State.loaded.phoneNumbers = false;
          toast('Number unassigned.', 'ok');
          if (currentRoute() === 'numbers') onRoute();
          else goto('numbers');
        }
      });
    };

    const inboundBtn = el('button', { class: 'btn btn-ghost btn-sm' }, 'Inbound');
    inboundBtn.onclick = () => {
      if (n.assignedEmployeeId) {
        location.hash = '#/employees?id=' + encodeURIComponent(n.assignedEmployeeId) + '&tab=number';
      } else {
        toast('Assign this Phone Number to an Employee to edit Inbound greeting and hours.', 'info');
      }
    };

    host.appendChild(el('div', { class: 'did-row pn-row' }, [
      el('div', {}, [
        el('div', { class: 'num' }, n.e164),
        el('div', { class: 'exp' }, (n.label || 'Phone Number')
          + (n.assignedEmployeeName ? ' · Employee ' + n.assignedEmployeeName : (n.assignedAgentName ? ' · ' + n.assignedAgentName : ''))
          + (n.inbound && n.inbound.answer === false ? ' · Inbound off' : '')
          + (n.inboundWorkflowName ? ' · ' + n.inboundWorkflowName : ''))
      ]),
      el('div', { class: 'pn-actions' }, [inbound, outbound, inboundBtn, unassignBtn])
    ]));
  });
}

function paintAvailableNumbers(host, numbers) {
  host.innerHTML = '';
  host.appendChild(el('div', { class: 'flex items-center justify-between', style: 'margin-bottom:14px' }, [
    el('h3', { class: 't-h3' }, 'Available to assign'),
    el('span', { class: 'pill' }, [
      el('span', { class: 'dot' }),
      'test inventory'
    ])
  ]));
  host.appendChild(el('p', { class: 'muted', style: 'font-size:.84rem;margin:0 0 12px;line-height:1.5' },
    'Platform-owned Phone Numbers for testing. Purchase is not available yet.'));

  if (!numbers || !numbers.length) {
    host.appendChild(el('div', { class: 'empty', style: 'padding:28px 12px' }, [
      el('div', { class: 'ttl' }, 'No inventory right now'),
      el('p', {}, 'All test Phone Numbers are assigned. Unassign one to free it for another employee.')
    ]));
    return;
  }

  const employees = (State.employees || []).filter((e) => e.status !== 'ARCHIVED');
  numbers.forEach((n) => {
    const empSel = el('select', { class: 'select' }, [
      el('option', { value: '' }, 'Select employee')
    ].concat(employees.map((e) => el('option', { value: e.id }, e.name || e.id))));
    const assignBtn = el('button', { class: 'btn btn-primary btn-sm' }, 'Assign');
    assignBtn.onclick = async () => {
      const employeeId = empSel.value;
      if (!employeeId) { toast('Choose an employee first.', 'err'); return; }
      assignBtn.disabled = true;
      try {
        await api('/api/phone-numbers/' + encodeURIComponent(n.id) + '/assign', {
          method: 'POST',
          body: {
            employeeId,
            inboundEnabled: true,
            outboundEnabled: true,
          }
        });
        State.loaded.phoneNumbers = false;
        State.loaded.employees = false;
        toast('Assigned ' + n.e164 + ' to employee.', 'ok');
        if (currentRoute() === 'numbers') onRoute();
        else goto('numbers');
      } catch (ex) {
        toast(ex.message || 'Assign failed.', 'err');
      } finally {
        assignBtn.disabled = false;
      }
    };

    host.appendChild(el('div', { class: 'did-row pn-row pn-row-assign' }, [
      el('div', {}, [
        el('div', { class: 'num' }, n.e164),
        el('div', { class: 'exp' }, n.label || 'Available Phone Number')
      ]),
      el('div', { class: 'pn-assign' }, [empSel, assignBtn])
    ]));
  });
}

function dialForm() {
  const numI = el('input', { class: 'input', id: 'dial_num', type: 'tel', inputmode: 'numeric', maxlength: 10, placeholder: '9876543210' });
  numI.addEventListener('input', () => { numI.value = numI.value.replace(/\D/g, '').slice(0, 10); });
  const btn = el('button', { class: 'btn btn-primary' }, 'Place call');
  const form = el('form', { class: 'dial-form', onsubmit: (e) => { e.preventDefault(); onDial(numI, btn); } }, [
    el('h3', { class: 't-h3' }, 'Outbound call'),
    el('p', { class: 'muted', style: 'font-size:.85rem' }, 'Enter a 10 digit Indian mobile number. Astra dials it through your assigned number.'),
    el('div', { class: 'field' }, [
      el('label', {}, 'Number'),
      el('div', { class: 'dial-input-row' }, [el('span', { class: 'prefix' }, '+91'), numI])
    ]),
    el('div', { class: 'cost-warn' }, ['This places a ', el('b', {}, 'real paid call'), ' on your telephony account.']),
    btn
  ]);
  return form;
}
function refreshDialNumbers() { /* placeholder for future caller-id selection */ }

function onDial(numI, btn) {
  const num = (numI.value || '').replace(/\D/g, '');
  if (num.length !== 10) { toast('Enter a valid 10 digit mobile number.', 'err'); numI.focus(); return; }
  modal({
    title: 'Confirm a real call',
    body: el('div', {}, [
      el('p', {}, ['You are about to place a real outbound call to ', el('b', {}, '+91 ' + num), '.']),
      el('div', { class: 'danger-note' }, [
        el('b', {}, 'This is a live, paid call. '),
        document.createTextNode('Only continue if you intend to ring this number now.')
      ])
    ]),
    confirmText: 'Yes, place the call', confirmKind: 'danger',
    onConfirm: async () => {
      btn.disabled = true; btn.textContent = 'Dialing...';
      try {
        await api('/api/telephony/dial', { method: 'POST', body: { number: num, confirm: true } });
        toast('Call placed to +91 ' + num + '.', 'ok');
        State.loaded.telephony = false;
        State.loaded.calls = false;
      } catch (ex) {
        if (ex.status === 400 && ex.data && ex.data.code === 'needs_confirm') toast('Confirmation required. Please retry.', 'err');
        else toast(ex.message || 'Dial failed.', 'err');
        throw ex;
      } finally {
        btn.disabled = false; btn.textContent = 'Place call';
      }
    }
  });
}

/* ===========================================================================
   5b. CALLS (list + detail + sync)
   =========================================================================== */
function fmtCallTime(iso) {
  if (!iso) return '-';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    return d.toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
    });
  } catch (_) {
    return String(iso);
  }
}

function fmtDuration(sec) {
  if (sec == null || !Number.isFinite(Number(sec))) return '-';
  const s = Math.max(0, Math.round(Number(sec)));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m ? (m + 'm ' + r + 's') : (r + 's');
}

async function viewCalls(root) {
  root.appendChild(viewHead(
    'Conversations',
    'Inbound and outbound conversations for this workspace. Transcript, recording, and outcome appear when data exists. Empty means none yet.'
  ));

  await ensureEmployees().catch(() => []);
  const empFilter = el('select', { class: 'select', id: 'callsEmp' },
    [el('option', { value: '' }, 'All employees')].concat(
      (State.employees || []).filter((e) => e.agentId).map((e) => el('option', { value: e.id }, e.name || e.id))
    )
  );
  const toolbar = el('div', { class: 'calls-toolbar' }, [
    el('div', { class: 'calls-filters' }, [
      el('select', { class: 'select', id: 'callsDir' }, [
        el('option', { value: '' }, 'All directions'),
        el('option', { value: 'inbound' }, 'Inbound'),
        el('option', { value: 'outbound' }, 'Outbound')
      ]),
      empFilter,
      el('input', { class: 'input', id: 'callsOutcome', placeholder: 'Outcome filter', style: 'max-width:140px' }),
      el('button', { class: 'btn btn-ghost btn-sm', id: 'callsRefresh' }, 'Refresh')
    ]),
    el('button', { class: 'btn btn-primary btn-sm', id: 'callsSync' }, 'Sync conversations')
  ]);
  root.appendChild(toolbar);

  const layout = el('div', { class: 'calls-layout' }, [
    el('div', { class: 'card card-pad calls-list-panel', id: 'callsListHost' }, skeleton('sk-line', 6)),
    el('div', { class: 'card card-pad calls-detail-panel', id: 'callsDetailHost' }, [
      el('div', { class: 'empty', style: 'padding:36px 12px' }, [
        el('div', { class: 'ttl' }, 'Select a conversation'),
        el('p', {}, 'Choose a row to see summary, transcript, outcome, and recording when available.')
      ])
    ])
  ]);
  root.appendChild(layout);

  const listHost = $('#callsListHost');
  const detailHost = $('#callsDetailHost');
  const dirSel = $('#callsDir');
  const outcomeIn = $('#callsOutcome');
  const syncBtn = $('#callsSync');
  const refreshBtn = $('#callsRefresh');

  function selectHandler(id) {
    State.selectedCallId = id;
    paintCallsList(listHost, State.calls, id, selectHandler);
    paintCallDetail(detailHost, id);
  }

  async function reload() {
    listHost.innerHTML = '';
    listHost.appendChild(el('div', {}, skeleton('sk-line', 5)));
    try {
      const params = new URLSearchParams();
      params.set('limit', '50');
      if (dirSel.value) params.set('direction', dirSel.value);
      if (empFilter.value) params.set('employeeId', empFilter.value);
      if (outcomeIn.value.trim()) params.set('outcome', outcomeIn.value.trim());
      const res = await api('/api/conversations?' + params.toString());
      State.calls = res.conversations || res.calls || [];
      State.loaded.calls = true;
      paintCallsList(listHost, State.calls, State.selectedCallId, selectHandler);
      if (State.selectedCallId) {
        const still = State.calls.find((c) => c.id === State.selectedCallId);
        if (still) await paintCallDetail(detailHost, State.selectedCallId);
        else {
          State.selectedCallId = null;
          detailHost.innerHTML = '';
          detailHost.appendChild(el('div', { class: 'empty', style: 'padding:36px 12px' }, [
            el('div', { class: 'ttl' }, 'Select a conversation'),
            el('p', {}, 'Choose a row to see summary, transcript, outcome, and recording when available.')
          ]));
        }
      }
    } catch (e) {
      listHost.innerHTML = '';
      listHost.appendChild(el('div', { class: 'muted' }, 'Could not load conversations. ' + esc(e.message)));
    }
  }

  dirSel.onchange = () => reload();
  empFilter.onchange = () => reload();
  outcomeIn.onchange = () => reload();
  refreshBtn.onclick = () => reload();
  syncBtn.onclick = async () => {
    syncBtn.disabled = true;
    syncBtn.textContent = 'Syncing...';
    try {
      const result = await api('/api/conversations/sync', { method: 'POST', body: {} });
      State.loaded.calls = false;
      const note = result.stubbed
        ? ('Synced with demo seed (' + (result.total || 0) + ' conversations).')
        : ('Synced ' + (result.fetched || 0) + ' upstream runs.');
      toast(note, 'ok');
      await reload();
    } catch (ex) {
      toast(ex.message || 'Sync failed.', 'err');
    } finally {
      syncBtn.disabled = false;
      syncBtn.textContent = 'Sync conversations';
    }
  };

  await reload();
}

function paintCallsList(host, callRows, selectedId, onSelect) {
  host.innerHTML = '';
  host.appendChild(el('div', { class: 'flex items-center justify-between', style: 'margin-bottom:12px' }, [
    el('h3', { class: 't-h3' }, 'Recent conversations'),
    el('span', { class: 'pill' }, [
      el('span', { class: 'dot' }),
      String((callRows || []).length) + ' shown'
    ])
  ]));

  if (!callRows || !callRows.length) {
    host.appendChild(el('div', { class: 'empty', style: 'padding:32px 12px' }, [
      el('div', { class: 'ttl' }, 'No conversations yet'),
      el('p', {}, 'When numbers are assigned and conversations happen, they appear here. Count: 0. —')
    ]));
    return;
  }

  const table = el('table', { class: 'calls-table' });
  table.appendChild(el('thead', {}, el('tr', {}, [
    el('th', {}, 'Time'),
    el('th', {}, 'Parties'),
    el('th', {}, 'Agent'),
    el('th', {}, 'Dir'),
    el('th', {}, 'Dur'),
    el('th', {}, 'Outcome')
  ])));
  const tbody = el('tbody');
  callRows.forEach((c) => {
    const tr = el('tr', {
      class: 'calls-row' + (c.id === selectedId ? ' is-selected' : ''),
      tabindex: '0',
      role: 'button'
    }, [
      el('td', {}, fmtCallTime(c.startedAt || c.createdAt)),
      el('td', { class: 'mono' }, (c.fromE164 || '?') + ' to ' + (c.toE164 || '?')),
      el('td', {}, c.agentName || '—'),
      el('td', {}, el('span', { class: 'dir-chip dir-' + (c.direction || 'inbound') }, c.direction || 'inbound')),
      el('td', {}, fmtDuration(c.durationSec)),
      el('td', {}, c.outcome || c.status || '—')
    ]);
    tr.onclick = () => onSelect(c.id);
    tr.onkeydown = (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onSelect(c.id); } };
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  host.appendChild(el('div', { class: 'calls-table-wrap' }, table));
}

async function paintCallDetail(host, callId) {
  host.innerHTML = '';
  host.appendChild(el('div', {}, skeleton('sk-line', 5)));
  try {
    const res = await api('/api/conversations/' + encodeURIComponent(callId));
    const c = res.conversation || res.call;
    if (!c) throw new Error('Conversation not found');
    host.innerHTML = '';

    host.appendChild(el('div', { class: 'calls-detail-head' }, [
      el('div', {}, [
        el('h3', { class: 't-h3' }, (c.direction === 'outbound' ? 'Outbound' : 'Inbound') + ' conversation'),
        el('p', { class: 'muted calls-detail-sub' },
          fmtCallTime(c.startedAt) + ' · ' + (c.fromE164 || '?') + ' to ' + (c.toE164 || '?'))
      ]),
      el('span', { class: 'pill' }, [el('span', { class: 'dot' }), c.status || 'unknown'])
    ]));

    host.appendChild(el('div', { class: 'calls-meta' }, [
      metaItem('Agent', c.agentName || '—'),
      metaItem('Duration', fmtDuration(c.durationSec)),
      metaItem('Outcome', c.outcome || '—')
    ]));

    host.appendChild(el('section', { class: 'calls-section' }, [
      el('h4', {}, 'Summary'),
      el('p', { class: 'calls-summary' }, c.summary || '—')
    ]));

    const extracted = c.extractedData || {};
    const keys = Object.keys(extracted);
    host.appendChild(el('section', { class: 'calls-section' }, [
      el('h4', {}, 'Extracted fields'),
      keys.length
        ? el('dl', { class: 'calls-extract' }, keys.flatMap((k) => [
          el('dt', {}, k),
          el('dd', {}, typeof extracted[k] === 'object' ? JSON.stringify(extracted[k]) : String(extracted[k]))
        ]))
        : el('p', { class: 'muted' }, '—')
    ]));

    const transcript = c.transcript;
    const turns = Array.isArray(transcript) ? transcript
      : (typeof transcript === 'string' && transcript ? [{ role: 'transcript', text: transcript }] : []);
    host.appendChild(el('section', { class: 'calls-section' }, [
      el('h4', {}, 'Transcript'),
      turns.length
        ? el('div', { class: 'calls-transcript' }, turns.map((t) => el('div', { class: 'tx-turn' }, [
          el('span', { class: 'tx-role' }, String(t.role || 'unknown')),
          el('span', { class: 'tx-text' }, String(t.text || ''))
        ])))
        : el('p', { class: 'muted' }, '—')
    ]));

    const lat = c.latency || {};
    host.appendChild(el('section', { class: 'calls-section' }, [
      el('h4', {}, 'Latency'),
      el('div', { class: 'calls-latency' }, [
        latChip('Total', lat.totalMs),
        latChip('STT', lat.sttMs),
        latChip('LLM', lat.llmMs),
        latChip('TTS', lat.ttsMs)
      ])
    ]));

    const recSection = el('section', { class: 'calls-section' }, [el('h4', {}, 'Recording')]);
    if (c.recordingAvailable && c.recordingUrl) {
      const audio = el('audio', { controls: 'controls', preload: 'none', class: 'calls-audio' });
      audio.src = c.recordingUrl;
      recSection.appendChild(audio);
      recSection.appendChild(el('p', { class: 'muted', style: 'margin-top:8px;font-size:.8rem' },
        'Played through Astra. Provider credentials never reach the browser.'));
    } else {
      recSection.appendChild(el('p', { class: 'muted' }, '—'));
    }
    host.appendChild(recSection);
  } catch (e) {
    host.innerHTML = '';
    host.appendChild(el('div', { class: 'muted' }, 'Could not load conversation. ' + esc(e.message)));
  }
}

function metaItem(label, value) {
  return el('div', { class: 'calls-meta-item' }, [
    el('span', { class: 'lbl' }, label),
    el('span', { class: 'val' }, value)
  ]);
}

function latChip(label, ms) {
  return el('div', { class: 'lat-chip' }, [
    el('span', { class: 'lbl' }, label),
    el('span', { class: 'val' }, ms == null ? '-' : (ms + ' ms'))
  ]);
}

/* ===========================================================================
   6. PRESETS, BILLING, SUPPORT, AND SUPER ADMIN
   =========================================================================== */
async function viewPresets(root) {
  root.appendChild(viewHead('Agent presets', 'Browse by agent type. Each preset is a deployable starting point with a clear direction and job to do.'));
  const notice = el('div', { class: 'inbound-note', style: 'margin:0 0 18px' }, 'AstraNova Receptionist is the live inbound starting point. Outbound Jerry follows permission, discovery, then reschedule. Industry presets stay editable and do not auto-bill.');
  const host = el('div', { id: 'presetGroups', class: 'preset-groups' }, skeleton('sk-card', 4));
  root.appendChild(notice); root.appendChild(host);
  try {
    await Promise.all([ensurePresets(true), ensureAgentTypes()]);
    host.innerHTML = '';
    const types = State.agentTypes.length ? State.agentTypes : [{ id: 'custom', label: 'Other', description: '', direction: 'both' }];
    const used = new Set();
    types.forEach((type) => {
      const presets = (State.presets || []).filter((p) => p.agentType === type.id);
      presets.forEach((p) => used.add(p.id));
      if (!presets.length && type.id === 'custom') return;
      const section = el('section', { class: 'preset-type-section' });
      section.appendChild(el('div', { class: 'preset-type-head' }, [
        el('div', {}, [
          el('h3', { class: 't-h3' }, type.label),
          el('p', { class: 'muted' }, type.description || '')
        ]),
        el('span', { class: 'tag' }, directionLabel(type.direction))
      ]));
      const grid = el('div', { class: 'preset-grid' });
      if (!presets.length) {
        grid.appendChild(el('div', { class: 'empty muted' }, 'No presets in this type yet. Use Custom to start blank.'));
      } else {
        presets.forEach((p) => grid.appendChild(presetCard(p, type)));
      }
      section.appendChild(grid);
      host.appendChild(section);
    });
    const orphan = (State.presets || []).filter((p) => !used.has(p.id));
    if (orphan.length) {
      const section = el('section', { class: 'preset-type-section' });
      section.appendChild(el('div', { class: 'preset-type-head' }, [el('h3', { class: 't-h3' }, 'Other presets')]));
      const grid = el('div', { class: 'preset-grid' });
      orphan.forEach((p) => grid.appendChild(presetCard(p, agentTypeMeta(p.agentType))));
      section.appendChild(grid);
      host.appendChild(section);
    }
    if (!State.presets.length) host.appendChild(el('div', { class: 'empty muted' }, 'No presets are available.'));
  } catch (e) { host.innerHTML = ''; host.appendChild(el('div', { class: 'card card-pad muted' }, e.message)); }
}

function presetCard(p, type) {
  const typeMeta = type || agentTypeMeta(p.agentType);
  const typeLabel = (typeMeta && typeMeta.label) || p.agentType || 'custom';
  const workflowBit = p.direction === 'outbound' ? 'Outbound pattern' : (p.direction === 'inbound' ? 'Inbound pattern' : null);
  return el('article', { class: 'card preset-card' }, [
    el('div', { class: 'preset-icon' }, (p.name || '?').slice(0, 1)),
    el('div', { class: 'flex items-center justify-between gap-2' }, [
      el('h3', { class: 't-h3' }, p.name),
      el('span', { class: 'badge-ready' }, typeLabel)
    ]),
    el('p', { class: 'muted' }, p.description || 'Editable voice-agent starting point.'),
    el('div', { class: 'preset-meta' }, [
      el('span', {}, directionLabel(p.direction || (typeMeta && typeMeta.direction))),
      el('span', {}, p.category || 'Voice agent'),
      workflowBit ? el('span', {}, workflowBit) : null
    ]),
    el('button', { class: 'btn btn-primary', onclick: () => createFromPreset(p) }, 'Use this preset')
  ]);
}

function createFromPreset(preset) {
  startDeployWizard({
    agentType: preset.agentType || 'custom',
    presetId: preset.id,
  });
}

async function viewInstantLeads(root) {
  root.appendChild(viewHead(
    'Instant Leads',
    'Add a lead, pick an employee, and place a real outbound call with an explicit confirm. Job queue shows status with links to Employee, Lead, and Conversation when present.'
  ));
  await Promise.all([ensureAgents().catch(() => []), ensureEmployees().catch(() => [])]);
  const name = el('input', { class: 'input', placeholder: 'Lead name' });
  const phone = el('input', { class: 'input', placeholder: 'Phone (+91... or 10-digit IN)' });
  const empOptions = (State.employees || []).filter((e) => e.agentId && e.status !== 'ARCHIVED');
  const agent = el('select', { class: 'select' },
    [el('option', { value: '' }, 'Select employee')].concat(
      empOptions.length
        ? empOptions.map((e) => el('option', { value: e.id }, e.name + (e.role ? ' · ' + e.role : '')))
        : (State.agents || []).map((a) => el('option', { value: 'agent:' + a.id }, a.name))
    )
  );
  const list = el('div', { class: 'ticket-list' }, skeleton('sk-card', 2));
  const jobsHost = el('div', { class: 'ticket-list', id: 'callJobsQueue' }, skeleton('sk-card', 2));
  const create = el('button', { class: 'btn btn-primary' }, 'Save lead');
  create.onclick = async () => {
    create.disabled = true;
    try {
      const val = agent.value || '';
      const body = {
        name: name.value.trim(),
        phone: phone.value.trim(),
      };
      if (val.startsWith('agent:')) body.agentId = val.slice(6);
      else if (val) body.employeeId = val;
      await api('/api/leads', {
        method: 'POST',
        body,
      });
      name.value = '';
      phone.value = '';
      toast('Lead saved.', 'ok');
      await loadInstantLeads(list);
      await loadCallJobsQueue(jobsHost);
    } catch (e) { toast(e.message, 'err'); }
    finally { create.disabled = false; }
  };
  root.appendChild(el('div', { class: 'support-layout' }, [
    el('section', { class: 'card card-pad support-compose' }, [
      el('h3', { class: 't-h3' }, 'New lead'),
      field('Name', name),
      field('Phone', phone),
      field('Employee', agent),
      create,
    ]),
    list,
  ]));
  root.appendChild(el('section', { class: 'card card-pad', style: 'margin-top:18px' }, [
    el('div', { class: 'flex items-center justify-between gap-2', style: 'margin-bottom:12px' }, [
      el('h3', { class: 't-h3' }, 'Call job queue'),
      el('button', {
        class: 'btn btn-ghost btn-sm',
        onclick: () => loadCallJobsQueue(jobsHost),
      }, 'Refresh queue'),
    ]),
    el('p', { class: 'muted', style: 'margin-bottom:12px' },
      'Statuses: queued, dialing, completed, failed. Dial still requires Confirm on each lead.'),
    jobsHost,
  ]));
  await loadInstantLeads(list);
  await loadCallJobsQueue(jobsHost);
}

async function loadCallJobsQueue(host) {
  try {
    const out = await api('/api/call-jobs?limit=40');
    host.innerHTML = '';
    const jobs = out.jobs || [];
    if (!jobs.length) {
      host.appendChild(el('p', { class: 'muted' }, 'No call jobs yet. —'));
      return;
    }
    jobs.forEach((job) => {
      const links = [];
      if (job.employeeId) {
        links.push(el('a', {
          href: '#/employees?id=' + encodeURIComponent(job.employeeId),
          class: 'btn btn-ghost btn-sm',
        }, job.employeeName || 'Employee'));
      }
      if (job.leadId) {
        links.push(el('span', { class: 'muted' }, 'Lead ' + (job.leadName || job.leadId)));
      }
      if (job.resultCallId) {
        links.push(el('a', {
          href: '#/calls',
          class: 'btn btn-ghost btn-sm',
          onclick: (e) => {
            e.preventDefault();
            State.selectedCallId = job.resultCallId;
            goto('calls');
          },
        }, 'Conversation'));
      }
      host.appendChild(el('article', { class: 'card ticket-card' }, [
        el('div', { class: 'flex items-center justify-between gap-2' }, [
          el('h3', { class: 't-h3' }, job.toE164 || 'Job'),
          el('span', { class: 'pill' }, job.status || 'queued'),
        ]),
        el('p', { class: 'muted' },
          fmtCallTime(job.updatedAt || job.createdAt)
          + (job.source ? ' · ' + job.source : '')
          + (job.lastError ? ' · ' + job.lastError : '')
          + (job.callOutcome ? ' · outcome ' + job.callOutcome : '')),
        el('div', { class: 'flex gap-2', style: 'flex-wrap:wrap' }, links.length ? links : [el('span', { class: 'muted' }, '—')]),
      ]));
    });
  } catch (e) {
    host.innerHTML = '';
    host.appendChild(el('div', { class: 'muted' }, e.message));
  }
}

async function loadInstantLeads(host) {
  try {
    const out = await api('/api/leads');
    host.innerHTML = '';
    (out.leads || []).forEach((lead) => {
      const callBtn = el('button', { class: 'btn btn-primary' }, 'Call now');
      callBtn.onclick = () => {
        modal({
          title: 'Confirm outbound call',
          body: el('div', {}, [
            el('p', {}, 'This places a real call to ' + (lead.phone || '') + ' for "' + (lead.name || 'Lead') + '".'),
            el('p', { class: 'muted' }, 'You will see job status in the queue and a conversation row when the dial is accepted.'),
          ]),
          confirmText: 'Confirm call',
          onConfirm: async () => {
            const res = await api('/api/leads/' + encodeURIComponent(lead.id) + '/call', {
              method: 'POST',
              body: { confirm: true, agentId: lead.agentId || undefined },
            });
            const st = (res.job && res.job.status) || 'done';
            toast('Call job ' + st + (res.call && res.call.id ? '. Open Conversations for details.' : '.'), 'ok');
            await loadInstantLeads(host);
            const jobsHost = $('#callJobsQueue');
            if (jobsHost) await loadCallJobsQueue(jobsHost);
          },
        });
      };
      const callsLink = el('a', {
        href: '#/calls',
        class: 'btn btn-ghost',
        onclick: (e) => { e.preventDefault(); goto('calls'); },
      }, 'Open Conversations');
      const statusBits = [
        lead.status || 'new',
        lead.lastCallJobId ? 'job linked' : null,
        lead.lastCallId ? 'conversation linked' : null,
        lead.lastError ? ('error: ' + lead.lastError) : null,
      ].filter(Boolean).join(' · ');
      host.appendChild(el('article', { class: 'card ticket-card' }, [
        el('div', { class: 'flex items-center justify-between gap-2' }, [
          el('h3', { class: 't-h3' }, lead.name || 'Lead'),
          el('span', { class: 'pill' }, lead.status || 'new'),
        ]),
        el('p', { class: 'muted' }, (lead.phone || '') + (lead.employeeId || lead.agentId ? ' · employee linked' : '')),
        el('p', { class: 'muted' }, statusBits || '—'),
        el('div', { class: 'flex gap-2' }, [callBtn, callsLink]),
      ]));
    });
    if (!(out.leads || []).length) {
      host.appendChild(el('div', { class: 'card card-pad muted' }, 'No leads yet. Save one on the left, then Call now.'));
    }
  } catch (e) {
    host.innerHTML = '';
    host.appendChild(el('div', { class: 'card card-pad muted' }, e.message));
  }
}

async function viewCampaigns(root) {
  root.appendChild(viewHead('Campaigns', 'Attach an Employee, paste leads, and enqueue through the same CallJob dial path as Instant Leads. Confirm is required.'));
  await ensureEmployees();
  const name = el('input', { class: 'input', placeholder: 'March callbacks' });
  const empSel = el('select', { class: 'select' }, [
    el('option', { value: '' }, 'Select employee'),
  ].concat((State.employees || []).filter((e) => e.status !== 'ARCHIVED').map((e) => el('option', { value: e.id }, e.name || e.id))));
  const leads = el('textarea', { class: 'input textarea', placeholder: '+9198XXXXXXXX, Name\n+9199XXXXXXXX, Name' });
  const list = el('div', { class: 'ticket-list' }, skeleton('sk-card', 2));
  const create = el('button', { class: 'btn btn-primary' }, 'Create campaign');
  create.onclick = async () => {
    create.disabled = true;
    try {
      const out = await api('/api/campaigns', {
        method: 'POST',
        body: { name: name.value.trim(), employeeId: empSel.value || null },
      });
      if (leads.value.trim()) {
        await api('/api/campaigns/leads', { method: 'POST', body: { campaignId: out.campaign.id, text: leads.value } });
      }
      name.value = ''; leads.value = ''; toast('Campaign created.', 'ok'); await loadCampaigns(list);
    } catch (e) { toast(e.message, 'err'); } finally { create.disabled = false; }
  };
  root.appendChild(el('div', { class: 'support-layout' }, [
    el('section', { class: 'card card-pad support-compose' }, [
      el('h3', { class: 't-h3' }, 'New campaign'),
      field('Name', name), field('Employee', empSel), field('Lead list (phone, name)', leads), create
    ]),
    list
  ]));
  await loadCampaigns(list);
}

async function loadCampaigns(host) {
  try {
    await ensureEmployees();
    const out = await api('/api/campaigns');
    host.innerHTML = '';
    const empName = (id) => {
      const e = (State.employees || []).find((x) => x.id === id);
      return e ? e.name : (id || '—');
    };
    (out.campaigns || []).forEach((c) => {
      const pause = el('button', { class: 'btn btn-ghost' }, c.status === 'paused' ? 'Resume' : 'Pause');
      pause.onclick = async () => {
        try {
          await api('/api/campaigns/status', { method: 'POST', body: { campaignId: c.id, status: c.status === 'paused' ? 'running' : 'paused' } });
          await loadCampaigns(host);
        } catch (e) { toast(e.message, 'err'); }
      };
      const attach = el('select', { class: 'select' }, [
        el('option', { value: '' }, 'Attach employee'),
      ].concat((State.employees || []).filter((e) => e.status !== 'ARCHIVED').map((e) =>
        el('option', { value: e.id, selected: c.employeeId === e.id ? 'selected' : null }, e.name || e.id))));
      if (c.employeeId) attach.value = c.employeeId;
      attach.onchange = async () => {
        try {
          await api('/api/campaigns/employee', {
            method: 'POST',
            body: { campaignId: c.id, employeeId: attach.value || null },
          });
          toast(attach.value ? 'Employee attached.' : 'Employee cleared.', 'ok');
          await loadCampaigns(host);
        } catch (e) { toast(e.message, 'err'); }
      };
      const enqueue = el('button', { class: 'btn btn-primary' }, 'Enqueue batch');
      enqueue.onclick = () => {
        modal({
          title: 'Confirm outbound enqueue',
          body: el('div', {}, [
            el('p', {}, 'This queues up to ' + (c.ratePerMinute || 10) + ' CallJobs for "' + c.name + '"'
              + (c.employeeId ? (' via ' + empName(c.employeeId)) : '')
              + '. Same dial path as Instant Leads. Confirm is required.')
          ]),
          confirmText: 'Confirm enqueue',
          onConfirm: async () => {
            const res = await api('/api/campaigns/enqueue', { method: 'POST', body: { campaignId: c.id, confirm: true } });
            toast('Enqueued ' + (res.enqueued || 0) + ' lead(s).', 'ok');
            await loadCampaigns(host);
          }
        });
      };
      host.appendChild(el('article', { class: 'card ticket-card' }, [
        el('div', { class: 'flex items-center justify-between gap-2' }, [el('h3', { class: 't-h3' }, c.name), el('span', { class: 'pill' }, c.status)]),
        el('p', { class: 'muted' }, (c.leadCount || 0) + ' leads · ' + (c.dialedCount || 0) + ' dialed · employee ' + empName(c.employeeId) + ' · rate ' + (c.ratePerMinute || 10) + '/min'),
        el('div', { class: 'flex gap-2', style: 'flex-wrap:wrap;align-items:center' }, [attach, enqueue, pause])
      ]));
    });
    if (!(out.campaigns || []).length) host.appendChild(el('div', { class: 'card card-pad muted' }, 'No campaigns yet.'));
  } catch (e) { host.innerHTML = ''; host.appendChild(el('div', { class: 'card card-pad muted' }, e.message)); }
}

function fmtPerf(value, emptyDash) {
  if (value == null || value === '') return emptyDash ? '—' : '0';
  return String(value);
}

async function viewAnalytics(root) {
  root.appendChild(viewHead('Performance', 'Real Call, Lead, and Outcome aggregates only. Empty values stay — or zero. No invented charts.'));
  const stats = el('div', { class: 'grid grid-3' }, skeleton('sk-stat', 4));
  const tables = el('div', { class: 'grid grid-12', style: 'margin-top:14px' });
  root.appendChild(stats);
  root.appendChild(tables);
  try {
    const out = await api('/api/performance');
    const a = out.performance || out.analytics || {};
    const calls = a.calls || {};
    const totals = calls.totals || {};
    const leadTotals = (a.leads && a.leads.totals) || {};
    stats.innerHTML = '';
    [
      ['Calls', fmtPerf(totals.calls || 0), 'Tenant scoped'],
      ['Converted', fmtPerf(totals.converted || 0), totals.conversionRatePct == null ? '— rate' : (totals.conversionRatePct + '% rate')],
      ['Leads', fmtPerf(leadTotals.leads || 0), (leadTotals.connected || 0) + ' connected'],
      ['Campaign leads', fmtPerf((a.campaigns && a.campaigns.leads) || 0), String((a.campaigns && a.campaigns.campaigns) || 0) + ' campaigns']
    ].forEach((row) => stats.appendChild(statCard(row[0], String(row[1]), row[2])));
    tables.innerHTML = '';
    function tableCard(title, map) {
      const card = el('section', { class: 'card card-pad' }, [el('h3', { class: 't-h3', style: 'margin-bottom:12px' }, title)]);
      const entries = Object.entries(map || {});
      if (!entries.length) card.appendChild(el('div', { class: 'muted' }, '—'));
      entries.sort((x, y) => y[1] - x[1]).forEach(([k, v]) => {
        card.appendChild(el('div', { class: 'ledger-row' }, [el('div', {}, k), el('b', {}, String(v))]));
      });
      return card;
    }
    tables.appendChild(tableCard('By outcome', calls.byOutcome));
    tables.appendChild(tableCard('By employee', calls.byEmployee));
    tables.appendChild(tableCard('Lead status', (a.leads && a.leads.byStatus) || {}));
    tables.appendChild(tableCard('Outcome keys', (a.outcomes && a.outcomes.byKey) || {}));
  } catch (e) { stats.innerHTML = ''; stats.appendChild(el('div', { class: 'card card-pad muted' }, e.message)); }
}

async function viewTrainingHub(root) {
  root.appendChild(viewHead('Training', 'Teach each Employee with knowledge notes and FAQs. Opens the Studio Training tab.'));
  const host = el('div', { class: 'ticket-list' }, skeleton('sk-card', 3));
  root.appendChild(host);
  try {
    await ensureEmployees(true);
    host.innerHTML = '';
    const rows = (State.employees || []).filter((e) => e.status !== 'ARCHIVED');
    if (!rows.length) {
      host.appendChild(el('div', { class: 'card card-pad muted' }, 'No employees yet. Create one, then add training.'));
      return;
    }
    rows.forEach((emp) => {
      const open = el('button', { class: 'btn btn-primary btn-sm' }, 'Open Training');
      open.onclick = () => {
        location.hash = '#/employees?id=' + encodeURIComponent(emp.id) + '&tab=training';
      };
      host.appendChild(el('article', { class: 'card ticket-card' }, [
        el('div', { class: 'flex items-center justify-between gap-2' }, [
          el('div', {}, [
            el('h3', { class: 't-h3' }, emp.name || 'Employee'),
            el('p', { class: 'muted' }, (emp.role || 'Role') + ' · ' + (emp.status || 'DRAFT')
              + ' · ' + ((emp.knowledgeIds && emp.knowledgeIds.length) || 0) + ' training assets'),
          ]),
          open,
        ]),
      ]));
    });
  } catch (e) {
    host.innerHTML = '';
    host.appendChild(el('div', { class: 'card card-pad muted' }, e.message));
  }
}

async function viewBilling(root) {
  root.appendChild(viewHead('Billing', 'Plan entitlements, prepaid wallet balance, and top-up packs. Provider invoices stay off this page.'));
  const host = el('div', { class: 'grid grid-12' }, [
    el('section', { class: 'card card-pad', id: 'walletSummary' }, skeleton('sk-card', 1)),
    el('section', { class: 'card card-pad', id: 'planPanel' }, skeleton('sk-card', 1)),
    el('section', { class: 'card card-pad', id: 'entitlementsPanel' }, skeleton('sk-card', 1)),
    el('section', { class: 'card card-pad', id: 'usagePanel' }, skeleton('sk-card', 1)),
    el('section', { class: 'card card-pad', id: 'walletLedger' }, skeleton('sk-card', 1))
  ]);
  root.appendChild(host);
  try {
    const [out, planCatalog] = await Promise.all([api('/api/wallet'), api('/api/plans')]);
    const wallet = out.wallet || {}; const rows = out.ledger || [];
    const plan = out.plan || {};
    const ent = out.entitlements || {};
    const sum = $('#walletSummary'); sum.innerHTML = '';
    sum.appendChild(el('div', { class: 'muted' }, 'Available credit'));
    const bal = wallet.balanceInr != null ? wallet.balanceInr : (wallet.balancePaise || 0) / 100;
    sum.appendChild(el('div', { class: 'wallet-big' }, ['₹' + fmtInr(bal), el('small', {}, ' INR') ]));
    if (!bal) {
      sum.appendChild(el('p', { class: 'muted' }, 'Wallet is empty (₹0). Top up below, or ask Super Admin for test credits.'));
    } else {
      sum.appendChild(el('p', { class: 'muted' }, 'Signup grants a ₹10 trial plus the Starter plan allowance. Top-ups use PayU ' + (out.payuEnv || 'test') + ' mode' + (out.payuConfigured ? '.' : ' (not configured yet).')));
    }
    const packs = out.packs && out.packs.length ? out.packs : [{ id: 'starter', amountInr: 200 }, { id: 'growth', amountInr: 500 }, { id: 'scale', amountInr: 1000 }];
    sum.appendChild(el('h3', { class: 't-h3', style: 'margin:16px 0 10px' }, 'Top-up packs'));
    sum.appendChild(el('div', { class: 'pack-row' }, packs.map((pack) => el('button', { class: 'btn btn-ghost', onclick: () => startRecharge(pack.id) }, 'Add ₹' + fmtInr(pack.amountInr != null ? pack.amountInr : pack.inr)))));

    const planPanel = $('#planPanel'); planPanel.innerHTML = '';
    planPanel.appendChild(el('h3', { class: 't-h3', style: 'margin-bottom:10px' }, 'Current plan'));
    planPanel.appendChild(el('div', { class: 'wallet-big', style: 'font-size:28px' }, plan.label || plan.id || 'Starter'));
    planPanel.appendChild(el('p', { class: 'muted' },
      'Includes ₹' + fmtInr(plan.includedCreditsInr || 0) + ' credits, '
      + (plan.includedNumbers || 1) + ' number(s), '
      + (plan.includedEmployees || 2) + ' employee(s), '
      + (plan.includedMinutes || 100) + ' minute(s).'));

    const entPanel = $('#entitlementsPanel'); entPanel.innerHTML = '';
    entPanel.appendChild(el('h3', { class: 't-h3', style: 'margin-bottom:10px' }, 'Entitlements'));
    const included = (ent && ent.included) || {};
    const used = (ent && ent.used) || {};
    [
      ['Phone Numbers', used.numbers || 0, included.numbers != null ? included.numbers : (plan.includedNumbers || 1)],
      ['Employees', used.employees || 0, included.employees != null ? included.employees : (plan.includedEmployees || 2)],
      ['Minutes', used.minutes || 0, included.minutes != null ? included.minutes : (plan.includedMinutes || 100)],
    ].forEach((row) => {
      entPanel.appendChild(el('div', { class: 'ledger-row' }, [
        el('div', {}, row[0]),
        el('b', {}, String(row[1]) + ' / ' + String(row[2])),
      ]));
    });
    entPanel.appendChild(el('p', { class: 'muted', style: 'margin-top:10px' },
      'Usage counts come from real Phone Numbers, Employees, and call minutes only. Empty stays empty.'));
    const isOwner = State.me && ['super_admin', 'admin', 'owner'].includes(State.me.user.role);
    if (isOwner) {
      planPanel.appendChild(el('div', { class: 'pack-row', style: 'margin-top:12px' }, (planCatalog.plans || []).map((p) => {
        const btn = el('button', { class: 'btn ' + (p.id === plan.id ? 'btn-primary' : 'btn-ghost') }, p.label);
        btn.disabled = p.id === plan.id;
        btn.onclick = async () => {
          try {
            await api('/api/plans/upgrade', { method: 'POST', body: { planId: p.id } });
            toast('Plan updated to ' + p.label + '.', 'ok');
            onRoute();
          } catch (e) { toast(e.message, 'err'); }
        };
        return btn;
      })));
    }

    const usagePanel = $('#usagePanel'); usagePanel.innerHTML = '';
    usagePanel.appendChild(el('h3', { class: 't-h3', style: 'margin-bottom:10px' }, 'Recent usage'));
    const days = out.usageDays || [];
    if (!days.length) usagePanel.appendChild(el('div', { class: 'muted' }, 'No usage rows yet.'));
    days.slice().reverse().slice(0, 10).forEach((d) => {
      usagePanel.appendChild(el('div', { class: 'ledger-row' }, [
        el('div', {}, [el('div', {}, d.day), el('small', { class: 'muted' }, (d.chars || 0) + ' chars · ' + (d.calls || 0) + ' calls')]),
        el('b', {}, String(d.llmTokens || 0) + ' tok')
      ]));
    });

    const ledger = $('#walletLedger'); ledger.innerHTML = '';
    ledger.appendChild(el('h3', { class: 't-h3', style: 'margin-bottom:14px' }, 'Transaction history'));
    rows.slice(0, 20).forEach((x) => ledger.appendChild(el('div', { class: 'ledger-row' }, [
      el('div', {}, [el('div', {}, x.description || String(x.type || '').replace(/_/g, ' ')), el('small', { class: 'muted' }, x.createdAt || '')]),
      el('b', { class: Number(x.amountPaise) >= 0 ? 'money-plus' : 'money-minus' }, (Number(x.amountPaise) >= 0 ? '+' : '') + '₹' + fmtInr(Number(x.amountPaise || 0) / 100))
    ])));
    if (!rows.length) ledger.appendChild(el('div', { class: 'muted' }, 'No wallet activity yet.'));
  } catch (e) { host.innerHTML = ''; host.appendChild(el('div', { class: 'card card-pad muted' }, e.message)); }
}

async function viewKnowledge(root) {
  root.appendChild(viewHead('Knowledge', 'Tenant FAQ and docs for agent context. Portable JSON store, simple keyword retrieval.'));
  const title = el('input', { class: 'input', placeholder: 'Office hours FAQ' });
  const content = el('textarea', { class: 'input textarea', placeholder: 'Paste FAQ text or article body.' });
  const sourceUrl = el('input', { class: 'input', placeholder: 'https://example.com/faq (optional)' });
  const status = el('select', { class: 'select' }, ['draft', 'published', 'archived'].map((s) => el('option', { value: s }, s)));
  const list = el('div', { class: 'ticket-list' }, skeleton('sk-card', 2));
  const query = el('input', { class: 'input', placeholder: 'Try retrieval: office hours' });
  const hits = el('div', { class: 'card card-pad muted' }, 'Retrieval results appear here.');
  const save = el('button', { class: 'btn btn-primary' }, 'Add entry');
  save.onclick = async () => {
    save.disabled = true;
    try {
      await api('/api/knowledge', { method: 'POST', body: { title: title.value.trim(), content: content.value.trim(), sourceUrl: sourceUrl.value.trim(), status: status.value } });
      title.value = ''; content.value = ''; sourceUrl.value = ''; toast('Knowledge entry saved.', 'ok'); await loadKnowledge(list);
    } catch (e) { toast(e.message, 'err'); } finally { save.disabled = false; }
  };
  const retrieve = el('button', { class: 'btn btn-ghost' }, 'Retrieve');
  retrieve.onclick = async () => {
    try {
      const out = await api('/api/knowledge/retrieve?q=' + encodeURIComponent(query.value.trim()));
      hits.innerHTML = '';
      hits.className = 'card card-pad';
      (out.hits || []).forEach((h) => hits.appendChild(el('div', { class: 'ledger-row' }, [
        el('div', {}, [el('b', {}, h.title), el('small', { class: 'muted' }, h.excerpt || '')]),
        el('span', { class: 'pill' }, 'score ' + h.score)
      ])));
      if (!(out.hits || []).length) hits.appendChild(el('div', { class: 'muted' }, 'No published matches.'));
    } catch (e) { toast(e.message, 'err'); }
  };
  root.appendChild(el('div', { class: 'support-layout' }, [
    el('section', { class: 'card card-pad support-compose' }, [
      el('h3', { class: 't-h3' }, 'New entry'),
      field('Title', title), field('Content', content), field('Source URL', sourceUrl), field('Status', status), save
    ]),
    list
  ]));
  root.appendChild(el('section', { class: 'card card-pad', style: 'margin-top:14px' }, [
    el('h3', { class: 't-h3' }, 'Retrieval stub'),
    el('div', { class: 'flex gap-2', style: 'margin:12px 0' }, [query, retrieve]),
    hits
  ]));
  await loadKnowledge(list);
}

async function loadKnowledge(host) {
  try {
    const out = await api('/api/knowledge');
    host.innerHTML = '';
    (out.entries || []).forEach((e) => {
      const del = el('button', { class: 'btn btn-ghost' }, 'Delete');
      del.onclick = async () => {
        try { await api('/api/knowledge/delete', { method: 'POST', body: { id: e.id } }); toast('Deleted.', 'ok'); await loadKnowledge(host); }
        catch (err) { toast(err.message, 'err'); }
      };
      const pub = el('button', { class: 'btn btn-ghost' }, e.status === 'published' ? 'Archive' : 'Publish');
      pub.onclick = async () => {
        try {
          await api('/api/knowledge/update', { method: 'POST', body: { id: e.id, title: e.title, content: e.content, sourceUrl: e.sourceUrl, status: e.status === 'published' ? 'archived' : 'published', tags: e.tags } });
          toast('Updated.', 'ok'); await loadKnowledge(host);
        } catch (err) { toast(err.message, 'err'); }
      };
      host.appendChild(el('article', { class: 'card ticket-card' }, [
        el('div', { class: 'flex items-center justify-between gap-2' }, [el('h3', { class: 't-h3' }, e.title), el('span', { class: 'pill' }, e.status)]),
        el('p', { class: 'muted' }, (e.content || e.sourceUrl || '').slice(0, 220)),
        el('div', { class: 'flex gap-2' }, [pub, del])
      ]));
    });
    if (!(out.entries || []).length) host.appendChild(el('div', { class: 'card card-pad muted' }, 'No knowledge entries yet.'));
  } catch (e) { host.innerHTML = ''; host.appendChild(el('div', { class: 'card card-pad muted' }, e.message)); }
}

async function viewIntegrations(root) {
  const isOwner = State.me && ['super_admin', 'admin', 'owner'].includes(State.me.user.role);
  root.appendChild(viewHead('Integrations', 'Webhook endpoints and CRM connectors. Secrets are hashed. CRM vendors are coming soon.'));
  const list = el('div', { class: 'ticket-list' }, skeleton('sk-card', 1));
  const crmHost = el('div', { class: 'grid grid-3', style: 'margin-top:14px' });
  root.appendChild(list);
  root.appendChild(crmHost);
  if (isOwner) {
    const name = el('input', { class: 'input', placeholder: 'CRM sync webhook' });
    const url = el('input', { class: 'input', placeholder: 'https://hooks.example.com/astra' });
    const secret = el('input', { class: 'input', type: 'password', placeholder: 'Shared secret, min 12 chars' });
    const events = el('select', { class: 'select', multiple: 'multiple', style: 'min-height:90px' }, [
      el('option', { value: 'lead.created', selected: 'selected' }, 'lead.created'),
      el('option', { value: 'call.completed' }, 'call.completed'),
      el('option', { value: 'campaign.started' }, 'campaign.started'),
      el('option', { value: 'campaign.completed' }, 'campaign.completed')
    ]);
    const create = el('button', { class: 'btn btn-primary' }, 'Add webhook');
    create.onclick = async () => {
      const selected = Array.from(events.selectedOptions || []).map((o) => o.value);
      create.disabled = true;
      try {
        const out = await api('/api/integrations/webhooks', { method: 'POST', body: { name: name.value.trim(), url: url.value.trim(), secret: secret.value, events: selected } });
        modal({
          title: 'Webhook secret (shown once)',
          body: el('div', {}, [el('p', {}, 'Store this secret now. Only its hash is saved.'), el('code', {}, out.secretOnce || '')]),
          confirmText: 'I saved it',
          onConfirm: async () => {}
        });
        name.value = ''; url.value = ''; secret.value = '';
        await loadIntegrations(list, crmHost);
      } catch (e) { toast(e.message, 'err'); } finally { create.disabled = false; }
    };
    const leadPhone = el('input', { class: 'input', placeholder: '+9198XXXXXXXX' });
    const leadName = el('input', { class: 'input', placeholder: 'Lead name' });
    const fireLead = el('button', { class: 'btn btn-ghost' }, 'Stub lead.created');
    fireLead.onclick = async () => {
      try {
        const out = await api('/api/integrations/lead-created', { method: 'POST', body: { phone: leadPhone.value.trim(), name: leadName.value.trim() } });
        toast('Queued to ' + (out.queued || 0) + ' webhook(s).', 'ok');
        await loadIntegrations(list, crmHost);
      } catch (e) { toast(e.message, 'err'); }
    };
    root.prepend(el('section', { class: 'card card-pad', style: 'margin-bottom:14px' }, [
      el('h3', { class: 't-h3' }, 'Register webhook'),
      field('Name', name), field('HTTPS URL', url), field('Secret', secret), field('Events', events), create,
      el('h3', { class: 't-h3', style: 'margin-top:18px' }, 'Outbound stub'),
      field('Lead phone', leadPhone), field('Lead name', leadName), fireLead
    ]));
  }
  await loadIntegrations(list, crmHost);
}

async function loadIntegrations(list, crmHost) {
  try {
    const out = await api('/api/integrations');
    list.innerHTML = '';
    list.appendChild(el('h3', { class: 't-h3', style: 'margin-bottom:12px' }, 'Webhooks'));
    (out.webhooks || []).forEach((w) => {
      const del = el('button', { class: 'btn btn-ghost' }, 'Delete');
      del.onclick = async () => {
        try { await api('/api/integrations/webhooks/delete', { method: 'POST', body: { id: w.id } }); toast('Webhook removed.', 'ok'); await loadIntegrations(list, crmHost); }
        catch (e) { toast(e.message, 'err'); }
      };
      list.appendChild(el('div', { class: 'admin-row' }, [
        el('div', {}, [el('b', {}, w.name), el('small', { class: 'muted' }, w.url + ' · ' + (w.events || []).join(', '))]),
        el('div', { class: 'flex gap-2' }, [el('span', { class: 'pill' }, w.secretConfigured ? 'secret set' : 'no secret'), del])
      ]));
    });
    if (!(out.webhooks || []).length) list.appendChild(el('div', { class: 'muted' }, 'No webhooks yet.'));
    crmHost.innerHTML = '';
    (out.crm || []).forEach((c) => crmHost.appendChild(el('div', { class: 'card card-pad' }, [
      el('h3', { class: 't-h3' }, c.label),
      el('p', { class: 'muted' }, 'Native ' + c.label + ' connector is coming soon. Use lead.created webhooks for now.'),
      el('span', { class: 'pill' }, c.status || 'coming_soon')
    ])));
  } catch (e) { list.innerHTML = ''; list.appendChild(el('div', { class: 'muted' }, e.message)); }
}

async function startRecharge(packId) {
  try {
    const out = await api('/api/payment-intents', { method: 'POST', body: { packId: packId } });
    const checkoutUrl = out.checkout && (out.checkout.action || out.checkout.url);
    if (checkoutUrl && out.checkout.fields) {
      const form = el('form', { method: 'POST', action: checkoutUrl });
      Object.keys(out.checkout.fields).forEach((k) => form.appendChild(el('input', { type: 'hidden', name: k, value: out.checkout.fields[k] })));
      document.body.appendChild(form); form.submit(); return;
    }
    toast(out.message || 'PayU checkout is not enabled yet. Your wallet was not charged.', 'info');
  } catch (e) { toast(e.message, 'err'); }
}

async function viewSupport(root) {
  root.appendChild(viewHead('Support', 'Open a ticket and keep every reply attached to your workspace.'));
  const subject = el('input', { class: 'input', placeholder: 'What do you need help with.' });
  const message = el('textarea', { class: 'input textarea', placeholder: 'Describe the issue, expected result, and what happened.' });
  const create = el('button', { class: 'btn btn-primary' }, 'Open ticket');
  const list = el('div', { class: 'ticket-list' }, skeleton('sk-card', 2));
  create.onclick = async () => {
    create.disabled = true;
    try {
      await api('/api/support/tickets', { method: 'POST', body: { subject: subject.value.trim(), message: message.value.trim(), priority: 'normal' } });
      subject.value = ''; message.value = ''; toast('Support ticket opened.', 'ok'); await loadTickets(list);
    } catch (e) { toast(e.message, 'err'); } finally { create.disabled = false; }
  };
  root.appendChild(el('div', { class: 'support-layout' }, [
    el('section', { class: 'card card-pad support-compose' }, [el('h3', { class: 't-h3' }, 'New ticket'), field('Subject', subject), field('Message', message), create]),
    list
  ]));
  await loadTickets(list);
}

async function loadTickets(host) {
  try {
    const out = await api('/api/support/tickets'); host.innerHTML = '';
    (out.tickets || []).forEach((t) => host.appendChild(ticketCard(t, false)));
    if (!(out.tickets || []).length) host.appendChild(el('div', { class: 'card card-pad muted' }, 'No support tickets yet.'));
  } catch (e) { host.innerHTML = ''; host.appendChild(el('div', { class: 'card card-pad muted' }, e.message)); }
}

function ticketCard(t, admin) {
  const messages = (t.messages || []).map((m) => el('div', { class: 'ticket-message' }, [
    el('b', {}, m.authorName || m.authorRole || 'User'), el('span', {}, m.message || m.body || '')
  ]));
  const reply = el('input', { class: 'input', placeholder: 'Write a reply.' });
  const send = el('button', { class: 'btn btn-ghost' }, 'Reply');
  send.onclick = async () => {
    const msg = reply.value.trim(); if (!msg) return;
    send.disabled = true;
    try {
      await api(admin ? '/api/admin/tickets/reply' : '/api/support/tickets/reply', { method: 'POST', body: { ticketId: t.id, message: msg } });
      toast('Reply sent.', 'ok'); onRoute();
    } catch (e) { toast(e.message, 'err'); } finally { send.disabled = false; }
  };
  const adminControls = admin ? el('div', { class: 'ticket-admin-controls' }, [
    (function () { const s = el('select', { class: 'select' }, ['open','in_progress','waiting_on_customer','resolved','closed'].map((v) => el('option', { value: v }, v.replace(/_/g, ' ')))); s.value = t.status || 'open'; s.setAttribute('data-ticket-status', t.id); return s; })(),
    (function () { const s = el('select', { class: 'select' }, ['low','normal','high','urgent'].map((v) => el('option', { value: v }, v))); s.value = t.priority || 'normal'; s.setAttribute('data-ticket-priority', t.id); return s; })(),
    el('button', { class: 'btn btn-ghost', onclick: async () => { const status = document.querySelector('[data-ticket-status="' + t.id + '"]').value; const priority = document.querySelector('[data-ticket-priority="' + t.id + '"]').value; await api('/api/admin/tickets/update', { method: 'POST', body: { ticketId: t.id, status: status, priority: priority } }); toast('Ticket updated.', 'ok'); onRoute(); } }, 'Update')
  ]) : null;
  return el('article', { class: 'card ticket-card' }, [
    el('div', { class: 'flex items-center justify-between gap-2' }, [el('h3', { class: 't-h3' }, t.subject), el('span', { class: 'pill' }, t.status || 'open')]),
    adminControls, ...messages, el('div', { class: 'ticket-reply' }, [reply, send])
  ]);
}

async function viewAdmin(root) {
  if (!State.me || !['super_admin', 'admin'].includes(State.me.user.role)) { goto('overview'); return; }
  const superAdmin = State.me.user.role === 'super_admin';
  root.appendChild(viewHead(
    superAdmin ? 'Diagnostics console' : 'Operations admin',
    superAdmin
      ? 'Super Admin only. Provider health, tenant overview, test credits, and audit. Customers never see this console. Secrets stay in .env.'
      : 'Support tickets, PayU events, and platform audit. Provider inventory and tenant controls require Super Admin.'
  ));
  const stats = el('div', { class: 'grid grid-3' }, skeleton('sk-stat', 5));
  const healthHost = el('div', { class: 'card card-pad admin-table' }, skeleton('sk-card', 1));
  const tenantHost = el('div', { class: 'card card-pad admin-table' }, skeleton('sk-card', 1));
  const ticketHost = el('div', { class: 'ticket-list' }, skeleton('sk-card', 2));
  const eventHost = el('div', { class: 'card card-pad admin-table' }, skeleton('sk-card', 1));
  const auditHost = el('div', { class: 'card card-pad admin-table' }, skeleton('sk-card', 1));
  root.appendChild(stats);
  root.appendChild(healthHost);
  root.appendChild(el('div', { class: 'admin-layout' }, [tenantHost, ticketHost]));
  root.appendChild(eventHost);
  root.appendChild(auditHost);
  try {
    const calls = [api('/api/admin/tickets'), api('/api/admin/payment-events'), api('/api/admin/audit')];
    if (superAdmin) {
      calls.unshift(
        api('/api/admin/overview'),
        api('/api/admin/tenants'),
        api('/api/admin/users'),
        api('/api/admin/diagnostics')
      );
    }
    const data = await Promise.all(calls);
    const o = superAdmin ? data[0] : { totals: {} };
    const ts = superAdmin ? data[1] : { tenants: [] };
    const users = superAdmin ? data[2] : { users: [] };
    const diagnostics = superAdmin ? data[3] : null;
    const offset = superAdmin ? 4 : 0;
    const tickets = data[offset];
    const events = data[offset + 1];
    const audit = data[offset + 2];
    stats.innerHTML = '';
    const totals = o.totals || {};
    const overview = (diagnostics && diagnostics.diagnostics && diagnostics.diagnostics.overview) || {};
    [['Workspaces', totals.tenants != null ? totals.tenants : (overview.tenants || 'Restricted')], ['Users', totals.users != null ? totals.users : (overview.users || 'Restricted')], ['Open tickets', totals.openTickets != null ? totals.openTickets : (tickets.tickets || []).filter((t) => t.status !== 'closed').length], ['Wallet total', superAdmin ? '₹' + fmtInr((totals.walletPaise || 0) / 100) : 'Restricted'], ['Calls', superAdmin ? (totals.calls != null ? totals.calls : overview.calls) : 'Restricted']].forEach((x) => stats.appendChild(statCard(x[0], String(x[1] || 0), 'All workspaces')));
    healthHost.innerHTML = '';
    if (superAdmin) {
      healthHost.appendChild(el('h3', { class: 't-h3', style: 'margin-bottom:12px' }, 'Provider health'));
      healthHost.appendChild(el('p', { class: 'muted', style: 'margin-bottom:12px' }, 'Super Admin diagnostics. Configured true/false and env key names only. Never shown to customers.'));
      const diag = diagnostics && diagnostics.diagnostics ? diagnostics.diagnostics : null;
      const layers = (diag && diag.providers) || {};
      Object.keys(layers).forEach((layer) => {
        (layers[layer] || []).forEach((p) => {
          healthHost.appendChild(el('div', { class: 'admin-row' }, [
            el('div', {}, [el('b', {}, (p.label || p.id) + ' · ' + layer), el('small', { class: 'muted' }, (p.needs || []).join(', ') || 'No env keys')]),
            el('span', { class: 'pill' }, p.configured ? 'configured' : 'missing')
          ]));
        });
      });
      if (diag && diag.deploy) {
        healthHost.appendChild(el('p', { class: 'muted', style: 'margin-top:12px' },
          'Deploy ' + (diag.deploy.gitSha || 'unknown sha') +
          (diag.deploy.version ? (' · v' + diag.deploy.version) : '') +
          (diag.schemaVersion != null ? (' · schema v' + diag.schemaVersion) : '')
        ));
      }
    } else {
      healthHost.appendChild(el('h3', { class: 't-h3', style: 'margin-bottom:12px' }, 'Provider health'));
      healthHost.appendChild(el('div', { class: 'muted' }, 'Provider inventory is Super Admin only. Operations admins use tickets, PayU events, and audit below.'));
    }
    tenantHost.innerHTML = ''; tenantHost.appendChild(el('h3', { class: 't-h3' }, 'Workspaces'));
    if (superAdmin) (ts.tenants || []).forEach((t) => tenantHost.appendChild(adminTenantRow(t, (users.users || []).filter((u) => u.tenantId === t.id))));
    else tenantHost.appendChild(el('div', { class: 'muted' }, 'Workspace controls require Super Admin access.'));
    if (superAdmin) {
      const usersCard = el('div', { class: 'card card-pad', style: 'margin-top:12px' }, [el('h3', { class: 't-h3' }, 'Users')]);
      (users.users || []).slice(0, 40).forEach((u) => usersCard.appendChild(el('div', { class: 'admin-row' }, [
        el('div', {}, [el('b', {}, u.email), el('small', { class: 'muted' }, (u.name || '') + ' · ' + (u.role || ''))]),
        el('span', { class: 'pill' }, u.status || 'active')
      ])));
      tenantHost.appendChild(usersCard);
    }
    ticketHost.innerHTML = ''; (tickets.tickets || []).forEach((t) => ticketHost.appendChild(ticketCard(t, true)));
    eventHost.innerHTML = ''; eventHost.appendChild(el('h3', { class: 't-h3' }, 'PayU webhook log'));
    (events.events || []).slice(0, 25).forEach((e) => eventHost.appendChild(el('div', { class: 'admin-row' }, [el('div', {}, [el('b', {}, e.txnid || 'Unknown transaction'), el('small', { class: 'muted' }, (e.reason || '') + ' · ' + (e.createdAt || ''))]), el('span', { class: 'pill' }, e.status || 'received')])));
    if (!(events.events || []).length) eventHost.appendChild(el('div', { class: 'muted' }, 'No PayU webhooks received yet.'));
    auditHost.innerHTML = '';
    auditHost.appendChild(el('h3', { class: 't-h3', style: 'margin-bottom:12px' }, 'Platform audit'));
    (audit.auditEvents || []).slice(0, 40).forEach((e) => auditHost.appendChild(el('div', { class: 'admin-row' }, [
      el('div', {}, [el('b', {}, e.action || 'event'), el('small', { class: 'muted' }, (e.targetType || '') + ' ' + (e.targetId || '') + ' · ' + (e.createdAt || ''))]),
      el('span', { class: 'pill' }, e.tenantId || 'platform')
    ])));
    if (!(audit.auditEvents || []).length) auditHost.appendChild(el('div', { class: 'muted' }, 'No audit events yet.'));
  } catch (e) { tenantHost.innerHTML = ''; tenantHost.appendChild(el('div', { class: 'muted' }, e.message)); }
}

function adminTenantRow(t, users) {
  const wallet = t.wallet || {};
  const toggle = el('button', { class: 'btn btn-ghost' }, t.status === 'suspended' ? 'Reactivate' : 'Suspend');
  toggle.onclick = async () => {
    const status = t.status === 'suspended' ? 'active' : 'suspended';
    await api('/api/admin/tenants/status', { method: 'POST', body: { tenantId: t.id, status: status } });
    toast('Tenant set to ' + status + '.', 'ok'); onRoute();
  };
  const credit = el('button', { class: 'btn btn-ghost', onclick: () => adjustWallet(t) }, 'Adjust credit');
  const testCredit = el('button', { class: 'btn btn-ghost', onclick: () => grantTestCredits(t) }, 'Test credits');
  const inspect = el('button', { class: 'btn btn-primary', onclick: () => inspectTenant(t, users || []) }, 'Open workspace');
  return el('div', { class: 'admin-row' }, [
    el('div', {}, [el('b', {}, t.name), el('small', { class: 'muted' }, (t.users || 0) + ' users, ₹' + fmtInr((wallet.balancePaise || 0) / 100))]),
    el('span', { class: 'pill' }, t.status || 'active'), el('div', { class: 'flex gap-2' }, [inspect, testCredit, credit, toggle])
  ]);
}

async function inspectTenant(t, users) {
  const out = await api('/api/admin/tenant-detail?tenantId=' + encodeURIComponent(t.id));
  const tabs = [
    ['Users', (out.users || []).map((u) => u.name + ' · ' + u.email + ' · ' + u.role)],
    ['Agents', (out.agents || []).map((a) => a.name + ' · ' + ((a.telephony || {}).did || 'No number'))],
    ['Numbers', (out.numbers || []).map((n) => n.address + ' · ' + n.provider + ' · ' + n.status)],
    ['Calls', (out.usage || []).map((u) => u.day + ' · ' + (u.calls || 0) + ' calls')],
    ['Billing', (out.ledger || []).map((x) => (x.type || 'entry') + ' · ₹' + fmtInr((x.amountPaise || 0) / 100))],
    ['Support', (out.tickets || []).map((x) => x.subject + ' · ' + x.status)]
  ];
  const body = el('div', { class: 'tenant-inspector' }, tabs.map((tab) => el('section', {}, [el('h4', {}, tab[0]), ...(tab[1].length ? tab[1].map((line) => el('div', { class: 'inspector-line' }, line)) : [el('div', { class: 'muted' }, 'No records')])])));
  const user = (out.users || []).find((u) => u.role !== 'super_admin' && u.status === 'active');
  if (user) body.prepend(el('button', { class: 'btn btn-dark', onclick: () => startImpersonation(user) }, 'View as ' + user.email));
  modal({ title: out.tenant.name, body: body, confirmText: 'Close', onConfirm: async () => {} });
}

function startImpersonation(user) {
  const reason = el('input', { class: 'input', placeholder: 'Support ticket or investigation reason' });
  const password = el('input', { class: 'input', type: 'password', placeholder: 'Your super admin password' });
  modal({ title: 'View as ' + user.email, body: el('div', {}, [el('p', {}, 'This creates a 30 minute read-only user session. Billing, roles, status, and secrets remain blocked.'), field('Reason', reason), field('Re-enter your password', password)]), confirmText: 'Enter user view', onConfirm: async () => {
    await api('/api/admin/impersonations', { method: 'POST', body: { userId: user.id, reason: reason.value.trim(), password: password.value } });
    State.me = await api('/api/me'); renderShell(); goto('overview');
  }});
}

function adjustWallet(t) {
  const amount = el('input', { class: 'input', type: 'number', step: '0.01', placeholder: '100.00' });
  const reason = el('input', { class: 'input', placeholder: 'Required adjustment reason' });
  modal({ title: 'Adjust ' + t.name + ' wallet', body: el('div', {}, [field('Amount in INR, negative deducts', amount), field('Reason', reason)]), confirmText: 'Apply adjustment', onConfirm: async () => {
    const paise = Math.round(Number(amount.value) * 100);
    await api('/api/admin/wallet/adjust', { method: 'POST', body: { tenantId: t.id, amountPaise: paise, reason: reason.value.trim(), idempotencyKey: 'ui_' + Date.now() + '_' + Math.random().toString(36).slice(2) } });
    toast('Wallet adjusted.', 'ok'); onRoute();
  }});
}

function grantTestCredits(t) {
  const amount = el('input', { class: 'input', type: 'number', step: '0.01', min: '0.01', placeholder: '50.00' });
  const reason = el('input', { class: 'input', placeholder: 'QA / sandbox test credits' });
  modal({ title: 'Grant test credits to ' + t.name, body: el('div', {}, [
    el('p', { class: 'muted' }, 'Positive test credits only. Customers see balance, not this Super Admin grant path.'),
    field('Amount in INR', amount),
    field('Reason', reason),
  ]), confirmText: 'Grant test credits', onConfirm: async () => {
    const paise = Math.round(Number(amount.value) * 100);
    if (!Number.isInteger(paise) || paise <= 0) throw new Error('Enter a positive INR amount.');
    await api('/api/admin/wallet/test-credits', {
      method: 'POST',
      body: {
        tenantId: t.id,
        amountPaise: paise,
        reason: reason.value.trim() || 'test credits',
        idempotencyKey: 'ui_test_' + Date.now() + '_' + Math.random().toString(36).slice(2),
      },
    });
    toast('Test credits granted.', 'ok'); onRoute();
  }});
}

/* ===========================================================================
   7. SETTINGS
   =========================================================================== */
async function viewSettings(root) {
  root.appendChild(viewHead('Settings', 'Workspace identity, members, audit history, and implemented providers. Secrets stay in server .env only.'));

  const provHost = el('div', { id: 'provHost' }, skeleton('sk-card', 3));
  root.appendChild(provHost);

  const t = State.me.tenant;
  const isOwner = State.me && ['super_admin', 'admin', 'owner'].includes(State.me.user.role);
  const nameI = el('input', { class: 'input', id: 'set_name', type: 'text', value: t.name || '' });
  const colorVal = (t.branding && t.branding.color) || '#6B21A8';
  const colorI = el('input', { type: 'color', id: 'set_color', value: colorVal });
  const colorHex = el('input', { class: 'input', id: 'set_color_hex', value: colorVal, style: 'max-width:130px;font-family:var(--mono)' });
  colorI.addEventListener('input', () => { colorHex.value = colorI.value; });
  colorHex.addEventListener('input', () => { if (/^#[0-9a-fA-F]{6}$/.test(colorHex.value)) colorI.value = colorHex.value; });

  const saveBtn = el('button', { class: 'btn btn-primary' }, 'Save workspace settings');
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true; saveBtn.textContent = 'Saving...';
    try {
      const out = await api('/api/tenant/update', { method: 'POST', body: { name: nameI.value.trim(), color: colorI.value } });
      State.me.tenant = out.tenant || Object.assign({}, State.me.tenant, { name: nameI.value.trim(), branding: Object.assign({}, State.me.tenant.branding, { color: colorI.value }) });
      const tn = $('.tenant-chip .tn'); if (tn) { tn.textContent = State.me.tenant.name; tn.title = State.me.tenant.name; }
      const av = $('.tenant-chip .av'); if (av) av.textContent = initials(State.me.tenant.name);
      toast('Workspace settings saved.', 'ok');
    } catch (ex) {
      toast(ex.message || 'Save failed.', 'err');
    } finally {
      saveBtn.disabled = false; saveBtn.textContent = 'Save workspace settings';
    }
  });
  if (!isOwner) { saveBtn.disabled = true; nameI.disabled = true; colorI.disabled = true; colorHex.disabled = true; }

  root.appendChild(el('div', { class: 'card card-pad', style: 'margin-top:8px' }, [
    el('h3', { class: 't-h3', style: 'margin-bottom:16px' }, 'Workspace'),
    el('p', { class: 'muted', style: 'margin-bottom:12px' }, 'Organization and workspace map to this tenant record. Plan: ' + (t.plan || 'starter') + '.'),
    el('div', { class: 'settings-form' }, [
      field('Workspace name', nameI),
      el('div', { class: 'field' }, [el('label', {}, 'Brand color'), el('div', { class: 'color-row' }, [colorI, colorHex])]),
      el('div', { class: 'flex gap-2', style: 'margin-top:6px' }, [saveBtn, el('button', { class: 'btn btn-ghost', onclick: doLogout }, 'Sign out')])
    ])
  ]));

  if (isOwner) {
    const membersHost = el('div', { class: 'card card-pad', style: 'margin-top:12px' }, [el('h3', { class: 't-h3' }, 'Members'), el('div', { class: 'muted' }, 'Loading...')]);
    const auditHost = el('div', { class: 'card card-pad', style: 'margin-top:12px' }, [el('h3', { class: 't-h3' }, 'Audit log'), el('div', { class: 'muted' }, 'Loading...')]);
    root.appendChild(membersHost);
    root.appendChild(auditHost);
    Promise.all([api('/api/members'), api('/api/audit')]).then(([members, audit]) => {
      membersHost.innerHTML = '';
      membersHost.appendChild(el('h3', { class: 't-h3', style: 'margin-bottom:12px' }, 'Members'));
      (members.users || []).forEach((u) => {
        const roleSel = el('select', { class: 'select' }, [
          el('option', { value: 'owner' }, 'owner'),
          el('option', { value: 'member' }, 'member')
        ]);
        roleSel.value = u.role === 'owner' ? 'owner' : 'member';
        const saveRole = el('button', { class: 'btn btn-ghost' }, 'Update role');
        saveRole.onclick = async () => {
          try {
            await api('/api/members/role', { method: 'POST', body: { userId: u.id, role: roleSel.value } });
            toast('Member role updated.', 'ok');
          } catch (e) { toast(e.message, 'err'); }
        };
        membersHost.appendChild(el('div', { class: 'admin-row' }, [
          el('div', {}, [el('b', {}, u.email), el('small', { class: 'muted' }, u.name || '')]),
          ['super_admin', 'admin'].includes(u.role) ? el('span', { class: 'pill' }, u.role) : el('div', { class: 'flex gap-2' }, [roleSel, saveRole])
        ]));
      });
      auditHost.innerHTML = '';
      auditHost.appendChild(el('h3', { class: 't-h3', style: 'margin-bottom:12px' }, 'Audit log'));
      auditHost.appendChild(el('p', { class: 'muted', style: 'margin-bottom:12px' }, 'Sensitive workspace actions for owners. Raw secrets are never stored here.'));
      (audit.auditEvents || []).slice(0, 50).forEach((e) => {
        auditHost.appendChild(el('div', { class: 'ledger-row' }, [
          el('div', {}, [el('div', {}, e.action || 'event'), el('small', { class: 'muted' }, (e.targetType || '') + ' ' + (e.targetId || '') + ' · ' + (e.createdAt || ''))]),
          el('span', { class: 'pill' }, e.actorUserId ? 'actor' : 'system')
        ]));
      });
      if (!(audit.auditEvents || []).length) auditHost.appendChild(el('div', { class: 'muted' }, 'No audit events yet.'));
    }).catch((e) => {
      membersHost.appendChild(el('div', { class: 'muted' }, e.message));
      auditHost.appendChild(el('div', { class: 'muted' }, e.message));
    });
  }

  const privacySelect = el('select', { class: 'select', id: 'privacy_mode' }, [
    el('option', { value: 'standard' }, 'Standard retention'),
    el('option', { value: 'metadata_only' }, 'Privacy mode, metadata only'),
    el('option', { value: 'no_recording' }, 'HIPAA mode, no recording or transcript retention')
  ]);
  const privacySave = el('button', { class: 'btn btn-primary' }, 'Save privacy mode');
  privacySave.onclick = async () => {
    privacySave.disabled = true;
    try { await api('/api/privacy', { method: 'POST', body: { mode: privacySelect.value } }); toast('Privacy mode saved.', 'ok'); }
    catch (e) { toast(e.message, 'err'); } finally { privacySave.disabled = false; }
  };
  const provider = el('select', { class: 'select' }, [el('option', { value: 'vobiz' }, 'Bring your own trunk'), el('option', { value: 'telnyx' }, 'Telnyx'), el('option', { value: 'sip' }, 'SIP trunk')]);
  const address = el('input', { class: 'input', placeholder: 'Verified E.164 number or SIP address' });
  const label = el('input', { class: 'input', placeholder: 'Main sales line' });
  const byonList = el('div', { class: 'byon-list muted' }, 'Loading connections...');
  const byonSave = el('button', { class: 'btn btn-ghost' }, 'Connect my number');
  byonSave.onclick = async () => {
    byonSave.disabled = true;
    try { await api('/api/byon', { method: 'POST', body: { provider: provider.value, address: address.value.trim(), label: label.value.trim() } }); toast('Number connection saved for verification.', 'ok'); await loadByon(byonList); }
    catch (e) { toast(e.message, 'err'); } finally { byonSave.disabled = false; }
  };
  root.appendChild(el('div', { class: 'settings-split' }, [
    el('section', { class: 'card card-pad' }, [
      el('h3', { class: 't-h3' }, 'Privacy and HIPAA mode'),
      el('p', { class: 'muted privacy-copy' }, 'HIPAA mode disables recording and transcript retention in Astra AI. It does not by itself make your organization HIPAA compliant. You still need appropriate provider BAAs, policies, access controls, consent, and legal review.'),
      field('Retention policy', privacySelect), privacySave
    ]),
    el('section', { class: 'card card-pad' }, [
      el('h3', { class: 't-h3' }, 'Bring your own number'),
      el('p', { class: 'muted privacy-copy' }, 'Connect only a number or SIP address that your organization owns and has verified with the carrier.'),
      field('Provider', provider), field('Number or SIP address', address), field('Label', label), byonSave, byonList
    ])
  ]));
  Promise.all([
    api('/api/privacy').then((x) => { privacySelect.value = x.mode || 'standard'; }),
    loadByon(byonList)
  ]).catch(() => {});

  try {
    const reg = await ensureProviders();
    paintProviders(provHost, reg);
  } catch (e) {
    provHost.innerHTML = '';
    provHost.appendChild(el('div', { class: 'card card-pad muted' }, 'Could not load providers. ' + esc(e.message)));
  }
}

async function loadByon(host) {
  const out = await api('/api/byon'); host.innerHTML = '';
  (out.connections || []).forEach((x) => host.appendChild(el('div', { class: 'status-line' }, [
    el('span', { class: 'k' }, x.label || x.provider), el('span', { class: 'v' }, (x.address || '') + ' · ' + (x.status || 'pending'))
  ])));
  if (!(out.connections || []).length) host.textContent = 'No number connected yet.';
}

function paintProviders(host, reg) {
  host.innerHTML = '';
  const layers = [
    { key: 'tts', label: 'Text to speech' },
    { key: 'llm', label: 'Brain, LLM' },
    { key: 'telephony', label: 'Telephony' }
  ];
  layers.forEach((L) => {
    const list = reg[L.key] || [];
    const wrap = el('div', { class: 'prov-layer' }, [
      el('div', { class: 'lh' }, [el('span', { class: 'lt' }, L.label)]),
      el('div', { class: 'prov-grid' }, list.length ? list.map(provCard) : [el('div', { class: 'muted' }, 'No providers registered.')])
    ]);
    host.appendChild(wrap);
  });
}
function provCard(p) {
  const live = !!p.live;
  const selected = !!p.selected;
  const needs = p.needs || [];
  return el('div', { class: 'card prov-card' }, [
    el('div', { class: 'pc-top' }, [
      el('div', { class: 'pc-name' }, p.label || p.id),
      selected && live
        ? el('span', { class: 'badge-live' }, [el('span', { class: 'd' }), 'Selected'])
        : live
          ? el('span', { class: 'badge-ready' }, [el('span', { class: 'd' }), 'Configured'])
          : el('span', { class: 'badge-ready' }, [el('span', { class: 'd' }), 'Needs setup'])
    ]),
    selected && live
      ? el('div', { class: 'pc-needs' }, 'Default provider for dashboard-owned requests.')
      : live
        ? el('div', { class: 'pc-needs' }, 'Credentials available. Select it through trusted server configuration.')
      : el('div', { class: 'pc-needs' }, needs.length
          ? ['To enable, add ', ...needs.flatMap((n, i) => i ? [document.createTextNode(', '), el('code', {}, n)] : [el('code', {}, n)]), document.createTextNode(' to your .env.')]
          : 'Adapter is implemented but not configured.')
  ]);
}

/* ===========================================================================
   START
   =========================================================================== */
let _booted = false;
function bootOnce() { if (_booted) return; _booted = true; boot(); }
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootOnce);
else bootOnce();
