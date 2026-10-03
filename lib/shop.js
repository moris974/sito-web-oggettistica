'use strict';
const crypto = require('node:crypto');
const { HttpError, tsNow, tsFromMs } = require('./util');
const { getSettings } = require('./db');

const CATEGORIES = {
  natale: 'Fiocchi & Addobbi Natalizi',
  bomboniere: 'Bomboniere Cerimonia',
  mercatino: 'Articoli da Mercatino',
};

const ORDER_STATUSES = ['pending', 'awaiting_payment', 'paid', 'shipped', 'cancelled'];

const today = () => new Date().toISOString().slice(0, 10);

function publicProduct(row, coupon) {
  return {
    id: row.id,
    title: row.title,
    category: row.category,
    priceCents: row.price_cents,
    stock: row.stock,
    image: row.image,
    description: row.description,
    coupon: coupon ? { code: coupon.code, percent: coupon.percent } : null,
  };
}

async function listPublicProducts(db) {
  const products = await db.all('SELECT * FROM products WHERE active = 1 ORDER BY id DESC');
  const coupons = await db.all(
    'SELECT * FROM coupons WHERE active = 1 AND product_id IS NOT NULL AND (expires_at IS NULL OR expires_at >= ?)',
    today()
  );
  const byProduct = new Map();
  for (const c of coupons) {
    const cur = byProduct.get(c.product_id);
    if (!cur || c.percent > cur.percent) byProduct.set(c.product_id, c);
  }
  return products.map((p) => publicProduct(p, byProduct.get(p.id)));
}

function normalizeItems(rawItems) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) throw new HttpError(400, 'Il carrello è vuoto.');
  if (rawItems.length > 50) throw new HttpError(400, 'Troppi articoli nel carrello.');
  const merged = new Map();
  for (const it of rawItems) {
    const id = Number(it && it.id);
    const qty = Number(it && it.qty);
    if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(qty) || qty < 1 || qty > 99) {
      throw new HttpError(400, 'Carrello non valido.');
    }
    merged.set(id, Math.min(99, (merged.get(id) || 0) + qty));
  }
  return [...merged].map(([id, qty]) => ({ id, qty }));
}

async function resolveCoupon(db, code, productIds) {
  if (!code) return null;
  const clean = String(code).trim().toUpperCase().slice(0, 40);
  if (!clean) return null;
  const row = await db.get('SELECT * FROM coupons WHERE code = ?', clean);
  if (!row || !row.active) throw new HttpError(400, 'Codice coupon non valido.');
  if (row.expires_at && row.expires_at < today()) throw new HttpError(400, 'Il coupon è scaduto.');
  if (row.product_id && !productIds.includes(row.product_id)) {
    throw new HttpError(400, 'Questo coupon vale solo per un articolo che non è nel carrello.');
  }
  return row;
}

/**
 * Calcola il carrello lato server (mai fidarsi dei prezzi del client).
 * Tutti gli importi sono in centesimi interi.
 */
async function priceCart(db, rawItems, couponCode) {
  const items = normalizeItems(rawItems);
  const settings = await getSettings(db);

  const products = new Map();
  for (const it of items) {
    const p = await db.get('SELECT * FROM products WHERE id = ? AND active = 1', it.id);
    if (!p) throw new HttpError(400, 'Un articolo nel carrello non è più disponibile.');
    if (p.stock < it.qty) {
      throw new HttpError(
        409,
        p.stock === 0 ? `"${p.title}" è esaurito.` : `"${p.title}": disponibili solo ${p.stock} pezzi.`
      );
    }
    products.set(it.id, p);
  }

  const coupon = await resolveCoupon(db, couponCode, [...products.keys()]);

  let listTotal = 0;
  let payTotal = 0;
  const lines = items.map((it) => {
    const p = products.get(it.id);
    const eligible = coupon && (coupon.product_id === null || coupon.product_id === p.id);
    const unit = eligible ? Math.round((p.price_cents * (100 - coupon.percent)) / 100) : p.price_cents;
    listTotal += p.price_cents * it.qty;
    payTotal += unit * it.qty;
    return {
      id: p.id,
      title: p.title,
      image: p.image,
      qty: it.qty,
      listUnitCents: p.price_cents,
      unitCents: unit,
      lineCents: unit * it.qty,
      discounted: unit !== p.price_cents,
    };
  });

  const shipBase = Number(settings.shipping_cents) || 0;
  const freeOver = Number(settings.free_shipping_over_cents) || 0;
  const shipping = freeOver > 0 && payTotal >= freeOver ? 0 : shipBase;

  return {
    lines,
    subtotalCents: listTotal,
    discountCents: listTotal - payTotal,
    shippingCents: shipping,
    totalCents: payTotal + shipping,
    coupon: coupon ? { code: coupon.code, percent: coupon.percent } : null,
    freeShippingOverCents: freeOver,
    freeShippingRemainingCents: freeOver > 0 && shipping > 0 ? freeOver - payTotal : 0,
  };
}

const ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newOrderId() {
  const bytes = crypto.randomBytes(8);
  let s = '';
  for (const b of bytes) s += ID_ALPHABET[b % ID_ALPHABET.length];
  return `GT-${s}`;
}

