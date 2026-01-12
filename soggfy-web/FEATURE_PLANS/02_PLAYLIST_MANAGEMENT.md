# Playlist Management Feature

**Branch:** `feature/playlist-management`

## Overview

Add playlist management capabilities to save favorite playlists, enable one-click downloading, and maintain download history for easy re-downloading. Uses SQLite for efficient data storage, sharing the database with the statistics feature.

## Features

### 1. Saved Playlists

- Save Spotify playlists to favorites
- Display playlist artwork, name, track count
- Sync playlist changes (new tracks added)
- Remove from favorites

### 2. One-Click Download

- Download entire playlist with single click
- Resume interrupted playlist downloads
- Skip already downloaded tracks option
- Download only new tracks since last sync

### 3. Download History

- Full history of all downloaded URLs
- Filter by type (track/album/playlist)
- Search history
- Re-download from history
- Clear history options

### 4. Playlist Sync

- Auto-detect new tracks in saved playlists
- Badge showing "X new tracks"
- Differential download (only new tracks)

## Technical Implementation

### Backend Changes

#### Database Schema

Extends the existing `stats.db` SQLite database:

```sql
-- Saved playlists table
CREATE TABLE IF NOT EXISTS playlists (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    image TEXT,
    owner TEXT,
    track_count INTEGER DEFAULT 0,
    saved_at INTEGER NOT NULL,
    last_synced_at INTEGER,
    last_downloaded_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_playlists_saved ON playlists(saved_at);

-- Playlist tracks (stores track IDs for sync comparison)
CREATE TABLE IF NOT EXISTS playlist_tracks (
    playlist_id TEXT NOT NULL,
    track_id TEXT NOT NULL,
    position INTEGER,
    added_at INTEGER NOT NULL,
    PRIMARY KEY (playlist_id, track_id),
    FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_playlist_tracks_playlist ON playlist_tracks(playlist_id);

-- Download history table
CREATE TABLE IF NOT EXISTS download_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id TEXT NOT NULL,
    item_type TEXT NOT NULL CHECK (item_type IN ('track', 'album', 'playlist')),
    name TEXT NOT NULL,
    artist TEXT,
    album TEXT,
    image TEXT,
    track_count INTEGER DEFAULT 1,
    url TEXT,
    downloaded_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_history_downloaded ON download_history(downloaded_at DESC);
CREATE INDEX IF NOT EXISTS idx_history_type ON download_history(item_type);
CREATE INDEX IF NOT EXISTS idx_history_item ON download_history(item_id);
```

#### New Files

```
soggfy-web/backend/
├── playlistManager.js    # Playlist saving, sync, and history logic
```

#### playlistManager.js

