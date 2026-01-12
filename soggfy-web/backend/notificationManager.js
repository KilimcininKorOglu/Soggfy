const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

class NotificationManager {
    constructor(dbPath, config = {}) {
        const dbDir = path.dirname(dbPath);
        if (!fs.existsSync(dbDir)) {
            fs.mkdirSync(dbDir, { recursive: true });
        }

        this.db = new Database(dbPath);
        this.db.pragma('journal_mode = WAL');
        this.config = config;
        this.discord = null;
        this.telegram = null;
        this.batchTimer = null;
        this.webpush = null;

        this.initTables();
        this.prepareStatements();
        this.initDefaultSettings();
    }

    initTables() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS push_subscriptions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                endpoint TEXT UNIQUE NOT NULL,
                p256dh_key TEXT NOT NULL,
                auth_key TEXT NOT NULL,
                user_agent TEXT,
                created_at INTEGER NOT NULL,
                last_used_at INTEGER
            );

            CREATE INDEX IF NOT EXISTS idx_push_endpoint ON push_subscriptions(endpoint);

            CREATE TABLE IF NOT EXISTS notification_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at INTEGER
            );

            CREATE TABLE IF NOT EXISTS notification_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                type TEXT NOT NULL CHECK (type IN ('download_complete', 'download_error', 'queue_complete', 'scheduled_task', 'test')),
                channel TEXT NOT NULL CHECK (channel IN ('browser', 'discord', 'telegram')),
                title TEXT NOT NULL,
                body TEXT,
                track_id TEXT,
                track_name TEXT,
                status TEXT NOT NULL CHECK (status IN ('sent', 'failed', 'skipped')),
                error TEXT,
                sent_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_notif_type ON notification_history(type);
            CREATE INDEX IF NOT EXISTS idx_notif_channel ON notification_history(channel);
            CREATE INDEX IF NOT EXISTS idx_notif_status ON notification_history(status);
            CREATE INDEX IF NOT EXISTS idx_notif_sent ON notification_history(sent_at DESC);

            CREATE TABLE IF NOT EXISTS notification_batch (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                channel TEXT NOT NULL,
                track_id TEXT NOT NULL,
                track_name TEXT NOT NULL,
                track_artist TEXT,
                album_art TEXT,
                queued_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_batch_channel ON notification_batch(channel);
        `);
    }

    initDefaultSettings() {
        const defaults = {
            'browser.enabled': 'true',
            'browser.onComplete': 'true',
            'browser.onError': 'true',
            'browser.onQueueComplete': 'true',
            'browser.onScheduledTask': 'true',
            'browser.sound': 'true',
            'discord.enabled': 'false',
            'discord.webhookUrl': '',
            'discord.onComplete': 'true',
            'discord.onError': 'true',
            'discord.batchMode': 'false',
            'discord.batchInterval': '60000',
            'telegram.enabled': 'false',
            'telegram.botToken': '',
            'telegram.chatId': '',
            'telegram.onComplete': 'true',
            'telegram.onError': 'true',
            'quietHours.enabled': 'false',
            'quietHours.start': '22:00',
            'quietHours.end': '08:00'
        };

        const insertStmt = this.db.prepare(`
            INSERT OR IGNORE INTO notification_settings (key, value, updated_at)
            VALUES (?, ?, ?)
        `);

        const now = Date.now();
        for (const [key, value] of Object.entries(defaults)) {
            insertStmt.run(key, value, now);
        }
    }

    prepareStatements() {
        this.stmts = {
            // Settings
            getSetting: this.db.prepare(`SELECT value FROM notification_settings WHERE key = ?`),
            setSetting: this.db.prepare(`
                INSERT INTO notification_settings (key, value, updated_at)
                VALUES (@key, @value, @updatedAt)
                ON CONFLICT(key) DO UPDATE SET value = @value, updated_at = @updatedAt
            `),
            getAllSettings: this.db.prepare(`SELECT key, value FROM notification_settings`),

            // Push subscriptions
            addSubscription: this.db.prepare(`
                INSERT INTO push_subscriptions (endpoint, p256dh_key, auth_key, user_agent, created_at)
                VALUES (@endpoint, @p256dhKey, @authKey, @userAgent, @createdAt)
                ON CONFLICT(endpoint) DO UPDATE SET
                    p256dh_key = @p256dhKey,
                    auth_key = @authKey,
                    user_agent = @userAgent
            `),
            removeSubscription: this.db.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?`),
            getAllSubscriptions: this.db.prepare(`SELECT * FROM push_subscriptions`),
            updateSubscriptionUsed: this.db.prepare(`
                UPDATE push_subscriptions SET last_used_at = ? WHERE endpoint = ?
            `),

            // History
            addHistory: this.db.prepare(`
                INSERT INTO notification_history 
                (type, channel, title, body, track_id, track_name, status, error, sent_at)
                VALUES (@type, @channel, @title, @body, @trackId, @trackName, @status, @error, @sentAt)
            `),
            getHistory: this.db.prepare(`
                SELECT * FROM notification_history 
                ORDER BY sent_at DESC 
                LIMIT ? OFFSET ?
            `),
            getHistoryByType: this.db.prepare(`
                SELECT * FROM notification_history 
                WHERE type = ?
                ORDER BY sent_at DESC 
                LIMIT ?
            `),
            getHistoryByChannel: this.db.prepare(`
                SELECT * FROM notification_history 
                WHERE channel = ?
                ORDER BY sent_at DESC 
                LIMIT ?
            `),
            getHistoryStats: this.db.prepare(`
                SELECT 
                    channel,
                    COUNT(*) as total,
                    SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) as sent,
                    SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
                    SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) as skipped
                FROM notification_history
                GROUP BY channel
            `),
            cleanOldHistory: this.db.prepare(`
                DELETE FROM notification_history 
                WHERE sent_at < ?
            `),

            // Batch
            addToBatch: this.db.prepare(`
                INSERT INTO notification_batch 
                (channel, track_id, track_name, track_artist, album_art, queued_at)
                VALUES (@channel, @trackId, @trackName, @trackArtist, @albumArt, @queuedAt)
            `),
            getBatch: this.db.prepare(`
                SELECT * FROM notification_batch WHERE channel = ? ORDER BY queued_at ASC
            `),
            clearBatch: this.db.prepare(`DELETE FROM notification_batch WHERE channel = ?`)
        };
    }

    // ==================== SETTINGS ====================

    getSetting(key) {
        const row = this.stmts.getSetting.get(key);
        if (!row) return null;

        if (row.value === 'true') return true;
        if (row.value === 'false') return false;
        if (/^\d+$/.test(row.value)) return parseInt(row.value);
        return row.value;
    }

    setSetting(key, value) {
        this.stmts.setSetting.run({
            key,
            value: String(value),
            updatedAt: Date.now()
        });

        if (key.startsWith('discord.') || key.startsWith('telegram.')) {
            this.initWebhooks();
        }
    }

    getAllSettings() {
        const rows = this.stmts.getAllSettings.all();
        const settings = {};

        for (const row of rows) {
            const parts = row.key.split('.');
            let current = settings;

            for (let i = 0; i < parts.length - 1; i++) {
                if (!current[parts[i]]) current[parts[i]] = {};
                current = current[parts[i]];
            }

            let value = row.value;
            if (value === 'true') value = true;
            else if (value === 'false') value = false;
            else if (/^\d+$/.test(value)) value = parseInt(value);

            current[parts[parts.length - 1]] = value;
        }

        return settings;
    }

    updateSettings(updates, prefix = '') {
        const flatten = (obj, parentKey = '') => {
            const result = {};
            for (const [key, value] of Object.entries(obj)) {
                const fullKey = parentKey ? `${parentKey}.${key}` : key;
                if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
                    Object.assign(result, flatten(value, fullKey));
                } else {
                    result[fullKey] = value;
                }
            }
            return result;
        };

        const flattened = flatten(updates, prefix);
        for (const [key, value] of Object.entries(flattened)) {
            this.setSetting(key, value);
        }
    }

    // ==================== VAPID & PUSH ====================

    initVapid() {
        if (this.config.vapidPublicKey && this.config.vapidPrivateKey) {
            try {
                this.webpush = require('web-push');
                this.webpush.setVapidDetails(
                    'mailto:' + (this.config.vapidEmail || 'admin@localhost'),
                    this.config.vapidPublicKey,
                    this.config.vapidPrivateKey
                );
            } catch (err) {
                console.error('Failed to initialize web-push:', err.message);
            }
        }
    }

    registerPushSubscription(subscription, userAgent = null) {
        this.stmts.addSubscription.run({
            endpoint: subscription.endpoint,
            p256dhKey: subscription.keys.p256dh,
            authKey: subscription.keys.auth,
            userAgent,
            createdAt: Date.now()
        });
    }

    unregisterPushSubscription(endpoint) {
        this.stmts.removeSubscription.run(endpoint);
    }

    getPushSubscriptions() {
        return this.stmts.getAllSubscriptions.all().map(row => ({
            endpoint: row.endpoint,
            keys: {
                p256dh: row.p256dh_key,
                auth: row.auth_key
            }
        }));
    }

    // ==================== WEBHOOKS ====================

    initWebhooks() {
        const discordUrl = this.getSetting('discord.webhookUrl');
        if (discordUrl) {
            try {
                const DiscordWebhook = require('./webhooks/discord');
                this.discord = new DiscordWebhook(discordUrl);
            } catch (err) {
                console.error('Failed to initialize Discord webhook:', err.message);
            }
        }

        const telegramToken = this.getSetting('telegram.botToken');
        const telegramChatId = this.getSetting('telegram.chatId');
        if (telegramToken && telegramChatId) {
            try {
                const TelegramBot = require('./webhooks/telegram');
                this.telegram = new TelegramBot(telegramToken, telegramChatId);
            } catch (err) {
                console.error('Failed to initialize Telegram bot:', err.message);
            }
        }
    }

    // ==================== QUIET HOURS ====================

    isQuietTime() {
        if (!this.getSetting('quietHours.enabled')) return false;

        const now = new Date();
        const currentTime = now.getHours() * 60 + now.getMinutes();

        const start = this.getSetting('quietHours.start') || '22:00';
        const end = this.getSetting('quietHours.end') || '08:00';

        const [startH, startM] = start.split(':').map(Number);
        const [endH, endM] = end.split(':').map(Number);

        const startTime = startH * 60 + startM;
        const endTime = endH * 60 + endM;

        if (startTime < endTime) {
            return currentTime >= startTime && currentTime < endTime;
        } else {
            return currentTime >= startTime || currentTime < endTime;
        }
    }

    // ==================== SEND NOTIFICATIONS ====================

    logNotification(type, channel, title, body, trackId, trackName, status, error = null) {
        this.stmts.addHistory.run({
            type,
            channel,
            title,
            body,
            trackId,
            trackName,
            status,
            error,
            sentAt: Date.now()
        });
    }

    async sendPushNotification(title, body, options = {}) {
        if (!this.getSetting('browser.enabled')) return;
        if (!this.webpush) {
            console.log('Web push not configured');
            return;
        }
        if (this.isQuietTime()) {
            this.logNotification(options.type || 'test', 'browser', title, body, null, null, 'skipped', 'Quiet hours');
            return;
        }

        const payload = JSON.stringify({
            title,
            body,
            icon: options.icon || '/logo192.png',
            badge: '/badge.png',
            tag: options.tag || 'soggfy',
            data: options.data,
            sound: this.getSetting('browser.sound') ? '/notification.mp3' : null,
            requireInteraction: options.requireInteraction || false
        });

        const subscriptions = this.getPushSubscriptions();
        let sent = 0;
        let failed = 0;

        for (const subscription of subscriptions) {
            try {
                await this.webpush.sendNotification(subscription, payload);
                this.stmts.updateSubscriptionUsed.run(Date.now(), subscription.endpoint);
                sent++;
            } catch (error) {
                if (error.statusCode === 410) {
                    this.unregisterPushSubscription(subscription.endpoint);
                }
                console.error('Push notification failed:', error.message);
                failed++;
            }
        }

        this.logNotification(
            options.type || 'test',
            'browser',
            title,
            body,
            options.trackId,
            options.trackName,
            sent > 0 ? 'sent' : 'failed',
            failed > 0 ? `${failed} failed` : null
        );
    }

    async notifyDownloadComplete(track) {
        if (this.isQuietTime()) return;

        const title = 'Download Complete';
        const body = `${track.name} - ${track.artist}`;
        const icon = track.albumArt;

        if (this.getSetting('browser.onComplete')) {
            await this.sendPushNotification(title, body, {
                icon,
                type: 'download_complete',
                trackId: track.id,
                trackName: track.name
            });
        }

        if (this.getSetting('discord.enabled') && this.getSetting('discord.onComplete')) {
            if (this.getSetting('discord.batchMode')) {
                this.addToBatch('discord', track);
            } else {
                await this.sendDiscordNotification(track);
            }
        }

        if (this.getSetting('telegram.enabled') && this.getSetting('telegram.onComplete')) {
            await this.sendTelegramNotification(track);
        }
    }

    async sendDiscordNotification(track, isError = false, error = null) {
        if (!this.discord) return;

        try {
            if (isError) {
                await this.discord.sendErrorNotification(track, error);
            } else {
                await this.discord.sendDownloadNotification(track);
            }
            this.logNotification(
                isError ? 'download_error' : 'download_complete',
                'discord',
                isError ? 'Download Failed' : 'Download Complete',
                `${track.name} - ${track.artist}`,
                track.id,
                track.name,
                'sent'
            );
        } catch (err) {
            this.logNotification(
                isError ? 'download_error' : 'download_complete',
                'discord',
                isError ? 'Download Failed' : 'Download Complete',
                `${track.name} - ${track.artist}`,
                track.id,
                track.name,
                'failed',
                err.message
            );
        }
    }

    async sendTelegramNotification(track, isError = false, error = null) {
        if (!this.telegram) return;

        try {
            if (isError) {
                await this.telegram.sendErrorNotification(track, error);
            } else {
                await this.telegram.sendDownloadNotification(track);
            }
            this.logNotification(
                isError ? 'download_error' : 'download_complete',
                'telegram',
                isError ? 'Download Failed' : 'Download Complete',
                `${track.name} - ${track.artist}`,
                track.id,
                track.name,
                'sent'
            );
        } catch (err) {
            this.logNotification(
                isError ? 'download_error' : 'download_complete',
                'telegram',
                isError ? 'Download Failed' : 'Download Complete',
                `${track.name} - ${track.artist}`,
                track.id,
                track.name,
                'failed',
                err.message
            );
        }
    }

    async notifyDownloadError(track, error) {
        if (this.isQuietTime()) return;

        const title = 'Download Failed';
        const body = `${track.name} - ${error}`;

        if (this.getSetting('browser.onError')) {
            await this.sendPushNotification(title, body, {
                tag: 'soggfy-error',
                requireInteraction: true,
                type: 'download_error',
                trackId: track.id,
                trackName: track.name
            });
        }

        if (this.getSetting('discord.enabled') && this.getSetting('discord.onError')) {
            await this.sendDiscordNotification(track, true, error);
        }

        if (this.getSetting('telegram.enabled') && this.getSetting('telegram.onError')) {
            await this.sendTelegramNotification(track, true, error);
        }
    }

    async notifyQueueComplete(stats) {
        if (this.isQuietTime()) return;

        const title = 'Queue Complete';
        const body = `Downloaded ${stats.completed} tracks (${stats.failed} failed)`;

        if (this.getSetting('browser.onQueueComplete')) {
            await this.sendPushNotification(title, body, {
                tag: 'soggfy-queue-complete',
                requireInteraction: true,
                type: 'queue_complete'
            });
        }

        if (this.getSetting('discord.enabled') && this.discord) {
            try {
                await this.discord.sendQueueCompleteNotification(stats);
                this.logNotification('queue_complete', 'discord', title, body, null, null, 'sent');
            } catch (err) {
                this.logNotification('queue_complete', 'discord', title, body, null, null, 'failed', err.message);
            }
        }

        if (this.getSetting('telegram.enabled') && this.telegram) {
            try {
                await this.telegram.sendQueueCompleteNotification(stats);
                this.logNotification('queue_complete', 'telegram', title, body, null, null, 'sent');
            } catch (err) {
                this.logNotification('queue_complete', 'telegram', title, body, null, null, 'failed', err.message);
            }
        }
    }

    async notifyScheduledTaskComplete(task, result) {
        if (this.isQuietTime()) return;

        const title = 'Scheduled Task Complete';
        const body = `${task.name}: ${result.tracksAdded} tracks added`;

        if (this.getSetting('browser.onScheduledTask')) {
            await this.sendPushNotification(title, body, {
                tag: 'soggfy-scheduled',
                type: 'scheduled_task'
            });
        }
    }

    // ==================== BATCH NOTIFICATIONS ====================

    addToBatch(channel, track) {
        this.stmts.addToBatch.run({
            channel,
            trackId: track.id,
            trackName: track.name,
            trackArtist: track.artist,
            albumArt: track.albumArt,
            queuedAt: Date.now()
        });
    }

    startBatchProcessor() {
        const interval = this.getSetting('discord.batchInterval') || 60000;

        this.batchTimer = setInterval(async () => {
            await this.processBatch('discord');
        }, interval);
    }

    async processBatch(channel) {
        const items = this.stmts.getBatch.all(channel);
        if (items.length === 0) return;

        if (channel === 'discord' && this.discord) {
            try {
                await this.discord.sendBatchNotification(items);
                this.logNotification(
                    'download_complete',
                    'discord',
                    'Batch Download Complete',
                    `${items.length} tracks`,
                    null,
                    null,
                    'sent'
                );
            } catch (err) {
                this.logNotification(
                    'download_complete',
                    'discord',
                    'Batch Download Complete',
                    `${items.length} tracks`,
                    null,
                    null,
                    'failed',
                    err.message
                );
            }
        }

        this.stmts.clearBatch.run(channel);
    }

    // ==================== HISTORY ====================

    getHistory(options = {}) {
        const limit = options.limit || 50;
        const offset = options.offset || 0;

        let rows;
        if (options.type) {
            rows = this.stmts.getHistoryByType.all(options.type, limit);
        } else if (options.channel) {
            rows = this.stmts.getHistoryByChannel.all(options.channel, limit);
        } else {
            rows = this.stmts.getHistory.all(limit, offset);
        }

        return rows.map(row => ({
            id: row.id,
            type: row.type,
            channel: row.channel,
            title: row.title,
            body: row.body,
            trackId: row.track_id,
            trackName: row.track_name,
            status: row.status,
            error: row.error,
            sentAt: row.sent_at
        }));
    }

    getHistoryStats() {
        const rows = this.stmts.getHistoryStats.all();
        const stats = {};

        for (const row of rows) {
            stats[row.channel] = {
                total: row.total,
                sent: row.sent,
                failed: row.failed,
                skipped: row.skipped,
                successRate: row.total > 0 ? Math.round((row.sent / row.total) * 100) : 0
            };
        }

        return stats;
    }

    cleanHistory(daysToKeep = 30) {
        const cutoff = Date.now() - (daysToKeep * 24 * 60 * 60 * 1000);
        this.stmts.cleanOldHistory.run(cutoff);
    }

    // ==================== TEST ====================

    async sendTestNotification(channel = 'all') {
        const testTrack = {
            id: 'test',
            name: 'Test Track',
            artist: 'Test Artist',
            album: 'Test Album',
            albumArt: null,
            duration: 180000
        };

        const results = {};

        if (channel === 'all' || channel === 'browser') {
            try {
                await this.sendPushNotification('Test Notification', 'This is a test from Soggfy', {
                    type: 'test'
                });
                results.browser = 'sent';
            } catch (err) {
                results.browser = `failed: ${err.message}`;
            }
        }

        if (channel === 'all' || channel === 'discord') {
            if (this.discord) {
                try {
                    await this.discord.sendDownloadNotification(testTrack);
                    this.logNotification('test', 'discord', 'Test', 'Test notification', null, null, 'sent');
                    results.discord = 'sent';
                } catch (err) {
                    this.logNotification('test', 'discord', 'Test', 'Test notification', null, null, 'failed', err.message);
                    results.discord = `failed: ${err.message}`;
                }
            } else {
                results.discord = 'not configured';
            }
        }

        if (channel === 'all' || channel === 'telegram') {
            if (this.telegram) {
                try {
                    await this.telegram.sendDownloadNotification(testTrack);
                    this.logNotification('test', 'telegram', 'Test', 'Test notification', null, null, 'sent');
                    results.telegram = 'sent';
                } catch (err) {
                    this.logNotification('test', 'telegram', 'Test', 'Test notification', null, null, 'failed', err.message);
                    results.telegram = `failed: ${err.message}`;
                }
            } else {
                results.telegram = 'not configured';
            }
        }

        return results;
    }

    // ==================== LIFECYCLE ====================

    shutdown() {
        if (this.batchTimer) {
            clearInterval(this.batchTimer);
        }
        this.processBatch('discord').catch(console.error);
    }
}

module.exports = NotificationManager;
