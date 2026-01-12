class PlaylistManager {
    constructor(db, spotify) {
        this.db = db;
        this.spotify = spotify;
        this.initTables();
        this.prepareStatements();
    }

    initTables() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS playlists (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT,
                image TEXT,
                owner TEXT,
                track_count INTEGER DEFAULT 0,
                saved_at INTEGER NOT NULL,
                last_synced_at INTEGER,
                last_downloaded_at INTEGER
            );

            CREATE INDEX IF NOT EXISTS idx_playlists_saved ON playlists(saved_at);

            CREATE TABLE IF NOT EXISTS playlist_tracks (
                playlist_id TEXT NOT NULL,
                track_id TEXT NOT NULL,
                position INTEGER,
                added_at INTEGER NOT NULL,
                PRIMARY KEY (playlist_id, track_id),
                FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_playlist_tracks_playlist ON playlist_tracks(playlist_id);

            CREATE TABLE IF NOT EXISTS download_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                item_id TEXT NOT NULL,
                item_type TEXT NOT NULL CHECK (item_type IN ('track', 'album', 'playlist')),
                name TEXT NOT NULL,
                artist TEXT,
                album TEXT,
                image TEXT,
                track_count INTEGER DEFAULT 1,
                url TEXT,
                downloaded_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_history_downloaded ON download_history(downloaded_at DESC);
            CREATE INDEX IF NOT EXISTS idx_history_type ON download_history(item_type);
            CREATE INDEX IF NOT EXISTS idx_history_item ON download_history(item_id);
        `);
    }

    prepareStatements() {
        this.stmts = {
            // Playlist statements
            insertPlaylist: this.db.prepare(`
                INSERT OR REPLACE INTO playlists 
                (id, name, description, image, owner, track_count, saved_at, last_synced_at)
                VALUES (@id, @name, @description, @image, @owner, @trackCount, @savedAt, @lastSyncedAt)
            `),
            getPlaylist: this.db.prepare(`SELECT * FROM playlists WHERE id = ?`),
            getAllPlaylists: this.db.prepare(`
                SELECT p.*, 
                    (SELECT COUNT(*) FROM playlist_tracks pt2 
                     WHERE pt2.playlist_id = p.id 
                     AND pt2.added_at > COALESCE(p.last_downloaded_at, 0)) as new_tracks
                FROM playlists p
                ORDER BY p.saved_at DESC
            `),
            deletePlaylist: this.db.prepare(`DELETE FROM playlists WHERE id = ?`),
            updatePlaylistSync: this.db.prepare(`
                UPDATE playlists 
                SET track_count = @trackCount, last_synced_at = @lastSyncedAt, name = @name, image = @image
                WHERE id = @id
            `),
            updatePlaylistDownload: this.db.prepare(`
                UPDATE playlists SET last_downloaded_at = ? WHERE id = ?
            `),

            // Playlist tracks statements
            insertTrack: this.db.prepare(`
                INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position, added_at)
                VALUES (@playlistId, @trackId, @position, @addedAt)
            `),
            getPlaylistTracks: this.db.prepare(`
                SELECT track_id FROM playlist_tracks WHERE playlist_id = ? ORDER BY position
            `),
            getNewTracks: this.db.prepare(`
                SELECT track_id FROM playlist_tracks 
                WHERE playlist_id = ? AND added_at > ?
                ORDER BY position
            `),
            deletePlaylistTracks: this.db.prepare(`
                DELETE FROM playlist_tracks WHERE playlist_id = ?
            `),

            // History statements
            insertHistory: this.db.prepare(`
                INSERT INTO download_history 
                (item_id, item_type, name, artist, album, image, track_count, url, downloaded_at)
                VALUES (@itemId, @itemType, @name, @artist, @album, @image, @trackCount, @url, @downloadedAt)
            `),
            updateHistory: this.db.prepare(`
                UPDATE download_history 
                SET downloaded_at = @downloadedAt, track_count = @trackCount
                WHERE item_id = @itemId
            `),
            getHistoryById: this.db.prepare(`
                SELECT * FROM download_history WHERE id = ?
            `),
            getHistoryByItemId: this.db.prepare(`
                SELECT * FROM download_history WHERE item_id = ?
            `),
            getHistory: this.db.prepare(`
                SELECT * FROM download_history 
                ORDER BY downloaded_at DESC 
                LIMIT ? OFFSET ?
            `),
            getHistoryByType: this.db.prepare(`
                SELECT * FROM download_history 
                WHERE item_type = ?
                ORDER BY downloaded_at DESC 
                LIMIT ? OFFSET ?
            `),
            searchHistory: this.db.prepare(`
                SELECT * FROM download_history 
                WHERE name LIKE ? OR artist LIKE ? OR album LIKE ?
                ORDER BY downloaded_at DESC 
                LIMIT ?
            `),
            getHistoryCount: this.db.prepare(`SELECT COUNT(*) as count FROM download_history`),
            getHistoryCountByType: this.db.prepare(`SELECT COUNT(*) as count FROM download_history WHERE item_type = ?`),
            clearHistory: this.db.prepare(`DELETE FROM download_history`),
            clearHistoryBefore: this.db.prepare(`DELETE FROM download_history WHERE downloaded_at < ?`),
            deleteHistoryItem: this.db.prepare(`DELETE FROM download_history WHERE id = ?`)
        };

        // Transactions
        this.insertPlaylistWithTracks = this.db.transaction((params, tracks) => {
            this.stmts.insertPlaylist.run(params);
            this.stmts.deletePlaylistTracks.run(params.id);

            for (let i = 0; i < tracks.length; i++) {
                const track = tracks[i];
                if (track && track.id) {
                    this.stmts.insertTrack.run({
                        playlistId: params.id,
                        trackId: track.id,
                        position: i,
                        addedAt: params.savedAt
                    });
                }
            }
        });

        this.syncPlaylistTransaction = this.db.transaction((playlistId, params, newTrackIds, allTrackIds, now) => {
            this.stmts.updatePlaylistSync.run(params);

            // Add new tracks
            for (let i = 0; i < allTrackIds.length; i++) {
                if (newTrackIds.includes(allTrackIds[i])) {
                    this.stmts.insertTrack.run({
                        playlistId,
                        trackId: allTrackIds[i],
                        position: i,
                        addedAt: now
                    });
                }
            }
        });
    }

    // ==================== PLAYLIST METHODS ====================

    async savePlaylist(playlistId) {
        const playlist = await this.spotify.getPlaylist(playlistId);
        const now = Date.now();

        const params = {
            id: playlistId,
            name: playlist.name,
            description: playlist.description || null,
            image: playlist.images[0]?.url || null,
            owner: playlist.owner.display_name,
            trackCount: playlist.tracks.total,
            savedAt: now,
            lastSyncedAt: now
        };

        const tracks = playlist.tracks.items
            .filter(item => item.track && item.track.id)
            .map(item => ({ id: item.track.id }));

        this.insertPlaylistWithTracks(params, tracks);

        return this.getPlaylistInfo(playlistId);
    }

    getPlaylistInfo(playlistId) {
        const playlist = this.stmts.getPlaylist.get(playlistId);
        if (!playlist) return null;

        const newTracks = this.stmts.getNewTracks.all(
            playlistId,
            playlist.last_downloaded_at || 0
        );

        return {
            id: playlist.id,
            name: playlist.name,
            description: playlist.description,
            image: playlist.image,
            owner: playlist.owner,
            trackCount: playlist.track_count,
            savedAt: playlist.saved_at,
            lastSyncedAt: playlist.last_synced_at,
            lastDownloadedAt: playlist.last_downloaded_at,
            newTracks: newTracks.length
        };
    }

    getPlaylists() {
        return this.stmts.getAllPlaylists.all().map(row => ({
            id: row.id,
            name: row.name,
            description: row.description,
            image: row.image,
            owner: row.owner,
            trackCount: row.track_count,
            savedAt: row.saved_at,
            lastSyncedAt: row.last_synced_at,
            lastDownloadedAt: row.last_downloaded_at,
            newTracks: row.new_tracks
        }));
    }

    removePlaylist(playlistId) {
        this.stmts.deletePlaylist.run(playlistId);
        return { success: true };
    }

    async syncPlaylist(playlistId) {
        const saved = this.stmts.getPlaylist.get(playlistId);
        if (!saved) return null;

        const current = await this.spotify.getPlaylist(playlistId);
        const now = Date.now();

        const currentTrackIds = current.tracks.items
            .filter(item => item.track && item.track.id)
            .map(item => item.track.id);

        const savedTracks = this.stmts.getPlaylistTracks.all(playlistId);
        const savedTrackIds = new Set(savedTracks.map(t => t.track_id));

        const newTrackIds = currentTrackIds.filter(id => !savedTrackIds.has(id));

        const params = {
            id: playlistId,
            trackCount: current.tracks.total,
            lastSyncedAt: now,
            name: current.name,
            image: current.images[0]?.url || null
        };

        this.syncPlaylistTransaction(playlistId, params, newTrackIds, currentTrackIds, now);

        return {
            ...this.getPlaylistInfo(playlistId),
            newTrackIds
        };
    }

    async syncAllPlaylists() {
        const playlists = this.stmts.getAllPlaylists.all();
        const results = [];

        for (const playlist of playlists) {
            try {
                const result = await this.syncPlaylist(playlist.id);
                results.push(result);
            } catch (error) {
                results.push({
                    id: playlist.id,
                    name: playlist.name,
                    error: error.message
                });
            }
        }

        return results;
    }

    getNewTrackIds(playlistId) {
        const playlist = this.stmts.getPlaylist.get(playlistId);
        if (!playlist) return [];

        return this.stmts.getNewTracks
            .all(playlistId, playlist.last_downloaded_at || 0)
            .map(t => t.track_id);
    }

    getPlaylistTrackIds(playlistId) {
        return this.stmts.getPlaylistTracks.all(playlistId).map(t => t.track_id);
    }

    markPlaylistDownloaded(playlistId) {
        this.stmts.updatePlaylistDownload.run(Date.now(), playlistId);
    }

    // ==================== HISTORY METHODS ====================

    addToHistory(item) {
        const params = {
            itemId: item.id,
            itemType: item.type,
            name: item.name,
            artist: item.artist || null,
            album: item.album || null,
            image: item.image || null,
            trackCount: item.trackCount || 1,
            url: item.url || null,
            downloadedAt: Date.now()
        };

        const existing = this.stmts.getHistoryByItemId.get(item.id);

        if (existing) {
            this.stmts.updateHistory.run({
                itemId: item.id,
                trackCount: params.trackCount,
                downloadedAt: params.downloadedAt
            });
        } else {
            this.stmts.insertHistory.run(params);
        }

        return this.stmts.getHistoryByItemId.get(item.id);
    }

    getHistory(options = {}) {
        const limit = options.limit || 50;
        const offset = options.offset || 0;

        let rows;
        let total;

        if (options.type) {
            rows = this.stmts.getHistoryByType.all(options.type, limit, offset);
            total = this.stmts.getHistoryCountByType.get(options.type).count;
        } else {
            rows = this.stmts.getHistory.all(limit, offset);
            total = this.stmts.getHistoryCount.get().count;
        }

        return {
            items: rows.map(row => ({
                id: row.id,
                itemId: row.item_id,
                type: row.item_type,
                name: row.name,
                artist: row.artist,
                album: row.album,
                image: row.image,
                trackCount: row.track_count,
                url: row.url,
                downloadedAt: row.downloaded_at
            })),
            total,
            limit,
            offset
        };
    }

    searchHistory(query, limit = 50) {
        const pattern = `%${query}%`;
        const rows = this.stmts.searchHistory.all(pattern, pattern, pattern, limit);

        return rows.map(row => ({
            id: row.id,
            itemId: row.item_id,
            type: row.item_type,
            name: row.name,
            artist: row.artist,
            album: row.album,
            image: row.image,
            trackCount: row.track_count,
            url: row.url,
            downloadedAt: row.downloaded_at
        }));
    }

    clearHistory() {
        this.stmts.clearHistory.run();
        return { success: true };
    }

    clearHistoryBefore(timestamp) {
        this.stmts.clearHistoryBefore.run(timestamp);
        return { success: true };
    }

    deleteHistoryItem(id) {
        this.stmts.deleteHistoryItem.run(id);
        return { success: true };
    }

    getHistoryItem(id) {
        const row = this.stmts.getHistoryById.get(id);
        if (!row) return null;

        return {
            id: row.id,
            itemId: row.item_id,
            type: row.item_type,
            name: row.name,
            artist: row.artist,
            album: row.album,
            image: row.image,
            trackCount: row.track_count,
            url: row.url,
            downloadedAt: row.downloaded_at
        };
    }
}

module.exports = PlaylistManager;
