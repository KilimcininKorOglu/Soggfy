# Notifications Feature

**Branch:** `feature/notifications`

## Overview

Add notification capabilities to alert users about download completions, errors, and other events through browser notifications and external services like Discord and Telegram webhooks. Uses SQLite for persistent storage, sharing the database with other features.

## Features

### 1. Browser Push Notifications

- Notify when download completes
- Notify when download fails
- Notify when queue completes
- Notify when scheduled task runs
- Optional sound alerts

### 2. Discord Webhook Integration

- Post download completion to Discord channel
- Include track artwork and metadata
- Configurable message format
- Batch notifications (summary of multiple downloads)

### 3. Telegram Bot Integration

- Send notifications to Telegram chat
- Include track details and artwork
- Configurable message format
- Real-time download updates

### 4. Notification Preferences

- Enable/disable per notification type
- Quiet hours (no notifications between X and Y)
- Batch notifications (combine multiple into one)
- Custom notification sounds

### 5. Notification History

- Log of all sent notifications
- Filter by type, channel, status
- Retry failed notifications
- Statistics (success rate, etc.)

## Technical Implementation

### Database Schema

Extends the existing `stats.db` SQLite database:

```sql
-- Push subscriptions (persistent across restarts)
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

-- Notification settings (key-value store)
CREATE TABLE IF NOT EXISTS notification_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER
);

-- Notification history
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

-- Batch queue for Discord (group notifications)
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
```

### Backend Changes

#### New Dependencies

```bash
cd soggfy-web/backend
npm install web-push
```

#### New Files

```
soggfy-web/backend/
├── notificationManager.js    # Notification routing and management
├── webhooks/
│   ├── discord.js            # Discord webhook handler
│   └── telegram.js           # Telegram bot handler
```

#### notificationManager.js

