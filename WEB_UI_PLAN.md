# Soggfy Web UI Implementation Plan

## 🎯 Proje Hedefi

Soggfy'ye web tabanlı bir arayüz ekleyerek Spotify linklerinden otomatik download yapabilme özelliği kazandırmak.

## 📊 Seçilen Yaklaşım

**MVP: Local Web UI + Desktop Client Kontrolü**

- **Deployment:** Local (aynı bilgisayarda)
- **Süre:** 1-2 hafta
- **Tech Stack:** Node.js (backend) + React (frontend)
- **Mimari:** Mevcut Soggfy altyapısını kullanma

---

## ⚠️ Önemli Teknik Notlar

Bu plan Soggfy kaynak kodu analiz edilerek hazırlanmıştır. Aşağıdaki detaylara dikkat edilmelidir:

| Konu | Detay |
|------|-------|
| **WebSocket URL** | `ws://127.0.0.1:28653/sgf_ctrl` - Path (`/sgf_ctrl`) zorunludur |
| **Status Değerleri** | `IN_PROGRESS`, `CONVERTING`, `DONE`, `ERROR` (UPPERCASE) |
| **Track Eşleştirme** | Soggfy `trackUri` (`spotify:track:XXX`) kullanır, `playbackId` değil |
| **Progress** | Soggfy progress yüzdesi göndermez, sadece status değişiklikleri |
| **Config Sync** | Bağlantı kurulduğunda Soggfy `SYNC_CONFIG` mesajı gönderir |
| **Token Refresh** | Spotify access token'ları 1 saat sonra expire olur, refresh gerekir |
| **URL Desteği** | Track, Album ve Playlist URL'leri desteklenir |
| **Reconnect** | WebSocket bağlantısı kesilirse exponential backoff ile yeniden bağlanır |

---

## 🏗️ Sistem Mimarisi

```
┌─────────────────┐
│  React Web UI   │  (http://localhost:3000)
│  - Link input   │
│  - Queue view   │
│  - Status       │
└────────┬────────┘
         │ HTTP/WebSocket
         ↓
┌─────────────────┐
│ Node.js Backend │  (http://localhost:3001)
│  - REST API     │
│  - Queue Mgr    │
│  - Spotify API  │
└────────┬────────┘
         │ WebSocket (port 28653)
         ↓
┌─────────────────┐
│ Soggfy + Client │
│  - Audio hooks  │
│  - Downloads    │
└─────────────────┘
```

### İletişim Akışı

1. User → Web UI'ya Spotify linki girer
2. Web UI → Backend'e HTTP POST
3. Backend → Spotify Web API'den track metadata alır
4. Backend → Queue'ya ekler ve Spotify client'a play komutu gönderir
5. Spotify Client → Track'i oynatır
6. Soggfy DLL → Audio'yu yakalar ve kaydeder
7. Soggfy → Backend'e WebSocket ile completion mesajı
8. Backend → Web UI'ya status güncellemesi

---

## 📁 Proje Yapısı

```
soggfy-web/
├── backend/
│   ├── server.js              # Express API sunucusu
│   ├── soggfyClient.js        # Soggfy WebSocket client
│   ├── spotifyAuth.js         # OAuth + Spotify Web API
│   ├── queueManager.js        # Download queue yönetimi
│   ├── package.json
│   └── .env                   # Spotify credentials
│
├── frontend/
│   ├── src/
│   │   ├── App.jsx            # Ana UI component
│   │   ├── components/
│   │   │   ├── LinkInput.jsx
│   │   │   ├── QueueList.jsx
│   │   │   └── StatusCard.jsx
│   │   └── index.js
│   ├── package.json
│   └── public/
│
└── README.md
```

---

## 💻 Backend Implementasyonu

### 1. Soggfy WebSocket Client

**Dosya:** `backend/soggfyClient.js`

