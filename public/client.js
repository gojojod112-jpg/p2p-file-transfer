const socket = io({
  transports: ['websocket', 'polling']
});

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

const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun.relay.metered.ca:80' },
    {
      urls: 'turn:global.relay.metered.ca:80',
      username: 'cf2f73a9f9b2391f95501168',
      credential: '0u+I2IjWFllcLGu3',
    },
    {
      urls: 'turn:global.relay.metered.ca:80?transport=tcp',
      username: 'cf2f73a9f9b2391f95501168',
      credential: '0u+I2IjWFllcLGu3',
    },
    {
      urls: 'turn:global.relay.metered.ca:443',
      username: 'cf2f73a9f9b2391f95501168',
      credential: '0u+I2IjWFllcLGu3',
    },
    {
      urls: 'turns:global.relay.metered.ca:443?transport=tcp',
      username: 'cf2f73a9f9b2391f95501168',
      credential: '0u+I2IjWFllcLGu3',
    }
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

// Socket Connection Check
socket.on('connect', () => {
  updateStatus('Server Ready • Enter Room ID', 'pending');
});

socket.on('disconnect', () => {
  updateStatus('Server Disconnected (Reconnecting...)', 'error');
});

// 1. Join Room
connectBtn.addEventListener('click', () => {
  const room = roomInput.value.trim();
  if (!room) {
    alert('Please enter Room ID');
    return;
  }
  if (!socket.connected) {
    alert('Server se connection nahi bana hai, 2 second ruk kar try karo.');
    return;
  }

  currentRoom = room;
  if (activeRoomLabel) activeRoomLabel.innerText = room;
  if (copyRoomBtn) copyRoomBtn.style.display = 'inline-flex';

  socket.emit('join-room', currentRoom);
  updateStatus(`Joined Room ${room} • Waiting for peer...`, 'pending');
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
  updateStatus('Step 1/4: Peer found, sending Offer...', 'pending');
  createPeer(true);

  try {
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    socket.emit('signal', { room: currentRoom, signal: { offer } });
    updateStatus('Step 2/4: Offer sent, waiting for Answer...', 'pending');
  } catch (err) {
    updateStatus('Error at Offer: ' + err.message, 'error');
  }
});

// 3. Signaling Handler
socket.on('signal', async (signal) => {
  try {
    if (signal.offer) {
      updateStatus('Step 2/4: Offer received, sending Answer...', 'pending');
      createPeer(false);

      await peerConnection.setRemoteDescription(new RTCSessionDescription(signal.offer));
      while (iceCandidateQueue.length > 0) {
        await peerConnection.addIceCandidate(iceCandidateQueue.shift());
      }

      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      socket.emit('signal', { room: currentRoom, signal: { answer } });
      updateStatus('Step 3/4: Answer sent, negotiating network...', 'pending');

    } else if (signal.answer) {
      updateStatus('Step 3/4: Answer received, negotiating network...', 'pending');
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
    updateStatus('Signal Error: ' + err.message, 'error');
  }
});

function createPeer(isInitiator) {
  if (peerConnection) {
    peerConnection.close();
  }
  iceCandidateQueue = [];
  peerConnection = new RTCPeerConnection(rtcConfig);

  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('signal', { room: currentRoom, signal: { candidate: event.candidate } });
    }
  };

  peerConnection.oniceconnectionstatechange = () => {
    const iceState = peerConnection.iceConnectionState;
    updateStatus(`Step 4/4: Network ICE -> ${iceState}`, iceState === 'connected' || iceState === 'completed' ? 'connected' : 'pending');

    if (iceState === 'failed') {
      updateStatus('Failed: Network/Hotspot blocked P2P', 'error');
      sendBtn.disabled = true;
    } else if (iceState === 'disconnected' || iceState === 'closed') {
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
  channel.bufferedAmountLowThreshold = 2097152; // 2MB threshold

  channel.onopen = async () => {
    let mode = 'Connected & Ready';
    try {
      const stats = await peerConnection.getStats();
      stats.forEach((report) => {
        if (report.type === 'candidate-pair' && report.state === 'succeeded') {
          const localCand = stats.get(report.localCandidateId);
          if (localCand) {
            if (localCand.candidateType === 'host') {
              mode = 'Connected • Direct Wi-Fi (Max Speed)';
            } else if (localCand.candidateType === 'relay') {
              mode = 'Connected • Cloud Relay (TURN)';
            } else {
              mode = 'Connected • Direct P2P';
            }
          }
        }
      });
    } catch (e) {}

    updateStatus(mode, 'connected');
    if (fileInput.files.length > 0) sendBtn.disabled = false;
  };

  channel.onclose = () => {
    updateStatus('Disconnected', 'error');
    sendBtn.disabled = true;
  };

  channel.onmessage = handleReceiveMessage;
}

fileInput.addEventListener('change', () => {
  if (fileInput.files.length > 0) {
    const sizeMB = (fileInput.files[0].size / (1024 * 1024)).toFixed(2);
    fileLabel.innerText = `📄 ${fileInput.files[0].name} (${sizeMB} MB)`;
    if (dataChannel && dataChannel.readyState === 'open') {
      sendBtn.disabled = false;
    }
  }
});

function renderProgress(bytesDone, totalBytes, labelPrefix) {
  const percent = Math.min(100, Math.round((bytesDone / totalBytes) * 100));
  const elapsedSec = Math.max(0.1, (Date.now() - transferStartTime) / 1000);
  const mbps = (bytesDone / (1024 * 1024) / elapsedSec).toFixed(1);

  progressFill.style.width = percent + '%';
  if (progressStatus) progressStatus.innerText = `${labelPrefix}: ${percent}%`;
  if (speedText) speedText.innerText = `${mbps} MB/s`;
}

// Fast Transfer + Synced Percentage (256KB Chunks + 12MB Buffer)
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

  const chunkSize = 262144; // 256 KB
  const maxBuffer = 12582912; // 12 MB pipeline
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
      alert('File transferred successfully!');
      progressWrapper.style.display = 'none';
      progressFill.style.width = '0%';
      sendBtn.disabled = false;
    }, 300);

  } catch (err) {
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