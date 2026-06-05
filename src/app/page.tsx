'use client';

import { useState, useEffect, useRef } from 'react';
import Image from 'next/image';

const CHUNK_SIZE = 65536; // 64KB chunks (optimal packet size for SCTP / UDP fragmentation)
const BLOCK_SIZE = 1048576; // 1MB blocks for disk read optimization (reduces FileReader overhead)
const BUFFER_THRESHOLD = 8388608; // 8MB buffer threshold for larger network window

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
  // Stats
  const [transferMeta, setTransferMeta] = useState<{ name: string; size: number; mimeType?: string } | null>(null);

  // Speed test states
  const [isSpeedTesting, setIsSpeedTesting] = useState<boolean>(false);
  const [speedTestResult, setSpeedTestResult] = useState<string | null>(null);
  const isSpeedTestingRef = useRef<boolean>(false);

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
    isSpeedTestingRef.current = false;
    setIsSpeedTesting(false);
    setSpeedTestResult(null);
    setStatus('disconnected');
    setIsTransferring(false);
    setTransferType(null);
    setSelectedFile(null);
    setProgress(0);
  };

  const initWebSocket = () => {
    // Connect to WebSocket signaling server
    // Read from env variable (useful for Vercel production) or fallback to local port 3001
    const envUrl = process.env.NEXT_PUBLIC_SIGNALING_SERVER;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = envUrl || `${protocol}//${window.location.hostname}:3001`;
    
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
    dc.bufferedAmountLowThreshold = 2097152; // 2MB threshold to keep high-speed pipeline full

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

    const readNextBlock = () => {
      const slice = file.slice(offset, offset + BLOCK_SIZE);
      reader.readAsArrayBuffer(slice);
    };

    reader.onload = (e) => {
      const blockBuffer = e.target?.result as ArrayBuffer;
      if (!dataChannelRef.current) return;

      const bytesInBlock = blockBuffer.byteLength;
      let blockOffset = 0;

      // Stream the block in 64KB chunks synchronously
      while (blockOffset < bytesInBlock) {
        const currentChunkSize = Math.min(CHUNK_SIZE, bytesInBlock - blockOffset);
        const chunk = blockBuffer.slice(blockOffset, blockOffset + currentChunkSize);
        dataChannelRef.current.send(chunk);
        blockOffset += currentChunkSize;
        offset += currentChunkSize;
      }
      
      // Update statistics
      updateTransferStats(offset, size);

      if (offset < size) {
        // Backpressure check: wait if bufferedAmount exceeds threshold
        if (dataChannelRef.current.bufferedAmount > BUFFER_THRESHOLD) {
          dataChannelRef.current.onbufferedamountlow = () => {
            if (dataChannelRef.current) {
              dataChannelRef.current.onbufferedamountlow = null;
              readNextBlock();
            }
          };
        } else {
          // Continue reading next block immediately
          readNextBlock();
        }
      } else {
        // Send EOF message
        dataChannelRef.current.send(JSON.stringify({ type: 'eof' }));
        setIsTransferring(false);
        setTransferType(null);
        alert('File sent successfully!');
      }
    };

    readNextBlock();
  };

  // --- WebRTC Speed Test Logic ---
  const runSpeedTest = () => {
    if (!dataChannelRef.current) return;
    
    setIsSpeedTesting(true);
    isSpeedTestingRef.current = true;
    setSpeedTestResult(null);
    setProgress(0);
    setSpeed('0 B/s');
    setEta('15.0s');
    
    // Send speedtest-start signal
    dataChannelRef.current.send(JSON.stringify({ type: 'speedtest-start' }));

    const testDurationMs = 15000;
    const startTime = Date.now();
    let totalBytesSent = 0;
    
    lastTimeRef.current = Date.now();
    lastBytesRef.current = 0;

    // Create a 1MB dummy ArrayBuffer to reuse
    const dummyBuffer = new ArrayBuffer(BLOCK_SIZE);
    
    const sendNextBlock = () => {
      const elapsed = Date.now() - startTime;
      if (elapsed >= testDurationMs) {
        // Stop speed test
        const durationSec = elapsed / 1000;
        const avgSpeedBps = totalBytesSent / durationSec;
        let avgSpeedText = '';
        if (avgSpeedBps > 1024 * 1024) {
          avgSpeedText = `${(avgSpeedBps / (1024 * 1024)).toFixed(2)} MB/s`;
        } else if (avgSpeedBps > 1024) {
          avgSpeedText = `${(avgSpeedBps / 1024).toFixed(2)} KB/s`;
        } else {
          avgSpeedText = `${Math.floor(avgSpeedBps)} B/s`;
        }

        setIsSpeedTesting(false);
        isSpeedTestingRef.current = false;
        setSpeedTestResult(avgSpeedText);
        
        // Notify receiver
        if (dataChannelRef.current) {
          dataChannelRef.current.send(JSON.stringify({ 
            type: 'speedtest-eof', 
            avgSpeed: avgSpeedText 
          }));
        }
        return;
      }

      // Update progress
      const percent = Math.min(100, Math.floor((elapsed / testDurationMs) * 100));
      setProgress(percent);
      setEta(`${Math.max(0, (testDurationMs - elapsed) / 1000).toFixed(1)}s`);

      // Stream the 1MB dummy block in 64KB chunks
      let blockOffset = 0;
      while (blockOffset < BLOCK_SIZE) {
        const currentChunkSize = Math.min(CHUNK_SIZE, BLOCK_SIZE - blockOffset);
        const chunk = new Uint8Array(dummyBuffer, blockOffset, currentChunkSize);
        if (dataChannelRef.current) {
          dataChannelRef.current.send(chunk);
        }
        blockOffset += currentChunkSize;
        totalBytesSent += currentChunkSize;
      }

      // Calculate speed
      const now = Date.now();
      const currentElapsedSec = (now - lastTimeRef.current) / 1000;
      if (currentElapsedSec >= 0.5) {
        const byteDiff = totalBytesSent - lastBytesRef.current;
        const instSpeedBps = byteDiff / currentElapsedSec;
        let speedText = '0 B/s';
        if (instSpeedBps > 1024 * 1024) {
          speedText = `${(instSpeedBps / (1024 * 1024)).toFixed(2)} MB/s`;
        } else if (instSpeedBps > 1024) {
          speedText = `${(instSpeedBps / 1024).toFixed(2)} KB/s`;
        } else {
          speedText = `${Math.floor(instSpeedBps)} B/s`;
        }
        setSpeed(speedText);
        lastTimeRef.current = now;
        lastBytesRef.current = totalBytesSent;
      }

      // Flow control check
      if (dataChannelRef.current && dataChannelRef.current.bufferedAmount > BUFFER_THRESHOLD) {
        dataChannelRef.current.onbufferedamountlow = () => {
          if (dataChannelRef.current) {
            dataChannelRef.current.onbufferedamountlow = null;
            sendNextBlock();
          }
        };
      } else {
        setTimeout(sendNextBlock, 0);
      }
    };

    sendNextBlock();
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
      } else if (msg.type === 'speedtest-start') {
        setIsSpeedTesting(true);
        isSpeedTestingRef.current = true;
        setSpeedTestResult(null);
        setProgress(0);
        setSpeed('0 B/s');
        setEta('15.0s');
        receivedSizeRef.current = 0;
        lastTimeRef.current = Date.now();
        lastBytesRef.current = 0;
        
        let elapsed = 0;
        const interval = setInterval(() => {
          elapsed += 100;
          if (elapsed >= 15000 || !isSpeedTestingRef.current) {
            clearInterval(interval);
          } else {
            setProgress(Math.floor((elapsed / 15000) * 100));
            setEta(`${((15000 - elapsed) / 1000).toFixed(1)}s`);
          }
        }, 100);
      } else if (msg.type === 'speedtest-eof') {
        setIsSpeedTesting(false);
        isSpeedTestingRef.current = false;
        setSpeedTestResult(msg.avgSpeed);
        setProgress(100);
        setEta('0s');
      }
    } else {
      if (isSpeedTestingRef.current) {
        receivedSizeRef.current += data.byteLength;
        const now = Date.now();
        const duration = (now - lastTimeRef.current) / 1000;
        if (duration >= 0.5) {
          const byteDiff = receivedSizeRef.current - lastBytesRef.current;
          const speedBps = byteDiff / duration;
          let speedText = '0 B/s';
          if (speedBps > 1024 * 1024) {
            speedText = `${(speedBps / (1024 * 1024)).toFixed(2)} MB/s`;
          } else if (speedBps > 1024) {
            speedText = `${(speedBps / 1024).toFixed(2)} KB/s`;
          } else {
            speedText = `${Math.floor(speedBps)} B/s`;
          }
          setSpeed(speedText);
          lastTimeRef.current = now;
          lastBytesRef.current = receivedSizeRef.current;
        }
        return;
      }
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
            
            {/* Speed Test Result Banner */}
            {speedTestResult && !isSpeedTesting && !isTransferring && (
              <div style={{
                background: 'rgba(0, 240, 255, 0.08)',
                border: '1px solid rgba(0, 240, 255, 0.2)',
                borderRadius: '16px',
                padding: '20px 24px',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '8px',
                textAlign: 'center'
              }}>
                <div style={{ fontSize: '1rem', fontWeight: 600, color: 'var(--accent-cyan)', letterSpacing: '0.05em', textTransform: 'uppercase' }}>
                  ⚡ Connection Speed Test Result
                </div>
                <div style={{ fontSize: '2.5rem', fontWeight: 800, color: '#fff', textShadow: '0 0 10px rgba(0, 240, 255, 0.2)' }}>
                  {speedTestResult}
                </div>
                <div className="mode-desc">
                  Average direct transfer rate between devices.
                </div>
              </div>
            )}

            {/* Sender UI: File pick and Send button */}
            {mode === 'send' && !isTransferring && !isSpeedTesting && (
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
                
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '16px', justifyContent: 'center' }}>
                  <button className="btn btn-secondary" onClick={cleanup}>
                    Disconnect
                  </button>
                  <button className="btn btn-secondary" onClick={runSpeedTest} style={{ borderColor: 'var(--accent-cyan)', color: 'var(--accent-cyan)' }}>
                    ⚡ Test Speed
                  </button>
                  <button className="btn" onClick={sendFile} disabled={!selectedFile}>
                    Send File
                  </button>
                </div>
              </div>
            )}

            {/* Receiver UI: Waiting indicator */}
            {mode === 'receive' && !isTransferring && !isSpeedTesting && (
              <div style={{ textAlign: 'center', padding: '40px 20px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <div style={{ fontSize: '3rem', animation: 'pulse 2s infinite' }}>⏳</div>
                <div className="mode-title">Waiting for files...</div>
                <p className="mode-desc">Connected! Ask the sender to choose a file or start a speed test.</p>
                <div style={{ display: 'flex', gap: '16px', justifyContent: 'center', marginTop: '16px' }}>
                  <button className="btn btn-secondary" onClick={cleanup} style={{ alignSelf: 'center' }}>
                    Disconnect
                  </button>
                </div>
              </div>
            )}

            {/* Speed Test Active UI */}
            {isSpeedTesting && (
              <div className="transfer-box" style={{ borderColor: 'var(--accent-cyan)' }}>
                <div className="mode-title" style={{ fontSize: '1.2rem', display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: 'var(--accent-cyan)' }}>⚡ Running Connection Speed Test</span>
                  <span style={{ color: 'var(--accent-cyan)' }}>{progress}%</span>
                </div>
                
                <div className="mode-desc">
                  Measuring direct P2P bandwidth capacity using a simulated 15-second data stream...
                </div>
                
                <div className="progress-container">
                  <div className="progress-bar" style={{ width: `${progress}%`, background: 'linear-gradient(90deg, var(--accent-cyan), var(--accent-purple))' }} />
                </div>
                
                <div className="transfer-meta">
                  <span>Duration: 15.0s</span>
                  <span>Testing P2P Channel</span>
                </div>

                <div className="transfer-stats">
                  <div className="stat-card">
                    <div className="stat-label">Current Speed</div>
                    <div className="stat-value">{speed}</div>
                  </div>
                  <div className="stat-card">
                    <div className="stat-label">Time Remaining</div>
                    <div className="stat-value">{eta}</div>
                  </div>
                  <div className="stat-card">
                    <div className="stat-label">Progress</div>
                    <div className="stat-value">{progress}%</div>
                  </div>
                </div>
              </div>
            )}

            {/* Common Progress UI: Shown during active transfer */}
            {isTransferring && transferMeta && !isSpeedTesting && (
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
