# Scheduling Feature

**Branch:** `feature/scheduling`

## Overview

Add scheduling capabilities to automatically download playlists at specified times or intervals, enabling "set and forget" playlist synchronization. Uses SQLite for persistent storage, sharing the database with statistics and playlist features.

## Features

### 1. Scheduled Downloads

- Schedule playlist downloads at specific times
- Recurring schedules (daily, weekly, custom)
- One-time scheduled downloads
- Time zone support

### 2. Playlist Sync Rules

- "Download new tracks from playlist X every day at 3 AM"
- "Sync all saved playlists every Sunday"
- "Download this album on release date" (future feature)

### 3. Schedule Management

- View all scheduled tasks
- Enable/disable schedules
- Edit schedule times
- Delete schedules
- View last run status

### 4. Execution History

- Log of scheduled task executions
- Success/failure status
- Tracks downloaded per execution
- Next scheduled run time

## Technical Implementation

### Backend Changes

#### New Dependencies

```bash
cd soggfy-web/backend
npm install node-cron cron-parser
```

#### Database Schema

Extends the existing `stats.db` SQLite database:

```sql
-- Schedules table
CREATE TABLE IF NOT EXISTS schedules (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('playlist', 'playlist-sync-all', 'url')),
    target_id TEXT,
    target_name TEXT,
    cron_expression TEXT NOT NULL,
    timezone TEXT DEFAULT 'UTC',
    new_tracks_only INTEGER DEFAULT 1,
    enabled INTEGER DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER,
    last_run_at INTEGER,
    last_run_status TEXT,
    next_run_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_schedules_enabled ON schedules(enabled);
CREATE INDEX IF NOT EXISTS idx_schedules_next_run ON schedules(next_run_at);

-- Execution history table
CREATE TABLE IF NOT EXISTS schedule_executions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    schedule_id TEXT NOT NULL,
    schedule_name TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    completed_at INTEGER,
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
    tracks_added INTEGER DEFAULT 0,
    error TEXT,
    FOREIGN KEY (schedule_id) REFERENCES schedules(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_executions_schedule ON schedule_executions(schedule_id);
CREATE INDEX IF NOT EXISTS idx_executions_started ON schedule_executions(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_executions_status ON schedule_executions(status);
```

#### New Files

```
soggfy-web/backend/
├── scheduler.js          # Scheduling engine using node-cron
```

#### scheduler.js

