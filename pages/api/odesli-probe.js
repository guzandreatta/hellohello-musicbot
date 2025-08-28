// pages/api/slack.js
import { App, ExpressReceiver } from '@slack/bolt';
import fetch from 'node-fetch';

// ===== Marca de versión =====
const VERSION = 'v3.7-provisional-parallel-cap';
console.log('[BOT] Boot', VERSION, '| ALLOWED_CHANNELS=', process.env.ALLOWED_CHANNELS || '(all)');

// ===== Config =====
const DEBUG = process.env.DEBUG === '1';
const ALLOWED_CHANNELS = (process.env.ALLOWED_CHANNELS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// Timeout configurable para Odesli; en Vercel lo capamos a 2400ms para cumplir la ventana de Slack
const ODESLI_TIMEOUT_MS = Number(process.env.ODESLI_TIMEOUT_MS || '5000');
const IS_VERCEL = !!process.env.VERCEL;
const EFFECTIVE_ODESLI_MS = IS_VERCEL ? Math.min(ODESLI_TIMEOUT_MS, 2400) : ODESLI_TIMEOUT_MS;
console.log('[BOT] ODESLI_TIMEOUT_MS=', ODESLI_TIMEOUT_MS, '| EFFECTIVE=', EFFECTIVE_ODESLI_MS, '| IS_VERCEL=', IS_VERCEL);

// Receiver con endpoint /api/slack (Next/Vercel)
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  endpoints: { events: '/api/slack' },
});

// Bolt espera al listener (sin background). Mantener <~2.5s en Vercel.
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
  processBeforeResponse: true,
});

// ===== Logs =====
const log = (...a) => { if (DEBUG) console.log('[BOT]', ...a); };
const logObj = (label, obj) => { if (DEBUG) console.log(`[BOT] ${label}:`, JSON.stringify(obj, null, 2)); };

// ===== URL helpers =====
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
  let s = (u || '').replace(/&amp;/g, '&').replace(/\u00A0/g, ' ').trim();
  try { return new URL(s).toString(); } catch { return s; }
}
const pickFirstSupportedUrlFromText = (text) => extractUrls(text).find(isSupportedMusicUrl);

// Extrae link desde texto o attachments del unfurl (message_changed)
function pickUrlFromEvent(ev) {
  const text =
    typeof ev.text === 'string' ? ev.text :
    (ev.message && typeof ev.message.text === 'string' ? ev.message.text : '');
  let url = pickFirstSupportedUrlFromText(text || '');
  if (url) return url;

  const atts = ev?.message?.attachments || ev?.attachments || [];
  for (const a of atts) {
    if (a?.from_url && isSupportedMusicUrl(a.from_url)) return a.from_url;
    if (a?.title_link && isSupportedMusicUrl(a.title_link)) return a.title_link;
    if (a?.original_url && isSupportedMusicUrl(a.original_url)) return a.original_url;
  }
  return null;
}

function refineQuery(s) {
  if (!s) return s;
  s = s.replace(/\s*[\(\[][^\)\]]*[\)\]]/g, '');   // (Remix), [Live], etc.
  s = s.replace(/\s+(feat\.?|ft\.?)\s+.+$/i, '');  // feat. ...
  return s.replace(/\s{2,}/g, ' ').trim();
}

// ===== Filtros =====
function isIgnorableEvent(ev) {
  if (!ev) return true;
  if (ev.subtype === 'bot_message' || ev.bot_id) return true;
  if (ev.subtype === 'message_deleted') return true;
  return false;
}

// ===== Fetch con timeout =====
async function fetchWithTimeout(url, opts = {}, timeoutMs = EFFECTIVE_ODESLI_MS) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

