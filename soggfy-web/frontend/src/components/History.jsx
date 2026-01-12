import { useState, useEffect, useCallback, useMemo } from 'react';
import axios from 'axios';
import './History.css';

const API_BASE = process.env.REACT_APP_API_URL || '';

function History({ onClose, sessionId }) {
    const [history, setHistory] = useState({ items: [], total: 0 });
    const [loading, setLoading] = useState(true);
    const [typeFilter, setTypeFilter] = useState('');
    const [searchQuery, setSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState(null);
    const [page, setPage] = useState(0);
    const [redownloading, setRedownloading] = useState(null);
    const [error, setError] = useState('');
    const pageSize = 20;

    const headers = useMemo(
        () => (sessionId ? { 'x-session-id': sessionId } : {}),
        [sessionId]
    );

    const fetchHistory = useCallback(async () => {
        try {
            const params = {
                limit: pageSize,
                offset: page * pageSize
            };
            if (typeFilter) {
                params.type = typeFilter;
            }
            const response = await axios.get(`${API_BASE}/api/history`, {
                headers,
                params
            });
            setHistory(response.data);
        } catch (err) {
            console.error('Failed to fetch history:', err);
            setError('Failed to load history');
        } finally {
            setLoading(false);
        }
    }, [headers, page, typeFilter]);

    useEffect(() => {
        setSearchResults(null);
        fetchHistory();
    }, [fetchHistory]);

    const handleSearch = async (e) => {
        e.preventDefault();
        if (!searchQuery.trim()) {
            setSearchResults(null);
            return;
        }
        try {
            const response = await axios.get(`${API_BASE}/api/history/search`, {
                headers,
                params: { q: searchQuery, limit: 50 }
            });
            setSearchResults(response.data);
        } catch (err) {
            setError('Search failed');
        }
    };

    const handleRedownload = async (id) => {
        setRedownloading(id);
        setError('');
        try {
            await axios.post(
                `${API_BASE}/api/history/${id}/redownload`,
                {},
                { headers }
            );
        } catch (err) {
            setError(err.response?.data?.error || 'Failed to redownload');
        } finally {
            setRedownloading(null);
        }
    };

    const handleDelete = async (id) => {
        if (!window.confirm('Delete this item from history?')) return;

        try {
            await axios.delete(`${API_BASE}/api/history/${id}`, { headers });
            setHistory({
                ...history,
                items: history.items.filter((item) => item.id !== id),
                total: history.total - 1
            });
        } catch (err) {
            setError('Failed to delete');
        }
    };

    const handleClearAll = async () => {
        if (!window.confirm('Clear all download history? This cannot be undone.'))
            return;

        try {
            await axios.delete(`${API_BASE}/api/history`, { headers });
            setHistory({ items: [], total: 0 });
            setPage(0);
        } catch (err) {
            setError('Failed to clear history');
        }
    };

    const formatDate = (timestamp) => {
        if (!timestamp) return '-';
        return new Date(timestamp).toLocaleString();
    };

    const getTypeIcon = (type) => {
        switch (type) {
            case 'track':
                return '🎵';
            case 'album':
                return '💿';
            case 'playlist':
                return '📋';
            default:
                return '📄';
        }
    };

    const totalPages = Math.ceil(history.total / pageSize);
    const displayItems = searchResults || history.items;

    if (loading) {
        return (
            <div className="history-overlay">
                <div className="history-modal">
                    <div className="history-loading">Loading history...</div>
                </div>
            </div>
        );
    }

    return (
        <div className="history-overlay" onClick={onClose}>
            <div className="history-modal" onClick={(e) => e.stopPropagation()}>
                <header className="history-header">
                    <h2>Download History</h2>
                    <div className="header-actions">
                        <button
                            onClick={handleClearAll}
                            className="clear-all-btn"
                            disabled={history.total === 0}
                        >
                            Clear All
                        </button>
                        <button onClick={onClose} className="close-btn">
                            ×
                        </button>
                    </div>
                </header>

                <div className="history-content">
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

                    <div className="history-controls">
                        <form onSubmit={handleSearch} className="search-form">
                            <input
                                type="text"
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                placeholder="Search history..."
                            />
                            <button type="submit">Search</button>
                            {searchResults && (
                                <button
                                    type="button"
                                    onClick={() => {
                                        setSearchQuery('');
                                        setSearchResults(null);
                                    }}
                                    className="clear-search"
                                >
                                    Clear
                                </button>
                            )}
                        </form>

                        <div className="filter-buttons">
                            <button
                                className={typeFilter === '' ? 'active' : ''}
                                onClick={() => {
                                    setTypeFilter('');
                                    setPage(0);
                                }}
                            >
                                All
                            </button>
                            <button
                                className={typeFilter === 'track' ? 'active' : ''}
                                onClick={() => {
                                    setTypeFilter('track');
                                    setPage(0);
                                }}
                            >
                                Tracks
                            </button>
                            <button
                                className={typeFilter === 'album' ? 'active' : ''}
                                onClick={() => {
                                    setTypeFilter('album');
                                    setPage(0);
                                }}
                            >
                                Albums
                            </button>
                            <button
                                className={
                                    typeFilter === 'playlist' ? 'active' : ''
                                }
                                onClick={() => {
                                    setTypeFilter('playlist');
                                    setPage(0);
                                }}
                            >
                                Playlists
                            </button>
                        </div>
                    </div>

                    {displayItems.length === 0 ? (
                        <div className="empty-state">
                            <p>No download history</p>
                            <p className="hint">
                                Downloaded albums and playlists will appear here
                            </p>
                        </div>
                    ) : (
                        <>
                            <div className="history-list">
                                {displayItems.map((item) => (
                                    <div key={item.id} className="history-item">
                                        <div className="item-image">
                                            {item.image ? (
                                                <img src={item.image} alt="" />
                                            ) : (
                                                <div className="no-image">
                                                    {getTypeIcon(item.type)}
                                                </div>
                                            )}
                                        </div>
                                        <div className="item-info">
                                            <div className="item-name">
                                                {item.name}
                                            </div>
                                            <div className="item-meta">
                                                <span className="item-type">
                                                    {getTypeIcon(item.type)}{' '}
                                                    {item.type}
                                                </span>
                                                {item.artist && (
                                                    <span className="item-artist">
                                                        {item.artist}
                                                    </span>
                                                )}
                                                {item.trackCount > 1 && (
                                                    <span className="item-tracks">
                                                        {item.trackCount} tracks
                                                    </span>
                                                )}
                                            </div>
                                            <div className="item-date">
                                                {formatDate(item.downloadedAt)}
                                            </div>
                                        </div>
                                        <div className="item-actions">
                                            {item.url && (
                                                <button
                                                    onClick={() =>
                                                        handleRedownload(item.id)
                                                    }
                                                    disabled={
                                                        redownloading === item.id
                                                    }
                                                    className="action-btn redownload-btn"
                                                    title="Re-download"
                                                >
                                                    {redownloading === item.id
                                                        ? '...'
                                                        : '🔄'}
                                                </button>
                                            )}
                                            <button
                                                onClick={() =>
                                                    handleDelete(item.id)
                                                }
                                                className="action-btn delete-btn"
                                                title="Delete from history"
                                            >
                                                🗑️
                                            </button>
                                        </div>
                                    </div>
                                ))}
                            </div>

                            {!searchResults && totalPages > 1 && (
                                <div className="pagination">
                                    <button
                                        onClick={() => setPage(page - 1)}
                                        disabled={page === 0}
                                    >
                                        Previous
                                    </button>
                                    <span className="page-info">
                                        Page {page + 1} of {totalPages}
                                    </span>
                                    <button
                                        onClick={() => setPage(page + 1)}
                                        disabled={page >= totalPages - 1}
                                    >
                                        Next
                                    </button>
                                </div>
                            )}
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}

export default History;
