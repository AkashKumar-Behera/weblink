# 🌐 WebLink Share — Open-Source Direct P2P File Sharing

WebLink Share is a modern, privacy-focused, open-source web application for high-speed peer-to-peer (P2P) file sharing. By leveraging **WebRTC Data Channels**, it enables direct browser-to-browser transfers without size limits, cloud logs, or server bottlenecks. If both devices are on the same WiFi network, the file transfer fully utilizes the local network capacity, delivering super ultra-high speeds.

---

## ✨ Key Features
- **Zero Size Limits:** Send any file format of any size (MBs to GBs).
- **Direct P2P Transfer:** Files stream directly between browsers. They are never uploaded to a third-party server or stored in the cloud.
- **Ultra High-Speed:** Direct peer connections maximize your local WiFi/Ethernet speeds.
- **Backpressure & Stability:** Incorporates automated RTC buffer tracking (`bufferedamountlow`) to transfer giant files smoothly without crashing the browser's memory.
- **Real-Time Dashboards:** Shows instant speedometer (MB/s), transfer progress, and responsive ETAs.
- **Pairing Code Handshake:** Connect two devices securely and instantly using a simple 6-digit code.
- **Premium Glassmorphic Design:** Sleek, responsive, HSL dark-themed UI built with custom styling.

---

## 🛠️ Tech Stack
- **Frontend:** [Next.js](https://nextjs.org/) (App Router), React, TypeScript
- **Styling:** Custom Vanilla CSS with responsive design and modern glassmorphic tokens
- **Signaling:** Node.js, WebSockets (`ws`)
- **P2P Transport:** WebRTC (`RTCPeerConnection` & `RTCDataChannel`)

---

## ⚙️ How It Works
1. **Signaling (Pairing):** Device A generates a code. This creates a virtual pairing room on the signaling server.
2. **Handshake:** Device B enters the code, connecting to the same room. The server relays their WebRTC SDP offers/answers and ICE candidates.
3. **P2P Tunnel:** Once the devices discover each other, they establish a direct peer-to-peer connection. **The WebSocket signaling connection is no longer used for data transfer.**
4. **Data Stream:** Files are read chunk-by-chunk using `FileReader` on Device A, sent directly through the encrypted `RTCDataChannel`, and reassembled for instant download on Device B.

---

## 🚀 Getting Started

### Prerequisites
- Node.js (v18 or higher)
- npm or yarn

### Setup Instructions

1. **Clone the repository:**
   ```bash
   git clone https://github.com/AkashKumar-Behera/weblink.git
   cd weblink
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Start the WebSocket Signaling Server:**
   ```bash
   node server.js
   ```
   *The signaling server starts on port `3001`.*

4. **Start the Next.js Development Server:**
   In another terminal window, run:
   ```bash
   npm run dev
   ```
   *The frontend starts on port `3000` (e.g., `http://localhost:3000`). If you are on the same WiFi network, you can access it on other devices using your local network IP (e.g., `http://192.168.1.XX:3000`).*

---

## 🤝 Contributing
Contributions are what make the open-source community such an amazing place to learn, inspire, and create. Any contributions you make are **greatly appreciated**.

1. Fork the Project.
2. Create your Feature Branch (`git checkout -b feature/AmazingFeature`).
3. Commit your Changes (`git commit -m 'Add some AmazingFeature'`).
4. Push to the Branch (`git push origin feature/AmazingFeature`).
5. Open a Pull Request.

---

## 📄 License
Distributed under the MIT License. See `LICENSE` for more information.