```javascript
const cron = require('node-cron');
const cronParser = require('cron-parser');

class Scheduler {
    constructor(db, queueManager, playlistManager) {
        this.db = db; // Shared SQLite database
        this.queue = queueManager;
        this.playlists = playlistManager;
        this.jobs = new Map(); // Active cron jobs in memory

        this.initTables();
        this.prepareStatements();
        this.initializeJobs();
    }

    initTables() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS schedules (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                type TEXT NOT NULL CHECK (type IN ('playlist', 'playlist-sync-all', 'url')),
                target_id TEXT,
                target_name TEXT,
                cron_expression TEXT NOT NULL,
                timezone TEXT DEFAULT 'UTC',
                new_tracks_only INTEGER DEFAULT 1,
                enabled INTEGER DEFAULT 1,
                created_at INTEGER NOT NULL,
                updated_at INTEGER,
                last_run_at INTEGER,
                last_run_status TEXT,
                next_run_at INTEGER
            );

            CREATE INDEX IF NOT EXISTS idx_schedules_enabled ON schedules(enabled);
            CREATE INDEX IF NOT EXISTS idx_schedules_next_run ON schedules(next_run_at);

            CREATE TABLE IF NOT EXISTS schedule_executions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                schedule_id TEXT NOT NULL,
                schedule_name TEXT NOT NULL,
                started_at INTEGER NOT NULL,
                completed_at INTEGER,
                status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
                tracks_added INTEGER DEFAULT 0,
                error TEXT,
                FOREIGN KEY (schedule_id) REFERENCES schedules(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_executions_schedule ON schedule_executions(schedule_id);
            CREATE INDEX IF NOT EXISTS idx_executions_started ON schedule_executions(started_at DESC);
            CREATE INDEX IF NOT EXISTS idx_executions_status ON schedule_executions(status);
        `);
    }

    prepareStatements() {
        this.stmts = {
            // Schedule statements
            insertSchedule: this.db.prepare(`
                INSERT INTO schedules 
                (id, name, type, target_id, target_name, cron_expression, timezone, 
                 new_tracks_only, enabled, created_at, next_run_at)
                VALUES (@id, @name, @type, @targetId, @targetName, @cronExpression, 
                        @timezone, @newTracksOnly, @enabled, @createdAt, @nextRunAt)
            `),
            getSchedule: this.db.prepare(`SELECT * FROM schedules WHERE id = ?`),
            getAllSchedules: this.db.prepare(`
                SELECT * FROM schedules ORDER BY created_at DESC
            `),
            getEnabledSchedules: this.db.prepare(`
                SELECT * FROM schedules WHERE enabled = 1
            `),
            updateSchedule: this.db.prepare(`
                UPDATE schedules SET
                    name = @name,
                    type = @type,
                    target_id = @targetId,
                    target_name = @targetName,
                    cron_expression = @cronExpression,
                    timezone = @timezone,
                    new_tracks_only = @newTracksOnly,
                    updated_at = @updatedAt,
                    next_run_at = @nextRunAt
                WHERE id = @id
            `),
            updateScheduleStatus: this.db.prepare(`
                UPDATE schedules SET
                    last_run_at = @lastRunAt,
                    last_run_status = @lastRunStatus,
                    next_run_at = @nextRunAt
                WHERE id = @id
            `),
            toggleSchedule: this.db.prepare(`
                UPDATE schedules SET enabled = @enabled, updated_at = @updatedAt WHERE id = @id
            `),
            deleteSchedule: this.db.prepare(`DELETE FROM schedules WHERE id = ?`),

            // Execution statements
            insertExecution: this.db.prepare(`
                INSERT INTO schedule_executions 
                (schedule_id, schedule_name, started_at, status)
                VALUES (@scheduleId, @scheduleName, @startedAt, 'running')
            `),
            updateExecution: this.db.prepare(`
                UPDATE schedule_executions SET
                    completed_at = @completedAt,
                    status = @status,
                    tracks_added = @tracksAdded,
                    error = @error
                WHERE id = @id
            `),
            getExecutionHistory: this.db.prepare(`
                SELECT * FROM schedule_executions 
                ORDER BY started_at DESC 
                LIMIT ? OFFSET ?
            `),
            getExecutionsBySchedule: this.db.prepare(`
                SELECT * FROM schedule_executions 
                WHERE schedule_id = ?
                ORDER BY started_at DESC 
                LIMIT ?
            `),
            getExecutionStats: this.db.prepare(`
                SELECT 
                    COUNT(*) as total,
                    SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
                    SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
                    SUM(tracks_added) as total_tracks
                FROM schedule_executions
                WHERE schedule_id = ?
            `),
            cleanOldExecutions: this.db.prepare(`
                DELETE FROM schedule_executions 
                WHERE started_at < ? 
                AND id NOT IN (
                    SELECT id FROM schedule_executions 
                    ORDER BY started_at DESC 
                    LIMIT 1000
                )
            `)
        };
    }

    // Initialize all enabled schedules on startup
    initializeJobs() {
        const schedules = this.stmts.getEnabledSchedules.all();

        for (const schedule of schedules) {
            this.startJob(schedule);
        }

        console.log(`Scheduler initialized with ${this.jobs.size} active jobs`);

        // Clean old executions (keep last 1000 or 30 days)
        const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
        this.stmts.cleanOldExecutions.run(thirtyDaysAgo);
    }

    // Calculate next run time using cron-parser
    getNextRunTime(cronExpression, timezone = 'UTC') {
        try {
            const interval = cronParser.parseExpression(cronExpression, {
                currentDate: new Date(),
                tz: timezone
            });
            return interval.next().getTime();
        } catch (error) {
            console.error('Failed to parse cron expression:', error);
            return null;
        }
    }

    // Validate cron expression
    isValidCron(cronExpression) {
        try {
            cronParser.parseExpression(cronExpression);
            return true;
        } catch {
            return false;
        }
    }

    // Generate unique ID
    generateId() {
        return 'sch_' + Math.random().toString(36).substring(2) + Date.now().toString(36);
    }

    // ==================== SCHEDULE CRUD ====================

    // Create a new schedule
    createSchedule(config) {
        if (!this.isValidCron(config.cronExpression)) {
            throw new Error('Invalid cron expression');
        }

        const id = this.generateId();
        const now = Date.now();
        const nextRunAt = this.getNextRunTime(config.cronExpression, config.timezone);

        const params = {
            id,
            name: config.name,
            type: config.type,
            targetId: config.targetId || null,
            targetName: config.targetName || null,
            cronExpression: config.cronExpression,
            timezone: config.timezone || 'UTC',
            newTracksOnly: config.newTracksOnly ? 1 : 0,
            enabled: 1,
            createdAt: now,
            nextRunAt
        };

        this.stmts.insertSchedule.run(params);

        const schedule = this.stmts.getSchedule.get(id);
        this.startJob(schedule);

        return this.formatSchedule(schedule);
    }

    // Get all schedules
    getSchedules() {
        const schedules = this.stmts.getAllSchedules.all();
        return schedules.map(s => ({
            ...this.formatSchedule(s),
            isRunning: this.jobs.has(s.id)
        }));
    }

    // Get single schedule
    getSchedule(id) {
        const schedule = this.stmts.getSchedule.get(id);
        if (!schedule) return null;

        const stats = this.stmts.getExecutionStats.get(id);

        return {
            ...this.formatSchedule(schedule),
            isRunning: this.jobs.has(id),
            stats: {
                totalExecutions: stats.total,
                completed: stats.completed,
                failed: stats.failed,
                totalTracksAdded: stats.total_tracks || 0
            }
        };
    }

    // Update schedule
    updateSchedule(id, updates) {
        const existing = this.stmts.getSchedule.get(id);
        if (!existing) return null;

        if (updates.cronExpression && !this.isValidCron(updates.cronExpression)) {
            throw new Error('Invalid cron expression');
        }

        const cronExpr = updates.cronExpression || existing.cron_expression;
        const timezone = updates.timezone || existing.timezone;
        const nextRunAt = this.getNextRunTime(cronExpr, timezone);

        const params = {
            id,
            name: updates.name ?? existing.name,
            type: updates.type ?? existing.type,
            targetId: updates.targetId ?? existing.target_id,
            targetName: updates.targetName ?? existing.target_name,
            cronExpression: cronExpr,
            timezone: timezone,
            newTracksOnly: updates.newTracksOnly !== undefined 
                ? (updates.newTracksOnly ? 1 : 0) 
                : existing.new_tracks_only,
            updatedAt: Date.now(),
            nextRunAt
        };

        this.stmts.updateSchedule.run(params);

        const schedule = this.stmts.getSchedule.get(id);

        // Restart job if enabled
        if (schedule.enabled) {
            this.stopJob(id);
            this.startJob(schedule);
        }

        return this.formatSchedule(schedule);
    }

    // Toggle schedule enabled/disabled
    toggleSchedule(id) {
        const schedule = this.stmts.getSchedule.get(id);
        if (!schedule) return null;

        const newEnabled = schedule.enabled ? 0 : 1;

        this.stmts.toggleSchedule.run({
            id,
            enabled: newEnabled,
            updatedAt: Date.now()
        });

        if (newEnabled) {
            this.startJob(this.stmts.getSchedule.get(id));
        } else {
            this.stopJob(id);
        }

        return this.formatSchedule(this.stmts.getSchedule.get(id));
    }

    // Delete schedule
    deleteSchedule(id) {
        this.stopJob(id);
        this.stmts.deleteSchedule.run(id);
        return { success: true };
    }

    // Format schedule for API response
    formatSchedule(row) {
        return {
            id: row.id,
            name: row.name,
            type: row.type,
            targetId: row.target_id,
            targetName: row.target_name,
            cronExpression: row.cron_expression,
            timezone: row.timezone,
            newTracksOnly: !!row.new_tracks_only,
            enabled: !!row.enabled,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            lastRunAt: row.last_run_at,
            lastRunStatus: row.last_run_status,
            nextRunAt: row.next_run_at
        };
    }

    // ==================== JOB MANAGEMENT ====================

    // Start a cron job for a schedule
    startJob(schedule) {
        if (this.jobs.has(schedule.id)) {
            this.stopJob(schedule.id);
        }

        try {
            const job = cron.schedule(schedule.cron_expression, async () => {
                await this.executeSchedule(schedule.id);
            }, {
                timezone: schedule.timezone || 'UTC'
            });

            this.jobs.set(schedule.id, job);
            console.log(`Started job: ${schedule.name} (${schedule.cron_expression})`);
        } catch (error) {
            console.error(`Failed to start job ${schedule.id}:`, error);
        }
    }

    // Stop a cron job
    stopJob(scheduleId) {
        if (this.jobs.has(scheduleId)) {
            this.jobs.get(scheduleId).stop();
            this.jobs.delete(scheduleId);
        }
    }

    // Execute a scheduled task
    async executeSchedule(scheduleId) {
        const schedule = this.stmts.getSchedule.get(scheduleId);
        if (!schedule || !schedule.enabled) return null;

        console.log(`Executing scheduled task: ${schedule.name}`);

        // Insert execution record
        const execResult = this.stmts.insertExecution.run({
            scheduleId,
            scheduleName: schedule.name,
            startedAt: Date.now()
        });
        const executionId = execResult.lastInsertRowid;

        let tracksAdded = 0;
        let status = 'completed';
        let error = null;

        try {
            switch (schedule.type) {
                case 'playlist':
                    tracksAdded = await this.downloadPlaylist(
                        schedule.target_id,
                        !!schedule.new_tracks_only
                    );
                    break;

                case 'playlist-sync-all':
                    tracksAdded = await this.syncAllPlaylists();
                    break;

                case 'url':
                    const tracks = await this.queue.addUrl(schedule.target_id);
                    tracksAdded = tracks.length;
                    break;
            }
        } catch (err) {
            status = 'failed';
            error = err.message;
            console.error(`Schedule execution failed:`, err);
        }

        const completedAt = Date.now();
        const nextRunAt = this.getNextRunTime(schedule.cron_expression, schedule.timezone);

        // Update execution record
        this.stmts.updateExecution.run({
            id: executionId,
            completedAt,
            status,
            tracksAdded,
            error
        });

        // Update schedule status
        this.stmts.updateScheduleStatus.run({
            id: scheduleId,
            lastRunAt: completedAt,
            lastRunStatus: status,
            nextRunAt
        });

        return {
            executionId,
            scheduleId,
            scheduleName: schedule.name,
            status,
            tracksAdded,
            error,
            duration: completedAt - execResult.lastInsertRowid
        };
    }

    // Run schedule immediately (manual trigger)
    async runNow(scheduleId) {
        return await this.executeSchedule(scheduleId);
    }

    // Download playlist helper
    async downloadPlaylist(playlistId, newTracksOnly) {
        if (newTracksOnly) {
            const syncResult = await this.playlists.syncPlaylist(playlistId);
            if (!syncResult || syncResult.newTrackIds.length === 0) return 0;

            for (const trackId of syncResult.newTrackIds) {
                await this.queue.addUrl(`spotify:track:${trackId}`);
            }

            this.playlists.markPlaylistDownloaded(playlistId);
            return syncResult.newTrackIds.length;
        } else {
            const trackIds = this.playlists.getPlaylistTrackIds(playlistId);

            for (const trackId of trackIds) {
                await this.queue.addUrl(`spotify:track:${trackId}`);
            }

            this.playlists.markPlaylistDownloaded(playlistId);
            return trackIds.length;
        }
    }

    // Sync all saved playlists helper
    async syncAllPlaylists() {
        const playlists = this.playlists.getPlaylists();
        let totalAdded = 0;

        for (const playlist of playlists) {
            try {
                const added = await this.downloadPlaylist(playlist.id, true);
                totalAdded += added;
            } catch (error) {
                console.error(`Failed to sync playlist ${playlist.id}:`, error);
            }
        }

        return totalAdded;
    }

    // ==================== EXECUTION HISTORY ====================

    // Get execution history with pagination
    getExecutionHistory(options = {}) {
        const limit = options.limit || 50;
        const offset = options.offset || 0;

        const rows = this.stmts.getExecutionHistory.all(limit, offset);

        return rows.map(row => ({
            id: row.id,
            scheduleId: row.schedule_id,
            scheduleName: row.schedule_name,
            startedAt: row.started_at,
            completedAt: row.completed_at,
            status: row.status,
            tracksAdded: row.tracks_added,
            error: row.error,
            duration: row.completed_at ? row.completed_at - row.started_at : null
        }));
    }

    // Get executions for a specific schedule
    getScheduleExecutions(scheduleId, limit = 20) {
        const rows = this.stmts.getExecutionsBySchedule.all(scheduleId, limit);

        return rows.map(row => ({
            id: row.id,
            startedAt: row.started_at,
            completedAt: row.completed_at,
            status: row.status,
            tracksAdded: row.tracks_added,
            error: row.error,
            duration: row.completed_at ? row.completed_at - row.started_at : null
        }));
    }

    // ==================== LIFECYCLE ====================

    // Cleanup on shutdown
    shutdown() {
        console.log('Shutting down scheduler...');
        for (const [id, job] of this.jobs) {
            job.stop();
            console.log(`Stopped job: ${id}`);
        }
        this.jobs.clear();
    }
}

