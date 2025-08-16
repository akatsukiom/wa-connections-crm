// src/connections.js
import fs from 'fs';
import path from 'path';
import EventEmitter from 'events';
import { toDataURL } from 'qrcode';

// whatsapp-web.js es CommonJS → import por default y desestructurar:
import wwebjs from 'whatsapp-web.js';
const { Client, LocalAuth } = wwebjs;

// Webhooks (opcional, pero recomendado)
import { fireWebhook } from './webhooks.js';

/* ===========================
   Config & helpers
=========================== */

export const bus = new EventEmitter(); // emite: qr, authenticated, ready, auth_failure, disconnected, message

const SESSIONS_DIR =
  process.env.SESSIONS_DIR || path.join(process.cwd(), 'sessions');

if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

// Map de sesiones vivas en memoria
const clients = new Map(); // id -> { client, status, info, me }

/** estado actual (string) o 'offline' si no existe */
const statusOf = (id) => clients.get(id)?.status || 'offline';

/** arma config de puppeteer compatible con Railway/Docker */
function buildPuppeteerConfig() {
  const conf = {
    headless: true, // en Node 20, "true" funciona bien
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

  // Si definiste un binario de Chromium en el contenedor
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
  return `${digits}@c.us`;
}

/* ===========================
   API
=========================== */

/**
 * Crea / inicializa una sesión (si ya existe en memoria, la devuelve).
 * - Persistencia con LocalAuth en SESSIONS_DIR.
 * - Emite eventos al bus y dispara webhooks.
 */
export async function createSession(id, opts = {}) {
  if (!id) throw new Error('missing_session_id');
  if (clients.has(id)) return clients.get(id);

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: id, dataPath: SESSIONS_DIR }),
    puppeteer: buildPuppeteerConfig(),
    // fijar versión web para evitar roturas por cambios de WA Web
    webVersionCache: {
      type: 'remote',
      remotePath:
        'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
    },
  });

  const session = { client, status: 'initializing', info: null, me: null };
  clients.set(id, session);

  /* ===== Eventos de cliente ===== */

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
    } catch (e) {
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

    try {
      client.destroy();
    } catch {}
    clients.delete(id);
  });

  client.on('message', (message) => {
    bus.emit('message', { id, message });

    const data = {
      id, // id de la sesión
      from: message.from,
      to: message.to || (session.me?.wid ?? null),
      body: message.body,
      timestamp: message.timestamp ? message.timestamp * 1000 : Date.now(),
      type: message.type, // chat, image, etc.
      ack: message.ack ?? null, // 0..3
      id_msg: message.id?._serialized,
      fromMe: !!message.fromMe,
    };

    fireWebhook('message', data);
  });

  await client.initialize();
  return session;
}

/** Lista las sesiones vivas (en memoria) */
export function listSessions() {
  return Array.from(clients.keys()).map((id) => ({
    id,
    status: statusOf(id),
    me: clients.get(id)?.me || null,
  }));
}

/** Obtiene la sesión (si existe) */
export function getSession(id) {
  return clients.get(id) || null;
}

/** Cierra sesión, la elimina del mapa y borra credenciales en disco */
export async function deleteSession(id) {
  const s = clients.get(id);
  if (s) {
    try {
      await s.client.destroy();
    } catch {}
    clients.delete(id);
  }

  const dir = path.join(SESSIONS_DIR, `session-${id}`);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });

  fireWebhook('session_deleted', { id });
  return true;
}

/** Enviar texto por una sesión */
export async function sendText(id, to, text) {
  const s = clients.get(id);
  if (!s) throw new Error('session_not_found');
  if (s.status !== 'ready') throw new Error('session_not_ready');

  const chatId = toChatId(to);
  if (!chatId) throw new Error('invalid_recipient');

  const msg = await s.client.sendMessage(chatId, text);
  // opcional: webhook de "message_sent"
  fireWebhook('message_sent', {
    id,
    to: chatId,
    body: text,
    id_msg: msg?.id?._serialized || null,
    timestamp: Date.now(),
  });
  return msg;
}

/** Reconecta (cierra y vuelve a inicializar) sin borrar credenciales */
export async function reconnect(id) {
  const s = clients.get(id);
  if (!s) throw new Error('session_not_found');

  try {
    await s.client.destroy();
  } catch {}
  clients.delete(id);

  return createSession(id);
}

/** Restaura todas las sesiones guardadas en disco */
export async function restoreAllSessions() {
  const entries = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true });
  const ids = [];

  for (const dir of entries) {
    if (dir.isDirectory() && dir.name.startsWith('session-')) {
      const id = dir.name.replace(/^session-/, '');
      try {
        await createSession(id); // espera a que se cree cada sesión
        ids.push(id);
      } catch (e) {
        console.error(`[${id}] restore error:`, e.message);
      }
    }
  }

  return ids;
}
