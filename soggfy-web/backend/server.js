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
app.get('/api/auth/url', (req, res) => {
  const url = spotify.getAuthUrl(`http://127.0.0.1:${PORT}/auth/callback`);
  res.json({ url });
});

// Check auth status
app.get('/api/auth/status', (req, res) => {
  res.json({ authenticated: !!spotify.userAccessToken });
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

// Add URL to download queue (supports track, album, playlist)
app.post('/api/download', async (req, res) => {
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
app.get('/api/queue', (req, res) => {
  res.json(queue.getStatus());
});

// Clear completed tracks
app.post('/api/queue/clear', (req, res) => {
  queue.clearCompleted();
  res.json({ success: true });
});

// Remove track from queue
app.delete('/api/queue/:trackId', (req, res) => {
  const { trackId } = req.params;
  const removed = queue.removeFromQueue(trackId);
  res.json({ success: removed });
});

// Skip current track
app.post('/api/queue/skip', (req, res) => {
  const skipped = queue.skipCurrent();
  res.json({ success: skipped });
});

// Get Soggfy config
app.get('/api/config', (req, res) => {
  const config = queue.getConfig();
  if (!config) {
    return res.status(503).json({ error: 'Config not available yet' });
  }
  res.json(config);
});

// Update Soggfy config
app.put('/api/config', (req, res) => {
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

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    soggfyConnected: soggfy.isConnected,
    spotifyAuthenticated: !!spotify.userAccessToken,
    autoSelectDevice: process.env.AUTO_SELECT_DEVICE !== 'false'
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 Backend running on http://localhost:${PORT}`);
  console.log(`🔗 Spotify Auth: http://localhost:${PORT}/api/auth/url`);
  console.log(`📡 WebSocket: ws://localhost:${PORT}/ws`);
});
