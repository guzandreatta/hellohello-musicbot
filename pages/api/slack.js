import { App, ExpressReceiver } from '@slack/bolt';
import fetch from 'node-fetch';

// Receiver con endpoint /api/slack para Next/Vercel
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  endpoints: { events: '/api/slack' },
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
  processBeforeResponse: true, // ack inmediato en serverless
});

const ALLOWED_CHANNEL = process.env.ALLOWED_CHANNEL || '';

// --------- Utilidades de URL ----------
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

// --------- Listener ---------
app.message(async ({ message, client }) => {
  try {
    if (isIgnorableMessage(message)) return;
    if (ALLOWED_CHANNEL && message.channel !== ALLOWED_CHANNEL) return;

    const candidate = pickFirstSupportedUrl(message.text || '');
    if (!candidate) return;

    const res = await fetch(`https://api.song.link/v1-alpha.1/links?url=${encodeURIComponent(candidate)}`);
    const data = await res.json();

    const spotify = data?.linksByPlatform?.spotify?.url;
    const apple = data?.linksByPlatform?.appleMusic?.url;
    const youtube = data?.linksByPlatform?.youtubeMusic?.url;

    let reply = '🎶 Links equivalentes:\n';
    if (spotify) reply += `- Spotify: ${spotify}\n`;
    if (apple) reply += `- Apple Music: ${apple}\n`;
    if (youtube) reply += `- YouTube Music: ${youtube}\n`;
    if (reply === '🎶 Links equivalentes:\n') reply = 'No pude encontrar equivalencias 😕';

    const threadTs = message.thread_ts || message.ts;
    await client.chat.postMessage({
      channel: message.channel,
      thread_ts: threadTs,
      text: reply,
    });
  } catch (err) {
    console.error('[BOT ERROR]', err);
  }
});

// Next.js API config (crítico para Slack)
export const config = { api: { bodyParser: false } };
export default receiver.app;
