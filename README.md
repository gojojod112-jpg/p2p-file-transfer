# 🚀 WebRTC P2P Local File Transfer

A lightweight, serverless peer-to-peer (P2P) file-sharing web application that enables direct browser-to-browser data transfer using the native **WebRTC DataChannel API** and a **Node.js/Socket.io** signaling server.

---

## 📌 Features

- **Direct P2P Transfer:** Files are transferred directly between peers without storing even a single byte on the server.
- **Zero Cloud Storage & High Privacy:** End-to-end encrypted transfer ensures absolute data privacy.
- **High-Speed LAN Transfer:** Operates at local Wi-Fi speeds, bypassing standard internet bandwidth caps.
- **Chunking Mechanism:** Files are split into binary chunks (16 KB) via JavaScript's `FileReader` API for smooth transmission.
- **Responsive UI:** Clean, modern interface with a real-time progress indicator.

---

## 🛠️ Tech Stack

- **Frontend:** HTML5, CSS3, Vanilla JavaScript (ES6+)
- **Core Protocol:** WebRTC (`RTCPeerConnection`, `RTCDataChannel`)
- **Signaling Layer:** Node.js, Express.js, Socket.io
- **STUN Server:** Google Public STUN (`stun.l.google.com:19302`)

---

## ⚙️ Architecture & How It Works

1. **Signaling (Handshake):** Peers join the same room using Socket.io. The server exchanges Session Description Protocol (SDP) offers, answers, and ICE candidates between the browsers.
2. **Direct Connection:** Once the handshake is complete, an `RTCDataChannel` is established directly between the two browsers.
3. **File Chunking:** The sender slices the file into small chunks and sends them sequentially over the data channel.
4. **Reassembly & Download:** The receiver collects all incoming binary chunks into an array, reconstructs the `Blob`, and triggers an automatic browser download.

---

## 💻 Local Setup & Installation

### Prerequisites
- [Node.js](https://nodejs.org/) installed on your machine.

### Steps

1. **Clone the repository:**
   ```bash
   git clone [https://github.com/](https://github.com/)<YOUR_USERNAME>/<REPO_NAME>.git
   cd <REPO_NAME>