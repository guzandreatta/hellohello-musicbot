import { App, ExpressReceiver } from '@slack/bolt';
import fetch from 'node-fetch';

// ====== Config ======
const DEBUG = process.env.DEBUG === '1'; // pon DEBUG=1 para ver logs verbosos
const ALLOWED_CHANNELS = (process.env.ALLOWED_CHANNELS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const isChannelAllowed = !ALLOWED_CHANNELS.length || ALLOWED_CHANNELS.includes(message.channel);
if (!isChannelAllowed) return;

// Receiver con endpoint /api/slack para Next/Vercel
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  endpoints: { events: '/api/slack' }, // clave para que Slack valide el challenge en esta ruta
});

// App Bolt (serverless friendly)
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
  processBeforeResponse: true, // ack inmediato en Vercel/Serverless
});

// ====== Helpers de log ======
function log(...args) {
  if (DEBUG) console.log('[BOT]', ...args);
}
function logObj(label, obj) {
  if (DEBUG) console.log(`[BOT] ${label}:`, JSON.stringify(obj, null, 2));
}

// ====== Utilidades de URL ======
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
  } catch {
    return false;
  }
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

// ====== Logs de arranque ======
log('Inicializando bot…');
log('Endpoint de eventos: /api/slack');
log('ALLOWED_CHANNEL:', ALLOWED_CHANNEL || '(no restringido)');

// ====== Listener principal ======
app.message(async ({ message, client }) => {
  try {
    if (isIgnorableMessage(message)) return;

    log('Evento recibido:');
    logObj('message', {
      channel: message.channel,
      user: message.user,
      ts: message.ts,
      thread_ts: message.thread_ts,
      text: message.text,
      subtype: message.subtype,
      bot_id: message.bot_id
    });

    // Limitar a canal si corresponde
    if (ALLOWED_CHANNEL && message.channel !== ALLOWED_CHANNEL) {
      log('Ignorado por canal. channel=', message.channel);
      return;
    }

    // Detectar URL soportada
    const candidate = pickFirstSupportedUrl(message.text || '');
    log('URL candidata:', candidate || '(ninguna)');
    if (!candidate) return;

    // Consultar song.link (Odesli)
    const apiUrl = `https://api.song.link/v1-alpha.1/links?url=${encodeURIComponent(candidate)}`;
    log('Fetching:', apiUrl);
    const res = await fetch(apiUrl);
    const data = await res.json();
    if (DEBUG) logObj('Odesli response (trimmed)', {
      platforms: Object.keys(data?.linksByPlatform || {}),
    });

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
    console.error('[BOT ERROR]', err);
  }
});

// ====== Handler global de errores Bolt ======
app.error((error) => {
  console.error('[BOLT ERROR]', error);
});

// ====== Next.js API config y export ======
export const config = { api: { bodyParser: false } };
export default receiver.app;
