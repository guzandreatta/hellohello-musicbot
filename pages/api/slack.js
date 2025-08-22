import { App, ExpressReceiver } from '@slack/bolt';
import fetch from 'node-fetch';

// ===== Config =====
const DEBUG = process.env.DEBUG === '1';

// Canales permitidos (opcional). Ej: "C0123ABCDEF,C0456GHIJKL"
// Si está vacío, responde en cualquier canal.
const ALLOWED_CHANNELS = (process.env.ALLOWED_CHANNELS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// Receiver con endpoint /api/slack (Next/Vercel)
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  endpoints: { events: '/api/slack' },
});

// ⚠️ Importante: SIN processBeforeResponse (ack inmediato por defecto)
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
});

// ===== Helpers de log =====
function log(...args) { if (DEBUG) console.log('[BOT]', ...args); }
function logObj(label, obj) { if (DEBUG) console.log(`[BOT] ${label}:`, JSON.stringify(obj, null, 2)); }

// ===== Utilidades URL =====
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
function isIgnorableMessage(message) {
  if (!message) return true;
  if (message.subtype === 'bot_message' || message.bot_id) return true;
  if (message.subtype === 'message_changed' || message.subtype === 'message_deleted') return true;
  return false;
}

// ===== Anti-duplicados (simple, por proceso) =====
const seenEvents = new Set();

// ===== Diagnóstico opcional =====
app.event('message', async ({ event }) => {
  logObj('event(message)', {
    channel: event.channel, user: event.user, subtype: event.subtype, text: event.text, ts: event.ts
  });
});

// ===== Listener principal =====
app.message(async ({ message, client, body }) => {
  try {
    // 0) Ack inmediato lo maneja Bolt (no usamos processBeforeResponse)
    //    → No hacer await aquí antes de programar el trabajo pesado.

    // 1) Filtros rápidos para salir ASAP
    if (isIgnorableMessage(message)) return;

    const isChannelAllowed =
      !ALLOWED_CHANNELS.length || ALLOWED_CHANNELS.includes(message.channel);
    if (!isChannelAllowed) {
      log('Ignorado por canal:', message.channel);
      return;
    }

    // 2) **Programar** el trabajo pesado después del ack
    //    Usamos setImmediate para que el ack salga primero.
    setImmediate(async () => {
      try {
        // Idempotencia básica (si Slack reintenta el mismo evento)
        const eventId = body?.event_id;
        if (eventId) {
          if (seenEvents.has(eventId)) {
            log('Evento duplicado ignorado:', eventId);
            return;
          }
          seenEvents.add(eventId);
          // limpiar memoria simple (opcional)
          if (seenEvents.size > 1000) {
            // evitar crecer sin límite
            seenEvents.clear();
          }
        }

        log('Procesando mensaje…');
        logObj('message', {
          channel: message.channel, user: message.user, text: message.text, ts: message.ts, thread_ts: message.thread_ts
        });

        const candidate = pickFirstSupportedUrl(message.text || '');
        log('URL candidata:', candidate || '(ninguna)');
        if (!candidate) return;

        const apiUrl = `https://api.song.link/v1-alpha.1/links?url=${encodeURIComponent(candidate)}`;
        log('Fetching:', apiUrl);
        const res = await fetch(apiUrl);
        const data = await res.json();
        if (DEBUG) logObj('Odesli platforms', Object.keys(data?.linksByPlatform || {}));

        const spotify = data?.linksByPlatform?.spotify?.url;
        const apple = data?.linksByPlatform?.appleMusic?.url;
        const youtube = data?.linksByPlatform?.youtubeMusic?.url;

        let reply = '🎶 Links equivalentes:\n';
        if (spotify) reply += `- Spotify: ${spotify}\n`;
        if (apple) reply += `- Apple Music: ${apple}\n`;
        if (youtube) reply += `- YouTube Music: ${youtube}\n`;
        if (reply === '🎶 Links equivalentes:\n') reply = 'No pude encontrar equivalencias 😕';

        const threadTs = message.thread_ts || message.ts;
        log('Posteando en thread:', { channel: message.channel, threadTs, reply });

        await client.chat.postMessage({
          channel: message.channel,
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
    console.error('[BOT ERROR]', err);
  }
});

// ===== Errores Bolt =====
app.error((error) => {
  console.error('[BOLT ERROR]', error);
});

// ===== Next.js API export =====
export const config = { api: { bodyParser: false } };
export default receiver.app;
