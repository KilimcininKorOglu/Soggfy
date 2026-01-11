# Scheduling Feature

**Branch:** `feature/scheduling`

## Overview

Add scheduling capabilities to automatically download playlists at specified times or intervals, enabling "set and forget" playlist synchronization.

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
npm install node-cron
```

#### New Files

```
soggfy-web/backend/
├── scheduler.js          # Scheduling engine using node-cron
├── schedules.json        # Persistent schedule storage
```

#### scheduler.js

```javascript
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

class Scheduler {
  constructor(queueManager, playlistManager, dbPath) {
    this.queue = queueManager;
    this.playlists = playlistManager;
    this.dbPath = dbPath;
    this.data = this.load();
    this.jobs = new Map(); // Active cron jobs
    
    this.initializeJobs();
  }

  load() {
    try {
      return JSON.parse(fs.readFileSync(this.dbPath, 'utf8'));
    } catch {
      return { schedules: [], executionHistory: [] };
    }
  }

  save() {
    fs.writeFileSync(this.dbPath, JSON.stringify(this.data, null, 2));
  }

  // Initialize all saved schedules on startup
  initializeJobs() {
    for (const schedule of this.data.schedules) {
      if (schedule.enabled) {
        this.startJob(schedule);
      }
    }
    console.log(`Scheduler initialized with ${this.jobs.size} active jobs`);
  }

  // Create a new schedule
  createSchedule(config) {
    const schedule = {
      id: this.generateId(),
      name: config.name,
      type: config.type, // 'playlist', 'playlist-sync-all', 'url'
      targetId: config.targetId, // playlist ID or URL
      targetName: config.targetName,
      cronExpression: config.cronExpression,
      timezone: config.timezone || 'UTC',
      newTracksOnly: config.newTracksOnly || false,
      enabled: true,
      createdAt: Date.now(),
      lastRunAt: null,
      lastRunStatus: null,
      nextRunAt: this.getNextRunTime(config.cronExpression)
    };

    this.data.schedules.push(schedule);
    this.save();
    this.startJob(schedule);

    return schedule;
  }

  // Start a cron job for a schedule
  startJob(schedule) {
    if (this.jobs.has(schedule.id)) {
      this.jobs.get(schedule.id).stop();
    }

    const job = cron.schedule(schedule.cronExpression, async () => {
      await this.executeSchedule(schedule.id);
    }, {
      timezone: schedule.timezone
    });

    this.jobs.set(schedule.id, job);
  }

  // Execute a scheduled task
  async executeSchedule(scheduleId) {
    const schedule = this.data.schedules.find(s => s.id === scheduleId);
    if (!schedule || !schedule.enabled) return;

    console.log(`Executing scheduled task: ${schedule.name}`);
    
    const execution = {
      scheduleId,
      scheduleName: schedule.name,
      startedAt: Date.now(),
      status: 'running',
      tracksAdded: 0,
      error: null
    };

    try {
      let tracksAdded = 0;

      switch (schedule.type) {
        case 'playlist':
          tracksAdded = await this.downloadPlaylist(
            schedule.targetId, 
            schedule.newTracksOnly
          );
          break;
        
        case 'playlist-sync-all':
          tracksAdded = await this.syncAllPlaylists();
          break;
        
        case 'url':
          const tracks = await this.queue.addUrl(schedule.targetId);
          tracksAdded = tracks.length;
          break;
      }

      execution.status = 'completed';
      execution.tracksAdded = tracksAdded;
      execution.completedAt = Date.now();

      schedule.lastRunAt = Date.now();
      schedule.lastRunStatus = 'success';
      schedule.nextRunAt = this.getNextRunTime(schedule.cronExpression);

    } catch (error) {
      execution.status = 'failed';
      execution.error = error.message;
      execution.completedAt = Date.now();

      schedule.lastRunAt = Date.now();
      schedule.lastRunStatus = 'failed';
    }

    // Add to execution history (keep last 100)
    this.data.executionHistory.unshift(execution);
    if (this.data.executionHistory.length > 100) {
      this.data.executionHistory = this.data.executionHistory.slice(0, 100);
    }

    this.save();
    return execution;
  }

  async downloadPlaylist(playlistId, newTracksOnly) {
    if (newTracksOnly) {
      const syncResult = await this.playlists.syncPlaylist(playlistId);
      if (syncResult.newTrackIds.length === 0) return 0;
      
      // Add only new tracks to queue
      for (const trackId of syncResult.newTrackIds) {
        await this.queue.addUrl(`spotify:track:${trackId}`);
      }
      return syncResult.newTrackIds.length;
    } else {
      const tracks = await this.queue.addUrl(
        `https://open.spotify.com/playlist/${playlistId}`
      );
      return tracks.length;
    }
  }

  async syncAllPlaylists() {
    const playlists = this.playlists.getPlaylists();
    let totalAdded = 0;

    for (const playlist of playlists) {
      const added = await this.downloadPlaylist(playlist.id, true);
      totalAdded += added;
    }

    return totalAdded;
  }

