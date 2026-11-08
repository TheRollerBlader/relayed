self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : { title: 'RelayAid', body: 'A follow-up about your case', url: '/' }
  event.waitUntil(self.registration.showNotification(data.title || 'RelayAid', { body: data.body, data }))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = event.notification.data?.url || '/'
  event.waitUntil(self.clients.openWindow(url))
})
