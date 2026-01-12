class SearchHistory {
    constructor(db) {
        this.db = db;
        this.initTables();
        this.prepareStatements();
    }

    initTables() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS search_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                query TEXT NOT NULL UNIQUE,
                searched_at INTEGER NOT NULL,
                search_count INTEGER DEFAULT 1,
                last_result_count INTEGER
            );

            CREATE INDEX IF NOT EXISTS idx_search_query ON search_history(query);
            CREATE INDEX IF NOT EXISTS idx_search_time ON search_history(searched_at DESC);

            CREATE TABLE IF NOT EXISTS favorite_artists (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                image_url TEXT,
                followers INTEGER,
                added_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_favorite_added ON favorite_artists(added_at DESC);
        `);
    }

    prepareStatements() {
        this.stmts = {
            upsertSearch: this.db.prepare(`
                INSERT INTO search_history (query, searched_at, search_count, last_result_count)
                VALUES (@query, @searchedAt, 1, @resultCount)
                ON CONFLICT(query) DO UPDATE SET
                    searched_at = @searchedAt,
                    search_count = search_count + 1,
                    last_result_count = @resultCount
            `),
            getHistory: this.db.prepare(`
                SELECT * FROM search_history 
                ORDER BY searched_at DESC 
                LIMIT ?
            `),
            getPopularSearches: this.db.prepare(`
                SELECT * FROM search_history 
                ORDER BY search_count DESC 
                LIMIT ?
            `),
            searchInHistory: this.db.prepare(`
                SELECT * FROM search_history 
                WHERE query LIKE ? 
                ORDER BY searched_at DESC 
                LIMIT ?
            `),
            deleteSearch: this.db.prepare(`DELETE FROM search_history WHERE id = ?`),
            clearHistory: this.db.prepare(`DELETE FROM search_history`),
            getHistoryStats: this.db.prepare(`
                SELECT 
                    COUNT(*) as total_searches,
                    SUM(search_count) as total_queries,
                    MAX(searched_at) as last_search
                FROM search_history
            `),

            addFavorite: this.db.prepare(`
                INSERT OR REPLACE INTO favorite_artists (id, name, image_url, followers, added_at)
                VALUES (@id, @name, @imageUrl, @followers, @addedAt)
            `),
            removeFavorite: this.db.prepare(`DELETE FROM favorite_artists WHERE id = ?`),
            getFavorites: this.db.prepare(`
                SELECT * FROM favorite_artists ORDER BY added_at DESC
            `),
            isFavorite: this.db.prepare(`SELECT 1 FROM favorite_artists WHERE id = ?`)
        };
    }

    // ==================== SEARCH HISTORY ====================

    add(query, resultCount = null) {
        const normalizedQuery = query.trim().toLowerCase();
        if (!normalizedQuery) return;

        this.stmts.upsertSearch.run({
            query: normalizedQuery,
            searchedAt: Date.now(),
            resultCount
        });
    }

    getRecent(limit = 20) {
        return this.stmts.getHistory.all(limit).map(row => ({
            id: row.id,
            query: row.query,
            searchedAt: row.searched_at,
            searchCount: row.search_count,
            lastResultCount: row.last_result_count
        }));
    }

    getPopular(limit = 10) {
        return this.stmts.getPopularSearches.all(limit).map(row => ({
            id: row.id,
            query: row.query,
            searchCount: row.search_count,
            lastResultCount: row.last_result_count
        }));
    }

    searchHistory(prefix, limit = 5) {
        return this.stmts.searchInHistory.all(`${prefix}%`, limit).map(row => ({
            id: row.id,
            query: row.query,
            searchCount: row.search_count
        }));
    }

    delete(id) {
        this.stmts.deleteSearch.run(id);
    }

    clear() {
        this.stmts.clearHistory.run();
    }

    getStats() {
        const row = this.stmts.getHistoryStats.get();
        return {
            totalSearches: row.total_searches,
            totalQueries: row.total_queries,
            lastSearch: row.last_search
        };
    }

    // ==================== FAVORITE ARTISTS ====================

    addFavorite(artist) {
        this.stmts.addFavorite.run({
            id: artist.id,
            name: artist.name,
            imageUrl: artist.images?.[0]?.url || null,
            followers: artist.followers?.total || 0,
            addedAt: Date.now()
        });
    }

    removeFavorite(artistId) {
        this.stmts.removeFavorite.run(artistId);
    }

    getFavorites() {
        return this.stmts.getFavorites.all().map(row => ({
            id: row.id,
            name: row.name,
            imageUrl: row.image_url,
            followers: row.followers,
            addedAt: row.added_at
        }));
    }

    isFavorite(artistId) {
        return !!this.stmts.isFavorite.get(artistId);
    }
}

module.exports = SearchHistory;
