// canary-cry fixture app (#608 P3): a tiny shop with PLANTED state bugs, for
// the cry-e2e suite. node:http only, no dependencies, in memory.
//
// `variant: 'buggy'` plants the bugs canary-cry exists to catch:
//   - double-submit: the pay and save-address buttons have no in-flight
//     guard and the server stores every POST, so a double click writes twice
//     (multi-submit, stale-optimistic, duplicate-tab -> corrupted)
//   - abandon-midflow: re-entering the flow saves the address again
//   - shared-machine: sign-in remembers the FIRST user's email in
//     localStorage and the cart shows it, so the next user on the machine
//     sees it (a cross-account-leak symptom)
//   - token-expiry: a cart remembers the user who opened it, and an address
//     saved with no session is filed under that owner, while the payment is
//     a guest's. An expired session half-completes the owner's checkout: one
//     row of the two (#1720; token-expiry -> corrupted)
// `variant: 'fixed'` guards the buttons, makes both writes idempotent per
// cart, stores the current user's email, and never files a write made with no
// session under any account: a correct app refusing an unauthenticated write,
// as far as the account's state can tell.
//
// Every page also loads a pixel from egress.cry-e2e.invalid, a host no
// target declares, so the egress lockdown has something to abort (SC13).

import http from 'node:http';

const EGRESS = 'http://egress.cry-e2e.invalid/pixel.gif';

const page = (body, script = '') =>
  `<!doctype html><html><body>${body}<img src="${EGRESS}" alt="">` +
  `<script>${script}</script></body></html>`;

const post = (path, body) =>
  `fetch('${path}', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(${body}) })`;

function loginPage(fixed) {
  const remember = fixed
    ? "localStorage.setItem('cry.profile', email.value);"
    : "if (!localStorage.getItem('cry.profile')) localStorage.setItem('cry.profile', email.value);";
  return page(
    '<form id="f"><input name="email"><input name="password" type="password">' +
      '<button type="submit">Sign in</button></form><p id="who"></p>',
    `const email = document.querySelector('[name=email]');
     const pw = document.querySelector('[name=password]');
     document.getElementById('f').onsubmit = (e) => {
       e.preventDefault();
       ${post('/api/session', '{ email: email.value, password: pw.value }')}
         .then((r) => { if (r.ok) { ${remember} document.getElementById('who').textContent = 'Signed in'; } });
     };`,
  );
}

const logoutPage = () =>
  page(
    '<button id="sign-out">Sign out</button>',
    `document.getElementById('sign-out').onclick = () => ${post('/api/logout', '{}')};`,
  );

/** A write button: guarded and disabled while in flight only when fixed. */
const writeButton = (id, path, body, done, fixed) => `
  {
    const b = document.getElementById('${id}');
    let busy = false;
    b.onclick = () => {
      ${fixed ? 'if (busy) return; busy = true; b.disabled = true;' : ''}
      ${post(path, body)}.then((r) => {
        busy = false; b.disabled = false;
        if (r.ok) document.getElementById('status').textContent = '${done}';
        else document.querySelector('.error-banner').hidden = false;
      });
    };
  }`;

function cartPage(fixed) {
  return page(
    '<p>Ship to: <span id="ship"></span></p>' +
      '<input name="line" value="1 Main St"><button id="save-address">Save address</button>' +
      '<input name="card"><button id="pay">Pay</button>' +
      '<p id="status"></p><p class="error-banner" hidden>Payment failed</p>',
    `document.getElementById('ship').textContent = localStorage.getItem('cry.profile') || '';
     ${writeButton('save-address', '/api/addresses', '{ line: document.querySelector("[name=line]").value }', 'Address saved', fixed)}
     ${writeButton('pay', '/api/orders', '{ card: document.querySelector("[name=card]").value }', 'Order placed', fixed)}`,
  );
}

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k) out[k] = v.join('=');
  }
  return out;
}

function readBody(req) {
  return new Promise((done) => {
    let text = '';
    req.on('data', (c) => (text += c));
    req.on('end', () => {
      try {
        done(JSON.parse(text || '{}'));
      } catch {
        done({});
      }
    });
  });
}

function send(res, status, body, headers = {}) {
  const json = typeof body !== 'string';
  res.writeHead(status, {
    'content-type': json ? 'application/json' : 'text/html',
    ...headers,
  });
  res.end(json ? JSON.stringify(body) : body);
}

