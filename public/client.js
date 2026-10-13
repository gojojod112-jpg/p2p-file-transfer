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
  } else {
    statusDot.classList.remove('connected');
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

// 2. Caller Side (Existing user detects new user)
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
    
    // Process queued candidates
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
    fileLabel.innerText = '📄 ' + fileInput.files[0].name;
    if (dataChannel && dataChannel.readyState === 'open') {
      sendBtn.disabled = false;
    }
  }
});

// File Sending Logic
sendBtn.addEventListener('click', () => {
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

  const chunkSize = 16384; // 16 KB chunks
  let offset = 0;
  const reader = new FileReader();

  reader.onload = (e) => {
    dataChannel.send(e.target.result);
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

// File Receiving Logic
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

  receiveBuffer.push(event.data);
  receivedSize += event.data.byteLength;

  if (incomingFileInfo) {
    const percent = Math.min(100, Math.round((receivedSize / incomingFileInfo.size) * 100));
    progressFill.style.width = percent + '%';
    progressText.innerText = percent + '%';

    if (receivedSize >= incomingFileInfo.size) {
      const receivedBlob = new Blob(receiveBuffer, { type: incomingFileInfo.mime });
      const downloadLink = document.createElement('a');
      downloadLink.href = URL.createObjectURL(receivedBlob);
      downloadLink.download = incomingFileInfo.name;
      document.body.appendChild(downloadLink);
      downloadLink.click();
      downloadLink.remove();

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