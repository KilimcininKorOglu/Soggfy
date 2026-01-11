# Search Feature

**Branch:** `feature/search`

## Overview

Add Spotify search functionality to the Web UI, allowing users to search for tracks, albums, artists, and playlists directly and download them without needing to copy URLs from Spotify.

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

- Recent searches
- Clear search history
- Quick re-search

### 4. Artist Discography

- View all albums by artist
- Filter by album type (album, single, compilation)
- Download full discography option

## Technical Implementation

### Backend Changes

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

  // Get artist albums
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

| Method | Endpoint                            | Description           |
|--------|-------------------------------------|-----------------------|
| GET    | `/api/search`                       | Search Spotify        |
| GET    | `/api/search/artist/:id`            | Get artist details    |
| GET    | `/api/search/artist/:id/albums`     | Get artist albums     |
| GET    | `/api/search/artist/:id/top-tracks` | Get artist top tracks |
| GET    | `/api/search/album/:id`             | Get album with tracks |
| GET    | `/api/search/history`               | Get search history    |
| DELETE | `/api/search/history`               | Clear search history  |

#### server.js Additions

```javascript
// Search Spotify
app.get('/api/search', authMiddleware, async (req, res) => {
  try {
    const { q, types, limit } = req.query;
    
    if (!q) {
      return res.status(400).json({ error: 'Query is required' });
    }

    const typeArray = types ? types.split(',') : ['track', 'album', 'artist', 'playlist'];
    const results = await spotify.search(q, typeArray, parseInt(limit) || 20);
    
    // Save to search history
    searchHistory.add(q);
    
    res.json(results);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Get artist details
app.get('/api/search/artist/:id', authMiddleware, async (req, res) => {
  try {
    const artist = await spotify.getArtist(req.params.id);
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

// Get album with tracks
app.get('/api/search/album/:id', authMiddleware, async (req, res) => {
  try {
    const album = await spotify.getAlbum(req.params.id);
    res.json(album);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});
```

### Frontend Changes

#### New Components

```
soggfy-web/frontend/src/components/
├── Search/
│   ├── Search.jsx              # Main search page
│   ├── Search.css              # Styles
│   ├── SearchBar.jsx           # Search input component
│   ├── SearchResults.jsx       # Results container
│   ├── TrackResult.jsx         # Track result item
│   ├── AlbumResult.jsx         # Album result item
│   ├── ArtistResult.jsx        # Artist result item
│   ├── PlaylistResult.jsx      # Playlist result item
│   ├── ArtistDetail.jsx        # Artist discography view
│   └── AlbumDetail.jsx         # Album tracks view
```

#### Search.jsx Structure

```jsx
function Search() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('all');
  const [selectedArtist, setSelectedArtist] = useState(null);
  const [selectedAlbum, setSelectedAlbum] = useState(null);
  const [searchHistory, setSearchHistory] = useState([]);

  const handleSearch = async (searchQuery) => {
    if (!searchQuery.trim()) return;
    
    setLoading(true);
    try {
      const response = await axios.get(`${API_BASE}/search`, {
        params: { q: searchQuery }
      });
      setResults(response.data);
      setQuery(searchQuery);
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

  return (
    <div className="search-page">
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
          />
        </>
      )}

      {selectedArtist && (
        <ArtistDetail
          artist={selectedArtist}
          onClose={() => setSelectedArtist(null)}
          onDownloadAlbum={handleDownloadAlbum}
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
```

#### TrackResult.jsx

```jsx
function TrackResult({ track, onDownload }) {
  return (
    <div className="track-result">
      <img 
        src={track.album.images[2]?.url} 
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
```

#### ArtistDetail.jsx

```jsx
function ArtistDetail({ artist, onClose, onDownloadAlbum }) {
  const [albums, setAlbums] = useState([]);
  const [topTracks, setTopTracks] = useState([]);
  const [filter, setFilter] = useState('album,single');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchArtistData();
  }, [artist.id, filter]);

  const fetchArtistData = async () => {
    setLoading(true);
    try {
      const [albumsRes, tracksRes] = await Promise.all([
        axios.get(`${API_BASE}/search/artist/${artist.id}/albums`, {
          params: { includeGroups: filter }
        }),
        axios.get(`${API_BASE}/search/artist/${artist.id}/top-tracks`)
      ]);
      setAlbums(albumsRes.data);
      setTopTracks(tracksRes.data);
    } catch (error) {
      console.error('Failed to fetch artist data:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleDownloadDiscography = async () => {
    for (const album of albums) {
      await onDownloadAlbum(album);
    }
  };

  return (
    <div className="artist-detail-overlay">
      <div className="artist-detail-modal">
        <header>
          <img src={artist.images[0]?.url} alt={artist.name} />
          <div>
            <h2>{artist.name}</h2>
            <p>{artist.followers?.total?.toLocaleString()} followers</p>
            <div className="genres">
              {artist.genres?.slice(0, 3).map(g => (
                <span key={g} className="genre-tag">{g}</span>
              ))}
            </div>
          </div>
          <button onClick={onClose} className="close-btn">×</button>
        </header>

        <div className="artist-actions">
          <button onClick={handleDownloadDiscography}>
            📥 Download All ({albums.length} albums)
          </button>
        </div>

        <div className="filter-tabs">
          <button 
            className={filter.includes('album') ? 'active' : ''}
            onClick={() => setFilter('album')}
          >
            Albums
          </button>
          <button 
            className={filter.includes('single') ? 'active' : ''}
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
        </div>

        <section className="top-tracks">
          <h3>Top Tracks</h3>
          {topTracks.slice(0, 5).map(track => (
            <TrackResult key={track.id} track={track} onDownload={onDownload} />
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
      </div>
    </div>
  );
}
```

## UI Design

### Search Page

```
┌─────────────────────────────────────────────────────────────────┐
│  🔍 [Search Spotify...                              ] [Search]  │
│     Recent: Queen, Led Zeppelin, Pink Floyd                     │
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
│  │  [View →]  │ │  [View →]  │ │  [View →]  │                   │
│  └────────────┘ └────────────┘ └────────────┘                   │
└─────────────────────────────────────────────────────────────────┘
```

### Artist Detail Modal

```
┌─────────────────────────────────────────────────────────────────┐
│  ┌─────────┐                                              [×]   │
│  │         │  Queen                                             │
│  │  [img]  │  45,234,567 followers                              │
│  │         │  [Rock] [Classic Rock] [Glam Rock]                 │
│  └─────────┘                                                    │
│                                                                 │
│  [📥 Download All (15 albums)]                                  │
│                                                                 │
│  [Albums] [Singles] [All]                                       │
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
└─────────────────────────────────────────────────────────────────┘
```

## Testing

1. Search for various artists, albums, tracks
2. Verify results display correctly with artwork
3. Test download buttons work correctly
4. Test artist discography view
5. Test album track listing
6. Verify search history saves and displays
7. Test edge cases (no results, special characters)

## Future Enhancements

- Autocomplete suggestions while typing
- Advanced search filters (year, genre)
- Related artists suggestions
- Save favorite artists
- New release notifications for followed artists
- Lyrics preview (if available)
