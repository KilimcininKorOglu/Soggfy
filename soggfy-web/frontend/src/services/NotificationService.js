const API_BASE = 'http://localhost:3001/api';

class NotificationService {
    constructor() {
        this.swRegistration = null;
        this.vapidKey = null;
    }

    async init() {
        if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
            console.log('Push notifications not supported');
            return false;
        }

        try {
            const response = await fetch(`${API_BASE}/notifications/vapid-key`);
            const { key } = await response.json();
            this.vapidKey = key;

            if (!this.vapidKey) {
                console.log('VAPID key not configured');
                return false;
            }

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

    async subscribe(sessionId = null) {
        if (!this.swRegistration || !this.vapidKey) return null;

        try {
            const subscription = await this.swRegistration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: this.urlBase64ToUint8Array(this.vapidKey)
            });

            const headers = {
                'Content-Type': 'application/json'
            };
            if (sessionId) {
                headers['X-Session-ID'] = sessionId;
            }

            await fetch(`${API_BASE}/notifications/push/subscribe`, {
                method: 'POST',
                headers,
                body: JSON.stringify(subscription)
            });

            return subscription;
        } catch (error) {
            console.error('Failed to subscribe:', error);
            return null;
        }
    }

    async unsubscribe(sessionId = null) {
        if (!this.swRegistration) return;

        try {
            const subscription = await this.swRegistration.pushManager.getSubscription();
            if (subscription) {
                await subscription.unsubscribe();

                const headers = {
                    'Content-Type': 'application/json'
                };
                if (sessionId) {
                    headers['X-Session-ID'] = sessionId;
                }

                await fetch(`${API_BASE}/notifications/push/unsubscribe`, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ endpoint: subscription.endpoint })
                });
            }
        } catch (error) {
            console.error('Failed to unsubscribe:', error);
        }
    }

    async isSubscribed() {
        if (!this.swRegistration) return false;
        try {
            const subscription = await this.swRegistration.pushManager.getSubscription();
            return !!subscription;
        } catch (error) {
            return false;
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

const notificationService = new NotificationService();
export default notificationService;
