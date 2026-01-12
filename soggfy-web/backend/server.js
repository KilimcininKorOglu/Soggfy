const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');
require('dotenv').config();

const { SoggfyClient } = require('./soggfyClient');
const SpotifyAPI = require('./spotifyAuth');
const QueueManager = require('./queueManager');
const StatsManager = require('./statsManager');
const PlaylistManager = require('./playlistManager');
const Scheduler = require('./scheduler');
const SearchHistory = require('./searchHistory');
const NotificationManager = require('./notificationManager');
const FileManager = require('./fileManager');
const MetadataEditor = require('./metadataEditor');

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

// Initialize stats manager
const statsDbPath = path.join(process.env.LOCALAPPDATA || '.', 'Soggfy', 'stats.db');
const stats = new StatsManager(statsDbPath);

// Wire up stats tracking to queue manager
queue.setStatsManager(stats);

// Initialize playlist manager (shares database with stats)
const playlistMgr = new PlaylistManager(stats.db, spotify);

// Wire up playlist manager to queue manager for history tracking
queue.setPlaylistManager(playlistMgr);

// Initialize scheduler (shares database with stats and playlist)
const scheduler = new Scheduler(stats.db, queue, playlistMgr);

// Initialize search history (shares database with stats)
const searchHistory = new SearchHistory(stats.db);

// Initialize notification manager (shares database with stats)
const notifications = new NotificationManager(statsDbPath, {
  vapidPublicKey: process.env.VAPID_PUBLIC_KEY,
  vapidPrivateKey: process.env.VAPID_PRIVATE_KEY,
  vapidEmail: process.env.VAPID_EMAIL
});
notifications.initVapid();
notifications.initWebhooks();

// Wire up notifications to queue manager
queue.setNotificationManager(notifications);

// Initialize file manager - get base path from Soggfy config or use default
const defaultMusicPath = process.env.SOGGFY_SAVE_PATH || 
  path.join(process.env.USERPROFILE || process.env.HOME || '', 'Music', 'Soggfy');

let fileManager = new FileManager(defaultMusicPath);
let metadataEditor = new MetadataEditor(defaultMusicPath);
console.log(`File manager initialized with default path: ${defaultMusicPath}`);

// Update file manager when config is received from Soggfy
queue.on('configSync', (config) => {
  if (config && config.savePath && config.savePath !== fileManager.basePath) {
    const basePath = config.savePath;
    fileManager = new FileManager(basePath);
    metadataEditor = new MetadataEditor(basePath);
    console.log(`File manager updated with Soggfy path: ${basePath}`);
  }
});

// Graceful shutdown handlers
process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down...');
  scheduler.shutdown();
  notifications.shutdown();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down...');
  scheduler.shutdown();
  notifications.shutdown();
  process.exit(0);
});

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

// ==================== STATS API ====================

// Get all statistics
app.get('/api/stats', authMiddleware, (req, res) => {
  res.json(stats.getStats());
});

// Get totals only (fast)
app.get('/api/stats/totals', authMiddleware, (req, res) => {
  res.json(stats.getTotals());
});

// Get chart data by period
app.get('/api/stats/chart/:period', authMiddleware, (req, res) => {
  const { period } = req.params;
  switch (period) {
    case 'daily':
      res.json(stats.getDailyChart(30));
      break;
    case 'weekly':
      res.json(stats.getWeeklyChart(12));
      break;
    case 'monthly':
      res.json(stats.getMonthlyChart(12));
      break;
    default:
      res.status(400).json({ error: 'Invalid period. Use daily, weekly, or monthly.' });
  }
});

// Get hourly heatmap
app.get('/api/stats/heatmap', authMiddleware, (req, res) => {
  res.json(stats.getHourlyHeatmap());
});

// Get top artists or albums
app.get('/api/stats/top/:type', authMiddleware, (req, res) => {
  const { type } = req.params;
  const limit = parseInt(req.query.limit) || 10;

  switch (type) {
    case 'artists':
      res.json(stats.getTopArtists(limit));
      break;
    case 'albums':
      res.json(stats.getTopAlbums(limit));
      break;
    default:
      res.status(400).json({ error: 'Invalid type. Use artists or albums.' });
  }
});

// Get recent downloads
app.get('/api/stats/recent', authMiddleware, (req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  res.json(stats.getRecentDownloads(limit));
});

// Search downloads
app.get('/api/stats/search', authMiddleware, (req, res) => {
  const { q } = req.query;
  if (!q) {
    return res.status(400).json({ error: 'Query parameter "q" is required.' });
  }
  const limit = parseInt(req.query.limit) || 50;
  res.json(stats.searchDownloads(q, limit));
});

