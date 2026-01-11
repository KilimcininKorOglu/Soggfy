# Notifications Feature

**Branch:** `feature/notifications`

## Overview

Add notification capabilities to alert users about download completions, errors, and other events through browser notifications and external services like Discord and Telegram webhooks.

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

## Technical Implementation

### Backend Changes

#### New Dependencies

```bash
cd soggfy-web/backend
npm install web-push node-telegram-bot-api
```

#### New Files

```
soggfy-web/backend/
├── notificationManager.js    # Notification routing and management
├── webhooks/
│   ├── discord.js            # Discord webhook handler
│   └── telegram.js           # Telegram bot handler
├── notifications.json        # Notification settings storage
```

#### notificationManager.js

```javascript
const webpush = require('web-push');
const DiscordWebhook = require('./webhooks/discord');
const TelegramBot = require('./webhooks/telegram');
const fs = require('fs');

class NotificationManager {
  constructor(config) {
    this.config = config;
    this.settings = this.loadSettings();
    this.pushSubscriptions = new Map();
    
    // Initialize VAPID keys for web push
    if (config.vapidPublicKey && config.vapidPrivateKey) {
      webpush.setVapidDetails(
        'mailto:' + (config.email || 'admin@localhost'),
        config.vapidPublicKey,
        config.vapidPrivateKey
      );
    }

    // Initialize Discord webhook
    if (this.settings.discord?.webhookUrl) {
      this.discord = new DiscordWebhook(this.settings.discord.webhookUrl);
    }

    // Initialize Telegram bot
    if (this.settings.telegram?.botToken && this.settings.telegram?.chatId) {
      this.telegram = new TelegramBot(
        this.settings.telegram.botToken,
        this.settings.telegram.chatId
      );
    }
  }

  loadSettings() {
    try {
      return JSON.parse(fs.readFileSync('notifications.json', 'utf8'));
    } catch {
      return {
        browser: {
          enabled: true,
          onComplete: true,
          onError: true,
          onQueueComplete: true,
          onScheduledTask: true,
          sound: true
        },
        discord: {
          enabled: false,
          webhookUrl: '',
          onComplete: true,
          onError: true,
          batchMode: false,
          batchInterval: 60000 // 1 minute
        },
        telegram: {
          enabled: false,
          botToken: '',
          chatId: '',
          onComplete: true,
          onError: true
        },
        quietHours: {
          enabled: false,
          start: '22:00',
          end: '08:00'
        }
      };
    }
  }

  saveSettings() {
    fs.writeFileSync('notifications.json', JSON.stringify(this.settings, null, 2));
  }

  updateSettings(updates) {
    this.settings = { ...this.settings, ...updates };
    this.saveSettings();
    this.reinitialize();
  }

  reinitialize() {
    if (this.settings.discord?.webhookUrl) {
      this.discord = new DiscordWebhook(this.settings.discord.webhookUrl);
    }
    if (this.settings.telegram?.botToken && this.settings.telegram?.chatId) {
      this.telegram = new TelegramBot(
        this.settings.telegram.botToken,
        this.settings.telegram.chatId
      );
    }
  }

  // Check if notifications should be sent (quiet hours)
  isQuietTime() {
    if (!this.settings.quietHours?.enabled) return false;
    
    const now = new Date();
    const currentTime = now.getHours() * 60 + now.getMinutes();
    
    const [startH, startM] = this.settings.quietHours.start.split(':').map(Number);
    const [endH, endM] = this.settings.quietHours.end.split(':').map(Number);
    
    const startTime = startH * 60 + startM;
    const endTime = endH * 60 + endM;
    
    if (startTime < endTime) {
      return currentTime >= startTime && currentTime < endTime;
    } else {
      // Quiet hours span midnight
      return currentTime >= startTime || currentTime < endTime;
    }
  }

  // Register push subscription
  registerPushSubscription(subscription) {
    const id = JSON.stringify(subscription.keys);
    this.pushSubscriptions.set(id, subscription);
  }

  // Unregister push subscription
  unregisterPushSubscription(subscription) {
    const id = JSON.stringify(subscription.keys);
    this.pushSubscriptions.delete(id);
  }

  // Send browser push notification
  async sendPushNotification(title, body, options = {}) {
    if (!this.settings.browser?.enabled) return;
    if (this.isQuietTime()) return;

    const payload = JSON.stringify({
      title,
      body,
      icon: options.icon || '/logo192.png',
      badge: '/badge.png',
      tag: options.tag || 'soggfy',
      data: options.data,
      requireInteraction: options.requireInteraction || false
    });

    const promises = [];
    for (const [id, subscription] of this.pushSubscriptions) {
      promises.push(
        webpush.sendNotification(subscription, payload).catch(error => {
          if (error.statusCode === 410) {
            // Subscription expired, remove it
            this.pushSubscriptions.delete(id);
          }
          console.error('Push notification failed:', error);
        })
      );
    }

    await Promise.all(promises);
  }

  // Notify download complete
  async notifyDownloadComplete(track) {
    if (this.isQuietTime()) return;

    const title = 'Download Complete';
    const body = `${track.name} - ${track.artist}`;
    const icon = track.albumArt;

    // Browser notification
    if (this.settings.browser?.onComplete) {
      await this.sendPushNotification(title, body, { icon });
    }

    // Discord
    if (this.settings.discord?.enabled && this.settings.discord?.onComplete) {
      await this.discord?.sendDownloadNotification(track);
    }

    // Telegram
    if (this.settings.telegram?.enabled && this.settings.telegram?.onComplete) {
      await this.telegram?.sendDownloadNotification(track);
    }
  }

  // Notify download error
  async notifyDownloadError(track, error) {
    if (this.isQuietTime()) return;

    const title = 'Download Failed';
    const body = `${track.name} - ${error}`;

    // Browser notification
    if (this.settings.browser?.onError) {
      await this.sendPushNotification(title, body, {
        tag: 'soggfy-error',
        requireInteraction: true
      });
    }

    // Discord
    if (this.settings.discord?.enabled && this.settings.discord?.onError) {
      await this.discord?.sendErrorNotification(track, error);
    }

    // Telegram
    if (this.settings.telegram?.enabled && this.settings.telegram?.onError) {
      await this.telegram?.sendErrorNotification(track, error);
    }
  }

  // Notify queue complete
  async notifyQueueComplete(stats) {
    if (this.isQuietTime()) return;

    const title = 'Queue Complete';
    const body = `Downloaded ${stats.completed} tracks (${stats.failed} failed)`;

    // Browser notification
    if (this.settings.browser?.onQueueComplete) {
      await this.sendPushNotification(title, body, {
        tag: 'soggfy-queue-complete',
        requireInteraction: true
      });
    }

    // Discord
    if (this.settings.discord?.enabled) {
      await this.discord?.sendQueueCompleteNotification(stats);
    }

    // Telegram
    if (this.settings.telegram?.enabled) {
      await this.telegram?.sendQueueCompleteNotification(stats);
    }
  }

  // Notify scheduled task complete
  async notifyScheduledTaskComplete(task, result) {
    if (this.isQuietTime()) return;

    const title = 'Scheduled Task Complete';
    const body = `${task.name}: ${result.tracksAdded} tracks added`;

    // Browser notification
    if (this.settings.browser?.onScheduledTask) {
      await this.sendPushNotification(title, body, {
        tag: 'soggfy-scheduled'
      });
    }
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
    try {
      await axios.post(this.webhookUrl, payload);
    } catch (error) {
      console.error('Discord webhook failed:', error.message);
    }
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
        { name: 'Skipped', value: stats.skipped.toString(), inline: true }
      ],
      timestamp: new Date().toISOString()
    };

    await this.send({ embeds: [embed] });
  }

  formatDuration(ms) {
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
    try {
      await axios.post(`${this.apiUrl}/sendMessage`, {
        chat_id: this.chatId,
        text,
        parse_mode: 'HTML',
        ...options
      });
    } catch (error) {
      console.error('Telegram message failed:', error.message);
    }
  }

  async sendPhoto(photoUrl, caption) {
    try {
      await axios.post(`${this.apiUrl}/sendPhoto`, {
        chat_id: this.chatId,
        photo: photoUrl,
        caption,
        parse_mode: 'HTML'
      });
    } catch (error) {
      console.error('Telegram photo failed:', error.message);
    }
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
⏭ Skipped: ${stats.skipped}
    `.trim();

    await this.sendMessage(message);
  }

  escapeHtml(text) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  formatDuration(ms) {
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  }
}

