'use strict';
const path = require('node:path');

function loadConfig(env = process.env) {
  const port = Number(env.PORT) || 3000;
  const serverless = Boolean(env.VERCEL);
  const baseUrl = (
    env.BASE_URL ||
    (env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : `http://localhost:${port}`)
  ).replace(/\/+$/, '');
  const paypalEnv = env.PAYPAL_ENV === 'live' ? 'live' : 'sandbox';
  return {
    port,
    baseUrl,
    isHttps: baseUrl.startsWith('https://'),
    serverless,
    allowSqlite: env.ALLOW_SQLITE === '1',
    // Postgres in produzione (Neon/Supabase/...); se assente si usa SQLite in DATA_DIR
    databaseUrl: env.DATABASE_URL || env.POSTGRES_URL || '',
    dataDir: path.resolve(env.DATA_DIR || path.join(__dirname, '..', 'data')),
    publicDir: path.join(__dirname, '..', 'public'),
    viewsDir: path.join(__dirname, '..', 'views'),
    trustProxy: env.TRUST_PROXY === '1' || serverless,
    adminUser: (env.ADMIN_USER || 'admin').trim(),
    adminPassword: env.ADMIN_PASSWORD || '',
    shopName: env.SHOP_NAME || 'G&T Hobbistica e Artigianato',
    stripeSecretKey: env.STRIPE_SECRET_KEY || '',
    stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
    stripeApiBase: env.STRIPE_API_BASE || 'https://api.stripe.com',
    paypalClientId: env.PAYPAL_CLIENT_ID || '',
    paypalClientSecret: env.PAYPAL_CLIENT_SECRET || '',
    paypalApiBase:
      env.PAYPAL_API_BASE || (paypalEnv === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com'),
  };
}

module.exports = { loadConfig };