// ===== Odesli =====
async function fetchOdesli(url) {
  const normalized = normalizeCandidate(url);
  const apiUrl = `https://api.song.link/v1-alpha.1/links?userCountry=US&url=${encodeURIComponent(normalized)}`;
  const headers = { 'Accept': 'application/json', 'User-Agent': 'hellohello-musicbot/1.0' };
  log('Fetching Odesli:', apiUrl);
  const r = await fetchWithTimeout(apiUrl, { headers }, EFFECTIVE_ODESLI_MS);
  const ct = r.headers.get('content-type');
  log('Odesli status:', r.status, '| content-type:', ct);
  const raw = await r.text(); // siempre leemos para debug
  if (!r.ok) {
    console.error('[ODESLI ERR BODY]', raw.slice(0, 400));
    throw new Error(`odesli status ${r.status}`);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error('[ODESLI PARSE ERR]', String(e), '| sample:', raw.slice(0, 200));
    throw e;
  }
}

// ===== Spotify oEmbed (para fallback) =====
async function fetchSpotifyOEmbed(spotifyUrl, ms = Math.min(1500, EFFECTIVE_ODESLI_MS)) {
  const url = `https://open.spotify.com/oembed?url=${encodeURIComponent(spotifyUrl)}`;
  const r = await fetchWithTimeout(url, {}, ms);
  if (!r.ok) throw new Error(`spotify oembed ${r.status}`);
  return await r.json(); // { title, author_name, ... }
}

// ===== Cache (10 min) =====
const cache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;
function getCached(url) {
  const e = cache.get(url);
  if (!e) return null;
  if (Date.now() - e.at > CACHE_TTL_MS) { cache.delete(url); return null; }
  return e.data;
}
function setCached(url, data) { cache.set(url, { data, at: Date.now() }); }

// ===== Anti-duplicados (solo si hay URL) =====
const seenEvents = new Set();

