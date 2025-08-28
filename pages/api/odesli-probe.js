import fetch from 'node-fetch';

export default async function handler(req, res) {
  try {
    const testUrl = req.query.u || 'https://open.spotify.com/track/2wTglGVOzB6UatOM1bORa4';
    const api = `https://api.song.link/v1-alpha.1/links?userCountry=US&url=${encodeURIComponent(testUrl)}`;
    const r = await fetch(api, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'hellohello-musicbot/1.0'
      }
    });
    const text = await r.text();
    return res.status(200).json({
      ok: r.ok,
      status: r.status,
      contentType: r.headers.get('content-type'),
      bytes: text.length,
      sample: text.slice(0, 400) // para no inundar logs
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
}