```javascript
const webpush = require('web-push');
const DiscordWebhook = require('./webhooks/discord');
const TelegramBot = require('./webhooks/telegram');

class NotificationManager {
    constructor(db, config) {
        this.db = db; // Shared SQLite database
        this.config = config;
        this.discord = null;
        this.telegram = null;
        this.batchTimer = null;

        this.initTables();
        this.prepareStatements();
        this.initVapid();
        this.initWebhooks();
        this.startBatchProcessor();
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

        // Initialize default settings
        this.initDefaultSettings();
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

        // Parse boolean and number values
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

        // Reinitialize webhooks if relevant settings changed
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
            webpush.setVapidDetails(
                'mailto:' + (this.config.vapidEmail || 'admin@localhost'),
                this.config.vapidPublicKey,
                this.config.vapidPrivateKey
            );
        }
    }

    // Register push subscription
    registerPushSubscription(subscription, userAgent = null) {
        this.stmts.addSubscription.run({
            endpoint: subscription.endpoint,
            p256dhKey: subscription.keys.p256dh,
            authKey: subscription.keys.auth,
            userAgent,
            createdAt: Date.now()
        });
    }

    // Unregister push subscription
    unregisterPushSubscription(endpoint) {
        this.stmts.removeSubscription.run(endpoint);
    }

    // Get all push subscriptions
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
            this.discord = new DiscordWebhook(discordUrl);
        }

        const telegramToken = this.getSetting('telegram.botToken');
        const telegramChatId = this.getSetting('telegram.chatId');
        if (telegramToken && telegramChatId) {
            this.telegram = new TelegramBot(telegramToken, telegramChatId);
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
            // Quiet hours span midnight
            return currentTime >= startTime || currentTime < endTime;
        }
    }

    // ==================== SEND NOTIFICATIONS ====================

    // Log notification to history
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

    // Send browser push notification
    async sendPushNotification(title, body, options = {}) {
        if (!this.getSetting('browser.enabled')) return;
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
                await webpush.sendNotification(subscription, payload);
                this.stmts.updateSubscriptionUsed.run(Date.now(), subscription.endpoint);
                sent++;
            } catch (error) {
                if (error.statusCode === 410) {
                    // Subscription expired, remove it
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

    // Notify download complete
    async notifyDownloadComplete(track) {
        if (this.isQuietTime()) return;

        const title = 'Download Complete';
        const body = `${track.name} - ${track.artist}`;
        const icon = track.albumArt;

        // Browser notification
        if (this.getSetting('browser.onComplete')) {
            await this.sendPushNotification(title, body, {
                icon,
                type: 'download_complete',
                trackId: track.id,
                trackName: track.name
            });
        }

        // Discord
        if (this.getSetting('discord.enabled') && this.getSetting('discord.onComplete')) {
            if (this.getSetting('discord.batchMode')) {
                this.addToBatch('discord', track);
            } else {
                await this.sendDiscordNotification(track);
            }
        }

        // Telegram
        if (this.getSetting('telegram.enabled') && this.getSetting('telegram.onComplete')) {
            await this.sendTelegramNotification(track);
        }
    }

    // Send Discord notification
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

    // Send Telegram notification
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

    // Notify download error
    async notifyDownloadError(track, error) {
        if (this.isQuietTime()) return;

        const title = 'Download Failed';
        const body = `${track.name} - ${error}`;

        // Browser notification
        if (this.getSetting('browser.onError')) {
            await this.sendPushNotification(title, body, {
                tag: 'soggfy-error',
                requireInteraction: true,
                type: 'download_error',
                trackId: track.id,
                trackName: track.name
            });
        }

        // Discord
        if (this.getSetting('discord.enabled') && this.getSetting('discord.onError')) {
            await this.sendDiscordNotification(track, true, error);
        }

        // Telegram
        if (this.getSetting('telegram.enabled') && this.getSetting('telegram.onError')) {
            await this.sendTelegramNotification(track, true, error);
        }
    }

    // Notify queue complete
    async notifyQueueComplete(stats) {
        if (this.isQuietTime()) return;

        const title = 'Queue Complete';
        const body = `Downloaded ${stats.completed} tracks (${stats.failed} failed)`;

        // Browser notification
        if (this.getSetting('browser.onQueueComplete')) {
            await this.sendPushNotification(title, body, {
                tag: 'soggfy-queue-complete',
                requireInteraction: true,
                type: 'queue_complete'
            });
        }

        // Discord
        if (this.getSetting('discord.enabled') && this.discord) {
            try {
                await this.discord.sendQueueCompleteNotification(stats);
                this.logNotification('queue_complete', 'discord', title, body, null, null, 'sent');
            } catch (err) {
                this.logNotification('queue_complete', 'discord', title, body, null, null, 'failed', err.message);
            }
        }

        // Telegram
        if (this.getSetting('telegram.enabled') && this.telegram) {
            try {
                await this.telegram.sendQueueCompleteNotification(stats);
                this.logNotification('queue_complete', 'telegram', title, body, null, null, 'sent');
            } catch (err) {
                this.logNotification('queue_complete', 'telegram', title, body, null, null, 'failed', err.message);
            }
        }
    }

    // Notify scheduled task complete
    async notifyScheduledTaskComplete(task, result) {
        if (this.isQuietTime()) return;

        const title = 'Scheduled Task Complete';
        const body = `${task.name}: ${result.tracksAdded} tracks added`;

        // Browser notification
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

    // Clean old history (keep last 30 days)
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
        // Process any remaining batched notifications
        this.processBatch('discord').catch(console.error);
    }
}

module.exports = NotificationManager;
```

#### webhooks/discord.js

