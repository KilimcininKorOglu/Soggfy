import { useState, useEffect, useCallback, useMemo } from 'react';
import axios from 'axios';
import './Playlists.css';

const API_BASE = process.env.REACT_APP_API_URL || '';

function Playlists({ onClose, sessionId }) {
    const [playlists, setPlaylists] = useState([]);
    const [loading, setLoading] = useState(true);
    const [syncing, setSyncing] = useState(false);
    const [addUrl, setAddUrl] = useState('');
    const [adding, setAdding] = useState(false);
    const [downloading, setDownloading] = useState(null);
    const [error, setError] = useState('');

    const headers = useMemo(
        () => (sessionId ? { 'x-session-id': sessionId } : {}),
        [sessionId]
    );

    const fetchPlaylists = useCallback(async () => {
        try {
            const response = await axios.get(`${API_BASE}/api/playlists`, {
                headers
            });
            setPlaylists(response.data);
        } catch (err) {
            console.error('Failed to fetch playlists:', err);
            setError('Failed to load playlists');
        } finally {
            setLoading(false);
        }
    }, [headers]);

    useEffect(() => {
        fetchPlaylists();
    }, [fetchPlaylists]);

    const handleAddPlaylist = async (e) => {
        e.preventDefault();
        if (!addUrl.trim()) return;

        setAdding(true);
        setError('');
        try {
            await axios.post(
                `${API_BASE}/api/playlists`,
                { url: addUrl },
                { headers }
            );
            setAddUrl('');
            fetchPlaylists();
        } catch (err) {
            setError(err.response?.data?.error || 'Failed to add playlist');
        } finally {
            setAdding(false);
        }
    };

    const handleRemove = async (id) => {
        if (!window.confirm('Remove this playlist from favorites?')) return;

        try {
            await axios.delete(`${API_BASE}/api/playlists/${id}`, { headers });
            setPlaylists(playlists.filter((p) => p.id !== id));
        } catch (err) {
            setError('Failed to remove playlist');
        }
    };

    const handleSync = async (id) => {
        try {
            const response = await axios.post(
                `${API_BASE}/api/playlists/${id}/sync`,
                {},
                { headers }
            );
            setPlaylists(
                playlists.map((p) => (p.id === id ? response.data : p))
            );
        } catch (err) {
            setError('Failed to sync playlist');
        }
    };

    const handleSyncAll = async () => {
        setSyncing(true);
        try {
            const response = await axios.post(
                `${API_BASE}/api/playlists/sync-all`,
                {},
                { headers }
            );
            setPlaylists(response.data);
        } catch (err) {
            setError('Failed to sync playlists');
        } finally {
            setSyncing(false);
        }
    };

    const handleDownload = async (id, newOnly = false) => {
        setDownloading(id);
        try {
            const response = await axios.post(
                `${API_BASE}/api/playlists/${id}/download`,
                { newOnly },
                { headers }
            );
            if (response.data.count > 0) {
                fetchPlaylists();
            } else {
                setError('No tracks to download');
            }
        } catch (err) {
            setError(err.response?.data?.error || 'Failed to download');
        } finally {
            setDownloading(null);
        }
    };

    const formatDate = (timestamp) => {
        if (!timestamp) return '-';
        return new Date(timestamp).toLocaleDateString();
    };

    if (loading) {
        return (
            <div className="playlists-overlay">
                <div className="playlists-modal">
                    <div className="playlists-loading">
                        Loading saved playlists...
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="playlists-overlay" onClick={onClose}>
            <div
                className="playlists-modal"
                onClick={(e) => e.stopPropagation()}
            >
                <header className="playlists-header">
                    <h2>Saved Playlists</h2>
                    <div className="header-actions">
                        <button
                            onClick={handleSyncAll}
                            disabled={syncing}
                            className="sync-all-btn"
                        >
                            {syncing ? 'Syncing...' : 'Sync All'}
                        </button>
                        <button onClick={onClose} className="close-btn">
                            ×
                        </button>
                    </div>
                </header>

                <div className="playlists-content">
                    {error && (
                        <div className="error-message">
                            {error}
                            <button
                                onClick={() => setError('')}
                                className="dismiss-btn"
                            >
                                ×
                            </button>
                        </div>
                    )}

                    <form onSubmit={handleAddPlaylist} className="add-form">
                        <input
                            type="text"
                            value={addUrl}
                            onChange={(e) => setAddUrl(e.target.value)}
                            placeholder="Paste Spotify playlist URL to save..."
                            disabled={adding}
                        />
                        <button type="submit" disabled={adding || !addUrl.trim()}>
                            {adding ? 'Adding...' : 'Save Playlist'}
                        </button>
                    </form>

                    {playlists.length === 0 ? (
                        <div className="empty-state">
                            <p>No saved playlists yet</p>
                            <p className="hint">
                                Save playlists to track new additions and
                                download them easily
                            </p>
                        </div>
                    ) : (
                        <div className="playlists-list">
                            {playlists.map((playlist) => (
                                <div
                                    key={playlist.id}
                                    className="playlist-card"
                                >
                                    <div className="playlist-image">
                                        {playlist.image ? (
                                            <img
                                                src={playlist.image}
                                                alt=""
                                            />
                                        ) : (
                                            <div className="no-image">🎵</div>
                                        )}
                                    </div>
                                    <div className="playlist-info">
                                        <div className="playlist-name">
                                            {playlist.name}
                                        </div>
                                        <div className="playlist-meta">
                                            <span>{playlist.trackCount} tracks</span>
                                            <span>by {playlist.owner}</span>
                                        </div>
                                        <div className="playlist-dates">
                                            <span>
                                                Saved:{' '}
                                                {formatDate(playlist.savedAt)}
                                            </span>
                                            <span>
                                                Synced:{' '}
                                                {formatDate(playlist.lastSyncedAt)}
                                            </span>
                                        </div>
                                        {playlist.newTracks > 0 && (
                                            <div className="new-tracks-badge">
                                                {playlist.newTracks} new tracks
                                            </div>
                                        )}
                                    </div>
                                    <div className="playlist-actions">
                                        <button
                                            onClick={() =>
                                                handleSync(playlist.id)
                                            }
                                            className="action-btn sync-btn"
                                            title="Check for new tracks"
                                        >
                                            🔄
                                        </button>
                                        {playlist.newTracks > 0 && (
                                            <button
                                                onClick={() =>
                                                    handleDownload(
                                                        playlist.id,
                                                        true
                                                    )
                                                }
                                                disabled={
                                                    downloading === playlist.id
                                                }
                                                className="action-btn download-new-btn"
                                                title="Download new tracks only"
                                            >
                                                {downloading === playlist.id
                                                    ? '...'
                                                    : '⬇️'}
                                            </button>
                                        )}
                                        <button
                                            onClick={() =>
                                                handleDownload(
                                                    playlist.id,
                                                    false
                                                )
                                            }
                                            disabled={
                                                downloading === playlist.id
                                            }
                                            className="action-btn download-btn"
                                            title="Download all tracks"
                                        >
                                            {downloading === playlist.id
                                                ? '...'
                                                : '📥'}
                                        </button>
                                        <button
                                            onClick={() =>
                                                handleRemove(playlist.id)
                                            }
                                            className="action-btn remove-btn"
                                            title="Remove from favorites"
                                        >
                                            🗑️
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

export default Playlists;