// ===== Listener principal =====
app.event('message', async ({ event, client, body }) => {
  try {
    if (isIgnorableEvent(event)) return;

    const channel = event.channel;
    const allowed = !ALLOWED_CHANNELS.length || ALLOWED_CHANNELS.includes(channel);
    if (!allowed) { log('Ignorado por canal:', channel); return; }

    log('Procesando event(message)…');
    logObj('event(raw)', { channel, user: event.user, subtype: event.subtype, ts: event.ts });

    // 1) URL candidata
    const candidateRaw = pickUrlFromEvent(event);
    log('URL candidata RAW:', candidateRaw || '(ninguna)');
    if (!candidateRaw) return;

    // 2) Dedup recién ahora (una vez que SÍ hay URL)
    const eventId = body?.event_id;
    if (eventId) {
      if (seenEvents.has(eventId)) { log('Evento duplicado ignorado:', eventId); return; }
      seenEvents.add(eventId);
      if (seenEvents.size > 2000) seenEvents.clear();
    }

    const candidate = normalizeCandidate(candidateRaw);
    log('URL candidata NORMALIZADA:', candidate);

    // 3) Thread del mensaje original (message_changed → event.message.ts)
    const threadTs = event.message?.ts || event.thread_ts || event.ts;

    // 3.5) Respuesta provisional inmediata (confirma que el bot “responde el mensaje”)
    let provisionalTs = null;
    try {
      const provisional = await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: '⏳ Buscando equivalencias…',
      });
      provisionalTs = provisional.ts;
      log('Provisional posteado:', { ts: provisionalTs });
    } catch (e) {
      console.error('[BOT] provisional post error:', e?.data || e);
    }

    // 4) Construí FALLBACK en paralelo (rápido)
    const buildFallback = (async () => {
      try {
        const u = new URL(candidate);
        const host = u.hostname.toLowerCase();
        let searchText = candidate;

        if (host.includes('spotify')) {
          try {
            const meta = await fetchSpotifyOEmbed(candidate);
            const title = meta?.title || '';
            const author = meta?.author_name || '';
            const merged = [title, author].filter(Boolean).join(' ');
            if (merged) searchText = merged;
            log('oEmbed title/author:', { title, author, merged });
          } catch (e) {
            log('Fallback meta fetch failed:', String(e));
          }
        }
        searchText = refineQuery(searchText);
        const q = encodeURIComponent(searchText);
        const appleSearch = `https://music.apple.com/us/search?term=${q}`;
        const ytMusicSearch = `https://music.youtube.com/search?q=${q}`;
        const spotifySearch = `https://open.spotify.com/search/${q}`;

        let txt = '🎶 No pude confirmar equivalencias exactas ahora, probá con estas búsquedas:\n';
        if (!host.includes('spotify')) txt += `- Spotify (búsqueda): ${spotifySearch}\n`;
        if (!host.includes('apple')) txt += `- Apple Music (búsqueda): ${appleSearch}\n`;
        if (!host.includes('youtube')) txt += `- YouTube Music (búsqueda): ${ytMusicSearch}\n`;
        txt += ' _(modo rápido por latencia de Odesli)_';
        return txt;
      } catch {
        return '🎶 No pude confirmar equivalencias exactas ahora.';
      }
    })();

    // 5) Odesli (o cache), en paralelo con el fallback y con timeout propio
    const dataFromCache = getCached(candidate);
    const odesliPromise = (async () => {
      if (dataFromCache) {
        log('Cache hit para URL');
        return dataFromCache;
      }
      log(`Odesli RACE start (${EFFECTIVE_ODESLI_MS}ms)`);
      const data = await fetchOdesli(candidate);
      log('Odesli RACE resolved');
      setCached(candidate, data);
      return data;
    })();

    // 6) Odesli → texto final
    const odesliToText = (async () => {
      const data = await odesliPromise;
      const spotify = data?.linksByPlatform?.spotify?.url;
      const apple = data?.linksByPlatform?.appleMusic?.url;
      const youtube = data?.linksByPlatform?.youtubeMusic?.url;

      let reply = '🎶 Links equivalentes:\n';
      if (spotify) reply += `- Spotify: ${spotify}\n`;
      if (apple) reply += `- Apple Music: ${apple}\n`;
      if (youtube) reply += `- YouTube Music: ${youtube}\n`;
      if (reply === '🎶 Links equivalentes:\n') throw new Error('odesli-empty');
      return reply;
    })();

    // 7) Timeout global levemente mayor que Odesli efectivo
    const globalTimeoutMs = Math.min(EFFECTIVE_ODESLI_MS + 200, 2600);
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`GLOBAL_TIMEOUT_${globalTimeoutMs}ms`)), globalTimeoutMs)
    );

    // 8) Elige lo primero que llegue: Odesli (texto) o Fallback; si ambos demoran, cae al catch y usamos fallback
    let textToPost = '';
    try {
      textToPost = await Promise.race([odesliToText, buildFallback, timeoutPromise]);
      log('Reply source:', textToPost.startsWith('🎶 Links equivalentes') ? 'ODESLI' : 'FALLBACK');
    } catch (e) {
      log('Race failed → usar fallback:', String(e));
      try {
        textToPost = await buildFallback;
      } catch {
        textToPost = '🎶 No pude confirmar equivalencias exactas ahora.';
      }
    }

    // 9) Publicar: si hay provisional, se actualiza; si no, se postea nuevo
    const finalText = textToPost || '🎶 No pude confirmar equivalencias exactas ahora.';
    log('Posteando en thread (pre):', { channel, thread_ts: threadTs, provisionalTs });

    try {
      if (provisionalTs) {
        const resp = await client.chat.update({
          channel,
          ts: provisionalTs,
          text: finalText,
        });
        log('Provisional actualizado OK:', { ts: resp.ts });
      } else {
        const resp = await client.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text: finalText,
        });
        log('Posteado OK:', { ts: resp.ts });
      }
    } catch (e) {
      const errData = e?.data || e;
      console.error('[BOT] post/update error:', errData);

      const reason = errData?.error;
      if (reason === 'not_in_channel' || reason === 'restricted_action') {
        try {
          await client.chat.postEphemeral({
            channel,
            user: event.user,
            text: 'No tengo permiso para publicar en este canal. Invitame con `/invite @TuBot` o habilitá permisos.',
          });
          log('Aviso ephemeral enviado.');
        } catch (eph) {
          console.error('[BOT] chat.postEphemeral error:', eph?.data || eph);
        }
      }
    }
  } catch (err) {
    console.error('[BOT WORKER ERROR]', err);
  }
});

// ===== Captura global de errores de Bolt =====
app.error((e) => {
  console.error('[BOLT APP ERROR]', e?.data || e);
});

// ===== Next.js API export =====
export const config = { api: { bodyParser: false } };
export default receiver.app;
