import { App, ExpressReceiver } from '@slack/bolt';
import fetch from 'node-fetch';

// ===== Config =====
const DEBUG = process.env.DEBUG === '1';
// Permitir uno o varios canales (C... / G...). Si lo dejas vacío, responde en todos.
const ALLOWED_CHANNELS = (process.env.ALLOWED_CHANNELS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// Receiver con endpoint /api/slack (Next/Vercel)
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  endpoints: { events: '/api/slack' },
});

// ⚠️ Importante: esperamos al listener para responder (ack controlado)
// Mantener todo < ~2.5s para entrar en la ventana de Slack (3s).
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
  processBeforeResponse: true,
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
  // corrige &amp; y espacios NBSP
  let s = u.replace(/&amp;/g, '&').replace(/\u00A0/g, ' ').trim();
  try { return new URL(s).toString(); } catch { return s; }
}
function pickFirstSupportedUrlFromText(text) {
  return extractUrls(text).find(isSupportedMusicUrl);
}

// Para unfurls: a veces el link viene en attachments/title_link o from_url
function pickUrlFromEvent(event) {
  const text =
    typeof event.text === 'string' ? event.text :
    (event.message && typeof event.message.text === 'string' ? event.message.text : '');

  // 1) del texto
  let url = pickFirstSupportedUrlFromText(text || '');
  if (url) return url;

  // 2) de attachments (unfurl)
  const atts = event?.message?.attachments || event?.attachments || [];
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

// ===== fetch con timeout (2.2s, un solo intento) =====
async function fetchWithTimeout(url, opts = {}, timeoutMs = 2200) {
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

  log('Fetching Odesli:', apiUrl);
  const r = await fetchWithTimeout(apiUrl, { headers }, 2200);
  log('Odesli status:', r.status);
  if (!r.ok) throw new Error(`odesli status ${r.status}`);
  return await r.json();
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

// ===== anti-duplicados: solo si ya tenemos URL candidata =====
const seenEvents = new Set();

// ===== ÚNICO listener para todos los mensajes (incluye message_changed) =====
app.event('message', async ({ event, client, body }) => {
  try {
    const channel = event.channel;
    if (isIgnorableEvent(event)) return;

    const allowed = !ALLOWED_CHANNELS.length || ALLOWED_CHANNELS.includes(channel);
    if (!allowed) { log('Ignorado por canal:', channel); return; }

    log('Procesando event(message)…');
    logObj('event(raw)', {
      channel, user: event.user, subtype: event.subtype, ts: event.ts,
      text: typeof event.text === 'string' ? event.text : undefined
    });

    // 1) Buscar la URL (texto o attachments de unfurl)
    const candidateRaw = pickUrlFromEvent(event);
    log('URL candidata RAW:', candidateRaw || '(ninguna)');
    if (!candidateRaw) return;

    // 2) Dedup recién ahora (si no hay URL, no marcamos el evento como visto)
    const eventId = body?.event_id;
    if (eventId) {
      if (seenEvents.has(eventId)) { log('Evento duplicado ignorado:', eventId); return; }
      seenEvents.add(eventId);
      if (seenEvents.size > 2000) seenEvents.clear();
    }

    const candidate = normalizeCandidate(candidateRaw);
    log('URL candidata NORMALIZADA:', candidate);

    // 3) Cache y Odesli
    let data = getCached(candidate);
    if (!data) {
      try {
        data = await fetchOdesli(candidate);
        setCached(candidate, data);
      } catch (err) {
        console.error('[BOT] Odesli timeout/failure:', err);
        const threadTs = event.thread_ts || event.ts;
        await client.chat.postMessage({
          channel,
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

// ===== Next.js API export =====
export const config = { api: { bodyParser: false } };
export default receiver.app;