```javascript
const axios = require('axios');

class DiscordWebhook {
    constructor(webhookUrl) {
        this.webhookUrl = webhookUrl;
    }

    async send(payload) {
        await axios.post(this.webhookUrl, payload);
    }

    async sendDownloadNotification(track) {
        const embed = {
            title: '🎵 Download Complete',
            description: `**${track.name}**\nby ${track.artist}`,
            color: 0x1DB954, // Spotify green
            thumbnail: track.albumArt ? { url: track.albumArt } : undefined,
            fields: [
                { name: 'Album', value: track.album || 'Unknown', inline: true },
                { name: 'Duration', value: this.formatDuration(track.duration), inline: true }
            ],
            timestamp: new Date().toISOString()
        };

        await this.send({ embeds: [embed] });
    }

    async sendErrorNotification(track, error) {
        const embed = {
            title: '❌ Download Failed',
            description: `**${track.name}**\nby ${track.artist}`,
            color: 0xFF4757, // Red
            fields: [
                { name: 'Error', value: error }
            ],
            timestamp: new Date().toISOString()
        };

        await this.send({ embeds: [embed] });
    }

    async sendQueueCompleteNotification(stats) {
        const embed = {
            title: '✅ Queue Complete',
            color: 0x1DB954,
            fields: [
                { name: 'Completed', value: stats.completed.toString(), inline: true },
                { name: 'Failed', value: stats.failed.toString(), inline: true },
                { name: 'Skipped', value: (stats.skipped || 0).toString(), inline: true }
            ],
            timestamp: new Date().toISOString()
        };

        await this.send({ embeds: [embed] });
    }

    async sendBatchNotification(tracks) {
        const trackList = tracks.slice(0, 10)
            .map(t => `• ${t.track_name} - ${t.track_artist}`)
            .join('\n');

        const embed = {
            title: `🎵 Downloaded ${tracks.length} Tracks`,
            description: trackList + (tracks.length > 10 ? `\n... and ${tracks.length - 10} more` : ''),
            color: 0x1DB954,
            timestamp: new Date().toISOString()
        };

        await this.send({ embeds: [embed] });
    }

    formatDuration(ms) {
        if (!ms) return 'Unknown';
        const minutes = Math.floor(ms / 60000);
        const seconds = Math.floor((ms % 60000) / 1000);
        return `${minutes}:${seconds.toString().padStart(2, '0')}`;
    }
}

module.exports = DiscordWebhook;
```

#### webhooks/telegram.js

```javascript
const axios = require('axios');

class TelegramBot {
    constructor(botToken, chatId) {
        this.botToken = botToken;
        this.chatId = chatId;
        this.apiUrl = `https://api.telegram.org/bot${botToken}`;
    }

    async sendMessage(text, options = {}) {
        await axios.post(`${this.apiUrl}/sendMessage`, {
            chat_id: this.chatId,
            text,
            parse_mode: 'HTML',
            ...options
        });
    }

    async sendPhoto(photoUrl, caption) {
        await axios.post(`${this.apiUrl}/sendPhoto`, {
            chat_id: this.chatId,
            photo: photoUrl,
            caption,
            parse_mode: 'HTML'
        });
    }

    async sendDownloadNotification(track) {
        const message = `
🎵 <b>Download Complete</b>

<b>${this.escapeHtml(track.name)}</b>
by ${this.escapeHtml(track.artist)}

💿 Album: ${this.escapeHtml(track.album || 'Unknown')}
⏱ Duration: ${this.formatDuration(track.duration)}
        `.trim();

        if (track.albumArt) {
            await this.sendPhoto(track.albumArt, message);
        } else {
            await this.sendMessage(message);
        }
    }

    async sendErrorNotification(track, error) {
        const message = `
❌ <b>Download Failed</b>

<b>${this.escapeHtml(track.name)}</b>
by ${this.escapeHtml(track.artist)}

Error: ${this.escapeHtml(error)}
        `.trim();

        await this.sendMessage(message);
    }

    async sendQueueCompleteNotification(stats) {
        const message = `
✅ <b>Queue Complete</b>

📥 Completed: ${stats.completed}
❌ Failed: ${stats.failed}
⏭ Skipped: ${stats.skipped || 0}
        `.trim();

        await this.sendMessage(message);
    }

    escapeHtml(text) {
        if (!text) return '';
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    formatDuration(ms) {
        if (!ms) return 'Unknown';
        const minutes = Math.floor(ms / 60000);
        const seconds = Math.floor((ms % 60000) / 1000);
        return `${minutes}:${seconds.toString().padStart(2, '0')}`;
    }
}

module.exports = TelegramBot;
```

#### API Endpoints

| Method | Endpoint                              | Description                   |
|--------|---------------------------------------|-------------------------------|
| GET    | `/api/notifications/settings`         | Get notification settings     |
| PUT    | `/api/notifications/settings`         | Update notification settings  |
| POST   | `/api/notifications/push/subscribe`   | Register push subscription    |
| POST   | `/api/notifications/push/unsubscribe` | Unregister push subscription  |
| GET    | `/api/notifications/push/subscriptions`| List push subscriptions      |
| GET    | `/api/notifications/vapid-key`        | Get VAPID public key          |
| POST   | `/api/notifications/test`             | Send test notification        |
| GET    | `/api/notifications/history`          | Get notification history      |
| GET    | `/api/notifications/stats`            | Get notification statistics   |
| DELETE | `/api/notifications/history`          | Clear notification history    |

#### server.js Integration

```javascript
const NotificationManager = require('./notificationManager');

