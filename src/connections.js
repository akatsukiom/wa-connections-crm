// src/connections.js
import fs from 'fs';
import path from 'path';
import EventEmitter from 'events';
import { toDataURL } from 'qrcode';

// whatsapp-web.js (CommonJS)
import wwebjs from 'whatsapp-web.js';
const { Client, LocalAuth, MessageMedia } = wwebjs;

import mime from 'mime'; // npm i mime
import { fireWebhook } from './webhooks.js';

/* ===========================
   Config & helpers
=========================== */
export const bus = new EventEmitter(); // qr, authenticated, ready, auth_failure, disconnected, message

const SESSIONS_DIR = process.env.SESSIONS_DIR || path.join(process.cwd(), 'sessions');
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// tamaño máx. (bytes) para adjuntar base64 en webhook de mensajes entrantes
const WEBHOOK_MEDIA_MAX = Number(process.env.WEBHOOK_MEDIA_MAX || 1_500_000); // ~1.5 MB

// URLs de entorno
const { PUBLIC_BASE_URL, CRM_BASE_URL, CRM_API_TOKEN } = process.env;

// fetch (Node 18+ nativo; fallback si fuese necesario)
const fetchFn = globalThis.fetch || (async (...args) => (await import('node-fetch')).default(...args));

// Sesiones vivas en memoria: id -> { client, status, info, me }
const clients = new Map();
const statusOf = (id) => clients.get(id)?.status || 'offline';

function buildPuppeteerConfig() {
  const conf = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-extensions',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--disable-features=IsolateOrigins,site-per-process',
    ],
  };
  const exe =
    process.env.CHROMIUM_PATH ||
    process.env.PUPPETEER_EXECUTABLE_PATH ||
    process.env.GOOGLE_CHROME_BIN;
  if (exe) conf.executablePath = exe;
  return conf;
}

/** normaliza un número a chatId de WhatsApp */
function toChatId(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (/@(c\.us|g\.us)$/i.test(s)) return s;
  const digits = s.replace(/\D/g, '');
  return digits ? `${digits}@c.us` : null;
}

function inferMediaType(m) {
  if (!m) return null;
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (m === 'application/pdf') return 'document';
  return 'document';
}

/** ¿es OGG/Opus válido para PTT? */
function isOggOpus(mimeStr = '') {
  return /^audio\/ogg(?:;.*)?$/i.test(mimeStr);
}

/** extensión segura desde mime */
function extFromMime(m) {
  try { return mime.getExtension(m) || 'bin'; } catch { return 'bin'; }
}

