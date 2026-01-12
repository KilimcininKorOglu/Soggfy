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
        const message = `<b>Download Complete</b>

<b>${this.escapeHtml(track.name)}</b>
by ${this.escapeHtml(track.artist)}

Album: ${this.escapeHtml(track.album || 'Unknown')}
Duration: ${this.formatDuration(track.duration)}`;

        if (track.albumArt) {
            try {
                await this.sendPhoto(track.albumArt, message);
            } catch (err) {
                await this.sendMessage(message);
            }
        } else {
            await this.sendMessage(message);
        }
    }

    async sendErrorNotification(track, error) {
        const message = `<b>Download Failed</b>

<b>${this.escapeHtml(track.name)}</b>
by ${this.escapeHtml(track.artist)}

Error: ${this.escapeHtml(error || 'Unknown error')}`;

        await this.sendMessage(message);
    }

    async sendQueueCompleteNotification(stats) {
        const message = `<b>Queue Complete</b>

Completed: ${stats.completed}
Failed: ${stats.failed}
Skipped: ${stats.skipped || 0}`;

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