  // Update schedule
  updateSchedule(scheduleId, updates) {
    const index = this.data.schedules.findIndex(s => s.id === scheduleId);
    if (index === -1) return null;

    const schedule = { ...this.data.schedules[index], ...updates };
    
    if (updates.cronExpression) {
      schedule.nextRunAt = this.getNextRunTime(updates.cronExpression);
    }

    this.data.schedules[index] = schedule;
    this.save();

    // Restart job if enabled
    if (schedule.enabled) {
      this.startJob(schedule);
    } else {
      this.stopJob(scheduleId);
    }

    return schedule;
  }

  // Toggle schedule enabled/disabled
  toggleSchedule(scheduleId) {
    const schedule = this.data.schedules.find(s => s.id === scheduleId);
    if (!schedule) return null;

    schedule.enabled = !schedule.enabled;
    this.save();

    if (schedule.enabled) {
      this.startJob(schedule);
    } else {
      this.stopJob(scheduleId);
    }

    return schedule;
  }

  // Stop a cron job
  stopJob(scheduleId) {
    if (this.jobs.has(scheduleId)) {
      this.jobs.get(scheduleId).stop();
      this.jobs.delete(scheduleId);
    }
  }

  // Delete schedule
  deleteSchedule(scheduleId) {
    this.stopJob(scheduleId);
    this.data.schedules = this.data.schedules.filter(s => s.id !== scheduleId);
    this.save();
  }

  // Get all schedules
  getSchedules() {
    return this.data.schedules.map(s => ({
      ...s,
      isRunning: this.jobs.has(s.id)
    }));
  }

  // Get execution history
  getExecutionHistory(limit = 50) {
    return this.data.executionHistory.slice(0, limit);
  }

  // Calculate next run time from cron expression
  getNextRunTime(cronExpression) {
    try {
      const interval = cron.schedule(cronExpression, () => {});
      // node-cron doesn't have built-in next run calculation
      // We'll use a simple approximation or external library
      interval.stop();
      return Date.now() + 86400000; // Placeholder: 24 hours from now
    } catch {
      return null;
    }
  }

  generateId() {
    return Math.random().toString(36).substring(2) + Date.now().toString(36);
  }

  // Cleanup on shutdown
  shutdown() {
    for (const job of this.jobs.values()) {
      job.stop();
    }
    this.jobs.clear();
  }
}

module.exports = Scheduler;
```

#### API Endpoints

| Method | Endpoint                    | Description             |
|--------|-----------------------------|-------------------------|
| GET    | `/api/schedules`            | Get all schedules       |
| POST   | `/api/schedules`            | Create new schedule     |
| PUT    | `/api/schedules/:id`        | Update schedule         |
| DELETE | `/api/schedules/:id`        | Delete schedule         |
| POST   | `/api/schedules/:id/toggle` | Enable/disable schedule |
| POST   | `/api/schedules/:id/run`    | Run schedule now        |
| GET    | `/api/schedules/history`    | Get execution history   |

### Frontend Changes

#### New Components

```
soggfy-web/frontend/src/components/
├── Schedules/
│   ├── Schedules.jsx           # Schedule management page
│   ├── Schedules.css           # Styles
│   ├── ScheduleCard.jsx        # Individual schedule card
│   ├── CreateSchedule.jsx      # Create/edit schedule modal
│   └── ExecutionHistory.jsx    # Execution history list
```

#### Schedules.jsx Structure

```jsx
function Schedules() {
  const [schedules, setSchedules] = useState([]);
  const [showCreate, setShowCreate] = useState(false);
  const [history, setHistory] = useState([]);

  return (
    <div className="schedules-page">
      <header>
        <h2>Scheduled Downloads</h2>
        <button onClick={() => setShowCreate(true)}>New Schedule</button>
      </header>

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

      <section className="history-section">
        <h3>Recent Executions</h3>
        <ExecutionHistory history={history} />
      </section>

      {showCreate && (
        <CreateSchedule
          onClose={() => setShowCreate(false)}
          onSave={handleCreate}
        />
      )}
    </div>
  );
}
```

#### CreateSchedule.jsx

```jsx
function CreateSchedule({ onClose, onSave, editSchedule }) {
  const [form, setForm] = useState({
    name: editSchedule?.name || '',
    type: editSchedule?.type || 'playlist',
    targetId: editSchedule?.targetId || '',
    scheduleType: 'daily', // 'daily', 'weekly', 'custom'
    time: '03:00',
    daysOfWeek: [0], // Sunday
    cronExpression: '',
    newTracksOnly: true
  });

  const generateCronExpression = () => {
    const [hours, minutes] = form.time.split(':');
    
    switch (form.scheduleType) {
      case 'daily':
        return `${minutes} ${hours} * * *`;
      case 'weekly':
        return `${minutes} ${hours} * * ${form.daysOfWeek.join(',')}`;
      case 'custom':
        return form.cronExpression;
      default:
        return `${minutes} ${hours} * * *`;
    }
  };

  return (
    <div className="modal-overlay">
      <div className="create-schedule-modal">
        <h3>{editSchedule ? 'Edit Schedule' : 'New Schedule'}</h3>

        <div className="form-group">
          <label>Name</label>
          <input
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
            <PlaylistSelector
              value={form.targetId}
              onChange={id => setForm({ ...form, targetId: id })}
            />
          </div>
        )}

        <div className="form-group">
          <label>Schedule</label>
          <div className="schedule-options">
            <label>
              <input
                type="radio"
                checked={form.scheduleType === 'daily'}
                onChange={() => setForm({ ...form, scheduleType: 'daily' })}
              />
              Daily
            </label>
            <label>
              <input
                type="radio"
                checked={form.scheduleType === 'weekly'}
                onChange={() => setForm({ ...form, scheduleType: 'weekly' })}
              />
              Weekly
            </label>
            <label>
              <input
                type="radio"
                checked={form.scheduleType === 'custom'}
                onChange={() => setForm({ ...form, scheduleType: 'custom' })}
              />
              Custom (Cron)
            </label>
          </div>
        </div>

        <div className="form-group">
          <label>Time</label>
          <input
            type="time"
            value={form.time}
            onChange={e => setForm({ ...form, time: e.target.value })}
          />
        </div>

        {form.scheduleType === 'weekly' && (
          <div className="form-group">
            <label>Days</label>
            <DaySelector
              value={form.daysOfWeek}
              onChange={days => setForm({ ...form, daysOfWeek: days })}
            />
          </div>
        )}

        <div className="form-group">
          <label>
            <input
              type="checkbox"
              checked={form.newTracksOnly}
              onChange={e => setForm({ ...form, newTracksOnly: e.target.checked })}
            />
            Download new tracks only
          </label>
        </div>

        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
          <button onClick={() => onSave({ ...form, cronExpression: generateCronExpression() })}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
