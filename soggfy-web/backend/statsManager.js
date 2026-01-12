const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

class StatsManager {
    constructor(dbPath) {
        const dbDir = path.dirname(dbPath);
        if (!fs.existsSync(dbDir)) {
            fs.mkdirSync(dbDir, { recursive: true });
        }

        this.db = new Database(dbPath);
        this.db.pragma('journal_mode = WAL');
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
                SELECT COUNT(*) as count, COALESCE(SUM(size), 0) as size, COALESCE(SUM(duration), 0) as duration
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
            getWeeklyStats: this.db.prepare(`
                SELECT 
                    strftime('%Y-%W', timestamp / 1000, 'unixepoch', 'localtime') as week,
                    COUNT(*) as count,
                    SUM(size) as size
                FROM downloads
                WHERE timestamp >= ? AND status = 'completed'
                GROUP BY week
                ORDER BY week ASC
            `),
            getMonthlyStats: this.db.prepare(`
                SELECT 
                    strftime('%Y-%m', timestamp / 1000, 'unixepoch', 'localtime') as month,
                    COUNT(*) as count,
                    SUM(size) as size
                FROM downloads
                WHERE timestamp >= ? AND status = 'completed'
                GROUP BY month
                ORDER BY month ASC
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

        this.insertTransaction = this.db.transaction((params, totalsUpdate) => {
            this.stmts.insertDownload.run(params);
            this.stmts.updateTotals.run(totalsUpdate);
        });
    }

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

        this.insertTransaction(params, totalsUpdate);
    }

    getStats() {
        const totals = this.getTotals();
        const now = Date.now();

        return {
            totals,
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

    getTopArtists(limit = 10) {
        return this.stmts.getTopArtists.all(limit);
    }

    getTopAlbums(limit = 10) {
        return this.stmts.getTopAlbums.all(limit);
    }

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

    getDailyChart(days = 30) {
        const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
        const rows = this.stmts.getDailyStats.all(cutoff);

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

    getWeeklyChart(weeks = 12) {
        const cutoff = Date.now() - (weeks * 7 * 24 * 60 * 60 * 1000);
        return this.stmts.getWeeklyStats.all(cutoff);
    }

    getMonthlyChart(months = 12) {
        const cutoff = Date.now() - (months * 30 * 24 * 60 * 60 * 1000);
        return this.stmts.getMonthlyStats.all(cutoff);
    }

    getHourlyHeatmap() {
        return this.stmts.getHourlyStats.all();
    }

    searchDownloads(query, limit = 50) {
        const pattern = `%${query}%`;
        return this.stmts.searchDownloads.all(pattern, pattern, pattern, limit);
    }

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
            `"${(d.name || '').replace(/"/g, '""')}"`,
            `"${(d.artist || '').replace(/"/g, '""')}"`,
            `"${(d.album || '').replace(/"/g, '""')}"`,
            d.duration,
            d.size,
            d.status,
            d.date
        ]);

        return [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    }

    reset() {
        const transaction = this.db.transaction(() => {
            this.db.exec('DELETE FROM downloads');
            this.db.exec('UPDATE totals SET count=0, size=0, duration=0, completed=0, failed=0, skipped=0 WHERE id=1');
        });
        transaction();
    }

    close() {
        this.db.close();
    }
}

module.exports = StatsManager;
