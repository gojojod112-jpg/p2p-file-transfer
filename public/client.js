const socket = io();

let localConnection;
let sendChannel;
let receiveBuffer = [];
let receivedSize = 0;
let incomingFileInfo = null;

// DOM Elements
const roomInput = document.getElementById('roomInput');
const connectBtn = document.getElementById('connectBtn');
const statusText = document.getElementById('statusText');
const statusDot = document.getElementById('statusDot');
const fileInput = document.getElementById('fileInput');
const fileLabel = document.getElementById('fileLabel');
const sendBtn = document.getElementById('sendBtn');
const progressWrapper = document.getElementById('progressWrapper');
const progressFill = document.getElementById('progressFill');
const progressText = document.getElementById('progressText');

let currentRoom = '';

// ICE Servers (Crucial for Mobile-to-Laptop & cross-network)
const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

// 1. Join Room
connectBtn.addEventListener('click', () => {
  const room = roomInput.value.trim();
  if (!room) {
    alert('Please enter a Room ID');
    return;
  }
  currentRoom = room;
  socket.emit('join-room', room);
  updateStatus('Joining room...', 'pending');
});

// 2. Peer signaling
socket.on('user-connected', async () => {
  updateStatus('Peer found. Connecting...', 'pending');
  createPeerConnection();

  sendChannel = localConnection.createDataChannel('fileTransfer');
  setupDataChannel(sendChannel);

  const offer = await localConnection.createOffer();
  await localConnection.setLocalDescription(offer);
  socket.emit('signal', { room: currentRoom, signal: { type: 'offer', sdp: offer } });
});

socket.on('signal', async (data) => {
  const { signal } = data;

  if (signal.type === 'offer') {
    createPeerConnection();

    localConnection.ondatachannel = (event) => {
      sendChannel = event.channel;
      setupDataChannel(sendChannel);
    };

    await localConnection.setRemoteDescription(new RTCSessionDescription(signal.sdp));
    const answer = await localConnection.createAnswer();
    await localConnection.setLocalDescription(answer);
    socket.emit('signal', { room: currentRoom, signal: { type: 'answer', sdp: answer } });
  } else if (signal.type === 'answer') {
    await localConnection.setRemoteDescription(new RTCSessionDescription(signal.sdp));
  } else if (signal.candidate) {
    try {
      if (localConnection) {
        await localConnection.addIceCandidate(new RTCIceCandidate(signal.candidate));
      }
    } catch (err) {
      console.error('Error adding ICE candidate:', err);
    }
  }
});

function createPeerConnection() {
  localConnection = new RTCPeerConnection(rtcConfig);

  localConnection.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('signal', { room: currentRoom, signal: { candidate: event.candidate } });
    }
  };

  localConnection.onconnectionstatechange = () => {
    if (localConnection.connectionState === 'connected') {
      updateStatus('Connected & Ready', 'connected');
      if (fileInput.files.length > 0) sendBtn.disabled = false;
    } else if (localConnection.connectionState === 'disconnected' || localConnection.connectionState === 'failed') {
      updateStatus('Disconnected', 'error');
      sendBtn.disabled = true;
    }
  };
}

function setupDataChannel(channel) {
  channel.binaryType = 'arraybuffer';

  channel.onopen = () => {
    updateStatus('Connected & Ready', 'connected');
    if (fileInput.files.length > 0) sendBtn.disabled = false;
  };

  channel.onclose = () => {
    updateStatus('Disconnected', 'error');
    sendBtn.disabled = true;
  };

  channel.onmessage = handleReceiveMessage;
}

// 3. File Selection & Transfer
fileInput.addEventListener('change', () => {
  if (fileInput.files.length > 0) {
    fileLabel.innerText = '📄 ' + fileInput.files[0].name;
    if (localConnection && localConnection.connectionState === 'connected') {
      sendBtn.disabled = false;
    }
  }
});

sendBtn.addEventListener('click', () => {
  const file = fileInput.files[0];
  if (!file) return;

  progressWrapper.style.display = 'block';
  sendBtn.disabled = true;

  // Send metadata first
  sendChannel.send(JSON.stringify({
    type: 'metadata',
    name: file.name,
    size: file.size,
    mime: file.type
  }));

  // Chunking (16KB chunks)
  const chunkSize = 16384;
  let offset = 0;
  const reader = new FileReader();

  reader.onload = (e) => {
    sendChannel.send(e.target.result);
    offset += e.target.result.byteLength;

    const percent = Math.min(100, Math.round((offset / file.size) * 100));
    progressFill.style.width = percent + '%';
    progressText.innerText = percent + '%';

    if (offset < file.size) {
      readSlice(offset);
    } else {
      setTimeout(() => {
        alert('File sent successfully!');
        progressWrapper.style.display = 'none';
        progressFill.style.width = '0%';
        sendBtn.disabled = false;
      }, 500);
    }
  };

  const readSlice = (o) => {
    const slice = file.slice(o, o + chunkSize);
    reader.readAsArrayBuffer(slice);
  };

  readSlice(0);
});

// 4. File Receiver Logic
function handleReceiveMessage(event) {
  if (typeof event.data === 'string') {
    const meta = JSON.parse(event.data);
    if (meta.type === 'metadata') {
      incomingFileInfo = meta;
      receiveBuffer = [];
      receivedSize = 0;
      progressWrapper.style.display = 'block';
    }
    return;
  }

  // Binary data chunk
  receiveBuffer.push(event.data);
  receivedSize += event.data.byteLength;

  if (incomingFileInfo) {
    const percent = Math.min(100, Math.round((receivedSize / incomingFileInfo.size) * 100));
    progressFill.style.width = percent + '%';
    progressText.innerText = percent + '%';

    if (receivedSize >= incomingFileInfo.size) {
      const receivedBlob = new Blob(receiveBuffer, { type: incomingFileInfo.mime });
      downloadBlob(receivedBlob, incomingFileInfo.name);

      receiveBuffer = [];
      receivedSize = 0;
      incomingFileInfo = null;
      setTimeout(() => {
        progressWrapper.style.display = 'none';
        progressFill.style.width = '0%';
      }, 1000);
    }
  }
}

function downloadBlob(blob, filename) {
  const downloadLink = document.createElement('a');
  downloadLink.href = URL.createObjectURL(blob);
  downloadLink.download = filename;
  document.body.appendChild(downloadLink);
  downloadLink.click();
  downloadLink.remove();
}

function updateStatus(text, state) {
  statusText.innerText = text;
  if (state === 'connected') {
    statusDot.classList.add('connected');
  } else {
    statusDot.classList.remove('connected');
  }
}