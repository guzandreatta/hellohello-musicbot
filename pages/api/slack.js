import { App, ExpressReceiver } from '@slack/bolt';
import fetch from 'node-fetch';

const VERSION = 'v4.1-odesli-extended';
const DEBUG = process.env.DEBUG === '1';
const ALLOWED_CHANNELS = (process.env.ALLOWED_CHANNELS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// Ahora permitimos hasta 8s reales (sin cap en Vercel)
const ODESLI_TIMEOUT_MS = Number(process.env.ODESLI_TIMEOUT_MS || '8000');

const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  endpoints: { events: '/api/slack' },
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
  processBeforeResponse: true,
});

const log = (...a) => { if (DEBUG) console.log('[BOT]', ...a); };

function normalizeCandidate(u) {
  return u.replace(/&amp;/g, '&').trim();
}
function extractUrls(text) {
  if (!text) return [];
  const urlRegex = /(https?:\/\/[^\s<>]+)/gi;
  return (text.match(urlRegex) || []).map(s => s.replace(/^<|>$/g, ''));
}
function isSupportedMusicUrl(u) {
  try {
    const h = new URL(u).hostname.toLowerCase();
    return (
      h.includes('spotify') ||
      h.includes('music.apple') ||
      h.includes('youtube') ||
      h === 'youtu.be'
    );
  } catch { return false; }
}
function pickUrlFromEvent(ev) {
  const text = ev.text || ev.message?.text;
  const url = extractUrls(text || '').find(isSupportedMusicUrl);
  if (url) return url;
  const atts = ev?.message?.attachments || [];
  for (const a of atts) {
    if (a?.from_url && isSupportedMusicUrl(a.from_url)) return a.from_url;
  }
  return null;
}

// ===== Odesli =====
async function fetchOdesli(url) {
  const api = `https://api.song.link/v1-alpha.1/links?url=${encodeURIComponent(url)}`;
  const r = await fetch(api, { headers: { 'User-Agent': 'hellohello-musicbot/1.0' } });
  const raw = await r.text();
  log('[ODESLI RAW SAMPLE]', raw.slice(0, 300));
  if (!r.ok) throw new Error(`odesli status ${r.status}`);
  const data = JSON.parse(raw);
  console.log('[ODESLI DATA linksByPlatform]', JSON.stringify(data.linksByPlatform, null, 2));
  return data;
}

// ===== Fallback =====
function buildFallback(url, title = '') {
  const q = encodeURIComponent(title || url);
  let txt = ':notes: No pude confirmar equivalencias exactas ahora, probá con estas búsquedas:\n';
  txt += `- Apple Music (búsqueda): https://music.apple.com/us/search?term=${q}\n`;
  txt += `- YouTube Music (búsqueda): https://music.youtube.com/search?q=${q}\n`;
  return txt;
}

// ===== Listener =====
app.event('message', async ({ event, client }) => {
  try {
    if (event.subtype === 'bot_message' || event.bot_id) return;
    const channel = event.channel;
    if (ALLOWED_CHANNELS.length && !ALLOWED_CHANNELS.includes(channel)) return;

    const rawUrl = pickUrlFromEvent(event);
    if (!rawUrl) return;
    const url = normalizeCandidate(rawUrl);
    const threadTs = event.message?.ts || event.ts;

    // Provisional inmediato
    let provisionalTs = null;
    try {
      const resp = await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: '⏳ Buscando equivalencias…',
      });
      provisionalTs = resp.ts;
    } catch (e) {
      console.error('[BOT] provisional error', e.data || e);
    }

    // Fetch Odesli en background
    (async () => {
      let finalText = '';
      try {
        const data = await Promise.race([
          fetchOdesli(url),
          new Promise((_, rej) => setTimeout(() => rej(new Error('odesli-timeout')), ODESLI_TIMEOUT_MS))
        ]);
        const sp = data?.linksByPlatform?.spotify?.url;
        const ap = data?.linksByPlatform?.appleMusic?.url;
        const yt = data?.linksByPlatform?.youtubeMusic?.url;
        finalText = ':notes: Links equivalentes:\n';
        if (sp) finalText += `- Spotify: ${sp}\n`;
        if (ap) finalText += `- Apple Music: ${ap}\n`;
        if (yt) finalText += `- YouTube Music: ${yt}\n`;
        if (finalText === ':notes: Links equivalentes:\n') {
          finalText = buildFallback(url);
        }
      } catch (err) {
        log('Odesli fallback', String(err));
        finalText = buildFallback(url);
      }

      // Update el provisional
      try {
        if (provisionalTs) {
          await client.chat.update({
            channel,
            ts: provisionalTs,
            text: finalText,
          });
        } else {
          await client.chat.postMessage({
            channel,
            thread_ts: threadTs,
            text: finalText,
          });
        }
      } catch (e) {
        console.error('[BOT] update/post error', e.data || e);
      }
    })();

  } catch (err) {
    console.error('[BOT ERROR]', err);
  }
});

// ===== Next.js API export =====
export const config = { api: { bodyParser: false } };
export default receiver.app;
