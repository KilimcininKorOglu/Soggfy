const axios = require('axios');

class DiscordWebhook {
    constructor(webhookUrl) {
        this.webhookUrl = webhookUrl;
    }

    async send(payload) {
        await axios.post(this.webhookUrl, payload, {
            headers: {
                'Content-Type': 'application/json'
            }
        });
    }

    async sendDownloadNotification(track) {
        const embed = {
            title: 'Download Complete',
            description: `**${track.name}**\nby ${track.artist}`,
            color: 0x1DB954,
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
            title: 'Download Failed',
            description: `**${track.name}**\nby ${track.artist}`,
            color: 0xFF4757,
            fields: [
                { name: 'Error', value: error || 'Unknown error' }
            ],
            timestamp: new Date().toISOString()
        };

        await this.send({ embeds: [embed] });
    }

    async sendQueueCompleteNotification(stats) {
        const embed = {
            title: 'Queue Complete',
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
            .map(t => `- ${t.track_name} - ${t.track_artist}`)
            .join('\n');

        const embed = {
            title: `Downloaded ${tracks.length} Tracks`,
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