```javascript
const WebSocket = require('ws');

class SoggfyClient {
  constructor() {
    this.ws = null;
    this.callbacks = new Map();
    this.isConnected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
  }

  connect() {
    // IMPORTANT: Must include /sgf_ctrl path
    this.ws = new WebSocket('ws://127.0.0.1:28653/sgf_ctrl');

    this.ws.on('open', () => {
      console.log('Connected to Soggfy ControlServer');
      this.isConnected = true;
      this.reconnectAttempts = 0;
      
      // Emit connected event for state recovery
      const callback = this.callbacks.get('connected');
      if (callback) callback();
    });

    this.ws.on('message', (data) => {
      const msg = this.parseMessage(data);
      const callback = this.callbacks.get(msg.type);
      if (callback) callback(msg.content, msg.binary);
    });

    this.ws.on('error', (error) => {
      console.error('WebSocket error:', error);
    });

    this.ws.on('close', () => {
      this.isConnected = false;
      console.log('Disconnected from Soggfy');
      
      // Emit disconnected event
      const callback = this.callbacks.get('disconnected');
      if (callback) callback();
      
      // Reconnect with exponential backoff
      if (this.reconnectAttempts < this.maxReconnectAttempts) {
        const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
        this.reconnectAttempts++;
        console.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})...`);
        setTimeout(() => this.connect(), delay);
      } else {
        console.error('Max reconnection attempts reached');
      }
    });
  }

  send(type, content, binary = Buffer.alloc(0)) {
    // Soggfy message format: [type:u8][len:i32][json][binary]
    const jsonStr = JSON.stringify(content);
    const jsonBuffer = Buffer.from(jsonStr, 'utf8');
    const buffer = Buffer.alloc(5 + jsonBuffer.length + binary.length);

    buffer.writeUInt8(type, 0);
    buffer.writeInt32LE(jsonBuffer.length, 1);
    jsonBuffer.copy(buffer, 5);
    if (binary.length > 0) binary.copy(buffer, 5 + jsonBuffer.length);

    this.ws.send(buffer);
  }

  parseMessage(buffer) {
    const type = buffer.readUInt8(0);
    const jsonLen = buffer.readInt32LE(1);
    const jsonStr = buffer.toString('utf8', 5, 5 + jsonLen);
    const binary = buffer.slice(5 + jsonLen);

    return {
      type,
      content: JSON.parse(jsonStr),
      binary
    };
  }

  on(messageType, callback) {
    this.callbacks.set(messageType, callback);
  }
}

module.exports = SoggfyClient;
```

### 2. Spotify Web API Integration

**Dosya:** `backend/spotifyAuth.js`

```javascript
const axios = require('axios');

