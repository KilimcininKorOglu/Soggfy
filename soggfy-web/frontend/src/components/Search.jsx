import { useState, useEffect, useCallback, useMemo } from 'react';
import axios from 'axios';
import './Search.css';

const API_BASE = process.env.REACT_APP_API_URL || '';

function Search({ onClose, sessionId }) {
    const [query, setQuery] = useState('');
    const [results, setResults] = useState(null);
    const [loading, setLoading] = useState(false);
    const [activeTab, setActiveTab] = useState('all');
    const [searchHistory, setSearchHistory] = useState([]);
    const [favorites, setFavorites] = useState([]);
    const [suggestions, setSuggestions] = useState([]);
    const [showSuggestions, setShowSuggestions] = useState(false);
    const [selectedArtist, setSelectedArtist] = useState(null);
    const [selectedAlbum, setSelectedAlbum] = useState(null);
    const [error, setError] = useState('');

    const headers = useMemo(
        () => (sessionId ? { 'x-session-id': sessionId } : {}),
        [sessionId]
    );

    const fetchHistory = useCallback(async () => {
        try {
            const response = await axios.get(`${API_BASE}/api/search/history`, { headers });
            setSearchHistory(response.data);
        } catch (err) {
            console.error('Failed to fetch history:', err);
        }
    }, [headers]);

    const fetchFavorites = useCallback(async () => {
        try {
            const response = await axios.get(`${API_BASE}/api/search/favorites`, { headers });
            setFavorites(response.data);
        } catch (err) {
            console.error('Failed to fetch favorites:', err);
        }
    }, [headers]);

    useEffect(() => {
        fetchHistory();
        fetchFavorites();
    }, [fetchHistory, fetchFavorites]);

    useEffect(() => {
        if (query.length >= 2) {
            fetchSuggestions(query);
        } else {
            setSuggestions([]);
        }
    }, [query]);

    const fetchSuggestions = async (q) => {
        try {
            const response = await axios.get(`${API_BASE}/api/search/history/suggest`, {
                headers,
                params: { q, limit: 5 }
            });
            setSuggestions(response.data);
        } catch (err) {
            console.error('Failed to fetch suggestions:', err);
        }
    };

    const handleSearch = async (searchQuery) => {
        if (!searchQuery.trim()) return;

        setLoading(true);
        setError('');
        setShowSuggestions(false);

        try {
            const response = await axios.get(`${API_BASE}/api/search`, {
                headers,
                params: { q: searchQuery }
            });
            setResults(response.data);
            setQuery(searchQuery);
            fetchHistory();
        } catch (err) {
            setError(err.response?.data?.error || 'Search failed');
        } finally {
            setLoading(false);
        }
    };

    const handleDownloadTrack = async (track) => {
        try {
            await axios.post(`${API_BASE}/api/download`, { url: `spotify:track:${track.id}` }, { headers });
        } catch (err) {
            setError('Failed to add to queue');
        }
    };

    const handleDownloadAlbum = async (album) => {
        try {
            await axios.post(`${API_BASE}/api/download`, { url: `spotify:album:${album.id}` }, { headers });
        } catch (err) {
            setError('Failed to add to queue');
        }
    };

    const handleDownloadPlaylist = async (playlist) => {
        try {
            await axios.post(`${API_BASE}/api/download`, { url: `spotify:playlist:${playlist.id}` }, { headers });
        } catch (err) {
            setError('Failed to add to queue');
        }
    };

    const handleToggleFavorite = async (artist) => {
        try {
            if (artist.isFavorite) {
                await axios.delete(`${API_BASE}/api/search/favorites/${artist.id}`, { headers });
            } else {
                await axios.post(`${API_BASE}/api/search/favorites`, { artistId: artist.id }, { headers });
            }
            fetchFavorites();
            if (selectedArtist && selectedArtist.id === artist.id) {
                setSelectedArtist({ ...selectedArtist, isFavorite: !artist.isFavorite });
            }
        } catch (err) {
            setError('Failed to update favorite');
        }
    };

    const handleClearHistory = async () => {
        if (!window.confirm('Clear all search history?')) return;
        try {
            await axios.delete(`${API_BASE}/api/search/history`, { headers });
            setSearchHistory([]);
        } catch (err) {
            setError('Failed to clear history');
        }
    };

    const formatDuration = (ms) => {
        const minutes = Math.floor(ms / 60000);
        const seconds = Math.floor((ms % 60000) / 1000);
        return `${minutes}:${seconds.toString().padStart(2, '0')}`;
    };

    const getFilteredResults = () => {
        if (!results) return null;
        switch (activeTab) {
            case 'tracks': return { tracks: results.tracks };
            case 'albums': return { albums: results.albums };
            case 'artists': return { artists: results.artists };
            case 'playlists': return { playlists: results.playlists };
            default: return results;
        }
    };

    const filteredResults = getFilteredResults();

    return (
        <div className="search-overlay" onClick={onClose}>
            <div className="search-modal" onClick={(e) => e.stopPropagation()}>
                <header className="search-header">
                    <h2>Search Spotify</h2>
                    <button onClick={onClose} className="close-btn">×</button>
                </header>

                <div className="search-content">
                    {error && (
                        <div className="error-message">
                            {error}
                            <button onClick={() => setError('')} className="dismiss-btn">×</button>
                        </div>
                    )}

                    <form
                        onSubmit={(e) => {
                            e.preventDefault();
                            handleSearch(query);
                        }}
                        className="search-form"
                    >
                        <div className="search-input-wrapper">
                            <span className="search-icon">🔍</span>
                            <input
                                type="text"
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                                onFocus={() => setShowSuggestions(true)}
                                onBlur={() => setTimeout(() => setShowSuggestions(false), 200)}
                                placeholder="Search for tracks, albums, artists..."
                            />
                            {query && (
                                <button
                                    type="button"
                                    className="clear-input"
                                    onClick={() => setQuery('')}
                                >
                                    ×
                                </button>
                            )}
                        </div>
                        <button type="submit" disabled={loading || !query.trim()}>
                            {loading ? 'Searching...' : 'Search'}
                        </button>

                        {showSuggestions && suggestions.length > 0 && (
                            <ul className="suggestions-dropdown">
                                {suggestions.map((item) => (
                                    <li
                                        key={item.id}
                                        onMouseDown={() => {
                                            setQuery(item.query);
                                            handleSearch(item.query);
                                        }}
                                    >
                                        <span className="suggestion-icon">🕐</span>
                                        <span className="suggestion-query">{item.query}</span>
                                        <span className="suggestion-count">({item.searchCount})</span>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </form>

                    {!results && !loading && searchHistory.length > 0 && (
                        <div className="history-section">
                            <div className="section-header">
                                <h3>Recent Searches</h3>
                                <button onClick={handleClearHistory} className="clear-link">
                                    Clear all
                                </button>
                            </div>
                            <div className="history-tags">
                                {searchHistory.slice(0, 10).map((item) => (
                                    <button
                                        key={item.id}
                                        className="history-tag"
                                        onClick={() => handleSearch(item.query)}
                                    >
                                        {item.query}
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}

                    {favorites.length > 0 && !results && (
                        <div className="favorites-section">
                            <h3>Favorite Artists</h3>
                            <div className="favorites-grid">
                                {favorites.map((artist) => (
                                    <div
                                        key={artist.id}
                                        className="favorite-artist-card"
                                        onClick={() => setSelectedArtist({ id: artist.id, name: artist.name })}
                                    >
                                        {artist.imageUrl ? (
                                            <img src={artist.imageUrl} alt={artist.name} />
                                        ) : (
                                            <div className="no-image">🎤</div>
                                        )}
                                        <span>{artist.name}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

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

                            <div className="search-results">
                                {(activeTab === 'all' || activeTab === 'tracks') &&
                                    filteredResults.tracks?.length > 0 && (
                                        <section className="results-section">
                                            {activeTab === 'all' && <h3>Tracks</h3>}
                                            <div className="tracks-list">
                                                {filteredResults.tracks.slice(0, activeTab === 'all' ? 5 : 50).map((track) => (
                                                    <div key={track.id} className="track-result">
                                                        <img
                                                            src={track.album.images[2]?.url || track.album.images[0]?.url}
                                                            alt=""
                                                            className="track-image"
                                                        />
                                                        <div className="track-info">
                                                            <div className="track-name">{track.name}</div>
                                                            <div className="track-artist">
                                                                {track.artists.map((a) => a.name).join(', ')}
                                                            </div>
                                                        </div>
                                                        <div className="track-duration">
                                                            {formatDuration(track.duration_ms)}
                                                        </div>
                                                        <button
                                                            onClick={() => handleDownloadTrack(track)}
                                                            className="download-btn"
                                                            title="Download"
                                                        >
                                                            📥
                                                        </button>
                                                    </div>
                                                ))}
                                            </div>
                                        </section>
                                    )}

                                {(activeTab === 'all' || activeTab === 'albums') &&
                                    filteredResults.albums?.length > 0 && (
                                        <section className="results-section">
                                            {activeTab === 'all' && <h3>Albums</h3>}
                                            <div className="albums-grid">
                                                {filteredResults.albums.slice(0, activeTab === 'all' ? 6 : 50).map((album) => (
                                                    <div key={album.id} className="album-result">
                                                        <div
                                                            className="album-image-wrapper"
                                                            onClick={() => setSelectedAlbum(album)}
                                                        >
                                                            <img
                                                                src={album.images[1]?.url || album.images[0]?.url}
                                                                alt=""
                                                            />
                                                        </div>
                                                        <div className="album-name">{album.name}</div>
                                                        <div className="album-artist">
                                                            {album.artists[0]?.name} • {album.release_date?.split('-')[0]}
                                                        </div>
                                                        <button
                                                            onClick={() => handleDownloadAlbum(album)}
                                                            className="download-btn"
                                                        >
                                                            📥
                                                        </button>
                                                    </div>
                                                ))}
                                            </div>
                                        </section>
                                    )}

                                {(activeTab === 'all' || activeTab === 'artists') &&
                                    filteredResults.artists?.length > 0 && (
                                        <section className="results-section">
                                            {activeTab === 'all' && <h3>Artists</h3>}
                                            <div className="artists-grid">
                                                {filteredResults.artists.slice(0, activeTab === 'all' ? 6 : 50).map((artist) => (
                                                    <div
                                                        key={artist.id}
                                                        className="artist-result"
                                                        onClick={() => setSelectedArtist(artist)}
                                                    >
                                                        {artist.images[0]?.url ? (
                                                            <img src={artist.images[2]?.url || artist.images[0]?.url} alt="" />
                                                        ) : (
                                                            <div className="no-image">🎤</div>
                                                        )}
                                                        <div className="artist-name">{artist.name}</div>
                                                        <div className="artist-followers">
                                                            {artist.followers?.total?.toLocaleString()} followers
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>
                                        </section>
                                    )}

                                {(activeTab === 'all' || activeTab === 'playlists') &&
                                    filteredResults.playlists?.length > 0 && (
                                        <section className="results-section">
                                            {activeTab === 'all' && <h3>Playlists</h3>}
                                            <div className="playlists-grid">
                                                {filteredResults.playlists.slice(0, activeTab === 'all' ? 6 : 50).map((playlist) => (
                                                    <div key={playlist.id} className="playlist-result">
                                                        <img
                                                            src={playlist.images[0]?.url}
                                                            alt=""
                                                        />
                                                        <div className="playlist-name">{playlist.name}</div>
                                                        <div className="playlist-owner">
                                                            by {playlist.owner?.display_name} • {playlist.tracks?.total} tracks
                                                        </div>
                                                        <button
                                                            onClick={() => handleDownloadPlaylist(playlist)}
                                                            className="download-btn"
                                                        >
                                                            📥
                                                        </button>
                                                    </div>
                                                ))}
                                            </div>
                                        </section>
                                    )}
                            </div>
                        </>
                    )}
                </div>

                {selectedArtist && (
                    <ArtistDetailModal
                        artist={selectedArtist}
                        headers={headers}
                        onClose={() => setSelectedArtist(null)}
                        onDownloadTrack={handleDownloadTrack}
                        onDownloadAlbum={handleDownloadAlbum}
                        onToggleFavorite={handleToggleFavorite}
                    />
                )}

                {selectedAlbum && (
                    <AlbumDetailModal
                        album={selectedAlbum}
                        headers={headers}
                        onClose={() => setSelectedAlbum(null)}
                        onDownloadTrack={handleDownloadTrack}
                        onDownloadAlbum={handleDownloadAlbum}
                    />
                )}
            </div>
        </div>
    );
}

function ArtistDetailModal({ artist, headers, onClose, onDownloadTrack, onDownloadAlbum, onToggleFavorite }) {
    const [fullArtist, setFullArtist] = useState(null);
    const [albums, setAlbums] = useState([]);
    const [topTracks, setTopTracks] = useState([]);
    const [filter, setFilter] = useState('album,single');
    const [loading, setLoading] = useState(true);

    const API_BASE = process.env.REACT_APP_API_URL || '';

    useEffect(() => {
        fetchArtistData();
    }, [artist.id, filter]);

    const fetchArtistData = async () => {
        setLoading(true);
        try {
            const [artistRes, albumsRes, tracksRes] = await Promise.all([
                axios.get(`${API_BASE}/api/search/artist/${artist.id}`, { headers }),
                axios.get(`${API_BASE}/api/search/artist/${artist.id}/albums`, {
                    headers,
                    params: { includeGroups: filter }
                }),
                axios.get(`${API_BASE}/api/search/artist/${artist.id}/top-tracks`, { headers })
            ]);
            setFullArtist(artistRes.data);
            setAlbums(albumsRes.data);
            setTopTracks(tracksRes.data);
        } catch (error) {
            console.error('Failed to fetch artist data:', error);
        } finally {
            setLoading(false);
        }
    };

    const handleDownloadDiscography = async () => {
        if (!window.confirm(`Download all ${albums.length} albums?`)) return;
        for (const album of albums) {
            await onDownloadAlbum(album);
        }
    };

    const formatDuration = (ms) => {
        const minutes = Math.floor(ms / 60000);
        const seconds = Math.floor((ms % 60000) / 1000);
        return `${minutes}:${seconds.toString().padStart(2, '0')}`;
    };

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="artist-detail-modal" onClick={(e) => e.stopPropagation()}>
                <button onClick={onClose} className="modal-close-btn">×</button>

                {loading ? (
                    <div className="modal-loading">Loading artist...</div>
                ) : fullArtist && (
                    <>
                        <header className="artist-header">
                            {fullArtist.images?.[0]?.url ? (
                                <img src={fullArtist.images[0].url} alt="" className="artist-image" />
                            ) : (
                                <div className="artist-image no-image">🎤</div>
                            )}
                            <div className="artist-info">
                                <h2>{fullArtist.name}</h2>
                                <p className="followers">
                                    {fullArtist.followers?.total?.toLocaleString()} followers
                                </p>
                                <div className="genres">
                                    {fullArtist.genres?.slice(0, 3).map((g) => (
                                        <span key={g} className="genre-tag">{g}</span>
                                    ))}
                                </div>
                            </div>
                            <button
                                onClick={() => onToggleFavorite(fullArtist)}
                                className={`favorite-btn ${fullArtist.isFavorite ? 'active' : ''}`}
                            >
                                {fullArtist.isFavorite ? '❤️' : '🤍'}
                            </button>
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
                        </div>

                        {topTracks.length > 0 && (
                            <section className="top-tracks-section">
                                <h3>Top Tracks</h3>
                                <div className="top-tracks-list">
                                    {topTracks.slice(0, 5).map((track, index) => (
                                        <div key={track.id} className="top-track-row">
                                            <span className="track-number">{index + 1}</span>
                                            <img
                                                src={track.album.images[2]?.url || track.album.images[0]?.url}
                                                alt=""
                                            />
                                            <div className="track-info">
                                                <div className="track-name">{track.name}</div>
                                                <div className="track-album">{track.album.name}</div>
                                            </div>
                                            <div className="track-duration">{formatDuration(track.duration_ms)}</div>
                                            <button
                                                onClick={() => onDownloadTrack(track)}
                                                className="download-btn"
                                            >
                                                📥
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            </section>
                        )}

                        <section className="discography-section">
                            <h3>Discography</h3>
                            <div className="discography-grid">
                                {albums.map((album) => (
                                    <div key={album.id} className="discography-album">
                                        <img src={album.images[1]?.url || album.images[0]?.url} alt="" />
                                        <div className="album-name">{album.name}</div>
                                        <div className="album-year">{album.release_date?.split('-')[0]}</div>
                                        <button
                                            onClick={() => onDownloadAlbum(album)}
                                            className="download-btn"
                                        >
                                            📥
                                        </button>
                                    </div>
                                ))}
                            </div>
                        </section>
                    </>
                )}
            </div>
        </div>
    );
}

function AlbumDetailModal({ album, headers, onClose, onDownloadTrack, onDownloadAlbum }) {
    const [fullAlbum, setFullAlbum] = useState(null);
    const [loading, setLoading] = useState(true);

    const API_BASE = process.env.REACT_APP_API_URL || '';

    useEffect(() => {
        fetchAlbumData();
    }, [album.id]);

    const fetchAlbumData = async () => {
        setLoading(true);
        try {
            const response = await axios.get(`${API_BASE}/api/search/album/${album.id}`, { headers });
            setFullAlbum(response.data);
        } catch (error) {
            console.error('Failed to fetch album data:', error);
        } finally {
            setLoading(false);
        }
    };

    const formatDuration = (ms) => {
        const minutes = Math.floor(ms / 60000);
        const seconds = Math.floor((ms % 60000) / 1000);
        return `${minutes}:${seconds.toString().padStart(2, '0')}`;
    };

    const getTotalDuration = () => {
        if (!fullAlbum?.tracks?.items) return '0 min';
        const totalMs = fullAlbum.tracks.items.reduce((sum, t) => sum + t.duration_ms, 0);
        const minutes = Math.floor(totalMs / 60000);
        return `${minutes} min`;
    };

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="album-detail-modal" onClick={(e) => e.stopPropagation()}>
                <button onClick={onClose} className="modal-close-btn">×</button>

                {loading ? (
                    <div className="modal-loading">Loading album...</div>
                ) : fullAlbum && (
                    <>
                        <header className="album-header">
                            <img
                                src={fullAlbum.images[0]?.url}
                                alt=""
                                className="album-image"
                            />
                            <div className="album-info">
                                <h2>{fullAlbum.name}</h2>
                                <p className="album-artist">
                                    {fullAlbum.artists.map((a) => a.name).join(', ')}
                                </p>
                                <p className="album-meta">
                                    {fullAlbum.release_date?.split('-')[0]} • {fullAlbum.total_tracks} tracks • {getTotalDuration()}
                                </p>
                            </div>
                        </header>

                        <div className="album-actions">
                            <button onClick={() => onDownloadAlbum(fullAlbum)} className="download-all-btn">
                                📥 Download Album
                            </button>
                        </div>

                        <section className="album-tracks-section">
                            <div className="album-tracks-list">
                                {fullAlbum.tracks.items.map((track, index) => (
                                    <div key={track.id} className="album-track-row">
                                        <span className="track-number">{index + 1}</span>
                                        <div className="track-info">
                                            <div className="track-name">{track.name}</div>
                                            {track.artists.length > 1 && (
                                                <div className="track-artists">
                                                    {track.artists.map((a) => a.name).join(', ')}
                                                </div>
                                            )}
                                        </div>
                                        <div className="track-duration">{formatDuration(track.duration_ms)}</div>
                                        <button
                                            onClick={() => onDownloadTrack({ ...track, album: fullAlbum })}
                                            className="download-btn"
                                        >
                                            📥
                                        </button>
                                    </div>
                                ))}
                            </div>
                        </section>
                    </>
                )}
            </div>
        </div>
    );
}

export default Search;