// Export as JSON
app.get('/api/stats/export/json', authMiddleware, (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename=soggfy-stats.json');
  res.json(stats.exportJSON());
});

// Export as CSV
app.get('/api/stats/export/csv', authMiddleware, (req, res) => {
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=soggfy-stats.csv');
  res.send(stats.exportCSV());
});

// Reset all statistics
app.delete('/api/stats/reset', authMiddleware, (req, res) => {
  stats.reset();
  res.json({ success: true });
});

// ==================== PLAYLIST API ====================

// Get all saved playlists
app.get('/api/playlists', authMiddleware, (req, res) => {
  res.json(playlistMgr.getPlaylists());
});

// Get single playlist details
app.get('/api/playlists/:id', authMiddleware, (req, res) => {
  const playlist = playlistMgr.getPlaylistInfo(req.params.id);
  if (!playlist) {
    return res.status(404).json({ error: 'Playlist not found' });
  }
  res.json(playlist);
});

// Save a playlist to favorites
app.post('/api/playlists', authMiddleware, async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    const parsed = spotify.parseSpotifyUrl(url);
    if (!parsed || parsed.type !== 'playlist') {
      return res.status(400).json({ error: 'Invalid playlist URL' });
    }

    const playlist = await playlistMgr.savePlaylist(parsed.id);
    res.json(playlist);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Remove saved playlist
app.delete('/api/playlists/:id', authMiddleware, (req, res) => {
  playlistMgr.removePlaylist(req.params.id);
  res.json({ success: true });
});

// Sync a playlist for new tracks
app.post('/api/playlists/:id/sync', authMiddleware, async (req, res) => {
  try {
    const result = await playlistMgr.syncPlaylist(req.params.id);
    if (!result) {
      return res.status(404).json({ error: 'Playlist not found' });
    }
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Sync all saved playlists
app.post('/api/playlists/sync-all', authMiddleware, async (req, res) => {
  try {
    const results = await playlistMgr.syncAllPlaylists();
    res.json(results);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Get playlist track IDs
app.get('/api/playlists/:id/tracks', authMiddleware, (req, res) => {
  const trackIds = playlistMgr.getPlaylistTrackIds(req.params.id);
  res.json({ trackIds });
});

// Get new track IDs since last download
app.get('/api/playlists/:id/new', authMiddleware, (req, res) => {
  const trackIds = playlistMgr.getNewTrackIds(req.params.id);
  res.json({ trackIds, count: trackIds.length });
});

// Download playlist (all or new only)
app.post('/api/playlists/:id/download', authMiddleware, async (req, res) => {
  try {
    const { newOnly } = req.body;
    const playlistId = req.params.id;

    const playlist = playlistMgr.getPlaylistInfo(playlistId);
    if (!playlist) {
      return res.status(404).json({ error: 'Playlist not found' });
    }

    let trackIds;
    if (newOnly) {
      trackIds = playlistMgr.getNewTrackIds(playlistId);
    } else {
      trackIds = playlistMgr.getPlaylistTrackIds(playlistId);
    }

    if (trackIds.length === 0) {
      return res.json({ success: true, message: 'No tracks to download', count: 0 });
    }

    // Add tracks to queue
    for (const trackId of trackIds) {
      await queue.addUrl(`spotify:track:${trackId}`);
    }

    // Mark as downloaded
    playlistMgr.markPlaylistDownloaded(playlistId);

    // Add to history
    playlistMgr.addToHistory({
      id: playlistId,
      type: 'playlist',
      name: playlist.name,
      image: playlist.image,
      trackCount: trackIds.length,
      url: `https://open.spotify.com/playlist/${playlistId}`
    });

    res.json({ success: true, count: trackIds.length });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ==================== HISTORY API ====================

// Get download history (paginated)
app.get('/api/history', authMiddleware, (req, res) => {
  const { type, limit, offset } = req.query;
  res.json(playlistMgr.getHistory({
    type,
    limit: parseInt(limit) || 50,
    offset: parseInt(offset) || 0
  }));
});

// Search download history
app.get('/api/history/search', authMiddleware, (req, res) => {
  const { q, limit } = req.query;
  if (!q) {
    return res.status(400).json({ error: 'Query parameter "q" is required' });
  }
  res.json(playlistMgr.searchHistory(q, parseInt(limit) || 50));
});

// Re-download item from history
app.post('/api/history/:id/redownload', authMiddleware, async (req, res) => {
  try {
    const historyItem = playlistMgr.getHistoryItem(parseInt(req.params.id));
    if (!historyItem) {
      return res.status(404).json({ error: 'History item not found' });
    }

    if (!historyItem.url) {
      return res.status(400).json({ error: 'No URL available for re-download' });
    }

    await queue.addUrl(historyItem.url);
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Delete single history item
app.delete('/api/history/:id', authMiddleware, (req, res) => {
  playlistMgr.deleteHistoryItem(parseInt(req.params.id));
  res.json({ success: true });
});

// Clear all history
app.delete('/api/history', authMiddleware, (req, res) => {
  const { before } = req.query;
  if (before) {
    playlistMgr.clearHistoryBefore(parseInt(before));
  } else {
    playlistMgr.clearHistory();
  }
  res.json({ success: true });
});

// ==================== SCHEDULE API ====================

// Get all schedules
app.get('/api/schedules', authMiddleware, (req, res) => {
  res.json(scheduler.getSchedules());
});

// Get single schedule with stats
app.get('/api/schedules/:id', authMiddleware, (req, res) => {
  const schedule = scheduler.getSchedule(req.params.id);
  if (!schedule) {
    return res.status(404).json({ error: 'Schedule not found' });
  }
  res.json(schedule);
});

// Create new schedule
app.post('/api/schedules', authMiddleware, (req, res) => {
  try {
    const schedule = scheduler.createSchedule(req.body);
    res.json(schedule);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Update schedule
app.put('/api/schedules/:id', authMiddleware, (req, res) => {
  try {
    const schedule = scheduler.updateSchedule(req.params.id, req.body);
    if (!schedule) {
      return res.status(404).json({ error: 'Schedule not found' });
    }
    res.json(schedule);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Delete schedule
app.delete('/api/schedules/:id', authMiddleware, (req, res) => {
  scheduler.deleteSchedule(req.params.id);
  res.json({ success: true });
});

// Toggle schedule enabled/disabled
app.post('/api/schedules/:id/toggle', authMiddleware, (req, res) => {
  const schedule = scheduler.toggleSchedule(req.params.id);
  if (!schedule) {
    return res.status(404).json({ error: 'Schedule not found' });
  }
  res.json(schedule);
});

// Run schedule immediately
app.post('/api/schedules/:id/run', authMiddleware, async (req, res) => {
  try {
    const result = await scheduler.runNow(req.params.id);
    if (!result) {
      return res.status(404).json({ error: 'Schedule not found' });
    }
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Get schedule's execution history
app.get('/api/schedules/:id/executions', authMiddleware, (req, res) => {
  const { limit } = req.query;
  res.json(scheduler.getScheduleExecutions(req.params.id, parseInt(limit) || 20));
});

// Get all execution history
app.get('/api/schedules/history', authMiddleware, (req, res) => {
  const { limit, offset } = req.query;
  res.json(scheduler.getExecutionHistory({
    limit: parseInt(limit) || 50,
    offset: parseInt(offset) || 0
  }));
});

// Validate cron expression
app.post('/api/schedules/validate-cron', authMiddleware, (req, res) => {
  const { expression, timezone } = req.body;
  const isValid = scheduler.isValidCron(expression);

  if (isValid) {
    const nextRun = scheduler.getNextRunTime(expression, timezone);
    res.json({ valid: true, nextRun });
  } else {
    res.json({ valid: false, error: 'Invalid cron expression' });
  }
});

// ==================== SEARCH API ====================

// Search Spotify
app.get('/api/search', authMiddleware, async (req, res) => {
  try {
    const { q, types, limit } = req.query;

    if (!q) {
      return res.status(400).json({ error: 'Query is required' });
    }

    const typeArray = types ? types.split(',') : ['track', 'album', 'artist', 'playlist'];
    const results = await spotify.search(q, typeArray, parseInt(limit) || 20);

    const totalResults =
      results.tracks.length +
      results.albums.length +
      results.artists.length +
      results.playlists.length;

    searchHistory.add(q, totalResults);

    res.json(results);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Get artist details
app.get('/api/search/artist/:id', authMiddleware, async (req, res) => {
  try {
    const artist = await spotify.getArtist(req.params.id);
    artist.isFavorite = searchHistory.isFavorite(req.params.id);
    res.json(artist);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Get artist albums
app.get('/api/search/artist/:id/albums', authMiddleware, async (req, res) => {
  try {
    const { includeGroups } = req.query;
    const albums = await spotify.getArtistAlbums(
      req.params.id,
      includeGroups || 'album,single'
    );
    res.json(albums);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Get artist top tracks
app.get('/api/search/artist/:id/top-tracks', authMiddleware, async (req, res) => {
  try {
    const tracks = await spotify.getArtistTopTracks(req.params.id);
    res.json(tracks);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Get related artists
app.get('/api/search/artist/:id/related', authMiddleware, async (req, res) => {
  try {
    const artists = await spotify.getRelatedArtists(req.params.id);
    const result = artists.map(a => ({
      ...a,
      isFavorite: searchHistory.isFavorite(a.id)
    }));
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Get album with tracks
app.get('/api/search/album/:id', authMiddleware, async (req, res) => {
  try {
    const album = await spotify.getAlbum(req.params.id);
    res.json(album);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Get search history
app.get('/api/search/history', authMiddleware, (req, res) => {
  const { limit } = req.query;
  res.json(searchHistory.getRecent(parseInt(limit) || 20));
});

// Get popular searches
app.get('/api/search/history/popular', authMiddleware, (req, res) => {
  const { limit } = req.query;
  res.json(searchHistory.getPopular(parseInt(limit) || 10));
});

// Autocomplete suggestions
app.get('/api/search/history/suggest', authMiddleware, (req, res) => {
  const { q, limit } = req.query;
  if (!q) return res.json([]);
  res.json(searchHistory.searchHistory(q, parseInt(limit) || 5));
});

// Clear search history
app.delete('/api/search/history', authMiddleware, (req, res) => {
  searchHistory.clear();
  res.json({ success: true });
});

// Delete single search
app.delete('/api/search/history/:id', authMiddleware, (req, res) => {
  searchHistory.delete(parseInt(req.params.id));
  res.json({ success: true });
});

// Get favorite artists
app.get('/api/search/favorites', authMiddleware, (req, res) => {
  res.json(searchHistory.getFavorites());
});

// Add favorite artist
app.post('/api/search/favorites', authMiddleware, async (req, res) => {
  try {
    const { artistId } = req.body;
    const artist = await spotify.getArtist(artistId);
    searchHistory.addFavorite(artist);
    res.json({ success: true, artist });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Remove favorite artist
app.delete('/api/search/favorites/:id', authMiddleware, (req, res) => {
  searchHistory.removeFavorite(req.params.id);
  res.json({ success: true });
});

// ==================== NOTIFICATION ROUTES ====================

// Get notification settings
app.get('/api/notifications/settings', authMiddleware, (req, res) => {
  res.json(notifications.getAllSettings());
});

// Update notification settings
app.put('/api/notifications/settings', authMiddleware, (req, res) => {
  notifications.updateSettings(req.body);
  res.json({ success: true });
});

// Register push subscription
app.post('/api/notifications/push/subscribe', authMiddleware, (req, res) => {
  notifications.registerPushSubscription(req.body, req.headers['user-agent']);
  res.json({ success: true });
});

// Unregister push subscription
app.post('/api/notifications/push/unsubscribe', authMiddleware, (req, res) => {
  notifications.unregisterPushSubscription(req.body.endpoint);
  res.json({ success: true });
});

// Get push subscriptions
app.get('/api/notifications/push/subscriptions', authMiddleware, (req, res) => {
  const subscriptions = notifications.getPushSubscriptions();
  res.json(subscriptions.map(s => ({
    endpoint: s.endpoint.substring(0, 50) + '...',
    active: true
  })));
});

// Get VAPID public key
app.get('/api/notifications/vapid-key', (req, res) => {
  res.json({ key: process.env.VAPID_PUBLIC_KEY || null });
});

// Send test notification
app.post('/api/notifications/test', authMiddleware, async (req, res) => {
  const { channel } = req.body;
  const results = await notifications.sendTestNotification(channel);
  res.json(results);
});

// Get notification history
app.get('/api/notifications/history', authMiddleware, (req, res) => {
  const { type, channel, limit, offset } = req.query;
  res.json(notifications.getHistory({
    type,
    channel,
    limit: parseInt(limit) || 50,
    offset: parseInt(offset) || 0
  }));
});

// Get notification stats
app.get('/api/notifications/stats', authMiddleware, (req, res) => {
  res.json(notifications.getHistoryStats());
});

// Clear notification history
app.delete('/api/notifications/history', authMiddleware, (req, res) => {
  notifications.cleanHistory(0);
  res.json({ success: true });
});

// ==================== FILE MANAGEMENT ROUTES ====================

// Check if file manager is ready middleware
const fileManagerReady = (req, res, next) => {
  if (!fileManager) {
    return res.status(503).json({ error: 'File manager not initialized. Waiting for Soggfy config.' });
  }
  next();
};

// Get file manager base path
app.get('/api/files/basepath', authMiddleware, (req, res) => {
  if (!fileManager) {
    return res.status(503).json({ error: 'File manager not initialized' });
  }
  res.json({ basePath: fileManager.basePath });
});

// List directory contents
app.get('/api/files', authMiddleware, fileManagerReady, async (req, res) => {
  try {
    const { path: dirPath = '' } = req.query;
    const result = await fileManager.listDirectory(dirPath);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Get file details
app.get('/api/files/details', authMiddleware, fileManagerReady, async (req, res) => {
  try {
    const { path: filePath } = req.query;
    if (!filePath) {
      return res.status(400).json({ error: 'Path required' });
    }
    const result = await fileManager.getFileDetails(filePath);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Search files
app.get('/api/files/search', authMiddleware, fileManagerReady, async (req, res) => {
  try {
    const { q, searchMetadata, limit } = req.query;
    if (!q) {
      return res.status(400).json({ error: 'Query required' });
    }
    const result = await fileManager.search(q, {
      searchMetadata: searchMetadata === 'true',
      limit: parseInt(limit) || 100
    });
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Delete file or directory
app.delete('/api/files', authMiddleware, fileManagerReady, async (req, res) => {
  try {
    const { path: targetPath } = req.query;
    if (!targetPath) {
      return res.status(400).json({ error: 'Path required' });
    }
    const result = await fileManager.deleteFile(targetPath);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Move/rename file
app.post('/api/files/move', authMiddleware, fileManagerReady, async (req, res) => {
  try {
    const { from, to } = req.body;
    if (!from || !to) {
      return res.status(400).json({ error: 'From and to paths required' });
    }
    const result = await fileManager.moveFile(from, to);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Create directory
app.post('/api/files/mkdir', authMiddleware, fileManagerReady, async (req, res) => {
  try {
    const { path: dirPath } = req.body;
    if (!dirPath) {
      return res.status(400).json({ error: 'Path required' });
    }
    const result = await fileManager.createDirectory(dirPath);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Get storage statistics
app.get('/api/files/stats', authMiddleware, fileManagerReady, async (req, res) => {
  try {
    const result = await fileManager.getStorageStats();
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Find duplicate files
app.get('/api/files/duplicates', authMiddleware, fileManagerReady, async (req, res) => {
  try {
    const result = await fileManager.findDuplicates();
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Get file metadata
app.get('/api/files/metadata', authMiddleware, fileManagerReady, async (req, res) => {
  try {
    const { path: filePath } = req.query;
    if (!filePath) {
      return res.status(400).json({ error: 'Path required' });
    }
    const result = await metadataEditor.readMetadata(filePath);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Update file metadata
app.put('/api/files/metadata', authMiddleware, fileManagerReady, async (req, res) => {
  try {
    const { path: filePath, updates } = req.body;
    if (!filePath) {
      return res.status(400).json({ error: 'Path required' });
    }
    const result = await metadataEditor.writeMetadata(filePath, updates || {});
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Batch update metadata
app.put('/api/files/metadata/batch', authMiddleware, fileManagerReady, async (req, res) => {
  try {
    const { files, updates } = req.body;
    if (!files || !Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: 'Files array required' });
    }
    const result = await metadataEditor.batchUpdate(files, updates || {});
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Get file artwork
app.get('/api/files/artwork', authMiddleware, fileManagerReady, async (req, res) => {
  try {
    const { path: filePath } = req.query;
    if (!filePath) {
      return res.status(400).json({ error: 'Path required' });
    }
    const result = await metadataEditor.getArtwork(filePath);
    if (!result) {
      return res.status(404).json({ error: 'No artwork found' });
    }
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Remove file artwork
app.delete('/api/files/artwork', authMiddleware, fileManagerReady, async (req, res) => {
  try {
    const { path: filePath } = req.query;
    if (!filePath) {
      return res.status(400).json({ error: 'Path required' });
    }
    const result = await metadataEditor.removeArtwork(filePath);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 Backend running on http://localhost:${PORT}`);
  console.log(`🔗 Spotify Auth: http://localhost:${PORT}/api/auth/url`);
  console.log(`📡 WebSocket: ws://localhost:${PORT}/ws`);
});
