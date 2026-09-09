(() => {
  const storageKey = 'torrent-web-debug-log-v1'
  const maxEntries = 180
  const maxMessageLength = 2500
  const original = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console)
  }

  function stringify(value) {
    if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack || ''}`
    if (typeof value === 'string') return value
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }

  function readEntries() {
    try {
      const parsed = JSON.parse(localStorage.getItem(storageKey) || '[]')
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }

  function writeEntry(level, args) {
    try {
      const entries = readEntries()
      const message = args.map(stringify).join(' ').slice(0, maxMessageLength)
      entries.push({
        time: new Date().toISOString(),
        level,
        message
      })
      if (entries.length > maxEntries) entries.splice(0, entries.length - maxEntries)
      localStorage.setItem(storageKey, JSON.stringify(entries))
    } catch {
      // Logging must never break the application.
    }
  }

  for (const level of ['log', 'info', 'warn', 'error']) {
    console[level] = (...args) => {
      writeEntry(level, args)
      original[level](...args)
    }
  }

  window.addEventListener('error', event => {
    writeEntry('error', [
      'WINDOW ERROR',
      event.message,
      event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : '',
      event.error || ''
    ])
  })

  window.addEventListener('unhandledrejection', event => {
    writeEntry('error', ['UNHANDLED REJECTION', event.reason])
  })

  window.addEventListener('pagehide', event => {
    writeEntry('info', [`PAGEHIDE persisted=${event.persisted}`])
  })

  document.addEventListener('visibilitychange', () => {
    writeEntry('info', [`VISIBILITY ${document.visibilityState}`])
  })

  const previousEntries = readEntries()
  if (previousEntries.length > 0) {
    original.warn(`Previous session log available: ${previousEntries.length} entries`)
    for (const entry of previousEntries.slice(-40)) {
      original[entry.level](`[previous ${entry.time}] ${entry.message}`)
    }
  }

  window.torrentWebDebug = {
    getLog() {
      return readEntries()
    },
    getText() {
      return readEntries()
        .map(entry => `[${entry.time}] ${entry.level.toUpperCase()} ${entry.message}`)
        .join('\n')
    },
    clear() {
      localStorage.removeItem(storageKey)
      original.info('Persistent debug log cleared')
    },
    copy: async function () {
      const text = this.getText()
      await navigator.clipboard.writeText(text)
      original.info('Persistent debug log copied')
    }
  }

  writeEntry('info', [
    'SESSION START',
    navigator.userAgent,
    `online=${navigator.onLine}`,
    `serviceWorker=${'serviceWorker' in navigator}`,
    `WebRTC=${Boolean(window.RTCPeerConnection)}`
  ])

  if (window.eruda) {
    try {
      window.eruda.init()
      original.info('Eruda mobile console initialized')
    } catch (error) {
      original.error('Eruda initialization failed', error)
    }
  }
})()
