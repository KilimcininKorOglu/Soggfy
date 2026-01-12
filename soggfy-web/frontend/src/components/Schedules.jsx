import { useState, useEffect, useCallback, useMemo } from 'react';
import axios from 'axios';
import './Schedules.css';

const API_BASE = process.env.REACT_APP_API_URL || '';

function Schedules({ onClose, sessionId }) {
    const [schedules, setSchedules] = useState([]);
    const [history, setHistory] = useState([]);
    const [loading, setLoading] = useState(true);
    const [showCreate, setShowCreate] = useState(false);
    const [editSchedule, setEditSchedule] = useState(null);
    const [playlists, setPlaylists] = useState([]);
    const [error, setError] = useState('');

    const headers = useMemo(
        () => (sessionId ? { 'x-session-id': sessionId } : {}),
        [sessionId]
    );

    const fetchSchedules = useCallback(async () => {
        try {
            const response = await axios.get(`${API_BASE}/api/schedules`, { headers });
            setSchedules(response.data);
        } catch (err) {
            console.error('Failed to fetch schedules:', err);
            setError('Failed to load schedules');
        } finally {
            setLoading(false);
        }
    }, [headers]);

    const fetchHistory = useCallback(async () => {
        try {
            const response = await axios.get(`${API_BASE}/api/schedules/history`, {
                headers,
                params: { limit: 20 }
            });
            setHistory(response.data);
        } catch (err) {
            console.error('Failed to fetch history:', err);
        }
    }, [headers]);

    const fetchPlaylists = useCallback(async () => {
        try {
            const response = await axios.get(`${API_BASE}/api/playlists`, { headers });
            setPlaylists(response.data);
        } catch (err) {
            console.error('Failed to fetch playlists:', err);
        }
    }, [headers]);

    useEffect(() => {
        fetchSchedules();
        fetchHistory();
        fetchPlaylists();
    }, [fetchSchedules, fetchHistory, fetchPlaylists]);

    const handleToggle = async (id) => {
        try {
            await axios.post(`${API_BASE}/api/schedules/${id}/toggle`, {}, { headers });
            await fetchSchedules();
        } catch (err) {
            setError('Failed to toggle schedule');
        }
    };

    const handleRunNow = async (id) => {
        try {
            const result = await axios.post(`${API_BASE}/api/schedules/${id}/run`, {}, { headers });
            alert(`Executed: ${result.data.tracksAdded} tracks added`);
            await fetchSchedules();
            await fetchHistory();
        } catch (err) {
            setError(err.response?.data?.error || 'Execution failed');
        }
    };

    const handleDelete = async (id) => {
        if (!window.confirm('Delete this schedule?')) return;
        try {
            await axios.delete(`${API_BASE}/api/schedules/${id}`, { headers });
            await fetchSchedules();
        } catch (err) {
            setError('Failed to delete schedule');
        }
    };

    const handleEdit = (schedule) => {
        setEditSchedule(schedule);
        setShowCreate(true);
    };

    const handleSave = async (data) => {
        try {
            if (editSchedule) {
                await axios.put(`${API_BASE}/api/schedules/${editSchedule.id}`, data, { headers });
            } else {
                await axios.post(`${API_BASE}/api/schedules`, data, { headers });
            }
            await fetchSchedules();
            setShowCreate(false);
            setEditSchedule(null);
        } catch (err) {
            alert('Failed: ' + (err.response?.data?.error || err.message));
        }
    };

    const formatDate = (timestamp) => {
        if (!timestamp) return 'Never';
        return new Date(timestamp).toLocaleString();
    };

    const formatRelativeTime = (timestamp) => {
        if (!timestamp) return 'Never';
        const diff = timestamp - Date.now();
        if (diff < 0) return 'Overdue';

        const hours = Math.floor(diff / 3600000);
        const minutes = Math.floor((diff % 3600000) / 60000);

        if (hours > 24) {
            const days = Math.floor(hours / 24);
            return `in ${days} day${days > 1 ? 's' : ''}`;
        }
        if (hours > 0) return `in ${hours}h ${minutes}m`;
        return `in ${minutes}m`;
    };

    const getTypeIcon = (type) => {
        switch (type) {
            case 'playlist': return '📋';
            case 'playlist-sync-all': return '🔄';
            case 'url': return '🔗';
            default: return '📅';
        }
    };

    const getStatusIcon = (status) => {
        switch (status) {
            case 'completed': return '✅';
            case 'failed': return '❌';
            default: return '⏳';
        }
    };

    if (loading) {
        return (
            <div className="schedules-overlay">
                <div className="schedules-modal">
                    <div className="schedules-loading">Loading schedules...</div>
                </div>
            </div>
        );
    }

    return (
        <div className="schedules-overlay" onClick={onClose}>
            <div className="schedules-modal" onClick={(e) => e.stopPropagation()}>
                <header className="schedules-header">
                    <h2>Scheduled Downloads</h2>
                    <div className="header-actions">
                        <button
                            onClick={() => {
                                setEditSchedule(null);
                                setShowCreate(true);
                            }}
                            className="create-btn"
                        >
                            + New Schedule
                        </button>
                        <button onClick={onClose} className="close-btn">×</button>
                    </div>
                </header>

                <div className="schedules-content">
                    {error && (
                        <div className="error-message">
                            {error}
                            <button onClick={() => setError('')} className="dismiss-btn">×</button>
                        </div>
                    )}

                    {schedules.length === 0 ? (
                        <div className="empty-state">
                            <p>No scheduled downloads</p>
                            <p className="hint">Create a schedule to automate playlist syncing</p>
                        </div>
                    ) : (
                        <div className="schedules-list">
                            {schedules.map((schedule) => (
                                <div
                                    key={schedule.id}
                                    className={`schedule-card ${schedule.enabled ? '' : 'disabled'}`}
                                >
                                    <div className="schedule-header">
                                        <div className="schedule-status">
                                            <button
                                                className={`toggle-btn ${schedule.enabled ? 'enabled' : ''}`}
                                                onClick={() => handleToggle(schedule.id)}
                                                title={schedule.enabled ? 'Disable' : 'Enable'}
                                            >
                                                {schedule.enabled ? '✅' : '⏸️'}
                                            </button>
                                            <h3>{schedule.name}</h3>
                                        </div>
                                        <div className="schedule-actions">
                                            <button
                                                onClick={() => handleRunNow(schedule.id)}
                                                title="Run Now"
                                                className="action-btn"
                                            >
                                                ▶️
                                            </button>
                                            <button
                                                onClick={() => handleEdit(schedule)}
                                                title="Edit"
                                                className="action-btn"
                                            >
                                                ✏️
                                            </button>
                                            <button
                                                onClick={() => handleDelete(schedule.id)}
                                                title="Delete"
                                                className="action-btn danger"
                                            >
                                                🗑️
                                            </button>
                                        </div>
                                    </div>

                                    <div className="schedule-details">
                                        <div className="detail-row">
                                            <span className="icon">{getTypeIcon(schedule.type)}</span>
                                            <span>
                                                {schedule.type === 'playlist-sync-all'
                                                    ? 'Sync All Saved Playlists'
                                                    : schedule.targetName || schedule.targetId}
                                                {schedule.newTracksOnly && ' (New tracks only)'}
                                            </span>
                                        </div>
                                        <div className="detail-row">
                                            <span className="icon">🕐</span>
                                            <span className="cron">{schedule.cronExpression}</span>
                                            <span className="timezone">({schedule.timezone})</span>
                                        </div>
                                    </div>

                                    <div className="schedule-timing">
                                        {schedule.lastRunAt && (
                                            <div className="last-run">
                                                {getStatusIcon(schedule.lastRunStatus)} Last: {formatDate(schedule.lastRunAt)}
                                            </div>
                                        )}
                                        {schedule.enabled && schedule.nextRunAt && (
                                            <div className="next-run">
                                                Next: {formatRelativeTime(schedule.nextRunAt)}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}

                    {history.length > 0 && (
                        <section className="history-section">
                            <h3>Recent Executions</h3>
                            <div className="execution-list">
                                {history.map((exec) => (
                                    <div key={exec.id} className={`execution-item ${exec.status}`}>
                                        <span className="exec-status">{getStatusIcon(exec.status)}</span>
                                        <span className="exec-name">{exec.scheduleName}</span>
                                        <span className="exec-tracks">
                                            {exec.status === 'completed' ? `${exec.tracksAdded} tracks` : exec.error || 'Running...'}
                                        </span>
                                        <span className="exec-date">{formatDate(exec.startedAt)}</span>
                                    </div>
                                ))}
                            </div>
                        </section>
                    )}
                </div>

                {showCreate && (
                    <CreateScheduleModal
                        schedule={editSchedule}
                        playlists={playlists}
                        headers={headers}
                        onClose={() => {
                            setShowCreate(false);
                            setEditSchedule(null);
                        }}
                        onSave={handleSave}
                    />
                )}
            </div>
        </div>
    );
}

const SCHEDULE_PRESETS = [
    { label: 'Every day at 3 AM', cron: '0 3 * * *' },
    { label: 'Every day at midnight', cron: '0 0 * * *' },
    { label: 'Every Sunday at 2 AM', cron: '0 2 * * 0' },
    { label: 'Every Monday at 6 AM', cron: '0 6 * * 1' },
    { label: 'Every 6 hours', cron: '0 */6 * * *' },
    { label: 'Every 12 hours', cron: '0 */12 * * *' },
];

function CreateScheduleModal({ schedule, playlists, headers, onClose, onSave }) {
    const [form, setForm] = useState({
        name: schedule?.name || '',
        type: schedule?.type || 'playlist',
        targetId: schedule?.targetId || '',
        targetName: schedule?.targetName || '',
        cronExpression: schedule?.cronExpression || '0 3 * * *',
        timezone: schedule?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
        newTracksOnly: schedule?.newTracksOnly ?? true
    });
    const [cronValid, setCronValid] = useState(true);
    const [nextRun, setNextRun] = useState(null);
    const [validating, setValidating] = useState(false);

    const API_BASE = process.env.REACT_APP_API_URL || '';

    useEffect(() => {
        validateCron();
    }, [form.cronExpression, form.timezone]);

    const validateCron = async () => {
        if (!form.cronExpression) {
            setCronValid(false);
            setNextRun(null);
            return;
        }

        setValidating(true);
        try {
            const response = await axios.post(
                `${API_BASE}/api/schedules/validate-cron`,
                { expression: form.cronExpression, timezone: form.timezone },
                { headers }
            );
            setCronValid(response.data.valid);
            setNextRun(response.data.nextRun);
        } catch {
            setCronValid(false);
            setNextRun(null);
        } finally {
            setValidating(false);
        }
    };

    const handlePlaylistSelect = (e) => {
        const playlist = playlists.find((p) => p.id === e.target.value);
        const autoName = playlist 
            ? `${playlist.owner || 'Unknown'} - ${playlist.name}` 
            : '';
        
        // Check if current name was auto-generated from a previous playlist
        const currentPlaylist = playlists.find((p) => p.id === form.targetId);
        const wasAutoGenerated = currentPlaylist 
            ? form.name === `${currentPlaylist.owner || 'Unknown'} - ${currentPlaylist.name}`
            : !form.name;
        
        setForm({
            ...form,
            targetId: playlist?.id || '',
            targetName: playlist?.name || '',
            name: wasAutoGenerated ? autoName : form.name
        });
    };

    const handlePresetSelect = (cron) => {
        setForm({ ...form, cronExpression: cron });
    };

    const handleSubmit = () => {
        if (!form.name.trim()) {
            alert('Name is required');
            return;
        }
        if (!cronValid) {
            alert('Invalid cron expression');
            return;
        }
        if (form.type === 'playlist' && !form.targetId) {
            alert('Please select a playlist');
            return;
        }
        if (form.type === 'url' && !form.targetId) {
            alert('Please enter a URL');
            return;
        }
        onSave(form);
    };

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="create-schedule-modal" onClick={(e) => e.stopPropagation()}>
                <header>
                    <h3>{schedule ? 'Edit Schedule' : 'New Schedule'}</h3>
                    <button onClick={onClose} className="close-btn">×</button>
                </header>

                <div className="form-content">
                    <div className="form-group">
                        <label>Name</label>
                        <input
                            type="text"
                            value={form.name}
                            onChange={(e) => setForm({ ...form, name: e.target.value })}
                            placeholder="Daily playlist sync"
                        />
                    </div>

                    <div className="form-group">
                        <label>Type</label>
                        <select
                            value={form.type}
                            onChange={(e) => setForm({ ...form, type: e.target.value })}
                        >
                            <option value="playlist">Single Playlist</option>
                            <option value="playlist-sync-all">Sync All Saved Playlists</option>
                            <option value="url">Custom URL</option>
                        </select>
                    </div>

                    {form.type === 'playlist' && (
                        <div className="form-group">
                            <label>Playlist</label>
                            <select value={form.targetId} onChange={handlePlaylistSelect}>
                                <option value="">Select a playlist...</option>
                                {playlists.map((p) => (
                                    <option key={p.id} value={p.id}>{p.name}</option>
                                ))}
                            </select>
                            {playlists.length === 0 && (
                                <div className="form-hint">No saved playlists. Save a playlist first.</div>
                            )}
                        </div>
                    )}

                    {form.type === 'url' && (
                        <div className="form-group">
                            <label>Spotify URL</label>
                            <input
                                type="text"
                                value={form.targetId}
                                onChange={(e) => setForm({ ...form, targetId: e.target.value })}
                                placeholder="https://open.spotify.com/playlist/..."
                            />
                        </div>
                    )}

                    <div className="form-group">
                        <label>Schedule (Cron Expression)</label>
                        <input
                            type="text"
                            value={form.cronExpression}
                            onChange={(e) => setForm({ ...form, cronExpression: e.target.value })}
                            className={cronValid ? '' : 'invalid'}
                        />
                        <div className="presets">
                            {SCHEDULE_PRESETS.map((preset) => (
                                <button
                                    key={preset.cron}
                                    type="button"
                                    className={form.cronExpression === preset.cron ? 'active' : ''}
                                    onClick={() => handlePresetSelect(preset.cron)}
                                >
                                    {preset.label}
                                </button>
                            ))}
                        </div>
                        {validating && <div className="form-hint">Validating...</div>}
                        {cronValid && nextRun && (
                            <div className="next-run-preview">
                                Next run: {new Date(nextRun).toLocaleString()}
                            </div>
                        )}
                        {!cronValid && !validating && (
                            <div className="form-error">Invalid cron expression</div>
                        )}
                    </div>

                    <div className="form-group">
                        <label>Timezone</label>
                        <select
                            value={form.timezone}
                            onChange={(e) => setForm({ ...form, timezone: e.target.value })}
                        >
                            <option value="UTC">UTC</option>
                            <option value="Europe/Istanbul">Europe/Istanbul</option>
                            <option value="Europe/London">Europe/London</option>
                            <option value="Europe/Berlin">Europe/Berlin</option>
                            <option value="America/New_York">America/New_York</option>
                            <option value="America/Los_Angeles">America/Los_Angeles</option>
                            <option value="Asia/Tokyo">Asia/Tokyo</option>
                        </select>
                    </div>

                    <div className="form-group checkbox">
                        <label>
                            <input
                                type="checkbox"
                                checked={form.newTracksOnly}
                                onChange={(e) => setForm({ ...form, newTracksOnly: e.target.checked })}
                            />
                            Download new tracks only
                        </label>
                    </div>
                </div>

                <footer>
                    <button onClick={onClose} className="cancel-btn">Cancel</button>
                    <button onClick={handleSubmit} className="save-btn" disabled={!cronValid}>
                        {schedule ? 'Save Changes' : 'Create Schedule'}
                    </button>
                </footer>
            </div>
        </div>
    );
}

export default Schedules;
