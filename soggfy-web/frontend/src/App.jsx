import React, { useState, useEffect, useCallback, useRef } from 'react';
import axios from 'axios';
import './App.css';
import Settings from './components/Settings';

const API_BASE = 'http://localhost:3001/api';
const WS_URL = 'ws://localhost:3001/ws';

function App() {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [queue, setQueue] = useState({ current: null, queue: [], completed: [] });
  const [devices, setDevices] = useState([]);
  const [selectedDevice, setSelectedDevice] = useState('');
  const [authenticated, setAuthenticated] = useState(false);
  const [soggfyConnected, setSoggfyConnected] = useState(false);
  const [wsConnected, setWsConnected] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [soggfyConfig, setSoggfyConfig] = useState(null);
  const [autoSelectDevice, setAutoSelectDevice] = useState(true);
  const wsRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);

  const connectWebSocket = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('WebSocket connected');
      setWsConnected(true);
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        switch (message.type) {
          case 'status':
            setSoggfyConnected(message.data.soggfyConnected);
            setAuthenticated(message.data.spotifyAuthenticated);
            setQueue(message.data.queue);
            break;
          case 'queueUpdate':
            setQueue(message.data);
            break;
          case 'soggfyStatus':
            setSoggfyConnected(message.data.connected);
            break;
          case 'authStatus':
            setAuthenticated(message.data.authenticated);
            if (message.data.authenticated) {
              fetchDevices();
            }
            break;
          case 'configSync':
          case 'configUpdate':
            setSoggfyConfig(message.data);
            break;
          default:
            break;
        }
      } catch (error) {
        console.error('Failed to parse WebSocket message:', error);
      }
    };

    ws.onclose = () => {
      console.log('WebSocket disconnected');
      setWsConnected(false);
      reconnectTimeoutRef.current = setTimeout(connectWebSocket, 2000);
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };
  }, []);

  useEffect(() => {
    connectWebSocket();
    checkHealth();

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [connectWebSocket]);

  const checkHealth = async () => {
    try {
      const response = await axios.get(`${API_BASE}/health`);
      setSoggfyConnected(response.data.soggfyConnected);
      setAuthenticated(response.data.spotifyAuthenticated);
      setAutoSelectDevice(response.data.autoSelectDevice !== false);
      if (response.data.spotifyAuthenticated) {
        fetchDevices(response.data.autoSelectDevice !== false);
      }
      if (response.data.soggfyConnected) {
        fetchConfig();
      }
    } catch (error) {
      console.error('Health check failed:', error);
    }
  };

  const fetchConfig = async () => {
    try {
      const response = await axios.get(`${API_BASE}/config`);
      setSoggfyConfig(response.data);
    } catch (error) {
      console.error('Failed to fetch config:', error);
    }
  };

  const fetchDevices = async (autoSelect = autoSelectDevice) => {
    try {
      const response = await axios.get(`${API_BASE}/devices`);
      setDevices(response.data.devices || []);
      if (autoSelect && response.data.devices?.length === 1) {
        const deviceId = response.data.devices[0].id;
        setSelectedDevice(deviceId);
        await selectDevice(deviceId);
      }
    } catch (error) {
      console.error('Failed to fetch devices:', error);
    }
  };

  const handleAuth = async () => {
    try {
      const response = await axios.get(`${API_BASE}/auth/url`);
      window.open(response.data.url, '_blank', 'width=500,height=700');
    } catch (error) {
      alert('Failed to start authentication');
    }
  };

  const selectDevice = async (deviceId) => {
    try {
      await axios.post(`${API_BASE}/device`, { deviceId });
      setSelectedDevice(deviceId);
    } catch (error) {
      alert('Failed to select device');
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!url.trim()) return;

    setLoading(true);
    try {
      const response = await axios.post(`${API_BASE}/download`, { url });
      setUrl('');
      if (response.data.count > 1) {
        console.log(`Added ${response.data.count} tracks to queue`);
      }
    } catch (error) {
      alert('Error: ' + (error.response?.data?.error || error.message));
    } finally {
      setLoading(false);
    }
  };

  const handleClearCompleted = async () => {
    try {
      await axios.post(`${API_BASE}/queue/clear`);
    } catch (error) {
      console.error('Failed to clear completed:', error);
    }
  };

  const handleRemoveFromQueue = async (trackId) => {
    try {
      await axios.delete(`${API_BASE}/queue/${trackId}`);
    } catch (error) {
      console.error('Failed to remove from queue:', error);
    }
  };

  const handleSkipCurrent = async () => {
    try {
      await axios.post(`${API_BASE}/queue/skip`);
    } catch (error) {
      console.error('Failed to skip:', error);
    }
  };

  const formatDuration = (ms) => {
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  const getStatusText = (status) => {
    switch (status) {
      case 'downloading': return 'Downloading...';
      case 'converting': return 'Converting...';
      case 'completed': return 'Done';
      case 'error': return 'Error';
      case 'skipped': return 'Skipped';
      case 'queued': return 'Queued';
      default: return status;
    }
  };

  if (!wsConnected) {
    return (
      <div className="app loading">
        <div className="spinner"></div>
        <h2>Connecting to server...</h2>
      </div>
    );
  }

  if (!soggfyConnected) {
    return (
      <div className="app error">
        <h2>Cannot connect to Soggfy</h2>
        <p>Make sure Spotify with Soggfy mod is running.</p>
        <button onClick={checkHealth} className="retry-button">Retry</button>
      </div>
    );
  }

  if (!authenticated) {
    return (
      <div className="app">
        <div className="auth-container">
          <h1>Soggfy Web UI</h1>
          <p>Authenticate with Spotify to control playback</p>
          <button onClick={handleAuth} className="auth-button">
            Connect Spotify Account
          </button>
        </div>
      </div>
    );
  }

  if (devices.length > 0 && !selectedDevice) {
    return (
      <div className="app">
        <div className="device-selector">
          <h2>Select Spotify Device</h2>
          <p>Choose the device where Soggfy is running</p>
          <div className="device-list">
            {devices.map(device => (
              <button
                key={device.id}
                onClick={() => selectDevice(device.id)}
                className={`device-button ${device.is_active ? 'active' : ''}`}
              >
                <span className="device-name">{device.name}</span>
                <span className="device-type">{device.type}</span>
              </button>
            ))}
          </div>
          <button onClick={fetchDevices} className="refresh-button">
            Refresh Devices
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <header>
        <h1>Soggfy Web UI</h1>
        <div className="header-actions">
          <button onClick={() => setShowSettings(true)} className="settings-button">
            Settings
          </button>
          <span className={`indicator ${soggfyConnected ? 'connected' : 'disconnected'}`}>
            Soggfy
          </span>
        </div>
      </header>

      {showSettings && (
        <Settings
          config={soggfyConfig}
          onClose={() => setShowSettings(false)}
          onConfigUpdate={setSoggfyConfig}
        />
      )}

      <div className="content">
        <form onSubmit={handleSubmit} className="url-form">
          <input
            type="text"
            placeholder="Paste Spotify track, album, or playlist URL..."
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={loading}
          />
          <button type="submit" disabled={loading || !url.trim()}>
            {loading ? 'Adding...' : 'Add to Queue'}
          </button>
        </form>

        {queue.current && (
          <div className="current-download">
            <div className="section-header">
              <h3>Now Downloading</h3>
              <button onClick={handleSkipCurrent} className="skip-button">Skip</button>
            </div>
            <div className="track-card current">
              {queue.current.albumArt && (
                <img src={queue.current.albumArt} alt="" className="album-art" />
              )}
              <div className="track-info">
                <div className="track-name">{queue.current.name}</div>
                <div className="track-artist">{queue.current.artist}</div>
              </div>
              <div className="track-status">
                <span className={`status-badge ${queue.current.status}`}>
                  {getStatusText(queue.current.status)}
                </span>
              </div>
            </div>
          </div>
        )}

        {queue.queue.length > 0 && (
          <div className="queue-section">
            <h3>Queue ({queue.queue.length} tracks)</h3>
            <div className="track-list">
              {queue.queue.map((track, i) => (
                <div key={track.id} className="track-card">
                  <div className="queue-number">{i + 1}</div>
                  {track.albumArt && (
                    <img src={track.albumArt} alt="" className="album-art small" />
                  )}
                  <div className="track-info">
                    <div className="track-name">{track.name}</div>
                    <div className="track-artist">{track.artist}</div>
                  </div>
                  <div className="track-duration">{formatDuration(track.duration)}</div>
                  <button
                    onClick={() => handleRemoveFromQueue(track.id)}
                    className="remove-button"
                    title="Remove from queue"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {queue.completed.length > 0 && (
          <div className="completed-section">
            <div className="section-header">
              <h3>Completed ({queue.completed.length})</h3>
              <button onClick={handleClearCompleted} className="clear-button">
                Clear
              </button>
            </div>
            <div className="track-list">
              {queue.completed.map((track) => (
                <div key={`${track.id}-${track.completedAt}`} className="track-card completed">
                  {track.albumArt && (
                    <img src={track.albumArt} alt="" className="album-art small" />
                  )}
                  <div className="track-info">
                    <div className="track-name">{track.name}</div>
                    <div className="track-artist">{track.artist}</div>
                  </div>
                  <span className={`status-badge ${track.status}`}>
                    {track.status === 'completed' ? '✓' : track.status === 'error' ? '✗' : '⏭'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {!queue.current && queue.queue.length === 0 && queue.completed.length === 0 && (
          <div className="empty-state">
            <p>No tracks in queue</p>
            <p className="hint">Paste a Spotify URL above to get started</p>
          </div>
        )}
      </div>

      <footer className="app-footer">
        <a href="https://x.com/KorOglan" target="_blank" rel="noopener noreferrer">
          Kilimcinin Kor Oglu
        </a>
      </footer>
    </div>
  );
}

export default App;
