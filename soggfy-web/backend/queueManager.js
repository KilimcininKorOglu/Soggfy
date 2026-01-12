const { MessageType } = require('./soggfyClient');

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
    this.eventListeners = new Map();
    this.statsManager = null;

    // Listen for config sync from Soggfy
    soggfyClient.on(MessageType.SYNC_CONFIG, (data) => {
      this.soggfyConfig = data;
      console.log('Received Soggfy config');
      this.emit('configSync', data);
    });

    // Listen for download status updates from Soggfy
    soggfyClient.on(MessageType.DOWNLOAD_STATUS, (data) => {
      this.handleDownloadStatus(data);
    });

    soggfyClient.on('connected', () => {
      console.log('Soggfy connected');
      this.emit('soggfyConnected');
    });

    soggfyClient.on('disconnected', () => {
      console.log('Soggfy disconnected');
      this.emit('soggfyDisconnected');
    });
  }

  on(event, callback) {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, []);
    }
    this.eventListeners.get(event).push(callback);
  }

  emit(event, data) {
    const listeners = this.eventListeners.get(event);
    if (listeners) {
      listeners.forEach(cb => cb(data));
    }
  }

  setDeviceId(deviceId) {
    this.deviceId = deviceId;
  }

  setStatsManager(statsManager) {
    this.statsManager = statsManager;
  }

  trackStats(track, status) {
    if (!this.statsManager) return;

    try {
      this.statsManager.trackDownload({
        id: track.id,
        name: track.name,
        artist: track.artist,
        album: track.album,
        duration: track.duration,
        fileSize: track.fileSize || 0,
        status: status
      });
    } catch (error) {
      console.error('Failed to track stats:', error.message);
    }
  }

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
    this.emit('queueUpdate', this.getStatus());

    // Start processing if nothing is downloading
    this.processQueue();

    return addedTracks;
  }

  async processQueue() {
    // Don't start new download if one is already in progress
    if (this.currentTrack || this.queue.length === 0) {
      return;
    }

    // Check if Soggfy is connected
    if (!this.soggfyClient.isConnected) {
      console.log('Waiting for Soggfy connection...');
      return;
    }

    this.currentTrack = this.queue.shift();
    this.currentTrack.status = 'downloading';
    this.currentTrack.startedAt = Date.now();

    console.log(`Starting download: ${this.currentTrack.name}`);
    this.emit('queueUpdate', this.getStatus());

    try {
      await this.spotifyAPI.playTrack(
        this.currentTrack.uri,
        this.deviceId
      );
      console.log(`Playback started for: ${this.currentTrack.name}`);
    } catch (error) {
      console.error('Failed to start playback:', error.message);
      this.currentTrack.status = 'error';
      this.currentTrack.error = error.message;
      this.trackStats(this.currentTrack, 'error');
      this.completedTracks.unshift(this.currentTrack);
      this.currentTrack = null;
      this.emit('queueUpdate', this.getStatus());

      setTimeout(() => this.processQueue(), 2000);
    }
  }

  // Calculate estimated track duration for timeout
  getTrackTimeout(track) {
    // Track duration + 30 seconds buffer for conversion
    const durationMs = track.duration || 180000; // Default 3 min
    return durationMs + 30000;
  }

  handleDownloadStatus(data) {
    console.log('Download status update:', JSON.stringify(data));

    let trackUri = null;
    let statusInfo = null;

    if (data.results) {
      const entries = Object.entries(data.results);
      if (entries.length > 0) {
        [trackUri, statusInfo] = entries[0];
      }
    } else if (data.playbackId) {
      // playbackId messages without trackUri are usually from tracks played outside our control
      // or stale messages from previous playbacks - ignore ERROR status from these
      if (data.status === DownloadStatus.ERROR) {
        console.log(`Ignoring playbackId ERROR (likely stale): ${data.message}`);
        return;
      }
      statusInfo = data;
    }

    if (!statusInfo) return;
    if (!this.currentTrack) return;

    // Match by trackUri if available
    if (trackUri) {
      if (this.currentTrack.uri !== trackUri) {
        console.log(`Status for different track: ${trackUri}`);
        return;
      }
    } else if (data.playbackId) {
      // For playbackId messages, only process if track started recently (within 5s)
      // This helps filter out stale status messages from previous tracks
      const elapsed = Date.now() - (this.currentTrack.startedAt || 0);
      if (elapsed > 5000) {
        console.log(`Ignoring stale playbackId status (${elapsed}ms since start)`);
        return;
      }
    }

    const status = statusInfo.status;

    if (status === DownloadStatus.CONVERTING) {
      this.currentTrack.status = 'converting';
      this.emit('queueUpdate', this.getStatus());
    } else if (status === DownloadStatus.IN_PROGRESS) {
      this.currentTrack.status = 'downloading';
      this.emit('queueUpdate', this.getStatus());
    }

    if (status === DownloadStatus.DONE) {
      console.log(`Download completed: ${this.currentTrack.name}`);
      this.currentTrack.status = 'completed';
      this.currentTrack.completedAt = Date.now();
      this.currentTrack.path = statusInfo.path;
      this.trackStats(this.currentTrack, 'completed');
      this.completedTracks.unshift(this.currentTrack);
      this.currentTrack = null;
      this.emit('queueUpdate', this.getStatus());

      setTimeout(() => this.processQueue(), 1000);
    } else if (status === DownloadStatus.ERROR) {
      console.error(`Download failed: ${this.currentTrack.name}`);
      this.currentTrack.status = 'error';
      this.currentTrack.error = statusInfo.message || 'Download failed';
      this.trackStats(this.currentTrack, 'error');
      this.completedTracks.unshift(this.currentTrack);
      this.currentTrack = null;
      this.emit('queueUpdate', this.getStatus());

      setTimeout(() => this.processQueue(), 2000);
    }
  }

  getStatus() {
    return {
      current: this.currentTrack,
      queue: this.queue,
      completed: this.completedTracks.slice(0, 20)
    };
  }

  clearCompleted() {
    this.completedTracks = [];
    this.emit('queueUpdate', this.getStatus());
  }

  removeFromQueue(trackId) {
    const index = this.queue.findIndex(t => t.id === trackId);
    if (index !== -1) {
      this.queue.splice(index, 1);
      this.emit('queueUpdate', this.getStatus());
      return true;
    }
    return false;
  }

  skipCurrent() {
    if (this.currentTrack) {
      this.currentTrack.status = 'skipped';
      this.trackStats(this.currentTrack, 'skipped');
      this.completedTracks.unshift(this.currentTrack);
      this.currentTrack = null;
      this.emit('queueUpdate', this.getStatus());
      setTimeout(() => this.processQueue(), 500);
      return true;
    }
    return false;
  }

  getConfig() {
    return this.soggfyConfig;
  }

  updateConfig(updates) {
    if (!this.soggfyClient.isConnected) {
      throw new Error('Soggfy not connected');
    }

    console.log('Sending config update to Soggfy:', JSON.stringify(updates));
    
    // Send SYNC_CONFIG message to Soggfy with updates
    this.soggfyClient.send(MessageType.SYNC_CONFIG, updates);

    // Optimistically update local config
    if (this.soggfyConfig) {
      this.soggfyConfig = { ...this.soggfyConfig, ...updates };
    }

    return this.soggfyConfig;
  }
}

module.exports = QueueManager;
