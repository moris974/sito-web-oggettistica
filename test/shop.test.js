'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { createApp } = require('../server');
const { loadConfig } = require('../lib/config');
const shop = require('../lib/shop');
const { tsFromMs } = require('../lib/util');
const { toPgSql } = require('../lib/db');

// TEST_PG_SIM=1 -> l'app usa l'adapter Postgres con un finto driver (vedi test/helpers/fakepg.js)
const PG_SIM = process.env.TEST_PG_SIM === '1';
const dbOptions = () => (PG_SIM ? { pg: require('./helpers/fakepg') } : {});
const dbEnv = () => (PG_SIM ? { DATABASE_URL: 'postgres://simulato' } : {});

const WHSEC = 'whsec_test_secret';
let app, base, mock, mockBase, tmp, cookie;
const mockCalls = [];

function startMock() {
  return new Promise((resolve) => {
    mock = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        mockCalls.push({ url: req.url, method: req.method, body, auth: req.headers.authorization });
        const send = (o, s = 200) => {
          res.writeHead(s, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(o));
        };
        if (req.url === '/v1/checkout/sessions') return send({ id: 'cs_test_1', url: 'https://checkout.stripe.test/pay/cs_test_1' });
        if (req.url === '/v1/oauth2/token') return send({ access_token: 'pp_token' });
        if (req.url === '/v2/checkout/orders') {
          return send({ id: 'PP-ORDER-1', links: [{ rel: 'approve', href: 'https://paypal.test/approve/PP-ORDER-1' }] });
        }
        if (req.url.startsWith('/v2/checkout/orders/') && req.url.endsWith('/capture')) {
          const total = mock.captureValue;
          return send({
            status: 'COMPLETED',
            purchase_units: [{ payments: { captures: [{ id: 'CAP-1', status: 'COMPLETED', amount: { currency_code: 'EUR', value: total } }] } }],
          });
        }
        send({ error: 'unknown' }, 404);
      });
    });
    mock.listen(0, '127.0.0.1', () => {
      mockBase = `http://127.0.0.1:${mock.address().port}`;
      resolve();
    });
  });
}

async function api(p, { method = 'GET', body, auth = false, headers = {}, raw } = {}) {
  const h = { ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (auth) {
    h.Cookie = cookie;
    h['X-Requested-With'] = 'fetch';
  }
  const res = await fetch(base + p, { method, headers: h, body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined), redirect: 'manual' });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non json */ }
  return { status: res.status, json, text, headers: res.headers };
}

const customer = { name: 'Laura Rossi', email: 'laura@example.com', phone: '+39 340 1234567', address: 'Via Roma 1', city: 'Milano', zip: '20100', notes: '' };

function stripeEvent(type, order, overrides = {}) {
  return {
    id: 'evt_1',
    type,
    data: {
      object: {
        id: 'cs_test_1',
        client_reference_id: order,
        payment_status: 'paid',
        currency: 'eur',
        payment_intent: 'pi_123',
        ...overrides,
      },
    },
  };
}
function signed(event, secret = WHSEC, ts = Math.floor(Date.now() / 1000)) {
  const raw = JSON.stringify(event);
  const sig = crypto.createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex');
  return { raw, headers: { 'Stripe-Signature': `t=${ts},v1=${sig}`, 'Content-Type': 'application/json' } };
}

