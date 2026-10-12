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
const validPhoto = (p) => typeof p === 'string' && p.startsWith('data:image/') && p.length < 150000;
const ck = (a, b) => 'chat:' + [a, b].sort().join(':');
const getUsers = async (ids) => (ids.length ? (await redis.mget(...ids.map((x) => 'u:' + x))).filter(Boolean) : []);
const allUsers = async () => getUsers(await redis.smembers('users'));
const makeMatch = async (a, b) => {
  await Promise.all([
    redis.srem('inbox:' + a, b), redis.srem('inbox:' + b, a),
    redis.sadd('match:' + a, b), redis.sadd('match:' + b, a),
    redis.sadd('likes:' + a, b), redis.sadd('likes:' + b, a),
  ]);
};
const parse = (m) => { if (typeof m === 'string') { try { return JSON.parse(m); } catch (e) { return { f: '', t: m, ts: 0 }; } } return m; };

module.exports = async (req, res) => {
  const action = req.query.action;
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const fail = (code, error) => res.status(code).json({ error });
  try {
    if (action === 'join' && req.method === 'POST') {
      const name = String(body.name || '').trim().slice(0, 40);
      const age = parseInt(body.age, 10);
      const phone = String(body.phone || '').replace(/[^\d+]/g, '').slice(0, 15);
      if (!name || !(age >= 14 && age <= 100) || !/^\+91[6-9]\d{9}$/.test(phone))
        return fail(400, 'Enter a valid name, age and Indian mobile number');
      const photo = validPhoto(body.photo) ? body.photo : '';
      if (!photo) return fail(400, 'Please upload a photo');
      const id = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      const ua = String(req.headers['user-agent'] || '');
      const device = /ipad|tablet/i.test(ua) ? 'Tablet' : /mobi|android|iphone/i.test(ua) ? 'Mobile' : 'Desktop';
      await redis.set('u:' + id, { id, name, age, phone, photo, device, seen: Date.now(), joined: Date.now() });
      await redis.sadd('users', id);
      return res.json({ id });
    }

    if (action === 'profile' && req.method === 'POST') {
      const me = await redis.get('u:' + body.id);
      if (!me) return fail(404, 'Session expired');
      const hobbies = clean(body.hobbies, 10, 30);
      const looking = LOOKING.includes(body.looking) ? body.looking : '';
      if (!hobbies.length || !looking) return fail(400, 'Pick at least one hobby and what you are looking for');
      Object.assign(me, {
        hobbies, looking,
        likes: String(body.likes || '').trim().slice(0, 200),
        traits: clean(body.traits, 8, 30),
        note: String(body.note || '').trim().slice(0, 200),
      });
      if (validPhoto(body.photo)) me.photo = body.photo;
      await redis.set('u:' + body.id, me);
      return res.json({ ok: true });
    }

    if (action === 'matches') {
      const id = String(req.query.id || '');
      const me = await redis.get('u:' + id);
      if (!me) return fail(404, 'Session expired');
      me.seen = Date.now();
      await redis.set('u:' + id, me);
      const mine = (me.hobbies || []).map((h) => h.toLowerCase());
      const common = (u) => (u.hobbies || []).filter((h) => mine.includes(h.toLowerCase()));
      const [sent, matchIds, inboxIds] = await Promise.all([
        redis.smembers('likes:' + id), redis.smembers('match:' + id), redis.smembers('inbox:' + id),
      ]);
      const users = (await allUsers()).filter((u) => u.id !== id && u.looking);
      const byId = Object.fromEntries(users.map((u) => [u.id, u]));
      const online = (u) => Date.now() - u.seen < ONLINE_MS;
      const people = users
        .filter((u) => !matchIds.includes(u.id) && !inboxIds.includes(u.id))
        .map((u) => ({ ...pub(u), online: online(u), liked: sent.includes(u.id), common: common(u) }));
      people.sort((a, b) => b.common.length - a.common.length || b.online - a.online);
      const requests = inboxIds.map((x) => byId[x]).filter(Boolean).map((u) => ({ ...pub(u), common: common(u) }));
      const matches = [];
      for (const x of matchIds) {
        const u = byId[x];
        if (!u) continue;
        const [len, rd] = await Promise.all([redis.llen(ck(id, x)), redis.get('rd:' + id + ':' + x)]);
        matches.push({ ...pub(u), online: online(u), unread: Math.max(0, len - (Number(rd) || 0)) });
      }
      return res.json({ me: { ...pub(me), done: !!me.looking }, people, requests, matches });
    }

    // A asks B to dandiya -> B gets a request to approve or deny
    if (action === 'like' && req.method === 'POST') {
      const { id, target } = body;
      const [me, t] = await Promise.all([redis.get('u:' + id), redis.get('u:' + target)]);
      if (!me) return fail(404, 'Session expired');
      if (!t || id === target) return fail(400, 'Person not found');
      if (await redis.sismember('match:' + id, target)) return res.json({ matched: true });
      if (await redis.sismember('inbox:' + id, target)) { await makeMatch(id, target); return res.json({ matched: true }); }
      await redis.sadd('likes:' + id, target);
      if (!(await redis.sismember('denied:' + target, id))) await redis.sadd('inbox:' + target, id);
      return res.json({ ok: true });
    }

    if (action === 'respond' && req.method === 'POST') {
      const { id, from, accept } = body;
      if (!(await redis.get('u:' + id))) return fail(404, 'Session expired');
      if (!(await redis.sismember('inbox:' + id, from))) return fail(400, 'Request not found');
      await redis.srem('inbox:' + id, from);
      if (accept) await makeMatch(id, from);
      else await redis.sadd('denied:' + id, from);
      return res.json({ ok: true, matched: !!accept });
    }

    if (action === 'send' && req.method === 'POST') {
      const text = String(body.text || '').trim().slice(0, 500);
      if (!text) return fail(400, 'Type a message');
      if (!(await redis.sismember('match:' + body.id, body.to))) return fail(403, 'Not matched');
      const key = ck(body.id, body.to);
      await redis.rpush(key, { f: body.id, t: text, ts: Date.now() });
      await redis.ltrim(key, -200, -1);
      return res.json({ ok: true });
    }

    if (action === 'chat') {
      const id = String(req.query.id || ''), w = String(req.query.with || '');
      if (!(await redis.sismember('match:' + id, w))) return fail(403, 'Not matched');
      const msgs = (await redis.lrange(ck(id, w), 0, -1)).map(parse);
      await redis.set('rd:' + id + ':' + w, msgs.length);
      return res.json({ msgs });
    }

    if (action === 'unmatch' && req.method === 'POST') {
      const { id } = body, w = body.with;
      if (!(await redis.get('u:' + id))) return fail(404, 'Session expired');
      await Promise.all([
        redis.srem('match:' + id, w), redis.srem('match:' + w, id),
        redis.srem('likes:' + id, w), redis.srem('likes:' + w, id),
        redis.sadd('denied:' + id, w), redis.sadd('denied:' + w, id),
        redis.del(ck(id, w), 'rd:' + id + ':' + w, 'rd:' + w + ':' + id),
      ]);
      return res.json({ ok: true });
    }

    if (action === 'admin' && req.method === 'POST') {
      if (!adminOk(body.password)) return fail(401, 'Wrong password');
      if (body.remove) {
        await redis.srem('users', body.remove);
        await redis.del('u:' + body.remove, 'likes:' + body.remove, 'inbox:' + body.remove, 'match:' + body.remove);
      }
      const users = (await allUsers()).map((u) => ({ ...u, online: Date.now() - u.seen < ONLINE_MS }));
      users.sort((a, b) => b.seen - a.seen);
      return res.json({ total: users.length, online: users.filter((u) => u.online).length, users });
    }

    return fail(404, 'Not found');
  } catch (e) {
    return fail(500, 'Server error: ' + e.message);
  }
};