// Share database with other features
const notifications = new NotificationManager(stats.db, {
    vapidPublicKey: process.env.VAPID_PUBLIC_KEY,
    vapidPrivateKey: process.env.VAPID_PRIVATE_KEY,
    vapidEmail: process.env.VAPID_EMAIL
});

// Graceful shutdown
process.on('SIGTERM', () => {
    notifications.shutdown();
    process.exit(0);
});

// Notification Routes
app.get('/api/notifications/settings', authMiddleware, (req, res) => {
    res.json(notifications.getAllSettings());
});

app.put('/api/notifications/settings', authMiddleware, (req, res) => {
    notifications.updateSettings(req.body);
    res.json({ success: true });
});

app.post('/api/notifications/push/subscribe', authMiddleware, (req, res) => {
    notifications.registerPushSubscription(req.body, req.headers['user-agent']);
    res.json({ success: true });
});

app.post('/api/notifications/push/unsubscribe', authMiddleware, (req, res) => {
    notifications.unregisterPushSubscription(req.body.endpoint);
    res.json({ success: true });
});

app.get('/api/notifications/push/subscriptions', authMiddleware, (req, res) => {
    const subscriptions = notifications.getPushSubscriptions();
    // Don't expose full keys, just endpoint info
    res.json(subscriptions.map(s => ({
        endpoint: s.endpoint.substring(0, 50) + '...',
        active: true
    })));
});

app.get('/api/notifications/vapid-key', (req, res) => {
    res.json({ key: process.env.VAPID_PUBLIC_KEY });
});

app.post('/api/notifications/test', authMiddleware, async (req, res) => {
    const { channel } = req.body;
    const results = await notifications.sendTestNotification(channel);
    res.json(results);
});

app.get('/api/notifications/history', authMiddleware, (req, res) => {
    const { type, channel, limit, offset } = req.query;
    res.json(notifications.getHistory({
        type,
        channel,
        limit: parseInt(limit) || 50,
        offset: parseInt(offset) || 0
    }));
});

app.get('/api/notifications/stats', authMiddleware, (req, res) => {
    res.json(notifications.getHistoryStats());
});

app.delete('/api/notifications/history', authMiddleware, (req, res) => {
    notifications.cleanHistory(0); // Delete all
    res.json({ success: true });
});
```

### Frontend Changes

#### New Components

```
soggfy-web/frontend/src/components/
├── Notifications/
│   ├── NotificationSettings.jsx    # Settings panel
│   ├── NotificationSettings.css    # Styles
│   ├── NotificationHistory.jsx     # History list
│   └── NotificationService.js      # Service worker registration
```

#### NotificationService.js

```javascript
class NotificationService {
    constructor() {
        this.swRegistration = null;
        this.vapidKey = null;
    }

    async init(apiBase) {
        if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
            console.log('Push notifications not supported');
            return false;
        }

        try {
            // Get VAPID key from server
            const response = await fetch(`${apiBase}/notifications/vapid-key`);
            const { key } = await response.json();
            this.vapidKey = key;

            this.swRegistration = await navigator.serviceWorker.register('/sw.js');
            return true;
        } catch (error) {
            console.error('Notification service init failed:', error);
            return false;
        }
    }

    async requestPermission() {
        const permission = await Notification.requestPermission();
        return permission === 'granted';
    }

    async subscribe(apiBase) {
        if (!this.swRegistration || !this.vapidKey) return null;

        const subscription = await this.swRegistration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: this.urlBase64ToUint8Array(this.vapidKey)
        });

        // Send subscription to backend
        await fetch(`${apiBase}/notifications/push/subscribe`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(subscription)
        });

        return subscription;
    }

    async unsubscribe(apiBase) {
        if (!this.swRegistration) return;

        const subscription = await this.swRegistration.pushManager.getSubscription();
        if (subscription) {
            await subscription.unsubscribe();

            await fetch(`${apiBase}/notifications/push/unsubscribe`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ endpoint: subscription.endpoint })
            });
        }
    }

    async isSubscribed() {
        if (!this.swRegistration) return false;
        const subscription = await this.swRegistration.pushManager.getSubscription();
        return !!subscription;
    }

    urlBase64ToUint8Array(base64String) {
        const padding = '='.repeat((4 - base64String.length % 4) % 4);
        const base64 = (base64String + padding)
            .replace(/-/g, '+')
            .replace(/_/g, '/');
        const rawData = window.atob(base64);
        const outputArray = new Uint8Array(rawData.length);
        for (let i = 0; i < rawData.length; ++i) {
            outputArray[i] = rawData.charCodeAt(i);
        }
        return outputArray;
    }
}

