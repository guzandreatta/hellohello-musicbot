import { App, ExpressReceiver } from '@slack/bolt';
import fetch from 'node-fetch';

// ===== Config =====
const DEBUG = process.env.DEBUG === '1';
const FAST_MODE = process.env.FAST_MODE === '1';
const ALLOWED_CHANNELS = (process.env.ALLOWED_CHANNELS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// Receiver con endpoint /api/slack (Next/Vercel)
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  endpoints: { events: '/api/slack' },
});

// ⚠️ Bolt espera al listener. Mantener <~2.5s.
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
  processBeforeResponse: true,
});

// ===== Logs =====
const log = (...a) => { if (DEBUG) console.log('[BOT]', ...a); };
const logObj = (label, obj) => { if (DEBUG) console.log(`[BOT] ${label}:`, JSON.stringify(obj, null, 2)); };
log('Boot | FAST_MODE=', FAST_MODE ? 'ON' : 'OFF', '| ALLOWED_CHANNELS=', ALLOWED_CHANNELS.join(',') || '(all)');

// ===== URL utils =====
function cleanSlackUrl(raw) {
  if (!raw) return '';
  let u = raw.trim();
  if (u.startsWith('<') && u.endsWith('>')) u = u.slice(1, -1);
  const i = u.indexOf('|'); if (i !== -1) u = u.slice(0, i);
  return u.trim();
}
function extractUrls(text) {
  if (!text) return [];
  const urlRegex = /(https?:\/\/[^\s<>]+)/gi;
  const found = text.match(urlRegex) || [];
  return found.map(cleanSlackUrl);
}
function isSupportedMusicUrl(u) {
  try {
    const h = new URL(u).hostname.toLowerCase();
    if (h.endsWith('open.spotify.com') || h === 'spotify.link') return true;
    if (h.endsWith('music.apple.com') || h.endsWith('itunes.apple.com') || h.endsWith('geo.music.apple.com')) return true;
    if (h.endsWith('music.youtube.com') || h.endsWith('youtube.com') || h === 'youtu.be') return true;
    return false;
  } catch { return false; }
}
function normalizeCandidate(u) {
  let s = (u || '').replace(/&amp;/g, '&').replace(/\u00A0/g, ' ').trim();
  try { return new URL(s).toString(); } catch { return s; }
}
const pickFirstSupportedUrlFromText = (text) => extractUrls(text).find(isSupportedMusicUrl);

// Para unfurls: a veces el link viene en attachments
function pickUrlFromEvent(ev) {
  const text =
    typeof ev.text === 'string' ? ev.text :
    (ev.message && typeof ev.message.text === 'string' ? ev.message.text : '');

  let url = pickFirstSupportedUrlFromText(text || '');
  if (url) return url;

  const atts = ev?.message?.attachments || ev?.attachments || [];
  for (const a of atts) {
    if (a?.from_url && isSupportedMusicUrl(a.from_url)) return a.from_url;
    if (a?.title_link && isSupportedMusicUrl(a.title_link)) return a.title_link;
    if (a?.original_url && isSupportedMusicUrl(a.original_url)) return a.original_url;
  }
  return null;
}

// ===== filtros =====
function isIgnorableEvent(ev) {
  if (!ev) return true;
  if (ev.subtype === 'bot_message' || ev.bot_id) return true;
  if (ev.subtype === 'message_deleted') return true;
  return false;
}

// ===== fetch con timeout corto =====
async function fetchWithTimeout(url, opts = {}, timeoutMs = 2200) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

// ===== Odesli (cuando NO está FAST_MODE) =====
async function fetchOdesli(url) {
  const normalized = normalizeCandidate(url);
  const apiUrl = `https://api.song.link/v1-alpha.1/links?userCountry=US&url=${encodeURIComponent(normalized)}`;
  const headers = { 'user-agent': 'hellohello-musicbot/1.0' };

  log('Fetching Odesli:', apiUrl);
  const r = await fetchWithTimeout(apiUrl, { headers }, 2200);
  log('Odesli status:', r.status);
  if (!r.ok) throw new Error(`odesli status ${r.status}`);
  return await r.json();
}

// ===== Spotify oEmbed (fallback/FAST_MODE) =====
async function fetchSpotifyOEmbed(spotifyUrl) {
  const url = `https://open.spotify.com/oembed?url=${encodeURIComponent(spotifyUrl)}`;
  const r = await fetchWithTimeout(url, {}, 900);
  if (!r.ok) throw new Error(`spotify oembed ${r.status}`);
  return await r.json(); // { title: "Song — Artist", author_name: "Artist", ... }
}

// ===== cache (10 min) =====
const cache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;
function getCached(url) {
  const e = cache.get(url);
  if (!e) return null;
  if (Date.now() - e.at > CACHE_TTL_MS) { cache.delete(url); return null; }
  return e.data;
}
function setCached(url, data) { cache.set(url, { data, at: Date.now() }); }

