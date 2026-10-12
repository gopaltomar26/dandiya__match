const { Redis } = require('@upstash/redis');
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});
const ONLINE_MS = 45000;
const pub = (u) => ({ id: u.id, name: u.name, age: u.age, photo: u.photo });
const adminOk = (p) => process.env.ADMIN_PASSWORD && p === process.env.ADMIN_PASSWORD;

async function allUsers() {
  const ids = await redis.smembers('users');
  if (!ids.length) return [];
  return (await redis.mget(...ids.map((x) => 'u:' + x))).filter(Boolean);
}

module.exports = async (req, res) => {
  const action = req.query.action;
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  try {
    if (action === 'join' && req.method === 'POST') {
      const name = String(body.name || '').trim().slice(0, 40);
      const age = parseInt(body.age, 10);
      const phone = String(body.phone || '').replace(/[^\d+]/g, '').slice(0, 15);
      if (!name || !(age >= 14 && age <= 100) || phone.length < 8)
        return res.status(400).json({ error: 'Enter a valid name, age and phone number' });
      const photo = typeof body.photo === 'string' && body.photo.startsWith('data:image/') && body.photo.length < 150000 ? body.photo : '';
      const id = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      await redis.set('u:' + id, { id, name, age, phone, photo, seen: Date.now(), joined: Date.now() });
      await redis.sadd('users', id);
      return res.json({ id });
    }

    if (action === 'matches') {
      const id = String(req.query.id || '');
      const me = await redis.get('u:' + id);
      if (!me) return res.status(404).json({ error: 'Session expired' });
      me.seen = Date.now();
      await redis.set('u:' + id, me);
      const users = (await allUsers()).filter((u) => u.id !== id);
      const liked = await redis.smembers('likes:' + id);
      const people = users.map((u) => ({ ...pub(u), online: Date.now() - u.seen < ONLINE_MS, liked: liked.includes(u.id) }));
      const matches = [];
      for (const u of users) {
        if (liked.includes(u.id) && (await redis.sismember('likes:' + u.id, id))) matches.push({ ...pub(u), phone: u.phone });
      }
      return res.json({ me: pub(me), people, matches });
    }

    if (action === 'like' && req.method === 'POST') {
      const me = await redis.get('u:' + body.id);
      if (!me) return res.status(404).json({ error: 'Session expired' });
      await redis.sadd('likes:' + body.id, String(body.target));
      return res.json({ ok: true });
    }

    if (action === 'admin' && req.method === 'POST') {
      if (!adminOk(body.password)) return res.status(401).json({ error: 'Wrong password' });
      if (body.remove) {
        await redis.srem('users', body.remove);
        await redis.del('u:' + body.remove, 'likes:' + body.remove);
      }
      const users = (await allUsers()).map((u) => ({ ...u, online: Date.now() - u.seen < ONLINE_MS }));
      users.sort((a, b) => b.seen - a.seen);
      return res.json({ total: users.length, online: users.filter((u) => u.online).length, users });
    }

    return res.status(404).json({ error: 'Not found' });
  } catch (e) {
    return res.status(500).json({ error: 'Server error: ' + e.message });
  }
};
