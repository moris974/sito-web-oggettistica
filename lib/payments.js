'use strict';
const crypto = require('node:crypto');
const { HttpError, safeEqual } = require('./util');
const { eur } = require('./shop');

/** fetch con errore di rete trasformato in 502 leggibile. */
async function httpFetch(url, options, label) {
  try {
    return await fetch(url, { ...options, signal: AbortSignal.timeout(8000) });
  } catch (e) {
    console.error(`[${label}] rete non raggiungibile:`, e.cause?.message || e.message);
    throw new HttpError(502, 'Servizio di pagamento non raggiungibile. Riprova o scegli un altro metodo.');
  }
}

/* ------------------------------ STRIPE ------------------------------ */

function stripeEnabled(cfg) {
  return Boolean(cfg.stripeSecretKey);
}

/** Crea una Checkout Session ospitata da Stripe. Gli importi arrivano dal calcolo server-side. */
async function createStripeSession(cfg, order, priced, customer) {
  const body = new URLSearchParams();
  body.set('mode', 'payment');
  body.set('locale', 'it');
  body.set('client_reference_id', order.id);
  body.set('customer_email', customer.email);
  body.set('metadata[order_id]', order.id);
  body.set('payment_intent_data[metadata][order_id]', order.id);
  body.set('payment_intent_data[description]', `Ordine ${order.id} - ${cfg.shopName}`);
  body.set('success_url', `${cfg.baseUrl}/?ordine=${order.id}&esito=ok`);
  body.set('cancel_url', `${cfg.baseUrl}/?ordine=${order.id}&esito=annullato`);
  body.set('expires_at', String(Math.floor(Date.now() / 1000) + 31 * 60));

  let i = 0;
  const addLine = (name, unitCents, qty) => {
    body.set(`line_items[${i}][quantity]`, String(qty));
    body.set(`line_items[${i}][price_data][currency]`, 'eur');
    body.set(`line_items[${i}][price_data][unit_amount]`, String(unitCents));
    body.set(`line_items[${i}][price_data][product_data][name]`, name.slice(0, 250));
    i++;
  };
  for (const l of priced.lines) addLine(l.title, l.unitCents, l.qty);
  if (priced.shippingCents > 0) addLine('Spedizione', priced.shippingCents, 1);

  const res = await httpFetch(
    `${cfg.stripeApiBase}/v1/checkout/sessions`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.stripeSecretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    },
    'stripe'
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.url) {
    console.error('[stripe] errore creazione sessione:', res.status, data && data.error && data.error.message);
    throw new HttpError(502, 'Pagamento con carta momentaneamente non disponibile. Riprova o scegli un altro metodo.');
  }
  return { id: data.id, url: data.url };
}

/**
 * Verifica la firma di un webhook Stripe (header Stripe-Signature).
 * Ritorna l'evento già parsato oppure lancia HttpError(400).
 */
function verifyStripeWebhook(rawBody, header, secret, toleranceSec = 300) {
  if (!secret) throw new HttpError(503, 'Webhook non configurato.');
  if (!header) throw new HttpError(400, 'Firma mancante.');
  const parts = String(header)
    .split(',')
    .map((p) => p.trim().split('='));
  const t = parts.find(([k]) => k === 't')?.[1];
  const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!t || sigs.length === 0) throw new HttpError(400, 'Firma non valida.');
  const age = Math.abs(Date.now() / 1000 - Number(t));
  if (!Number.isFinite(age) || age > toleranceSec) throw new HttpError(400, 'Firma scaduta.');
  const expected = crypto.createHmac('sha256', secret).update(`${t}.`).update(rawBody).digest('hex');
  if (!sigs.some((s) => safeEqual(s, expected))) throw new HttpError(400, 'Firma non valida.');
  try {
    return JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw new HttpError(400, 'Payload non valido.');
  }
}

/* ------------------------------ PAYPAL ------------------------------ */

function paypalEnabled(cfg) {
  return Boolean(cfg.paypalClientId && cfg.paypalClientSecret);
}

async function paypalToken(cfg) {
  const basic = Buffer.from(`${cfg.paypalClientId}:${cfg.paypalClientSecret}`).toString('base64');
  const res = await httpFetch(
    `${cfg.paypalApiBase}/v1/oauth2/token`,
    {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    },
    'paypal'
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    console.error('[paypal] errore token:', res.status);
    throw new HttpError(502, 'PayPal momentaneamente non disponibile. Riprova o scegli un altro metodo.');
  }
  return data.access_token;
}

async function createPaypalOrder(cfg, order, priced) {
  const token = await paypalToken(cfg);
  const res = await httpFetch(
    `${cfg.paypalApiBase}/v2/checkout/orders`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [
          {
            reference_id: order.id,
            custom_id: order.id,
            description: `Ordine ${order.id} - ${cfg.shopName}`.slice(0, 127),
            amount: { currency_code: 'EUR', value: eur(priced.totalCents) },
          },
        ],
        application_context: {
          brand_name: cfg.shopName.slice(0, 127),
          locale: 'it-IT',
          user_action: 'PAY_NOW',
          shipping_preference: 'NO_SHIPPING',
          return_url: `${cfg.baseUrl}/api/paypal/return?order=${order.id}`,
          cancel_url: `${cfg.baseUrl}/?ordine=${order.id}&esito=annullato`,
        },
      }),
    },
    'paypal'
  );
  const data = await res.json().catch(() => ({}));
  const link = (data.links || []).find((l) => l.rel === 'approve' || l.rel === 'payer-action');
  if (!res.ok || !data.id || !link) {
    console.error('[paypal] errore creazione ordine:', res.status);
    throw new HttpError(502, 'PayPal momentaneamente non disponibile. Riprova o scegli un altro metodo.');
  }
  return { id: data.id, url: link.href };
}

/** Cattura il pagamento dopo l'approvazione del cliente. Ritorna { ok, amountCents }. */
async function capturePaypalOrder(cfg, paypalOrderId) {
  const token = await paypalToken(cfg);
  const res = await httpFetch(
    `${cfg.paypalApiBase}/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}/capture`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    },
    'paypal'
  );
  const data = await res.json().catch(() => ({}));
  const capture = data?.purchase_units?.[0]?.payments?.captures?.[0];
  const ok = res.ok && data.status === 'COMPLETED' && capture && capture.status === 'COMPLETED';
  return {
    ok: Boolean(ok),
    amountCents: ok ? Math.round(parseFloat(capture.amount.value) * 100) : 0,
    currency: ok ? capture.amount.currency_code : null,
    captureId: ok ? capture.id : null,
  };
}

module.exports = {
  stripeEnabled,
  createStripeSession,
  verifyStripeWebhook,
  paypalEnabled,
  createPaypalOrder,
  capturePaypalOrder,
};
