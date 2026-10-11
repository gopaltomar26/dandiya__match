const { Redis } = require('@upstash/redis');
const crypto = require('crypto');
const e = process.env;

// Works with the variables Vercel adds when you connect Upstash Redis
const redis = new Redis({
  url: e.UPSTASH_REDIS_REST_URL || e.KV_REST_API_URL,
  token: e.UPSTASH_REDIS_REST_TOKEN || e.KV_REST_API_TOKEN,
  automaticDeserialization: false,
});

// The browser keeps a secret id; other people only ever see this short public id
const pid = (id) => crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 12);
const okId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(id);
const bad = (res, code, msg) => res.status(code).json({ error: msg });
const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch (x) { return d; } };

module.exports = { redis, pid, okId, bad, parse };
