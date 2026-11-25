const socket = io();

let peerConnection = null;
let dataChannel = null;
let currentRoom = '';
let iceCandidateQueue = [];

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

// Chat DOM Elements
const chatBox = document.getElementById('chatBox');
const chatPlaceholder = document.getElementById('chatPlaceholder');
const chatInput = document.getElementById('chatInput');
const chatSendBtn = document.getElementById('chatSendBtn');

const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' }
  ]
};

function updateStatus(text, state) {
  statusText.innerText = text;
  if (state === 'connected') {
    statusDot.classList.add('connected');
    chatInput.disabled = false;
    chatSendBtn.disabled = false;
  } else {
    statusDot.classList.remove('connected');
    chatInput.disabled = true;
    chatSendBtn.disabled = true;
  }
}

// 1. Join Room
connectBtn.addEventListener('click', () => {
  const room = roomInput.value.trim();
  if (!room) {
    alert('Please enter Room ID');
    return;
  }
  currentRoom = room;
  socket.emit('join-room', currentRoom);
  updateStatus('Waiting for peer in room...', 'pending');
});

// 2. Caller Side
socket.on('user-connected', async () => {
  updateStatus('Peer found. Handshaking...', 'pending');
  createPeer(true);

  try {
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    socket.emit('signal', { room: currentRoom, signal: { offer } });
  } catch (err) {
    console.error('Error creating offer:', err);
  }
});

// 3. Signaling Handler
socket.on('signal', async (signal) => {
  if (signal.offer) {
    updateStatus('Connecting with peer...', 'pending');
    createPeer(false);

    await peerConnection.setRemoteDescription(new RTCSessionDescription(signal.offer));
    
    while (iceCandidateQueue.length > 0) {
      const cand = iceCandidateQueue.shift();
      await peerConnection.addIceCandidate(cand);
    }

    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    socket.emit('signal', { room: currentRoom, signal: { answer } });

  } else if (signal.answer) {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(signal.answer));
    
    while (iceCandidateQueue.length > 0) {
      const cand = iceCandidateQueue.shift();
      await peerConnection.addIceCandidate(cand);
    }

  } else if (signal.candidate) {
    const candidate = new RTCIceCandidate(signal.candidate);
    if (peerConnection && peerConnection.remoteDescription) {
      await peerConnection.addIceCandidate(candidate);
    } else {
      iceCandidateQueue.push(candidate);
    }
  }
});

function createPeer(isInitiator) {
  peerConnection = new RTCPeerConnection(rtcConfig);

  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('signal', { room: currentRoom, signal: { candidate: event.candidate } });
    }
  };

  peerConnection.onconnectionstatechange = () => {
    if (peerConnection.connectionState === 'connected') {
      updateStatus('Connected & Ready', 'connected');
      if (fileInput.files.length > 0) sendBtn.disabled = false;
    } else if (['disconnected', 'failed', 'closed'].includes(peerConnection.connectionState)) {
      updateStatus('Disconnected', 'error');
      sendBtn.disabled = true;
    }
  };

  if (isInitiator) {
    dataChannel = peerConnection.createDataChannel('fileTransfer');
    setupDataChannel(dataChannel);
  } else {
    peerConnection.ondatachannel = (event) => {
      dataChannel = event.channel;
      setupDataChannel(dataChannel);
    };
  }
}

