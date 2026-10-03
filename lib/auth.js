'use strict';
const crypto = require('node:crypto');
const { sha256, safeEqual } = require('./util');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored) return false;
  const [algo, salt, hash] = stored.split('$');
  if (algo !== 'scrypt' || !salt || !hash) return false;
  const test = crypto.scryptSync(password, salt, 64).toString('hex');
  return safeEqual(test, hash);
}

const SESSION_MS = 7 * 24 * 3600 * 1000;

async function createSession(db) {
  const token = crypto.randomBytes(32).toString('hex');
  await db.run('INSERT INTO sessions (token_hash, expires_at) VALUES (?, ?)', sha256(token), Date.now() + SESSION_MS);
  return { token, maxAgeSec: SESSION_MS / 1000 };
}

async function destroySession(db, token) {
  if (token) await db.run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
}

async function isValidSession(db, token) {
  if (!token) return false;
  const row = await db.get('SELECT expires_at FROM sessions WHERE token_hash = ?', sha256(token));
  if (!row) return false;
  if (Number(row.expires_at) < Date.now()) {
    await destroySession(db, token);
    return false;
  }
  return true;
}

async function purgeExpiredSessions(db) {
  await db.run('DELETE FROM sessions WHERE expires_at < ?', Date.now());
}

async function clearAllSessions(db) {
  await db.run('DELETE FROM sessions');
}

module.exports = { hashPassword, verifyPassword, createSession, isValidSession, destroySession, purgeExpiredSessions, clearAllSessions };
