# Search Feature

**Branch:** `feature/search`

## Overview

Add Spotify search functionality to the Web UI, allowing users to search for tracks, albums, artists, and playlists directly and download them without needing to copy URLs from Spotify. Uses SQLite for persistent search history, sharing the database with other features.

## Features

### 1. Search Types

- Track search
- Album search
- Artist search (view discography)
- Playlist search

### 2. Search Results

- Display results with artwork, metadata
- Inline download buttons
- Quick add to queue
- View artist discography
- View album tracks

### 3. Search History

- Recent searches with timestamps
- Result count tracking
- Clear search history
- Quick re-search
- Duplicate prevention (updates timestamp)

### 4. Artist Discography

- View all albums by artist
- Filter by album type (album, single, compilation)
- Download full discography option

## Technical Implementation

### Database Schema

Extends the existing `stats.db` SQLite database:

```sql
-- Search history table
CREATE TABLE IF NOT EXISTS search_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    query TEXT NOT NULL UNIQUE,
    searched_at INTEGER NOT NULL,
    search_count INTEGER DEFAULT 1,
    last_result_count INTEGER
);

CREATE INDEX IF NOT EXISTS idx_search_query ON search_history(query);
CREATE INDEX IF NOT EXISTS idx_search_time ON search_history(searched_at DESC);

-- Favorite artists table (optional enhancement)
CREATE TABLE IF NOT EXISTS favorite_artists (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    image_url TEXT,
    followers INTEGER,
    added_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_favorite_added ON favorite_artists(added_at DESC);
```

### Backend Changes

#### New Files

```
soggfy-web/backend/
├── searchHistory.js      # Search history manager using SQLite
```

#### searchHistory.js