// ===== anti-duplicados (solo si hay URL) =====
const seenEvents = new Set();

// ===== ÚNICO listener =====
app.event('message', async ({ event, client, body }) => {
  try {
    if (isIgnorableEvent(event)) return;

    const channel = event.channel;
    const allowed = !ALLOWED_CHANNELS.length || ALLOWED_CHANNELS.includes(channel);
    if (!allowed) { log('Ignorado por canal:', channel); return; }

    log('Procesando event(message)…');
    logObj('event(raw)', { channel, user: event.user, subtype: event.subtype, ts: event.ts });

    // 1) URL candidata
    const candidateRaw = pickUrlFromEvent(event);
    log('URL candidata RAW:', candidateRaw || '(ninguna)');
    if (!candidateRaw) return;

    // 2) Dedup recién ahora
    const eventId = body?.event_id;
    if (eventId) {
      if (seenEvents.has(eventId)) { log('Evento duplicado ignorado:', eventId); return; }
      seenEvents.add(eventId);
      if (seenEvents.size > 2000) seenEvents.clear();
    }

    const candidate = normalizeCandidate(candidateRaw);
    log('URL candidata NORMALIZADA:', candidate);

    const threadTs = event.message?.ts || event.thread_ts || event.ts;

    // 3) Resolver equivalencias
    let reply = '';
    let data = null;

    if (!FAST_MODE) {
      try {
        data = getCached(candidate);
        if (!data) {
          data = await fetchOdesli(candidate);
          setCached(candidate, data);
        } else {
          log('Cache hit para URL');
        }
      } catch (err) {
        log('[BOT] Odesli falló/tardó, usaré fallback:', String(err));
      }
    } else {
      log('FAST_MODE=ON → salto Odesli y voy a fallback');
    }

    if (data?.linksByPlatform) {
      const spotify = data?.linksByPlatform?.spotify?.url;
      const apple = data?.linksByPlatform?.appleMusic?.url;
      const youtube = data?.linksByPlatform?.youtubeMusic?.url;

      reply = '🎶 Links equivalentes:\n';
      if (spotify) reply += `- Spotify: ${spotify}\n`;
      if (apple) reply += `- Apple Music: ${apple}\n`;
      if (youtube) reply += `- YouTube Music: ${youtube}\n`;
      if (reply === '🎶 Links equivalentes:\n') reply = ''; // si no hay nada, forzar fallback
    }

    if (!reply) {
      // ===== Fallback rápido (siempre disponible) =====
      const u = new URL(candidate);
      const host = u.hostname.toLowerCase();
      let searchText = candidate;

      try {
        if (host.includes('spotify')) {
          const meta = await fetchSpotifyOEmbed(candidate);
          const title = meta?.title || '';
          const author = meta?.author_name || '';
          const merged = [title, author].filter(Boolean).join(' ');
          if (merged) searchText = merged;
          log('oEmbed title/author:', { title, author, merged });
        }
      } catch (e) {
        log('Fallback meta fetch failed:', String(e));
      }

      const q = encodeURIComponent(searchText);
      const appleSearch = `https://music.apple.com/us/search?term=${q}`;
      const ytMusicSearch = `https://music.youtube.com/search?q=${q}`;
      const spotifySearch = `https://open.spotify.com/search/${q}`;

      reply = '🎶 No pude confirmar equivalencias exactas ahora, probá con estas búsquedas:\n';
      if (!host.includes('spotify')) reply += `- Spotify (búsqueda): ${spotifySearch}\n`;
      if (!host.includes('apple')) reply += `- Apple Music (búsqueda): ${appleSearch}\n`;
      if (!host.includes('youtube')) reply += `- YouTube Music (búsqueda): ${ytMusicSearch}\n`;
      if (!FAST_MODE) reply += ' _(modo rápido por latencia de Odesli)_';
    }

    // 4) Postear en thread
    log('Posteando en thread (pre):', { channel, thread_ts: threadTs });

    try {
      const resp = await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: reply,
      });
      log('Posteado OK:', { ts: resp.ts });
    } catch (e) {
      const errData = e?.data || e;
      console.error('[BOT] chat.postMessage error:', errData);

      const reason = errData?.error;
      if (reason === 'not_in_channel' || reason === 'restricted_action') {
        try {
          await client.chat.postEphemeral({
            channel,
            user: event.user,
            text: 'No tengo permiso para publicar en este canal. Invitame con `/invite @TuBot` o habilitá permisos.',
          });
          log('Aviso ephemeral enviado.');
        } catch (eph) {
          console.error('[BOT] chat.postEphemeral error:', eph?.data || eph);
        }
      }
    }
  } catch (err) {
    console.error('[BOT WORKER ERROR]', err);
  }
});

// ===== Next.js API export =====
export const config = { api: { bodyParser: false } };
export default receiver.app;
