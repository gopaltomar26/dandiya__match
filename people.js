const { redis, pid, okId, bad, parse } = require('../lib/db');

module.exports = async (req, res) => {
  const { id, dev } = req.query;
  if (!okId(id)) return bad(res, 400, 'Bad id');
  const p = pid(id);
  const mine = parse(await redis.hget('users', p), null);
  if (!mine) return res.json({ joined: false });

  // heartbeat: lets the admin panel see who is online
  await redis.hset('seen', { [p]: JSON.stringify({ t: Date.now(), d: String(dev || '').slice(0, 40) }) });

  const [all, lk] = await Promise.all([redis.hgetall('users'), redis.hgetall('likes')]);
  const likesOf = (k) => parse((lk || {})[k], []);
  const people = Object.entries(all || {})
    .filter(([k]) => k !== p)
    .map(([k, v]) => {
      const r = parse(v, null);
      return r && { pid: k, name: r.name, age: r.age, gender: r.gender, photo: r.photo }; // phone is never sent
    })
    .filter(Boolean);
  const liked = likesOf(p);
  const mutual = liked.filter((x) => likesOf(x).includes(p));
  res.json({ joined: true, me: { name: mine.name, age: mine.age, gender: mine.gender }, people, liked, mutual });
};