function setupDataChannel(channel) {
  channel.binaryType = 'arraybuffer';
  // 1MB low threshold taaki pipe kabhi dry na ho
  channel.bufferedAmountLowThreshold = 1048576;

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

// File Input
fileInput.addEventListener('change', () => {
  if (fileInput.files.length > 0) {
    const sizeMB = (fileInput.files[0].size / (1024 * 1024)).toFixed(2);
    fileLabel.innerText = `📄 ${fileInput.files[0].name} (${sizeMB} MB)`;
    if (dataChannel && dataChannel.readyState === 'open') {
      sendBtn.disabled = false;
    }
  }
});

// HIGH-SPEED: Large File Sending Logic (64KB Chunks + 4MB Pipeline)
sendBtn.addEventListener('click', async () => {
  const file = fileInput.files[0];
  if (!file || !dataChannel || dataChannel.readyState !== 'open') return;

  progressWrapper.style.display = 'block';
  sendBtn.disabled = true;

  dataChannel.send(JSON.stringify({
    type: 'metadata',
    name: file.name,
    size: file.size,
    mime: file.type
  }));

  const chunkSize = 65536; // 64 KB (4x faster than 16 KB)
  const maxBuffer = 4194304; // 4 MB buffer pipeline
  let offset = 0;
  let lastUiUpdate = 0;

  try {
    while (offset < file.size) {
      if (dataChannel.bufferedAmount > maxBuffer) {
        await new Promise((resolve) => {
          dataChannel.onbufferedamountlow = () => {
            dataChannel.onbufferedamountlow = null;
            resolve();
          };
        });
      }

      const slice = file.slice(offset, offset + chunkSize);
      const buffer = await slice.arrayBuffer();
      dataChannel.send(buffer);
      offset += buffer.byteLength;

      // Har chunk par DOM update karne ke bajay har 100ms par UI update karo
      const now = Date.now();
      if (now - lastUiUpdate > 100 || offset >= file.size) {
        const percent = Math.min(100, Math.round((offset / file.size) * 100));
        progressFill.style.width = percent + '%';
        progressText.innerText = `Sending: ${percent}%`;
        lastUiUpdate = now;
      }
    }

    setTimeout(() => {
      alert('File sent successfully!');
      progressWrapper.style.display = 'none';
      progressFill.style.width = '0%';
      sendBtn.disabled = false;
    }, 300);

  } catch (err) {
    console.error('Transfer failed:', err);
    alert('Transfer interrupted!');
    sendBtn.disabled = false;
  }
});

// Chat Functions
function appendMessage(text, sender) {
  if (chatPlaceholder) chatPlaceholder.style.display = 'none';
  const msgDiv = document.createElement('div');
  msgDiv.classList.add('msg', sender);
  msgDiv.textContent = text;
  chatBox.appendChild(msgDiv);
  chatBox.scrollTop = chatBox.scrollHeight;
}

function sendChatMessage() {
  const text = chatInput.value.trim();
  if (!text || !dataChannel || dataChannel.readyState !== 'open') return;

  dataChannel.send(JSON.stringify({ type: 'chat', text }));
  appendMessage(text, 'me');
  chatInput.value = '';
}

chatSendBtn.addEventListener('click', sendChatMessage);
chatInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') sendChatMessage();
});

// Receiving Logic (Handles both Chat & Large Files)
function handleReceiveMessage(event) {
  if (typeof event.data === 'string') {
    const data = JSON.parse(event.data);
    
    if (data.type === 'metadata') {
      incomingFileInfo = data;
      receiveBuffer = [];
      receivedSize = 0;
      progressWrapper.style.display = 'block';
    } else if (data.type === 'chat') {
      appendMessage(data.text, 'peer');
    }
    return;
  }

  // Binary File Chunks
  receiveBuffer.push(event.data);
  receivedSize += event.data.byteLength;

  if (incomingFileInfo) {
    const percent = Math.min(100, Math.round((receivedSize / incomingFileInfo.size) * 100));
    progressFill.style.width = percent + '%';
    progressText.innerText = `Receiving: ${percent}%`;

    if (receivedSize >= incomingFileInfo.size) {
      const receivedBlob = new Blob(receiveBuffer, { type: incomingFileInfo.mime });
      const downloadLink = document.createElement('a');
      downloadLink.href = URL.createObjectURL(receivedBlob);
      downloadLink.download = incomingFileInfo.name;
      document.body.appendChild(downloadLink);
      downloadLink.click();
      downloadLink.remove();

      // Free memory
      setTimeout(() => URL.revokeObjectURL(downloadLink.href), 10000);
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