```javascript
const Database = require('better-sqlite3');

class PlaylistManager {
    constructor(db, spotify) {
        this.db = db; // Shared SQLite database instance
        this.spotify = spotify;
        this.initTables();
        this.prepareStatements();
    }

    initTables() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS playlists (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT,
                image TEXT,
                owner TEXT,
                track_count INTEGER DEFAULT 0,
                saved_at INTEGER NOT NULL,
                last_synced_at INTEGER,
                last_downloaded_at INTEGER
            );

            CREATE INDEX IF NOT EXISTS idx_playlists_saved ON playlists(saved_at);

            CREATE TABLE IF NOT EXISTS playlist_tracks (
                playlist_id TEXT NOT NULL,
                track_id TEXT NOT NULL,
                position INTEGER,
                added_at INTEGER NOT NULL,
                PRIMARY KEY (playlist_id, track_id),
                FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_playlist_tracks_playlist ON playlist_tracks(playlist_id);

            CREATE TABLE IF NOT EXISTS download_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                item_id TEXT NOT NULL,
                item_type TEXT NOT NULL CHECK (item_type IN ('track', 'album', 'playlist')),
                name TEXT NOT NULL,
                artist TEXT,
                album TEXT,
                image TEXT,
                track_count INTEGER DEFAULT 1,
                url TEXT,
                downloaded_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_history_downloaded ON download_history(downloaded_at DESC);
            CREATE INDEX IF NOT EXISTS idx_history_type ON download_history(item_type);
            CREATE INDEX IF NOT EXISTS idx_history_item ON download_history(item_id);
        `);
    }

    prepareStatements() {
        this.stmts = {
            // Playlist statements
            insertPlaylist: this.db.prepare(`
                INSERT OR REPLACE INTO playlists 
                (id, name, description, image, owner, track_count, saved_at, last_synced_at)
                VALUES (@id, @name, @description, @image, @owner, @trackCount, @savedAt, @lastSyncedAt)
            `),
            getPlaylist: this.db.prepare(`SELECT * FROM playlists WHERE id = ?`),
            getAllPlaylists: this.db.prepare(`
                SELECT p.*, 
                    (SELECT COUNT(*) FROM playlist_tracks pt2 
                     WHERE pt2.playlist_id = p.id 
                     AND pt2.added_at > COALESCE(p.last_downloaded_at, 0)) as new_tracks
                FROM playlists p
                ORDER BY p.saved_at DESC
            `),
            deletePlaylist: this.db.prepare(`DELETE FROM playlists WHERE id = ?`),
            updatePlaylistSync: this.db.prepare(`
                UPDATE playlists 
                SET track_count = @trackCount, last_synced_at = @lastSyncedAt
                WHERE id = @id
            `),
            updatePlaylistDownload: this.db.prepare(`
                UPDATE playlists SET last_downloaded_at = ? WHERE id = ?
            `),

            // Playlist tracks statements
            insertTrack: this.db.prepare(`
                INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position, added_at)
                VALUES (@playlistId, @trackId, @position, @addedAt)
            `),
            getPlaylistTracks: this.db.prepare(`
                SELECT track_id FROM playlist_tracks WHERE playlist_id = ? ORDER BY position
            `),
            getNewTracks: this.db.prepare(`
                SELECT track_id FROM playlist_tracks 
                WHERE playlist_id = ? AND added_at > ?
                ORDER BY position
            `),
            deletePlaylistTracks: this.db.prepare(`
                DELETE FROM playlist_tracks WHERE playlist_id = ?
            `),
            deleteRemovedTracks: this.db.prepare(`
                DELETE FROM playlist_tracks 
                WHERE playlist_id = ? AND track_id NOT IN (SELECT value FROM json_each(?))
            `),

            // History statements
            insertHistory: this.db.prepare(`
                INSERT INTO download_history 
                (item_id, item_type, name, artist, album, image, track_count, url, downloaded_at)
                VALUES (@itemId, @itemType, @name, @artist, @album, @image, @trackCount, @url, @downloadedAt)
            `),
            updateHistory: this.db.prepare(`
                UPDATE download_history 
                SET downloaded_at = @downloadedAt, track_count = @trackCount
                WHERE item_id = @itemId
            `),
            getHistoryById: this.db.prepare(`
                SELECT * FROM download_history WHERE item_id = ?
            `),
            getHistory: this.db.prepare(`
                SELECT * FROM download_history 
                ORDER BY downloaded_at DESC 
                LIMIT ? OFFSET ?
            `),
            getHistoryByType: this.db.prepare(`
                SELECT * FROM download_history 
                WHERE item_type = ?
                ORDER BY downloaded_at DESC 
                LIMIT ? OFFSET ?
            `),
            searchHistory: this.db.prepare(`
                SELECT * FROM download_history 
                WHERE name LIKE ? OR artist LIKE ? OR album LIKE ?
                ORDER BY downloaded_at DESC 
                LIMIT ?
            `),
            getHistoryCount: this.db.prepare(`SELECT COUNT(*) as count FROM download_history`),
            clearHistory: this.db.prepare(`DELETE FROM download_history`),
            clearHistoryBefore: this.db.prepare(`DELETE FROM download_history WHERE downloaded_at < ?`),
            deleteHistoryItem: this.db.prepare(`DELETE FROM download_history WHERE id = ?`)
        };
    }

    // ==================== PLAYLIST METHODS ====================

    // Save a playlist to favorites
    async savePlaylist(playlistId) {
        const playlist = await this.spotify.getPlaylist(playlistId);
        const now = Date.now();

        const params = {
            id: playlistId,
            name: playlist.name,
            description: playlist.description || null,
            image: playlist.images[0]?.url || null,
            owner: playlist.owner.display_name,
            trackCount: playlist.tracks.total,
            savedAt: now,
            lastSyncedAt: now
        };

        // Transaction: insert playlist + all tracks
        const insertTracks = this.db.transaction((tracks) => {
            this.stmts.insertPlaylist.run(params);
            this.stmts.deletePlaylistTracks.run(playlistId); // Clear existing tracks

            for (let i = 0; i < tracks.length; i++) {
                const track = tracks[i].track;
                if (track) {
                    this.stmts.insertTrack.run({
                        playlistId,
                        trackId: track.id,
                        position: i,
                        addedAt: now
                    });
                }
            }
        });

        insertTracks(playlist.tracks.items);

        return this.getPlaylist(playlistId);
    }

    // Get a single playlist with new tracks count
    getPlaylist(playlistId) {
        const playlist = this.stmts.getPlaylist.get(playlistId);
        if (!playlist) return null;

        const newTracks = this.stmts.getNewTracks.all(
            playlistId, 
            playlist.last_downloaded_at || 0
        );

        return {
            id: playlist.id,
            name: playlist.name,
            description: playlist.description,
            image: playlist.image,
            owner: playlist.owner,
            trackCount: playlist.track_count,
            savedAt: playlist.saved_at,
            lastSyncedAt: playlist.last_synced_at,
            lastDownloadedAt: playlist.last_downloaded_at,
            newTracks: newTracks.length
        };
    }

    // Get all saved playlists
    getPlaylists() {
        return this.stmts.getAllPlaylists.all().map(row => ({
            id: row.id,
            name: row.name,
            description: row.description,
            image: row.image,
            owner: row.owner,
            trackCount: row.track_count,
            savedAt: row.saved_at,
            lastSyncedAt: row.last_synced_at,
            lastDownloadedAt: row.last_downloaded_at,
            newTracks: row.new_tracks
        }));
    }

    // Remove playlist from favorites
    removePlaylist(playlistId) {
        this.stmts.deletePlaylist.run(playlistId);
        return { success: true };
    }

    // Sync a playlist to detect new tracks
    async syncPlaylist(playlistId) {
        const saved = this.stmts.getPlaylist.get(playlistId);
        if (!saved) return null;

        const current = await this.spotify.getPlaylist(playlistId);
        const now = Date.now();

        // Get current track IDs from Spotify
        const currentTrackIds = current.tracks.items
            .filter(item => item.track)
            .map(item => item.track.id);

        // Get saved track IDs
        const savedTracks = this.stmts.getPlaylistTracks.all(playlistId);
        const savedTrackIds = new Set(savedTracks.map(t => t.track_id));

        // Find new tracks
        const newTrackIds = currentTrackIds.filter(id => !savedTrackIds.has(id));

        // Transaction: update playlist and add new tracks
        const syncTransaction = this.db.transaction(() => {
            // Update playlist metadata
            this.stmts.updatePlaylistSync.run({
                id: playlistId,
                trackCount: current.tracks.total,
                lastSyncedAt: now
            });

            // Remove tracks that are no longer in the playlist
            this.stmts.deleteRemovedTracks.run(playlistId, JSON.stringify(currentTrackIds));

            // Add new tracks
            for (let i = 0; i < current.tracks.items.length; i++) {
                const track = current.tracks.items[i].track;
                if (track && newTrackIds.includes(track.id)) {
                    this.stmts.insertTrack.run({
                        playlistId,
                        trackId: track.id,
                        position: i,
                        addedAt: now
                    });
                }
            }
        });

        syncTransaction();

        return {
            ...this.getPlaylist(playlistId),
            newTrackIds
        };
    }

    // Sync all saved playlists
    async syncAllPlaylists() {
        const playlists = this.stmts.getAllPlaylists.all();
        const results = [];

        for (const playlist of playlists) {
            try {
                const result = await this.syncPlaylist(playlist.id);
                results.push(result);
            } catch (error) {
                results.push({ 
                    id: playlist.id, 
                    name: playlist.name,
                    error: error.message 
                });
            }
        }

        return results;
    }

    // Get new track IDs for a playlist (since last download)
    getNewTrackIds(playlistId) {
        const playlist = this.stmts.getPlaylist.get(playlistId);
        if (!playlist) return [];

        return this.stmts.getNewTracks
            .all(playlistId, playlist.last_downloaded_at || 0)
            .map(t => t.track_id);
    }

    // Get all track IDs for a playlist
    getPlaylistTrackIds(playlistId) {
        return this.stmts.getPlaylistTracks.all(playlistId).map(t => t.track_id);
    }

    // Mark playlist as downloaded
    markPlaylistDownloaded(playlistId) {
        this.stmts.updatePlaylistDownload.run(Date.now(), playlistId);
    }

    // ==================== HISTORY METHODS ====================

    // Add to download history
    addToHistory(item) {
        const params = {
            itemId: item.id,
            itemType: item.type,
            name: item.name,
            artist: item.artist || null,
            album: item.album || null,
            image: item.image || null,
            trackCount: item.trackCount || 1,
            url: item.url || null,
            downloadedAt: Date.now()
        };

        // Check if already exists
        const existing = this.stmts.getHistoryById.get(item.id);
        
        if (existing) {
            this.stmts.updateHistory.run({
                itemId: item.id,
                trackCount: params.trackCount,
                downloadedAt: params.downloadedAt
            });
        } else {
            this.stmts.insertHistory.run(params);
        }

        return this.stmts.getHistoryById.get(item.id);
    }

    // Get download history with pagination
    getHistory(options = {}) {
        const limit = options.limit || 50;
        const offset = options.offset || 0;

        let rows;
        if (options.type) {
            rows = this.stmts.getHistoryByType.all(options.type, limit, offset);
        } else {
            rows = this.stmts.getHistory.all(limit, offset);
        }

        return {
            items: rows.map(row => ({
                id: row.id,
                itemId: row.item_id,
                type: row.item_type,
                name: row.name,
                artist: row.artist,
                album: row.album,
                image: row.image,
                trackCount: row.track_count,
                url: row.url,
                downloadedAt: row.downloaded_at
            })),
            total: this.stmts.getHistoryCount.get().count,
            limit,
            offset
        };
    }

    // Search download history
    searchHistory(query, limit = 50) {
        const pattern = `%${query}%`;
        const rows = this.stmts.searchHistory.all(pattern, pattern, pattern, limit);

        return rows.map(row => ({
            id: row.id,
            itemId: row.item_id,
            type: row.item_type,
            name: row.name,
            artist: row.artist,
            album: row.album,
            image: row.image,
            trackCount: row.track_count,
            url: row.url,
            downloadedAt: row.downloaded_at
        }));
    }

    // Clear all history
    clearHistory() {
        this.stmts.clearHistory.run();
        return { success: true };
    }

    // Clear history before a date
    clearHistoryBefore(timestamp) {
        this.stmts.clearHistoryBefore.run(timestamp);
        return { success: true };
    }

    // Delete single history item
    deleteHistoryItem(id) {
        this.stmts.deleteHistoryItem.run(id);
        return { success: true };
    }
}