export default new NotificationService();
```

#### NotificationSettings.jsx

```jsx
import { useState, useEffect } from 'react';
import axios from 'axios';
import NotificationService from './NotificationService';
import NotificationHistory from './NotificationHistory';
import './NotificationSettings.css';

function NotificationSettings() {
    const [settings, setSettings] = useState(null);
    const [pushEnabled, setPushEnabled] = useState(false);
    const [stats, setStats] = useState({});
    const [testResults, setTestResults] = useState(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        fetchSettings();
        fetchStats();
        checkPushStatus();
    }, []);

    const fetchSettings = async () => {
        try {
            const response = await axios.get(`${API_BASE}/notifications/settings`);
            setSettings(response.data);
        } catch (error) {
            console.error('Failed to fetch settings:', error);
        } finally {
            setLoading(false);
        }
    };

    const fetchStats = async () => {
        try {
            const response = await axios.get(`${API_BASE}/notifications/stats`);
            setStats(response.data);
        } catch (error) {
            console.error('Failed to fetch stats:', error);
        }
    };

    const checkPushStatus = async () => {
        await NotificationService.init(API_BASE);
        const subscribed = await NotificationService.isSubscribed();
        setPushEnabled(subscribed);
    };

    const handleEnablePush = async () => {
        const granted = await NotificationService.requestPermission();
        if (granted) {
            await NotificationService.subscribe(API_BASE);
            setPushEnabled(true);
        }
    };

    const handleDisablePush = async () => {
        await NotificationService.unsubscribe(API_BASE);
        setPushEnabled(false);
    };

    const handleSave = async () => {
        try {
            await axios.put(`${API_BASE}/notifications/settings`, settings);
            alert('Settings saved');
        } catch (error) {
            alert('Failed to save settings');
        }
    };

    const handleTest = async (channel = 'all') => {
        setTestResults(null);
        try {
            const response = await axios.post(`${API_BASE}/notifications/test`, { channel });
            setTestResults(response.data);
        } catch (error) {
            setTestResults({ error: error.message });
        }
    };

    const updateSetting = (path, value) => {
        const newSettings = { ...settings };
        const parts = path.split('.');
        let current = newSettings;
        for (let i = 0; i < parts.length - 1; i++) {
            current = current[parts[i]];
        }
        current[parts[parts.length - 1]] = value;
        setSettings(newSettings);
    };

    if (loading) return <div>Loading...</div>;

    return (
        <div className="notification-settings">
            <h2>Notification Settings</h2>

            {/* Stats */}
            <section className="stats-section">
                <h3>Statistics</h3>
                <div className="stats-grid">
                    {Object.entries(stats).map(([channel, data]) => (
                        <div key={channel} className="stat-card">
                            <h4>{channel}</h4>
                            <div className="stat-row">
                                <span>Sent:</span>
                                <span>{data.sent}</span>
                            </div>
                            <div className="stat-row">
                                <span>Failed:</span>
                                <span>{data.failed}</span>
                            </div>
                            <div className="stat-row">
                                <span>Success Rate:</span>
                                <span>{data.successRate}%</span>
                            </div>
                        </div>
                    ))}
                </div>
            </section>

            {/* Browser Notifications */}
            <section>
                <h3>Browser Notifications</h3>
                <div className="push-status">
                    {!pushEnabled ? (
                        <button onClick={handleEnablePush} className="enable-btn">
                            Enable Push Notifications
                        </button>
                    ) : (
                        <button onClick={handleDisablePush} className="disable-btn">
                            Disable Push Notifications
                        </button>
                    )}
                </div>

                <label className="checkbox-label">
                    <input
                        type="checkbox"
                        checked={settings.browser?.onComplete}
                        onChange={e => updateSetting('browser.onComplete', e.target.checked)}
                    />
                    Notify on download complete
                </label>
                <label className="checkbox-label">
                    <input
                        type="checkbox"
                        checked={settings.browser?.onError}
                        onChange={e => updateSetting('browser.onError', e.target.checked)}
                    />
                    Notify on download error
                </label>
                <label className="checkbox-label">
                    <input
                        type="checkbox"
                        checked={settings.browser?.onQueueComplete}
                        onChange={e => updateSetting('browser.onQueueComplete', e.target.checked)}
                    />
                    Notify when queue completes
                </label>
                <label className="checkbox-label">
                    <input
                        type="checkbox"
                        checked={settings.browser?.sound}
                        onChange={e => updateSetting('browser.sound', e.target.checked)}
                    />
                    Play sound
                </label>
            </section>

            {/* Discord */}
            <section>
                <h3>Discord Webhook</h3>
                <label className="checkbox-label">
                    <input
                        type="checkbox"
                        checked={settings.discord?.enabled}
                        onChange={e => updateSetting('discord.enabled', e.target.checked)}
                    />
                    Enable Discord notifications
                </label>

                {settings.discord?.enabled && (
                    <>
                        <div className="form-group">
                            <label>Webhook URL</label>
                            <input
                                type="url"
                                placeholder="https://discord.com/api/webhooks/..."
                                value={settings.discord?.webhookUrl || ''}
                                onChange={e => updateSetting('discord.webhookUrl', e.target.value)}
                            />
                        </div>
                        <label className="checkbox-label">
                            <input
                                type="checkbox"
                                checked={settings.discord?.batchMode}
                                onChange={e => updateSetting('discord.batchMode', e.target.checked)}
                            />
                            Batch notifications (combine multiple downloads)
                        </label>
                    </>
                )}
            </section>

            {/* Telegram */}
            <section>
                <h3>Telegram Bot</h3>
                <label className="checkbox-label">
                    <input
                        type="checkbox"
                        checked={settings.telegram?.enabled}
                        onChange={e => updateSetting('telegram.enabled', e.target.checked)}
                    />
                    Enable Telegram notifications
                </label>

                {settings.telegram?.enabled && (
                    <>
                        <div className="form-group">
                            <label>Bot Token</label>
                            <input
                                type="password"
                                placeholder="123456:ABC-DEF..."
                                value={settings.telegram?.botToken || ''}
                                onChange={e => updateSetting('telegram.botToken', e.target.value)}
                            />
                        </div>
                        <div className="form-group">
                            <label>Chat ID</label>
                            <input
                                type="text"
                                placeholder="-1001234567890"
                                value={settings.telegram?.chatId || ''}
                                onChange={e => updateSetting('telegram.chatId', e.target.value)}
                            />
                        </div>
                    </>
                )}
            </section>

            {/* Quiet Hours */}
            <section>
                <h3>Quiet Hours</h3>
                <label className="checkbox-label">
                    <input
                        type="checkbox"
                        checked={settings.quietHours?.enabled}
                        onChange={e => updateSetting('quietHours.enabled', e.target.checked)}
                    />
                    Enable quiet hours (no notifications)
                </label>

                {settings.quietHours?.enabled && (
                    <div className="time-range">
                        <input
                            type="time"
                            value={settings.quietHours?.start || '22:00'}
                            onChange={e => updateSetting('quietHours.start', e.target.value)}
                        />
                        <span>to</span>
                        <input
                            type="time"
                            value={settings.quietHours?.end || '08:00'}
                            onChange={e => updateSetting('quietHours.end', e.target.value)}
                        />
                    </div>
                )}
            </section>

            {/* Actions */}
            <div className="actions">
                <button onClick={handleSave} className="save-btn">Save Settings</button>
                <button onClick={() => handleTest('all')} className="test-btn">Test All</button>
                <button onClick={() => handleTest('browser')} className="test-btn">Test Browser</button>
                <button onClick={() => handleTest('discord')} className="test-btn">Test Discord</button>
                <button onClick={() => handleTest('telegram')} className="test-btn">Test Telegram</button>
            </div>

            {testResults && (
                <div className="test-results">
                    <h4>Test Results</h4>
                    <pre>{JSON.stringify(testResults, null, 2)}</pre>
                </div>
            )}

            {/* History */}
            <NotificationHistory />
        </div>
    );
}