```javascript
class SearchHistory {
    constructor(db) {
        this.db = db; // Shared SQLite database
        this.initTables();
        this.prepareStatements();
    }

    initTables() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS search_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                query TEXT NOT NULL UNIQUE,
                searched_at INTEGER NOT NULL,
                search_count INTEGER DEFAULT 1,
                last_result_count INTEGER
            );

            CREATE INDEX IF NOT EXISTS idx_search_query ON search_history(query);
            CREATE INDEX IF NOT EXISTS idx_search_time ON search_history(searched_at DESC);

            CREATE TABLE IF NOT EXISTS favorite_artists (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                image_url TEXT,
                followers INTEGER,
                added_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_favorite_added ON favorite_artists(added_at DESC);
        `);
    }

    prepareStatements() {
        this.stmts = {
            // Search history
            upsertSearch: this.db.prepare(`
                INSERT INTO search_history (query, searched_at, search_count, last_result_count)
                VALUES (@query, @searchedAt, 1, @resultCount)
                ON CONFLICT(query) DO UPDATE SET
                    searched_at = @searchedAt,
                    search_count = search_count + 1,
                    last_result_count = @resultCount
            `),
            getHistory: this.db.prepare(`
                SELECT * FROM search_history 
                ORDER BY searched_at DESC 
                LIMIT ?
            `),
            getPopularSearches: this.db.prepare(`
                SELECT * FROM search_history 
                ORDER BY search_count DESC 
                LIMIT ?
            `),
            searchInHistory: this.db.prepare(`
                SELECT * FROM search_history 
                WHERE query LIKE ? 
                ORDER BY searched_at DESC 
                LIMIT ?
            `),
            deleteSearch: this.db.prepare(`DELETE FROM search_history WHERE id = ?`),
            clearHistory: this.db.prepare(`DELETE FROM search_history`),
            getHistoryStats: this.db.prepare(`
                SELECT 
                    COUNT(*) as total_searches,
                    SUM(search_count) as total_queries,
                    MAX(searched_at) as last_search
                FROM search_history
            `),

            // Favorite artists
            addFavorite: this.db.prepare(`
                INSERT OR REPLACE INTO favorite_artists (id, name, image_url, followers, added_at)
                VALUES (@id, @name, @imageUrl, @followers, @addedAt)
            `),
            removeFavorite: this.db.prepare(`DELETE FROM favorite_artists WHERE id = ?`),
            getFavorites: this.db.prepare(`
                SELECT * FROM favorite_artists ORDER BY added_at DESC
            `),
            isFavorite: this.db.prepare(`SELECT 1 FROM favorite_artists WHERE id = ?`)
        };
    }

    // ==================== SEARCH HISTORY ====================

    // Add or update search query
    add(query, resultCount = null) {
        const normalizedQuery = query.trim().toLowerCase();
        if (!normalizedQuery) return;

        this.stmts.upsertSearch.run({
            query: normalizedQuery,
            searchedAt: Date.now(),
            resultCount
        });
    }

    // Get recent search history
    getRecent(limit = 20) {
        return this.stmts.getHistory.all(limit).map(row => ({
            id: row.id,
            query: row.query,
            searchedAt: row.searched_at,
            searchCount: row.search_count,
            lastResultCount: row.last_result_count
        }));
    }

    // Get most popular searches
    getPopular(limit = 10) {
        return this.stmts.getPopularSearches.all(limit).map(row => ({
            id: row.id,
            query: row.query,
            searchCount: row.search_count,
            lastResultCount: row.last_result_count
        }));
    }

    // Search within history (for autocomplete)
    searchHistory(prefix, limit = 5) {
        return this.stmts.searchInHistory.all(`${prefix}%`, limit).map(row => ({
            id: row.id,
            query: row.query,
            searchCount: row.search_count
        }));
    }

    // Delete single search from history
    delete(id) {
        this.stmts.deleteSearch.run(id);
    }

    // Clear all search history
    clear() {
        this.stmts.clearHistory.run();
    }

    // Get history statistics
    getStats() {
        const row = this.stmts.getHistoryStats.get();
        return {
            totalSearches: row.total_searches,
            totalQueries: row.total_queries,
            lastSearch: row.last_search
        };
    }

    // ==================== FAVORITE ARTISTS ====================

    // Add artist to favorites
    addFavorite(artist) {
        this.stmts.addFavorite.run({
            id: artist.id,
            name: artist.name,
            imageUrl: artist.images?.[0]?.url || null,
            followers: artist.followers?.total || 0,
            addedAt: Date.now()
        });
    }

    // Remove artist from favorites
    removeFavorite(artistId) {
        this.stmts.removeFavorite.run(artistId);
    }

    // Get all favorite artists
    getFavorites() {
        return this.stmts.getFavorites.all().map(row => ({
            id: row.id,
            name: row.name,
            imageUrl: row.image_url,
            followers: row.followers,
            addedAt: row.added_at
        }));
    }

    // Check if artist is favorite
    isFavorite(artistId) {
        return !!this.stmts.isFavorite.get(artistId);
    }
}

module.exports = SearchHistory;
```

#### spotifyAuth.js Additions

```javascript
class SpotifyAPI {
    // ... existing code ...

    // Search Spotify
    async search(query, types = ['track', 'album', 'artist', 'playlist'], limit = 20) {
        await this.ensureToken();

        const response = await axios.get('https://api.spotify.com/v1/search', {
            headers: { Authorization: `Bearer ${this.userAccessToken}` },
            params: {
                q: query,
                type: types.join(','),
                limit,
                market: 'US'
            }
        });

        return {
            tracks: response.data.tracks?.items || [],
            albums: response.data.albums?.items || [],
            artists: response.data.artists?.items || [],
            playlists: response.data.playlists?.items || []
        };
    }

    // Get artist details
    async getArtist(artistId) {
        await this.ensureToken();

        const response = await axios.get(
            `https://api.spotify.com/v1/artists/${artistId}`,
            { headers: { Authorization: `Bearer ${this.userAccessToken}` } }
        );

        return response.data;
    }

    // Get artist albums with pagination
    async getArtistAlbums(artistId, includeGroups = 'album,single', limit = 50) {
        await this.ensureToken();

        const response = await axios.get(
            `https://api.spotify.com/v1/artists/${artistId}/albums`,
            {
                headers: { Authorization: `Bearer ${this.userAccessToken}` },
                params: {
                    include_groups: includeGroups,
                    limit,
                    market: 'US'
                }
            }
        );

        return response.data.items;
    }