before(async () => {
  await startMock();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-test-'));
  const cfg = loadConfig({
    PORT: '0',
    BASE_URL: 'http://localhost:3999',
    DATA_DIR: tmp,
    ADMIN_USER: 'boss',
    ADMIN_PASSWORD: 'una-password-lunga-1',
    STRIPE_SECRET_KEY: 'sk_test_x',
    STRIPE_WEBHOOK_SECRET: WHSEC,
    STRIPE_API_BASE: mockBase,
    PAYPAL_CLIENT_ID: 'id',
    PAYPAL_CLIENT_SECRET: 'secret',
    PAYPAL_API_BASE: mockBase,
    ...dbEnv(),
  });
  app = await createApp(cfg, dbOptions());
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(async () => {
  await app.close();
  await new Promise((r) => mock.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('config pubblica e prodotti seed', async () => {
  const c = await api('/api/config');
  assert.equal(c.status, 200);
  assert.deepEqual(c.json.methods.map((m) => m.id), ['stripe', 'paypal']);
  assert.ok(!JSON.stringify(c.json).includes('admin_hash'));
  const p = await api('/api/products');
  assert.equal(p.json.products.length, 3);
  assert.equal(p.json.products.find((x) => x.coupon?.code === 'FIOCCO25').priceCents, 2800);
});

test('preventivo: coupon per prodotto, coupon globale, spedizione', async () => {
  const p = (await api('/api/products')).json.products;
  const fiocco = p.find((x) => x.coupon?.code === 'FIOCCO25');
  let q = await api('/api/cart/quote', { method: 'POST', body: { items: [{ id: fiocco.id, qty: 1 }], coupon: 'fiocco25' } });
  assert.equal(q.status, 200);
  assert.equal(q.json.lines[0].unitCents, 2100); // 28.00 -25%
  assert.equal(q.json.shippingCents, 600);
  assert.equal(q.json.totalCents, 2700);

  q = await api('/api/cart/quote', { method: 'POST', body: { items: [{ id: fiocco.id, qty: 3 }], coupon: 'NATALE15' } });
  assert.equal(q.json.lines[0].unitCents, 2380);
  assert.equal(q.json.shippingCents, 0); // 71.40 >= 60.00 -> gratis
  assert.equal(q.json.totalCents, 7140);

  // coupon di un altro prodotto
  const bombo = p.find((x) => x.coupon?.code === 'BOMBO15');
  q = await api('/api/cart/quote', { method: 'POST', body: { items: [{ id: bombo.id, qty: 1 }], coupon: 'FIOCCO25' } });
  assert.equal(q.status, 400);
  q = await api('/api/cart/quote', { method: 'POST', body: { items: [{ id: bombo.id, qty: 1 }], coupon: 'INVENTATO' } });
  assert.equal(q.status, 400);
});

test('input malevoli sul carrello vengono rifiutati', async () => {
  for (const items of [[], [{ id: 1, qty: -1 }], [{ id: 'x', qty: 1 }], [{ id: 1, qty: 1.5 }], [{ id: 1, qty: 1000 }], 'boh', [{ id: 9999, qty: 1 }]]) {
    const q = await api('/api/cart/quote', { method: 'POST', body: { items } });
    assert.ok(q.status === 400 || q.status === 409, `items=${JSON.stringify(items)} -> ${q.status}`);
  }
  const q = await api('/api/cart/quote', { method: 'POST', raw: '{non json', headers: { 'Content-Type': 'application/json' } });
  assert.equal(q.status, 400);
});

test('admin: login, sessione, CSRF, accesso negato', async () => {
  let r = await api('/api/admin/products');
  assert.equal(r.status, 401);

  r = await api('/api/admin/login', { method: 'POST', body: { username: 'boss', password: 'sbagliata' }, headers: { 'X-Requested-With': 'fetch' } });
  assert.equal(r.status, 401);

  r = await api('/api/admin/login', { method: 'POST', body: { username: 'boss', password: 'una-password-lunga-1' } });
  assert.equal(r.status, 403); // manca header CSRF

  r = await api('/api/admin/login', { method: 'POST', body: { username: 'boss', password: 'una-password-lunga-1' }, headers: { 'X-Requested-With': 'fetch' } });
  assert.equal(r.status, 200);
  const sc = r.headers.get('set-cookie');
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /SameSite=Strict/);
  cookie = sc.split(';')[0];

  r = await api('/api/admin/me', { auth: true });
  assert.equal(r.status, 200);

  // mutazione con cookie ma senza header X-Requested-With
  r = await api('/api/admin/products', { method: 'POST', body: {}, headers: { Cookie: cookie } });
  assert.equal(r.status, 403);
});

test('admin: CRUD prodotti e coupon con validazione', async () => {
  let r = await api('/api/admin/products', { method: 'POST', auth: true, body: { title: 'Palla di Natale', category: 'natale', priceCents: 1500, stock: 3, image: 'javascript:alert(1)', description: 'x' } });
  assert.equal(r.status, 400);
  r = await api('/api/admin/products', { method: 'POST', auth: true, body: { title: 'Palla di Natale', category: 'natale', priceCents: -5, stock: 3 } });
  assert.equal(r.status, 400);
  r = await api('/api/admin/products', { method: 'POST', auth: true, body: { title: 'Palla di Natale', category: 'natale', priceCents: 1500, stock: 3, image: 'https://example.com/a.jpg', description: 'Bella' } });
  assert.equal(r.status, 201);
  const id = r.json.id;

  r = await api(`/api/admin/products/${id}`, { method: 'PUT', auth: true, body: { title: 'Palla di Natale XL', category: 'natale', priceCents: 1800, stock: 5, image: '', description: 'Bella', active: true } });
  assert.equal(r.status, 200);

  r = await api('/api/admin/coupons', { method: 'POST', auth: true, body: { code: 'prova10', percent: 10, productId: id } });
  assert.equal(r.status, 201);
  r = await api('/api/admin/coupons', { method: 'POST', auth: true, body: { code: 'PROVA10', percent: 10 } });
  assert.equal(r.status, 409);
  r = await api('/api/admin/coupons', { method: 'POST', auth: true, body: { code: 'a b', percent: 10 } });
  assert.equal(r.status, 400);
  r = await api('/api/admin/coupons', { method: 'POST', auth: true, body: { code: 'SCADUTO', percent: 10, expiresAt: '2020-01-01' } });
  assert.equal(r.status, 201);
  r = await api('/api/cart/quote', { method: 'POST', body: { items: [{ id, qty: 1 }], coupon: 'SCADUTO' } });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /scaduto/);

  r = await api(`/api/admin/products/${id}`, { method: 'DELETE', auth: true });
  assert.equal(r.status, 200);
  const cs = (await api('/api/admin/coupons', { auth: true })).json.coupons;
  assert.ok(!cs.some((c) => c.code === 'PROVA10'), 'coupon collegato rimosso con il prodotto');
});

test('upload: accetta immagini vere, rifiuta contenuti falsi, serve in sandbox', async () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)]);
  let r = await api('/api/admin/upload', { method: 'POST', auth: true, body: { dataUrl: `data:image/png;base64,${png.toString('base64')}` } });
  assert.equal(r.status, 201);
  assert.match(r.json.url, /^\/uploads\/[a-f0-9]{24}\.png$/);
  const f = await api(r.json.url);
  assert.equal(f.status, 200);
  assert.match(f.headers.get('content-security-policy'), /sandbox/);
  assert.equal(f.headers.get('x-content-type-options'), 'nosniff');

  r = await api('/api/admin/upload', { method: 'POST', auth: true, body: { dataUrl: `data:image/png;base64,${Buffer.from('<script>alert(1)</script>').toString('base64')}` } });
  assert.equal(r.status, 400);
  r = await api('/api/admin/upload', { method: 'POST', auth: true, body: { dataUrl: 'data:text/html;base64,PGgxPg==' } });
  assert.equal(r.status, 400);
  r = await api('/api/admin/upload', { method: 'POST', body: { dataUrl: 'x' } });
  assert.equal(r.status, 401);
  r = await api('/uploads/../shop.db');
  assert.equal(r.status, 404);
});