/** A write that the fixed variant keeps to one row per cart. */
function store(state, table, user, cart, row) {
  const rows = state[table];
  if (state.fixed && rows.some((r) => r.cart === cart)) return;
  rows.push({ ...row, user, cart });
}

/** Buggy: a write with no session is filed under the cart's owner. */
function addressOwner(state, ctx) {
  if (state.fixed || ctx.user !== 'guest') return ctx.user;
  return state.owners.get(ctx.cart) ?? 'guest';
}

function makeHandler(state) {
  const routes = {
    'GET /': () => [200, page('<p>cry fixture</p>')],
    'GET /login': () => [200, loginPage(state.fixed)],
    'GET /logout': () => [200, logoutPage()],
    'GET /cart': (ctx) => {
      const cart = ctx.cart ?? `c${(state.carts += 1)}`;
      if (ctx.user !== 'guest') state.owners.set(cart, ctx.user);
      return [
        200,
        cartPage(state.fixed),
        { 'set-cookie': `cart=${cart}; Path=/` },
      ];
    },
    'POST /api/session': async (ctx) => {
      const { email, password } = await readBody(ctx.req);
      const user = state.users.find(
        (u) => u.email === email && u.password === password,
      );
      if (!user) return [401, { error: 'bad credentials' }];
      const token = `t${(state.tokens += 1)}`;
      state.sessions.set(token, user);
      return [200, { ok: true }, { 'set-cookie': `session=${token}; Path=/` }];
    },
    'POST /api/logout': (ctx) => {
      state.sessions.delete(ctx.session);
      return [
        200,
        { ok: true },
        { 'set-cookie': 'session=; Path=/; Max-Age=0' },
      ];
    },
    'POST /api/orders': async (ctx) => {
      const body = await readBody(ctx.req);
      store(state, 'orders', ctx.user, ctx.cart, { card: body.card });
      // Fixed: a placed order consumes the cart, so the next flow starts fresh.
      const done = state.fixed
        ? { 'set-cookie': 'cart=; Path=/; Max-Age=0' }
        : {};
      return [200, { ok: true }, done];
    },
    'POST /api/addresses': async (ctx) => {
      const body = await readBody(ctx.req);
      const user = addressOwner(state, ctx);
      store(state, 'addresses', user, ctx.cart, { line: body.line });
      return [200, { ok: true }];
    },
    'GET /api/orders': (ctx) => [
      200,
      state.orders.filter((o) => o.user === ctx.query),
    ],
    'GET /api/addresses': (ctx) => [
      200,
      state.addresses.filter((a) => a.user === ctx.query),
    ],
    // Both rows of one checkout: a whole completion adds 2, a refusal 0.
    'GET /api/checkout': (ctx) => [
      200,
      [...state.addresses, ...state.orders].filter((r) => r.user === ctx.query),
    ],
  };
  return async (req, res) => {
    const url = new URL(req.url, 'http://fixture');
    const jar = cookies(req);
    const session = jar.session;
    const ctx = {
      req,
      session,
      cart: jar.cart,
      user: String(state.sessions.get(session)?.id ?? 'guest'),
      query: url.searchParams.get('user'),
    };
    const route = routes[`${req.method} ${url.pathname}`];
    if (!route) return send(res, 404, { error: 'not found' });
    const [status, body, headers] = await route(ctx);
    return send(res, status, body, headers);
  };
}

/**
 * Start the fixture on 127.0.0.1.
 * @param {{variant?: 'buggy' | 'fixed', users: {email: string,
 *   password: string, id: string}[], port?: number}} options
 */
export function startApp({ variant = 'buggy', users, port = 0 }) {
  const state = {
    fixed: variant === 'fixed',
    users,
    sessions: new Map(),
    tokens: 0,
    carts: 0,
    owners: new Map(),
    orders: [],
    addresses: [],
  };
  const server = http.createServer(makeHandler(state));
  return new Promise((done) => {
    server.listen(port, '127.0.0.1', () => {
      const { port: bound } = server.address();
      done({
        url: `http://127.0.0.1:${bound}`,
        state,
        close: () => new Promise((closed) => server.close(closed)),
      });
    });
  });
}
