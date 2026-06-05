'use client';

import { useState, useEffect, useRef } from 'react';
import Image from 'next/image';

const CHUNK_SIZE = 262144; // 256KB chunks (much faster!)
const BUFFER_THRESHOLD = 1048576; // 1MB buffer threshold to allow pipelining

type AppMode = 'select' | 'send' | 'receive';
type ConnectionStatus = 'disconnected' | 'connecting' | 'connected';

export default function Home() {
  const [mode, setMode] = useState<AppMode>('select');
  const [code, setCode] = useState<string>('');
  const [inputCode, setInputCode] = useState<string>('');
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [errorMessage, setErrorMessage] = useState<string>('');
  
  // File states
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<number>(0);
  const [speed, setSpeed] = useState<string>('0 B/s');
  const [eta, setEta] = useState<string>('0s');
  const [isTransferring, setIsTransferring] = useState<boolean>(false);
  const [transferType, setTransferType] = useState<'sending' | 'receiving' | null>(null);
  
  // Stats
  const [transferMeta, setTransferMeta] = useState<{ name: string; size: number; mimeType?: string } | null>(null);

  // Refs for WebRTC
  const wsRef = useRef<WebSocket | null>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const fileReaderRef = useRef<FileReader | null>(null);
  const receivedChunksRef = useRef<ArrayBuffer[]>([]);
  const receivedSizeRef = useRef<number>(0);
  const transferMetaRef = useRef<{ name: string; size: number; mimeType?: string } | null>(null);
  
  // Speed monitoring
  const lastTimeRef = useRef<number>(0);
  const lastBytesRef = useRef<number>(0);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      cleanup();
    };
  }, []);

  const cleanup = () => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    if (dataChannelRef.current) {
      dataChannelRef.current.close();
      dataChannelRef.current = null;
    }
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }
    transferMetaRef.current = null;
    setStatus('disconnected');
    setIsTransferring(false);
    setTransferType(null);
    setSelectedFile(null);
    setProgress(0);
  };

  const initWebSocket = () => {
    // Connect to WebSockets server running locally
    // In production, we'd use the window.location.hostname
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.hostname}:3001`;
    
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;
    
    ws.onopen = () => {
      console.log('Connected to signaling server');
    };

    ws.onmessage = async (event) => {
      const data = JSON.parse(event.data);

      switch (data.type) {
        case 'room-created':
          setCode(data.code);
          setStatus('connecting');
          break;

        case 'room-joined':
          setStatus('connecting');
          // Receiver creates PeerConnection
          createPeerConnection(data.clientId, false);
          break;

        case 'peer-joined':
          // Sender creates PeerConnection and DataChannel
          createPeerConnection(data.peerId, true);
          break;

        case 'signal':
          if (peerConnectionRef.current) {
            const { signal } = data;
            if (signal.sdp) {
              await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(signal.sdp));
              if (signal.sdp.type === 'offer') {
                const answer = await peerConnectionRef.current.createAnswer();
                await peerConnectionRef.current.setLocalDescription(answer);
                sendSignal({ sdp: answer });
              }
            } else if (signal.candidate) {
              await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(signal.candidate));
            }
          }
          break;

        case 'peer-left':
          setErrorMessage('Peer disconnected from room');
          cleanup();
          break;

        case 'error':
          setErrorMessage(data.message);
          cleanup();
          break;
      }
    };

    ws.onerror = (err) => {
      console.error('WebSocket error:', err);
      setErrorMessage('Failed to connect to signaling server');
      cleanup();
    };

    ws.onclose = () => {
      console.log('Signaling server connection closed');
    };
  };

  const sendSignal = (signal: any) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'signal', signal }));
    }
  };

  const createPeerConnection = (peerId: string, isInitiator: boolean) => {
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19002' },
        { urls: 'stun:stun1.l.google.com:19002' }
      ]
    });
    peerConnectionRef.current = pc;

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendSignal({ candidate: event.candidate });
      }
    };

    pc.onconnectionstatechange = () => {
      console.log('Connection state:', pc.connectionState);
      if (pc.connectionState === 'connected') {
        setStatus('connected');
      } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        setStatus('disconnected');
        setErrorMessage('Direct P2P connection lost');
        cleanup();
      }
    };

    if (isInitiator) {
      // Create data channel
      const dc = pc.createDataChannel('file-transfer', { ordered: true });
      setupDataChannel(dc);
      
      pc.createOffer().then(offer => {
        return pc.setLocalDescription(offer);
      }).then(() => {
        sendSignal({ sdp: pc.localDescription });
      });
    } else {
      pc.ondatachannel = (event) => {
        setupDataChannel(event.channel);
      };
    }
  };

  const setupDataChannel = (dc: RTCDataChannel) => {
    dataChannelRef.current = dc;
    dc.binaryType = 'arraybuffer';

    dc.onopen = () => {
      console.log('Data channel open');
      setStatus('connected');
    };

    dc.onmessage = (event) => {
      handleIncomingData(event.data);
    };

    dc.onclose = () => {
      console.log('Data channel closed');
      setStatus('disconnected');
    };
  };

  // Sender starts the code generation
  const startSending = () => {
    cleanup();
    setMode('send');
    initWebSocket();
    // Request server to create a room
    setTimeout(() => {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'create-room' }));
      }
    }, 500);
  };

  // Receiver joins a room using code
  const startReceiving = () => {
    if (!inputCode || inputCode.length !== 6) {
      setErrorMessage('Please enter a valid 6-digit code');
      return;
    }
    cleanup();
    setMode('receive');
    initWebSocket();
    
    // Request server to join the room
    setTimeout(() => {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'join-room', code: inputCode }));
      }
    }, 500);
  };

  // --- WebRTC Chunked Sender Logic ---
  const sendFile = () => {
    if (!selectedFile || !dataChannelRef.current) return;
    
    const file = selectedFile;
    const size = file.size;
    
    setIsTransferring(true);
    setTransferType('sending');
    setTransferMeta({ name: file.name, size });
    setProgress(0);
    
    lastTimeRef.current = Date.now();
    lastBytesRef.current = 0;

    // Send metadata header first
    dataChannelRef.current.send(JSON.stringify({
      type: 'meta',
      name: file.name,
      size: file.size,
      mimeType: file.type
    }));

    let offset = 0;
    const reader = new FileReader();
    fileReaderRef.current = reader;

    const readSlice = (o: number) => {
      const slice = file.slice(offset, o + CHUNK_SIZE);
      reader.readAsArrayBuffer(slice);
    };

    reader.onload = (e) => {
      const buffer = e.target?.result as ArrayBuffer;
      if (!dataChannelRef.current) return;

      // Send chunk
      dataChannelRef.current.send(buffer);
      offset += buffer.byteLength;
      
      // Update statistics
      updateTransferStats(offset, size);

      if (offset < size) {
        // Backpressure check: wait if bufferedAmount exceeds threshold
        if (dataChannelRef.current.bufferedAmount > BUFFER_THRESHOLD) {
          dataChannelRef.current.onbufferedamountlow = () => {
            if (dataChannelRef.current) {
              dataChannelRef.current.onbufferedamountlow = null;
              readSlice(offset);
            }
          };
        } else {
          // Continue reading next slice
          readSlice(offset);
        }
      } else {
        // Send EOF message
        dataChannelRef.current.send(JSON.stringify({ type: 'eof' }));
        setIsTransferring(false);
        setTransferType(null);
        alert('File sent successfully!');
      }
    };

    readSlice(0);
  };

  // --- WebRTC Receiver Handle Logic ---
  const handleIncomingData = (data: any) => {
    if (typeof data === 'string') {
      const msg = JSON.parse(data);
      if (msg.type === 'meta') {
        // Initialize transfer metadata
        const meta = { name: msg.name, size: msg.size, mimeType: msg.mimeType };
        setTransferMeta(meta);
        transferMetaRef.current = meta;
        setIsTransferring(true);
        setTransferType('receiving');
        setProgress(0);
        
        receivedChunksRef.current = [];
        receivedSizeRef.current = 0;
        
        lastTimeRef.current = Date.now();
        lastBytesRef.current = 0;
      } else if (msg.type === 'eof') {
        // Reassemble the file
        const currentMeta = transferMetaRef.current;
        const blob = new Blob(receivedChunksRef.current, { type: currentMeta?.mimeType || 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        
        // Trigger download
        const a = document.createElement('a');
        a.href = url;
        a.download = currentMeta?.name || 'downloaded-file';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        
        setIsTransferring(false);
        setTransferType(null);
        setProgress(100);
        transferMetaRef.current = null;
        alert('File received and downloaded!');
      }
    } else {
      // Chunk buffer received
      receivedChunksRef.current.push(data);
      receivedSizeRef.current += data.byteLength;
      
      const currentMeta = transferMetaRef.current;
      if (currentMeta) {
        updateTransferStats(receivedSizeRef.current, currentMeta.size);
      }
    }
  };

  // Speed and ETA calculation
  const updateTransferStats = (currentBytes: number, totalBytes: number) => {
    const percent = Math.min(100, Math.floor((currentBytes / totalBytes) * 100));
    setProgress(percent);

    const now = Date.now();
    const duration = (now - lastTimeRef.current) / 1000;
    
    // Calculate stats every 500ms
    if (duration >= 0.5) {
      const byteDiff = currentBytes - lastBytesRef.current;
      const speedBps = byteDiff / duration;
      
      // Speed formatting
      let speedText = '0 B/s';
      if (speedBps > 1024 * 1024) {
        speedText = `${(speedBps / (1024 * 1024)).toFixed(2)} MB/s`;
      } else if (speedBps > 1024) {
        speedText = `${(speedBps / 1024).toFixed(2)} KB/s`;
      } else {
        speedText = `${Math.floor(speedBps)} B/s`;
      }
      
      setSpeed(speedText);

      // ETA formatting
      const remainingBytes = totalBytes - currentBytes;
      if (speedBps > 0) {
        const remainingSeconds = remainingBytes / speedBps;
        if (remainingSeconds > 60) {
          const m = Math.floor(remainingSeconds / 60);
          const s = Math.floor(remainingSeconds % 60);
          setEta(`${m}m ${s}s`);
        } else {
          setEta(`${remainingSeconds.toFixed(1)}s`);
        }
      } else {
        setEta('Infinite');
      }

      lastTimeRef.current = now;
      lastBytesRef.current = currentBytes;
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      setSelectedFile(e.target.files[0]);
    }
  };

  // Format file size
  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  return (
    <main>
      <div className="container-card">
        {/* Header */}
        <div className="header-section">
          <h1>
            <Image 
              src="/favicon.ico"  
              alt="Logo" 
              width={40} 
              height={40} 
              className="logo-icon" 
              priority
            />
            WebLink Share
          </h1>
          <p className="app-subtitle">
            Super ultra high-speed direct peer-to-peer file sharing. No limits. No cloud logs.
          </p>
        </div>

        {/* Error notification */}
        {errorMessage && (
          <div style={{
            background: 'rgba(255, 59, 48, 0.15)',
            border: '1px solid rgba(255, 59, 48, 0.3)',
            borderRadius: '12px',
            padding: '12px 20px',
            color: '#ff453a',
            fontSize: '0.95rem',
            textAlign: 'center'
          }}>
            {errorMessage}
            <button 
              onClick={() => setErrorMessage('')} 
              style={{
                background: 'none',
                border: 'none',
                color: '#fff',
                marginLeft: '12px',
                cursor: 'pointer',
                fontWeight: 'bold'
              }}
            >
              ×
            </button>
          </div>
        )}

        {/* Connection status badge */}
        <div className="status-pill">
          <span className={`status-dot ${status === 'connected' ? 'active' : ''}`} />
          {status === 'connected' ? 'P2P Link Secured' : status === 'connecting' ? 'Establishing P2P Tunnel...' : 'Offline'}
        </div>

        {/* Mode Selector (Only shown when not paired) */}
        {status === 'disconnected' && (
          <div className="action-grid">
            <div 
              className={`mode-card ${mode === 'send' ? 'active' : ''}`}
              onClick={startSending}
            >
              <div className="icon-wrapper">↑</div>
              <div className="mode-title">Send Files</div>
              <div className="mode-desc">Create a temporary connection code to share files with another device.</div>
            </div>

            <div 
              className={`mode-card ${mode === 'receive' ? 'active' : ''}`}
              onClick={() => setMode('receive')}
            >
              <div className="icon-wrapper">↓</div>
              <div className="mode-title">Receive Files</div>
              <div className="mode-desc">Enter a 6-digit code to pair with a sending device and receive files.</div>
            </div>
          </div>
        )}

        {/* Send Screen: Code display */}
        {mode === 'send' && status !== 'connected' && (
          <div className="code-display-box">
            <div style={{ color: varLink('secondary') }}>Your Connection Code</div>
            <div className="code-value">{code || '------'}</div>
            <p className="mode-desc" style={{ textAlign: 'center' }}>
              Open this website on the receiver device and enter this code.
            </p>
            <button className="btn btn-secondary" onClick={cleanup} style={{ marginTop: '12px' }}>
              Cancel
            </button>
          </div>
        )}

        {/* Receive Screen: Code input */}
        {mode === 'receive' && status !== 'connected' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
            <div className="code-input-wrapper">
              <input 
                type="text" 
                maxLength={6} 
                placeholder="Enter 6-digit code" 
                className="text-input" 
                value={inputCode}
                onChange={(e) => setInputCode(e.target.value.replace(/\D/g, ''))}
              />
              <button className="btn" onClick={startReceiving}>
                Connect
              </button>
            </div>
            <button className="btn btn-secondary" onClick={cleanup} style={{ alignSelf: 'center' }}>
              Back
            </button>
          </div>
        )}

        {/* Connected Screen: Peer-to-peer file transfer panel */}
        {status === 'connected' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '28px' }}>
            {/* Sender UI: File pick and Send button */}
            {mode === 'send' && !isTransferring && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                <label className="dropzone">
                  <input 
                    type="file" 
                    onChange={handleFileChange} 
                    style={{ display: 'none' }}
                  />
                  <div className="dropzone-icon">📁</div>
                  <div>
                    {selectedFile ? (
                      <strong style={{ color: '#00f0ff' }}>{selectedFile.name}</strong>
                    ) : (
                      'Drag & drop or click to select file'
                    )}
                  </div>
                  <div className="mode-desc">
                    {selectedFile ? formatBytes(selectedFile.size) : 'Any format, no size limit'}
                  </div>
                </label>
                
                <div style={{ display: 'flex', gap: '16px', justifyContent: 'center' }}>
                  <button className="btn btn-secondary" onClick={cleanup}>
                    Disconnect
                  </button>
                  <button className="btn" onClick={sendFile} disabled={!selectedFile}>
                    Send File
                  </button>
                </div>
              </div>
            )}

            {/* Receiver UI: Waiting indicator */}
            {mode === 'receive' && !isTransferring && (
              <div style={{ textAlign: 'center', padding: '40px 20px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <div style={{ fontSize: '3rem', animation: 'pulse 2s infinite' }}>⏳</div>
                <div className="mode-title">Waiting for files...</div>
                <p className="mode-desc">Connected! Ask the sender to choose and send a file.</p>
                <button className="btn btn-secondary" onClick={cleanup} style={{ alignSelf: 'center', marginTop: '16px' }}>
                  Disconnect
                </button>
              </div>
            )}

            {/* Common Progress UI: Shown during active transfer */}
            {isTransferring && transferMeta && (
              <div className="transfer-box">
                <div className="mode-title" style={{ fontSize: '1.2rem', display: 'flex', justifyContent: 'space-between' }}>
                  <span>{transferType === 'sending' ? 'Sending' : 'Receiving'} File</span>
                  <span style={{ color: 'var(--accent-cyan)' }}>{progress}%</span>
                </div>
                
                <div style={{ wordBreak: 'break-all', fontWeight: 600 }}>
                  {transferMeta.name}
                </div>
                
                <div className="progress-container">
                  <div className="progress-bar" style={{ width: `${progress}%` }} />
                </div>
                
                <div className="transfer-meta">
                  <span>{formatBytes(transferMeta.size)}</span>
                  <span>{transferType === 'sending' ? 'Uploading' : 'Downloading'}</span>
                </div>

                <div className="transfer-stats">
                  <div className="stat-card">
                    <div className="stat-label">Speed</div>
                    <div className="stat-value">{speed}</div>
                  </div>
                  <div className="stat-card">
                    <div className="stat-label">Time Left</div>
                    <div className="stat-value">{eta}</div>
                  </div>
                  <div className="stat-card">
                    <div className="stat-label">Progress</div>
                    <div className="stat-value">{progress}%</div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <footer style={{ justifyContent: 'center' }}>
        <span>Secure Local Connection</span>
        <span>•</span>
        <span>Made with WebRTC</span>
      </footer>
    </main>
  );
}

// Helper to access CSS color variables safely in TSX styled alerts
const varLink = (color: 'primary' | 'secondary') => {
  return color === 'primary' ? 'var(--text-primary)' : 'var(--text-secondary)';
};
