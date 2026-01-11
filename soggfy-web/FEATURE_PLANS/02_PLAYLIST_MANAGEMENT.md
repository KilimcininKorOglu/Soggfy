# Playlist Management Feature

**Branch:** `feature/playlist-management`

## Overview

Add playlist management capabilities to save favorite playlists, enable one-click downloading, and maintain download history for easy re-downloading.

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

#### New Files

```
soggfy-web/backend/
├── playlistManager.js    # Playlist saving and sync logic
├── playlists.json        # Saved playlists storage
├── downloadHistory.json  # Download history storage
```

#### playlistManager.js

```javascript
class PlaylistManager {
  constructor(spotify, dbPath) {
    this.spotify = spotify;
    this.dbPath = dbPath;
    this.data = this.load();
  }

  // Save a playlist to favorites
  async savePlaylist(playlistId) {
    const playlist = await this.spotify.getPlaylist(playlistId);
    const trackIds = playlist.tracks.items.map(t => t.track.id);
    
    this.data.playlists[playlistId] = {
      id: playlistId,
      name: playlist.name,
      description: playlist.description,
      image: playlist.images[0]?.url,
      owner: playlist.owner.display_name,
      trackCount: playlist.tracks.total,
      trackIds: trackIds,
      savedAt: Date.now(),
      lastSyncedAt: Date.now(),
      lastDownloadedAt: null
    };
    
    this.save();
    return this.data.playlists[playlistId];
  }

  // Remove playlist from favorites
  removePlaylist(playlistId) {
    delete this.data.playlists[playlistId];
    this.save();
  }

  // Get all saved playlists
  getPlaylists() {
    return Object.values(this.data.playlists);
  }

  // Check for new tracks in a playlist
  async syncPlaylist(playlistId) {
    const saved = this.data.playlists[playlistId];
    if (!saved) return null;

    const current = await this.spotify.getPlaylist(playlistId);
    const currentTrackIds = current.tracks.items.map(t => t.track.id);
    const newTrackIds = currentTrackIds.filter(id => !saved.trackIds.includes(id));

    saved.trackCount = current.tracks.total;
    saved.newTracks = newTrackIds.length;
    saved.lastSyncedAt = Date.now();
    
    this.save();
    
    return {
      ...saved,
      newTrackIds
    };
  }

  // Sync all saved playlists
  async syncAllPlaylists() {
    const results = [];
    for (const playlistId of Object.keys(this.data.playlists)) {
      try {
        const result = await this.syncPlaylist(playlistId);
        results.push(result);
      } catch (error) {
        results.push({ id: playlistId, error: error.message });
      }
    }
    return results;
  }

  // Record download in history
  addToHistory(item) {
    const entry = {
      id: item.id,
      type: item.type, // 'track', 'album', 'playlist'
      name: item.name,
      artist: item.artist,
      image: item.image,
      trackCount: item.trackCount || 1,
      url: item.url,
      downloadedAt: Date.now()
    };

    // Avoid duplicates - update timestamp if exists
    const existingIndex = this.data.history.findIndex(h => h.id === item.id);
    if (existingIndex >= 0) {
      this.data.history[existingIndex] = entry;
    } else {
      this.data.history.unshift(entry);
    }

    // Keep only last 500 entries
    if (this.data.history.length > 500) {
      this.data.history = this.data.history.slice(0, 500);
    }

    this.save();
    return entry;
  }

  // Get download history
  getHistory(options = {}) {
    let history = [...this.data.history];

    if (options.type) {
      history = history.filter(h => h.type === options.type);
    }

    if (options.search) {
      const search = options.search.toLowerCase();
      history = history.filter(h => 
        h.name.toLowerCase().includes(search) ||
        h.artist?.toLowerCase().includes(search)
      );
    }

    if (options.limit) {
      history = history.slice(0, options.limit);
    }

    return history;
  }

  // Clear history
  clearHistory(beforeDate = null) {
    if (beforeDate) {
      this.data.history = this.data.history.filter(h => h.downloadedAt >= beforeDate);
    } else {
      this.data.history = [];
    }
    this.save();
  }
}
```

#### API Endpoints

