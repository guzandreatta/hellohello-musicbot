import { App, ExpressReceiver } from '@slack/bolt';
import fetch from 'node-fetch';

// ===== Config =====
const DEBUG = true; // activamos siempre logs
const ALLOWED_CHANNELS = (process.env.ALLOWED_CHANNELS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

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
  processBeforeResponse: true,
});

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
  return (text.match(urlRegex) || []).map(cleanAngle);
}
function isMusicUrl(u) {
  try {
    const h = new URL(u).hostname.toLowerCase();
    return (
      h.includes('spotify') ||
      h.includes('music.apple.com') ||
      h.includes('youtube') ||
      h === 'youtu.be'
    );
  } catch { return false; }
}
function pickMusicUrlFromEvent(ev) {
  const text = ev.text || ev.message?.text || '';
  const fromText = extractUrls(text).find(isMusicUrl);
  if (fromText) return fromText;
  const atts = ev?.message?.attachments || [];
  for (const a of atts) {
    if (a?.from_url && isMusicUrl(a.from_url)) return a.from_url;
  }
  return null;
}

async function fetchWithTimeout(url, ms) {
  const ac = new AbortController();
  const id = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, {
      signal: ac.signal,
      headers: { 'Accept': 'application/json', 'User-Agent': 'music-bot/1.0' }
    });
  } finally {
    clearTimeout(id);
  }
}

async function getOdesli(url) {
  const api = `https://api.song.link/v1-alpha.1/links?userCountry=US&url=${encodeURIComponent(url)}`;
  console.log('[BOT] → Consultando Odesli:', api);
  const r = await fetchWithTimeout(api, ODESLI_TIMEOUT_MS);
  const text = await r.text();
  console.log('[BOT] Odesli status:', r.status, '| size:', text.length);
  console.log('[BOT] Odesli respuesta (sample):', text.slice(0, 200));
  if (!r.ok) throw new Error(`odesli ${r.status}`);
  const data = JSON.parse(text);
  console.log('[BOT] Odesli linksByPlatform:', JSON.stringify(data.linksByPlatform, null, 2));
  return data;
}

app.event('message', async ({ event, client }) => {
  try {
    if (!event || event.bot_id || event.subtype === 'bot_message') return;
    if (ALLOWED_CHANNELS.length && !ALLOWED_CHANNELS.includes(event.channel)) return;

    console.log('[BOT] Nuevo mensaje:', JSON.stringify(event, null, 2));

    const raw = pickMusicUrlFromEvent(event);
    if (!raw) {
      console.log('[BOT] No se detectó URL de música.');
      return;
    }

    const url = raw.replace(/&amp;/g, '&').trim();
    console.log('[BOT] URL candidata:', url);

    let data;
    try {
      data = await getOdesli(url);
    } catch (e) {
      console.error('[BOT] Error/timeout en Odesli:', e);
      return;
    }

    const by = data?.linksByPlatform || {};
    const sp = by?.spotify?.url;
    const ap = by?.appleMusic?.url;
    const yt = by?.youtubeMusic?.url;

    if (!sp && !ap && !yt) {
      console.log('[BOT] Odesli no devolvió equivalencias.');
      return;
    }

    let txt = '🎶 ';
    const parts = [];
    if (sp) parts.push(`Spotify: ${sp}`);
    if (ap) parts.push(`Apple Music: ${ap}`);
    if (yt) parts.push(`YouTube Music: ${yt}`);
    txt += parts.join(' • ');

    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: event.ts,
      text: txt,
    });
    console.log('[BOT] Posteado en thread OK.');

  } catch (err) {
    console.error('[BOT ERROR]', err);
  }
});

export const config = { api: { bodyParser: false } };
export default receiver.app;
