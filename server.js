const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3001;
const wss = new WebSocketServer({ port: PORT });

// Maps room codes to array of client connections
// roomCode -> Array of client objects { id, ws }
const rooms = new Map();

console.log(`WebSocket signaling server started on port ${PORT}`);

wss.on('connection', (ws) => {
  let currentRoom = null;
  let clientId = null;

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      
      switch (data.type) {
        case 'create-room': {
          // Generate a unique 6-digit code
          let code;
          do {
            code = Math.floor(100000 + Math.random() * 900000).toString();
          } while (rooms.has(code));

          clientId = 'sender-' + Math.random().toString(36).substring(2, 9);
          rooms.set(code, [{ id: clientId, ws }]);
          currentRoom = code;
          
          ws.send(JSON.stringify({ type: 'room-created', code, clientId }));
          console.log(`Room ${code} created by client ${clientId}`);
          break;
        }

        case 'join-room': {
          const { code } = data;
          if (!rooms.has(code)) {
            ws.send(JSON.stringify({ type: 'error', message: 'Room not found or expired' }));
            return;
          }

          const roomClients = rooms.get(code);
          if (roomClients.length >= 2) {
            ws.send(JSON.stringify({ type: 'error', message: 'Room is full' }));
            return;
          }

          clientId = 'receiver-' + Math.random().toString(36).substring(2, 9);
          roomClients.push({ id: clientId, ws });
          currentRoom = code;

          ws.send(JSON.stringify({ type: 'room-joined', code, clientId }));
          
          // Notify the creator (sender) that receiver joined
          const creator = roomClients[0];
          creator.ws.send(JSON.stringify({ type: 'peer-joined', peerId: clientId }));
          console.log(`Client ${clientId} joined Room ${code}`);
          break;
        }

        case 'signal': {
          if (!currentRoom || !rooms.has(currentRoom)) return;
          const roomClients = rooms.get(currentRoom);
          
          // Forward signal to the other client in the room
          const recipient = roomClients.find(client => client.id !== clientId);
          if (recipient) {
            recipient.ws.send(JSON.stringify({
              type: 'signal',
              signal: data.signal,
              senderId: clientId
            }));
          }
          break;
        }

        default:
          console.warn('Unknown message type:', data.type);
      }
    } catch (err) {
      console.error('Error handling WebSocket message:', err);
    }
  });

  ws.on('close', () => {
    if (currentRoom && rooms.has(currentRoom)) {
      const roomClients = rooms.get(currentRoom);
      const remainingClients = roomClients.filter(client => client.id !== clientId);
      
      if (remainingClients.length === 0) {
        rooms.delete(currentRoom);
        console.log(`Room ${currentRoom} destroyed (empty)`);
      } else {
        rooms.set(currentRoom, remainingClients);
        // Notify the remaining peer that their partner left
        remainingClients.forEach(client => {
          client.ws.send(JSON.stringify({ type: 'peer-left' }));
        });
        console.log(`Client ${clientId} left Room ${currentRoom}`);
      }
    }
  });
});
