const crypto = require('crypto');
const nodemailer = require('nodemailer');
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
const parse = (m) => { if (typeof m === 'string') { try { return JSON.parse(m); } catch (e) { return { f: '', t: m, ts: 0 }; } } return m; };
const makeMatch = async (a, b) => {
  await Promise.all([
    redis.srem('inbox:' + a, b), redis.srem('inbox:' + b, a),
    redis.sadd('match:' + a, b), redis.sadd('match:' + b, a),
    redis.sadd('likes:' + a, b), redis.sadd('likes:' + b, a),
  ]);
};

// Gmail ignores dots and +tags, so normalise them: one real inbox = one account
const normEmail = (e) => {
  const m = String(e || '').trim().toLowerCase().match(/^([^@\s]+)@(gmail|googlemail)\.com$/);
  if (!m) return '';
  const local = m[1].split('+')[0].replace(/\./g, '');
  return local ? local + '@gmail.com' : '';
};
const hashOtp = (n, code) => crypto.createHash('sha256').update(n + ':' + code + ':' + (process.env.ADMIN_PASSWORD || '')).digest('hex');
const newSession = async (id) => {
  const token = crypto.randomBytes(24).toString('hex');
  await redis.set('sess:' + token, id, { ex: 60 * 60 * 24 * 30 });
  return token;
};
const whoAmI = async (req) => {
  const t = String(req.headers['x-token'] || '');
  if (!/^[a-f0-9]{48}$/.test(t)) return null;
  const id = await redis.get('sess:' + t);
  return id ? String(id) : null;
};