| Method | Endpoint                      | Description                            |
|--------|-------------------------------|----------------------------------------|
| GET    | `/api/playlists`              | Get saved playlists                    |
| POST   | `/api/playlists`              | Save a playlist                        |
| DELETE | `/api/playlists/:id`          | Remove saved playlist                  |
| POST   | `/api/playlists/:id/sync`     | Sync playlist for new tracks           |
| POST   | `/api/playlists/sync-all`     | Sync all playlists                     |
| POST   | `/api/playlists/:id/download` | Download playlist (or new tracks only) |
| GET    | `/api/history`                | Get download history                   |
| POST   | `/api/history/:id/redownload` | Re-download from history               |
| DELETE | `/api/history`                | Clear history                          |

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
function Playlists({ onClose }) {
  const [playlists, setPlaylists] = useState([]);
  const [syncing, setSyncing] = useState(false);
  const [showAdd, setShowAdd] = useState(false);

  const handleSyncAll = async () => {
    setSyncing(true);
    await axios.post(`${API_BASE}/playlists/sync-all`);
    await fetchPlaylists();
    setSyncing(false);
  };

  const handleDownload = async (playlistId, newOnly = false) => {
    await axios.post(`${API_BASE}/playlists/${playlistId}/download`, { newOnly });
  };

  return (
    <div className="playlists-page">
      <header>
        <h2>Saved Playlists</h2>
        <div className="actions">
          <button onClick={handleSyncAll} disabled={syncing}>
            {syncing ? 'Syncing...' : 'Sync All'}
          </button>
          <button onClick={() => setShowAdd(true)}>Add Playlist</button>
        </div>
      </header>

      <div className="playlist-grid">
        {playlists.map(playlist => (
          <PlaylistCard
            key={playlist.id}
            playlist={playlist}
            onDownload={() => handleDownload(playlist.id)}
            onDownloadNew={() => handleDownload(playlist.id, true)}
            onRemove={() => handleRemove(playlist.id)}
          />
        ))}
      </div>

      {showAdd && <AddPlaylistModal onClose={() => setShowAdd(false)} />}
    </div>
  );
}
```

#### PlaylistCard.jsx

```jsx
function PlaylistCard({ playlist, onDownload, onDownloadNew, onRemove }) {
  return (
    <div className="playlist-card">
      <img src={playlist.image} alt={playlist.name} className="playlist-image" />
      
      <div className="playlist-info">
        <h3>{playlist.name}</h3>
        <p>{playlist.owner} • {playlist.trackCount} tracks</p>
        
        {playlist.newTracks > 0 && (
          <span className="new-badge">{playlist.newTracks} new</span>
        )}
      </div>

      <div className="playlist-actions">
        <button onClick={onDownload} title="Download All">
          📥 All
        </button>
        {playlist.newTracks > 0 && (
          <button onClick={onDownloadNew} title="Download New Only">
            ✨ New
          </button>
        )}
        <button onClick={onRemove} className="remove" title="Remove">
          🗑️
        </button>
      </div>
    </div>
  );
}
```

### Data Storage

#### playlists.json

```json
{
  "playlists": {
    "37i9dQZF1DXcBWIGoYBM5M": {
      "id": "37i9dQZF1DXcBWIGoYBM5M",
      "name": "Today's Top Hits",
      "description": "The hottest tracks right now",
      "image": "https://i.scdn.co/image/...",
      "owner": "Spotify",
      "trackCount": 50,
      "trackIds": ["id1", "id2", "..."],
      "savedAt": 1704067200000,
      "lastSyncedAt": 1704153600000,
      "lastDownloadedAt": 1704140000000,
      "newTracks": 3
    }
  }
}
```

#### downloadHistory.json

```json
{
  "history": [
    {
      "id": "37i9dQZF1DXcBWIGoYBM5M",
      "type": "playlist",
      "name": "Today's Top Hits",
      "artist": null,
      "image": "https://i.scdn.co/image/...",
      "trackCount": 50,
      "url": "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M",
      "downloadedAt": 1704153600000
    },
    {
      "id": "4iV5W9uYEdYUVa79Axb7Rh",
      "type": "track",
      "name": "Bohemian Rhapsody",
      "artist": "Queen",
      "image": "https://i.scdn.co/image/...",
      "trackCount": 1,
      "url": "https://open.spotify.com/track/4iV5W9uYEdYUVa79Axb7Rh",
      "downloadedAt": 1704150000000
    }
  ]
}
```

## UI Design

### Saved Playlists Grid

```
┌─────────────────────────────────────────────────────────────────┐
│  📚 Saved Playlists                    [Sync All] [Add Playlist] │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐             │
│  │  🎵     │  │  🎵     │  │  🎵     │  │  🎵     │             │
│  │ [image] │  │ [image] │  │ [image] │  │ [image] │             │
│  ├─────────┤  ├─────────┤  ├─────────┤  ├─────────┤             │
│  │Top Hits │  │Chill    │  │Workout  │  │Sleep   │             │
│  │50 tracks│  │32 tracks│  │45 tracks│  │28 tracks│             │
│  │ [3 new] │  │         │  │ [5 new] │  │         │             │
│  ├─────────┤  ├─────────┤  ├─────────┤  ├─────────┤             │
│  │[All][New]│  │  [All]  │  │[All][New]│  │  [All]  │             │
│  └─────────┘  └─────────┘  └─────────┘  └─────────┘             │
└─────────────────────────────────────────────────────────────────┘
```

### Download History

```
┌─────────────────────────────────────────────────────────────────┐
│  📜 Download History           [Search...] [Filter ▼] [Clear]   │
├─────────────────────────────────────────────────────────────────┤
│  🎵 Bohemian Rhapsody - Queen              2 hours ago    [↻]   │
│  💿 A Night at the Opera - Queen           3 hours ago    [↻]   │
│  📚 Today's Top Hits (50 tracks)           Yesterday      [↻]   │
│  🎵 Stairway to Heaven - Led Zeppelin      2 days ago     [↻]   │
│  💿 Led Zeppelin IV - Led Zeppelin         2 days ago     [↻]   │
└─────────────────────────────────────────────────────────────────┘
```

## Navigation Integration

Add tabs or sidebar navigation:

```jsx
// App.jsx
<nav className="main-nav">
  <button className={tab === 'queue' ? 'active' : ''} onClick={() => setTab('queue')}>
    Queue
  </button>
  <button className={tab === 'playlists' ? 'active' : ''} onClick={() => setTab('playlists')}>
    Playlists
  </button>
  <button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>
    History
  </button>
</nav>
```

## Testing

1. Save multiple playlists from different sources
2. Verify sync detects new tracks correctly
3. Test "download all" and "download new only" functions
4. Verify history records all downloads
5. Test history search and filter
6. Test re-download from history
7. Verify data persistence after restart

## Future Enhancements

- Album favorites (not just playlists)
- Artist follow with new release notifications
- Smart playlists based on download patterns
- Playlist folder organization
- Share saved playlists between Web UI instances
