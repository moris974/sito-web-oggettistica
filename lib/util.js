'use strict';
const crypto = require('node:crypto');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', (c) => {
      if (failed) return;
      size += c.length;
      if (size > limit) {
        failed = true;
        reject(new HttpError(413, 'Richiesta troppo grande.'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

async function readJson(req, limit = 64 * 1024) {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try {
    const v = JSON.parse(buf.toString('utf8'));
    if (v === null || typeof v !== 'object') throw new Error('not object');
    return v;
  } catch {
    throw new HttpError(400, 'JSON non valido.');
  }
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      /* cookie malformato: ignorato */
    }
  }
  return out;
}

class RateLimiter {
  constructor(max, windowMs) {
    this.max = max;
    this.windowMs = windowMs;
    this.hits = new Map();
    this.timer = setInterval(() => this.sweep(), windowMs);
    this.timer.unref();
  }
  sweep() {
    const now = Date.now();
    for (const [k, v] of this.hits) if (v.reset <= now) this.hits.delete(k);
  }
  /** true = consentito */
  hit(key) {
    const now = Date.now();
    let e = this.hits.get(key);
    if (!e || e.reset <= now) {
      e = { count: 0, reset: now + this.windowMs };
      this.hits.set(key, e);
    }
    e.count++;
    return e.count <= this.max;
  }
  clear(key) {
    this.hits.delete(key);
  }
  stop() {
    clearInterval(this.timer);
  }
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Timestamp UTC ordinabile come testo: 'YYYY-MM-DD HH:MM:SS.mmm' (uguale su SQLite e Postgres). */
const tsFromMs = (ms = Date.now()) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '');
const tsNow = () => tsFromMs(Date.now());

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

module.exports = { HttpError, sendJson, readBody, readJson, parseCookies, RateLimiter, escapeHtml, sha256, safeEqual, tsFromMs, tsNow };
