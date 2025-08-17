// src/server.js
import express from 'express';
import cors from 'cors';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';
import multer from 'multer';

import {
  createSession,
  listSessions,
  getSession,
  deleteSession,
  sendText,
  sendMedia,
  restoreAllSessions,
  revokeMessage,
} from './connections.js';

// ---------- Server base ----------
const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: '10mb' })); // un poco más grande por si mandas base64/preview

// Static (panel opcional)
const PUBLIC_DIR = path.join(process.cwd(), 'public');
app.use(express.static(PUBLIC_DIR));

// Multer en memoria (no escribe a disco)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
});

// ---------- REST API ----------
app.get('/api/health', (_req, res) =>
  res.json({ ok: true, name: 'wa-connections', ts: Date.now() })
);

app.get('/api/sessions', (_req, res) => {
  res.json({ ok: true, data: listSessions() });
});

app.post('/api/sessions', async (req, res) => {
  try {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ ok: false, error: 'missing_id' });
    const s = await createSession(id);
    res.json({ ok: true, status: s.status });
  } catch (e) {
    console.error('create session error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/sessions/:id', async (req, res) => {
  const s = await getSession(req.params.id);
  if (!s) return res.status(404).json({ ok: false, error: 'not_found' });
  res.json({ ok: true, status: s.status, me: s.me || null });
});

app.delete('/api/sessions/:id', async (req, res) => {
  await deleteSession(req.params.id);
  res.json({ ok: true });
});

// ----- Enviar TEXTO (devuelve id serializado y chatId) -----
app.post('/api/sessions/:id/messages', async (req, res) => {
  try {
    const { to, text } = req.body || {};
    if (!to || !text) {
      return res.status(400).json({ ok: false, error: 'missing_fields' });
    }
    const msg = await sendText(req.params.id, to, text);
    const messageId = msg?.id?._serialized || null;
    const chatId = msg?.from || `${String(to).replace(/\D/g, '')}@c.us`;
    res.json({ ok: true, id: messageId, chatId });
  } catch (e) {
    console.error('text error:', e);
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ----- Enviar MEDIA (imagen / video / doc / audio / PTT) -----
app.post('/api/sessions/:id/media', upload.single('file'), async (req, res) => {
  try {
    const { id } = req.params;
    const { to, asVoice, caption } = req.body || {};
    if (!to || !req.file) {
      return res.status(400).json({ ok: false, error: 'missing_to_or_file' });
    }

    const out = await sendMedia(
      id,
      to,
      req.file.buffer,
      req.file.mimetype,
      req.file.originalname || 'file',
      { asVoice: !!asVoice, caption: caption || '' }
    );

    res.json({
      ok: true,
      id: out?.id?._serialized || null,
      chatId: out?.from || `${String(to).replace(/\D/g, '')}@c.us`,
      mime: req.file.mimetype,
      fileName: req.file.originalname || 'file',
    });
  } catch (e) {
    // Si ves “Evaluation failed: b” aquí, el fallback de sendMedia lo cubre reenviando como documento.
    console.error('media error', e);
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ----- “Eliminar para todos” (revoke) -----
app.post('/api/sessions/:id/messages/revoke', async (req, res) => {
  try {
    const { chatId, messageId } = req.body || {};
    if (!chatId || !messageId) {
      return res.status(400).json({ ok: false, error: 'chatId and messageId required' });
    }
    const out = await revokeMessage(req.params.id, chatId, messageId);
    res.json({ ok: true, ...out });
  } catch (e) {
    console.error('revoke error', e);
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

// ---------- HTTP + Socket.io ----------
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Eventos → sockets
import { bus } from './connections.js';
io.on('connection', (socket) => {
  socket.emit('sessions', listSessions());
  socket.on('join', (sessionId) => socket.join(sessionId));

  const forward = (ev) => (payload) => {
    const { id } = payload || {};
    if (id) io.to(id).emit(ev, payload);
    io.emit(ev, payload);
  };
  for (const ev of ['qr', 'authenticated', 'ready', 'auth_failure', 'disconnected', 'message']) {
    bus.on(ev, forward(ev));
  }
});

// Restaurar sesiones guardadas al arrancar
restoreAllSessions()
  .then((ids) => console.log('Sesiones restauradas:', ids))
  .catch((e) => console.error('Restore error:', e));

// (Opcional) Precalentar una sesión
const autoId = process.env.AUTO_SESSION_ID;
if (autoId) {
  createSession(autoId)
    .then(() => console.log(`Auto session inicializada: ${autoId}`))
    .catch((e) => console.error('Auto session error:', e.message));
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('WA Connections listening on :' + PORT);
});
