import React, { useState, useEffect, useCallback, useRef } from 'react';
import axios from 'axios';
import './App.css';
import Settings from './components/Settings';
import Statistics from './components/Statistics';
import Playlists from './components/Playlists';
import History from './components/History';
import Schedules from './components/Schedules';
import Search from './components/Search';
import Notifications from './components/Notifications';
import FileBrowser from './components/FileBrowser';

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
  const [showStatistics, setShowStatistics] = useState(false);
  const [showPlaylists, setShowPlaylists] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showSchedules, setShowSchedules] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  const [showFileBrowser, setShowFileBrowser] = useState(false);
  const [soggfyConfig, setSoggfyConfig] = useState(null);
  const [authRequired, setAuthRequired] = useState(false);
  const [loggedIn, setLoggedIn] = useState(false);
  const [sessionId, setSessionId] = useState(() => localStorage.getItem('sessionId') || '');
  const [loginForm, setLoginForm] = useState({ username: '', password: '' });
  const [loginError, setLoginError] = useState('');
  const wsRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);

  // Configure axios to send session header
  useEffect(() => {
    if (sessionId) {
      axios.defaults.headers.common['X-Session-Id'] = sessionId;
    } else {
      delete axios.defaults.headers.common['X-Session-Id'];
    }
  }, [sessionId]);

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
              fetchDevices(false); // Don't auto-select on auth, let user choose
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
      setAuthRequired(response.data.authRequired);
      setLoggedIn(response.data.authenticated);
      setSoggfyConnected(response.data.soggfyConnected);
      setAuthenticated(response.data.spotifyAuthenticated);
      
      const shouldAutoSelect = response.data.autoSelectDevice !== false;
      
      // Only proceed if authenticated (or auth not required)
      if (response.data.authenticated) {
        if (response.data.spotifyAuthenticated) {
          fetchDevices(shouldAutoSelect);
        }
        if (response.data.soggfyConnected) {
          fetchConfig();
        }
      }
    } catch (error) {
      console.error('Health check failed:', error);
    }
  };

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoginError('');
    
    try {
      const response = await axios.post(`${API_BASE}/login`, loginForm);
      if (response.data.sessionId) {
        setSessionId(response.data.sessionId);
        localStorage.setItem('sessionId', response.data.sessionId);
        setLoggedIn(true);
        checkHealth();
      }
    } catch (error) {
      setLoginError(error.response?.data?.error || 'Login failed');
    }
  };

  const handleLogout = async () => {
    try {
      await axios.post(`${API_BASE}/logout`);
    } catch (error) {
      console.error('Logout failed:', error);
    }
    setSessionId('');
    localStorage.removeItem('sessionId');
    setLoggedIn(false);
  };

  const fetchConfig = async () => {
    try {
      const response = await axios.get(`${API_BASE}/config`);
      setSoggfyConfig(response.data);
    } catch (error) {
      console.error('Failed to fetch config:', error);
    }
  };

  const fetchDevices = async (autoSelect = false) => {
    try {
      const response = await axios.get(`${API_BASE}/devices`);
      const deviceList = response.data.devices || [];
      setDevices(deviceList);
      
      // Only auto-select if explicitly requested AND only one device exists
      if (autoSelect && deviceList.length === 1) {
        const deviceId = deviceList[0].id;
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

  if (authRequired && !loggedIn) {
    return (
      <div className="app">
        <div className="auth-container">
          <h1>Soggfy Web UI</h1>
          <p>Please log in to continue</p>
          <form onSubmit={handleLogin} className="login-form">
            {loginError && <div className="login-error">{loginError}</div>}
            <input
              type="text"
              placeholder="Username"
              value={loginForm.username}
              onChange={(e) => setLoginForm({ ...loginForm, username: e.target.value })}
              required
            />
            <input
              type="password"
              placeholder="Password"
              value={loginForm.password}
              onChange={(e) => setLoginForm({ ...loginForm, password: e.target.value })}
              required
            />
            <button type="submit" className="auth-button">Login</button>
          </form>
        </div>
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
          <button onClick={() => fetchDevices(false)} className="refresh-button">
            Refresh Devices
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="app-layout">
      <aside className="sidebar">
        <div className="sidebar-header">
          <h1>Soggfy</h1>
          <span className={`status-dot ${soggfyConnected ? 'connected' : 'disconnected'}`} title={soggfyConnected ? 'Connected' : 'Disconnected'}></span>
        </div>
        
        <nav className="sidebar-nav">
          <button onClick={() => setShowSearch(true)} className="nav-item primary">
            <span className="nav-icon">🔍</span>
            <span className="nav-label">Search</span>
          </button>
          <button onClick={() => setShowPlaylists(true)} className="nav-item">
            <span className="nav-icon">📋</span>
            <span className="nav-label">Playlists</span>
          </button>
          <button onClick={() => setShowHistory(true)} className="nav-item">
            <span className="nav-icon">📜</span>
            <span className="nav-label">History</span>
          </button>
          <button onClick={() => setShowSchedules(true)} className="nav-item">
            <span className="nav-icon">⏰</span>
            <span className="nav-label">Schedules</span>
          </button>
          <button onClick={() => setShowFileBrowser(true)} className="nav-item">
            <span className="nav-icon">📁</span>
            <span className="nav-label">Files</span>
          </button>
          
          <div className="nav-divider"></div>
          
          <button onClick={() => setShowStatistics(true)} className="nav-item">
            <span className="nav-icon">📊</span>
            <span className="nav-label">Statistics</span>
          </button>
          <button onClick={() => setShowNotifications(true)} className="nav-item">
            <span className="nav-icon">🔔</span>
            <span className="nav-label">Notifications</span>
          </button>
          <button onClick={() => setShowSettings(true)} className="nav-item">
            <span className="nav-icon">⚙️</span>
            <span className="nav-label">Settings</span>
          </button>
        </nav>
        
        <div className="sidebar-footer">
          {authRequired && (
            <button onClick={handleLogout} className="logout-btn">
              <span className="nav-icon">🚪</span>
              <span className="nav-label">Logout</span>
            </button>
          )}
          <a href="https://x.com/KorOglan" target="_blank" rel="noopener noreferrer" className="credit-link">
            @KorOglan
          </a>
        </div>
      </aside>

      <main className="main-content">

      {showSettings && (
        <Settings
          config={soggfyConfig}
          onClose={() => setShowSettings(false)}
          onConfigUpdate={setSoggfyConfig}
        />
      )}

      {showStatistics && (
        <Statistics
          onClose={() => setShowStatistics(false)}
          sessionId={sessionId}
        />
      )}

      {showPlaylists && (
        <Playlists
          onClose={() => setShowPlaylists(false)}
          sessionId={sessionId}
        />
      )}

      {showHistory && (
        <History
          onClose={() => setShowHistory(false)}
          sessionId={sessionId}
        />
      )}

      {showSchedules && (
        <Schedules
          onClose={() => setShowSchedules(false)}
          sessionId={sessionId}
        />
      )}

      {showSearch && (
        <Search
          onClose={() => setShowSearch(false)}
          sessionId={sessionId}
        />
      )}

      {showNotifications && (
        <Notifications
          onClose={() => setShowNotifications(false)}
          sessionId={sessionId}
        />
      )}

      {showFileBrowser && (
        <FileBrowser
          onClose={() => setShowFileBrowser(false)}
          sessionId={sessionId}
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
      </main>
    </div>
  );
}

export default App;