    // Get artist top tracks
    async getArtistTopTracks(artistId, market = 'US') {
        await this.ensureToken();

        const response = await axios.get(
            `https://api.spotify.com/v1/artists/${artistId}/top-tracks`,
            {
                headers: { Authorization: `Bearer ${this.userAccessToken}` },
                params: { market }
            }
        );

        return response.data.tracks;
    }

    // Get related artists
    async getRelatedArtists(artistId) {
        await this.ensureToken();

        const response = await axios.get(
            `https://api.spotify.com/v1/artists/${artistId}/related-artists`,
            { headers: { Authorization: `Bearer ${this.userAccessToken}` } }
        );

        return response.data.artists;
    }

    // Get album details with tracks
    async getAlbum(albumId) {
        await this.ensureToken();

        const response = await axios.get(
            `https://api.spotify.com/v1/albums/${albumId}`,
            { headers: { Authorization: `Bearer ${this.userAccessToken}` } }
        );

        return response.data;
    }
}
```

#### API Endpoints

| Method | Endpoint                            | Description              |
|--------|-------------------------------------|--------------------------|
| GET    | `/api/search`                       | Search Spotify           |
| GET    | `/api/search/artist/:id`            | Get artist details       |
| GET    | `/api/search/artist/:id/albums`     | Get artist albums        |
| GET    | `/api/search/artist/:id/top-tracks` | Get artist top tracks    |
| GET    | `/api/search/artist/:id/related`    | Get related artists      |
| GET    | `/api/search/album/:id`             | Get album with tracks    |
| GET    | `/api/search/history`               | Get search history       |
| GET    | `/api/search/history/popular`       | Get popular searches     |
| GET    | `/api/search/history/suggest`       | Autocomplete suggestions |
| DELETE | `/api/search/history`               | Clear all search history |
| DELETE | `/api/search/history/:id`           | Delete single search     |
| GET    | `/api/search/favorites`             | Get favorite artists     |
| POST   | `/api/search/favorites`             | Add favorite artist      |
| DELETE | `/api/search/favorites/:id`         | Remove favorite artist   |

#### server.js Integration

```javascript
const SearchHistory = require('./searchHistory');

// Share database with StatsManager
const searchHistory = new SearchHistory(stats.db);

