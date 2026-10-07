const socket = io();
let localPeerConnection;
let dataChannel;
let currentRoomId = '';

const statusText = document.getElementById('status');
const joinBtn = document.getElementById('joinBtn');
const roomIdInput = document.getElementById('roomId');
const fileInput = document.getElementById('fileInput');
const sendBtn = document.getElementById('sendBtn');
const progressBar = document.getElementById('progressBar');
const progressText = document.getElementById('progressText');

// STUN server connection routes dhoondne ke liye
const iceServers = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
};

// 1. Join Room
joinBtn.onclick = () => {
  currentRoomId = roomIdInput.value.trim();
  if (!currentRoomId) return alert('Enter a room ID');
  socket.emit('join-room', currentRoomId);
  statusText.innerText = 'Status: Waiting for peer...';
  joinBtn.disabled = true;
};

// 2. Peer setup function
function setupPeer(isInitiator) {
  localPeerConnection = new RTCPeerConnection(iceServers);

  localPeerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('ice-candidate', {
        roomId: currentRoomId,
        candidate: event.candidate
      });
    }
  };

  if (isInitiator) {
    // Sender side DataChannel banata hai
    dataChannel = localPeerConnection.createDataChannel('fileTransfer');
    setupDataChannelEvents();
  } else {
    // Receiver side DataChannel receive karta hai
    localPeerConnection.ondatachannel = (event) => {
      dataChannel = event.channel;
      setupDataChannelEvents();
    };
  }
}

// 3. Signaling Listeners
socket.on('user-connected', async () => {
  statusText.innerText = 'Status: Connecting with peer...';
  setupPeer(true);

  const offer = await localPeerConnection.createOffer();
  await localPeerConnection.setLocalDescription(offer);

  socket.emit('offer', { roomId: currentRoomId, offer });
});

socket.on('offer', async (data) => {
  setupPeer(false);
  await localPeerConnection.setRemoteDescription(new RTCSessionDescription(data.offer));

  const answer = await localPeerConnection.createAnswer();
  await localPeerConnection.setLocalDescription(answer);

  socket.emit('answer', { roomId: currentRoomId, answer });
});

socket.on('answer', async (data) => {
  await localPeerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
});

socket.on('ice-candidate', async (data) => {
  try {
    await localPeerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
  } catch (err) {
    console.error('Error adding ICE candidate', err);
  }
});

// 4. DataChannel Events & File Handling
let receivedBuffers = [];
let receivedFileSize = 0;
let metaData = null;

function setupDataChannelEvents() {
  dataChannel.binaryType = 'arraybuffer';

  dataChannel.onopen = () => {
    statusText.innerText = 'Status: Connected! Ready to transfer.';
    fileInput.disabled = false;
    sendBtn.disabled = false;
  };

  dataChannel.onmessage = (event) => {
    // String message matlab File Metadata hai
    if (typeof event.data === 'string') {
      metaData = JSON.parse(event.data);
      receivedBuffers = [];
      receivedFileSize = 0;
      return;
    }

    // Binary chunk receive karna
    receivedBuffers.push(event.data);
    receivedFileSize += event.data.byteLength;

    const percent = Math.round((receivedFileSize / metaData.size) * 100);
    progressBar.value = percent;
    progressText.innerText = `${percent}%`;

    // File transfer complete hone par download trigger karein
    if (receivedFileSize === metaData.size) {
      const blob = new Blob(receivedBuffers);
      const downloadLink = document.createElement('a');
      downloadLink.href = URL.createObjectURL(blob);
      downloadLink.download = metaData.name;
      downloadLink.click();
      statusText.innerText = `Received file: ${metaData.name}`;
    }
  };
}

// 5. File Send Logic (Chunking)
sendBtn.onclick = () => {
  const file = fileInput.files[0];
  if (!file) return alert('Select a file first');

  // Pehle metadata bhejo
  dataChannel.send(JSON.stringify({ name: file.name, size: file.size }));

  const chunkSize = 16384; // 16 KB chunks
  let offset = 0;
  const fileReader = new FileReader();

  fileReader.onload = (e) => {
    dataChannel.send(e.target.result);
    offset += e.target.result.byteLength;

    const percent = Math.round((offset / file.size) * 100);
    progressBar.value = percent;
    progressText.innerText = `${percent}%`;

    if (offset < file.size) {
      readNextChunk();
    } else {
      statusText.innerText = 'Status: File sent successfully!';
    }
  };

  function readNextChunk() {
    const slice = file.slice(offset, offset + chunkSize);
    fileReader.readAsArrayBuffer(slice);
  }

  readNextChunk();
};