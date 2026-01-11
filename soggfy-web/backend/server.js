const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const http = require('http');
require('dotenv').config();

const { SoggfyClient } = require('./soggfyClient');
const SpotifyAPI = require('./spotifyAuth');
const QueueManager = require('./queueManager');

const app = express();
app.use(cors());
app.use(express.json());

// Auth configuration
const AUTH_ENABLED = process.env.AUTH_ENABLED === 'true';
const AUTH_USER = process.env.AUTH_USER || 'admin';
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || 'changeme';

// Session storage (simple in-memory)
const sessions = new Set();

// Auth middleware
const authMiddleware = (req, res, next) => {
  if (!AUTH_ENABLED) return next();
  
  const sessionId = req.headers['x-session-id'];
  if (sessionId && sessions.has(sessionId)) {
    return next();
  }
  
  res.status(401).json({ error: 'Unauthorized' });
};

// Initialize services
const soggfy = new SoggfyClient();
const spotify = new SpotifyAPI(
  process.env.SPOTIFY_CLIENT_ID,
  process.env.SPOTIFY_CLIENT_SECRET
);
const queue = new QueueManager(soggfy, spotify);

// Create HTTP server for both Express and WebSocket
const server = http.createServer(app);

// WebSocket server for real-time updates to frontend
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  console.log('Frontend client connected');

  // Send current status
  ws.send(JSON.stringify({
    type: 'status',
    data: {
      soggfyConnected: soggfy.isConnected,
      spotifyAuthenticated: !!spotify.userAccessToken,
      queue: queue.getStatus()
    }
  }));

  ws.on('close', () => {
    console.log('Frontend client disconnected');
  });
});

// Broadcast to all connected frontend clients
function broadcast(type, data) {
  const message = JSON.stringify({ type, data });
  wss.clients.forEach(client => {
    if (client.readyState === 1) {
      client.send(message);
    }
  });
}

// Queue manager events -> broadcast to frontend
queue.on('queueUpdate', (status) => {
  broadcast('queueUpdate', status);
});

queue.on('soggfyConnected', () => {
  broadcast('soggfyStatus', { connected: true });
});

queue.on('soggfyDisconnected', () => {
  broadcast('soggfyStatus', { connected: false });
});

queue.on('configSync', (config) => {
  broadcast('configSync', config);
});

// Connect to Soggfy
soggfy.connect();

// OAuth callback handler
app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;

  try {
    await spotify.exchangeCode(code, `http://127.0.0.1:${PORT}/auth/callback`);
    broadcast('authStatus', { authenticated: true });
    res.send(`
      <!DOCTYPE html>
      <html>
      <head><title>Authentication Successful</title></head>
      <body style="font-family: sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);">
        <div style="background: white; padding: 40px; border-radius: 16px; text-align: center; box-shadow: 0 20px 60px rgba(0,0,0,0.3);">
          <h1 style="color: #10b981; margin-bottom: 10px;">✅ Authentication Successful!</h1>
          <p style="color: #666;">You can close this window and return to the app.</p>
        </div>
      </body>
      </html>
    `);
  } catch (error) {
    res.status(400).send(`
      <!DOCTYPE html>
      <html>
      <head><title>Authentication Failed</title></head>
      <body style="font-family: sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #fee2e2;">
        <div style="background: white; padding: 40px; border-radius: 16px; text-align: center;">
          <h1 style="color: #ef4444;">❌ Authentication Failed</h1>
          <p style="color: #666;">${error.message}</p>
        </div>
      </body>
      </html>
    `);
  }
});

// Get auth URL
app.get('/api/auth/url', authMiddleware, (req, res) => {
  const url = spotify.getAuthUrl(`http://127.0.0.1:${PORT}/auth/callback`);
  res.json({ url });
});

// Check auth status
app.get('/api/auth/status', authMiddleware, (req, res) => {
  res.json({ authenticated: !!spotify.userAccessToken });
});

// Get available Spotify devices
app.get('/api/devices', authMiddleware, async (req, res) => {
  try {
    const devices = await spotify.getDevices();
    res.json({ devices });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Set active device
app.post('/api/device', authMiddleware, (req, res) => {
  const { deviceId } = req.body;
  queue.setDeviceId(deviceId);
  res.json({ success: true });
});

// Add URL to download queue (supports track, album, playlist)
app.post('/api/download', authMiddleware, async (req, res) => {
  try {
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    const tracks = await queue.addUrl(url);
    res.json({ success: true, tracks, count: tracks.length });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Get queue status
app.get('/api/queue', authMiddleware, (req, res) => {
  res.json(queue.getStatus());
});

// Clear completed tracks
app.post('/api/queue/clear', authMiddleware, (req, res) => {
  queue.clearCompleted();
  res.json({ success: true });
});

// Remove track from queue
app.delete('/api/queue/:trackId', authMiddleware, (req, res) => {
  const { trackId } = req.params;
  const removed = queue.removeFromQueue(trackId);
  res.json({ success: removed });
});

// Skip current track
app.post('/api/queue/skip', authMiddleware, (req, res) => {
  const skipped = queue.skipCurrent();
  res.json({ success: skipped });
});

// Get Soggfy config
app.get('/api/config', authMiddleware, (req, res) => {
  const config = queue.getConfig();
  if (!config) {
    return res.status(503).json({ error: 'Config not available yet' });
  }
  res.json(config);
});

// Update Soggfy config
app.put('/api/config', authMiddleware, (req, res) => {
  try {
    const updates = req.body;
    if (!updates || Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No config updates provided' });
    }
    const config = queue.updateConfig(updates);
    broadcast('configUpdate', config);
    res.json({ success: true, config });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Health check (public - returns auth requirement info)
app.get('/api/health', (req, res) => {
  const sessionId = req.headers['x-session-id'];
  const isAuthenticated = !AUTH_ENABLED || (sessionId && sessions.has(sessionId));
  
  res.json({
    status: 'ok',
    authRequired: AUTH_ENABLED,
    authenticated: isAuthenticated,
    soggfyConnected: soggfy.isConnected,
    spotifyAuthenticated: !!spotify.userAccessToken,
    autoSelectDevice: process.env.AUTO_SELECT_DEVICE !== 'false'
  });
});

// Login endpoint
app.post('/api/login', (req, res) => {
  if (!AUTH_ENABLED) {
    return res.json({ success: true, message: 'Auth not enabled' });
  }
  
  const { username, password } = req.body;
  
  if (username === AUTH_USER && password === AUTH_PASSWORD) {
    const sessionId = Math.random().toString(36).substring(2) + Date.now().toString(36);
    sessions.add(sessionId);
    res.json({ success: true, sessionId });
  } else {
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

// Logout endpoint
app.post('/api/logout', (req, res) => {
  const sessionId = req.headers['x-session-id'];
  if (sessionId) {
    sessions.delete(sessionId);
  }
  res.json({ success: true });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 Backend running on http://localhost:${PORT}`);
  console.log(`🔗 Spotify Auth: http://localhost:${PORT}/api/auth/url`);
  console.log(`📡 WebSocket: ws://localhost:${PORT}/ws`);
});