export default NotificationSettings;
```

#### NotificationHistory.jsx

```jsx
import { useState, useEffect } from 'react';
import axios from 'axios';

function NotificationHistory() {
    const [history, setHistory] = useState([]);
    const [filter, setFilter] = useState({ type: '', channel: '' });

    useEffect(() => {
        fetchHistory();
    }, [filter]);

    const fetchHistory = async () => {
        try {
            const params = {};
            if (filter.type) params.type = filter.type;
            if (filter.channel) params.channel = filter.channel;
            params.limit = 50;

            const response = await axios.get(`${API_BASE}/notifications/history`, { params });
            setHistory(response.data);
        } catch (error) {
            console.error('Failed to fetch history:', error);
        }
    };

    const handleClear = async () => {
        if (!confirm('Clear all notification history?')) return;
        try {
            await axios.delete(`${API_BASE}/notifications/history`);
            setHistory([]);
        } catch (error) {
            alert('Failed to clear history');
        }
    };

    const getStatusIcon = (status) => {
        switch (status) {
            case 'sent': return '✅';
            case 'failed': return '❌';
            case 'skipped': return '⏭️';
            default: return '❓';
        }
    };

    const getChannelIcon = (channel) => {
        switch (channel) {
            case 'browser': return '🌐';
            case 'discord': return '💬';
            case 'telegram': return '📱';
            default: return '📧';
        }
    };

    return (
        <section className="history-section">
            <div className="history-header">
                <h3>Notification History</h3>
                <button onClick={handleClear} className="clear-btn">Clear All</button>
            </div>

            <div className="filters">
                <select
                    value={filter.channel}
                    onChange={e => setFilter({ ...filter, channel: e.target.value })}
                >
                    <option value="">All Channels</option>
                    <option value="browser">Browser</option>
                    <option value="discord">Discord</option>
                    <option value="telegram">Telegram</option>
                </select>
                <select
                    value={filter.type}
                    onChange={e => setFilter({ ...filter, type: e.target.value })}
                >
                    <option value="">All Types</option>
                    <option value="download_complete">Download Complete</option>
                    <option value="download_error">Download Error</option>
                    <option value="queue_complete">Queue Complete</option>
                    <option value="scheduled_task">Scheduled Task</option>
                    <option value="test">Test</option>
                </select>
            </div>

            <div className="history-list">
                {history.length === 0 ? (
                    <div className="empty">No notifications yet</div>
                ) : (
                    history.map(item => (
                        <div key={item.id} className={`history-item status-${item.status}`}>
                            <span className="status-icon">{getStatusIcon(item.status)}</span>
                            <span className="channel-icon">{getChannelIcon(item.channel)}</span>
                            <div className="content">
                                <div className="title">{item.title}</div>
                                {item.body && <div className="body">{item.body}</div>}
                                {item.error && <div className="error">{item.error}</div>}
                            </div>
                            <div className="time">
                                {new Date(item.sentAt).toLocaleString()}
                            </div>
                        </div>
                    ))
                )}
            </div>
        </section>
    );
}