module.exports = TelegramBot;
```

#### API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/notifications/settings` | Get notification settings |
| PUT | `/api/notifications/settings` | Update notification settings |
| POST | `/api/notifications/push/subscribe` | Register push subscription |
| POST | `/api/notifications/push/unsubscribe` | Unregister push subscription |
| GET | `/api/notifications/vapid-key` | Get VAPID public key |
| POST | `/api/notifications/test` | Send test notification |

### Frontend Changes

#### New Components

```
soggfy-web/frontend/src/components/
├── Notifications/
│   ├── NotificationSettings.jsx    # Settings panel
│   ├── NotificationSettings.css    # Styles
│   └── NotificationService.js      # Service worker registration
```

#### NotificationService.js

```javascript
const VAPID_PUBLIC_KEY = 'your-vapid-public-key';

class NotificationService {
  constructor() {
    this.swRegistration = null;
  }

  async init() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      console.log('Push notifications not supported');
      return false;
    }

    try {
      this.swRegistration = await navigator.serviceWorker.register('/sw.js');
      return true;
    } catch (error) {
      console.error('Service worker registration failed:', error);
      return false;
    }
  }

  async requestPermission() {
    const permission = await Notification.requestPermission();
    return permission === 'granted';
  }

  async subscribe(apiBase) {
    if (!this.swRegistration) return null;

    const subscription = await this.swRegistration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: this.urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
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
        body: JSON.stringify(subscription)
      });
    }
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
    requireInteraction: data.requireInteraction
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

#### NotificationSettings.jsx

```jsx
function NotificationSettings({ settings, onUpdate }) {
  const [localSettings, setLocalSettings] = useState(settings);
  const [pushEnabled, setPushEnabled] = useState(false);

  useEffect(() => {
    checkPushStatus();
  }, []);

  const checkPushStatus = async () => {
    if ('Notification' in window) {
      setPushEnabled(Notification.permission === 'granted');
    }
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

  const handleSave = () => {
    onUpdate(localSettings);
  };

  return (
    <div className="notification-settings">
      <h3>Notification Settings</h3>

      <section>
        <h4>Browser Notifications</h4>
        {!pushEnabled ? (
          <button onClick={handleEnablePush}>Enable Push Notifications</button>
        ) : (
          <button onClick={handleDisablePush}>Disable Push Notifications</button>
        )}
        
        <label>
          <input
            type="checkbox"
            checked={localSettings.browser?.onComplete}
            onChange={e => setLocalSettings({
              ...localSettings,
              browser: { ...localSettings.browser, onComplete: e.target.checked }
            })}
          />
          Notify on download complete
        </label>
        {/* More options... */}
      </section>

      <section>
        <h4>Discord Webhook</h4>
        <label>
          <input
            type="checkbox"
            checked={localSettings.discord?.enabled}
            onChange={e => setLocalSettings({
              ...localSettings,
              discord: { ...localSettings.discord, enabled: e.target.checked }
            })}
          />
          Enable Discord notifications
        </label>
        
        {localSettings.discord?.enabled && (
          <input
            type="url"
            placeholder="Webhook URL"
            value={localSettings.discord?.webhookUrl || ''}
            onChange={e => setLocalSettings({
              ...localSettings,
              discord: { ...localSettings.discord, webhookUrl: e.target.value }
            })}
          />
        )}
      </section>

      <section>
        <h4>Telegram Bot</h4>
        <label>
          <input
            type="checkbox"
            checked={localSettings.telegram?.enabled}
            onChange={e => setLocalSettings({
              ...localSettings,
              telegram: { ...localSettings.telegram, enabled: e.target.checked }
            })}
          />
          Enable Telegram notifications
        </label>
        
        {localSettings.telegram?.enabled && (
          <>
            <input
              type="text"
              placeholder="Bot Token"
              value={localSettings.telegram?.botToken || ''}
              onChange={e => setLocalSettings({
                ...localSettings,
                telegram: { ...localSettings.telegram, botToken: e.target.value }
              })}
            />
            <input
              type="text"
              placeholder="Chat ID"
              value={localSettings.telegram?.chatId || ''}
              onChange={e => setLocalSettings({
                ...localSettings,
                telegram: { ...localSettings.telegram, chatId: e.target.value }
              })}
            />
          </>
        )}
      </section>

      <section>
        <h4>Quiet Hours</h4>
        <label>
          <input
            type="checkbox"
            checked={localSettings.quietHours?.enabled}
            onChange={e => setLocalSettings({
              ...localSettings,
              quietHours: { ...localSettings.quietHours, enabled: e.target.checked }
            })}
          />
          Enable quiet hours
        </label>
        
        {localSettings.quietHours?.enabled && (
          <div className="time-range">
            <input
              type="time"
              value={localSettings.quietHours?.start || '22:00'}
              onChange={e => setLocalSettings({
                ...localSettings,
                quietHours: { ...localSettings.quietHours, start: e.target.value }
              })}
            />
            <span>to</span>
            <input
              type="time"
              value={localSettings.quietHours?.end || '08:00'}
              onChange={e => setLocalSettings({
                ...localSettings,
                quietHours: { ...localSettings.quietHours, end: e.target.value }
              })}
            />
          </div>
        )}
      </section>

      <button onClick={handleSave}>Save Settings</button>
      <button onClick={() => sendTestNotification()}>Send Test</button>
    </div>
  );
}
```

## .env Additions

```env
# Push Notifications (generate with web-push generate-vapid-keys)
VAPID_PUBLIC_KEY=your_public_key
VAPID_PRIVATE_KEY=your_private_key
VAPID_EMAIL=admin@example.com
```

## Testing

1. Enable browser push notifications
2. Verify notifications appear on download complete
3. Test Discord webhook with test message
4. Test Telegram bot with test message
5. Verify quiet hours work correctly
6. Test batch notifications
7. Test error notifications

## Future Enhancements

- Email notifications
- Slack integration
- Custom webhook support
- Notification templates
- Mobile app push notifications
- Notification history/log