module.exports = Scheduler;
```

#### API Endpoints

| Method | Endpoint                       | Description                     |
|--------|--------------------------------|---------------------------------|
| GET    | `/api/schedules`               | Get all schedules               |
| GET    | `/api/schedules/:id`           | Get schedule with stats         |
| POST   | `/api/schedules`               | Create new schedule             |
| PUT    | `/api/schedules/:id`           | Update schedule                 |
| DELETE | `/api/schedules/:id`           | Delete schedule                 |
| POST   | `/api/schedules/:id/toggle`    | Enable/disable schedule         |
| POST   | `/api/schedules/:id/run`       | Run schedule immediately        |
| GET    | `/api/schedules/:id/executions`| Get schedule's execution history|
| GET    | `/api/schedules/history`       | Get all execution history       |
| POST   | `/api/schedules/validate-cron` | Validate cron expression        |

#### server.js Integration

```javascript
const Scheduler = require('./scheduler');

// Share database with StatsManager and PlaylistManager
const scheduler = new Scheduler(stats.db, queue, playlistMgr);

// Graceful shutdown
process.on('SIGTERM', () => {
    scheduler.shutdown();
    process.exit(0);
});

process.on('SIGINT', () => {
    scheduler.shutdown();
    process.exit(0);
});

// Schedule Routes
app.get('/api/schedules', authMiddleware, (req, res) => {
    res.json(scheduler.getSchedules());
});

