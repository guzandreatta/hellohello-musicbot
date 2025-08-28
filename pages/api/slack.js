import { App, ExpressReceiver } from '@slack/bolt';
import fetch from 'node-fetch';

// ===== Config =====
const DEBUG = process.env.DEBUG === '1';
const ALLOWED_CHANNELS = (process.env.ALLOWED_CHANNELS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// Receiver con endpoint /api/slack (Next/Vercel)
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  endpoints: { events: '/api/slack' },
});

// ⚠️ Ack inmediato: SIN processBeforeResponse
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
});

// ===== Logs =====
const log = (...a) => { if (DEBUG) console.log('[BOT]', ...a); };
const logObj = (label, obj) => { if (DEBUG) console.log(`[BOT] ${label}:`, JSON.stringify(obj, null, 2)); };

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
  // Corrige &amp; y espacios no-break
  let s = u.replace(/&amp;/g, '&').replace(/\u00A0/g, ' ').trim();
  try {
    const parsed = new URL(s);
    return parsed.toString();
  } catch { return s; }
}
const pickFirstSupportedUrl = (text) => extractUrls(text).find(isSupportedMusicUrl);

// ===== filtros =====
function isIgnorableEvent(ev) {
  if (!ev) return true;
  if (ev.subtype === 'bot_message' || ev.bot_id) return true;
  if (ev.subtype === 'message_deleted') return true;
  return false;
}

// ===== fetch with timeout (6s) + retry =====
async function fetchWithTimeout(url, opts = {}, timeoutMs = 6000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}
async function fetchOdesli(url) {
  const normalized = normalizeCandidate(url);
  const apiUrl = `https://api.song.link/v1-alpha.1/links?userCountry=US&url=${encodeURIComponent(normalized)}`;
  const headers = { 'user-agent': 'hellohello-musicbot/1.0' };

  try {
    log('Fetching Odesli (1):', apiUrl);
    const r = await fetchWithTimeout(apiUrl, { headers }, 6000);
    log('Odesli status (1):', r.status);
    if (!r.ok) throw new Error(`odesli status ${r.status}`);
    return await r.json();
  } catch (e1) {
    log('Odesli try 1 failed:', String(e1));
    try {
      log('Fetching Odesli (2):', apiUrl);
      const r2 = await fetchWithTimeout(apiUrl, { headers }, 6000);
      log('Odesli status (2):', r2.status);
      if (!r2.ok) throw new Error(`odesli status ${r2.status}`);
      return await r2.json();
    } catch (e2) {
      log('Odesli try 2 failed:', String(e2));
      throw e2;
    }
  }
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

// ===== anti-duplicados (marcar solo si hay URL candidata) =====
const seenEvents = new Set();

// ===== único listener para todos los mensajes (incluye message_changed) =====
app.event('message', async ({ event, client, body }) => {
  try {
    // Ack inmediato → hacemos el trabajo en background
    setImmediate(async () => {
      try {
        if (isIgnorableEvent(event)) return;

        const channel = event.channel;
        const allowed = !ALLOWED_CHANNELS.length || ALLOWED_CHANNELS.includes(channel);
        if (!allowed) { log('Ignorado por canal:', channel); return; }

        // Texto: event.text o event.message.text cuando subtype=message_changed
        const text = typeof event.text === 'string'
          ? event.text
          : (event.message && typeof event.message.text === 'string' ? event.message.text : '');

        log('Procesando event(message)…');
        logObj('event(raw)', {
          channel, user: event.user, subtype: event.subtype, ts: event.ts, text
        });

        // Detectar URL primero (NO dedupe aún)
        const candidateRaw = pickFirstSupportedUrl(text || '');
        log('URL candidata RAW:', candidateRaw || '(ninguna)');
        if (!candidateRaw) return;

        // Ahora sí, dedupe por event_id (evitamos quemar eventos sin URL)
        const eventId = body?.event_id;
        if (eventId) {
          if (seenEvents.has(eventId)) { log('Evento duplicado ignorado:', eventId); return; }
          seenEvents.add(eventId);
          if (seenEvents.size > 2000) seenEvents.clear();
        }

        const candidate = normalizeCandidate(candidateRaw);
        log('URL candidata NORMALIZADA:', candidate);

        // Cache
        let data = getCached(candidate);
        if (!data) {
          try {
            data = await fetchOdesli(candidate);
            setCached(candidate, data);
          } catch (err) {
            console.error('[BOT] Odesli timeout/failure:', err);
            const tts = event.thread_ts || event.ts;
            await client.chat.postMessage({
              channel,
              thread_ts: tts,
              text: '😕 No pude obtener equivalencias ahora (timeout). Probá de nuevo en unos segundos.',
            });
            return;
          }
        } else {
          log('Cache hit para URL');
        }

        const platforms = Object.keys(data?.linksByPlatform || {});
        logObj('Odesli platforms', platforms);

        const spotify = data?.linksByPlatform?.spotify?.url;
        const apple = data?.linksByPlatform?.appleMusic?.url;
        const youtube = data?.linksByPlatform?.youtubeMusic?.url;

        let reply = '🎶 Links equivalentes:\n';
        if (spotify) reply += `- Spotify: ${spotify}\n`;
        if (apple) reply += `- Apple Music: ${apple}\n`;
        if (youtube) reply += `- YouTube Music: ${youtube}\n`;
        if (reply === '🎶 Links equivalentes:\n') reply = 'No pude encontrar equivalencias 😕';

        const threadTs = event.thread_ts || event.ts;
        log('Posteando en thread:', { channel, thread_ts: threadTs });

        await client.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text: reply,
          // unfurl_links: false,
          // unfurl_media: false,
        });
      } catch (err) {
        console.error('[BOT WORKER ERROR]', err);
      }
    });
  } catch (err) {
    console.error('[BOLT ERROR]', err);
  }
});

// ===== Next.js API export =====
export const config = { api: { bodyParser: false } };
export default receiver.app;
