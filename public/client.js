const socket = io();

let peerConnection = null;
let dataChannel = null;
let currentRoom = '';
let iceCandidateQueue = [];

// File Receive & Sync State
let receiveArray = null;
let receivedSize = 0;
let incomingFileInfo = null;
let transferStartTime = 0;
let lastAckPercent = 0;
let onTransferCompleteAck = null;

// DOM Elements
const roomInput = document.getElementById('roomInput');
const connectBtn = document.getElementById('connectBtn');
const copyRoomBtn = document.getElementById('copyRoomBtn');
const activeRoomLabel = document.getElementById('activeRoomLabel');
const statusText = document.getElementById('statusText');
const statusDot = document.getElementById('statusDot');
const fileInput = document.getElementById('fileInput');
const fileLabel = document.getElementById('fileLabel');
const sendBtn = document.getElementById('sendBtn');
const progressWrapper = document.getElementById('progressWrapper');
const progressFill = document.getElementById('progressFill');
const progressStatus = document.getElementById('progressStatus');
const speedText = document.getElementById('speedText');

// Chat DOM Elements
const chatBox = document.getElementById('chatBox');
const chatPlaceholder = document.getElementById('chatPlaceholder');
const chatInput = document.getElementById('chatInput');
const chatSendBtn = document.getElementById('chatSendBtn');

// Clean, reliable STUN + OpenRelay config (No broken credentials)
const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun.relay.metered.ca:80' }
  ],
  iceCandidatePoolSize: 10
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

connectBtn.addEventListener('click', () => {
  const room = roomInput.value.trim();
  if (!room) {
    alert('Please enter Room ID');
    return;
  }

  // Purana connection aur queue saaf karo
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }
  iceCandidateQueue = [];
  dataChannel = null;

  currentRoom = room;
  if (activeRoomLabel) activeRoomLabel.innerText = room;
  if (copyRoomBtn) copyRoomBtn.style.display = 'inline-flex';
  
  socket.emit('join-room', currentRoom);
  updateStatus('Waiting for peer in room...', 'pending');
});

roomInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') connectBtn.click();
});

if (copyRoomBtn) {
  copyRoomBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(currentRoom);
    activeRoomLabel.innerText = currentRoom + ' (Copied!)';
    setTimeout(() => { activeRoomLabel.innerText = currentRoom; }, 1500);
  });
}

// 2. Caller Side (Jab doosra user room join kare)
socket.on('user-connected', async () => {
  updateStatus('Peer found. Handshaking...', 'pending');
  createPeer(true);

  try {
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    socket.emit('signal', { room: currentRoom, signal: { offer } });
  } catch (err) {
    console.error('Offer error:', err);
    updateStatus('Handshake failed (Offer)', 'error');
  }
});

// 3. Signaling Handler
socket.on('signal', async (signal) => {
  try {
    if (signal.offer) {
      updateStatus('Connecting with peer...', 'pending');
      createPeer(false);

      await peerConnection.setRemoteDescription(new RTCSessionDescription(signal.offer));
      while (iceCandidateQueue.length > 0) {
        await peerConnection.addIceCandidate(iceCandidateQueue.shift());
      }

      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      socket.emit('signal', { room: currentRoom, signal: { answer } });

    } else if (signal.answer) {
      if (!peerConnection) return;
      await peerConnection.setRemoteDescription(new RTCSessionDescription(signal.answer));
      while (iceCandidateQueue.length > 0) {
        await peerConnection.addIceCandidate(iceCandidateQueue.shift());
      }

    } else if (signal.candidate) {
      const candidate = new RTCIceCandidate(signal.candidate);
      if (peerConnection && peerConnection.remoteDescription) {
        await peerConnection.addIceCandidate(candidate);
      } else {
        iceCandidateQueue.push(candidate);
      }
    }
  } catch (err) {
    console.error('Signaling error:', err);
  }
});

socket.on('user-disconnected', () => {
  updateStatus('Peer left the room', 'error');
  sendBtn.disabled = true;
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }
});

function createPeer(isInitiator) {
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }
  iceCandidateQueue = [];
  dataChannel = null;

  peerConnection = new RTCPeerConnection(rtcConfig);

  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('signal', { room: currentRoom, signal: { candidate: event.candidate } });
    }
  };

  peerConnection.oniceconnectionstatechange = () => {
    const state = peerConnection.iceConnectionState;
    if (state === 'failed') {
      updateStatus('Connection failed (Different Network / NAT blocked)', 'error');
      sendBtn.disabled = true;
    } else if (state === 'disconnected' || state === 'closed') {
      updateStatus('Disconnected', 'error');
      sendBtn.disabled = true;
    }
  };

  if (isInitiator) {
    dataChannel = peerConnection.createDataChannel('airlink');
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
  channel.bufferedAmountLowThreshold = 1048576; // 1MB

  channel.onopen = async () => {
    let routeType = 'Ready';
    try {
      const stats = await peerConnection.getStats();
      stats.forEach((report) => {
        if (report.type === 'candidate-pair' && report.state === 'succeeded') {
          const localCand = stats.get(report.localCandidateId);
          if (localCand && localCand.candidateType === 'host') {
            routeType = 'Direct Wi-Fi / Hotspot';
          } else {
            routeType = 'Internet P2P';
          }
        }
      });
    } catch (e) {}

    updateStatus(`Connected (${routeType})`, 'connected');
    if (fileInput.files.length > 0) sendBtn.disabled = false;
  };

  channel.onclose = () => {
    updateStatus('Disconnected', 'error');
    sendBtn.disabled = true;
  };

  channel.onerror = (err) => {
    console.error('DataChannel error:', err);
  };

  channel.onmessage = handleReceiveMessage;
}

