# Download Statistics Feature

**Branch:** `feature/download-statistics`

## Overview

Add comprehensive download statistics tracking and visualization to the Web UI, showing download history, trends, and insights. Uses SQLite for efficient data storage and fast queries.

## Features

### 1. Statistics Dashboard

- Total tracks downloaded (all time)
- Total download size (MB/GB)
- Total playback duration downloaded
- Average tracks per day/week
- Success rate (completed vs failed/skipped)

### 2. Time-based Analytics

- Daily download count chart (last 30 days)
- Weekly summary chart (last 12 weeks)
- Monthly summary chart (last 12 months)
- Peak download hours heatmap

### 3. Top Lists

- Top 10 most downloaded artists
- Top 10 most downloaded albums
- Top 10 most downloaded genres (if available from Spotify metadata)
- Recent downloads list with timestamps

### 4. Export Options

- Export statistics as JSON
- Export statistics as CSV
- Share statistics image (optional)

## Technical Implementation

### Backend Changes

#### New Dependencies

```bash
cd soggfy-web/backend
npm install better-sqlite3
```

#### New Files

```
soggfy-web/backend/
├── statsManager.js      # Statistics tracking and aggregation
├── stats.db             # SQLite database (auto-created)
```

#### Database Schema

```sql
-- Downloads table: stores every download record
CREATE TABLE IF NOT EXISTS downloads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    track_id TEXT NOT NULL,
    name TEXT NOT NULL,
    artist TEXT NOT NULL,
    album TEXT,
    duration INTEGER DEFAULT 0,
    size INTEGER DEFAULT 0,
    status TEXT NOT NULL,
    timestamp INTEGER NOT NULL
);

-- Indexes for fast queries
CREATE INDEX IF NOT EXISTS idx_downloads_timestamp ON downloads(timestamp);
CREATE INDEX IF NOT EXISTS idx_downloads_artist ON downloads(artist);
CREATE INDEX IF NOT EXISTS idx_downloads_album ON downloads(album);
CREATE INDEX IF NOT EXISTS idx_downloads_status ON downloads(status);

-- Totals cache table: avoids full table scans for aggregate stats
CREATE TABLE IF NOT EXISTS totals (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    count INTEGER DEFAULT 0,
    size INTEGER DEFAULT 0,
    duration INTEGER DEFAULT 0,
    completed INTEGER DEFAULT 0,
    failed INTEGER DEFAULT 0,
    skipped INTEGER DEFAULT 0
);

-- Initialize totals row
INSERT OR IGNORE INTO totals (id) VALUES (1);
```

#### statsManager.js

