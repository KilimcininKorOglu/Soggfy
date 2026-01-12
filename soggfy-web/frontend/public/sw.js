self.addEventListener('push', event => {
    let data = {};
    try {
        data = event.data.json();
    } catch (e) {
        data = {
            title: 'Soggfy',
            body: event.data.text()
        };
    }

    const options = {
        body: data.body || '',
        icon: data.icon || '/logo192.png',
        badge: '/badge.png',
        tag: data.tag || 'soggfy',
        data: data.data,
        requireInteraction: data.requireInteraction || false,
        silent: !data.sound
    };

    event.waitUntil(
        self.registration.showNotification(data.title || 'Soggfy', options)
    );
});

self.addEventListener('notificationclick', event => {
    event.notification.close();

    event.waitUntil(
        clients.matchAll({ type: 'window' }).then(clientList => {
            for (const client of clientList) {
                if (client.url.includes(self.location.origin) && 'focus' in client) {
                    return client.focus();
                }
            }
            if (clients.openWindow) {
                return clients.openWindow('/');
            }
        })
    );
});

self.addEventListener('install', event => {
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    event.waitUntil(clients.claim());
});