module.exports = PlaylistManager;
```

#### API Endpoints

| Method | Endpoint                      | Description                           |
|--------|-------------------------------|---------------------------------------|
| GET    | `/api/playlists`              | Get all saved playlists               |
| GET    | `/api/playlists/:id`          | Get single playlist details           |
| POST   | `/api/playlists`              | Save a playlist to favorites          |
| DELETE | `/api/playlists/:id`          | Remove saved playlist                 |
| POST   | `/api/playlists/:id/sync`     | Sync playlist for new tracks          |
| POST   | `/api/playlists/sync-all`     | Sync all saved playlists              |
| GET    | `/api/playlists/:id/tracks`   | Get playlist track IDs                |
| GET    | `/api/playlists/:id/new`      | Get new track IDs since last download |
| POST   | `/api/playlists/:id/download` | Download playlist (all or new only)   |
| GET    | `/api/history`                | Get download history (paginated)      |
| GET    | `/api/history/search`         | Search download history               |
| POST   | `/api/history/:id/redownload` | Re-download item from history         |
| DELETE | `/api/history/:id`            | Delete single history item            |
| DELETE | `/api/history`                | Clear all history                     |

#### server.js Integration

```javascript
const PlaylistManager = require('./playlistManager');

// Share database with StatsManager
const playlistMgr = new PlaylistManager(stats.db, spotify);