```javascript
const Database = require('better-sqlite3');
const path = require('path');

class StatsManager {
    constructor(dbPath) {
        this.db = new Database(dbPath);
        this.db.pragma('journal_mode = WAL'); // Better concurrent access
        this.initDatabase();
        this.prepareStatements();
    }

    initDatabase() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS downloads (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                track_id TEXT NOT NULL,
                name TEXT NOT NULL,
                artist TEXT NOT NULL,
                album TEXT,
                duration INTEGER DEFAULT 0,
                size INTEGER DEFAULT 0,
                status TEXT NOT NULL,
                timestamp INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_downloads_timestamp ON downloads(timestamp);
            CREATE INDEX IF NOT EXISTS idx_downloads_artist ON downloads(artist);
            CREATE INDEX IF NOT EXISTS idx_downloads_album ON downloads(album);
            CREATE INDEX IF NOT EXISTS idx_downloads_status ON downloads(status);

            CREATE TABLE IF NOT EXISTS totals (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                count INTEGER DEFAULT 0,
                size INTEGER DEFAULT 0,
                duration INTEGER DEFAULT 0,
                completed INTEGER DEFAULT 0,
                failed INTEGER DEFAULT 0,
                skipped INTEGER DEFAULT 0
            );

            INSERT OR IGNORE INTO totals (id) VALUES (1);
        `);
    }

    prepareStatements() {
        // Prepared statements for better performance
        this.stmts = {
            insertDownload: this.db.prepare(`
                INSERT INTO downloads (track_id, name, artist, album, duration, size, status, timestamp)
                VALUES (@trackId, @name, @artist, @album, @duration, @size, @status, @timestamp)
            `),
            updateTotals: this.db.prepare(`
                UPDATE totals SET
                    count = count + 1,
                    size = size + @size,
                    duration = duration + @duration,
                    completed = completed + @completed,
                    failed = failed + @failed,
                    skipped = skipped + @skipped
                WHERE id = 1
            `),
            getTotals: this.db.prepare(`SELECT * FROM totals WHERE id = 1`),
            getTopArtists: this.db.prepare(`
                SELECT artist, COUNT(*) as count, SUM(duration) as totalDuration
                FROM downloads
                WHERE status = 'completed'
                GROUP BY artist
                ORDER BY count DESC
                LIMIT ?
            `),
            getTopAlbums: this.db.prepare(`
                SELECT album, artist, COUNT(*) as count
                FROM downloads
                WHERE status = 'completed' AND album IS NOT NULL
                GROUP BY album, artist
                ORDER BY count DESC
                LIMIT ?
            `),
            getRecentDownloads: this.db.prepare(`
                SELECT track_id, name, artist, album, duration, size, status, timestamp
                FROM downloads
                ORDER BY timestamp DESC
                LIMIT ?
            `),
            getDownloadsAfter: this.db.prepare(`
                SELECT COUNT(*) as count, SUM(size) as size, SUM(duration) as duration
                FROM downloads
                WHERE timestamp >= ? AND status = 'completed'
            `),
            getDailyStats: this.db.prepare(`
                SELECT 
                    date(timestamp / 1000, 'unixepoch', 'localtime') as date,
                    COUNT(*) as count,
                    SUM(size) as size
                FROM downloads
                WHERE timestamp >= ? AND status = 'completed'
                GROUP BY date
                ORDER BY date ASC
            `),
            getHourlyStats: this.db.prepare(`
                SELECT 
                    strftime('%H', timestamp / 1000, 'unixepoch', 'localtime') as hour,
                    COUNT(*) as count
                FROM downloads
                WHERE status = 'completed'
                GROUP BY hour
                ORDER BY hour ASC
            `),
            searchDownloads: this.db.prepare(`
                SELECT track_id, name, artist, album, timestamp
                FROM downloads
                WHERE name LIKE ? OR artist LIKE ? OR album LIKE ?
                ORDER BY timestamp DESC
                LIMIT ?
            `)
        };
    }

    // Track a completed download
    trackDownload(track) {
        const params = {
            trackId: track.id,
            name: track.name,
            artist: track.artist,
            album: track.album || null,
            duration: track.duration || 0,
            size: track.fileSize || 0,
            status: track.status,
            timestamp: Date.now()
        };

        const totalsUpdate = {
            size: params.size,
            duration: params.duration,
            completed: params.status === 'completed' ? 1 : 0,
            failed: params.status === 'error' ? 1 : 0,
            skipped: params.status === 'skipped' ? 1 : 0
        };

        // Transaction for atomic insert + update
        const transaction = this.db.transaction(() => {
            this.stmts.insertDownload.run(params);
            this.stmts.updateTotals.run(totalsUpdate);
        });

        transaction();
    }

    // Get all statistics
    getStats() {
        const totals = this.stmts.getTotals.get();
        const now = Date.now();

        return {
            totals: {
                count: totals.count,
                size: totals.size,
                duration: totals.duration,
                completed: totals.completed,
                failed: totals.failed,
                skipped: totals.skipped,
                successRate: totals.count > 0 
                    ? Math.round((totals.completed / totals.count) * 100) 
                    : 100
            },
            today: this.stmts.getDownloadsAfter.get(now - 24 * 60 * 60 * 1000),
            thisWeek: this.stmts.getDownloadsAfter.get(now - 7 * 24 * 60 * 60 * 1000),
            thisMonth: this.stmts.getDownloadsAfter.get(now - 30 * 24 * 60 * 60 * 1000),
            topArtists: this.getTopArtists(10),
            topAlbums: this.getTopAlbums(10),
            dailyChart: this.getDailyChart(30),
            hourlyHeatmap: this.getHourlyHeatmap(),
            recentDownloads: this.getRecentDownloads(20)
        };
    }

    // Get totals only (fast)
    getTotals() {
        const totals = this.stmts.getTotals.get();
        return {
            count: totals.count,
            size: totals.size,
            duration: totals.duration,
            completed: totals.completed,
            failed: totals.failed,
            skipped: totals.skipped,
            successRate: totals.count > 0 
                ? Math.round((totals.completed / totals.count) * 100) 
                : 100
        };
    }

    // Get top artists
    getTopArtists(limit = 10) {
        return this.stmts.getTopArtists.all(limit);
    }

    // Get top albums
    getTopAlbums(limit = 10) {
        return this.stmts.getTopAlbums.all(limit);
    }

    // Get recent downloads
    getRecentDownloads(limit = 20) {
        return this.stmts.getRecentDownloads.all(limit).map(row => ({
            id: row.track_id,
            name: row.name,
            artist: row.artist,
            album: row.album,
            duration: row.duration,
            size: row.size,
            status: row.status,
            timestamp: row.timestamp
        }));
    }

    // Get daily chart data
    getDailyChart(days = 30) {
        const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
        const rows = this.stmts.getDailyStats.all(cutoff);

        // Fill in missing days with zero counts
        const chart = [];
        const rowMap = new Map(rows.map(r => [r.date, r]));
        const now = new Date();

        for (let i = days - 1; i >= 0; i--) {
            const date = new Date(now);
            date.setDate(date.getDate() - i);
            const dateStr = date.toISOString().split('T')[0];
            const row = rowMap.get(dateStr);

            chart.push({
                date: dateStr,
                count: row?.count || 0,
                size: row?.size || 0
            });
        }

        return chart;
    }

    // Get weekly chart data
    getWeeklyChart(weeks = 12) {
        const cutoff = Date.now() - (weeks * 7 * 24 * 60 * 60 * 1000);
        const rows = this.db.prepare(`
            SELECT 
                strftime('%Y-%W', timestamp / 1000, 'unixepoch', 'localtime') as week,
                COUNT(*) as count,
                SUM(size) as size
            FROM downloads
            WHERE timestamp >= ? AND status = 'completed'
            GROUP BY week
            ORDER BY week ASC
        `).all(cutoff);

        return rows;
    }

    // Get monthly chart data
    getMonthlyChart(months = 12) {
        const cutoff = Date.now() - (months * 30 * 24 * 60 * 60 * 1000);
        const rows = this.db.prepare(`
            SELECT 
                strftime('%Y-%m', timestamp / 1000, 'unixepoch', 'localtime') as month,
                COUNT(*) as count,
                SUM(size) as size
            FROM downloads
            WHERE timestamp >= ? AND status = 'completed'
            GROUP BY month
            ORDER BY month ASC
        `).all(cutoff);

        return rows;
    }

    // Get hourly heatmap (for peak hours)
    getHourlyHeatmap() {
        return this.stmts.getHourlyStats.all();
    }

    // Search downloads
    searchDownloads(query, limit = 50) {
        const pattern = `%${query}%`;
        return this.stmts.searchDownloads.all(pattern, pattern, pattern, limit);
    }

    // Export as JSON
    exportJSON() {
        const downloads = this.db.prepare(`
            SELECT track_id, name, artist, album, duration, size, status, timestamp
            FROM downloads
            ORDER BY timestamp DESC
        `).all();

        return {
            exportedAt: new Date().toISOString(),
            totals: this.getTotals(),
            downloads
        };
    }

    // Export as CSV
    exportCSV() {
        const downloads = this.db.prepare(`
            SELECT track_id, name, artist, album, duration, size, status, 
                   datetime(timestamp / 1000, 'unixepoch', 'localtime') as date
            FROM downloads
            ORDER BY timestamp DESC
        `).all();

        const headers = ['Track ID', 'Name', 'Artist', 'Album', 'Duration (ms)', 'Size (bytes)', 'Status', 'Date'];
        const rows = downloads.map(d => [
            d.track_id,
            `"${d.name.replace(/"/g, '""')}"`,
            `"${d.artist.replace(/"/g, '""')}"`,
            `"${(d.album || '').replace(/"/g, '""')}"`,
            d.duration,
            d.size,
            d.status,
            d.date
        ]);

        return [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    }

    // Reset all statistics
    reset() {
        const transaction = this.db.transaction(() => {
            this.db.exec('DELETE FROM downloads');
            this.db.exec('UPDATE totals SET count=0, size=0, duration=0, completed=0, failed=0, skipped=0 WHERE id=1');
        });
        transaction();
    }

    // Close database connection
    close() {
        this.db.close();
    }
}

