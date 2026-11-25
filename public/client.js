const socket = io();

const NUM_CHANNELS = 4; // 4 parallel WebRTC channels for maximum throughput
let peerConnection = null;
let dataChannels = [];
let openChannelsCount = 0;
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
  activeRoomLabel.innerText = room;
  copyRoomBtn.style.display = 'inline-flex';
  socket.emit('join-room', currentRoom);
  updateStatus('Waiting for peer in room...', 'pending');
});

roomInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') connectBtn.click();
});

copyRoomBtn.addEventListener('click', () => {
  navigator.clipboard.writeText(currentRoom);
  activeRoomLabel.innerText = currentRoom + ' (Copied!)';
  setTimeout(() => { activeRoomLabel.innerText = currentRoom; }, 1500);
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
      await peerConnection.addIceCandidate(iceCandidateQueue.shift());
    }

    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    socket.emit('signal', { room: currentRoom, signal: { answer } });

  } else if (signal.answer) {
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
});

function createPeer(isInitiator) {
  dataChannels = [];
  openChannelsCount = 0;
  peerConnection = new RTCPeerConnection(rtcConfig);

  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('signal', { room: currentRoom, signal: { candidate: event.candidate } });
    }
  };

  peerConnection.onconnectionstatechange = () => {
    if (['disconnected', 'failed', 'closed'].includes(peerConnection.connectionState)) {
      updateStatus('Disconnected', 'error');
      sendBtn.disabled = true;
    }
  };

  if (isInitiator) {
    // Channel 0: Ordered for control/chat; Channels 1..3: Unordered for max-speed parallel chunks
    for (let i = 0; i < NUM_CHANNELS; i++) {
      const ch = peerConnection.createDataChannel(`turbo_${i}`, { ordered: i === 0 });
      setupDataChannel(ch, i);
      dataChannels.push(ch);
    }
  } else {
    peerConnection.ondatachannel = (event) => {
      const ch = event.channel;
      const idx = parseInt(ch.label.split('_')[1] || '0', 10);
      setupDataChannel(ch, idx);
      dataChannels[idx] = ch;
    };
  }
}

function setupDataChannel(channel, idx) {
  channel.binaryType = 'arraybuffer';
  channel.bufferedAmountLowThreshold = 524288; // 512KB

  channel.onopen = () => {
    openChannelsCount++;
    if (openChannelsCount === NUM_CHANNELS) {
      updateStatus('Connected & Ready (4x Turbo)', 'connected');
      if (fileInput.files.length > 0) sendBtn.disabled = false;
    }
  };

  channel.onclose = () => {
    openChannelsCount = Math.max(0, openChannelsCount - 1);
    updateStatus('Disconnected', 'error');
    sendBtn.disabled = true;
  };

  channel.onmessage = handleReceiveMessage;
}

// File Input Selection
fileInput.addEventListener('change', () => {
  if (fileInput.files.length > 0) {
    const sizeMB = (fileInput.files[0].size / (1024 * 1024)).toFixed(2);
    fileLabel.innerText = `📄 ${fileInput.files[0].name} (${sizeMB} MB)`;
    if (openChannelsCount === NUM_CHANNELS) {
      sendBtn.disabled = false;
    }
  }
});

// UI Progress Updater (Used by both Sender via ACK & Receiver directly)
function renderProgress(bytesDone, totalBytes, labelPrefix) {
  const percent = Math.min(100, Math.round((bytesDone / totalBytes) * 100));
  const elapsedSec = Math.max(0.1, (Date.now() - transferStartTime) / 1000);
  const mbps = (bytesDone / (1024 * 1024) / elapsedSec).toFixed(1);

  progressFill.style.width = percent + '%';
  progressStatus.innerText = `${labelPrefix}: ${percent}%`;
  speedText.innerText = `${mbps} MB/s`;
}

// 4-CHANNEL TURBO SENDER (Offset-tagged packets + Receiver ACK Sync)
sendBtn.addEventListener('click', async () => {
  const file = fileInput.files[0];
  if (!file || openChannelsCount < NUM_CHANNELS) return;

  progressWrapper.style.display = 'block';
  sendBtn.disabled = true;
  transferStartTime = Date.now();
  renderProgress(0, file.size, 'Sending');

  // Send metadata on reliable ordered Channel 0
  dataChannels[0].send(JSON.stringify({
    type: 'metadata',
    name: file.name,
    size: file.size,
    mime: file.type
  }));

  const chunkSize = 131072; // 128 KB payload per packet
  const maxBufferPerChannel = 2097152; // 2 MB per channel (8 MB total pipeline)
  let offset = 0;
  let chunkIndex = 0;

  // Promise that resolves when receiver confirms 100% received
  const ackDonePromise = new Promise((resolve) => {
    onTransferCompleteAck = resolve;
  });

  try {
    while (offset < file.size) {
      const ch = dataChannels[chunkIndex % NUM_CHANNELS];

      if (ch.bufferedAmount > maxBufferPerChannel) {
        await new Promise((resolve) => {
          ch.onbufferedamountlow = () => {
            ch.onbufferedamountlow = null;
            resolve();
          };
        });
      }

      const slice = file.slice(offset, offset + chunkSize);
      const rawBuffer = await slice.arrayBuffer();

      // Prepend 8-byte Float64 offset header so unordered channels reconstruct exact order
      const packet = new ArrayBuffer(8 + rawBuffer.byteLength);
      new DataView(packet).setFloat64(0, offset, true);
      new Uint8Array(packet, 8).set(new Uint8Array(rawBuffer));

      ch.send(packet);
      offset += rawBuffer.byteLength;
      chunkIndex++;
    }

    // Wait until receiver finishes writing 100% so both screens finish together
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

// Chat Functions (Always uses reliable Channel 0)
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
  if (!text || !dataChannels[0] || dataChannels[0].readyState !== 'open') return;

  dataChannels[0].send(JSON.stringify({ type: 'chat', text }));
  appendMessage(text, 'me');
  chatInput.value = '';
}

chatSendBtn.addEventListener('click', sendChatMessage);
chatInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') sendChatMessage();
});

// Receiver Logic (Reconstructs out-of-order packets & sends real-time ACK to Sender)
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
      // Sender receives exact progress from Receiver -> Both devices show identical %
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

  // Binary Packet: Extract 8-byte offset + payload
  if (!incomingFileInfo || !receiveArray) return;

  const view = new DataView(event.data);
  const offset = view.getFloat64(0, true);
  const chunkBytes = new Uint8Array(event.data, 8);

  receiveArray.set(chunkBytes, offset);
  receivedSize += chunkBytes.byteLength;

  const currentPercent = Math.min(100, Math.round((receivedSize / incomingFileInfo.size) * 100));
  renderProgress(receivedSize, incomingFileInfo.size, 'Receiving');

  // Send ACK back to sender every 2% or at 100% completion
  if (currentPercent - lastAckPercent >= 2 || receivedSize >= incomingFileInfo.size) {
    lastAckPercent = currentPercent;
    const isDone = receivedSize >= incomingFileInfo.size;
    if (dataChannels[0] && dataChannels[0].readyState === 'open') {
      dataChannels[0].send(JSON.stringify({
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