class SpotifyAPI {
  constructor(clientId, clientSecret) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.accessToken = null;
    this.userAccessToken = null; // OAuth token for playback control
    this.refreshToken = null;    // For token refresh
    this.tokenExpiresAt = null;  // Token expiration timestamp
  }

  // Client Credentials Flow (metadata için)
  async getAccessToken() {
    const response = await axios.post(
      'https://accounts.spotify.com/api/token',
      'grant_type=client_credentials',
      {
        headers: {
          'Authorization': 'Basic ' + Buffer.from(
            this.clientId + ':' + this.clientSecret
          ).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );

    this.accessToken = response.data.access_token;
    return this.accessToken;
  }

  // User Authorization (playback control için)
  getAuthUrl(redirectUri) {
    const scopes = 'user-modify-playback-state user-read-playback-state';
    return `https://accounts.spotify.com/authorize?` +
      `response_type=code&` +
      `client_id=${this.clientId}&` +
      `scope=${encodeURIComponent(scopes)}&` +
      `redirect_uri=${encodeURIComponent(redirectUri)}`;
  }

  async exchangeCode(code, redirectUri) {
    const response = await axios.post(
      'https://accounts.spotify.com/api/token',
      new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: redirectUri
      }),
      {
        headers: {
          'Authorization': 'Basic ' + Buffer.from(
            this.clientId + ':' + this.clientSecret
          ).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );

    this.userAccessToken = response.data.access_token;
    this.refreshToken = response.data.refresh_token;
    // Token expires in 1 hour, refresh 5 min before
    this.tokenExpiresAt = Date.now() + (response.data.expires_in - 300) * 1000;
    return response.data;
  }

  // Token refresh (Spotify tokens expire after 1 hour)
  async refreshAccessToken() {
    if (!this.refreshToken) {
      throw new Error('No refresh token available');
    }

    const response = await axios.post(
      'https://accounts.spotify.com/api/token',
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.refreshToken
      }),
      {
        headers: {
          'Authorization': 'Basic ' + Buffer.from(
            this.clientId + ':' + this.clientSecret
          ).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );

    this.userAccessToken = response.data.access_token;
    // Refresh token may or may not be returned
    if (response.data.refresh_token) {
      this.refreshToken = response.data.refresh_token;
    }
    this.tokenExpiresAt = Date.now() + (response.data.expires_in - 300) * 1000;
    console.log('Access token refreshed');
    return response.data;
  }

  // Check and refresh token if needed
  async ensureValidToken() {
    if (this.tokenExpiresAt && Date.now() >= this.tokenExpiresAt) {
      await this.refreshAccessToken();
    }
  }

  async getTrackInfo(trackId) {
    if (!this.accessToken) await this.getAccessToken();

    const response = await axios.get(
      `https://api.spotify.com/v1/tracks/${trackId}`,
      {
        headers: { 'Authorization': `Bearer ${this.accessToken}` }
      }
    );

    return {
      id: response.data.id,
      name: response.data.name,
      artist: response.data.artists[0].name,
      album: response.data.album.name,
      duration: response.data.duration_ms,
      uri: response.data.uri
    };
  }

  async getDevices() {
    await this.ensureValidToken();
    const response = await axios.get(
      'https://api.spotify.com/v1/me/player/devices',
      {
        headers: { 'Authorization': `Bearer ${this.userAccessToken}` }
      }
    );
    return response.data.devices;
  }

  async playTrack(trackUri, deviceId = null) {
    await this.ensureValidToken();
    const url = deviceId
      ? `https://api.spotify.com/v1/me/player/play?device_id=${deviceId}`
      : 'https://api.spotify.com/v1/me/player/play';

    await axios.put(
      url,
      { uris: [trackUri] },
      {
        headers: {
          'Authorization': `Bearer ${this.userAccessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );
  }

  // Get all tracks from an album
  async getAlbumTracks(albumId) {
    if (!this.accessToken) await this.getAccessToken();

    const response = await axios.get(
      `https://api.spotify.com/v1/albums/${albumId}`,
      {
        headers: { 'Authorization': `Bearer ${this.accessToken}` }
      }
    );

    return response.data.tracks.items.map(track => ({
      id: track.id,
      name: track.name,
      artist: track.artists[0].name,
      album: response.data.name,
      duration: track.duration_ms,
      uri: track.uri
    }));
  }

  // Get all tracks from a playlist
  async getPlaylistTracks(playlistId) {
    if (!this.accessToken) await this.getAccessToken();

    const tracks = [];
    let url = `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=100`;

    // Handle pagination (playlists can have 10,000+ tracks)
    while (url) {
      const response = await axios.get(url, {
        headers: { 'Authorization': `Bearer ${this.accessToken}` }
      });

      for (const item of response.data.items) {
        if (item.track && item.track.type === 'track') {
          tracks.push({
            id: item.track.id,
            name: item.track.name,
            artist: item.track.artists[0]?.name || 'Unknown',
            album: item.track.album?.name || 'Unknown',
            duration: item.track.duration_ms,
            uri: item.track.uri
          });
        }
      }
      url = response.data.next;
    }
    return tracks;
  }

  // Parse any Spotify URL (track, album, or playlist)
  parseSpotifyUrl(url) {
    // Track: https://open.spotify.com/track/XXXXX or spotify:track:XXXXX
    const trackMatch = url.match(/track[\/:]([a-zA-Z0-9]+)/);
    if (trackMatch) {
      return { type: 'track', id: trackMatch[1] };
    }

    // Album: https://open.spotify.com/album/XXXXX or spotify:album:XXXXX
    const albumMatch = url.match(/album[\/:]([a-zA-Z0-9]+)/);
    if (albumMatch) {
      return { type: 'album', id: albumMatch[1] };
    }

    // Playlist: https://open.spotify.com/playlist/XXXXX or spotify:playlist:XXXXX
    const playlistMatch = url.match(/playlist[\/:]([a-zA-Z0-9]+)/);
    if (playlistMatch) {
      return { type: 'playlist', id: playlistMatch[1] };
    }

    return null;
  }

  // Legacy method for backward compatibility
  parseTrackId(url) {
    const parsed = this.parseSpotifyUrl(url);
    return parsed?.type === 'track' ? parsed.id : null;
  }
}

module.exports = SpotifyAPI;
```

### 3. Queue Manager

**Dosya:** `backend/queueManager.js`

```javascript
// Soggfy Message Types (from ControlServer.h)
const MessageType = {
  SYNC_CONFIG: 1,
  TRACK_META: 2,
  DOWNLOAD_STATUS: 3,
  OPEN_FOLDER: 4,
  OPEN_FILE_PICKER: 5,
  WRITE_FILE: 6,
  PLAYER_STATE: 7
};

// Soggfy Status Values (UPPERCASE)
const DownloadStatus = {
  IN_PROGRESS: 'IN_PROGRESS',
  CONVERTING: 'CONVERTING',
  DONE: 'DONE',
  ERROR: 'ERROR'
};

class QueueManager {
  constructor(soggfyClient, spotifyAPI) {
    this.queue = [];
    this.currentTrack = null;
    this.completedTracks = [];
    this.soggfyClient = soggfyClient;
    this.spotifyAPI = spotifyAPI;
    this.deviceId = null;
    this.soggfyConfig = null;

    // Listen for config sync from Soggfy (sent on connection)
    soggfyClient.on(MessageType.SYNC_CONFIG, (data) => {
      this.soggfyConfig = data;
      console.log('Received Soggfy config:', data);
    });

    // Listen for download status updates from Soggfy
    soggfyClient.on(MessageType.DOWNLOAD_STATUS, (data) => {
      this.handleDownloadStatus(data);
    });

    // Handle reconnection - config will be re-sent by Soggfy
    soggfyClient.on('connected', () => {
      console.log('Soggfy reconnected, config will be synced automatically');
    });

    soggfyClient.on('disconnected', () => {
      console.log('Soggfy disconnected, pausing queue processing');
      // Don't clear soggfyConfig - it will be refreshed on reconnect
    });
  }

  setDeviceId(deviceId) {
    this.deviceId = deviceId;
  }

  // Add any Spotify URL (track, album, or playlist)
  async addUrl(spotifyUrl) {
    const parsed = this.spotifyAPI.parseSpotifyUrl(spotifyUrl);
    if (!parsed) {
      throw new Error('Invalid Spotify URL');
    }

    let tracks = [];

    switch (parsed.type) {
      case 'track':
        const trackInfo = await this.spotifyAPI.getTrackInfo(parsed.id);
        tracks = [trackInfo];
        break;

      case 'album':
        tracks = await this.spotifyAPI.getAlbumTracks(parsed.id);
        console.log(`Adding album with ${tracks.length} tracks`);
        break;

      case 'playlist':
        tracks = await this.spotifyAPI.getPlaylistTracks(parsed.id);
        console.log(`Adding playlist with ${tracks.length} tracks`);
        break;
    }

    const addedTracks = [];
    for (const trackInfo of tracks) {
      // Skip if already in queue or downloading
      if (this.currentTrack?.id === trackInfo.id ||
          this.queue.some(t => t.id === trackInfo.id)) {
        console.log(`Skipping duplicate: ${trackInfo.name}`);
        continue;
      }

      const track = {
        ...trackInfo,
        status: 'queued',
        addedAt: Date.now()
      };

      this.queue.push(track);
      addedTracks.push(track);
    }

    console.log(`Added ${addedTracks.length} tracks to queue`);

    // Start processing if nothing is downloading
    this.processQueue();

    return addedTracks;
  }

  // Legacy method for backward compatibility
  async addTrack(spotifyUrl) {
    const result = await this.addUrl(spotifyUrl);
    return result[0];
  }

  async processQueue() {
    // Don't start new download if one is already in progress
    if (this.currentTrack || this.queue.length === 0) {
      return;
    }

    this.currentTrack = this.queue.shift();
    this.currentTrack.status = 'downloading';
    this.currentTrack.startedAt = Date.now();

    console.log(`Starting download: ${this.currentTrack.name}`);

    try {
      // Trigger playback via Spotify Web API
      await this.spotifyAPI.playTrack(
        this.currentTrack.uri,
        this.deviceId
      );
    } catch (error) {
      console.error('Failed to start playback:', error.message);
      this.currentTrack.status = 'error';
      this.currentTrack.error = error.message;
      this.completedTracks.push(this.currentTrack);
      this.currentTrack = null;

      // Try next track
      setTimeout(() => this.processQueue(), 2000);
    }
  }

  handleDownloadStatus(data) {
    console.log('Download status update:', data);

    // Soggfy sends status with trackUri (spotify:track:XXX) in results object
    // Format: { results: { "spotify:track:XXX": { status, message, path } } }
    // Or for playbackId: { playbackId: "xxx", status, message }
    
    let trackUri = null;
    let statusInfo = null;

    if (data.results) {
      // Status update with trackUri
      const entries = Object.entries(data.results);
      if (entries.length > 0) {
        [trackUri, statusInfo] = entries[0];
      }
    } else if (data.playbackId) {
      // Status update with playbackId (less common)
      statusInfo = data;
    }

    if (!statusInfo) return;

    // Match by trackUri (spotify:track:XXX format)
    if (this.currentTrack && trackUri) {
      if (this.currentTrack.uri !== trackUri) {
        console.log(`Status for different track: ${trackUri}`);
        return;
      }
    }

    if (!this.currentTrack) return;

    const status = statusInfo.status;

    // Update status display
    if (status === DownloadStatus.CONVERTING) {
      this.currentTrack.status = 'converting';
    } else if (status === DownloadStatus.IN_PROGRESS) {
      this.currentTrack.status = 'downloading';
    }

    // Check for completion (Soggfy uses UPPERCASE status values)
    if (status === DownloadStatus.DONE) {
      console.log(`Download completed: ${this.currentTrack.name}`);
      this.currentTrack.status = 'completed';
      this.currentTrack.completedAt = Date.now();
      this.currentTrack.path = statusInfo.path;
      this.completedTracks.push(this.currentTrack);
      this.currentTrack = null;

      // Process next track in queue
      setTimeout(() => this.processQueue(), 1000);
    } else if (status === DownloadStatus.ERROR) {
      console.error(`Download failed: ${this.currentTrack.name}`);
      this.currentTrack.status = 'error';
      this.currentTrack.error = statusInfo.message || 'Download failed';
      this.completedTracks.push(this.currentTrack);
      this.currentTrack = null;

      // Try next track
      setTimeout(() => this.processQueue(), 2000);
    }
  }

  getStatus() {
    return {
      current: this.currentTrack,
      queue: this.queue,
      completed: this.completedTracks.slice(-10) // Last 10 completed
    };
  }

  clearCompleted() {
    this.completedTracks = [];
  }
}

module.exports = QueueManager;
```

### 4. Express Server

**Dosya:** `backend/server.js`

```javascript
const express = require('express');
const cors = require('cors');
require('dotenv').config();

const SoggfyClient = require('./soggfyClient');
const SpotifyAPI = require('./spotifyAuth');
const QueueManager = require('./queueManager');

const app = express();
app.use(cors());
app.use(express.json());

// Initialize services
const soggfy = new SoggfyClient();
const spotify = new SpotifyAPI(
  process.env.SPOTIFY_CLIENT_ID,
  process.env.SPOTIFY_CLIENT_SECRET
);
const queue = new QueueManager(soggfy, spotify);

// Connect to Soggfy
soggfy.connect();

// OAuth callback handler
app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;

  try {
    await spotify.exchangeCode(code, 'http://localhost:3001/auth/callback');
    res.send('<h1>✅ Authentication successful!</h1><p>You can close this window.</p>');
  } catch (error) {
    res.status(400).send('<h1>❌ Authentication failed</h1><p>' + error.message + '</p>');
  }
});

// Get auth URL
app.get('/api/auth/url', (req, res) => {
  const url = spotify.getAuthUrl('http://localhost:3001/auth/callback');
  res.json({ url });
});

// Get available Spotify devices
app.get('/api/devices', async (req, res) => {
  try {
    const devices = await spotify.getDevices();
    res.json({ devices });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Set active device
app.post('/api/device', (req, res) => {
  const { deviceId } = req.body;
  queue.setDeviceId(deviceId);
  res.json({ success: true });
});

// Add track to download queue
app.post('/api/download', async (req, res) => {
  try {
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    const track = await queue.addTrack(url);
    res.json({ success: true, track });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Get queue status
app.get('/api/queue', (req, res) => {
  res.json(queue.getStatus());
});

// Clear completed tracks
app.post('/api/queue/clear', (req, res) => {
  queue.clearCompleted();
  res.json({ success: true });
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    soggfyConnected: soggfy.ws?.readyState === 1,
    spotifyAuthenticated: !!spotify.userAccessToken
  });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 Backend running on http://localhost:${PORT}`);
  console.log(`🔗 Spotify Auth: http://localhost:${PORT}/api/auth/url`);
});
```

### 5. Package.json

**Dosya:** `backend/package.json`

```json
{
  "name": "soggfy-web-backend",
  "version": "1.0.0",
  "description": "Backend for Soggfy Web UI",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "nodemon server.js"
  },
  "dependencies": {
    "express": "^4.18.2",
    "cors": "^2.8.5",
    "ws": "^8.14.2",
    "axios": "^1.6.0",
    "dotenv": "^16.3.1"
  },
  "devDependencies": {
    "nodemon": "^3.0.1"
  }
}
```

### 6. Environment Variables

**Dosya:** `backend/.env`

```env
# Spotify App Credentials
# Get these from: https://developer.spotify.com/dashboard
SPOTIFY_CLIENT_ID=your_client_id_here
SPOTIFY_CLIENT_SECRET=your_client_secret_here

# Server Port
PORT=3001
```

---

## 🎨 Frontend Implementasyonu

### 1. Main App Component

**Dosya:** `frontend/src/App.jsx`

```jsx
import React, { useState, useEffect } from 'react';
import axios from 'axios';
import './App.css';

const API_BASE = 'http://localhost:3001/api';

function App() {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [queue, setQueue] = useState({ current: null, queue: [], completed: [] });
  const [devices, setDevices] = useState([]);
  const [selectedDevice, setSelectedDevice] = useState('');
  const [authenticated, setAuthenticated] = useState(false);
  const [health, setHealth] = useState(null);

  useEffect(() => {
    checkHealth();
    const healthInterval = setInterval(checkHealth, 5000);
    return () => clearInterval(healthInterval);
  }, []);

  useEffect(() => {
    if (authenticated) {
      fetchQueue();
      const queueInterval = setInterval(fetchQueue, 2000);
      return () => clearInterval(queueInterval);
    }
  }, [authenticated]);

  const checkHealth = async () => {
    try {
      const response = await axios.get(`${API_BASE}/health`);
      setHealth(response.data);
      setAuthenticated(response.data.spotifyAuthenticated);
    } catch (error) {
      console.error('Health check failed:', error);
    }
  };

  const fetchQueue = async () => {
    try {
      const response = await axios.get(`${API_BASE}/queue`);
      setQueue(response.data);
    } catch (error) {
      console.error('Failed to fetch queue:', error);
    }
  };

  const handleAuth = async () => {
    try {
      const response = await axios.get(`${API_BASE}/auth/url`);
      window.open(response.data.url, '_blank', 'width=500,height=700');

      // Poll for auth completion
      const checkAuth = setInterval(async () => {
        await checkHealth();
        if (health?.spotifyAuthenticated) {
          clearInterval(checkAuth);
          await fetchDevices();
        }
      }, 2000);
    } catch (error) {
      alert('Failed to start authentication');
    }
  };

  const fetchDevices = async () => {
    try {
      const response = await axios.get(`${API_BASE}/devices`);
      setDevices(response.data.devices);
      if (response.data.devices.length === 1) {
        setSelectedDevice(response.data.devices[0].id);
        await selectDevice(response.data.devices[0].id);
      }
    } catch (error) {
      console.error('Failed to fetch devices:', error);
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
      await axios.post(`${API_BASE}/download`, { url });
      setUrl('');
      await fetchQueue();
    } catch (error) {
      alert('Error: ' + (error.response?.data?.error || error.message));
    } finally {
      setLoading(false);
    }
  };

  const handleClearCompleted = async () => {
    try {
      await axios.post(`${API_BASE}/queue/clear`);
      await fetchQueue();
    } catch (error) {
      console.error('Failed to clear completed:', error);
    }
  };

  const formatDuration = (ms) => {
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  if (!health) {
    return (
      <div className="app loading">
        <h2>🔄 Connecting to Soggfy...</h2>
      </div>
    );
  }

  if (!health.soggfyConnected) {
    return (
      <div className="app error">
        <h2>❌ Cannot connect to Soggfy</h2>
        <p>Make sure Spotify with Soggfy mod is running.</p>
      </div>
    );
  }

  if (!authenticated) {
    return (
      <div className="app">
        <div className="auth-container">
          <h1>🎵 Soggfy Web Downloader</h1>
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
          <select onChange={(e) => selectDevice(e.target.value)} defaultValue="">
            <option value="" disabled>Choose a device...</option>
            {devices.map(device => (
              <option key={device.id} value={device.id}>
                {device.name} ({device.type})
              </option>
            ))}
          </select>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <header>
        <h1>🎵 Soggfy Web Downloader</h1>
        <div className="status">
          <span className="status-indicator">
            {health.soggfyConnected ? '🟢' : '🔴'} Soggfy
          </span>
        </div>
      </header>

      <div className="content">
        <form onSubmit={handleSubmit} className="url-form">
          <input
            type="text"
            placeholder="Paste Spotify track URL here..."
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={loading}
          />
          <button type="submit" disabled={loading}>
            {loading ? '⏳ Adding...' : '➕ Add to Queue'}
          </button>
        </form>

        {queue.current && (
          <div className="current-download">
            <h3>📥 Currently Downloading</h3>
            <div className="track-card">
              <div className="track-info">
                <div className="track-name">{queue.current.name}</div>
                <div className="track-artist">{queue.current.artist}</div>
              </div>
              <div className="track-status">
                <span className="status-badge">{queue.current.status}</span>
              </div>
            </div>
          </div>
        )}

        {queue.queue.length > 0 && (
          <div className="queue-section">
            <h3>⏳ Queue ({queue.queue.length} tracks)</h3>
            {queue.queue.map((track, i) => (
              <div key={i} className="track-card small">
                <div className="queue-number">{i + 1}</div>
                <div className="track-info">
                  <div className="track-name">{track.name}</div>
                  <div className="track-artist">{track.artist}</div>
                </div>
                <div className="track-duration">
                  {formatDuration(track.duration)}
                </div>
              </div>
            ))}
          </div>
        )}

        {queue.completed.length > 0 && (
          <div className="completed-section">
            <div className="section-header">
              <h3>✅ Completed ({queue.completed.length})</h3>
              <button onClick={handleClearCompleted} className="clear-button">
                Clear
              </button>
            </div>
            {queue.completed.map((track, i) => (
              <div key={i} className="track-card small completed">
                <div className="track-info">
                  <div className="track-name">{track.name}</div>
                  <div className="track-artist">{track.artist}</div>
                </div>
                <span className={`status-badge ${track.status}`}>
                  {track.status === 'completed' ? '✓' : '✗'}
                </span>
              </div>
            ))}
          </div>
        )}

        {!queue.current && queue.queue.length === 0 && queue.completed.length === 0 && (
          <div className="empty-state">
            <p>🎶 No tracks in queue</p>
            <p className="hint">Paste a Spotify track URL above to get started</p>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
```

### 2. Styles

**Dosya:** `frontend/src/App.css`

```css
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  min-height: 100vh;
}

.app {
  max-width: 900px;
  margin: 0 auto;
  padding: 20px;
  min-height: 100vh;
}

.app.loading,
.app.error {
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
  text-align: center;
}

header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  color: white;
  margin-bottom: 30px;
}

header h1 {
  font-size: 2rem;
}

.status {
  display: flex;
  gap: 10px;
}

.status-indicator {
  background: rgba(255, 255, 255, 0.2);
  padding: 8px 16px;
  border-radius: 20px;
  font-size: 0.9rem;
}

.content {
  background: white;
  border-radius: 16px;
  padding: 30px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
}

.url-form {
  display: flex;
  gap: 10px;
  margin-bottom: 30px;
}

.url-form input {
  flex: 1;
  padding: 14px 20px;
  border: 2px solid #e0e0e0;
  border-radius: 8px;
  font-size: 1rem;
  transition: border-color 0.3s;
}

.url-form input:focus {
  outline: none;
  border-color: #667eea;
}

.url-form button {
  padding: 14px 28px;
  background: #667eea;
  color: white;
  border: none;
  border-radius: 8px;
  font-size: 1rem;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.3s;
}

.url-form button:hover:not(:disabled) {
  background: #5568d3;
}

.url-form button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.current-download,
.queue-section,
.completed-section {
  margin-bottom: 30px;
}

.current-download h3,
.queue-section h3,
.completed-section h3 {
  margin-bottom: 15px;
  color: #333;
  font-size: 1.2rem;
}

.track-card {
  background: #f8f9fa;
  border-radius: 12px;
  padding: 20px;
  display: flex;
  align-items: center;
  gap: 15px;
  margin-bottom: 10px;
  transition: transform 0.2s;
}

.track-card:hover {
  transform: translateX(5px);
}

.track-card.small {
  padding: 15px;
}

.track-card.completed {
  opacity: 0.7;
}

.queue-number {
  background: #667eea;
  color: white;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  flex-shrink: 0;
}

.track-info {
  flex: 1;
  min-width: 0;
}

.track-name {
  font-weight: 600;
  font-size: 1rem;
  margin-bottom: 4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.track-artist {
  color: #666;
  font-size: 0.9rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.track-duration {
  color: #999;
  font-size: 0.9rem;
  font-variant-numeric: tabular-nums;
}

.track-status {
  display: flex;
  align-items: center;
  min-width: 100px;
  justify-content: flex-end;
}

.status-badge {
  background: #667eea;
  color: white;
  padding: 4px 12px;
  border-radius: 12px;
  font-size: 0.85rem;
  font-weight: 600;
  text-transform: capitalize;
}

.status-badge.completed {
  background: #10b981;
}

.status-badge.error {
  background: #ef4444;
}

.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 15px;
}

.clear-button {
  padding: 6px 16px;
  background: #ef4444;
  color: white;
  border: none;
  border-radius: 6px;
  font-size: 0.9rem;
  cursor: pointer;
  transition: background 0.3s;
}

.clear-button:hover {
  background: #dc2626;
}

.empty-state {
  text-align: center;
  padding: 60px 20px;
  color: #999;
}

.empty-state p {
  margin-bottom: 10px;
  font-size: 1.1rem;
}

.empty-state .hint {
  font-size: 0.95rem;
}

.auth-container,
.device-selector {
  text-align: center;
  background: white;
  padding: 60px 40px;
  border-radius: 16px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
}

.auth-container h1 {
  color: #333;
  margin-bottom: 20px;
}

.auth-button {
  margin-top: 30px;
  padding: 16px 40px;
  background: #1DB954;
  color: white;
  border: none;
  border-radius: 30px;
  font-size: 1.1rem;
  font-weight: 600;
  cursor: pointer;
  transition: transform 0.2s, background 0.3s;
}

.auth-button:hover {
  background: #1ed760;
  transform: scale(1.05);
}

.device-selector select {
  width: 100%;
  max-width: 400px;
  padding: 14px 20px;
  margin-top: 20px;
  border: 2px solid #e0e0e0;
  border-radius: 8px;
  font-size: 1rem;
  cursor: pointer;
}
```

### 3. Package.json

**Dosya:** `frontend/package.json`

```json
{
  "name": "soggfy-web-frontend",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "axios": "^1.6.0",
    "react-scripts": "5.0.1"
  },
  "scripts": {
    "start": "react-scripts start",
    "build": "react-scripts build",
    "test": "react-scripts test",
    "eject": "react-scripts eject"
  },
  "eslintConfig": {
    "extends": [
      "react-app"
    ]
  },
  "browserslist": {
    "production": [
      ">0.2%",
      "not dead",
      "not op_mini all"
    ],
    "development": [
      "last 1 chrome version",
      "last 1 firefox version",
      "last 1 safari version"
    ]
  }
}
```

---

## 🚀 Setup ve Kullanım

### Ön Gereksinimler

1. **Node.js 16+** yüklü olmalı
2. **Soggfy** kurulu ve çalışan Spotify client
3. **Spotify Developer Account** (API credentials için)

### Spotify App Oluşturma

1. [Spotify Developer Dashboard](https://developer.spotify.com/dashboard)'a git
2. "Create app" butonuna tıkla
3. Bilgileri doldur:
   - **App name:** Soggfy Web
   - **Redirect URI:** `http://localhost:3001/auth/callback`
4. Client ID ve Client Secret'i kopyala

### Backend Setup

```bash
# Clone veya proje klasörü oluştur
mkdir soggfy-web
cd soggfy-web
mkdir backend
cd backend

# Dependencies yükle
npm install

# .env dosyası oluştur
cat > .env << EOF
SPOTIFY_CLIENT_ID=your_client_id_here
SPOTIFY_CLIENT_SECRET=your_client_secret_here
PORT=3001
EOF

# Sunucuyu başlat
npm start
```

### Frontend Setup

```bash
# Frontend klasörü oluştur
cd ..
npx create-react-app frontend
cd frontend

# Axios yükle
npm install axios

# Geliştirme sunucusunu başlat
npm start
```

### Kullanım Adımları

1. **Spotify'ı başlat** (Soggfy yüklü olmalı)
2. **Backend'i çalıştır:**
   ```bash
   cd backend
   npm start
   ```
3. **Frontend'i çalıştır:**
   ```bash
   cd frontend
   npm start
   ```
4. **Browser'da aç:** http://localhost:3000
5. **Spotify ile authenticate ol**
6. **Device seç** (genellikle Spotify client otomatik tespit edilir)
7. **Spotify track linki yapıştır ve indir!**

---

## 🔧 Soggfy Değişiklikleri (Opsiyonel)

Mevcut Soggfy implementasyonu çoğu durumda değişiklik gerektirmez.

> **Not:** Soggfy şu anda download progress yüzdesi göndermiyor. Sadece status değişikliklerini (IN_PROGRESS, CONVERTING, DONE, ERROR) broadcast ediyor. Progress bar eklemek için C++ tarafında değişiklik gerekir, ancak bu MVP için gerekli değil.

### 1. Yeni Message Type (Opsiyonel)

**Dosya:** `SpotifyOggDumper/ControlServer.h`

Eğer backend'den direkt playback kontrolü istiyorsan:

```cpp
enum class MessageType
{
    // ... existing types ...
    REMOTE_PLAY_TRACK = 8,  // Backend -> Soggfy: Play specific track
};
```

Handler ekle:

```cpp
void StateManagerImpl::HandleMessage(Connection* conn, Message&& msg) {
    if (msg.Type == MessageType::REMOTE_PLAY_TRACK) {
        std::string trackUri = msg.Content["uri"];
        // Spotify client'a play komutu gönder
        // (Implementation depends on chosen method)
    }
}
```

---

## 🐛 Troubleshooting

### Backend Soggfy'ye bağlanamıyor

**Çözüm:**
- Spotify client çalıştığından emin ol
- Soggfy DLL yüklenmiş olmalı (console'da log olmalı)
- `ws://127.0.0.1:28653/sgf_ctrl` erişilebilir mi test et (path dahil!)

### Spotify API "Invalid Device" hatası

**Çözüm:**
- Spotify client aktif olmalı
- Devices endpoint'inden mevcut device'ları listele
- Doğru device ID'yi seç

### Track indirmiyor (playback başlıyor ama dosya yok)

**Çözüm:**
- Track'i **baştan sona çalmak gerekir** (Soggfy requirement)
- Seeking yapılmamalı
- Premium account gerekli (320kbps için)

### OAuth redirect çalışmıyor

**Çözüm:**
- Spotify Dashboard'da redirect URI: `http://localhost:3001/auth/callback`
- Port numarası doğru olmalı
- Browser popup blocker kapalı olmalı

---

## 📊 İleri Seviye Özellikler (Faz 2)

### 1. Playlist Desteği

```javascript
// Backend'de playlist parse etme
async parsePlaylist(playlistUrl) {
  const playlistId = this.parsePlaylistId(playlistUrl);
  const response = await axios.get(
    `https://api.spotify.com/v1/playlists/${playlistId}/tracks`,
    { headers: { 'Authorization': `Bearer ${this.accessToken}` } }
  );

  return response.data.items.map(item => item.track.id);
}
```

### 2. Dosya Formatı Seçimi

Frontend'de format seçeneği:
- MP3 (320kbps)
- FLAC
- OGG (original)
- AAC

Backend'den Soggfy'ye config güncelle

### 3. Batch Download

Birden fazla track'i kuyruğa toplu ekle:

```javascript
app.post('/api/download/batch', async (req, res) => {
  const { urls } = req.body;
  const results = await Promise.allSettled(
    urls.map(url => queue.addTrack(url))
  );
  res.json({ results });
});
```

### 4. Download History

SQLite veya JSON dosyasında geçmiş saklama:

```javascript
const db = new SQLite('downloads.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS downloads (
    id INTEGER PRIMARY KEY,
    track_id TEXT,
    name TEXT,
    artist TEXT,
    downloaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);
```

---

## 🎯 Sonuç

Bu plan ile:

- ✅ **1-2 hafta** sürede MVP hazır
- ✅ **Local deployment** (kendi bilgisayarında çalışır)
- ✅ **Modern web UI** (React)
- ✅ **Mevcut Soggfy altyapısını** kullanır
- ✅ **Spotify link** → **otomatik download**
- ✅ **Queue yönetimi**
- ✅ **Real-time status** updates

### Geliştirme Sırası

1. **Gün 1-2:** Backend (WebSocket client, Spotify API, Queue Manager)
2. **Gün 3-4:** Frontend (React UI, state management)
3. **Gün 5-6:** Entegrasyon ve test
4. **Gün 7:** Bug fixing ve polish

### Sonraki Adımlar

1. Spotify Developer Dashboard'da app oluştur
2. Backend'i setup et ve test et
3. Frontend'i oluştur
4. End-to-end test
5. (Opsiyonel) Soggfy'ye progress reporting ekle

**Başlamaya hazır!** 🚀
