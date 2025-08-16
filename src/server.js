import express from 'express';
import cors from 'cors';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';
import {
  createSession, listSessions, getSession, deleteSession, sendText
} from './connections.js';
import { bindSocket } from './events.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const PUBLIC_DIR = path.join(process.cwd(), 'public');
app.use(express.static(PUBLIC_DIR));

app.get('/api/sessions', (req, res) => {
  res.json({ ok: true, data: listSessions() });
});

app.post('/api/sessions', async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ ok:false, error:'missing_id' });
    const session = await createSession(id);
    res.json({ ok: true, status: session.status });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message });
  }
});

app.get('/api/sessions/:id', async (req, res) => {
  const s = await getSession(req.params.id);
  if (!s) return res.status(404).json({ ok:false, error:'not_found' });
  res.json({ ok:true, status: s.status, me: s.me || null });
});

app.delete('/api/sessions/:id', async (req, res) => {
  await deleteSession(req.params.id);
  res.json({ ok:true });
});

app.post('/api/sessions/:id/messages', async (req, res) => {
  const { to, text } = req.body;
  if (!to || !text) return res.status(400).json({ ok:false, error:'missing_fields' });
  try {
    const result = await sendText(req.params.id, to, text);
    res.json({ ok:true, data: result.id._serialized });
  } catch (e) {
    res.status(400).json({ ok:false, error: e.message });
  }
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
bindSocket(io);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('WA Connections listening on :' + PORT);
});