module.exports = StatsManager;
```

#### API Endpoints

| Method | Endpoint                    | Description                           |
|--------|-----------------------------|---------------------------------------|
| GET    | `/api/stats`                | Get all statistics                    |
| GET    | `/api/stats/totals`         | Get totals only (fast)                |
| GET    | `/api/stats/chart/daily`    | Get daily chart (last 30 days)        |
| GET    | `/api/stats/chart/weekly`   | Get weekly chart (last 12 weeks)      |
| GET    | `/api/stats/chart/monthly`  | Get monthly chart (last 12 months)    |
| GET    | `/api/stats/top/artists`    | Get top artists                       |
| GET    | `/api/stats/top/albums`     | Get top albums                        |
| GET    | `/api/stats/recent`         | Get recent downloads                  |
| GET    | `/api/stats/search`         | Search downloads                      |
| GET    | `/api/stats/export/json`    | Export as JSON                        |
| GET    | `/api/stats/export/csv`     | Export as CSV                         |
| DELETE | `/api/stats/reset`          | Reset all statistics                  |

#### server.js Integration

```javascript
const StatsManager = require('./statsManager');
const path = require('path');

// Initialize stats manager
const statsDbPath = path.join(process.env.LOCALAPPDATA || '.', 'Soggfy', 'stats.db');
const stats = new StatsManager(statsDbPath);

