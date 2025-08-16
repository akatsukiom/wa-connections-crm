import express from 'express';
import cors from 'cors';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';
import {
  createSession,
  listSessions,
  getSession,
  deleteSession,
  sendText,
  restoreAllSessions,
} from './connections.js';

// Server base
const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Static (panel)
const PUBLIC_DIR = path.join(process.cwd(), 'public');
app.use(express.static(PUBLIC_DIR));

// REST API
app.get('/api/sessions', (req, res) => {
  res.json({ ok: true, data: listSessions() });
});

app.post('/api/sessions', async (req, res) => {
  try {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ ok: false, error: 'missing_id' });
    const s = await createSession(id);
    res.json({ ok: true, status: s.status });
  } catch (e) {
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

app.post('/api/sessions/:id/messages', async (req, res) => {
  const { to, text } = req.body || {};
  if (!to || !text) return res.status(400).json({ ok: false, error: 'missing_fields' });
  try {
    const result = await sendText(req.params.id, to, text);
    res.json({ ok: true, data: result.id._serialized });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// HTTP + Socket.io
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Enlazar bus de eventos a sockets
import { bus } from './connections.js';
io.on('connection', (socket) => {
  // enviar sesiones existentes al conectar
  socket.emit('sessions', listSessions());

  socket.on('join', (sessionId) => {
    socket.join(sessionId);
  });

  // Emitir a room y también broadcast (por si el cliente no se unió aún)
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

// (Opcional) Precalentar una sesión si defines AUTO_SESSION_ID en variables
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