```

### Data Storage

#### schedules.json

```json
{
  "schedules": [
    {
      "id": "sch_abc123",
      "name": "Daily Top Hits Sync",
      "type": "playlist",
      "targetId": "37i9dQZF1DXcBWIGoYBM5M",
      "targetName": "Today's Top Hits",
      "cronExpression": "0 3 * * *",
      "timezone": "Europe/Istanbul",
      "newTracksOnly": true,
      "enabled": true,
      "createdAt": 1704067200000,
      "lastRunAt": 1704153600000,
      "lastRunStatus": "success",
      "nextRunAt": 1704240000000
    }
  ],
  "executionHistory": [
    {
      "scheduleId": "sch_abc123",
      "scheduleName": "Daily Top Hits Sync",
      "startedAt": 1704153600000,
      "completedAt": 1704153650000,
      "status": "completed",
      "tracksAdded": 5,
      "error": null
    }
  ]
}
```

## UI Design

### Schedules List

```
┌─────────────────────────────────────────────────────────────────┐
│  ⏰ Scheduled Downloads                         [New Schedule]  │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ ✅ Daily Top Hits Sync                                   │    │
│  │    📚 Today's Top Hits • New tracks only                │    │
│  │    🕐 Every day at 03:00                                │    │
│  │    ✓ Last run: 2 hours ago (5 tracks)                   │    │
│  │    → Next run: Tomorrow at 03:00                        │    │
│  │                                    [Run Now] [Edit] [🗑️] │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ ⏸️ Weekly Full Sync (disabled)                          │    │
│  │    🔄 Sync All Saved Playlists                          │    │
│  │    🕐 Every Sunday at 02:00                             │    │
│  │    ✗ Last run: Failed (connection error)                │    │
│  │                                    [Run Now] [Edit] [🗑️] │    │
│  └─────────────────────────────────────────────────────────┘    │
├─────────────────────────────────────────────────────────────────┤
│  📜 Recent Executions                                           │
│  ───────────────────────────────────────────────────────────    │
│  ✅ Daily Top Hits Sync     5 tracks    2 hours ago             │
│  ✅ Daily Top Hits Sync     3 tracks    Yesterday               │
│  ❌ Weekly Full Sync        Failed      2 days ago              │
│  ✅ Daily Top Hits Sync     0 tracks    3 days ago              │
└─────────────────────────────────────────────────────────────────┘
```

## Common Cron Expressions

| Schedule                            | Cron Expression |
|-------------------------------------|-----------------|
| Every day at 3 AM                   | `0 3 * * *`     |
| Every Sunday at 2 AM                | `0 2 * * 0`     |
| Every 6 hours                       | `0 */6 * * *`   |
| Every Monday and Friday at midnight | `0 0 * * 1,5`   |
| First day of month at 4 AM          | `0 4 1 * *`     |

## Testing

1. Create schedules with different intervals
2. Verify cron jobs start/stop correctly
3. Test manual "Run Now" execution
4. Verify execution history is recorded
5. Test schedule enable/disable
6. Verify persistence after restart
7. Test error handling for failed downloads

## Future Enhancements

- Notification on schedule completion
- Retry failed schedules
- Schedule templates
- Import/export schedules
- Schedule dependencies (run B after A)
- Bandwidth/time limits (don't run during peak hours)
