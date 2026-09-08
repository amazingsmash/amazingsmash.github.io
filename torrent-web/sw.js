import fileResponse from './worker-server.js'

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', () => self.clients.claim())
self.addEventListener('fetch', event => {
  const response = fileResponse(event)
  if (response) event.respondWith(response)
})