export default NotificationHistory;
```

#### public/sw.js (Service Worker)

```javascript
self.addEventListener('push', event => {
    const data = event.data.json();

    const options = {
        body: data.body,
        icon: data.icon || '/logo192.png',
        badge: '/badge.png',
        tag: data.tag,
        data: data.data,
        requireInteraction: data.requireInteraction,
        silent: !data.sound
    };

    event.waitUntil(
        self.registration.showNotification(data.title, options)
    );
});

self.addEventListener('notificationclick', event => {
    event.notification.close();

    event.waitUntil(
        clients.matchAll({ type: 'window' }).then(clientList => {
            if (clientList.length > 0) {
                return clientList[0].focus();
            }
            return clients.openWindow('/');
        })
    );
});
```

### Data Storage

**Location:** `%localappdata%/Soggfy/stats.db` (shared SQLite database)

**Why SQLite over JSON/Memory?**

| Feature                 | JSON/Memory                       | SQLite                               |
|-------------------------|-----------------------------------|--------------------------------------|
| Push subscriptions      | Lost on restart                   | Persistent                           |
| Notification history    | Not implemented                   | Full history with filtering          |
| Settings storage        | Separate JSON file                | Same database                        |
| Batch queue             | Memory only                       | Persistent across restarts           |
| Statistics              | Manual calculation                | SQL aggregation                      |
| Filtering               | Not possible                      | Indexed queries                      |

**Database Size Estimate:**
- 1 push subscription ~200 bytes
- 1 notification history entry ~200 bytes
- 1 setting entry ~50 bytes
- 10 subscriptions + 5000 history + 20 settings ~1.2 MB

## .env Additions

```env
# Push Notifications (generate with: npx web-push generate-vapid-keys)
VAPID_PUBLIC_KEY=your_public_key
VAPID_PRIVATE_KEY=your_private_key
VAPID_EMAIL=admin@example.com
```

## UI Design

### Notification Settings

```
┌─────────────────────────────────────────────────────────────────┐
│  🔔 Notification Settings                                       │
├─────────────────────────────────────────────────────────────────┤
│  📊 STATISTICS                                                  │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐               │
│  │   Browser   │ │   Discord   │ │  Telegram   │               │
│  │  Sent: 142  │ │  Sent: 89   │ │  Sent: 45   │               │
│  │ Failed: 3   │ │ Failed: 1   │ │ Failed: 2   │               │
│  │  Rate: 98%  │ │  Rate: 99%  │ │  Rate: 96%  │               │
│  └─────────────┘ └─────────────┘ └─────────────┘               │
├─────────────────────────────────────────────────────────────────┤
│  🌐 BROWSER NOTIFICATIONS                                       │
│                                                                 │
│  [✅ Push notifications enabled]     [Disable]                  │
│                                                                 │
│  [✓] Notify on download complete                                │
│  [✓] Notify on download error                                   │
│  [✓] Notify when queue completes                                │
│  [✓] Play sound                                                 │
├─────────────────────────────────────────────────────────────────┤
│  💬 DISCORD WEBHOOK                                             │
│                                                                 │
│  [✓] Enable Discord notifications                               │
│  Webhook URL: [https://discord.com/api/webhooks/...        ]   │
│  [ ] Batch notifications (combine multiple downloads)           │
│                                        [Test Discord]           │
├─────────────────────────────────────────────────────────────────┤
│  📱 TELEGRAM BOT                                                │
│                                                                 │
│  [✓] Enable Telegram notifications                              │
│  Bot Token: [••••••••••••••••••••                          ]   │
│  Chat ID:   [-1001234567890                                ]   │
│                                        [Test Telegram]          │
├─────────────────────────────────────────────────────────────────┤
│  🌙 QUIET HOURS                                                 │
│                                                                 │
│  [✓] Enable quiet hours                                         │
│  From: [22:00] to [08:00]                                       │
├─────────────────────────────────────────────────────────────────┤
│                    [Save Settings]  [Test All]                  │
├─────────────────────────────────────────────────────────────────┤
│  📜 NOTIFICATION HISTORY                        [Clear All]     │
│  Filter: [All Channels ▼] [All Types ▼]                        │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ ✅ 🌐 Download Complete                                    │  │
│  │    Bohemian Rhapsody - Queen           2 minutes ago      │  │
│  ├───────────────────────────────────────────────────────────┤  │
│  │ ✅ 💬 Download Complete                                    │  │
│  │    Bohemian Rhapsody - Queen           2 minutes ago      │  │
│  ├───────────────────────────────────────────────────────────┤  │
│  │ ❌ 📱 Download Complete                                    │  │
│  │    We Will Rock You - Queen            5 minutes ago      │  │
│  │    Error: Telegram API timeout                            │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

## Testing

1. Enable browser push notifications and verify permission
2. Verify notifications appear on download complete
3. Test Discord webhook with test message
4. Test Telegram bot with test message
5. Verify quiet hours work correctly (no notifications during quiet time)
6. Test batch notifications (Discord)
7. Test error notifications
8. Verify push subscriptions persist after restart
9. Verify notification history is recorded correctly
10. Test filtering in history

## Security Considerations

- Bot tokens stored in database (consider encryption for production)
- VAPID keys stored in environment variables (secure)
- Webhook URLs validated before saving
- Push subscription endpoints not fully exposed in API

## Performance Considerations

- **Prepared statements**: All database operations use prepared statements
- **Indexed columns**: type, channel, status, sent_at for fast filtering
- **Batch processing**: Discord notifications can be batched to reduce API calls
- **Automatic cleanup**: Old history entries cleaned periodically

## Future Enhancements

- Email notifications
- Slack integration
- Custom webhook support (generic webhooks)
- Notification templates (customizable messages)
- Mobile app push notifications
- Per-playlist notification settings
- Notification scheduling (delayed notifications)
- Retry failed notifications