// API Routes
app.get('/api/stats', authMiddleware, (req, res) => {
    res.json(stats.getStats());
});

app.get('/api/stats/totals', authMiddleware, (req, res) => {
    res.json(stats.getTotals());
});

app.get('/api/stats/chart/:period', authMiddleware, (req, res) => {
    const { period } = req.params;
    switch (period) {
        case 'daily':
            res.json(stats.getDailyChart(30));
            break;
        case 'weekly':
            res.json(stats.getWeeklyChart(12));
            break;
        case 'monthly':
            res.json(stats.getMonthlyChart(12));
            break;
        default:
            res.status(400).json({ error: 'Invalid period' });
    }
});

app.get('/api/stats/top/:type', authMiddleware, (req, res) => {
    const { type } = req.params;
    const limit = parseInt(req.query.limit) || 10;

    switch (type) {
        case 'artists':
            res.json(stats.getTopArtists(limit));
            break;
        case 'albums':
            res.json(stats.getTopAlbums(limit));
            break;
        default:
            res.status(400).json({ error: 'Invalid type' });
    }
});

app.get('/api/stats/recent', authMiddleware, (req, res) => {
    const limit = parseInt(req.query.limit) || 20;
    res.json(stats.getRecentDownloads(limit));
});

app.get('/api/stats/search', authMiddleware, (req, res) => {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: 'Query required' });
    res.json(stats.searchDownloads(q));
});

app.get('/api/stats/export/:format', authMiddleware, (req, res) => {
    const { format } = req.params;

    switch (format) {
        case 'json':
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Content-Disposition', 'attachment; filename=soggfy-stats.json');
            res.json(stats.exportJSON());
            break;
        case 'csv':
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', 'attachment; filename=soggfy-stats.csv');
            res.send(stats.exportCSV());
            break;
        default:
            res.status(400).json({ error: 'Invalid format' });
    }
});

app.delete('/api/stats/reset', authMiddleware, (req, res) => {
    stats.reset();
    res.json({ success: true });
});

// Track download in queueManager
// In queueManager.js, after a track completes:
stats.trackDownload({
    id: track.id,
    name: track.name,
    artist: track.artist,
    album: track.album,
    duration: track.duration,
    fileSize: track.fileSize,
    status: track.status // 'completed', 'error', 'skipped'
});
```

### Frontend Changes

#### New Dependencies

```bash
cd soggfy-web/frontend
npm install chart.js react-chartjs-2
```

#### New Components

```
soggfy-web/frontend/src/components/
├── Statistics/
│   ├── Statistics.jsx       # Main statistics page/modal
│   ├── Statistics.css       # Styles
│   ├── StatsCard.jsx        # Individual stat card
│   ├── DownloadChart.jsx    # Line/bar chart component
│   ├── TopList.jsx          # Top artists/albums list
│   ├── HourlyHeatmap.jsx    # Peak hours heatmap
│   └── RecentDownloads.jsx  # Recent downloads table
```

#### Statistics.jsx Structure

```jsx
import { useState, useEffect } from 'react';
import axios from 'axios';
import { Line, Bar } from 'react-chartjs-2';
import StatsCard from './StatsCard';
import TopList from './TopList';
import RecentDownloads from './RecentDownloads';
import './Statistics.css';

