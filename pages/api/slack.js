// pages/api/slack.js
import { App, ExpressReceiver } from '@slack/bolt';
import fetch from 'node-fetch';

// ===== Marca de versión =====
const VERSION = 'v3.5-odesli-timeout-env-cap';
console.log('[BOT] Boot', VERSION, '| ALLOWED_CHANNELS=', process.env.ALLOWED_CHANNELS || '(all)');

// ===== Config =====
const DEBUG = process.env.DEBUG === '1';
const ALLOWED_CHANNELS = (process.env.ALLOWED_CHANNELS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// Tiempo de Odesli configurable, con CAP en Vercel para respetar 3s de Slack
const ODESLI_TIMEOUT_MS = Number(process.env.ODESLI_TIMEOUT_MS || '5000');
// Si estamos en Vercel (process.env.VERCEL existe), capamos a 2400 ms
const IS_VERCEL = !!process.env.VERCEL;
const EFFECTIVE_ODESLI_MS = IS_VERCEL ? Math.min(ODESLI_TIMEOUT_MS, 2400) : ODESLI_TIMEOUT_MS;
console.log('[BOT] ODESLI_TIMEOUT_MS=', ODESLI_TIMEOUT_MS, '| EFFECTIVE=', EFFECTIVE_ODESLI_MS, '| IS_VERCEL=', IS_VERCEL);

// Receiver con endpoint /api/slack (Next/Vercel)
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  endpoints: { events: '/api/slack' },
});

// Bolt espera al listener (sin trabajo “background”). Mantener <~2.5s.
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
  processBeforeResponse: true,
});

// ===== Utils de Log =====
const log = (...a) => { if (DEBUG) console.log('[BOT]', ...a); };
const logObj = (label, obj) => { if (DEBUG) console.log(`[BOT] ${label}:`, JSON.stringify(obj, null, 2)); };

// ===== Helpers de URL / texto =====
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
const pickFirstSupportedUrlFromText = (text) =>
  extractUrls(text).find(isSupportedMusicUrl);

// En unfurls, el link puede venir en attachments
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

function refineQuery(s) {
  if (!s) return s;
  s = s.replace(/\s*[\(\[][^\)\]]*[\)\]]/g, '');   // (Remix), [Live], etc.
  s = s.replace(/\s+(feat\.?|ft\.?)\s+.+$/i, '');  // feat. ...
  return s.replace(/\s{2,}/g, ' ').trim();
}

// ===== Filtros =====
function isIgnorableEvent(ev) {
  if (!ev) return true;
  if (ev.subtype === 'bot_message' || ev.bot_id) return true;
  if (ev.subtype === 'message_deleted') return true;
  return false;
}

// ===== Fetch con timeout =====
async function fetchWithTimeout(url, opts = {}, timeoutMs = EFFECTIVE_ODESLI_MS) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

// Carrera con timeout duro
async function raceWithTimeout(promise, ms, label = 'race') {
  let timeoutId;
  const stopper = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label}_TIMEOUT_${ms}ms`)), ms);
  });
  try {
    const res = await Promise.race([promise, stopper]);
    return res;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ===== Odesli =====
async function fetchOdesli(url) {
  const normalized = normalizeCandidate(url);
  const apiUrl = `https://api.song.link/v1-alpha.1/links?userCountry=US&url=${encodeURIComponent(normalized)}`;
  const headers = { 'user-agent': 'hellohello-musicbot/1.0' };

  log('Fetching Odesli:', apiUrl);
  const r = await fetchWithTimeout(apiUrl, { headers }, EFFECTIVE_ODESLI_MS);
  log('Odesli status:', r.status);
  if (!r.ok) throw new Error(`odesli status ${r.status}`);
  return await r.json();
}

// ===== Spotify oEmbed (fallback rápido) =====
async function fetchSpotifyOEmbed(spotifyUrl) {
  const url = `https://open.spotify.com/oembed?url=${encodeURIComponent(spotifyUrl)}`;
  const r = await fetchWithTimeout(url, {}, Math.min(1500, EFFECTIVE_ODESLI_MS));
  if (!r.ok) throw new Error(`spotify oembed ${r.status}`);
  return await r.json(); // { title: "Song — Artist", author_name: "Artist", ... }
}

// ===== Cache (10 min) =====
const cache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;
function getCached(url) {
  const e = cache.get(url);
  if (!e) return null;
  if (Date.now() - e.at > CACHE_TTL_MS) { cache.delete(url); return null; }
  return e.data;
}
function setCached(url, data) { cache.set(url, { data, at: Date.now() }); }

// ===== Anti-duplicados (solo si hay URL) =====
const seenEvents = new Set();

// ===== Único listener =====
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

    // 3) Intento Odesli con corte duro (EFFECTIVE_ODESLI_MS) OR cache
    let reply = '';
    let data = getCached(candidate);

    try {
      if (!data) {
        console.log(`[BOT] Odesli RACE start (${EFFECTIVE_ODESLI_MS}ms)`);
        data = await raceWithTimeout(fetchOdesli(candidate), EFFECTIVE_ODESLI_MS, 'ODESLI');
        console.log('[BOT] Odesli RACE resolved');
        setCached(candidate, data);
      } else {
        log('Cache hit para URL');
      }

      const spotify = data?.linksByPlatform?.spotify?.url;
      const apple = data?.linksByPlatform?.appleMusic?.url;
      const youtube = data?.linksByPlatform?.youtubeMusic?.url;

      reply = '🎶 Links equivalentes:\n';
      if (spotify) reply += `- Spotify: ${spotify}\n`;
      if (apple) reply += `- Apple Music: ${apple}\n`;
      if (youtube) reply += `- YouTube Music: ${youtube}\n`;
      if (reply === '🎶 Links equivalentes:\n') reply = ''; // fuerza fallback
    } catch (err) {
      console.log('[BOT] Odesli tardó/falló → fallback:', String(err));
    }

    // 4) Fallback si no hay reply (búsquedas cruzadas)
    if (!reply) {
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

      searchText = refineQuery(searchText);
      const q = encodeURIComponent(searchText);
      const appleSearch = `https://music.apple.com/us/search?term=${q}`;
      const ytMusicSearch = `https://music.youtube.com/search?q=${q}`;
      const spotifySearch = `https://open.spotify.com/search/${q}`;

      reply = '🎶 No pude confirmar equivalencias exactas ahora, probá con estas búsquedas:\n';
      if (!host.includes('spotify')) reply += `- Spotify (búsqueda): ${spotifySearch}\n`;
      if (!host.includes('apple')) reply += `- Apple Music (búsqueda): ${appleSearch}\n`;
      if (!host.includes('youtube')) reply += `- YouTube Music (búsqueda): ${ytMusicSearch}\n`;
      reply += ' _(modo rápido por latencia de Odesli)_';
    }

    // 5) Postear en el thread correcto
    const threadTs = event.message?.ts || event.thread_ts || event.ts;
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