// Playlist Routes
app.get('/api/playlists', authMiddleware, (req, res) => {
    res.json(playlistMgr.getPlaylists());
});

app.get('/api/playlists/:id', authMiddleware, (req, res) => {
    const playlist = playlistMgr.getPlaylist(req.params.id);
    if (!playlist) return res.status(404).json({ error: 'Playlist not found' });
    res.json(playlist);
});

app.post('/api/playlists', authMiddleware, async (req, res) => {
    try {
        const { url } = req.body;
        const playlistId = extractPlaylistId(url);
        const playlist = await playlistMgr.savePlaylist(playlistId);
        res.json(playlist);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.delete('/api/playlists/:id', authMiddleware, (req, res) => {
    playlistMgr.removePlaylist(req.params.id);
    res.json({ success: true });
});

app.post('/api/playlists/:id/sync', authMiddleware, async (req, res) => {
    try {
        const result = await playlistMgr.syncPlaylist(req.params.id);
        if (!result) return res.status(404).json({ error: 'Playlist not found' });
        res.json(result);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.post('/api/playlists/sync-all', authMiddleware, async (req, res) => {
    try {
        const results = await playlistMgr.syncAllPlaylists();
        res.json(results);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.post('/api/playlists/:id/download', authMiddleware, async (req, res) => {
    try {
        const { newOnly } = req.body;
        const playlistId = req.params.id;
        
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

        res.json({ success: true, count: trackIds.length });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// History Routes
app.get('/api/history', authMiddleware, (req, res) => {
    const { type, limit, offset } = req.query;
    res.json(playlistMgr.getHistory({
        type,
        limit: parseInt(limit) || 50,
        offset: parseInt(offset) || 0
    }));
});

app.get('/api/history/search', authMiddleware, (req, res) => {
    const { q, limit } = req.query;
    if (!q) return res.status(400).json({ error: 'Query required' });
    res.json(playlistMgr.searchHistory(q, parseInt(limit) || 50));
});

app.post('/api/history/:id/redownload', authMiddleware, async (req, res) => {
    try {
        const history = playlistMgr.stmts.getHistoryById.get(req.params.id);
        if (!history) return res.status(404).json({ error: 'History item not found' });

        await queue.addUrl(history.url);
        res.json({ success: true });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.delete('/api/history/:id', authMiddleware, (req, res) => {
    playlistMgr.deleteHistoryItem(parseInt(req.params.id));
    res.json({ success: true });
});

app.delete('/api/history', authMiddleware, (req, res) => {
    const { before } = req.query;
    if (before) {
        playlistMgr.clearHistoryBefore(parseInt(before));
    } else {
        playlistMgr.clearHistory();
    }
    res.json({ success: true });
});

// Helper function
function extractPlaylistId(url) {
    const match = url.match(/playlist[\/:]([a-zA-Z0-9]+)/);
    if (!match) throw new Error('Invalid playlist URL');
    return match[1];
}
```

### Frontend Changes

#### New Components

```
soggfy-web/frontend/src/components/
├── Playlists/
│   ├── Playlists.jsx           # Saved playlists view
│   ├── Playlists.css           # Styles
│   ├── PlaylistCard.jsx        # Individual playlist card
│   └── AddPlaylistModal.jsx    # Modal to add playlist
├── History/
│   ├── History.jsx             # Download history view
│   ├── History.css             # Styles
│   └── HistoryItem.jsx         # Individual history item
```

#### Playlists.jsx Structure

```jsx
import { useState, useEffect } from 'react';
import axios from 'axios';
import PlaylistCard from './PlaylistCard';
import AddPlaylistModal from './AddPlaylistModal';
import './Playlists.css';

function Playlists() {
    const [playlists, setPlaylists] = useState([]);
    const [syncing, setSyncing] = useState(false);
    const [showAdd, setShowAdd] = useState(false);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        fetchPlaylists();
    }, []);

    const fetchPlaylists = async () => {
        try {
            const response = await axios.get(`${API_BASE}/playlists`);
            setPlaylists(response.data);
        } catch (error) {
            console.error('Failed to fetch playlists:', error);
        } finally {
            setLoading(false);
        }
    };

    const handleSyncAll = async () => {
        setSyncing(true);
        try {
            await axios.post(`${API_BASE}/playlists/sync-all`);
            await fetchPlaylists();
        } catch (error) {
            console.error('Sync failed:', error);
        } finally {
            setSyncing(false);
        }
    };

    const handleDownload = async (playlistId, newOnly = false) => {
        try {
            const response = await axios.post(
                `${API_BASE}/playlists/${playlistId}/download`,
                { newOnly }
            );
            alert(`Added ${response.data.count} tracks to queue`);
            await fetchPlaylists();
        } catch (error) {
            alert('Download failed: ' + error.message);
        }
    };

    const handleRemove = async (playlistId) => {
        if (!confirm('Remove this playlist from favorites?')) return;
        try {
            await axios.delete(`${API_BASE}/playlists/${playlistId}`);
            await fetchPlaylists();
        } catch (error) {
            console.error('Remove failed:', error);
        }
    };

    const handleAdd = async (url) => {
        try {
            await axios.post(`${API_BASE}/playlists`, { url });
            await fetchPlaylists();
            setShowAdd(false);
        } catch (error) {
            alert('Failed to add playlist: ' + error.message);
        }
    };

    if (loading) return <div className="loading">Loading playlists...</div>;

    return (
        <div className="playlists-page">
            <header className="playlists-header">
                <h2>Saved Playlists</h2>
                <div className="actions">
                    <button onClick={handleSyncAll} disabled={syncing}>
                        {syncing ? 'Syncing...' : '🔄 Sync All'}
                    </button>
                    <button onClick={() => setShowAdd(true)}>➕ Add Playlist</button>
                </div>
            </header>

            {playlists.length === 0 ? (
                <div className="empty-state">
                    <p>No saved playlists</p>
                    <p className="hint">Add a Spotify playlist to get started</p>
                </div>
            ) : (
                <div className="playlist-grid">
                    {playlists.map(playlist => (
                        <PlaylistCard
                            key={playlist.id}
                            playlist={playlist}
                            onDownload={() => handleDownload(playlist.id)}
                            onDownloadNew={() => handleDownload(playlist.id, true)}
                            onSync={() => handleSync(playlist.id)}
                            onRemove={() => handleRemove(playlist.id)}
                        />
                    ))}
                </div>
            )}

            {showAdd && (
                <AddPlaylistModal 
                    onClose={() => setShowAdd(false)}
                    onAdd={handleAdd}
                />
            )}
        </div>
    );
}

export default Playlists;
```

#### PlaylistCard.jsx

```jsx
function PlaylistCard({ playlist, onDownload, onDownloadNew, onSync, onRemove }) {
    const formatDate = (timestamp) => {
        if (!timestamp) return 'Never';
        return new Date(timestamp).toLocaleDateString();
    };

    return (
        <div className="playlist-card">
            <div className="playlist-image-container">
                {playlist.image ? (
                    <img src={playlist.image} alt={playlist.name} className="playlist-image" />
                ) : (
                    <div className="playlist-image placeholder">🎵</div>
                )}
                {playlist.newTracks > 0 && (
                    <span className="new-badge">{playlist.newTracks} new</span>
                )}
            </div>
            
            <div className="playlist-info">
                <h3 className="playlist-name">{playlist.name}</h3>
                <p className="playlist-meta">
                    {playlist.owner} • {playlist.trackCount} tracks
                </p>
                <p className="playlist-sync">
                    Last synced: {formatDate(playlist.lastSyncedAt)}
                </p>
            </div>

            <div className="playlist-actions">
                <button onClick={onDownload} title="Download All" className="action-btn">
                    📥 All
                </button>
                {playlist.newTracks > 0 && (
                    <button onClick={onDownloadNew} title="Download New Only" className="action-btn primary">
                        ✨ New ({playlist.newTracks})
                    </button>
                )}
                <button onClick={onSync} title="Sync" className="action-btn">
                    🔄
                </button>
                <button onClick={onRemove} title="Remove" className="action-btn danger">
                    🗑️
                </button>
            </div>
        </div>
    );
}

export default PlaylistCard;
```

#### History.jsx

```jsx
import { useState, useEffect } from 'react';
import axios from 'axios';
import HistoryItem from './HistoryItem';
import './History.css';

function History() {
    const [history, setHistory] = useState({ items: [], total: 0 });
    const [filter, setFilter] = useState('all');
    const [search, setSearch] = useState('');
    const [page, setPage] = useState(0);
    const [loading, setLoading] = useState(true);
    const pageSize = 50;

    useEffect(() => {
        fetchHistory();
    }, [filter, page]);

    const fetchHistory = async () => {
        setLoading(true);
        try {
            const params = {
                limit: pageSize,
                offset: page * pageSize
            };
            if (filter !== 'all') params.type = filter;

            const response = await axios.get(`${API_BASE}/history`, { params });
            setHistory(response.data);
        } catch (error) {
            console.error('Failed to fetch history:', error);
        } finally {
            setLoading(false);
        }
    };

    const handleSearch = async () => {
        if (!search.trim()) {
            fetchHistory();
            return;
        }

        setLoading(true);
        try {
            const response = await axios.get(`${API_BASE}/history/search`, {
                params: { q: search }
            });
            setHistory({ items: response.data, total: response.data.length });
        } catch (error) {
            console.error('Search failed:', error);
        } finally {
            setLoading(false);
        }
    };

    const handleRedownload = async (item) => {
        try {
            await axios.post(`${API_BASE}/history/${item.id}/redownload`);
            alert('Added to queue');
        } catch (error) {
            alert('Failed: ' + error.message);
        }
    };

    const handleDelete = async (item) => {
        try {
            await axios.delete(`${API_BASE}/history/${item.id}`);
            fetchHistory();
        } catch (error) {
            console.error('Delete failed:', error);
        }
    };

    const handleClearAll = async () => {
        if (!confirm('Clear all download history?')) return;
        try {
            await axios.delete(`${API_BASE}/history`);
            fetchHistory();
        } catch (error) {
            console.error('Clear failed:', error);
        }
    };

    return (
        <div className="history-page">
            <header className="history-header">
                <h2>Download History</h2>
                <div className="history-controls">
                    <div className="search-box">
                        <input
                            type="search"
                            placeholder="Search history..."
                            value={search}
                            onChange={e => setSearch(e.target.value)}
                            onKeyDown={e => e.key === 'Enter' && handleSearch()}
                        />
                        <button onClick={handleSearch}>🔍</button>
                    </div>
                    <select value={filter} onChange={e => setFilter(e.target.value)}>
                        <option value="all">All Types</option>
                        <option value="track">Tracks</option>
                        <option value="album">Albums</option>
                        <option value="playlist">Playlists</option>
                    </select>
                    <button onClick={handleClearAll} className="danger">Clear All</button>
                </div>
            </header>

            {loading ? (
                <div className="loading">Loading history...</div>
            ) : history.items.length === 0 ? (
                <div className="empty-state">
                    <p>No download history</p>
                </div>
            ) : (
                <>
                    <div className="history-list">
                        {history.items.map(item => (
                            <HistoryItem
                                key={item.id}
                                item={item}
                                onRedownload={() => handleRedownload(item)}
                                onDelete={() => handleDelete(item)}
                            />
                        ))}
                    </div>

                    {history.total > pageSize && (
                        <div className="pagination">
                            <button 
                                disabled={page === 0}
                                onClick={() => setPage(p => p - 1)}
                            >
                                Previous
                            </button>
                            <span>Page {page + 1} of {Math.ceil(history.total / pageSize)}</span>
                            <button 
                                disabled={(page + 1) * pageSize >= history.total}
                                onClick={() => setPage(p => p + 1)}
                            >
                                Next
                            </button>
                        </div>
                    )}
                </>
            )}
        </div>
    );
}

export default History;
```

### Data Storage

**Location:** `%localappdata%/Soggfy/stats.db` (shared SQLite database)

**Why SQLite over JSON files?**

| Feature                | JSON Files                    | SQLite                            |
|------------------------|-------------------------------|-----------------------------------|
| Playlist track storage | Array of all IDs in memory    | Separate table, on-demand access  |
| Finding new tracks     | O(n) array comparison         | O(1) with indexed timestamp query |
| History search         | O(n) linear scan              | O(log n) indexed search           |
| Pagination             | Load all, slice in memory     | Native LIMIT/OFFSET               |
| Data integrity         | Two files can get out of sync | Single file with transactions     |
| Concurrent access      | Risk of corruption            | ACID compliant                    |

**Database Size Estimate:**
- 1 playlist with 100 tracks ~5 KB
- 100 playlists ~500 KB
- 10,000 history items ~1 MB

## UI Design

### Saved Playlists Grid

```
┌─────────────────────────────────────────────────────────────────┐
│  📚 Saved Playlists                    [🔄 Sync All] [➕ Add]   │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │
│  │   [image]   │  │   [image]   │  │   [image]   │              │
│  │  ┌──────┐   │  │             │  │  ┌──────┐   │              │
│  │  │3 new │   │  │             │  │  │5 new │   │              │
│  │  └──────┘   │  │             │  │  └──────┘   │              │
│  ├─────────────┤  ├─────────────┤  ├─────────────┤              │
│  │ Top Hits    │  │ Chill Vibes │  │ Workout Mix │              │
│  │ Spotify     │  │ John Doe    │  │ Spotify     │              │
│  │ 50 tracks   │  │ 32 tracks   │  │ 45 tracks   │              │
│  │ Synced: Today│ │ Synced: 2d  │  │ Synced: 1h  │              │
│  ├─────────────┤  ├─────────────┤  ├─────────────┤              │
│  │[📥 All][✨ 3]│ │  [📥 All]   │  │[📥 All][✨ 5]│              │
│  │  [🔄] [🗑️]  │  │  [🔄] [🗑️]  │  │  [🔄] [🗑️]  │              │
│  └─────────────┘  └─────────────┘  └─────────────┘              │
└─────────────────────────────────────────────────────────────────┘
```

### Download History

```
┌─────────────────────────────────────────────────────────────────┐
│  📜 Download History                                            │
│  [🔍 Search...          ] [All Types ▼] [Clear All]            │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────┬────────────────────────────────┬──────────┬─────────┐  │
│  │ 🎵  │ Bohemian Rhapsody              │ 2h ago   │ [↻] [🗑]│  │
│  │     │ Queen • A Night at the Opera   │          │         │  │
│  ├─────┼────────────────────────────────┼──────────┼─────────┤  │
│  │ 💿  │ A Night at the Opera           │ 3h ago   │ [↻] [🗑]│  │
│  │     │ Queen • 12 tracks              │          │         │  │
│  ├─────┼────────────────────────────────┼──────────┼─────────┤  │
│  │ 📚  │ Today's Top Hits               │ Yesterday│ [↻] [🗑]│  │
│  │     │ Spotify • 50 tracks            │          │         │  │
│  └─────┴────────────────────────────────┴──────────┴─────────┘  │
│                                                                 │
│  [← Previous]        Page 1 of 5        [Next →]               │
└─────────────────────────────────────────────────────────────────┘
```

## Navigation Integration

Add tabs to main app:

```jsx
// App.jsx
const [activeTab, setActiveTab] = useState('queue');

return (
    <div className="app">
        <nav className="main-nav">
            <button 
                className={activeTab === 'queue' ? 'active' : ''}
                onClick={() => setActiveTab('queue')}
            >
                Queue
            </button>
            <button 
                className={activeTab === 'playlists' ? 'active' : ''}
                onClick={() => setActiveTab('playlists')}
            >
                Playlists
            </button>
            <button 
                className={activeTab === 'history' ? 'active' : ''}
                onClick={() => setActiveTab('history')}
            >
                History
            </button>
        </nav>

        <main>
            {activeTab === 'queue' && <Queue />}
            {activeTab === 'playlists' && <Playlists />}
            {activeTab === 'history' && <History />}
        </main>
    </div>
);
```

## Testing

1. Save multiple playlists from different sources
2. Verify sync detects new and removed tracks correctly
3. Test "download all" and "download new only" functions
4. Verify history records all downloads with correct types
5. Test history search with various queries
6. Test history pagination with 100+ items
7. Test re-download from history
8. Verify data persistence after restart
9. Test removing a playlist clears its tracks (CASCADE)
10. Test concurrent sync operations

## Performance Considerations

- **Prepared statements**: All frequent queries use prepared statements
- **Indexed columns**: playlist_id, downloaded_at, item_type, item_id
- **CASCADE delete**: Playlist tracks auto-deleted when playlist removed
- **Pagination**: History uses LIMIT/OFFSET for large datasets
- **Transaction batching**: Playlist save uses single transaction for playlist + tracks

## Future Enhancements

- Album favorites (not just playlists)
- Artist follow with new release notifications
- Smart playlists based on download patterns
- Playlist folder organization
- Share saved playlists between Web UI instances
- Playlist cover art caching
- Offline playlist metadata
