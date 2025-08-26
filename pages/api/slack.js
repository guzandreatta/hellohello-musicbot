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

// ⚠️ processBeforeResponse: true → Bolt ackeará DESPUÉS de ejecutar el listener.
// Mantén TODO debajo de ~2.5s para cumplir la ventana de Slack.
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
  processBeforeResponse: true,
});

// ===== Logs helpers =====
function log(...args) { if (DEBUG) console.log('[BOT]', ...args); }
function logObj(label, obj) { if (DEBUG) console.log(`[BOT] ${label}:`, JSON.stringify(obj, null, 2)); }

// ===== URL utils =====
function cleanSlackUrl(raw) {
  if (!raw) return '';
  let u = raw.trim();
  if (u.startsWith('<') && u.endsWith('>')) u = u.slice(1, -1);
  const pipeIdx = u.indexOf('|');
  if (pipeIdx !== -1) u = u.slice(0, pipeIdx);
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
    const { hostname } = new URL(u);
    const h = hostname.toLowerCase();
    if (h.endsWith('open.spotify.com') || h === 'spotify.link') return true;
    if (h.endsWith('music.apple.com') || h.endsWith('itunes.apple.com') || h.endsWith('geo.music.apple.com')) return true;
    if (h.endsWith('music.youtube.com') || h.endsWith('youtube.com') || h === 'youtu.be') return true;
    return false;
  } catch { return false; }
}
function pickFirstSupportedUrl(text) {
  const urls = extractUrls(text);
  return urls.find(isSupportedMusicUrl);
}

// Permitimos message_changed para capturar URL cuando llega tras el unfurl
function isIgnorableMessage(message) {
  if (!message) return true;
  if (message.subtype === 'bot_message' || message.bot_id) return true;
  if (message.subtype === 'message_deleted') return true;
  return false;
}

// ===== fetch with timeout (1.8s) =====
async function fetchWithTimeout(url, opts = {}, timeoutMs = 1800) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(id);
  }
}

async function fetchOdesli(url) {
  const apiUrl = `https://api.song.link/v1-alpha.1/links?url=${encodeURIComponent(url)}`;
  log('Fetching Odesli:', apiUrl);
  const res = await fetchWithTimeout(apiUrl, {}, 1800);
  log('Odesli status:', res.status);
  if (!res.ok) throw new Error(`odesli status ${res.status}`);
  return res.json();
}

// ===== anti-duplicados (simple) =====
const seenEvents = new Set();

// ===== diagnóstico de eventos =====
app.event('message', async ({ event }) => {
  logObj('event(message)', {
    channel: event.channel, user: event.user, subtype: event.subtype, text: event.text, ts: event.ts
  });
});

// ===== listener principal =====
app.message(async ({ message, client, body }) => {
  const startedAt = Date.now();
  try {
    if (isIgnorableMessage(message)) return;

    const isChannelAllowed = !ALLOWED_CHANNELS.length || ALLOWED_CHANNELS.includes(message.channel);
    if (!isChannelAllowed) {
      log('Ignorado por canal:', message.channel);
      return;
    }

    // Fallback de texto: si es message_changed, Slack suele enviar el texto en body.event.message.text
    const text =
      message.text ??
      (body?.event?.message && typeof body.event.message.text === 'string' ? body.event.message.text : '');

    logObj('message', {
      channel: message.channel,
      user: message.user,
      subtype: message.subtype,
      ts: message.ts,
      thread_ts: message.thread_ts,
      text
    });

    const candidate = pickFirstSupportedUrl(text || '');
    log('URL candidata:', candidate || '(ninguna)');
    if (!candidate) return;

    // Idempotencia por event_id (evita doble post en reintentos)
    const eventId = body?.event_id;
    if (eventId) {
      if (seenEvents.has(eventId)) {
        log('Evento duplicado ignorado:', eventId);
        return;
      }
      seenEvents.add(eventId);
      if (seenEvents.size > 1000) seenEvents.clear();
    }

    let data;
    try {
      data = await fetchOdesli(candidate);
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

    logObj('Odesli platforms', Object.keys(data?.linksByPlatform || {}));

    const spotify = data?.linksByPlatform?.spotify?.url;
    const apple = data?.linksByPlatform?.appleMusic?.url;
    const youtube = data?.linksByPlatform?.youtubeMusic?.url;

    let reply = '🎶 Links equivalentes:\n';
    if (spotify) reply += `- Spotify: ${spotify}\n`;
    if (apple) reply += `- Apple Music: ${apple}\n`;
    if (youtube) reply += `- YouTube Music: ${youtube}\n`;
    if (reply === '🎶 Links equivalentes:\n') reply = 'No pude encontrar equivalencias 😕';

    const threadTs = message.thread_ts || message.ts || body?.event?.ts;
    log('Posteando en thread:', { channel: message.channel, threadTs, tookMs: Date.now() - startedAt });

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