function Statistics({ onClose }) {
    const [stats, setStats] = useState(null);
    const [chartPeriod, setChartPeriod] = useState('daily');
    const [chartData, setChartData] = useState(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        fetchStats();
    }, []);

    useEffect(() => {
        fetchChartData(chartPeriod);
    }, [chartPeriod]);

    const fetchStats = async () => {
        try {
            const response = await axios.get(`${API_BASE}/stats`);
            setStats(response.data);
        } catch (error) {
            console.error('Failed to fetch stats:', error);
        } finally {
            setLoading(false);
        }
    };

    const fetchChartData = async (period) => {
        try {
            const response = await axios.get(`${API_BASE}/stats/chart/${period}`);
            setChartData(response.data);
        } catch (error) {
            console.error('Failed to fetch chart:', error);
        }
    };

    const handleExport = async (format) => {
        window.open(`${API_BASE}/stats/export/${format}`, '_blank');
    };

    const handleReset = async () => {
        if (!confirm('Are you sure you want to reset all statistics? This cannot be undone.')) {
            return;
        }
        await axios.delete(`${API_BASE}/stats/reset`);
        fetchStats();
    };

    const formatSize = (bytes) => {
        if (bytes >= 1e9) return (bytes / 1e9).toFixed(2) + ' GB';
        if (bytes >= 1e6) return (bytes / 1e6).toFixed(2) + ' MB';
        return (bytes / 1e3).toFixed(2) + ' KB';
    };

    const formatDuration = (ms) => {
        const hours = Math.floor(ms / 3600000);
        const minutes = Math.floor((ms % 3600000) / 60000);
        if (hours > 0) return `${hours}h ${minutes}m`;
        return `${minutes}m`;
    };

    if (loading) {
        return <div className="statistics-loading">Loading statistics...</div>;
    }

    return (
        <div className="statistics-overlay">
            <div className="statistics-modal">
                <header>
                    <h2>Download Statistics</h2>
                    <div className="header-actions">
                        <button onClick={() => handleExport('json')}>Export JSON</button>
                        <button onClick={() => handleExport('csv')}>Export CSV</button>
                        <button onClick={onClose} className="close-btn">×</button>
                    </div>
                </header>

                <div className="stats-grid">
                    <StatsCard 
                        title="Total Downloads" 
                        value={stats.totals.count.toLocaleString()} 
                        icon="📥" 
                    />
                    <StatsCard 
                        title="Total Size" 
                        value={formatSize(stats.totals.size)} 
                        icon="💾" 
                    />
                    <StatsCard 
                        title="Total Duration" 
                        value={formatDuration(stats.totals.duration)} 
                        icon="⏱️" 
                    />
                    <StatsCard 
                        title="Success Rate" 
                        value={`${stats.totals.successRate}%`} 
                        icon="✅" 
                    />
                </div>

                <div className="period-stats">
                    <div className="period-card">
                        <h4>Today</h4>
                        <span>{stats.today.count} tracks</span>
                    </div>
                    <div className="period-card">
                        <h4>This Week</h4>
                        <span>{stats.thisWeek.count} tracks</span>
                    </div>
                    <div className="period-card">
                        <h4>This Month</h4>
                        <span>{stats.thisMonth.count} tracks</span>
                    </div>
                </div>

                <div className="chart-section">
                    <div className="chart-header">
                        <h3>Downloads Over Time</h3>
                        <div className="period-selector">
                            <button 
                                className={chartPeriod === 'daily' ? 'active' : ''}
                                onClick={() => setChartPeriod('daily')}
                            >
                                Daily
                            </button>
                            <button 
                                className={chartPeriod === 'weekly' ? 'active' : ''}
                                onClick={() => setChartPeriod('weekly')}
                            >
                                Weekly
                            </button>
                            <button 
                                className={chartPeriod === 'monthly' ? 'active' : ''}
                                onClick={() => setChartPeriod('monthly')}
                            >
                                Monthly
                            </button>
                        </div>
                    </div>
                    {chartData && (
                        <Line
                            data={{
                                labels: chartData.map(d => d.date || d.week || d.month),
                                datasets: [{
                                    label: 'Downloads',
                                    data: chartData.map(d => d.count),
                                    borderColor: '#1ed760',
                                    backgroundColor: 'rgba(30, 215, 96, 0.1)',
                                    fill: true,
                                    tension: 0.4
                                }]
                            }}
                            options={{
                                responsive: true,
                                plugins: {
                                    legend: { display: false }
                                },
                                scales: {
                                    y: { beginAtZero: true }
                                }
                            }}
                        />
                    )}
                </div>

                <div className="lists-section">
                    <TopList title="Top Artists" items={stats.topArtists} labelKey="artist" />
                    <TopList title="Top Albums" items={stats.topAlbums} labelKey="album" />
                </div>

                <RecentDownloads downloads={stats.recentDownloads} />

                <footer>
                    <button onClick={handleReset} className="danger">Reset Statistics</button>
                </footer>
            </div>
        </div>
    );
}

