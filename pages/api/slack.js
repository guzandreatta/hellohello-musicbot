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
  // Corrige entidades HTML y espacios extraños antes de encodear
  let s = u.replace(/&amp;/g, '&').replace(/\u00A0/g, ' ').trim();
  try {
    // round-trip para “limpiar” y normalizar
    const parsed = new URL(s);
    // (opcional) quitar tracking típico:
    // parsed.searchParams.delete('utm_source');
    // parsed.searchParams.delete('utm_medium');
    return parsed.toString();
  } catch {
    return s; // si no parsea, devuelve tal cual
  }
}
const pickFirstSupportedUrl = (text) => (extractUrls(text).find(isSupportedMusicUrl));

// Permitimos message_changed (unfurl)
function isIgnorableMessageLike(m) {
  if (!m) return true;
  if (m.subtype === 'bot_message' || m.bot_id) return true;
  if (m.subtype === 'message_deleted') return true;
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

  // try 1
  try {
    log('Fetching Odesli (1):', apiUrl);
    const r = await fetchWithTimeout(apiUrl, { headers }, 6000);
    log('Odesli status (1):', r.status);
    if (!r.ok) throw new Error(`odesli status ${r.status}`);
    return await r.json();
  } catch (e1) {
    log('Odesli try 1 failed:', String(e1));
    // try 2
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

// ===== cache en memoria (10 min) =====
const cache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;
function getCached(url) {
  const e = cache.get(url);
  if (!e) return null;
  if (Date.now() - e.at > CACHE_TTL_MS) { cache.delete(url); return null; }
  return e.data;
}
function setCached(url, data) { cache.set(url, { data, at: Date.now() }); }

// ===== anti-duplicados =====
const seenEvents = new Set();

// ===== diagnóstico de eventos =====
app.event('message', async ({ event }) => {
  logObj('event(message)', {
    channel: event.channel, user: event.user, subtype: event.subtype, text: event.text, ts: event.ts
  });
});

// ===== procesador común =====
async function handleMessageLike({ channel, user, text, ts, thread_ts, subtype }, client, body) {
  if (isIgnorableMessageLike({ subtype })) return;

  const allowed = !ALLOWED_CHANNELS.length || ALLOWED_CHANNELS.includes(channel);
  if (!allowed) { log('Ignorado por canal:', channel); return; }

  const eventId = body?.event_id;
  if (eventId) {
    if (seenEvents.has(eventId)) { log('Evento duplicado ignorado:', eventId); return; }
    seenEvents.add(eventId);
    if (seenEvents.size > 2000) seenEvents.clear();
  }

  const candidateRaw = pickFirstSupportedUrl(text || '');
  log('URL candidata RAW:', candidateRaw || '(ninguna)');
  if (!candidateRaw) return;

  const candidate = normalizeCandidate(candidateRaw);
  log('URL candidata NORMALIZADA:', candidate);

  let data = getCached(candidate);
  if (!data) {
    try {
      data = await fetchOdesli(candidate);
      setCached(candidate, data);
    } catch (err) {
      console.error('[BOT] Odesli timeout/failure:', err);
      const tts = thread_ts || ts || body?.event?.ts;
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

  const tts = thread_ts || ts || body?.event?.ts;
  log('Posteando en thread:', { channel, thread_ts: tts });

  await client.chat.postMessage({
    channel,
    thread_ts: tts,
    text: reply,
    // unfurl_links: false,
    // unfurl_media: false,
  });
}

// ===== listeners =====
app.message(async ({ message, client, body }) => {
  try {
    // Ack inmediato → programamos trabajo en background
    setImmediate(async () => {
      try {
        log('Procesando message…');
        logObj('message', {
          channel: message.channel, user: message.user, text: message.text,
          ts: message.ts, thread_ts: message.thread_ts, subtype: message.subtype
        });
        await handleMessageLike({
          channel: message.channel,
          user: message.user,
          text: message.text,
          ts: message.ts,
          thread_ts: message.thread_ts,
          subtype: message.subtype
        }, client, body);
      } catch (err) {
        console.error('[BOT WORKER ERROR app.message]', err);
      }
    });
  } catch (err) {
    console.error('[BOT ERROR app.message]', err);
  }
});

// Incluimos también los "message_changed" para unfurls
app.event('message', async ({ event, client, body }) => {
  try {
    setImmediate(async () => {
      try {
        const text = typeof event.text === 'string'
          ? event.text
          : (event.message && typeof event.message.text === 'string' ? event.message.text : '');
        log('Procesando event(message)…');
        logObj('event(raw)', event);
        await handleMessageLike({
          channel: event.channel,
          user: event.user,
          text,
          ts: event.ts,
          thread_ts: event.thread_ts,
          subtype: event.subtype
        }, client, body);
      } catch (err) {
        console.error('[BOT WORKER ERROR app.event]', err);
      }
    });
  } catch (err) {
    console.error('[BOT ERROR app.event]', err);
  }
});

// ===== errores Bolt =====
app.error((error) => {
  console.error('[BOLT ERROR]', error);
});

// ===== Next.js API export =====
export const config = { api: { bodyParser: false } };
export default receiver.app;
