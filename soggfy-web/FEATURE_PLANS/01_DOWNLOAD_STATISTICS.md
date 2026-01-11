# Download Statistics Feature

**Branch:** `feature/download-statistics`

## Overview

Add comprehensive download statistics tracking and visualization to the Web UI, showing download history, trends, and insights.

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

#### New Files

```
soggfy-web/backend/
├── statsManager.js      # Statistics tracking and aggregation
├── statsDb.json         # Persistent storage for stats
```

#### statsManager.js

```javascript
class StatsManager {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.stats = this.load();
  }

  // Track a completed download
  trackDownload(track) {
    const entry = {
      id: track.id,
      name: track.name,
      artist: track.artist,
      album: track.album,
      duration: track.duration,
      size: track.fileSize || 0,
      status: track.status,
      timestamp: Date.now()
    };
    
    this.stats.downloads.push(entry);
    this.stats.totals.count++;
    this.stats.totals.duration += track.duration || 0;
    this.stats.totals.size += track.fileSize || 0;
    
    this.updateArtistStats(track.artist);
    this.save();
  }

  // Get aggregated statistics
  getStats() {
    return {
      totals: this.stats.totals,
      today: this.getDownloadsForPeriod(1),
      thisWeek: this.getDownloadsForPeriod(7),
      thisMonth: this.getDownloadsForPeriod(30),
      topArtists: this.getTopArtists(10),
      topAlbums: this.getTopAlbums(10),
      dailyChart: this.getDailyChart(30),
      recentDownloads: this.getRecentDownloads(20)
    };
  }

  // Get downloads for last N days
  getDownloadsForPeriod(days) {
    const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
    return this.stats.downloads.filter(d => d.timestamp >= cutoff);
  }

  // Get top artists by download count
  getTopArtists(limit) {
    const artistCounts = {};
    this.stats.downloads.forEach(d => {
      artistCounts[d.artist] = (artistCounts[d.artist] || 0) + 1;
    });
    return Object.entries(artistCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([artist, count]) => ({ artist, count }));
  }

  // Get daily download counts for chart
  getDailyChart(days) {
    const chart = [];
    const now = new Date();
    
    for (let i = days - 1; i >= 0; i--) {
      const date = new Date(now);
      date.setDate(date.getDate() - i);
      const dayStart = new Date(date.setHours(0, 0, 0, 0)).getTime();
      const dayEnd = new Date(date.setHours(23, 59, 59, 999)).getTime();
      
      const count = this.stats.downloads.filter(
        d => d.timestamp >= dayStart && d.timestamp <= dayEnd
      ).length;
      
      chart.push({
        date: date.toISOString().split('T')[0],
        count
      });
    }
    return chart;
  }
}
```

#### API Endpoints

| Method | Endpoint                    | Description                           |
|--------|-----------------------------|---------------------------------------|
| GET    | `/api/stats`                | Get all statistics                    |
| GET    | `/api/stats/totals`         | Get totals only                       |
| GET    | `/api/stats/chart/:period`  | Get chart data (daily/weekly/monthly) |
| GET    | `/api/stats/top/:type`      | Get top artists/albums/genres         |
| GET    | `/api/stats/export/:format` | Export as JSON/CSV                    |
| DELETE | `/api/stats/reset`          | Reset all statistics                  |

### Frontend Changes

#### New Components

```
soggfy-web/frontend/src/components/
├── Statistics/
│   ├── Statistics.jsx       # Main statistics page/modal
│   ├── Statistics.css       # Styles
│   ├── StatsCard.jsx        # Individual stat card
│   ├── DownloadChart.jsx    # Line/bar chart component
│   ├── TopList.jsx          # Top artists/albums list
│   └── RecentDownloads.jsx  # Recent downloads table
```

#### Statistics.jsx Structure

```jsx
function Statistics({ onClose }) {
  const [stats, setStats] = useState(null);
  const [period, setPeriod] = useState('month');

  return (
    <div className="statistics-overlay">
      <div className="statistics-modal">
        <header>
          <h2>Download Statistics</h2>
          <button onClick={onClose}>×</button>
        </header>

        <div className="stats-grid">
          <StatsCard title="Total Downloads" value={stats.totals.count} icon="📥" />
          <StatsCard title="Total Size" value={formatSize(stats.totals.size)} icon="💾" />
          <StatsCard title="Total Duration" value={formatDuration(stats.totals.duration)} icon="⏱️" />
          <StatsCard title="Success Rate" value={`${stats.successRate}%`} icon="✅" />
        </div>

        <div className="chart-section">
          <div className="period-selector">
            <button onClick={() => setPeriod('week')}>Week</button>
            <button onClick={() => setPeriod('month')}>Month</button>
            <button onClick={() => setPeriod('year')}>Year</button>
          </div>
          <DownloadChart data={stats.dailyChart} period={period} />
        </div>

        <div className="lists-section">
          <TopList title="Top Artists" items={stats.topArtists} />
          <TopList title="Top Albums" items={stats.topAlbums} />
        </div>

        <RecentDownloads downloads={stats.recentDownloads} />
      </div>
    </div>
  );
}
```

### Chart Library

Use **Chart.js** with **react-chartjs-2** for visualizations:

```bash
cd soggfy-web/frontend
npm install chart.js react-chartjs-2
```

### Data Persistence

Statistics stored in `%localappdata%/Soggfy/web-stats.json`:

```json
{
  "totals": {
    "count": 1523,
    "size": 8547123456,
    "duration": 345600000,
    "completed": 1500,
    "failed": 15,
    "skipped": 8
  },
  "downloads": [
    {
      "id": "spotify:track:xxx",
      "name": "Song Name",
      "artist": "Artist Name",
      "album": "Album Name",
      "duration": 234000,
      "size": 5600000,
      "status": "completed",
      "timestamp": 1704067200000
    }
  ],
  "artistStats": {
    "Artist Name": { "count": 45, "totalDuration": 12345000 }
  }
}
```

## UI Design

### Stats Cards

```
┌─────────────────────────────────────────────────────────────┐
│  📥 Total Downloads    💾 Total Size    ⏱️ Duration    ✅ Rate │
│     1,523                8.5 GB          96 hours       98%  │
└─────────────────────────────────────────────────────────────┘
```

### Chart Section

```
┌─────────────────────────────────────────────────────────────┐
│  Downloads Over Time                    [Week] [Month] [Year] │
│  ▁▂▃▅▇█▆▄▃▂▁▂▃▄▅▆▇█▇▆▅▄▃▂▁▂▃▄▅▆▇        (line chart)        │
└─────────────────────────────────────────────────────────────┘
```

### Top Lists

```
┌──────────────────────────┐  ┌──────────────────────────┐
│  🎤 Top Artists          │  │  💿 Top Albums           │
│  1. Artist A      (125)  │  │  1. Album X       (45)   │
│  2. Artist B       (98)  │  │  2. Album Y       (38)   │
│  3. Artist C       (76)  │  │  3. Album Z       (32)   │
└──────────────────────────┘  └──────────────────────────┘
```

## Integration Points

1. **queueManager.js**: Call `statsManager.trackDownload()` when a track completes
2. **server.js**: Add `/api/stats` routes
3. **App.jsx**: Add "Statistics" button in header, open Statistics modal

## Testing

1. Download multiple tracks from different artists
2. Verify counts increment correctly
3. Check chart displays correct daily data
4. Verify top lists update properly
5. Test export functionality
6. Test persistence after server restart

## Future Enhancements

- Genre-based statistics (requires Spotify API calls)
- Comparison with previous periods
- Download speed tracking
- Storage location breakdown
- Shareable statistics cards