test('impostazioni: logo, IBAN, validazioni; abilita bonifico', async () => {
  const cur = (await api('/api/admin/settings', { auth: true })).json.settings;
  assert.equal(cur.shopName, 'G&T Hobbistica e Artigianato');
  let r = await api('/api/admin/settings', { method: 'PUT', auth: true, body: { ...cur, whatsapp: 'abc' } });
  assert.equal(r.status, 400);
  r = await api('/api/admin/settings', { method: 'PUT', auth: true, body: { ...cur, bankIban: 'XX' } });
  assert.equal(r.status, 400);
  r = await api('/api/admin/settings', { method: 'PUT', auth: true, body: { ...cur, bankIban: 'IT60 X054 2811 1010 0000 0123 456', bankHolder: 'G&T di Rossi' } });
  assert.equal(r.status, 200);
  const c = await api('/api/config');
  assert.ok(c.json.methods.some((m) => m.id === 'bank'));
});

test('checkout bonifico: riserva stock, validazioni, annullo ripristina', async () => {
  const prods = (await api('/api/products')).json.products;
  const g = prods.find((x) => x.coupon?.code === 'GHIR20');

  let r = await api('/api/checkout', { method: 'POST', body: { provider: 'bank', items: [{ id: g.id, qty: 2 }], customer, acceptTerms: false } });
  assert.equal(r.status, 400);
  r = await api('/api/checkout', { method: 'POST', body: { provider: 'bank', items: [{ id: g.id, qty: 2 }], customer: { ...customer, email: 'non-email' }, acceptTerms: true } });
  assert.equal(r.status, 400);
  r = await api('/api/checkout', { method: 'POST', body: { provider: 'contanti', items: [{ id: g.id, qty: 2 }], customer, acceptTerms: true } });
  assert.equal(r.status, 400);

  r = await api('/api/checkout', { method: 'POST', body: { provider: 'bank', items: [{ id: g.id, qty: 2 }], coupon: 'GHIR20', customer, acceptTerms: true } });
  assert.equal(r.status, 200);
  const orderId = r.json.orderId;
  assert.match(orderId, /^GT-[A-Z0-9]{8}$/);
  assert.equal(r.json.bank.iban, 'IT60X0542811101000000123456');
  // 34.00 -20% = 27.20 x2 = 54.40 (< 60.00 soglia) + 6.00 spedizione
  assert.equal(r.json.bank.totalCents, 5440 + 600);
});

