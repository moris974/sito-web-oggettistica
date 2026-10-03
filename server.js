'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { loadConfig } = require('./lib/config');
const { openDb, getSettings, setSetting } = require('./lib/db');
const { HttpError, sendJson, readBody, readJson, parseCookies, RateLimiter, escapeHtml, tsNow } = require('./lib/util');
const auth = require('./lib/auth');
const rl = require('./lib/ratelimit');
const shop = require('./lib/shop');
const pay = require('./lib/payments');
const content = require('./lib/content');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};
const IMAGE_MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml' };

// NB: il CDN di Tailwind (usato per lo stile) può richiedere 'unsafe-eval'.
// Se compili il CSS in locale (vedi README) puoi rimuoverlo.
const CSP = [
  "default-src 'self'",
  "script-src 'self' https://cdn.tailwindcss.com 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",
  "font-src 'self' https://cdnjs.cloudflare.com",
  "img-src 'self' data: blob: https:",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
].join('; ');

const UPLOAD_NAME = /^[a-f0-9]{24}\.(png|jpg|webp|gif|svg)$/;
const DATA_URL = /^data:(image\/(?:png|jpeg|webp|gif|svg\+xml));base64,([A-Za-z0-9+/=]+)$/;
// Le funzioni serverless accettano al massimo ~4,5 MB di richiesta: teniamo un margine.
const MAX_UPLOAD = 2 * 1024 * 1024;

/* ------------------------------ validazione ------------------------------ */

function str(v, min, max, label) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (s.length < min || s.length > max) {
    throw new HttpError(400, min > 0 ? `${label}: da ${min} a ${max} caratteri.` : `${label}: massimo ${max} caratteri.`);
  }
  return s;
}

