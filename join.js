const { redis, pid, okId, bad, parse } = require('../lib/db');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return bad(res, 405, 'POST only');
  const b = req.body || {};
  const name = String(b.name || '').trim();
  const age = parseInt(b.age, 10);
  const gender = String(b.gender || '');
  const phone = String(b.phone || '').replace(/[\s-]/g, '');
  if (!okId(b.id)) return bad(res, 400, 'Bad id');
  if (name.length < 2 || name.length > 40) return bad(res, 400, 'Enter your name');
  if (!(age >= 18 && age <= 80)) return bad(res, 400, 'Age must be 18 or above');
  if (!['Female', 'Male', 'Other'].includes(gender)) return bad(res, 400, 'Select an option');
  if (!/^\+?\d{10,14}$/.test(phone)) return bad(res, 400, 'Enter a valid phone number');

  const p = pid(b.id);
  const old = parse(await redis.hget('users', p), null);
  let photo = typeof b.photo === 'string' ? b.photo : '';
  const pre = 'data:image/jpeg;base64,';
  if (photo && !(photo.startsWith(pre) && photo.length < 60000 && /^[A-Za-z0-9+/=]+$/.test(photo.slice(pre.length)))) {
    return bad(res, 400, 'Bad photo');
  }
  if (!photo) photo = (old && old.photo) || '';
  if (!photo) return bad(res, 400, 'Please upload a photo');

  const rec = { name, age, gender, phone, photo, joined: (old && old.joined) || Date.now() };
  await redis.hset('users', { [p]: JSON.stringify(rec) });
  await redis.hset('seen', { [p]: JSON.stringify({ t: Date.now(), d: '' }) });
  res.json({ ok: true });
};