test('totale bonifico corretto (54.40 + 6.00) e stock/annullo', async () => {
  const orders = (await api('/api/admin/orders', { auth: true })).json.orders;
  const o = orders.find((x) => x.provider === 'bank');
  assert.equal(o.status, 'awaiting_payment');
  assert.equal(o.totalCents, 5440 + 600);
  assert.equal(o.coupon, 'GHIR20');

  const stockOf = async () => (await api('/api/products')).json.products.find((x) => x.coupon?.code === 'GHIR20').stock;
  assert.equal(await stockOf(), 6); // 8 - 2

  let r = await api(`/api/admin/orders/${o.id}`, { method: 'PATCH', auth: true, body: { status: 'cancelled' } });
  assert.equal(r.json.order.status, 'cancelled');
  assert.equal(await stockOf(), 8);
  // doppio annullo non deve ripristinare due volte
  r = await api(`/api/admin/orders/${o.id}`, { method: 'PATCH', auth: true, body: { status: 'cancelled' } });
  assert.equal(await stockOf(), 8);
  r = await api(`/api/admin/orders/${o.id}`, { method: 'PATCH', auth: true, body: { status: 'boh' } });
  assert.equal(r.status, 400);
});

test('stock insufficiente: 409 e nessun ordine creato', async () => {
  const g = (await api('/api/products')).json.products.find((x) => x.coupon?.code === 'GHIR20');
  const n = (await api('/api/admin/orders', { auth: true })).json.orders.length;
  const r = await api('/api/checkout', { method: 'POST', body: { provider: 'bank', items: [{ id: g.id, qty: 99 }], customer, acceptTerms: true } });
  assert.equal(r.status, 409);
  assert.equal((await api('/api/admin/orders', { auth: true })).json.orders.length, n);
});

test('Stripe: sessione con importi server-side, webhook firmato, idempotenza', async () => {
  const f = (await api('/api/products')).json.products.find((x) => x.coupon?.code === 'FIOCCO25');
  mockCalls.length = 0;
  let r = await api('/api/checkout', { method: 'POST', body: { provider: 'stripe', items: [{ id: f.id, qty: 1 }], coupon: 'FIOCCO25', customer, acceptTerms: true } });
  assert.equal(r.status, 200);
  assert.equal(r.json.url, 'https://checkout.stripe.test/pay/cs_test_1');
  const orderId = r.json.orderId;

  const call = mockCalls.find((c) => c.url === '/v1/checkout/sessions');
  assert.equal(call.auth, 'Bearer sk_test_x');
  const form = new URLSearchParams(call.body);
  assert.equal(form.get('line_items[0][price_data][unit_amount]'), '2100');
  assert.equal(form.get('line_items[1][price_data][unit_amount]'), '600');
  assert.equal(form.get('client_reference_id'), orderId);
  assert.match(form.get('success_url'), /esito=ok/);

  const status = async () => (await api(`/api/orders/${orderId}/status`)).json.status;
  assert.equal(await status(), 'pending');

  // firma sbagliata / scaduta / assente
  let ev = signed(stripeEvent('checkout.session.completed', orderId, { amount_total: 2700 }), 'whsec_sbagliato');
  r = await api('/api/webhooks/stripe', { method: 'POST', raw: ev.raw, headers: ev.headers });
  assert.equal(r.status, 400);
  ev = signed(stripeEvent('checkout.session.completed', orderId, { amount_total: 2700 }), WHSEC, Math.floor(Date.now() / 1000) - 3600);
  r = await api('/api/webhooks/stripe', { method: 'POST', raw: ev.raw, headers: ev.headers });
  assert.equal(r.status, 400);
  r = await api('/api/webhooks/stripe', { method: 'POST', raw: ev.raw, headers: { 'Content-Type': 'application/json' } });
  assert.equal(r.status, 400);
  assert.equal(await status(), 'pending');

  // importo divergente: NON deve risultare pagato
  ev = signed(stripeEvent('checkout.session.completed', orderId, { amount_total: 100 }));
  r = await api('/api/webhooks/stripe', { method: 'POST', raw: ev.raw, headers: ev.headers });
  assert.equal(r.status, 200);
  assert.equal(await status(), 'pending');

  // evento valido
  ev = signed(stripeEvent('checkout.session.completed', orderId, { amount_total: 2700 }));
  r = await api('/api/webhooks/stripe', { method: 'POST', raw: ev.raw, headers: ev.headers });
  assert.equal(r.status, 200);
  assert.equal(await status(), 'paid');
  // replay
  r = await api('/api/webhooks/stripe', { method: 'POST', raw: ev.raw, headers: ev.headers });
  assert.equal(r.status, 200);
  assert.equal(await status(), 'paid');
  // expired dopo pagato: non deve annullare
  ev = signed(stripeEvent('checkout.session.expired', orderId, { payment_status: 'unpaid' }));
  await api('/api/webhooks/stripe', { method: 'POST', raw: ev.raw, headers: ev.headers });
  assert.equal(await status(), 'paid');
});

