// pages/api/slack.js
import { App, ExpressReceiver } from '@slack/bolt';
import fetch from 'node-fetch';

// ===== Config mínima =====
const VERSION = 'v5-simple';
const DEBUG = process.env.DEBUG === '1';

// Canales permitidos (opcional). Dejar vacío para todos.
const ALLOWED_CHANNELS = (process.env.ALLOWED_CHANNELS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// Timeout para Odesli. En Vercel lo capamos a ~2.4s para cumplir con Slack.
const RAW_TIMEOUT_MS = Number(process.env.ODESLI_TIMEOUT_MS || '2000');
const IS_VERCEL = !!process.env.VERCEL;
const ODESLI_TIMEOUT_MS = IS_VERCEL ? Math.min(RAW_TIMEOUT_MS, 2400) : RAW_TIMEOUT_MS;

const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  endpoints: { events: '/api/slack' },
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
  processBeforeResponse: true, // respondemos rápido a Slack
});

const log = (...a) => { if (DEBUG) console.log('[BOT]', ...a); };

// ===== Helpers muy básicos =====
function cleanAngle(s) {
  if (!s) return '';
  let x = s.trim();
  if (x.startsWith('<') && x.endsWith('>')) x = x.slice(1, -1);
  const i = x.indexOf('|'); if (i !== -1) x = x.slice(0, i);
  return x.trim();
}
function extractUrls(text) {
  if (!text) return [];
  const urlRegex = /(https?:\/\/[^\s<>]+)/gi;
  const found = text.match(urlRegex) || [];
  return found.map(cleanAngle);
}
function isMusicUrl(u) {
  try {
    const h = new URL(u).hostname.toLowerCase();
    return (
      h.endsWith('open.spotify.com') ||
      h === 'spotify.link' ||
      h.endsWith('music.apple.com') ||
      h.endsWith('itunes.apple.com') ||
      h.endsWith('music.youtube.com') ||
      h.endsWith('youtube.com') ||
      h === 'youtu.be'
    );
  } catch { return false; }
}
function pickMusicUrlFromEvent(ev) {
  const text = typeof ev.text === 'string' ? ev.text : (ev.message?.text || '');
  const fromText = extractUrls(text).find(isMusicUrl);
  if (fromText) return fromText;

  const atts = ev?.message?.attachments || ev?.attachments || [];
  for (const a of atts) {
    if (a?.from_url && isMusicUrl(a.from_url)) return a.from_url;
    if (a?.title_link && isMusicUrl(a.title_link)) return a.title_link;
    if (a?.original_url && isMusicUrl(a.original_url)) return a.original_url;
  }
  return null;
}

async function fetchWithTimeout(url, ms) {
  const ac = new AbortController();
  const id = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { signal: ac.signal, headers: { 'Accept': 'application/json', 'User-Agent': 'music-bot/1.0' } });
    return r;
  } finally {
    clearTimeout(id);
  }
}

async function getOdesli(url) {
  const api = `https://api.song.link/v1-alpha.1/links?userCountry=US&url=${encodeURIComponent(url)}`;
  const r = await fetchWithTimeout(api, ODESLI_TIMEOUT_MS);
  if (!r.ok) throw new Error(`odesli ${r.status}`);
  return r.json(); // { linksByPlatform: { spotify, appleMusic, youtubeMusic, ... } }
}

// ===== Listener único y simple =====
app.event('message', async ({ event, client }) => {
  try {
    // Ignorar mensajes de bots, borrados, etc.
    if (!event || event.bot_id || event.subtype === 'bot_message' || event.subtype === 'message_deleted') return;

    // Canal permitido
    const ch = event.channel;
    if (ALLOWED_CHANNELS.length && !ALLOWED_CHANNELS.includes(ch)) return;

    // Detectar URL de música
    const raw = pickMusicUrlFromEvent(event);
    if (!raw) return;

    const url = raw.replace(/&amp;/g, '&').trim();

    // Consultar Odesli con timeout corto
    let data;
    try {
      data = await getOdesli(url);
    } catch (e) {
      log('Odesli no disponible/timeout:', String(e));
      return; // silencio total: no postear
    }

    const by = data?.linksByPlatform || {};
    const sp = by?.spotify?.url || null;
    const ap = by?.appleMusic?.url || null;
    const yt = by?.youtubeMusic?.url || null;

    // Si no hay equivalencias útiles, no postear
    if (!sp && !ap && !yt) return;

    // Armar respuesta breve
    let txt = '🎶 ';
    const parts = [];
    if (sp) parts.push(`Spotify: ${sp}`);
    if (ap) parts.push(`Apple Music: ${ap}`);
    if (yt) parts.push(`YouTube Music: ${yt}`);
    txt += parts.join(' • ');
    if (!parts.length) return;

    const threadTs = event.message?.ts || event.thread_ts || event.ts;

    // Postear en el thread del mensaje original
    await client.chat.postMessage({
      channel: ch,
      thread_ts: threadTs,
      text: txt,
    });

  } catch (err) {
    console.error('[BOT ERROR]', err);
  }
});

// ===== Next.js API export =====
export const config = { api: { bodyParser: false } };
export default receiver.app;
