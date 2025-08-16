import { bus, listSessions } from './connections.js';

export function bindSocket(io) {
  io.on('connection', (socket) => {
    socket.emit('sessions', listSessions());

    socket.on('join', (sessionId) => {
      socket.join(sessionId);
    });

    for (const ev of ['qr','authenticated','ready','auth_failure','disconnected','message']) {
      bus.on(ev, (payload) => {
        const { id } = payload;
        io.to(id).emit(ev, payload);
      });
    }
  });
}