app.get('/api/schedules/:id', authMiddleware, (req, res) => {
    const schedule = scheduler.getSchedule(req.params.id);
    if (!schedule) return res.status(404).json({ error: 'Schedule not found' });
    res.json(schedule);
});

app.post('/api/schedules', authMiddleware, (req, res) => {
    try {
        const schedule = scheduler.createSchedule(req.body);
        res.json(schedule);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.put('/api/schedules/:id', authMiddleware, (req, res) => {
    try {
        const schedule = scheduler.updateSchedule(req.params.id, req.body);
        if (!schedule) return res.status(404).json({ error: 'Schedule not found' });
        res.json(schedule);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.delete('/api/schedules/:id', authMiddleware, (req, res) => {
    scheduler.deleteSchedule(req.params.id);
    res.json({ success: true });
});

app.post('/api/schedules/:id/toggle', authMiddleware, (req, res) => {
    const schedule = scheduler.toggleSchedule(req.params.id);
    if (!schedule) return res.status(404).json({ error: 'Schedule not found' });
    res.json(schedule);
});

app.post('/api/schedules/:id/run', authMiddleware, async (req, res) => {
    try {
        const result = await scheduler.runNow(req.params.id);
        if (!result) return res.status(404).json({ error: 'Schedule not found' });
        res.json(result);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.get('/api/schedules/:id/executions', authMiddleware, (req, res) => {
    const { limit } = req.query;
    res.json(scheduler.getScheduleExecutions(req.params.id, parseInt(limit) || 20));
});

app.get('/api/schedules/history', authMiddleware, (req, res) => {
    const { limit, offset } = req.query;
    res.json(scheduler.getExecutionHistory({
        limit: parseInt(limit) || 50,
        offset: parseInt(offset) || 0
    }));
});

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
```

### Frontend Changes

#### New Components

```
soggfy-web/frontend/src/components/
├── Schedules/
│   ├── Schedules.jsx           # Schedule management page
│   ├── Schedules.css           # Styles
│   ├── ScheduleCard.jsx        # Individual schedule card
│   ├── CreateSchedule.jsx      # Create/edit schedule modal
│   ├── ExecutionHistory.jsx    # Execution history list
│   └── CronBuilder.jsx         # Visual cron expression builder
```

#### Schedules.jsx Structure

```jsx
import { useState, useEffect } from 'react';
import axios from 'axios';
import ScheduleCard from './ScheduleCard';
import CreateSchedule from './CreateSchedule';
import ExecutionHistory from './ExecutionHistory';
import './Schedules.css';

function Schedules() {
    const [schedules, setSchedules] = useState([]);
    const [showCreate, setShowCreate] = useState(false);
    const [editSchedule, setEditSchedule] = useState(null);
    const [history, setHistory] = useState([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        fetchSchedules();
        fetchHistory();
    }, []);

    const fetchSchedules = async () => {
        try {
            const response = await axios.get(`${API_BASE}/schedules`);
            setSchedules(response.data);
        } catch (error) {
            console.error('Failed to fetch schedules:', error);
        } finally {
            setLoading(false);
        }
    };

    const fetchHistory = async () => {
        try {
            const response = await axios.get(`${API_BASE}/schedules/history`, {
                params: { limit: 20 }
            });
            setHistory(response.data);
        } catch (error) {
            console.error('Failed to fetch history:', error);
        }
    };

    const handleCreate = async (data) => {
        try {
            if (editSchedule) {
                await axios.put(`${API_BASE}/schedules/${editSchedule.id}`, data);
            } else {
                await axios.post(`${API_BASE}/schedules`, data);
            }
            await fetchSchedules();
            setShowCreate(false);
            setEditSchedule(null);
        } catch (error) {
            alert('Failed: ' + error.response?.data?.error || error.message);
        }
    };

    const handleToggle = async (id) => {
        try {
            await axios.post(`${API_BASE}/schedules/${id}/toggle`);
            await fetchSchedules();
        } catch (error) {
            console.error('Toggle failed:', error);
        }
    };

    const handleRunNow = async (id) => {
        try {
            const result = await axios.post(`${API_BASE}/schedules/${id}/run`);
            alert(`Executed: ${result.data.tracksAdded} tracks added`);
            await fetchSchedules();
            await fetchHistory();
        } catch (error) {
            alert('Execution failed: ' + error.message);
        }
    };

    const handleDelete = async (id) => {
        if (!confirm('Delete this schedule?')) return;
        try {
            await axios.delete(`${API_BASE}/schedules/${id}`);
            await fetchSchedules();
        } catch (error) {
            console.error('Delete failed:', error);
        }
    };

    const handleEdit = (schedule) => {
        setEditSchedule(schedule);
        setShowCreate(true);
    };

    if (loading) return <div className="loading">Loading schedules...</div>;

    return (
        <div className="schedules-page">
            <header className="schedules-header">
                <h2>Scheduled Downloads</h2>
                <button onClick={() => setShowCreate(true)} className="create-btn">
                    ➕ New Schedule
                </button>
            </header>

            {schedules.length === 0 ? (
                <div className="empty-state">
                    <p>No scheduled downloads</p>
                    <p className="hint">Create a schedule to automate playlist syncing</p>
                </div>
            ) : (
                <div className="schedules-list">
                    {schedules.map(schedule => (
                        <ScheduleCard
                            key={schedule.id}
                            schedule={schedule}
                            onToggle={() => handleToggle(schedule.id)}
                            onEdit={() => handleEdit(schedule)}
                            onDelete={() => handleDelete(schedule.id)}
                            onRunNow={() => handleRunNow(schedule.id)}
                        />
                    ))}
                </div>
            )}

            <section className="history-section">
                <h3>Recent Executions</h3>
                <ExecutionHistory history={history} />
            </section>

            {showCreate && (
                <CreateSchedule
                    schedule={editSchedule}
                    onClose={() => {
                        setShowCreate(false);
                        setEditSchedule(null);
                    }}
                    onSave={handleCreate}
                />
            )}
        </div>
    );
}

export default Schedules;
```

#### ScheduleCard.jsx

```jsx
function ScheduleCard({ schedule, onToggle, onEdit, onDelete, onRunNow }) {
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
            case 'playlist': return '📚';
            case 'playlist-sync-all': return '🔄';
            case 'url': return '🔗';
            default: return '📅';
        }
    };

    const getStatusIcon = (status) => {
        switch (status) {
            case 'success': return '✅';
            case 'failed': return '❌';
            default: return '⏳';
        }
    };

    return (
        <div className={`schedule-card ${schedule.enabled ? '' : 'disabled'}`}>
            <div className="schedule-header">
                <div className="schedule-status">
                    <button 
                        className={`toggle-btn ${schedule.enabled ? 'enabled' : ''}`}
                        onClick={onToggle}
                        title={schedule.enabled ? 'Disable' : 'Enable'}
                    >
                        {schedule.enabled ? '✅' : '⏸️'}
                    </button>
                    <h3>{schedule.name}</h3>
                </div>
                <div className="schedule-actions">
                    <button onClick={onRunNow} title="Run Now" className="action-btn">
                        ▶️
                    </button>
                    <button onClick={onEdit} title="Edit" className="action-btn">
                        ✏️
                    </button>
                    <button onClick={onDelete} title="Delete" className="action-btn danger">
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
                        {schedule.newTracksOnly && ' • New tracks only'}
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
                        → Next: {formatRelativeTime(schedule.nextRunAt)}
                    </div>
                )}
            </div>
        </div>
    );
}

export default ScheduleCard;
```

#### CreateSchedule.jsx

```jsx
import { useState, useEffect } from 'react';
import axios from 'axios';

const SCHEDULE_PRESETS = [
    { label: 'Every day at 3 AM', cron: '0 3 * * *' },
    { label: 'Every day at midnight', cron: '0 0 * * *' },
    { label: 'Every Sunday at 2 AM', cron: '0 2 * * 0' },
    { label: 'Every Monday at 6 AM', cron: '0 6 * * 1' },
    { label: 'Every 6 hours', cron: '0 */6 * * *' },
    { label: 'Every 12 hours', cron: '0 */12 * * *' },
    { label: 'First of month at 4 AM', cron: '0 4 1 * *' },
];

function CreateSchedule({ schedule, onClose, onSave }) {
    const [form, setForm] = useState({
        name: schedule?.name || '',
        type: schedule?.type || 'playlist',
        targetId: schedule?.targetId || '',
        targetName: schedule?.targetName || '',
        cronExpression: schedule?.cronExpression || '0 3 * * *',
        timezone: schedule?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
        newTracksOnly: schedule?.newTracksOnly ?? true
    });
    const [playlists, setPlaylists] = useState([]);
    const [cronValid, setCronValid] = useState(true);
    const [nextRun, setNextRun] = useState(null);

    useEffect(() => {
        fetchPlaylists();
    }, []);

    useEffect(() => {
        validateCron();
    }, [form.cronExpression, form.timezone]);

    const fetchPlaylists = async () => {
        try {
            const response = await axios.get(`${API_BASE}/playlists`);
            setPlaylists(response.data);
        } catch (error) {
            console.error('Failed to fetch playlists:', error);
        }
    };

    const validateCron = async () => {
        try {
            const response = await axios.post(`${API_BASE}/schedules/validate-cron`, {
                expression: form.cronExpression,
                timezone: form.timezone
            });
            setCronValid(response.data.valid);
            setNextRun(response.data.nextRun);
        } catch {
            setCronValid(false);
            setNextRun(null);
        }
    };

    const handlePlaylistSelect = (e) => {
        const playlist = playlists.find(p => p.id === e.target.value);
        setForm({
            ...form,
            targetId: playlist?.id || '',
            targetName: playlist?.name || ''
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
        onSave(form);
    };

    return (
        <div className="modal-overlay">
            <div className="create-schedule-modal">
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
                            onChange={e => setForm({ ...form, name: e.target.value })}
                            placeholder="Daily playlist sync"
                        />
                    </div>

                    <div className="form-group">
                        <label>Type</label>
                        <select
                            value={form.type}
                            onChange={e => setForm({ ...form, type: e.target.value })}
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
                                {playlists.map(p => (
                                    <option key={p.id} value={p.id}>{p.name}</option>
                                ))}
                            </select>
                        </div>
                    )}

                    {form.type === 'url' && (
                        <div className="form-group">
                            <label>URL</label>
                            <input
                                type="text"
                                value={form.targetId}
                                onChange={e => setForm({ ...form, targetId: e.target.value })}
                                placeholder="https://open.spotify.com/..."
                            />
                        </div>
                    )}

                    <div className="form-group">
                        <label>Schedule (Cron Expression)</label>
                        <input
                            type="text"
                            value={form.cronExpression}
                            onChange={e => setForm({ ...form, cronExpression: e.target.value })}
                            className={cronValid ? '' : 'invalid'}
                        />
                        <div className="presets">
                            {SCHEDULE_PRESETS.map(preset => (
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
                        {cronValid && nextRun && (
                            <div className="next-run-preview">
                                Next run: {new Date(nextRun).toLocaleString()}
                            </div>
                        )}
                        {!cronValid && (
                            <div className="error">Invalid cron expression</div>
                        )}
                    </div>

                    <div className="form-group">
                        <label>Timezone</label>
                        <select
                            value={form.timezone}
                            onChange={e => setForm({ ...form, timezone: e.target.value })}
                        >
                            <option value="UTC">UTC</option>
                            <option value="Europe/Istanbul">Europe/Istanbul</option>
                            <option value="Europe/London">Europe/London</option>
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
                                onChange={e => setForm({ ...form, newTracksOnly: e.target.checked })}
                            />
                            Download new tracks only
                        </label>
                    </div>
                </div>

                <footer>
                    <button onClick={onClose}>Cancel</button>
                    <button onClick={handleSubmit} className="primary" disabled={!cronValid}>
                        {schedule ? 'Save Changes' : 'Create Schedule'}
                    </button>
                </footer>
            </div>
        </div>
    );
}

export default CreateSchedule;
```

### Data Storage

**Location:** `%localappdata%/Soggfy/stats.db` (shared SQLite database)

**Why SQLite over JSON?**

| Feature                | JSON File                         | SQLite                              |
|------------------------|-----------------------------------|-------------------------------------|
| Execution history      | Limited to 100, all in memory     | Unlimited with pagination           |
| History search         | Not implemented                   | Indexed queries available           |
| Schedule stats         | Manual calculation                | SQL aggregation (COUNT, SUM)        |
| Next run calculation   | Placeholder code                  | Proper cron-parser integration      |
| Data cleanup           | Manual slice                      | DELETE with WHERE clause            |
| Concurrent access      | Risk of corruption                | ACID transactions                   |

**Database Size Estimate:**
- 1 schedule ~500 bytes
- 1 execution record ~200 bytes
- 100 schedules + 10,000 executions ~2.5 MB

## UI Design

### Schedules List

```
┌─────────────────────────────────────────────────────────────────┐
│  ⏰ Scheduled Downloads                       [➕ New Schedule]  │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ [✅] Daily Top Hits Sync                    [▶️][✏️][🗑️] │    │
│  │     📚 Today's Top Hits • New tracks only               │    │
│  │     🕐 0 3 * * * (Europe/Istanbul)                      │    │
│  │     ✅ Last: Jan 12, 2024 03:00 AM                      │    │
│  │     → Next: in 5 hours                                  │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ [⏸️] Weekly Full Sync (disabled)            [▶️][✏️][🗑️] │    │
│  │     🔄 Sync All Saved Playlists                         │    │
│  │     🕐 0 2 * * 0 (UTC)                                  │    │
│  │     ❌ Last: Jan 7, 2024 (Failed: connection error)     │    │
│  └─────────────────────────────────────────────────────────┘    │
├─────────────────────────────────────────────────────────────────┤
│  📜 Recent Executions                                           │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ ✅ Daily Top Hits Sync    │ 5 tracks  │ 2h ago  │  1.2s   │  │
│  │ ✅ Daily Top Hits Sync    │ 3 tracks  │ 26h ago │  0.8s   │  │
│  │ ❌ Weekly Full Sync       │ Failed    │ 5d ago  │  -      │  │
│  │ ✅ Daily Top Hits Sync    │ 0 tracks  │ 6d ago  │  0.3s   │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### Create Schedule Modal

```
┌─────────────────────────────────────────────────────────────────┐
│  New Schedule                                             [×]   │
├─────────────────────────────────────────────────────────────────┤
│  Name: [Daily Top Hits Sync                               ]    │
│                                                                 │
│  Type: [Single Playlist            ▼]                          │
│                                                                 │
│  Playlist: [Today's Top Hits       ▼]                          │
│                                                                 │
│  Schedule (Cron): [0 3 * * *                              ]    │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │[Every day 3AM][Midnight][Sunday 2AM][Monday 6AM][6 hrs] │   │
│  └─────────────────────────────────────────────────────────┘   │
│  ✓ Next run: Tomorrow at 03:00 AM                              │
│                                                                 │
│  Timezone: [Europe/Istanbul        ▼]                          │
│                                                                 │
│  [✓] Download new tracks only                                  │
├─────────────────────────────────────────────────────────────────┤
│                              [Cancel]  [Create Schedule]        │
└─────────────────────────────────────────────────────────────────┘
```

## Common Cron Expressions

| Schedule                            | Cron Expression | Description             |
|-------------------------------------|-----------------|-------------------------|
| Every day at 3 AM                   | `0 3 * * *`     | Daily sync              |
| Every day at midnight               | `0 0 * * *`     | Midnight sync           |
| Every Sunday at 2 AM                | `0 2 * * 0`     | Weekly backup           |
| Every Monday at 6 AM                | `0 6 * * 1`     | Start of week           |
| Every 6 hours                       | `0 */6 * * *`   | Frequent updates        |
| Every 12 hours                      | `0 */12 * * *`  | Twice daily             |
| First of month at 4 AM              | `0 4 1 * *`     | Monthly archive         |
| Weekdays at 8 AM                    | `0 8 * * 1-5`   | Workday morning         |

## Testing

1. Create schedules with different intervals
2. Verify cron jobs start/stop correctly on enable/disable
3. Test manual "Run Now" execution
4. Verify execution history is recorded with correct status
5. Test schedule enable/disable persistence
6. Verify jobs resume after server restart
7. Test cron expression validation
8. Test error handling for failed downloads
9. Verify CASCADE delete removes executions when schedule deleted
10. Test timezone handling

## Performance Considerations

- **Prepared statements**: All database operations use prepared statements
- **Indexed columns**: enabled, next_run_at, started_at, schedule_id
- **Automatic cleanup**: Old executions cleaned on startup (30 days / 1000 limit)
- **Graceful shutdown**: All cron jobs stopped properly

## Future Enhancements

- Notification on schedule completion (integrate with notifications feature)
- Retry failed schedules with backoff
- Schedule templates for common patterns
- Import/export schedules
- Schedule dependencies (run B after A completes)
- Bandwidth/time limits (don't run during peak hours)
- Visual cron expression builder
- Schedule pause/resume with date range
