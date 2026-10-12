const crypto = require('crypto');
const { Redis } = require('@upstash/redis');
const env = (suffix) => process.env[Object.keys(process.env).find((k) => k.endsWith(suffix))];
const redis = new Redis({
  url: env('KV_REST_API_URL') || env('UPSTASH_REDIS_REST_URL'),
  token: env('KV_REST_API_TOKEN') || env('UPSTASH_REDIS_REST_TOKEN'),
});
const ONLINE_MS = 45000;
const LOOKING = ['Dandiya partner for the night', 'New friends', 'Something serious'];
const GENDERS = ['Man', 'Woman'];
const LEVELS = ['Beginner', 'Comfortable', 'Dandiya pro'];
const DIETS = ['Vegetarian', 'Non-vegetarian', 'Eggetarian', 'Jain', 'Vegan'];
const OPEN = ['Dating', 'One-night stay', 'Coffee or dinner meetup', 'Practice dandiya together'];
const pub = (u) => ({ id: u.id, name: u.name, age: u.age, photo: u.photo, hobbies: u.hobbies || [], likes: u.likes || '', looking: u.looking || '', traits: u.traits || [], note: u.note || '', height: u.height || null, about: u.about || '', level: u.level || '', diet: u.diet || '' });
const isDone = (u) => !!(u.looking && u.gender && u.about && u.height && Number.isFinite(u.lat) && (u.hobbies || []).length >= 3);
const dist = (a, b) => {
  if (!Number.isFinite(a.lat) || !Number.isFinite(b.lat)) return null;
  const rad = (x) => (x * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
};
const adminOk = (p) => process.env.ADMIN_PASSWORD && p === process.env.ADMIN_PASSWORD;
const clean = (a, n, len) => (Array.isArray(a) ? a : []).map((x) => String(x).trim().slice(0, len)).filter(Boolean).slice(0, n);
const validPhoto = (p) => typeof p === 'string' && p.startsWith('data:image/') && p.length < 150000;
// turns a typed place such as "Indirapuram, Ghaziabad" into rounded coordinates (OpenStreetMap), cached for 30 days
const geocode = async (q) => {
  const key = 'geo:' + q.toLowerCase().replace(/\s+/g, ' ');
  const hit = await redis.get(key);
  if (hit) return hit;
  const r = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=in&q=' + encodeURIComponent(q), {
    headers: { 'User-Agent': 'DandiyaMatch/1.0', 'Accept-Language': 'en' },
  });
  if (!r.ok) throw new Error('The location service is busy. Please try again in a minute.');
  const j = await r.json();
  if (!Array.isArray(j) || !j.length) return null;
  const out = {
    lat: Math.round(Number(j[0].lat) * 1000) / 1000,
    lng: Math.round(Number(j[0].lon) * 1000) / 1000,
    label: String(j[0].display_name || q).split(',').slice(0, 3).map((x) => x.trim()).join(', '),
  };
  await redis.set(key, out, { ex: 60 * 60 * 24 * 30 });
  return out;
};
const geocodeFor = async (id, q) => {
  const n = await redis.incr('geoc:' + id);
  if (n === 1) await redis.expire('geoc:' + id, 3600);
  if (n > 30) throw new Error('Too many location checks. Please try again in an hour.');
  return geocode(q);
};
const NOT_FOUND = 'We could not find that place. Try "Area, City", for example Indirapuram, Ghaziabad.';
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
      let nodemailer;
      try { nodemailer = require('nodemailer'); } catch (e) { return fail(500, 'Email package missing: add nodemailer to package.json on GitHub, then redeploy.'); }
      const mail = nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD } });
      try { await mail.sendMail({
        from: 'Dandiya Match <' + process.env.GMAIL_USER + '>',
        to: n,
        subject: code + ' is your Dandiya Match code',
        text: 'Your Dandiya Match verification code is ' + code + '. It expires in 10 minutes. If you did not ask for it, ignore this email.',
        html: '<div style="font-family:sans-serif"><h2>🪔 Dandiya Match</h2><p>Your verification code is</p><p style="font-size:32px;letter-spacing:6px;font-weight:700">' + code + '</p><p>It expires in 10 minutes. If you did not ask for it, ignore this email.</p></div>',
      }); } catch (e) { await redis.del('otpcool:' + n); return fail(500, 'Could not send the email: ' + e.message); }
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
      if (!name || !(age >= 18 && age <= 100) || !/^\+91[6-9]\d{9}$/.test(phone))
        return fail(400, 'Enter a valid name, an age of 18 or more, and an Indian mobile number');
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

    if (action === 'geo' && req.method === 'POST') {
      const q = String(body.q || '').trim().slice(0, 80);
      if (q.length < 3) return fail(400, 'Type your area and city, e.g. Indirapuram, Ghaziabad');
      let g;
      try { g = await geocodeFor(id, q); } catch (e) { return fail(503, e.message); }
      if (!g) return fail(404, NOT_FOUND);
      return res.json({ label: g.label });
    }

    if (action === 'profile' && req.method === 'POST') {
      const me = await redis.get('u:' + id);
      if (!me) return fail(401, 'Session expired');
      const hobbies = clean(body.hobbies, 15, 30);
      const traits = clean(body.traits, 12, 30);
      const looking = LOOKING.includes(body.looking) ? body.looking : '';
      const about = String(body.about || '').split('\n').map((x) => x.trim()).filter(Boolean).join('\n').slice(0, 500);
      const height = parseInt(body.height, 10);
      const gender = me.gender || (GENDERS.includes(body.gender) ? body.gender : '');
      const place = String(body.place || '').trim().slice(0, 80);
      if (!gender) return fail(400, 'Please choose Man or Woman');
      if (!(height >= 120 && height <= 230)) return fail(400, 'Enter your height in cm (120 to 230)');
      if (place.length < 3) return fail(400, 'Type your area and city, e.g. Indirapuram, Ghaziabad');
      let lat = me.lat, lng = me.lng;
      if (place !== me.place || !Number.isFinite(lat)) {
        let g;
        try { g = await geocodeFor(id, place); } catch (e) { return fail(503, e.message); }
        if (!g) return fail(400, NOT_FOUND);
        lat = g.lat; lng = g.lng;
      }
      if (about.split('\n').filter((x) => x.length >= 8).length < 2) return fail(400, 'Write at least 2 lines about yourself');
      if (hobbies.length < 3) return fail(400, 'Pick at least 3 hobbies');
      if (!looking) return fail(400, 'Choose what you are looking for');
      if (traits.length < 2) return fail(400, 'Pick at least 2 things you want in a partner');
      if (!validPhoto(body.photo) && !me.photo) return fail(400, 'Please add your photo to continue');
      Object.assign(me, {
        gender, height, place, lat, lng, about, hobbies, traits, looking,
        level: LEVELS.includes(body.level) ? body.level : '',
        diet: DIETS.includes(body.diet) ? body.diet : '',
        open: (Array.isArray(body.open) ? body.open : []).filter((x) => OPEN.includes(x)),
        likes: String(body.likes || '').trim().slice(0, 200),
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
      const r = [7, 15, 30, 50].includes(Number(req.query.r)) ? Number(req.query.r) : 7;
      const mine = (me.hobbies || []).map((h) => h.toLowerCase());
      const common = (u) => (u.hobbies || []).filter((h) => mine.includes(h.toLowerCase()));
      // an activity such as "One-night stay" is only revealed when BOTH people chose it
      const mutual = (u) => (u.open || []).filter((x) => (me.open || []).includes(x));
      const km = (u) => { const d = dist(me, u); return d == null ? null : Math.ceil(d); };
      const [sent, matchIds, inboxIds] = await Promise.all([
        redis.smembers('likes:' + id), redis.smembers('match:' + id), redis.smembers('inbox:' + id),
      ]);
      const base = (await allUsers()).filter((u) => u.id !== id && isDone(u) && u.age >= 18);
      const byId = Object.fromEntries(base.map((u) => [u.id, u]));
      const online = (u) => Date.now() - u.seen < ONLINE_MS;
      // only the opposite gender, within the chosen distance
      const people = isDone(me) && me.age >= 18
        ? base
            .filter((u) => u.gender !== me.gender && !matchIds.includes(u.id) && !inboxIds.includes(u.id) && dist(me, u) !== null && dist(me, u) <= r)
            .map((u) => ({ ...pub(u), online: online(u), liked: sent.includes(u.id), common: common(u), mutual: mutual(u), km: km(u) }))
        : [];
      people.sort((a, b) => b.mutual.length - a.mutual.length || b.common.length - a.common.length || b.online - a.online || a.km - b.km);
      const requests = inboxIds.map((x) => byId[x]).filter(Boolean).map((u) => ({ ...pub(u), common: common(u), mutual: mutual(u), km: km(u) }));
      const matches = [];
      for (const x of matchIds) {
        const u = byId[x];
        if (!u) continue;
        const [len, rd] = await Promise.all([redis.llen(ck(id, x)), redis.get('rd:' + id + ':' + x)]);
        matches.push({ ...pub(u), online: online(u), km: km(u), mutual: mutual(u), unread: Math.max(0, len - (Number(rd) || 0)) });
      }
      return res.json({ me: { ...pub(me), gender: me.gender || '', open: me.open || [], place: me.place || '', hasLoc: Number.isFinite(me.lat), done: isDone(me) }, people, requests, matches });
    }

    // A asks B to dandiya -> B gets a request to approve or deny
    if (action === 'like' && req.method === 'POST') {
      const target = String(body.target || '');
      const [meU, t] = await Promise.all([redis.get('u:' + id), redis.get('u:' + target)]);
      if (!t || !meU || id === target || !meU.gender || !t.gender || meU.gender === t.gender) return fail(400, 'Person not found');
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