// Search Spotify
app.get('/api/search', authMiddleware, async (req, res) => {
    try {
        const { q, types, limit } = req.query;

        if (!q) {
            return res.status(400).json({ error: 'Query is required' });
        }

        const typeArray = types ? types.split(',') : ['track', 'album', 'artist', 'playlist'];
        const results = await spotify.search(q, typeArray, parseInt(limit) || 20);

        // Calculate total results
        const totalResults = 
            results.tracks.length + 
            results.albums.length + 
            results.artists.length + 
            results.playlists.length;

        // Save to search history with result count
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
        // Add favorite status
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
        // Add favorite status to each
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
```

### Frontend Changes

#### New Components

```
soggfy-web/frontend/src/components/
├── Search/
│   ├── Search.jsx              # Main search page
│   ├── Search.css              # Styles
│   ├── SearchBar.jsx           # Search input with autocomplete
│   ├── SearchResults.jsx       # Results container
│   ├── TrackResult.jsx         # Track result item
│   ├── AlbumResult.jsx         # Album result item
│   ├── ArtistResult.jsx        # Artist result item
│   ├── PlaylistResult.jsx      # Playlist result item
│   ├── ArtistDetail.jsx        # Artist discography view
│   ├── AlbumDetail.jsx         # Album tracks view
│   └── FavoriteArtists.jsx     # Favorite artists sidebar
```

#### SearchBar.jsx with Autocomplete

```jsx
import { useState, useEffect, useRef } from 'react';
import axios from 'axios';

function SearchBar({ value, onChange, onSearch, history }) {
    const [suggestions, setSuggestions] = useState([]);
    const [showSuggestions, setShowSuggestions] = useState(false);
    const inputRef = useRef(null);

    useEffect(() => {
        if (value.length >= 2) {
            fetchSuggestions(value);
        } else {
            setSuggestions([]);
        }
    }, [value]);

    const fetchSuggestions = async (query) => {
        try {
            const response = await axios.get(`${API_BASE}/search/history/suggest`, {
                params: { q: query, limit: 5 }
            });
            setSuggestions(response.data);
        } catch (error) {
            console.error('Failed to fetch suggestions:', error);
        }
    };

    const handleSubmit = (e) => {
        e.preventDefault();
        setShowSuggestions(false);
        onSearch(value);
    };

    const handleSuggestionClick = (query) => {
        onChange(query);
        setShowSuggestions(false);
        onSearch(query);
    };

    return (
        <form onSubmit={handleSubmit} className="search-bar">
            <div className="search-input-wrapper">
                <span className="search-icon">🔍</span>
                <input
                    ref={inputRef}
                    type="text"
                    value={value}
                    onChange={(e) => onChange(e.target.value)}
                    onFocus={() => setShowSuggestions(true)}
                    onBlur={() => setTimeout(() => setShowSuggestions(false), 200)}
                    placeholder="Search Spotify..."
                    className="search-input"
                />
                {value && (
                    <button 
                        type="button" 
                        className="clear-btn"
                        onClick={() => onChange('')}
                    >
                        ×
                    </button>
                )}
            </div>

            {showSuggestions && suggestions.length > 0 && (
                <ul className="suggestions-dropdown">
                    {suggestions.map(item => (
                        <li 
                            key={item.id}
                            onClick={() => handleSuggestionClick(item.query)}
                        >
                            <span className="suggestion-icon">🕐</span>
                            <span className="suggestion-query">{item.query}</span>
                            <span className="suggestion-count">({item.searchCount})</span>
                        </li>
                    ))}
                </ul>
            )}

            {history && history.length > 0 && !value && (
                <div className="recent-searches">
                    <span className="recent-label">Recent:</span>
                    {history.slice(0, 5).map(item => (
                        <button
                            key={item.id}
                            type="button"
                            className="recent-tag"
                            onClick={() => handleSuggestionClick(item.query)}
                        >
                            {item.query}
                        </button>
                    ))}
                </div>
            )}

            <button type="submit" className="search-btn">Search</button>
        </form>
    );
}

export default SearchBar;
```

#### Search.jsx Structure

```jsx
import { useState, useEffect } from 'react';
import axios from 'axios';
import SearchBar from './SearchBar';
import SearchResults from './SearchResults';
import ArtistDetail from './ArtistDetail';
import AlbumDetail from './AlbumDetail';
import FavoriteArtists from './FavoriteArtists';
import './Search.css';

function Search() {
    const [query, setQuery] = useState('');
    const [results, setResults] = useState(null);
    const [loading, setLoading] = useState(false);
    const [activeTab, setActiveTab] = useState('all');
    const [selectedArtist, setSelectedArtist] = useState(null);
    const [selectedAlbum, setSelectedAlbum] = useState(null);
    const [searchHistory, setSearchHistory] = useState([]);
    const [favorites, setFavorites] = useState([]);

    useEffect(() => {
        fetchHistory();
        fetchFavorites();
    }, []);

    const fetchHistory = async () => {
        try {
            const response = await axios.get(`${API_BASE}/search/history`);
            setSearchHistory(response.data);
        } catch (error) {
            console.error('Failed to fetch history:', error);
        }
    };

    const fetchFavorites = async () => {
        try {
            const response = await axios.get(`${API_BASE}/search/favorites`);
            setFavorites(response.data);
        } catch (error) {
            console.error('Failed to fetch favorites:', error);
        }
    };

    const handleSearch = async (searchQuery) => {
        if (!searchQuery.trim()) return;

        setLoading(true);
        try {
            const response = await axios.get(`${API_BASE}/search`, {
                params: { q: searchQuery }
            });
            setResults(response.data);
            setQuery(searchQuery);
            fetchHistory(); // Refresh history
        } catch (error) {
            console.error('Search failed:', error);
        } finally {
            setLoading(false);
        }
    };

    const handleDownloadTrack = async (track) => {
        await axios.post(`${API_BASE}/download`, {
            url: `spotify:track:${track.id}`
        });
    };

    const handleDownloadAlbum = async (album) => {
        await axios.post(`${API_BASE}/download`, {
            url: `spotify:album:${album.id}`
        });
    };

    const handleToggleFavorite = async (artist) => {
        try {
            if (artist.isFavorite) {
                await axios.delete(`${API_BASE}/search/favorites/${artist.id}`);
            } else {
                await axios.post(`${API_BASE}/search/favorites`, { artistId: artist.id });
            }
            fetchFavorites();
        } catch (error) {
            console.error('Failed to toggle favorite:', error);
        }
    };

    const handleClearHistory = async () => {
        if (!confirm('Clear all search history?')) return;
        try {
            await axios.delete(`${API_BASE}/search/history`);
            setSearchHistory([]);
        } catch (error) {
            console.error('Failed to clear history:', error);
        }
    };

    return (
        <div className="search-page">
            <div className="search-main">
                <SearchBar
                    value={query}
                    onChange={setQuery}
                    onSearch={handleSearch}
                    history={searchHistory}
                />

                {loading && <div className="search-loading">Searching...</div>}

                {results && (
                    <>
                        <div className="search-tabs">
                            <button
                                className={activeTab === 'all' ? 'active' : ''}
                                onClick={() => setActiveTab('all')}
                            >
                                All
                            </button>
                            <button
                                className={activeTab === 'tracks' ? 'active' : ''}
                                onClick={() => setActiveTab('tracks')}
                            >
                                Tracks ({results.tracks.length})
                            </button>
                            <button
                                className={activeTab === 'albums' ? 'active' : ''}
                                onClick={() => setActiveTab('albums')}
                            >
                                Albums ({results.albums.length})
                            </button>
                            <button
                                className={activeTab === 'artists' ? 'active' : ''}
                                onClick={() => setActiveTab('artists')}
                            >
                                Artists ({results.artists.length})
                            </button>
                            <button
                                className={activeTab === 'playlists' ? 'active' : ''}
                                onClick={() => setActiveTab('playlists')}
                            >
                                Playlists ({results.playlists.length})
                            </button>
                        </div>

                        <SearchResults
                            results={results}
                            activeTab={activeTab}
                            onDownloadTrack={handleDownloadTrack}
                            onDownloadAlbum={handleDownloadAlbum}
                            onSelectArtist={setSelectedArtist}
                            onSelectAlbum={setSelectedAlbum}
                            onToggleFavorite={handleToggleFavorite}
                        />
                    </>
                )}

                {!results && !loading && searchHistory.length > 0 && (
                    <div className="history-section">
                        <div className="history-header">
                            <h3>Recent Searches</h3>
                            <button onClick={handleClearHistory} className="clear-link">
                                Clear all
                            </button>
                        </div>
                        <div className="history-list">
                            {searchHistory.map(item => (
                                <button
                                    key={item.id}
                                    className="history-item"
                                    onClick={() => handleSearch(item.query)}
                                >
                                    <span className="history-query">{item.query}</span>
                                    <span className="history-meta">
                                        {item.lastResultCount} results
                                    </span>
                                </button>
                            ))}
                        </div>
                    </div>
                )}
            </div>

            {favorites.length > 0 && (
                <FavoriteArtists
                    favorites={favorites}
                    onSelect={setSelectedArtist}
                    onRemove={handleToggleFavorite}
                />
            )}

            {selectedArtist && (
                <ArtistDetail
                    artist={selectedArtist}
                    onClose={() => setSelectedArtist(null)}
                    onDownloadAlbum={handleDownloadAlbum}
                    onDownloadTrack={handleDownloadTrack}
                    onToggleFavorite={handleToggleFavorite}
                />
            )}

            {selectedAlbum && (
                <AlbumDetail
                    album={selectedAlbum}
                    onClose={() => setSelectedAlbum(null)}
                    onDownloadTrack={handleDownloadTrack}
                    onDownloadAlbum={handleDownloadAlbum}
                />
            )}
        </div>
    );
}

export default Search;
```

#### TrackResult.jsx

```jsx
function TrackResult({ track, onDownload }) {
    const formatDuration = (ms) => {
        const minutes = Math.floor(ms / 60000);
        const seconds = Math.floor((ms % 60000) / 1000);
        return `${minutes}:${seconds.toString().padStart(2, '0')}`;
    };

    return (
        <div className="track-result">
            <img
                src={track.album.images[2]?.url || '/placeholder.png'}
                alt={track.album.name}
                className="track-image"
            />
            <div className="track-info">
                <div className="track-name">{track.name}</div>
                <div className="track-artist">
                    {track.artists.map(a => a.name).join(', ')}
                </div>
                <div className="track-album">{track.album.name}</div>
            </div>
            <div className="track-duration">
                {formatDuration(track.duration_ms)}
            </div>
            <button onClick={() => onDownload(track)} className="download-btn">
                📥
            </button>
        </div>
    );
}

export default TrackResult;
```

#### ArtistDetail.jsx with Favorites

```jsx
import { useState, useEffect } from 'react';
import axios from 'axios';
import TrackResult from './TrackResult';
import AlbumResult from './AlbumResult';

function ArtistDetail({ artist, onClose, onDownloadAlbum, onDownloadTrack, onToggleFavorite }) {
    const [fullArtist, setFullArtist] = useState(artist);
    const [albums, setAlbums] = useState([]);
    const [topTracks, setTopTracks] = useState([]);
    const [relatedArtists, setRelatedArtists] = useState([]);
    const [filter, setFilter] = useState('album,single');
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        fetchArtistData();
    }, [artist.id, filter]);

    const fetchArtistData = async () => {
        setLoading(true);
        try {
            const [artistRes, albumsRes, tracksRes, relatedRes] = await Promise.all([
                axios.get(`${API_BASE}/search/artist/${artist.id}`),
                axios.get(`${API_BASE}/search/artist/${artist.id}/albums`, {
                    params: { includeGroups: filter }
                }),
                axios.get(`${API_BASE}/search/artist/${artist.id}/top-tracks`),
                axios.get(`${API_BASE}/search/artist/${artist.id}/related`)
            ]);
            setFullArtist(artistRes.data);
            setAlbums(albumsRes.data);
            setTopTracks(tracksRes.data);
            setRelatedArtists(relatedRes.data.slice(0, 6));
        } catch (error) {
            console.error('Failed to fetch artist data:', error);
        } finally {
            setLoading(false);
        }
    };

    const handleDownloadDiscography = async () => {
        if (!confirm(`Download all ${albums.length} albums?`)) return;
        for (const album of albums) {
            await onDownloadAlbum(album);
        }
    };

    return (
        <div className="artist-detail-overlay">
            <div className="artist-detail-modal">
                <header className="artist-header">
                    <img 
                        src={fullArtist.images?.[0]?.url || '/placeholder.png'} 
                        alt={fullArtist.name}
                        className="artist-image"
                    />
                    <div className="artist-info">
                        <h2>{fullArtist.name}</h2>
                        <p className="followers">
                            {fullArtist.followers?.total?.toLocaleString()} followers
                        </p>
                        <div className="genres">
                            {fullArtist.genres?.slice(0, 3).map(g => (
                                <span key={g} className="genre-tag">{g}</span>
                            ))}
                        </div>
                    </div>
                    <div className="header-actions">
                        <button 
                            onClick={() => onToggleFavorite(fullArtist)}
                            className={`favorite-btn ${fullArtist.isFavorite ? 'active' : ''}`}
                        >
                            {fullArtist.isFavorite ? '❤️' : '🤍'}
                        </button>
                        <button onClick={onClose} className="close-btn">×</button>
                    </div>
                </header>

                <div className="artist-actions">
                    <button onClick={handleDownloadDiscography} className="download-all-btn">
                        📥 Download All ({albums.length} albums)
                    </button>
                </div>

                <div className="filter-tabs">
                    <button
                        className={filter === 'album' ? 'active' : ''}
                        onClick={() => setFilter('album')}
                    >
                        Albums
                    </button>
                    <button
                        className={filter === 'single' ? 'active' : ''}
                        onClick={() => setFilter('single')}
                    >
                        Singles
                    </button>
                    <button
                        className={filter === 'album,single' ? 'active' : ''}
                        onClick={() => setFilter('album,single')}
                    >
                        All
                    </button>
                    <button
                        className={filter === 'compilation' ? 'active' : ''}
                        onClick={() => setFilter('compilation')}
                    >
                        Compilations
                    </button>
                </div>

                {loading ? (
                    <div className="loading">Loading...</div>
                ) : (
                    <>
                        <section className="top-tracks">
                            <h3>Top Tracks</h3>
                            {topTracks.slice(0, 5).map((track, index) => (
                                <div key={track.id} className="top-track-row">
                                    <span className="track-number">{index + 1}</span>
                                    <TrackResult track={track} onDownload={onDownloadTrack} />
                                </div>
                            ))}
                        </section>

                        <section className="discography">
                            <h3>Discography</h3>
                            <div className="albums-grid">
                                {albums.map(album => (
                                    <AlbumResult
                                        key={album.id}
                                        album={album}
                                        onDownload={() => onDownloadAlbum(album)}
                                        compact
                                    />
                                ))}
                            </div>
                        </section>

                        {relatedArtists.length > 0 && (
                            <section className="related-artists">
                                <h3>Related Artists</h3>
                                <div className="related-grid">
                                    {relatedArtists.map(related => (
                                        <div key={related.id} className="related-artist-card">
                                            <img 
                                                src={related.images?.[2]?.url || '/placeholder.png'}
                                                alt={related.name}
                                            />
                                            <span>{related.name}</span>
                                        </div>
                                    ))}
                                </div>
                            </section>
                        )}
                    </>
                )}
            </div>
        </div>
    );
}

export default ArtistDetail;
```

### Data Storage

**Location:** `%localappdata%/Soggfy/stats.db` (shared SQLite database)

**Why SQLite over Memory/localStorage?**

| Feature            | Memory/localStorage | SQLite                |
|--------------------|---------------------|-----------------------|
| Persistence        | Lost on restart     | Permanent             |
| Search in history  | Linear scan         | Indexed LIKE query    |
| Popular searches   | Manual counting     | ORDER BY search_count |
| Duplicate handling | Manual check        | ON CONFLICT DO UPDATE |
| Storage limit      | ~5MB localStorage   | Unlimited             |
| Cross-session      | No                  | Yes                   |

**Database Size Estimate:**
- 1 search history entry ~100 bytes
- 1 favorite artist ~200 bytes
- 1000 searches + 50 favorites ~120 KB

## UI Design

### Search Page

```
┌─────────────────────────────────────────────────────────────────┐
│  🔍 [Search Spotify...                              ] [Search]  │
│     ┌──────────────────────────────────┐                        │
│     │ 🕐 queen (5)                     │  ← Autocomplete        │
│     │ 🕐 queen greatest hits (2)       │                        │
│     └──────────────────────────────────┘                        │
│     Recent: Queen, Led Zeppelin, Pink Floyd        [Clear all]  │
├─────────────────────────────────────────────────────────────────┤
│  [All] [Tracks (20)] [Albums (15)] [Artists (5)] [Playlists (8)]│
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  🎵 TRACKS                                                      │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ [img] Bohemian Rhapsody - Queen • A Night at... 5:55 [📥]│   │
│  │ [img] We Will Rock You - Queen • News of the... 2:02 [📥]│   │
│  │ [img] Somebody to Love - Queen • A Day at th... 4:56 [📥]│   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                 │
│  💿 ALBUMS                                                      │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐   │
│  │   [img]    │ │   [img]    │ │   [img]    │ │   [img]    │   │
│  │A Night at..│ │News of the.│ │Greatest Hit│ │The Game    │   │
│  │Queen • 1975│ │Queen • 1977│ │Queen • 1981│ │Queen • 1980│   │
│  │   [📥]     │ │   [📥]     │ │   [📥]     │ │   [📥]     │   │
│  └────────────┘ └────────────┘ └────────────┘ └────────────┘   │
│                                                                 │
│  🎤 ARTISTS                                                     │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐                   │
│  │   [img]    │ │   [img]    │ │   [img]    │                   │
│  │   Queen    │ │Queen + Adam│ │The Queen's │                   │
│  │ 45M follow │ │Gambit Sound│ │            │                   │
│  │[❤️][View →]│ │[🤍][View →]│ │[🤍][View →]│                   │
│  └────────────┘ └────────────┘ └────────────┘                   │
├─────────────────────────────────────────────────────────────────┤
│  ❤️ FAVORITE ARTISTS                                            │
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐                    │
│  │ [img]  │ │ [img]  │ │ [img]  │ │ [img]  │                    │
│  │ Queen  │ │Coldplay│ │Radiohead││  Muse  │                    │
│  └────────┘ └────────┘ └────────┘ └────────┘                    │
└─────────────────────────────────────────────────────────────────┘
```

### Artist Detail Modal

```
┌─────────────────────────────────────────────────────────────────┐
│  ┌─────────┐                                      [❤️]    [×]   │
│  │         │  Queen                                             │
│  │  [img]  │  45,234,567 followers                              │
│  │         │  [Rock] [Classic Rock] [Glam Rock]                 │
│  └─────────┘                                                    │
│                                                                 │
│  [📥 Download All (15 albums)]                                  │
│                                                                 │
│  [Albums] [Singles] [All] [Compilations]                        │
├─────────────────────────────────────────────────────────────────┤
│  🔥 TOP TRACKS                                                  │
│  1. Bohemian Rhapsody                           5:55    [📥]    │
│  2. Don't Stop Me Now                           3:29    [📥]    │
│  3. Somebody to Love                            4:56    [📥]    │
│  4. We Will Rock You                            2:02    [📥]    │
│  5. We Are the Champions                        2:59    [📥]    │
├─────────────────────────────────────────────────────────────────┤
│  💿 DISCOGRAPHY                                                 │
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐        │
│  │ [img]  │ │ [img]  │ │ [img]  │ │ [img]  │ │ [img]  │        │
│  │  1975  │ │  1976  │ │  1977  │ │  1978  │ │  1980  │        │
│  │  [📥]  │ │  [📥]  │ │  [📥]  │ │  [📥]  │ │  [📥]  │        │
│  └────────┘ └────────┘ └────────┘ └────────┘ └────────┘        │
├─────────────────────────────────────────────────────────────────┤
│  👥 RELATED ARTISTS                                             │
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐                    │
│  │ [img]  │ │ [img]  │ │ [img]  │ │ [img]  │                    │
│  │  Kiss  │ │Led Zep │ │  Bowie │ │  Elton │                    │
│  └────────┘ └────────┘ └────────┘ └────────┘                    │
└─────────────────────────────────────────────────────────────────┘
```

## Testing

1. Search for various artists, albums, tracks
2. Verify results display correctly with artwork
3. Test download buttons work correctly
4. Test artist discography view with filters
5. Test album track listing
6. Verify search history saves and displays
7. Test autocomplete suggestions work
8. Test favorite artist add/remove
9. Test related artists display
10. Test edge cases (no results, special characters, Unicode)
11. Verify history persists after restart

## Performance Considerations

- **Prepared statements**: All database operations use prepared statements
- **Indexed columns**: query, searched_at for fast lookups
- **Autocomplete debounce**: Prevent excessive API calls while typing
- **Result caching**: Consider caching recent search results

## Future Enhancements

- Advanced search filters (year, genre, label)
- Voice search support
- Spotify recommendations based on favorites
- Export/import favorites
- New release notifications for favorite artists
- Lyrics preview (if available from Spotify)
- Search result pagination for large result sets
