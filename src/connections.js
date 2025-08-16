import { fireWebhook } from './webhooks.js';
import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import { toDataURL } from 'qrcode';
import fs from 'fs';
import path from 'path';
import EventEmitter from 'events';

const SESS_BASE = '/app/sessions';
const SESSIONS_DIR = path.join(process.cwd(), 'sessions');
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

export const bus = new EventEmitter();   // emite: qr, authenticated, ready, auth_failure, disconnected, message
const clients = new Map();
const statusOf = (id) => clients.get(id)?.status || 'offline';

// Ruta de Chromium en Docker (Railway)
const CHROME_PATH =
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  process.env.CHROME_PATH ||
  '/usr/bin/chromium';

export async function createSession(id) {
  if (clients.has(id)) return clients.get(id);

  console.log(`[createSession] ${id} -> chromium: ${CHROME_PATH}`);

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: id, dataPath: SESS_BASE }),
    puppeteer: {
      headless: true,
      executablePath: CHROME_PATH,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
        '--single-process',
        '--no-zygote',
        '--disable-features=site-per-process',
      ],
    },
    // Si quieres bajar el tiempo del primer QR, puedes cambiar a cache local:
    // webVersionCache: { type: 'local', path: path.join(process.cwd(), 'public', 'wa-web.html') },
    webVersionCache: {
      type: 'remote',
      remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
    },
    qrMaxRetries: 6,
  });

  const session = { client, status: 'initializing', info: null, me: null };
  clients.set(id, session);

  client.on('qr', async (qr) => {
    console.log(`[${id}] QR recibido (len=${qr?.length || 0})`);
    try {
      const qrDataUrl = await toDataURL(qr);
      session.status = 'qr';
      // Enviar a sockets
      bus.emit('qr', { id, qr: qrDataUrl });
    } catch (e) {
      console.error(`[${id}] Error generando dataURL del QR: ${e.message}`);
    }
  });

  client.on('authenticated', (info) => {
    session.status = 'authenticating';
    session.info = info || null;
    console.log(`[${id}] authenticated`);
    bus.emit('authenticated', { id, info });
      fireWebhook('authenticated', { id }); // <— NUEVO

  });

  client.on('ready', async () => {
    session.status = 'ready';
    try {
      // 1) intenta API
      let wid = null;
      try { wid = (await client.getMe())?.wid || null; } catch {}
      // 2) respaldo desde info interna
      if (!wid) wid = client?.info?.wid?._serialized || null;
      session.me = wid ? { wid } : null;
      console.log(`[${id}] ready como ${wid || 'desconocido'}`);
    } catch (e) {
      console.log(`[${id}] ready (sin me): ${e.message}`);
      session.me = null;
    }
    bus.emit('ready', { id, me: session.me });
  });

  client.on('auth_failure', (msg) => {
    session.status = 'auth_failure';
    console.error(`[${id}] auth_failure: ${msg}`);
    bus.emit('auth_failure', { id, msg });
  });

  client.on('disconnected', (reason) => {
    session.status = 'disconnected';
    console.warn(`[${id}] disconnected: ${reason}`);
    bus.emit('disconnected', { id, reason });
    client.destroy().catch(() => {});
    clients.delete(id);
  });

  client.on('message', (message) => {
    bus.emit('message', { id, message });
  });

  await client.initialize();
  return session;
}

export function listSessions() {
  return Array.from(clients.keys()).map((id) => ({
    id,
    status: statusOf(id),
    me: clients.get(id)?.me || null,
  }));
}

export async function getSession(id) {
  return clients.get(id) || null;
}

export async function deleteSession(id) {
  const s = clients.get(id);
  if (s) {
    try { await s.client.destroy(); } catch {}
    clients.delete(id);
  }
  // borra credenciales LocalAuth
  const dir = path.join(SESS_BASE, `session-${id}`);
  try { if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  return true;
}

export async function sendText(id, to, text) {
  const s = clients.get(id);
  if (!s || s.status !== 'ready') throw new Error('session_not_ready');
  const chatId = /\@\w+$/i.test(to) ? to : `${to.replace(/\D/g, '')}@c.us`;
  const r = await s.client.sendMessage(chatId, text);
  return r;
}

/* ---------- Restauración automática ---------- */

export function getSavedSessionIds() {
  if (!fs.existsSync(SESS_BASE)) return [];
  return fs.readdirSync(SESS_BASE)
    .filter((n) => n.startsWith('session-'))
    .map((n) => n.replace(/^session-/, ''));
}

export async function restoreAllSessions() {
  const ids = getSavedSessionIds();
  for (const id of ids) {
    try {
      console.log(`[restore] creando sesión restaurada: ${id}`);
      await createSession(id);
    } catch (e) {
      console.error(`[restore] fallo restaurar ${id}: ${e.message}`);
    }
  }
  return ids;
}
