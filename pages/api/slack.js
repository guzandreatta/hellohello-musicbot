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

// Ack tras ejecutar el listener: mantén todo bajo ~2.5s
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
  processBeforeResponse: true,
});

// ===== Logs helpers =====
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
const pickFirstSupportedUrl = (text) => (extractUrls(text).find(isSupportedMusicUrl));

// Permitimos message_changed (cuando el unfurl inserta el link “después”)
function isIgnorableMessage(message) {
  if (!message) return true;
  if (message.subtype === 'bot_message' || message.bot_id) return true;
  if (message.subtype === 'message_deleted') return true;
  return false;
}

// ===== fetch with timeout (1.8s) + retry =====
async function fetchWithTimeout(url, opts = {}, timeoutMs = 1800) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}
async function fetchOdesli(url) {
  const apiUrl = `https://api.song.link/v1-alpha.1/links?userCountry=US&url=${encodeURIComponent(url)}`;
  const headers = { 'user-agent': 'hellohello-musicbot/1.0' };

  // try 1
  try {
    log('Fetching Odesli (1):', apiUrl);
    const r = await fetchWithTimeout(apiUrl, { headers }, 1800);
    log('Odesli status (1):', r.status);
    if (!r.ok) throw new Error(`odesli status ${r.status}`);
    return await r.json();
  } catch (e1) {
    log('Odesli try 1 failed:', String(e1));
    // try 2
    try {
      log('Fetching Odesli (2):', apiUrl);
      const r2 = await fetchWithTimeout(apiUrl, { headers }, 1800);
      log('Odesli status (2):', r2.status);
      if (!r2.ok) throw new Error(`odesli status ${r2.status}`);
      return await r2.json();
    } catch (e2) {
      log('Odesli try 2 failed:', String(e2));
      throw e2;
    }
  }
}

// ===== cache en memoria por URL =====
const cache = new Map(); // key: url, val: { data, at }
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 min
function getCached(url) {
  const e = cache.get(url);
  if (!e) return null;
  if (Date.now() - e.at > CACHE_TTL_MS) { cache.delete(url); return null; }
  return e.data;
}
function setCached(url, data) {
  cache.set(url, { data, at: Date.now() });
}

// ===== anti-duplicados simple =====
const seenEvents = new Set();

// ===== diagnóstico de eventos =====
app.event('message', async ({ event }) => {
  logObj('event(message)', {
    channel: event.channel, user: event.user, subtype: event.subtype, text: event.text, ts: event.ts
  });
});

// ===== listener principal =====
app.message(async ({ message, client, body }) => {
  const started = Date.now();
  try {
    if (isIgnorableMessage(message)) return;

    const allowed = !ALLOWED_CHANNELS.length || ALLOWED_CHANNELS.includes(message.channel);
    if (!allowed) { log('Ignorado por canal:', message.channel); return; }

    // Fallback de texto cuando subtype es message_changed
    const text =
      message.text ??
      (body?.event?.message && typeof body.event.message.text === 'string' ? body.event.message.text : '');

    logObj('message', {
      channel: message.channel, user: message.user, subtype: message.subtype,
      ts: message.ts, thread_ts: message.thread_ts, text
    });

    const candidate = pickFirstSupportedUrl(text || '');
    log('URL candidata:', candidate || '(ninguna)');
    if (!candidate) return;

    // Idempotencia por event_id
    const eventId = body?.event_id;
    if (eventId) {
      if (seenEvents.has(eventId)) { log('Evento duplicado ignorado:', eventId); return; }
      seenEvents.add(eventId);
      if (seenEvents.size > 2000) seenEvents.clear();
    }

    // Cache
    let data = getCached(candidate);
    if (!data) {
      try {
        data = await fetchOdesli(candidate);
        setCached(candidate, data);
      } catch (err) {
        console.error('[BOT] Odesli timeout/failure:', err);
        const threadTs = message.thread_ts || message.ts || body?.event?.ts;
        await client.chat.postMessage({
          channel: message.channel,
          thread_ts: threadTs,
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

    const threadTs = message.thread_ts || message.ts || body?.event?.ts;
    log('Posteando en thread:', { channel: message.channel, threadTs, tookMs: Date.now() - started });

    await client.chat.postMessage({
      channel: message.channel,
      thread_ts: threadTs,
      text: reply,
      // unfurl_links: false,
      // unfurl_media: false,
    });
  } catch (err) {
    console.error('[BOT ERROR]', err);
  }
});

// ===== errores Bolt =====
app.error((error) => {
  console.error('[BOLT ERROR]', error);
});

// ===== Next.js API export =====
export const config = { api: { bodyParser: false } };
export default receiver.app;
