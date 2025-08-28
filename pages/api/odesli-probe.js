import fetch from 'node-fetch';

export default async function handler(req, res) {
  const u = req.query.u || 'https://open.spotify.com/track/4JjqJhEW00zcGiMIsunf0X';
  const api = `https://api.song.link/v1-alpha.1/links?url=${encodeURIComponent(u)}`;
  try {
    const r = await fetch(api, { headers: { 'User-Agent': 'hellohello-musicbot/1.0' } });
    const text = await r.text();
    res.status(r.status).json({ ok: r.ok, status: r.status, sample: text.slice(0, 400) });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}