// File Input Selection
fileInput.addEventListener('change', () => {
  if (fileInput.files.length > 0) {
    const sizeMB = (fileInput.files[0].size / (1024 * 1024)).toFixed(2);
    fileLabel.innerText = `📄 ${fileInput.files[0].name} (${sizeMB} MB)`;
    if (dataChannel && dataChannel.readyState === 'open') {
      sendBtn.disabled = false;
    }
  }
});

// UI Progress Updater
function renderProgress(bytesDone, totalBytes, labelPrefix) {
  const percent = Math.min(100, Math.round((bytesDone / totalBytes) * 100));
  const elapsedSec = Math.max(0.1, (Date.now() - transferStartTime) / 1000);
  const mbps = (bytesDone / (1024 * 1024) / elapsedSec).toFixed(1);

  progressFill.style.width = percent + '%';
  if (progressStatus) progressStatus.innerText = `${labelPrefix}: ${percent}%`;
  if (speedText) speedText.innerText = `${mbps} MB/s`;
}

// High-Speed File Sender (128KB chunks + 8MB buffer + ACK Sync)
sendBtn.addEventListener('click', async () => {
  const file = fileInput.files[0];
  if (!file || !dataChannel || dataChannel.readyState !== 'open') return;

  progressWrapper.style.display = 'block';
  sendBtn.disabled = true;
  transferStartTime = Date.now();
  renderProgress(0, file.size, 'Sending');

  dataChannel.send(JSON.stringify({
    type: 'metadata',
    name: file.name,
    size: file.size,
    mime: file.type
  }));

  const chunkSize = 131072; // 128 KB
  const maxBuffer = 8388608; // 8 MB pipeline
  let offset = 0;

  const ackDonePromise = new Promise((resolve) => {
    onTransferCompleteAck = resolve;
  });

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
    }

    await ackDonePromise;

    setTimeout(() => {
      alert('File transferred & verified on both devices!');
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

// Receiver Logic
function handleReceiveMessage(event) {
  if (typeof event.data === 'string') {
    const data = JSON.parse(event.data);

    if (data.type === 'metadata') {
      incomingFileInfo = data;
      receiveArray = new Uint8Array(data.size);
      receivedSize = 0;
      lastAckPercent = 0;
      transferStartTime = Date.now();
      progressWrapper.style.display = 'block';
      renderProgress(0, data.size, 'Receiving');
    } else if (data.type === 'ack') {
      renderProgress(data.bytes, data.total, 'Sending');
      if (data.done && onTransferCompleteAck) {
        onTransferCompleteAck();
        onTransferCompleteAck = null;
      }
    } else if (data.type === 'chat') {
      appendMessage(data.text, 'peer');
    }
    return;
  }

  if (!incomingFileInfo || !receiveArray) return;

  const chunkBytes = new Uint8Array(event.data);
  receiveArray.set(chunkBytes, receivedSize);
  receivedSize += chunkBytes.byteLength;

  const currentPercent = Math.min(100, Math.round((receivedSize / incomingFileInfo.size) * 100));
  renderProgress(receivedSize, incomingFileInfo.size, 'Receiving');

  if (currentPercent - lastAckPercent >= 2 || receivedSize >= incomingFileInfo.size) {
    lastAckPercent = currentPercent;
    const isDone = receivedSize >= incomingFileInfo.size;
    if (dataChannel && dataChannel.readyState === 'open') {
      dataChannel.send(JSON.stringify({
        type: 'ack',
        bytes: receivedSize,
        total: incomingFileInfo.size,
        done: isDone
      }));
    }
  }

  if (receivedSize >= incomingFileInfo.size) {
    const receivedBlob = new Blob([receiveArray], { type: incomingFileInfo.mime });
    const downloadLink = document.createElement('a');
    downloadLink.href = URL.createObjectURL(receivedBlob);
    downloadLink.download = incomingFileInfo.name;
    document.body.appendChild(downloadLink);
    downloadLink.click();
    downloadLink.remove();

    setTimeout(() => URL.revokeObjectURL(downloadLink.href), 10000);
    receiveArray = null;
    receivedSize = 0;
    incomingFileInfo = null;

    setTimeout(() => {
      progressWrapper.style.display = 'none';
      progressFill.style.width = '0%';
    }, 1000);
  }
}