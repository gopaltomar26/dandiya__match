const { redis, pid, okId, bad, parse } = require('../lib/db');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return bad(res, 405, 'POST only');
  const { id, to } = req.body || {};
  if (!okId(id) || typeof to !== 'string' || !/^[a-f0-9]{12}$/.test(to)) return bad(res, 400, 'Bad request');
  const p = pid(id);
  if (!Number(await redis.hexists('users', p))) return bad(res, 403, 'Join first');
  if (to === p || !Number(await redis.hexists('users', to))) return bad(res, 400, 'Unknown person');
  const list = new Set(parse(await redis.hget('likes', p), []));
  const was = list.has(to);
  was ? list.delete(to) : list.add(to);
  await redis.hset('likes', { [p]: JSON.stringify([...list]) });
  res.json({ ok: true, liked: !was });
};
