// ✅ compatible con ESM
import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import { toDataURL } from 'qrcode';
import fs from 'fs';
import path from 'path';
import EventEmitter from 'events';

const SESSIONS_DIR = path.join(process.cwd(), 'sessions');
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR);

export const bus = new EventEmitter(); // emite: qr, ready, authenticated, message, etc.

const clients = new Map();
const statusOf = id => clients.get(id)?.status || 'offline';

export async function createSession(id) {
  if (clients.has(id)) return clients.get(id);

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: id, dataPath: '/app/sessions' }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu']
    }
  });

  const session = { client, status: 'initializing', info: null };
  clients.set(id, session);

  client.on('qr', async (qr) => {
    const qrDataUrl = await toDataURL(qr);
    session.status = 'qr';
    bus.emit('qr', { id, qr: qrDataUrl });
  });

  client.on('authenticated', (info) => {
    session.status = 'authenticating';
    session.info = info || null;
    bus.emit('authenticated', { id, info });
  });

  client.on('ready', async () => {
    session.status = 'ready';
    try {
      session.me = await client.getMe();
    } catch {}
    bus.emit('ready', { id, me: session.me || null });
  });

  client.on('auth_failure', (msg) => {
    session.status = 'auth_failure';
    bus.emit('auth_failure', { id, msg });
  });

  client.on('disconnected', (reason) => {
    session.status = 'disconnected';
    bus.emit('disconnected', { id, reason });
    client.destroy().catch(()=>{});
    clients.delete(id);
  });

  client.on('message', (message) => {
    bus.emit('message', { id, message });
  });

  await client.initialize();
  return session;
}

export function listSessions() {
  return Array.from(clients.keys()).map(id => ({
    id,
    status: statusOf(id),
    me: clients.get(id)?.me || null
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
  const dir = path.join(SESSIONS_DIR, `session-${id}`);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

export async function sendText(id, to, text) {
  const s = clients.get(id);
  if (!s || s.status !== 'ready') throw new Error('session_not_ready');
  const chatId = /\@\w+$/i.test(to) ? to : `${to.replace(/\D/g,'')}@c.us`;
  return s.client.sendMessage(chatId, text);
}
