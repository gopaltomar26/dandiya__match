const crypto = require('crypto');
const { redis, bad, parse } = require('../lib/db');

// The password is checked here on the server, using the ADMIN_PASSWORD variable you set in Vercel
module.exports = async (req, res) => {
  if (req.method !== 'POST') return bad(res, 405, 'POST only');
  const given = String((req.body || {}).password || '');
  const real = process.env.ADMIN_PASSWORD || '';
  const h = (s) => crypto.createHash('sha256').update(s).digest();
  const ok = real.length > 0 && crypto.timingSafeEqual(h(given), h(real));
  if (!ok) {
    await new Promise((r) => setTimeout(r, 1000)); // slows down password guessing
    return bad(res, 401, 'Wrong password');
  }
  const [all, seen, lk] = await Promise.all([redis.hgetall('users'), redis.hgetall('seen'), redis.hgetall('likes')]);
  const likes = {};
  Object.keys(all || {}).forEach((k) => (likes[k] = parse((lk || {})[k], [])));
  const users = Object.entries(all || {}).map(([k, v]) => {
    const r = parse(v, {});
    const s = parse((seen || {})[k], {});
    return { pid: k, name: r.name, age: r.age, gender: r.gender, phone: r.phone, device: s.d || '', lastSeen: s.t || 0 };
  });
  let mutual = 0;
  Object.keys(likes).forEach((a) => likes[a].forEach((b) => { if (a < b && (likes[b] || []).includes(a)) mutual++; }));
  res.json({ now: Date.now(), users, mutual });
};