test('Stripe: sessione scaduta libera lo stock; manutenzione annulla ordini vecchi', async () => {
  const stockOf = async () => (await api('/api/products')).json.products.find((x) => x.coupon?.code === 'BOMBO15').stock;
  const b = (await api('/api/products')).json.products.find((x) => x.coupon?.code === 'BOMBO15');
  const s0 = await stockOf();
  let r = await api('/api/checkout', { method: 'POST', body: { provider: 'stripe', items: [{ id: b.id, qty: 5 }], customer, acceptTerms: true } });
  const id1 = r.json.orderId;
  assert.equal(await stockOf(), s0 - 5);
  const ev = signed(stripeEvent('checkout.session.expired', id1, { payment_status: 'unpaid' }));
  await api('/api/webhooks/stripe', { method: 'POST', raw: ev.raw, headers: ev.headers });
  assert.equal((await api(`/api/orders/${id1}/status`)).json.status, 'cancelled');
  assert.equal(await stockOf(), s0);

  r = await api('/api/checkout', { method: 'POST', body: { provider: 'stripe', items: [{ id: b.id, qty: 4 }], customer, acceptTerms: true } });
  const id2 = r.json.orderId;
  assert.equal(await stockOf(), s0 - 4);
  await app.db.run('UPDATE orders SET created_at = ? WHERE id = ?', tsFromMs(Date.now() - 2 * 3600 * 1000), id2);
  assert.equal(await shop.expireStaleOrders(app.db, 45), 1);
  assert.equal(await stockOf(), s0);
  // pagamento tardivo dopo annullo automatico: viene comunque registrato
  // 6.50 * 4 = 26.00 senza coupon + 6.00 spedizione
  const late = signed(stripeEvent('checkout.session.completed', id2, { amount_total: 2600 + 600 }));
  await api('/api/webhooks/stripe', { method: 'POST', raw: late.raw, headers: late.headers });
  assert.equal((await api(`/api/orders/${id2}/status`)).json.status, 'paid');
  assert.equal(await stockOf(), s0 - 4);
});

test('PayPal: creazione, cattura, controllo importo', async () => {
  const g = (await api('/api/products')).json.products.find((x) => x.coupon?.code === 'FIOCCO25');
  let r = await api('/api/checkout', { method: 'POST', body: { provider: 'paypal', items: [{ id: g.id, qty: 1 }], customer, acceptTerms: true } });
  assert.equal(r.status, 200);
  assert.equal(r.json.url, 'https://paypal.test/approve/PP-ORDER-1');
  const id = r.json.orderId;
  const total = '34.00'; // 28.00 + 6.00

  // token sbagliato
  r = await api(`/api/paypal/return?order=${id}&token=ALTRO`);
  assert.equal(r.status, 302);
  assert.match(r.headers.get('location'), /esito=ko/);
  assert.equal((await api(`/api/orders/${id}/status`)).json.status, 'pending');

  // importo catturato diverso
  mock.captureValue = '1.00';
  r = await api(`/api/paypal/return?order=${id}&token=PP-ORDER-1`);
  assert.match(r.headers.get('location'), /esito=ko/);
  assert.equal((await api(`/api/orders/${id}/status`)).json.status, 'pending');

  mock.captureValue = total;
  r = await api(`/api/paypal/return?order=${id}&token=PP-ORDER-1`);
  assert.match(r.headers.get('location'), /esito=ok/);
  assert.equal((await api(`/api/orders/${id}/status`)).json.status, 'paid');
});

test('errore del provider: ordine annullato e stock ripristinato', async () => {
  const bad = await createApp(loadConfig({ DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'gt-bad-')), ADMIN_PASSWORD: 'una-password-lunga-1', STRIPE_SECRET_KEY: 'sk', STRIPE_API_BASE: 'http://127.0.0.1:1', ...dbEnv() }), dbOptions());
  await new Promise((r) => bad.server.listen(0, '127.0.0.1', r));
  const b = `http://127.0.0.1:${bad.server.address().port}`;
  const prods = (await (await fetch(b + '/api/products')).json()).products;
  const before = prods[0].stock;
  const res = await fetch(b + '/api/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'stripe', items: [{ id: prods[0].id, qty: 1 }], customer, acceptTerms: true }) });
  assert.equal(res.status, 502);
  const after = (await (await fetch(b + '/api/products')).json()).products.find((p) => p.id === prods[0].id).stock;
  assert.equal(after, before);
  await bad.close();
});