function intIn(v, min, max, label) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${label} non valido.`);
  return n;
}

function validImageRef(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (s === '') return '';
  if (s.length > 500) throw new HttpError(400, 'URL immagine troppo lungo.');
  if (s.startsWith('/uploads/')) {
    if (!UPLOAD_NAME.test(s.slice('/uploads/'.length))) throw new HttpError(400, 'Immagine non valida.');
    return s;
  }
  if (/^\/img\/[\w.-]+$/.test(s)) return s;
  try {
    const u = new URL(s);
    if (u.protocol === 'https:') return s;
  } catch {
    /* cade nell'errore sotto */
  }
  throw new HttpError(400, "L'immagine deve essere caricata da file o avere un URL https://");
}

function parseProduct(b) {
  if (!shop.CATEGORIES[b.category]) throw new HttpError(400, 'Categoria non valida.');
  return {
    title: str(b.title, 2, 120, 'Nome articolo'),
    category: b.category,
    priceCents: intIn(b.priceCents, 0, 10_000_000, 'Prezzo'),
    stock: intIn(b.stock, 0, 100_000, 'Stock'),
    image: validImageRef(b.image),
    description: str(b.description ?? '', 0, 1000, 'Descrizione'),
    active: b.active === false ? 0 : 1,
  };
}

async function parseCoupon(db, b) {
  const code = String(b.code || '').trim().toUpperCase();
  if (!/^[A-Z0-9_-]{3,30}$/.test(code)) throw new HttpError(400, 'Codice: 3-30 caratteri (lettere, numeri, - _).');
  const percent = intIn(b.percent, 1, 90, 'Percentuale');
  let productId = null;
  if (b.productId !== null && b.productId !== undefined && b.productId !== '') {
    productId = intIn(b.productId, 1, 2_000_000_000, 'Articolo');
    if (!(await db.get('SELECT 1 AS x FROM products WHERE id = ?', productId))) throw new HttpError(400, 'Articolo inesistente.');
  }
  let expiresAt = null;
  if (b.expiresAt) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(b.expiresAt) || Number.isNaN(Date.parse(b.expiresAt))) {
      throw new HttpError(400, 'Data di scadenza non valida.');
    }
    expiresAt = b.expiresAt;
  }
  return { code, percent, productId, expiresAt, active: b.active === false ? 0 : 1 };
}

function parseCustomer(b) {
  const c = b.customer || {};
  const email = str(c.email, 5, 120, 'Email').toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new HttpError(400, 'Email non valida.');
  const phone = str(c.phone, 6, 30, 'Telefono');
  if (!/^[\d\s+().-]+$/.test(phone)) throw new HttpError(400, 'Telefono non valido.');
  const zip = str(c.zip, 4, 10, 'CAP');
  return {
    name: str(c.name, 2, 100, 'Nome e cognome'),
    email,
    phone,
    address: str(c.address, 5, 200, 'Indirizzo'),
    city: str(c.city, 2, 80, 'Città'),
    zip,
    notes: str(c.notes ?? '', 0, 500, 'Note'),
  };
}

/* ------------------------------ app ------------------------------ */

async function createApp(userConfig, overrides = {}) {
  const cfg = userConfig || loadConfig();
  if (cfg.serverless && !cfg.databaseUrl && !cfg.allowSqlite) {
    throw new Error('Manca DATABASE_URL: su Vercel collega un database Postgres (Storage -> Neon) e rifai il deploy.');
  }
  const db = await openDb(cfg, overrides);

  // Primo avvio: crea l'account admin senza password hardcoded
  const s0 = await getSettings(db);
  if (!s0.admin_hash) {
    let pw = cfg.adminPassword;
    const generated = !pw;
    if (generated && cfg.serverless) {
      throw new Error('Imposta la variabile ADMIN_PASSWORD (almeno 10 caratteri) prima del primo avvio.');
    }
    if (generated) pw = crypto.randomBytes(12).toString('base64url');
    if (pw.length < 10) throw new Error('ADMIN_PASSWORD deve avere almeno 10 caratteri.');
    await setSetting(db, 'admin_user', cfg.adminUser);
    const r = await db.run("INSERT INTO settings (key, value) VALUES ('admin_hash', ?) ON CONFLICT (key) DO NOTHING", auth.hashPassword(pw));
    if (r.changes === 1 && generated) {
      console.log('\n==============================================================');
      console.log(' PRIMO AVVIO - credenziali admin (mostrate UNA SOLA VOLTA):');
      console.log(`   utente:   ${cfg.adminUser}`);
      console.log(`   password: ${pw}`);
      console.log(' Cambiala subito da /admin -> Impostazioni.');
      console.log('==============================================================\n');
    }
  }

  const quoteLimiter = new RateLimiter(120, 60 * 1000); // per istanza: basta per il carrello

  // Manutenzione "pigra" (niente timer: su serverless non ci sono processi sempre accesi)
  let lastMaint = 0;
  async function maybeMaintain() {
    const now = Date.now();
    if (now - lastMaint < 60_000) return;
    lastMaint = now;
    try {
      await shop.expireStaleOrders(db, 45);
      await auth.purgeExpiredSessions(db);
      await rl.purge(db);
    } catch (e) {
      console.error('[manutenzione]', e.message);
    }
  }

  const clientIp = (req) => {
    if (cfg.trustProxy) {
      const xf = req.headers['x-forwarded-for'];
      if (xf) return String(xf).split(',')[0].trim();
    }
    return req.socket?.remoteAddress || 'unknown';
  };

  const effCfg = async () => ({ ...cfg, shopName: (await getSettings(db)).shop_name || cfg.shopName });

  /* ---------- auth admin ---------- */
  const adminToken = (req) => parseCookies(req.headers.cookie).gt_admin || '';
  async function requireAdmin(req) {
    if (!(await auth.isValidSession(db, adminToken(req)))) throw new HttpError(401, 'Accesso richiesto.');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      // difesa CSRF aggiuntiva oltre a SameSite=Strict
      if (req.headers['x-requested-with'] !== 'fetch') throw new HttpError(403, 'Richiesta non valida.');
    }
  }
  const cookie = (token, maxAge) =>
    `gt_admin=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${cfg.isHttps ? '; Secure' : ''}`;

  /* ---------- upload immagini (salvate nel database) ---------- */
  async function saveUpload(dataUrl) {
    const m = DATA_URL.exec(typeof dataUrl === 'string' ? dataUrl : '');
    if (!m) throw new HttpError(400, 'Immagine non valida (PNG, JPG, WEBP, GIF o SVG).');
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length === 0 || buf.length > MAX_UPLOAD) throw new HttpError(413, 'Immagine troppo grande (max 2 MB).');
    const mime = m[1];
    const head = buf.subarray(0, 16);
    let ext;
    if (mime === 'image/png' && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) ext = 'png';
    else if (mime === 'image/jpeg' && head[0] === 0xff && head[1] === 0xd8) ext = 'jpg';
    else if (mime === 'image/gif' && head.subarray(0, 3).toString() === 'GIF') ext = 'gif';
    else if (mime === 'image/webp' && head.subarray(0, 4).toString() === 'RIFF' && head.subarray(8, 12).toString() === 'WEBP') ext = 'webp';
    else if (mime === 'image/svg+xml' && /<svg[\s>]/i.test(buf.subarray(0, 2048).toString('utf8'))) ext = 'svg';
    else throw new HttpError(400, 'Il contenuto del file non corrisponde al formato dichiarato.');
    const name = `${crypto.randomBytes(12).toString('hex')}.${ext}`;
    await db.run('INSERT INTO images (id, mime, data, created_at) VALUES (?, ?, ?, ?)', name, IMAGE_MIME[ext], buf, tsNow());
    return `/uploads/${name}`;
  }
  async function removeUploadIfLocal(url) {
    if (typeof url !== 'string' || !url.startsWith('/uploads/')) return;
    const name = url.slice('/uploads/'.length);
    if (UPLOAD_NAME.test(name)) await db.run('DELETE FROM images WHERE id = ?', name);
  }
  async function serveUpload(req, res, name) {
    if (!UPLOAD_NAME.test(name)) return notFound(req, res);
    const row = await db.get('SELECT mime, data FROM images WHERE id = ?', name);
    if (!row) return notFound(req, res);
    const data = Buffer.from(row.data);
    res.writeHead(200, {
      'Content-Type': row.mime,
      'Content-Length': data.length,
      'Cache-Control': 'public, max-age=604800, immutable',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  }

  /* ---------- helpers risposta ---------- */
  const publicSettings = (s) => ({
    shopName: s.shop_name,
    announcement: s.announcement,
    logo: s.logo,
    whatsapp: s.whatsapp,
    shippingCents: Number(s.shipping_cents) || 0,
    freeShippingOverCents: Number(s.free_shipping_over_cents) || 0,
    legal: { name: s.legal_name, vat: s.vat, email: s.contact_email, address: s.business_address },
  });

  function availableMethods(s) {
    const m = [];
    if (pay.stripeEnabled(cfg)) m.push({ id: 'stripe', label: 'Carta di credito / debito' });
    if (pay.paypalEnabled(cfg)) m.push({ id: 'paypal', label: 'PayPal' });
    if (s.bank_iban) m.push({ id: 'bank', label: 'Bonifico bancario' });
    return m;
  }

  const orderForAdmin = (o) => ({
    id: o.id,
    status: o.status,
    provider: o.provider,
    paymentRef: o.payment_ref,
    customer: { name: o.customer_name, email: o.email, phone: o.phone, address: o.address, city: o.city, zip: o.zip },
    notes: o.notes,
    subtotalCents: o.subtotal_cents,
    discountCents: o.discount_cents,
    shippingCents: o.shipping_cents,
    totalCents: o.total_cents,
    coupon: o.coupon_code,
    items: JSON.parse(o.items_json),
    adminNote: o.admin_note,
    createdAt: String(o.created_at).slice(0, 19),
    paidAt: o.paid_at ? String(o.paid_at).slice(0, 19) : null,
  });

  const adminProduct = (p) => ({
    id: p.id,
    title: p.title,
    category: p.category,
    priceCents: p.price_cents,
    stock: p.stock,
    image: p.image,
    description: p.description,
    active: !!p.active,
  });

  const adminCoupon = (c) => ({
    code: c.code,
    percent: c.percent,
    productId: c.product_id,
    active: !!c.active,
    expiresAt: c.expires_at,
    uses: c.uses,
  });

  /* ---------- API ---------- */
  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, re: new RegExp(`^${pattern}$`), handler });

  // --- pubblico ---
  route('GET', '/api/config', async ({ res }) => {
    const s = await getSettings(db);
    sendJson(res, 200, { ...publicSettings(s), categories: shop.CATEGORIES, methods: availableMethods(s) });
  });

  route('GET', '/api/products', async ({ res }) => {
    await maybeMaintain();
    sendJson(res, 200, { products: await shop.listPublicProducts(db) });
  });

  route('POST', '/api/cart/quote', async ({ req, res }) => {
    if (!quoteLimiter.hit(clientIp(req))) throw new HttpError(429, 'Troppe richieste, riprova tra poco.');
    const b = await readJson(req);
    sendJson(res, 200, await shop.priceCart(db, b.items, b.coupon));
  });

  route('POST', '/api/checkout', async ({ req, res }) => {
    if (!(await rl.hit(db, `checkout:${clientIp(req)}`, 10, 10 * 60 * 1000))) {
      throw new HttpError(429, 'Troppi tentativi, riprova tra qualche minuto.');
    }
    await maybeMaintain();
    const b = await readJson(req);
    const s = await getSettings(db);
    if (b.acceptTerms !== true) throw new HttpError(400, 'Devi accettare Termini di vendita e Privacy.');
    const provider = String(b.provider || '');
    if (!availableMethods(s).some((m) => m.id === provider)) throw new HttpError(400, 'Metodo di pagamento non disponibile.');
    const customer = parseCustomer(b);

    const order = await shop.createOrder(db, { customer, items: b.items, couponCode: b.coupon, provider });
    try {
      const c = await effCfg();
      if (provider === 'stripe') {
        const sess = await pay.createStripeSession(c, order, order.priced, customer);
        await db.run('UPDATE orders SET payment_ref = ? WHERE id = ?', sess.id, order.id);
        return sendJson(res, 200, { orderId: order.id, url: sess.url });
      }
      if (provider === 'paypal') {
        const pp = await pay.createPaypalOrder(c, order, order.priced);
        await db.run('UPDATE orders SET payment_ref = ? WHERE id = ?', pp.id, order.id);
        return sendJson(res, 200, { orderId: order.id, url: pp.url });
      }
      return sendJson(res, 200, {
        orderId: order.id,
        bank: { iban: s.bank_iban, holder: s.bank_holder, reason: `Ordine ${order.id}`, totalCents: order.priced.totalCents },
      });
    } catch (e) {
      await shop.cancelOrder(db, order.id, "Errore durante l'avvio del pagamento.");
      throw e;
    }
  });

  route('GET', '/api/orders/([A-Z0-9-]{6,20})/status', async ({ res, params }) => {
    const o = await shop.getOrder(db, params[0]);
    if (!o) throw new HttpError(404, 'Ordine non trovato.');
    sendJson(res, 200, { id: o.id, status: o.status, provider: o.provider, totalCents: o.total_cents });
  });

  route('GET', '/api/paypal/return', async ({ res, url }) => {
    const id = url.searchParams.get('order') || '';
    const token = url.searchParams.get('token') || '';
    const o = await shop.getOrder(db, id);
    const redirect = (esito) => {
      res.writeHead(302, { Location: `${cfg.baseUrl}/?ordine=${encodeURIComponent(id)}&esito=${esito}`, 'Cache-Control': 'no-store' });
      res.end();
    };
    if (!o || o.provider !== 'paypal' || !token || o.payment_ref !== token) return redirect('ko');
    if (o.status === 'paid' || o.status === 'shipped') return redirect('ok');
    const cap = await pay.capturePaypalOrder(cfg, token);
    if (cap.ok && cap.currency === 'EUR' && cap.amountCents === o.total_cents) {
      await shop.markPaid(db, o.id, cap.captureId);
      return redirect('ok');
    }
    if (cap.ok) {
      await db.run('UPDATE orders SET admin_note = ? WHERE id = ?', `ATTENZIONE: importo PayPal (${shop.eur(cap.amountCents)}) diverso dal totale ordine.`, o.id);
    }
    return redirect('ko');
  });

  route('POST', '/api/webhooks/stripe', async ({ req, res }) => {
    const raw = await readBody(req, 256 * 1024);
    const event = pay.verifyStripeWebhook(raw, req.headers['stripe-signature'], cfg.stripeWebhookSecret);
    const obj = event.data && event.data.object;
    if (obj) {
      const orderId = obj.client_reference_id || (obj.metadata && obj.metadata.order_id);
      const o = orderId ? await shop.getOrder(db, orderId) : null;
      if (o) {
        if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
          if (obj.payment_status === 'paid') {
            if (obj.currency === 'eur' && obj.amount_total === o.total_cents) {
              await shop.markPaid(db, o.id, obj.payment_intent || obj.id);
            } else {
              await db.run('UPDATE orders SET admin_note = ? WHERE id = ?', `ATTENZIONE: importo Stripe (${shop.eur(obj.amount_total || 0)}) diverso dal totale ordine.`, o.id);
              console.error('[stripe] importo divergente per', o.id);
            }
          }
        } else if (event.type === 'checkout.session.expired' && o.status === 'pending') {
          await shop.cancelOrder(db, o.id, 'Sessione di pagamento scaduta.');
        }
      }
    }
    sendJson(res, 200, { received: true });
  });

  // --- admin ---
  route('POST', '/api/admin/login', async ({ req, res }) => {
    const key = `login:${clientIp(req)}`;
    if (!(await rl.hit(db, key, 5, 15 * 60 * 1000))) throw new HttpError(429, 'Troppi tentativi falliti. Riprova tra 15 minuti.');
    if (req.headers['x-requested-with'] !== 'fetch') throw new HttpError(403, 'Richiesta non valida.');
    const b = await readJson(req);
    const s = await getSettings(db);
    const userOk = String(b.username || '') === s.admin_user;
    const passOk = auth.verifyPassword(String(b.password || ''), s.admin_hash);
    if (!userOk || !passOk) throw new HttpError(401, 'Credenziali errate.');
    await rl.clear(db, key);
    const sess = await auth.createSession(db);
    sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookie(sess.token, sess.maxAgeSec) });
  });

  route('POST', '/api/admin/logout', async ({ req, res }) => {
    await auth.destroySession(db, adminToken(req));
    sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookie('', 0) });
  });

  route('GET', '/api/admin/me', async ({ req, res }) => {
    await requireAdmin(req);
    sendJson(res, 200, { ok: true, user: (await getSettings(db)).admin_user });
  });

  route('GET', '/api/admin/products', async ({ req, res }) => {
    await requireAdmin(req);
    sendJson(res, 200, { products: (await db.all('SELECT * FROM products ORDER BY id DESC')).map(adminProduct) });
  });

  route('POST', '/api/admin/products', async ({ req, res }) => {
    await requireAdmin(req);
    const p = parseProduct(await readJson(req));
    const row = await db.get(
      'INSERT INTO products (title, category, price_cents, stock, image, description, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id',
      p.title, p.category, p.priceCents, p.stock, p.image, p.description, p.active, tsNow()
    );
    sendJson(res, 201, { id: Number(row.id) });
  });

  route('PUT', '/api/admin/products/(\\d+)', async ({ req, res, params }) => {
    await requireAdmin(req);
    const id = Number(params[0]);
    const old = await db.get('SELECT * FROM products WHERE id = ?', id);
    if (!old) throw new HttpError(404, 'Articolo non trovato.');
    const p = parseProduct(await readJson(req));
    await db.run(
      'UPDATE products SET title=?, category=?, price_cents=?, stock=?, image=?, description=?, active=? WHERE id=?',
      p.title, p.category, p.priceCents, p.stock, p.image, p.description, p.active, id
    );
    if (old.image !== p.image) await removeUploadIfLocal(old.image);
    sendJson(res, 200, { ok: true });
  });

  route('DELETE', '/api/admin/products/(\\d+)', async ({ req, res, params }) => {
    await requireAdmin(req);
    const id = Number(params[0]);
    const old = await db.get('SELECT * FROM products WHERE id = ?', id);
    if (!old) throw new HttpError(404, 'Articolo non trovato.');
    await db.run('DELETE FROM products WHERE id = ?', id);
    await removeUploadIfLocal(old.image);
    sendJson(res, 200, { ok: true });
  });

  route('GET', '/api/admin/coupons', async ({ req, res }) => {
    await requireAdmin(req);
    sendJson(res, 200, { coupons: (await db.all('SELECT * FROM coupons ORDER BY code')).map(adminCoupon) });
  });

  route('POST', '/api/admin/coupons', async ({ req, res }) => {
    await requireAdmin(req);
    const c = await parseCoupon(db, await readJson(req));
    if (await db.get('SELECT 1 AS x FROM coupons WHERE code = ?', c.code)) throw new HttpError(409, 'Esiste già un coupon con questo codice.');
    await db.run('INSERT INTO coupons (code, percent, product_id, active, expires_at) VALUES (?, ?, ?, ?, ?)', c.code, c.percent, c.productId, c.active, c.expiresAt);
    sendJson(res, 201, { ok: true });
  });

  route('PUT', '/api/admin/coupons/([A-Za-z0-9_-]{3,30})', async ({ req, res, params }) => {
    await requireAdmin(req);
    const code = params[0].toUpperCase();
    if (!(await db.get('SELECT 1 AS x FROM coupons WHERE code = ?', code))) throw new HttpError(404, 'Coupon non trovato.');
    const c = await parseCoupon(db, { ...(await readJson(req)), code });
    await db.run('UPDATE coupons SET percent=?, product_id=?, active=?, expires_at=? WHERE code=?', c.percent, c.productId, c.active, c.expiresAt, code);
    sendJson(res, 200, { ok: true });
  });

  route('DELETE', '/api/admin/coupons/([A-Za-z0-9_-]{3,30})', async ({ req, res, params }) => {
    await requireAdmin(req);
    await db.run('DELETE FROM coupons WHERE code = ?', params[0].toUpperCase());
    sendJson(res, 200, { ok: true });
  });

  route('GET', '/api/admin/orders', async ({ req, res, url }) => {
    await requireAdmin(req);
    await maybeMaintain();
    const st = url.searchParams.get('status');
    const rows = st && shop.ORDER_STATUSES.includes(st)
      ? await db.all('SELECT * FROM orders WHERE status = ? ORDER BY created_at DESC LIMIT 300', st)
      : await db.all('SELECT * FROM orders ORDER BY created_at DESC LIMIT 300');
    const counts = {};
    for (const r of await db.all('SELECT status, COUNT(*) AS n FROM orders GROUP BY status')) counts[r.status] = Number(r.n);
    sendJson(res, 200, { orders: rows.map(orderForAdmin), counts });
  });

  route('GET', '/api/admin/orders/export.csv', async ({ req, res }) => {
    await requireAdmin(req);
    const esc = (v) => {
      let s = String(v ?? '');
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // anti formula-injection in Excel
      return `"${s.replace(/"/g, '""')}"`;
    };
    const head = ['Ordine', 'Data', 'Stato', 'Pagamento', 'Cliente', 'Email', 'Telefono', 'Indirizzo', 'CAP', 'Città', 'Articoli', 'Coupon', 'Spedizione', 'Totale', 'Note'];
    const lines = [head.map(esc).join(',')];
    for (const o of await db.all('SELECT * FROM orders ORDER BY created_at DESC')) {
      const items = JSON.parse(o.items_json).map((i) => `${i.qty}x ${i.title}`).join(' | ');
      lines.push(
        [o.id, String(o.created_at).slice(0, 19), o.status, o.provider, o.customer_name, o.email, o.phone, o.address, o.zip, o.city, items,
          o.coupon_code || '', shop.eur(o.shipping_cents), shop.eur(o.total_cents), o.notes].map(esc).join(',')
      );
    }
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="ordini.csv"',
      'Cache-Control': 'no-store',
    });
    res.end('\ufeff' + lines.join('\r\n'));
  });

  route('PATCH', '/api/admin/orders/([A-Z0-9-]{6,20})', async ({ req, res, params }) => {
    await requireAdmin(req);
    const b = await readJson(req);
    if (b.status !== undefined) await shop.setOrderStatus(db, params[0], b.status);
    if (b.adminNote !== undefined) {
      await db.run('UPDATE orders SET admin_note = ? WHERE id = ?', str(b.adminNote, 0, 500, 'Nota'), params[0]);
    }
    const o = await shop.getOrder(db, params[0]);
    if (!o) throw new HttpError(404, 'Ordine non trovato.');
    sendJson(res, 200, { order: orderForAdmin(o) });
  });

  route('GET', '/api/admin/settings', async ({ req, res }) => {
    await requireAdmin(req);
    const s = await getSettings(db);
    sendJson(res, 200, {
      settings: {
        shopName: s.shop_name,
        announcement: s.announcement,
        logo: s.logo,
        whatsapp: s.whatsapp,
        shippingCents: Number(s.shipping_cents),
        freeShippingOverCents: Number(s.free_shipping_over_cents),
        bankIban: s.bank_iban,
        bankHolder: s.bank_holder,
        legalName: s.legal_name,
        vat: s.vat,
        contactEmail: s.contact_email,
        businessAddress: s.business_address,
      },
      payments: { stripe: pay.stripeEnabled(cfg), stripeWebhook: Boolean(cfg.stripeWebhookSecret), paypal: pay.paypalEnabled(cfg), baseUrl: cfg.baseUrl },
    });
  });

  route('PUT', '/api/admin/settings', async ({ req, res }) => {
    await requireAdmin(req);
    const b = await readJson(req);
    const whatsapp = String(b.whatsapp || '').replace(/[\s+]/g, '');
    if (!/^\d{8,15}$/.test(whatsapp)) throw new HttpError(400, 'WhatsApp: solo cifre con prefisso internazionale (es. 393401234567).');
    const iban = String(b.bankIban || '').replace(/\s+/g, '').toUpperCase();
    if (iban && !/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) throw new HttpError(400, 'IBAN non valido.');
    const logo = validImageRef(b.logo) || '/img/logo-default.svg';
    const prevLogo = (await getSettings(db)).logo;
    const next = {
      shop_name: str(b.shopName, 2, 100, 'Nome negozio'),
      announcement: str(b.announcement ?? '', 0, 200, 'Annuncio'),
      logo,
      whatsapp,
      shipping_cents: String(intIn(b.shippingCents, 0, 1_000_000, 'Spedizione')),
      free_shipping_over_cents: String(intIn(b.freeShippingOverCents, 0, 1_000_000, 'Soglia spedizione gratuita')),
      bank_iban: iban,
      bank_holder: str(b.bankHolder ?? '', 0, 100, 'Intestatario'),
      legal_name: str(b.legalName ?? '', 0, 150, 'Ragione sociale'),
      vat: str(b.vat ?? '', 0, 40, 'Partita IVA / C.F.'),
      contact_email: str(b.contactEmail ?? '', 0, 120, 'Email di contatto'),
      business_address: str(b.businessAddress ?? '', 0, 200, 'Sede'),
    };
    for (const [k, v] of Object.entries(next)) await setSetting(db, k, v);
    if (prevLogo !== logo) await removeUploadIfLocal(prevLogo);
    sendJson(res, 200, { ok: true });
  });

  route('GET', '/api/admin/content', async ({ req, res }) => {
    await requireAdmin(req);
    const themes = Object.fromEntries(Object.entries(content.THEMES).map(([k, v]) => [k, { label: v.label, cls: v.cls }]));
    sendJson(res, 200, { content: content.contentFrom(await getSettings(db)), defaults: content.DEFAULT_CONTENT, themes });
  });

  route('PUT', '/api/admin/content', async ({ req, res }) => {
    await requireAdmin(req);
    const next = content.parseContent(await readJson(req), validImageRef);
    const prev = content.contentFrom(await getSettings(db));
    await setSetting(db, 'content', JSON.stringify(next));
    if (prev.heroImage !== next.heroImage) await removeUploadIfLocal(prev.heroImage);
    sendJson(res, 200, { ok: true });
  });

  route('POST', '/api/admin/password', async ({ req, res }) => {
    await requireAdmin(req);
    const b = await readJson(req);
    const s = await getSettings(db);
    if (!auth.verifyPassword(String(b.currentPassword || ''), s.admin_hash)) throw new HttpError(400, 'Password attuale errata.');
    const np = String(b.newPassword || '');
    if (np.length < 10 || np.length > 200) throw new HttpError(400, 'La nuova password deve avere almeno 10 caratteri.');
    await setSetting(db, 'admin_hash', auth.hashPassword(np));
    await auth.clearAllSessions(db);
    const sess = await auth.createSession(db);
    sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookie(sess.token, sess.maxAgeSec) });
  });

  route('POST', '/api/admin/upload', async ({ req, res }) => {
    await requireAdmin(req);
    const b = await readJson(req, 3.4 * 1024 * 1024);
    sendJson(res, 201, { url: await saveUpload(b.dataUrl) });
  });

  route('GET', '/healthz', async ({ res }) => {
    await db.get('SELECT 1 AS ok');
    sendJson(res, 200, { ok: true });
  });

  /* ---------- pagine e file statici ---------- */
  async function renderTemplate(file) {
    const html = fs.readFileSync(file, 'utf8');
    const s = await getSettings(db);
    const jsonld = JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'CraftStore',
      name: s.shop_name,
      description: 'Creazioni artigianali fatte a mano: fiocchi natalizi, bomboniere personalizzate e articoli da mercatino.',
      url: cfg.baseUrl,
      telephone: `+${s.whatsapp}`,
      priceRange: '€€',
    }).replace(/</g, '\\u003c');
    const pending = '[da inserire da Admin → Impostazioni]';
    const c = content.contentFrom(s);
    const raw = {
      HERO: content.heroHtml(c),
      BRAND_TAGLINE_HTML: content.taglineHtml(c),
      FOOTER_NOTE_HTML: content.footerNoteHtml(c),
      FOOTER_LINKS: content.footerLinksHtml(c),
      FOOTER_PAY: content.footerPayHtml(c),
      ADMIN_LINK: content.adminLinkHtml(c),
    };
    const year = String(new Date().getFullYear());
    const vars = {
      BRAND_MAIN: c.brandMain,
      BRAND_ACCENT: c.brandAccent,
      NAV_QUOTE_LABEL: c.navQuoteLabel,
      FLOAT_QUOTE_LABEL: c.floatQuoteLabel,
      FOOTER_LINKS_TITLE: c.footerLinksTitle,
      COPYRIGHT: c.copyrightText || `© ${year} ${s.shop_name}`,
      SHOP_NAME: s.shop_name,
      ANNOUNCEMENT: s.announcement,
      LOGO: s.logo,
      LEGAL_NAME: s.legal_name || s.shop_name,
      VAT: s.vat || pending,
      CONTACT_EMAIL: s.contact_email || pending,
      BUSINESS_ADDRESS: s.business_address || pending,
      BASE_URL: cfg.baseUrl,
      YEAR: year,
    };
    return html.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => {
      if (k === 'JSONLD') return jsonld;
      if (k in raw) return raw[k]; // HTML già costruito e "escapato" da lib/content.js
      return k in vars ? escapeHtml(vars[k]) : m;
    });
  }

  const PAGES = { '/': 'index.html', '/admin': 'admin.html', '/privacy': 'privacy.html', '/termini': 'termini.html' };

  function notFound(req, res) {
    if (req.url.startsWith('/api/')) return sendJson(res, 404, { error: 'Non trovato.' });
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><meta charset="utf-8"><title>404</title><body style="font-family:sans-serif;text-align:center;padding:4rem"><h1>404</h1><p>Pagina non trovata.</p><a href="/">Torna al negozio</a></body>');
  }

  async function servePublic(req, res, url) {
    let p;
    try {
      p = decodeURIComponent(url.pathname);
    } catch {
      return notFound(req, res);
    }
    if (p === '/robots.txt') {
      res.writeHead(200, { 'Content-Type': MIME['.txt'] });
      return res.end(`User-agent: *\nDisallow: /admin\nDisallow: /api/\nSitemap: ${cfg.baseUrl}/sitemap.xml\n`);
    }
    if (p === '/sitemap.xml') {
      const urls = ['/', '/privacy', '/termini'].map((u) => `<url><loc>${cfg.baseUrl}${u === '/' ? '' : u}</loc></url>`).join('');
      res.writeHead(200, { 'Content-Type': MIME['.xml'] });
      return res.end(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`);
    }
    if (PAGES[p]) {
      const body = await renderTemplate(path.join(cfg.viewsDir, PAGES[p]));
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
      return res.end(req.method === 'HEAD' ? undefined : body);
    }
    if (p.startsWith('/uploads/')) return serveUpload(req, res, p.slice('/uploads/'.length));

    // File statici (in produzione su Vercel li serve direttamente la CDN; qui servono in locale)
    const file = path.resolve(cfg.publicDir, '.' + p);
    const rel = path.relative(cfg.publicDir, file);
    if (rel.startsWith('..') || path.isAbsolute(rel) || rel.split(path.sep).some((s) => s.startsWith('.'))) return notFound(req, res);
    const ext = path.extname(file).toLowerCase();
    if (!MIME[ext] || ext === '.html') return notFound(req, res);
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      return notFound(req, res);
    }
    if (!st.isFile()) return notFound(req, res);
    res.writeHead(200, { 'Content-Type': MIME[ext], 'Content-Length': st.size, 'Cache-Control': 'no-cache' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  }

  /* ---------- gestore richieste (usato da server locale e da Vercel) ---------- */
  function securityHeaders(res) {
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (cfg.isHttps) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  async function handle(req, res) {
    securityHeaders(res);
    try {
      const url = new URL(req.url, 'http://localhost');
      const isApi = url.pathname.startsWith('/api/') || url.pathname === '/healthz';
      if (isApi) {
        const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
        if (!r) {
          const known = routes.some((x) => x.re.test(url.pathname));
          throw new HttpError(known ? 405 : 404, known ? 'Metodo non consentito.' : 'Non trovato.');
        }
        const params = r.re.exec(url.pathname).slice(1);
        return await r.handler({ req, res, url, params });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Metodo non consentito.');
      return await servePublic(req, res, url);
    } catch (e) {
      if (res.headersSent) return res.end();
      if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message });
      console.error('[errore]', e);
      return sendJson(res, 500, { error: 'Errore interno del server.' });
    }
  }

  const server = http.createServer(handle);

  return {
    server,
    handle,
    db,
    cfg,
    async close() {
      quoteLimiter.stop();
      await new Promise((resolve) => {
        if (!server.listening) return resolve();
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
      try {
        await db.close();
      } catch {
        /* già chiuso */
      }
    },
  };
}

/* ------------------------------ Vercel / serverless ------------------------------ */

let appPromise = null;
/** Handler (req, res) con inizializzazione pigra: usato da api/index.js. */
async function vercelHandler(req, res) {
  try {
    appPromise ||= createApp(loadConfig());
    const app = await appPromise;
    return await app.handle(req, res);
  } catch (e) {
    appPromise = null; // ritenta al prossimo accesso
    console.error('[avvio]', e);
    const msg = /ADMIN_PASSWORD|DATABASE_URL/.test(e.message)
      ? e.message
      : "Il sito non riesce ad avviarsi: controlla le variabili d'ambiente e il database nei log.";
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(msg);
  }
}

/* ------------------------------ avvio locale ------------------------------ */

if (require.main === module) {
  (async () => {
    try {
      process.loadEnvFile(path.join(__dirname, '.env'));
    } catch {
      /* .env opzionale: le variabili possono arrivare dall'ambiente */
    }
    const app = await createApp(loadConfig());
    app.server.listen(app.cfg.port, () => {
      console.log(`G&T Hobbistica online su ${app.cfg.baseUrl} (porta ${app.cfg.port})`);
      console.log(`  - Database: ${app.cfg.databaseUrl ? 'Postgres' : 'SQLite in ' + app.cfg.dataDir}`);
      if (!pay.stripeEnabled(app.cfg)) console.log('  - Stripe: non configurato (carte disattivate)');
      if (!pay.paypalEnabled(app.cfg)) console.log('  - PayPal: non configurato');
      if (app.cfg.stripeSecretKey && !app.cfg.stripeWebhookSecret) console.log('  ! Stripe attivo ma STRIPE_WEBHOOK_SECRET mancante: i pagamenti non verranno confermati');
    });
    const stop = () => app.close().then(() => process.exit(0));
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
  })().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}

module.exports = { createApp, vercelHandler };