module.exports = async (req, res) => {
  const action = req.query.action;
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const fail = (code, error) => res.status(code).json({ error });
  try {
    // ---------- Gmail OTP ----------
    if (action === 'otp-send' && req.method === 'POST') {
      const n = normEmail(body.email);
      if (!n) return fail(400, 'Enter a valid Gmail address (…@gmail.com)');
      if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD)
        return fail(500, 'Email sending is not set up yet (admin: add GMAIL_USER and GMAIL_APP_PASSWORD in Vercel).');
      const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'x';
      if (await redis.get('otpcool:' + n)) return fail(429, 'Please wait a minute before asking for another code');
      const [c1, c2] = await Promise.all([redis.incr('otpn:' + n), redis.incr('otpip:' + ip)]);
      if (c1 === 1) await redis.expire('otpn:' + n, 3600);
      if (c2 === 1) await redis.expire('otpip:' + ip, 3600);
      if (c1 > 5 || c2 > 15) return fail(429, 'Too many attempts. Please try again in an hour.');
      const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      await redis.set('otp:' + n, { h: hashOtp(n, code), tries: 0 }, { ex: 600 });
      await redis.set('otpcool:' + n, 1, { ex: 60 });
      const mail = nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD } });
      await mail.sendMail({
        from: 'Dandiya Match <' + process.env.GMAIL_USER + '>',
        to: n,
        subject: code + ' is your Dandiya Match code',
        text: 'Your Dandiya Match verification code is ' + code + '. It expires in 10 minutes. If you did not ask for it, ignore this email.',
        html: '<div style="font-family:sans-serif"><h2>🪔 Dandiya Match</h2><p>Your verification code is</p><p style="font-size:32px;letter-spacing:6px;font-weight:700">' + code + '</p><p>It expires in 10 minutes. If you did not ask for it, ignore this email.</p></div>',
      });
      return res.json({ ok: true });
    }

    if (action === 'otp-verify' && req.method === 'POST') {
      const n = normEmail(body.email);
      const code = String(body.code || '').trim();
      const rec = n ? await redis.get('otp:' + n) : null;
      if (!rec) return fail(400, 'Code expired. Please ask for a new one.');
      if (rec.tries >= 5) { await redis.del('otp:' + n); return fail(429, 'Too many wrong tries. Please ask for a new code.'); }
      if (rec.h !== hashOtp(n, code)) {
        rec.tries += 1;
        await redis.set('otp:' + n, rec, { ex: 600 });
        return fail(400, 'Wrong code. Try again.');
      }
      await redis.del('otp:' + n);
      const uid = await redis.get('email:' + n);
      if (uid && (await redis.get('u:' + uid))) return res.json({ token: await newSession(String(uid)), existing: true });
      const ticket = crypto.randomBytes(24).toString('hex');
      await redis.set('ticket:' + ticket, n, { ex: 1800 });
      return res.json({ ticket });
    }

    // ---------- sign-up (needs a verified Gmail ticket) ----------
    if (action === 'join' && req.method === 'POST') {
      const n = await redis.get('ticket:' + String(body.ticket || ''));
      if (!n) return fail(400, 'Gmail verification expired. Please verify again.');
      const name = String(body.name || '').trim().slice(0, 40);
      const age = parseInt(body.age, 10);
      const phone = String(body.phone || '').replace(/[^\d+]/g, '').slice(0, 15);
      if (!name || !(age >= 14 && age <= 100) || !/^\+91[6-9]\d{9}$/.test(phone))
        return fail(400, 'Enter a valid name, age and Indian mobile number');
      const photo = '';
      const id = 'u' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      // one Gmail = one account
      const claimed = await redis.set('email:' + n, id, { nx: true });
      if (!claimed) {
        const old = await redis.get('email:' + n);
        if (old && (await redis.get('u:' + old))) return fail(409, 'This Gmail already has an account. Verify it again to log in.');
        await redis.set('email:' + n, id);
      }
      const ua = String(req.headers['user-agent'] || '');
      const device = /ipad|tablet/i.test(ua) ? 'Tablet' : /mobi|android|iphone/i.test(ua) ? 'Mobile' : 'Desktop';
      await redis.set('u:' + id, { id, email: n, name, age, phone, photo, device, seen: Date.now(), joined: Date.now() });
      await redis.sadd('users', id);
      await redis.del('ticket:' + body.ticket);
      return res.json({ token: await newSession(id) });
    }

    if (action === 'admin' && req.method === 'POST') {
      if (!adminOk(body.password)) return fail(401, 'Wrong password');
      if (body.remove) {
        const u = await redis.get('u:' + body.remove);
        await redis.srem('users', body.remove);
        await redis.del('u:' + body.remove, 'likes:' + body.remove, 'inbox:' + body.remove, 'match:' + body.remove);
        if (u && u.email) await redis.del('email:' + u.email);
      }
      const users = (await allUsers()).map((u) => ({ ...u, online: Date.now() - u.seen < ONLINE_MS }));
      users.sort((a, b) => b.seen - a.seen);
      return res.json({ total: users.length, online: users.filter((u) => u.online).length, users });
    }

    // ---------- everything below needs a logged-in session ----------
    const id = await whoAmI(req);
    if (!id) return fail(401, 'Session expired');

    if (action === 'logout' && req.method === 'POST') {
      await redis.del('sess:' + req.headers['x-token']);
      return res.json({ ok: true });
    }

    if (action === 'profile' && req.method === 'POST') {
      const me = await redis.get('u:' + id);
      if (!me) return fail(401, 'Session expired');
      const hobbies = clean(body.hobbies, 10, 30);
      const looking = LOOKING.includes(body.looking) ? body.looking : '';
      if (!hobbies.length || !looking) return fail(400, 'Pick at least one hobby and what you are looking for');
      if (!validPhoto(body.photo) && !me.photo) return fail(400, 'Please add your photo to continue');
      Object.assign(me, {
        hobbies, looking,
        likes: String(body.likes || '').trim().slice(0, 200),
        traits: clean(body.traits, 8, 30),
        note: String(body.note || '').trim().slice(0, 200),
      });
      if (validPhoto(body.photo)) me.photo = body.photo;
      await redis.set('u:' + id, me);
      return res.json({ ok: true });
    }

    if (action === 'matches') {
      const me = await redis.get('u:' + id);
      if (!me) return fail(401, 'Session expired');
      me.seen = Date.now();
      await redis.set('u:' + id, me);
      const mine = (me.hobbies || []).map((h) => h.toLowerCase());
      const common = (u) => (u.hobbies || []).filter((h) => mine.includes(h.toLowerCase()));
      const [sent, matchIds, inboxIds] = await Promise.all([
        redis.smembers('likes:' + id), redis.smembers('match:' + id), redis.smembers('inbox:' + id),
      ]);
      const users = (await allUsers()).filter((u) => u.id !== id && u.looking && u.email);
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
      const target = String(body.target || '');
      const t = await redis.get('u:' + target);
      if (!t || id === target) return fail(400, 'Person not found');
      if (await redis.sismember('match:' + id, target)) return res.json({ matched: true });
      if (await redis.sismember('inbox:' + id, target)) { await makeMatch(id, target); return res.json({ matched: true }); }
      await redis.sadd('likes:' + id, target);
      if (!(await redis.sismember('denied:' + target, id))) await redis.sadd('inbox:' + target, id);
      return res.json({ ok: true });
    }

    if (action === 'respond' && req.method === 'POST') {
      const from = String(body.from || '');
      if (!(await redis.sismember('inbox:' + id, from))) return fail(400, 'Request not found');
      await redis.srem('inbox:' + id, from);
      if (body.accept) await makeMatch(id, from);
      else await redis.sadd('denied:' + id, from);
      return res.json({ ok: true, matched: !!body.accept });
    }

    if (action === 'send' && req.method === 'POST') {
      const to = String(body.to || '');
      const text = String(body.text || '').trim().slice(0, 500);
      if (!text) return fail(400, 'Type a message');
      if (!(await redis.sismember('match:' + id, to))) return fail(403, 'Not matched');
      const key = ck(id, to);
      await redis.rpush(key, { f: id, t: text, ts: Date.now() });
      await redis.ltrim(key, -200, -1);
      return res.json({ ok: true });
    }

    if (action === 'chat') {
      const w = String(req.query.with || '');
      if (!(await redis.sismember('match:' + id, w))) return fail(403, 'Not matched');
      const msgs = (await redis.lrange(ck(id, w), 0, -1)).map(parse);
      await redis.set('rd:' + id + ':' + w, msgs.length);
      return res.json({ msgs });
    }

    if (action === 'unmatch' && req.method === 'POST') {
      const w = String(body.with || '');
      await Promise.all([
        redis.srem('match:' + id, w), redis.srem('match:' + w, id),
        redis.srem('likes:' + id, w), redis.srem('likes:' + w, id),
        redis.sadd('denied:' + id, w), redis.sadd('denied:' + w, id),
        redis.del(ck(id, w), 'rd:' + id + ':' + w, 'rd:' + w + ':' + id),
      ]);
      return res.json({ ok: true });
    }

    return fail(404, 'Not found');
  } catch (e) {
    return fail(500, 'Server error: ' + e.message);
  }
};