test('password: cambio, vecchie sessioni invalidate, rate-limit login', async () => {
  let r = await api('/api/admin/password', { method: 'POST', auth: true, body: { currentPassword: 'errata', newPassword: 'nuova-password-1234' } });
  assert.equal(r.status, 400);
  r = await api('/api/admin/password', { method: 'POST', auth: true, body: { currentPassword: 'una-password-lunga-1', newPassword: 'corta' } });
  assert.equal(r.status, 400);
  const old = cookie;
  r = await api('/api/admin/password', { method: 'POST', auth: true, body: { currentPassword: 'una-password-lunga-1', newPassword: 'nuova-password-1234' } });
  assert.equal(r.status, 200);
  cookie = r.headers.get('set-cookie').split(';')[0];
  r = await api('/api/admin/me', { headers: { Cookie: old } });
  assert.equal(r.status, 401);
  r = await api('/api/admin/me', { auth: true });
  assert.equal(r.status, 200);

  let last;
  for (let i = 0; i < 7; i++) {
    last = await api('/api/admin/login', { method: 'POST', body: { username: 'boss', password: 'x' }, headers: { 'X-Requested-With': 'fetch' } });
  }
  assert.equal(last.status, 429);
});

test('CSV ordini protetto da formula injection', async () => {
  const o = await app.db.get('SELECT id FROM orders LIMIT 1');
  await app.db.run('UPDATE orders SET customer_name = ? WHERE id = ?', '=HYPERLINK("http://evil")', o.id);
  const r = await api('/api/admin/orders/export.csv', { auth: true });
  assert.equal(r.status, 200);
  assert.match(r.text, /"'=HYPERLINK/);
  assert.equal((await api('/api/admin/orders/export.csv')).status, 401);
});

test('file statici: niente path traversal ne file nascosti, header di sicurezza', async () => {
  for (const p of ['/..%2f..%2fserver.js', '/%2e%2e/server.js', '/.env', '/lib/util.js', '/js/../../package.json', '/data/shop.db']) {
    const r = await api(p);
    assert.equal(r.status, 404, p);
  }
  const r = await api('/healthz');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  const rb = await api('/robots.txt');
  assert.match(rb.text, /Disallow: \/admin/);
});

test('pagine: template compilato, JSON-LD valido, nome negozio escapato', async () => {
  const cur = (await api('/api/admin/settings', { auth: true })).json.settings;
  let r = await api('/api/admin/settings', { method: 'PUT', auth: true, body: { ...cur, shopName: 'G&T <script>alert(1)</script>', vat: 'IT01234567890' } });
  assert.equal(r.status, 200);

  for (const p of ['/', '/admin', '/privacy', '/termini']) {
    r = await api(p);
    assert.equal(r.status, 200, p);
    assert.match(r.headers.get('content-type'), /text\/html/);
    assert.ok(!/\{\{[A-Z_]+\}\}/.test(r.text), `token non sostituiti in ${p}`);
    assert.ok(!r.text.includes('<script>alert(1)</script>'), `XSS nel nome negozio in ${p}`);
  }
  r = await api('/');
  const m = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(r.text);
  const ld = JSON.parse(m[1]);
  assert.equal(ld['@type'], 'CraftStore');
  assert.equal(ld.name, 'G&T <script>alert(1)</script>'); // dati preservati nel JSON
  assert.ok(!m[1].includes('<'), 'nel JSON-LD "<" deve essere escapato');
  assert.match((await api('/termini')).text, /IT01234567890/);

  for (const p of ['/js/shop.js', '/js/admin.js', '/img/logo-default.svg', '/img/favicon.svg']) {
    assert.equal((await api(p)).status, 200, p);
  }
  assert.equal((await api('/nonesiste')).status, 404);
  assert.equal((await api('/index.html')).status, 404); // solo la versione compilata
  assert.equal((await api('/sitemap.xml')).status, 200);
});

test('immagini salvate nel database: servite, sandbox, eliminate con il prodotto', async () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('prova-immagine')]);
  let r = await api('/api/admin/upload', { method: 'POST', auth: true, body: { dataUrl: `data:image/png;base64,${png.toString('base64')}` } });
  const url = r.json.url;
  r = await api('/api/admin/products', { method: 'POST', auth: true, body: { title: 'Con foto', category: 'natale', priceCents: 1000, stock: 1, image: url } });
  const id = r.json.id;
  const img = await fetch(base + url);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await img.arrayBuffer()), png);
  await api(`/api/admin/products/${id}`, { method: 'DELETE', auth: true });
  assert.equal((await api(url)).status, 404, "l'immagine deve sparire con il prodotto");
  // troppo grande
  const big = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(2 * 1024 * 1024)]);
  r = await api('/api/admin/upload', { method: 'POST', auth: true, body: { dataUrl: `data:image/png;base64,${big.toString('base64')}` } });
  assert.equal(r.status, 413);
});