/** Crea l'ordine e RISERVA lo stock in un'unica transazione. */
async function createOrder(db, { customer, items, couponCode, provider }) {
  return db.tx(async (t) => {
    const priced = await priceCart(t, items, couponCode);
    for (const l of priced.lines) {
      const r = await t.run('UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?', l.qty, l.id, l.qty);
      if (r.changes !== 1) throw new HttpError(409, `"${l.title}" non è più disponibile nella quantità richiesta.`);
    }
    const id = newOrderId();
    const status = provider === 'bank' ? 'awaiting_payment' : 'pending';
    await t.run(
      `INSERT INTO orders (id, status, provider, customer_name, email, phone, address, city, zip, notes,
        subtotal_cents, discount_cents, shipping_cents, total_cents, coupon_code, items_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, status, provider, customer.name, customer.email, customer.phone, customer.address, customer.city,
      customer.zip, customer.notes, priced.subtotalCents, priced.discountCents, priced.shippingCents,
      priced.totalCents, priced.coupon ? priced.coupon.code : null,
      JSON.stringify(priced.lines.map((l) => ({ id: l.id, title: l.title, qty: l.qty, unitCents: l.unitCents }))),
      tsNow()
    );
    if (priced.coupon) await t.run('UPDATE coupons SET uses = uses + 1 WHERE code = ?', priced.coupon.code);
    return { id, status, priced };
  });
}

async function getOrder(db, id) {
  return (await db.get('SELECT * FROM orders WHERE id = ?', String(id))) || null;
}

async function restoreStock(t, order) {
  for (const it of JSON.parse(order.items_json)) {
    await t.run('UPDATE products SET stock = stock + ? WHERE id = ?', it.qty, it.id);
  }
}

/** Toglie lo stock (mai sotto zero) per ordini riattivati dopo un annullamento. */
async function reserveStockSoft(t, order) {
  for (const it of JSON.parse(order.items_json)) {
    await t.run('UPDATE products SET stock = CASE WHEN stock - ? < 0 THEN 0 ELSE stock - ? END WHERE id = ?', it.qty, it.qty, it.id);
  }
}

/** Annulla un ordine e rimette in magazzino i pezzi. */
async function cancelOrder(db, id, note) {
  return db.tx(async (t) => {
    const o = await t.get('SELECT * FROM orders WHERE id = ?', String(id));
    if (!o || o.status === 'cancelled') return false;
    await restoreStock(t, o);
    if (note) await t.run("UPDATE orders SET status = 'cancelled', admin_note = ? WHERE id = ?", note, id);
    else await t.run("UPDATE orders SET status = 'cancelled' WHERE id = ?", id);
    return true;
  });
}

/** Segna come pagato (idempotente). Se era già annullato, ri-riserva lo stock disponibile. */
async function markPaid(db, id, paymentRef) {
  return db.tx(async (t) => {
    const o = await t.get('SELECT * FROM orders WHERE id = ?', String(id));
    if (!o) return false;
    if (o.status === 'paid' || o.status === 'shipped') return true;
    let note = '';
    if (o.status === 'cancelled') {
      await reserveStockSoft(t, o);
      note = "Pagamento arrivato dopo l'annullamento automatico: verifica la disponibilità.";
    }
    if (note) {
      await t.run(
        "UPDATE orders SET status = 'paid', paid_at = ?, payment_ref = COALESCE(?, payment_ref), admin_note = ? WHERE id = ?",
        tsNow(), paymentRef || null, note, id
      );
    } else {
      await t.run(
        "UPDATE orders SET status = 'paid', paid_at = ?, payment_ref = COALESCE(?, payment_ref) WHERE id = ?",
        tsNow(), paymentRef || null, id
      );
    }
    return true;
  });
}

async function setOrderStatus(db, id, status) {
  if (!ORDER_STATUSES.includes(status)) throw new HttpError(400, 'Stato non valido.');
  const o = await getOrder(db, id);
  if (!o) throw new HttpError(404, 'Ordine non trovato.');
  if (status === o.status) return o;
  if (status === 'cancelled') await cancelOrder(db, id);
  else if (status === 'paid') await markPaid(db, id, null);
  else {
    // Da annullato verso pending/awaiting/shipped: riserva di nuovo lo stock
    await db.tx(async (t) => {
      if (o.status === 'cancelled') await reserveStockSoft(t, o);
      await t.run('UPDATE orders SET status = ? WHERE id = ?', status, id);
    });
  }
  return getOrder(db, id);
}

/** Annulla gli ordini carta/PayPal rimasti in sospeso troppo a lungo, liberando lo stock. */
async function expireStaleOrders(db, maxAgeMinutes = 45) {
  const cutoff = tsFromMs(Date.now() - maxAgeMinutes * 60_000);
  const stale = await db.all(
    "SELECT id FROM orders WHERE status = 'pending' AND provider IN ('stripe','paypal') AND created_at < ?",
    cutoff
  );
  let n = 0;
  for (const { id } of stale) if (await cancelOrder(db, id, 'Scaduto: pagamento non completato.')) n++;
  return n;
}

const eur = (cents) => (cents / 100).toFixed(2);

module.exports = {
  CATEGORIES,
  ORDER_STATUSES,
  listPublicProducts,
  priceCart,
  createOrder,
  getOrder,
  cancelOrder,
  markPaid,
  setOrderStatus,
  expireStaleOrders,
  eur,
};
