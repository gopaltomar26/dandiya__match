const { Redis } = require('@upstash/redis');
const env = (suffix) => process.env[Object.keys(process.env).find((k) => k.endsWith(suffix))];
const redis = new Redis({
  url: env('KV_REST_API_URL') || env('UPSTASH_REDIS_REST_URL'),
  token: env('KV_REST_API_TOKEN') || env('UPSTASH_REDIS_REST_TOKEN'),
});
const ONLINE_MS = 45000;
const LOOKING = ['Dandiya partner for the night', 'New friends', 'Something serious'];
const pub = (u) => ({ id: u.id, name: u.name, age: u.age, photo: u.photo, hobbies: u.hobbies || [], likes: u.likes || '', looking: u.looking || '', traits: u.traits || [], note: u.note || '' });
const adminOk = (p) => process.env.ADMIN_PASSWORD && p === process.env.ADMIN_PASSWORD;
const clean = (a, n, len) => (Array.isArray(a) ? a : []).map((x) => String(x).trim().slice(0, len)).filter(Boolean).slice(0, n);

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
      if (!name || !(age >= 14 && age <= 100) || !/^\+91[6-9]\d{9}$/.test(phone))
        return res.status(400).json({ error: 'Enter a valid name, age and Indian mobile number' });
      const photo = typeof body.photo === 'string' && body.photo.startsWith('data:image/') && body.photo.length < 150000 ? body.photo : '';
      if (!photo) return res.status(400).json({ error: 'Please upload a photo' });
      const id = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      const ua = String(req.headers['user-agent'] || '');
      const device = /ipad|tablet/i.test(ua) ? 'Tablet' : /mobi|android|iphone/i.test(ua) ? 'Mobile' : 'Desktop';
      await redis.set('u:' + id, { id, name, age, phone, photo, device, seen: Date.now(), joined: Date.now() });
      await redis.sadd('users', id);
      return res.json({ id });
    }

    if (action === 'profile' && req.method === 'POST') {
      const me = await redis.get('u:' + body.id);
      if (!me) return res.status(404).json({ error: 'Session expired' });
      const hobbies = clean(body.hobbies, 10, 30);
      const looking = LOOKING.includes(body.looking) ? body.looking : '';
      if (!hobbies.length || !looking) return res.status(400).json({ error: 'Pick at least one hobby and what you are looking for' });
      Object.assign(me, {
        hobbies, looking,
        likes: String(body.likes || '').trim().slice(0, 200),
        traits: clean(body.traits, 8, 30),
        note: String(body.note || '').trim().slice(0, 200),
      });
      await redis.set('u:' + body.id, me);
      return res.json({ ok: true });
    }

    if (action === 'matches') {
      const id = String(req.query.id || '');
      const me = await redis.get('u:' + id);
      if (!me) return res.status(404).json({ error: 'Session expired' });
      me.seen = Date.now();
      await redis.set('u:' + id, me);
      const mine = (me.hobbies || []).map((h) => h.toLowerCase());
      const users = (await allUsers()).filter((u) => u.id !== id && u.looking);
      const liked = await redis.smembers('likes:' + id);
      const people = users.map((u) => ({
        ...pub(u),
        online: Date.now() - u.seen < ONLINE_MS,
        liked: liked.includes(u.id),
        common: (u.hobbies || []).filter((h) => mine.includes(h.toLowerCase())),
      }));
      people.sort((a, b) => b.common.length - a.common.length || b.online - a.online);
      const matches = [];
      for (const u of users) {
        if (liked.includes(u.id) && (await redis.sismember('likes:' + u.id, id)))
          matches.push({ ...pub(u), phone: u.phone, common: (u.hobbies || []).filter((h) => mine.includes(h.toLowerCase())) });
      }
      return res.json({ me: { ...pub(me), done: !!me.looking }, people, matches });
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