test('rate limit su database: contatore condiviso e azzerato dopo il login', async () => {
  const rl = require('../lib/ratelimit');
  for (let i = 0; i < 3; i++) assert.equal(await rl.hit(app.db, 'k:test', 3, 60_000), true);
  assert.equal(await rl.hit(app.db, 'k:test', 3, 60_000), false);
  await rl.clear(app.db, 'k:test');
  assert.equal(await rl.hit(app.db, 'k:test', 3, 60_000), true);
  // finestra scaduta -> riparte da 1
  assert.equal(await rl.hit(app.db, 'k:short', 1, 1), true);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(await rl.hit(app.db, 'k:short', 1, 1), true);
});

test('portabilita SQL: nessuna sintassi esclusiva di SQLite nelle query', async () => {
  assert.equal(toPgSql('SELECT * FROM t WHERE a = ? AND b = ?'), 'SELECT * FROM t WHERE a = $1 AND b = $2');
  const files = ['server.js', 'lib/shop.js', 'lib/auth.js', 'lib/ratelimit.js', 'lib/db.js'];
  const banned = [/datetime\(/i, /\browid\b/i, /INSERT OR /i, /lastInsertRowid/, /\bMAX\(0/i];
  for (const f of files) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    for (const re of banned) assert.ok(!re.test(src), `${f} contiene ${re}`);
  }
});

function fakeRes(resolve) {
  return {
    headersSent: false,
    h: {},
    setHeader(k, v) { this.h[k] = v; },
    writeHead(c, h) { this.code = c; Object.assign(this.h, h); this.headersSent = true; },
    end(b) { resolve({ code: this.code, body: String(b || ''), h: this.h }); },
  };
}

test('handler Vercel: avvio pigro, errore chiaro senza ADMIN_PASSWORD', async () => {
  const saved = { ...process.env };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-vercel-'));
  Object.assign(process.env, { VERCEL: '1', ALLOW_SQLITE: '1', DATA_DIR: dir, BASE_URL: 'https://shop.example.com' });
  delete process.env.ADMIN_PASSWORD;
  delete process.env.DATABASE_URL;
  delete process.env.POSTGRES_URL;
  try {
    delete require.cache[require.resolve('../server')];
    const { vercelHandler } = require('../server');
    const out = await new Promise((resolve) => {
      vercelHandler({ method: 'GET', url: '/healthz', headers: {} }, fakeRes(resolve));
    });
    assert.equal(out.code, 500);
    assert.match(out.body, /ADMIN_PASSWORD/);

    process.env.ADMIN_PASSWORD = 'password-per-vercel-1';
    const ok = await new Promise((resolve) => {
      require('../server').vercelHandler({ method: 'GET', url: '/healthz', headers: {} }, fakeRes(resolve));
    });
    assert.equal(ok.code, 200, ok.body);
    assert.match(ok.h['Strict-Transport-Security'] || '', /max-age/); // https da BASE_URL
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    delete require.cache[require.resolve('../server')];
  }
});

test('su Vercel senza DATABASE_URL: messaggio chiaro invece di un crash', async () => {
  const saved = { ...process.env };
  Object.assign(process.env, { VERCEL: '1', ADMIN_PASSWORD: 'password-per-vercel-1' });
  for (const k of ['DATABASE_URL', 'POSTGRES_URL', 'ALLOW_SQLITE']) delete process.env[k];
  try {
    delete require.cache[require.resolve('../server')];
    const out = await new Promise((resolve) => {
      require('../server').vercelHandler({ method: 'GET', url: '/', headers: {} }, fakeRes(resolve));
    });
    assert.equal(out.code, 500);
    assert.match(out.body, /DATABASE_URL/);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    delete require.cache[require.resolve('../server')];
  }
});

test('aspetto del sito: testi modificabili da admin, validati e senza XSS', async () => {
  assert.equal((await api('/api/admin/content')).status, 401);
  assert.equal((await api('/api/admin/content', { method: 'PUT', body: {}, headers: { Cookie: cookie } })).status, 403);

  let r = await api('/api/admin/content', { auth: true });
  assert.equal(r.status, 200);
  const base0 = r.json.content;
  assert.equal(r.json.defaults.heroTheme, 'rosso');
  assert.ok(r.json.themes.verde.cls.includes('emerald'));
  let page = (await api('/')).text;
  assert.match(page, /Fiocchi Natalizi Extra Large/);
  assert.match(page, /Fatto a Mano in Italia/);

  const next = {
    ...base0,
    heroTitle: 'Titolo <b>nuovo</b> & bello',
    heroText: 'Testo nuovo',
    heroTheme: 'verde',
    btn1Label: 'Vai al catalogo',
    btn2Label: '',
    badge2Label: '',
    brandMain: 'Mia',
    brandAccent: 'Bottega',
    brandTagline: '',
    navQuoteLabel: 'Scrivimi',
    footerLinksTitle: 'Seguici',
    footerLinks: [
      { label: 'Instagram', url: 'https://instagram.com/mia' },
      { label: 'Scrivici', url: 'mailto:ciao@example.com' },
      { label: 'Chiamaci', url: 'tel:+39 340 1234567' },
      { label: 'Privacy', url: '/privacy' },
    ],
    footerNote: 'Aperti il sabato <script>',
    footerPayTitle: '',
    footerPayText: '',
    copyrightText: '© Mia Bottega',
    showAdminLink: false,
  };
  r = await api('/api/admin/content', { method: 'PUT', auth: true, body: next });
  assert.equal(r.status, 200, r.text);

  page = (await api('/')).text;
  assert.ok(page.includes('Titolo &lt;b&gt;nuovo&lt;/b&gt; &amp; bello'));
  assert.ok(!page.includes('<b>nuovo</b>'));
  assert.ok(!page.includes('Aperti il sabato <script>'));
  assert.match(page, /Aperti il sabato &lt;script&gt;/);
  assert.match(page, /from-emerald-950/);
  assert.match(page, /Vai al catalogo/);
  assert.ok(!page.includes('Preventivo WhatsApp'));
  assert.match(page, /Mia <span class="text-red-700">Bottega<\/span>/);
  assert.ok(!page.includes('Fatto a Mano in Italia'));
  assert.match(page, /Scrivimi/);
  assert.match(page, /href="https:\/\/instagram\.com\/mia" target="_blank" rel="noopener noreferrer"/);
  assert.match(page, /href="mailto:ciao@example\.com"/);
  assert.match(page, /href="tel:\+39 340 1234567"/);
  assert.match(page, />Seguici</);
  assert.ok(!page.includes('Area riservata'));
  assert.match(page, /© Mia Bottega/);
  assert.ok(!page.includes('I dati di pagamento sono gestiti'));
  assert.ok(!/\{\{[A-Z_]+\}\}/.test(page));

  // validazione
  const bad = async (patch) => (await api('/api/admin/content', { method: 'PUT', auth: true, body: { ...next, ...patch } })).status;
  assert.equal(await bad({ heroTheme: 'viola' }), 400);
  assert.equal(await bad({ brandMain: '' }), 400);
  assert.equal(await bad({ heroImage: 'javascript:alert(1)' }), 400);
  assert.equal(await bad({ heroTitle: 'x'.repeat(141) }), 400);
  assert.equal(await bad({ footerLinks: [{ label: 'x', url: 'javascript:alert(1)' }] }), 400);
  assert.equal(await bad({ footerLinks: [{ label: 'x', url: '//evil.com' }] }), 400);
  assert.equal(await bad({ footerLinks: [{ label: 'x', url: 'http://non-sicuro.it' }] }), 400);
  assert.equal(await bad({ footerLinks: [{ label: '', url: 'https://ok.it' }] }), 400);
  assert.equal(await bad({ footerLinks: Array.from({ length: 9 }, (_, i) => ({ label: `l${i}`, url: 'https://ok.it' })) }), 400);
  // la pagina pubblica non è cambiata dopo i rifiuti
  assert.match((await api('/')).text, /Mia <span/);

  // riquadro nascosto
  assert.equal(await bad({ heroVisible: false }), 200);
  page = (await api('/')).text;
  assert.ok(!page.includes('from-emerald-950'));
  assert.ok(!page.includes('Titolo &lt;b&gt;'));

  // ripristino ai valori originali
  r = await api('/api/admin/content', { method: 'PUT', auth: true, body: (await api('/api/admin/content', { auth: true })).json.defaults });
  assert.equal(r.status, 200);
  page = (await api('/')).text;
  assert.match(page, /Fiocchi Natalizi Extra Large/);
  assert.match(page, /Area riservata/);
  assert.match(page, /Fatto a Mano in Italia/);
});