/** guarda base64 en /public/uploads/wa/YYYY/MM y devuelve { url, name, mime, size } */
function saveBase64ToUploads(base64, mimeType) {
  const buf = Buffer.from(base64, 'base64');
  const now = new Date();
  const yy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dir = path.join('public', 'uploads', 'wa', yy, mm);
  fs.mkdirSync(dir, { recursive: true });

  const ext = extFromMime(mimeType);
  const name = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}.${ext}`;
  const full = path.join(dir, name);
  fs.writeFileSync(full, buf);

  const url = `${PUBLIC_BASE_URL}/uploads/wa/${yy}/${mm}/${name}`;
  return { url, name, mime: mimeType, size: buf.length };
}

/** mapea tipos de whatsapp-web.js a tipos del CRM */
function mapWwebTypeToCRM(t) {
  switch (t) {
    case 'chat': return 'text';
    case 'image': return 'image';
    case 'video': return 'video';
    case 'audio':
    case 'ptt': return 'audio';
    case 'document': return 'file';
    case 'sticker': return 'image'; // webp -> render como imagen
    default: return 'text';
  }
}

/** Post al CRM /api/messages.php (entrantes) */
async function postIncomingToCRM(payload) {
  if (!CRM_BASE_URL) {
    console.warn('[CRM] CRM_BASE_URL no configurado, se omite POST');
    return;
  }
  try {
    await fetchFn(`${CRM_BASE_URL}/api/messages.php`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(CRM_API_TOKEN ? { 'Authorization': `Bearer ${CRM_API_TOKEN}` } : {}),
      },
      body: JSON.stringify(payload),
    }).then(r => r.text()).then(t => {
      if (!t || t.startsWith('<')) console.log('[CRM] respuesta (HTML?)', t?.slice(0, 200));
      else console.log('[CRM] ok', t);
    });
  } catch (e) {
    console.error('[CRM] POST error:', e);
  }
}

/* ===========================
   API pública
=========================== */
export async function createSession(id) {
  if (!id) throw new Error('missing_session_id');
  if (clients.has(id)) return clients.get(id);

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: id, dataPath: SESSIONS_DIR }),
    puppeteer: buildPuppeteerConfig(),
    webVersionCache: {
      type: 'remote',
      remotePath:
        'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
    },
  });

  const session = { client, status: 'initializing', info: null, me: null };
  clients.set(id, session);

  // ===== Eventos =====
  client.on('qr', async (qr) => {
    try {
      const qrDataUrl = await toDataURL(qr);
      session.status = 'qr';
      bus.emit('qr', { id, qr: qrDataUrl });
      fireWebhook('qr', { id });
    } catch (e) {
      console.error(`[${id}] QR error:`, e.message);
    }
  });

  client.on('authenticated', (info) => {
    session.status = 'authenticating';
    session.info = info || null;
    bus.emit('authenticated', { id, info });
    fireWebhook('authenticated', { id });
  });

  client.on('ready', async () => {
    session.status = 'ready';
    try {
      session.me = await client.getMe(); // { wid, pushname }
    } catch {
      session.me = null;
    }
    bus.emit('ready', { id, me: session.me });
    fireWebhook('ready', { id, me: session.me });
  });

  client.on('auth_failure', (msg) => {
    session.status = 'auth_failure';
    bus.emit('auth_failure', { id, msg });
    fireWebhook('auth_failure', { id, msg });
  });

  client.on('disconnected', (reason) => {
    session.status = 'disconnected';
    bus.emit('disconnected', { id, reason });
    fireWebhook('disconnected', { id, reason });
    try { client.destroy(); } catch {}
    clients.delete(id);
  });

  client.on('message', async (message) => {
    // payload base para tus websockets/webhooks existentes
    const data = {
      id, // sesión
      from: message.from,
      to: message.to || (session.me?.wid ?? null),
      body: message.body,
      timestamp: message.timestamp ? message.timestamp * 1000 : Date.now(),
      type: message.type, // chat, image, video, audio, etc.
      ack: message.ack ?? null,
      id_msg: message.id?._serialized || null,
      fromMe: !!message.fromMe,
    };

    // ===== NUEVO: persistir media y enviar a CRM =====
    // Solo para ENTRANTES (fromMe === false)
    if (!message.fromMe) {
      let mediaInfo = null;
      try {
        // caption si aplica
        const caption = typeof message.caption === 'string' ? message.caption : '';
        if (caption && (!data.body || data.body === '')) data.body = caption;

        if (message.hasMedia && typeof message.downloadMedia === 'function') {
          const media = await message.downloadMedia(); // { data(base64), mimetype, filename }
          if (media?.data && media?.mimetype) {
            // Guardar SIEMPRE el archivo para poder generar URL pública
            const saved = saveBase64ToUploads(media.data, media.mimetype);
            mediaInfo = {
              media_url: saved.url,
              media_mime: saved.mime,
              media_name: media.filename || saved.name,
              size_bytes: saved.size,
            };

            // Además, si el archivo es pequeño, adjuntamos base64 al webhook (como ya hacías)
            const approxBytes = Math.floor(media.data.length * 0.75);
            if (approxBytes <= WEBHOOK_MEDIA_MAX) {
              data.media = {
                mimetype: saved.mime,
                filename: media.filename || saved.name,
                data: media.data,
                size: approxBytes,
                media_type: inferMediaType(saved.mime),
              };
            } else {
              data.media = {
                mimetype: saved.mime,
                filename: media.filename || saved.name,
                data: null,
                size: approxBytes,
                media_type: inferMediaType(saved.mime),
                skipped: true,
              };
            }
          }
        }

        // Construir payload para /api/messages.php
        const payloadCRM = {
          channel: 'whatsapp',
          direction: 'in',
          chat_id: message.from, // el CRM lo normaliza a E.164
          wa_message_id: message.id?._serialized || null,
          body: data.body || '',
          type: mapWwebTypeToCRM(message.type),
          created_at_ms: data.timestamp,
          ...(mediaInfo || {}),
        };

        await postIncomingToCRM(payloadCRM);
      } catch (e) {
        console.warn(`[${id}] persist/CRM error:`, e.message);
      }
    }

    // ===== Fin NUEVO =====

    // Mantener tu flujo actual (bus + webhook genérico)
    bus.emit('message', { id, message });
    fireWebhook('message', data);
  });

  await client.initialize();
  return session;
}

/** Lista las sesiones vivas */
export function listSessions() {
  return Array.from(clients.keys()).map((id) => ({
    id,
    status: statusOf(id),
    me: clients.get(id)?.me || null,
  }));
}

/** Obtiene la sesión (si existe) */
export function getSession(id) { return clients.get(id) || null; }
export const getClient = getSession;

/** Cerrar sesión y borrar credenciales en disco */
export async function deleteSession(id) {
  const s = clients.get(id);
  if (s) {
    try { await s.client.destroy(); } catch {}
    clients.delete(id);
  }
  const dir = path.join(SESSIONS_DIR, `session-${id}`);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  fireWebhook('session_deleted', { id });
  return true;
}

/** Enviar texto */
export async function sendText(id, to, text) {
  const s = clients.get(id);
  if (!s) throw new Error('session_not_found');
  if (s.status !== 'ready') throw new Error('session_not_ready');

  const chatId = toChatId(to);
  if (!chatId) throw new Error('invalid_recipient');

  const msg = await s.client.sendMessage(chatId, text);

  // usar timestamp real del mensaje de WhatsApp (segundos -> ms)
  const ts = msg?.timestamp ? msg.timestamp * 1000 : Date.now();

  fireWebhook('message_sent', {
    id,
    to: chatId,
    body: text,
    id_msg: msg?.id?._serialized || null,
    timestamp: ts,
  });

  return msg; // contiene id._serialized
}

/** Enviar media (imágenes, videos, documentos, audio/nota de voz) con fallback */
export async function sendMedia(sessionId, to, buffer, mimeType, fileName = 'file', opts = {}) {
  const s = clients.get(sessionId);
  if (!s) throw new Error('session_not_found');
  if (s.status !== 'ready') throw new Error('session_not_ready');

  const chatId = toChatId(to);
  if (!chatId) throw new Error('invalid_recipient');
  if (!buffer || !mimeType) throw new Error('invalid_media');

  const b64 = Buffer.isBuffer(buffer) ? buffer.toString('base64') : Buffer.from(buffer).toString('base64');
  const media = new MessageMedia(mimeType, b64, fileName);

  // PTT sólo si es OGG/Opus
  const wantVoice = !!opts.asVoice && isOggOpus(mimeType);
  const baseOptions = {
    caption: opts.caption || '',
    sendAudioAsVoice: wantVoice,
  };

  let msg;
  try {
    msg = await s.client.sendMessage(chatId, media, baseOptions);
  } catch (e) {
    // Fallback: reintenta como DOCUMENTO (evita “Evaluation failed: b”)
    const shouldFallback = /Evaluation failed/i.test(e.message) || /not a function/i.test(e.message);
    if (!shouldFallback) throw e;

    const fallbackOptions = { ...baseOptions, sendAudioAsVoice: false, sendMediaAsDocument: true };
    msg = await s.client.sendMessage(chatId, media, fallbackOptions);
  }

  const ts = msg?.timestamp ? msg.timestamp * 1000 : Date.now();

  fireWebhook('message_sent', {
    id: sessionId,
    to: chatId,
    id_msg: msg?.id?._serialized || null,
    timestamp: ts,
    media_type: inferMediaType(mimeType),
    mime: mimeType,
    file_name: fileName,
  });

  return msg;
}

/** Revocar (eliminar para todos) */
export async function revokeMessage(sessionId, chatId, messageId) {
  const s = clients.get(sessionId);
  if (!s) throw new Error('session_not_found');
  if (s.status !== 'ready') throw new Error('session_not_ready');

  const toId = toChatId(chatId);
  if (!toId) throw new Error('invalid_chat_id');
  if (!messageId) throw new Error('invalid_message_id');

  if (typeof s.client.getMessageById === 'function') {
    const msg = await s.client.getMessageById(messageId);
    if (!msg) throw new Error('message_not_found');
    await msg.delete(true); // true => borrar para todos (si WA lo permite)
    fireWebhook('message_revoked', { id: sessionId, chatId: toId, messageId });
    return { ok: true, engine: 'whatsapp-web.js' };
  }
  throw new Error('revoke_not_supported_by_client');
}

/** Reconectar sin borrar credenciales */
export async function reconnect(id) {
  const s = clients.get(id);
  if (!s) throw new Error('session_not_found');
  try { await s.client.destroy(); } catch {}
  clients.delete(id);
  return createSession(id);
}

/** Restaurar todas las sesiones guardadas en disco */
export async function restoreAllSessions() {
  const entries = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true });
  const ids = [];
  for (const dir of entries) {
    if (dir.isDirectory() && dir.name.startsWith('session-')) {
      const id = dir.name.replace(/^session-/, '');
      try {
        await createSession(id);
        ids.push(id);
      } catch (e) {
        console.error(`[${id}] restore error:`, e.message);
      }
    }
  }
  return ids;
}
