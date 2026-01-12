const cron = require('node-cron');
const cronParser = require('cron-parser');

class Scheduler {
    constructor(db, queueManager, playlistManager) {
        this.db = db;
        this.queue = queueManager;
        this.playlists = playlistManager;
        this.jobs = new Map();

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

    initializeJobs() {
        const schedules = this.stmts.getEnabledSchedules.all();

        for (const schedule of schedules) {
            this.startJob(schedule);
        }

        console.log(`Scheduler initialized with ${this.jobs.size} active jobs`);

        const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
        this.stmts.cleanOldExecutions.run(thirtyDaysAgo);
    }

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

    isValidCron(cronExpression) {
        try {
            cronParser.parseExpression(cronExpression);
            return true;
        } catch {
            return false;
        }
    }

    generateId() {
        return 'sch_' + Math.random().toString(36).substring(2) + Date.now().toString(36);
    }

    // ==================== SCHEDULE CRUD ====================

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

    getSchedules() {
        const schedules = this.stmts.getAllSchedules.all();
        return schedules.map(s => ({
            ...this.formatSchedule(s),
            isRunning: this.jobs.has(s.id)
        }));
    }

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

        if (schedule.enabled) {
            this.stopJob(id);
            this.startJob(schedule);
        }

        return this.formatSchedule(schedule);
    }

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

    deleteSchedule(id) {
        this.stopJob(id);
        this.stmts.deleteSchedule.run(id);
        return { success: true };
    }

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

    stopJob(scheduleId) {
        if (this.jobs.has(scheduleId)) {
            this.jobs.get(scheduleId).stop();
            this.jobs.delete(scheduleId);
        }
    }

    async executeSchedule(scheduleId) {
        const schedule = this.stmts.getSchedule.get(scheduleId);
        if (!schedule || !schedule.enabled) return null;

        console.log(`Executing scheduled task: ${schedule.name}`);

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

        this.stmts.updateExecution.run({
            id: executionId,
            completedAt,
            status,
            tracksAdded,
            error
        });

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
            error
        };
    }

    async runNow(scheduleId) {
        return await this.executeSchedule(scheduleId);
    }

    async downloadPlaylist(playlistId, newTracksOnly) {
        if (newTracksOnly) {
            const syncResult = await this.playlists.syncPlaylist(playlistId);
            if (!syncResult || !syncResult.newTrackIds || syncResult.newTrackIds.length === 0) {
                return 0;
            }

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
