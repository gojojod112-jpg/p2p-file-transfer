const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Public folder ki files serve karne ke liye
app.use(express.static(path.join(__dirname, 'public')));

io.on('connection', (socket) => {
  // Room join karna
  socket.on('join-room', (roomId) => {
    socket.join(roomId);
    socket.to(roomId).emit('user-connected', socket.id);
  });

  // WebRTC offer forward karna
  socket.on('offer', (data) => {
    socket.to(data.roomId).emit('offer', data);
  });

  // WebRTC answer forward karna
  socket.on('answer', (data) => {
    socket.to(data.roomId).emit('answer', data);
  });

  // ICE Candidate exchange karna
  socket.on('ice-candidate', (data) => {
    socket.to(data.roomId).emit('ice-candidate', data);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running at port ${PORT}`);
});
