'use strict';
/**
 * Rate limit salvato nel database: funziona anche su serverless, dove ogni richiesta
 * può essere gestita da un'istanza diversa (un contatore in memoria non basterebbe).
 */
async function hit(db, key, max, windowMs) {
  const now = Date.now();
  const reset = now + windowMs;
  const row = await db.get(
    `INSERT INTO rate_limits (key, count, reset_at) VALUES (?, 1, ?)
     ON CONFLICT (key) DO UPDATE SET
       count = CASE WHEN rate_limits.reset_at <= ? THEN 1 ELSE rate_limits.count + 1 END,
       reset_at = CASE WHEN rate_limits.reset_at <= ? THEN ? ELSE rate_limits.reset_at END
     RETURNING count`,
    key, reset, now, now, reset
  );
  return Number(row.count) <= max;
}

async function clear(db, key) {
  await db.run('DELETE FROM rate_limits WHERE key = ?', key);
}

async function purge(db) {
  await db.run('DELETE FROM rate_limits WHERE reset_at < ?', Date.now());
}

module.exports = { hit, clear, purge };