export default Statistics;
```

### Data Storage

**Location:** `%localappdata%/Soggfy/stats.db` (SQLite database)

**Why SQLite over JSON?**

| Feature              | JSON File                     | SQLite                          |
|----------------------|-------------------------------|----------------------------------|
| Query speed          | O(n) - scan entire array      | O(log n) - indexed queries       |
| Memory usage         | Loads all data into RAM       | On-demand disk access            |
| Concurrent access    | Risk of corruption            | ACID transactions                |
| Aggregation          | Manual JS loops               | Native SQL (SUM, COUNT, GROUP BY)|
| Data size limit      | ~100MB practical limit        | Terabytes                        |
| Search               | Linear scan                   | Indexed full-text search         |

**Database Size Estimate:**
- 1 download record ~200 bytes
- 10,000 downloads ~2 MB
- 100,000 downloads ~20 MB

## UI Design

### Stats Cards

```
┌─────────────────────────────────────────────────────────────┐
│  📥 Total Downloads    💾 Total Size    ⏱️ Duration    ✅ Rate │
│     1,523                8.5 GB          96 hours       98%  │
└─────────────────────────────────────────────────────────────┘
```

### Period Summary

```
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│    Today     │  │  This Week   │  │  This Month  │
│   12 tracks  │  │   89 tracks  │  │  342 tracks  │
└──────────────┘  └──────────────┘  └──────────────┘
```

### Chart Section

```
┌─────────────────────────────────────────────────────────────┐
│  Downloads Over Time              [Daily] [Weekly] [Monthly] │
│                                                              │
│  50 ┤                        ╭─╮                             │
│  40 ┤              ╭─╮      ╭╯ ╰╮    ╭─╮                     │
│  30 ┤         ╭───╯  ╰─╮   ╭╯   ╰────╯ ╰╮                    │
│  20 ┤    ╭───╯        ╰───╯             ╰─╮                  │
│  10 ┼───╯                                  ╰───              │
│   0 ┼─────────────────────────────────────────               │
│     Jan 1    Jan 8    Jan 15   Jan 22   Jan 29              │
└─────────────────────────────────────────────────────────────┘
```

### Top Lists

```
┌──────────────────────────┐  ┌──────────────────────────┐
│  🎤 Top Artists          │  │  💿 Top Albums           │
├──────────────────────────┤  ├──────────────────────────┤
│  1. Queen          (125) │  │  1. Abbey Road     (45)  │
│  2. Led Zeppelin    (98) │  │  2. Thriller       (38)  │
│  3. Pink Floyd      (76) │  │  3. Dark Side...   (32)  │
│  4. The Beatles     (65) │  │  4. Rumours        (28)  │
│  5. AC/DC           (54) │  │  5. Back in Black  (25)  │
└──────────────────────────┘  └──────────────────────────┘
```

## Integration Points

1. **queueManager.js**: Call `stats.trackDownload()` when a track completes/fails/skips
2. **server.js**: Add `/api/stats/*` routes with auth middleware
3. **App.jsx**: Add "Statistics" button in header, open Statistics modal

## Testing

1. Download multiple tracks from different artists
2. Verify counts increment correctly in real-time
3. Check chart displays correct data for all periods
4. Verify top lists update properly
5. Test export functionality (JSON/CSV)
6. Test search functionality
7. Verify persistence after server restart
8. Test with large datasets (1000+ downloads)
9. Test reset functionality

## Performance Considerations

- **Prepared statements**: All frequent queries use prepared statements
- **WAL mode**: Enables concurrent reads during writes
- **Indexed columns**: timestamp, artist, album, status
- **Totals cache**: Avoids COUNT(*) on large tables
- **Pagination**: Recent downloads limited by default

## Future Enhancements

- Genre-based statistics (requires Spotify API calls)
- Comparison with previous periods ("20% more than last week")
- Download speed tracking
- Storage location breakdown
- Shareable statistics cards/images
- Real-time WebSocket updates for live stats
