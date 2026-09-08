import WebTorrent from 'https://esm.sh/webtorrent@3.0.21/dist/webtorrent.min.js'

const DEFAULT_TRACKERS = [
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.webtorrent.dev',
  'wss://tracker.btorrent.xyz'
]

const DEMO_MAGNET = 'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel&tr=wss%3A%2F%2Ftracker.btorrent.xyz&tr=wss%3A%2F%2Ftracker.openwebtorrent.com&tr=wss%3A%2F%2Ftracker.webtorrent.dev&ws=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2F&xs=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2Fsintel.torrent'

const elements = {
  runtimeBadge: document.querySelector('#runtimeBadge'),
  magnetInput: document.querySelector('#magnetInput'),
  addMagnetButton: document.querySelector('#addMagnetButton'),
  demoButton: document.querySelector('#demoButton'),
  torrentFileInput: document.querySelector('#torrentFileInput'),
  statusCard: document.querySelector('#statusCard'),
  torrentName: document.querySelector('#torrentName'),
  stopButton: document.querySelector('#stopButton'),
  retryButton: document.querySelector('#retryButton'),
  copyLogButton: document.querySelector('#copyLogButton'),
  progressBar: document.querySelector('#progressBar'),
  progressText: document.querySelector('#progressText'),
  amountText: document.querySelector('#amountText'),
  peersText: document.querySelector('#peersText'),
  downloadSpeedText: document.querySelector('#downloadSpeedText'),
  uploadSpeedText: document.querySelector('#uploadSpeedText'),
  etaText: document.querySelector('#etaText'),
  notice: document.querySelector('#notice'),
  filesSection: document.querySelector('#filesSection'),
  filesList: document.querySelector('#filesList'),
  phaseText: document.querySelector('#phaseText'),
  elapsedText: document.querySelector('#elapsedText'),
  infoHashText: document.querySelector('#infoHashText'),
  metadataText: document.querySelector('#metadataText'),
  discoveredText: document.querySelector('#discoveredText'),
  connectedText: document.querySelector('#connectedText'),
  sourceList: document.querySelector('#sourceList'),
  debugLog: document.querySelector('#debugLog')
}

const client = new WebTorrent()
let activeTorrent = null
let refreshTimer = null
let streamingAvailable = false
let currentTorrentId = null
let metadataWatchdog = null
let discoveryPoll = null
let sessionStartedAt = 0
let metadataLoaded = false
let discoveredPeers = 0
let connectedPeers = 0
let debugEntries = []
const attachedDiscoveries = new WeakSet()

client.on('error', error => {
  logDiagnostic('CLIENT ERROR', error.message)
  setNotice(error.message, 'error')
})

async function initializeStreaming () {
  logDiagnostic('BOOT', `WebTorrent 3.0.21; WebRTC=${Boolean(window.RTCPeerConnection)}; WebSocket=${Boolean(window.WebSocket)}; online=${navigator.onLine}`)
  logDiagnostic('BOOT', navigator.userAgent)

  if (!('serviceWorker' in navigator)) {
    elements.runtimeBadge.textContent = 'Blob mode'
    logDiagnostic('SERVICE WORKER', 'Not supported by this browser')
    return
  }

  try {
    const registration = await navigator.serviceWorker.register('./sw.js', {
      scope: './',
      type: 'module'
    })
    await navigator.serviceWorker.ready
    client.createServer({ controller: registration })
    streamingAvailable = true
    elements.runtimeBadge.textContent = 'Streaming ready'
    logDiagnostic('SERVICE WORKER', 'Streaming server ready')
  } catch (error) {
    console.warn('Service worker streaming unavailable', error)
    elements.runtimeBadge.textContent = 'Blob mode'
    logDiagnostic('SERVICE WORKER', `Streaming unavailable: ${error.message}`)
  }
}

function addTorrent (torrentId) {
  stopActiveTorrent()
  resetStatus()
  currentTorrentId = torrentId
  sessionStartedAt = Date.now()
  elements.statusCard.classList.remove('hidden')
  setPhase('Starting')
  setNotice('Creating torrent session and looking for metadata…')
  inspectInputSources(torrentId)

  try {
    const torrent = client.add(
      torrentId,
      {
        announce: DEFAULT_TRACKERS,
        noPeersIntervalTime: 10
      },
      onTorrentReady
    )

    activeTorrent = torrent
    attachTorrentDiagnostics(torrent)
    updateStats(torrent)

    refreshTimer = window.setInterval(() => {
      updateStats(torrent)
      attachDiscoveryDiagnostics(torrent)
    }, 500)

    discoveryPoll = window.setInterval(() => {
      if (attachDiscoveryDiagnostics(torrent)) {
        clearInterval(discoveryPoll)
        discoveryPoll = null
      }
    }, 100)

    metadataWatchdog = window.setTimeout(() => {
      if (torrent !== activeTorrent || metadataLoaded) return

      if (connectedPeers === 0 && discoveredPeers === 0) {
        setPhase('No compatible peers')
        setNotice(
          'No metadata after 12 seconds and no WebRTC peers were discovered. The most likely cause is that this swarm only has traditional TCP/uTP peers, or its WebSocket trackers are unavailable to Safari.',
          'error'
        )
        logDiagnostic('DIAGNOSIS', 'No metadata, no discovered peers, no connected wires after 12 seconds')
      } else if (connectedPeers === 0) {
        setPhase('Peer negotiation')
        setNotice(
          'Peers were discovered, but no WebRTC connection has completed yet. This points to WebRTC negotiation, NAT/firewall, or incompatible peers.',
          'error'
        )
        logDiagnostic('DIAGNOSIS', 'Peers discovered but no connected wires after 12 seconds')
      } else {
        setPhase('Waiting for metadata')
        setNotice(
          'A peer connection exists, but metadata has not arrived yet. The connected peer may not expose metadata or the metadata exchange is stalled.',
          'error'
        )
        logDiagnostic('DIAGNOSIS', 'Connected wire exists but metadata is still missing after 12 seconds')
      }
    }, 12_000)
  } catch (error) {
    setPhase('Failed')
    logDiagnostic('ADD ERROR', error.message)
    setNotice(error.message, 'error')
  }
}

function attachTorrentDiagnostics (torrent) {
  setPhase('Parsing identifier')
  logDiagnostic('TORRENT', 'Torrent object created before metadata callback')

  torrent.on('infoHash', () => {
    if (torrent !== activeTorrent) return
    elements.infoHashText.textContent = torrent.infoHash || '—'
    setPhase('Discovering peers')
    logDiagnostic('INFO HASH', torrent.infoHash || 'Determined')
    updateSourceList(torrent)
    attachDiscoveryDiagnostics(torrent)
  })

  torrent.on('metadata', () => {
    if (torrent !== activeTorrent) return
    metadataLoaded = true
    elements.metadataText.textContent = 'Loaded'
    setPhase('Preparing files')
    logDiagnostic('METADATA', `Received metadata${torrent.name ? `: ${torrent.name}` : ''}`)
    clearMetadataWatchdog()
    updateSourceList(torrent)
  })

  torrent.on('ready', () => {
    if (torrent !== activeTorrent) return
    setPhase(torrent.done ? 'Complete' : 'Downloading')
    logDiagnostic('READY', `${torrent.files.length} file(s), ${formatBytes(torrent.length)}`)
  })

  torrent.on('wire', (_wire, address) => {
    if (torrent !== activeTorrent) return
    connectedPeers += 1
    elements.connectedText.textContent = String(connectedPeers)
    const suffix = address ? ` (${address})` : ''
    logDiagnostic('PEER CONNECTED', `BitTorrent wire established${suffix}`)
  })

  torrent.on('noPeers', announceType => {
    if (torrent !== activeTorrent) return
    logDiagnostic('NO PEERS', `No peers found via ${announceType}`)
  })

  torrent.on('warning', error => {
    if (torrent !== activeTorrent) return
    logDiagnostic('TORRENT WARNING', error.message)
  })

  torrent.on('error', error => {
    if (torrent !== activeTorrent) return
    setPhase('Torrent error')
    logDiagnostic('TORRENT ERROR', error.message)
    setNotice(error.message, 'error')
  })

  if (torrent.infoHash) {
    elements.infoHashText.textContent = torrent.infoHash
    setPhase('Discovering peers')
    logDiagnostic('INFO HASH', torrent.infoHash)
  }

  attachDiscoveryDiagnostics(torrent)
  updateSourceList(torrent)
}

function attachDiscoveryDiagnostics (torrent) {
  const discovery = torrent?.discovery
  if (!discovery || attachedDiscoveries.has(discovery)) return Boolean(discovery)

  attachedDiscoveries.add(discovery)
  logDiagnostic('DISCOVERY', 'Peer discovery initialized')

  discovery.on('peer', (_peer, source) => {
    if (torrent !== activeTorrent) return
    discoveredPeers += 1
    elements.discoveredText.textContent = String(discoveredPeers)
    logDiagnostic('PEER DISCOVERED', `Source: ${source}`)
  })

  discovery.on('warning', error => {
    if (torrent !== activeTorrent) return
    logDiagnostic('DISCOVERY WARNING', error.message)
  })

  discovery.on('error', error => {
    if (torrent !== activeTorrent) return
    logDiagnostic('DISCOVERY ERROR', error.message)
  })

  updateSourceList(torrent)
  return true
}

function onTorrentReady (torrent) {
  if (torrent !== activeTorrent) return

  metadataLoaded = true
  clearMetadataWatchdog()
  elements.torrentName.textContent = torrent.name || torrent.infoHash
  elements.metadataText.textContent = 'Loaded'
  renderFiles(torrent)
  setPhase(torrent.done ? 'Complete' : 'Downloading')
  setNotice(
    torrent.numPeers > 0
      ? 'Metadata loaded and at least one peer is connected.'
      : 'Metadata loaded. Looking for WebRTC peers or web seeds.'
  )
  logDiagnostic('CALLBACK', 'Metadata callback fired; torrent is ready for use')
  updateSourceList(torrent)
  updateStats(torrent)

  torrent.on('done', () => {
    if (torrent !== activeTorrent) return
    setPhase('Complete')
    setNotice('Download complete. Files can now be saved.', 'success')
    logDiagnostic('DONE', 'Torrent download complete')
    updateStats(torrent)
  })
}

function inspectInputSources (torrentId) {
  const sources = []

  if (typeof torrentId === 'string' && torrentId.startsWith('magnet:')) {
    try {
      const url = new URL(torrentId)
      const trackers = url.searchParams.getAll('tr')
      const webSeeds = url.searchParams.getAll('ws')
      const exactSources = url.searchParams.getAll('xs')

      for (const tracker of trackers) sources.push({ type: 'Magnet tracker', value: tracker })
      for (const seed of webSeeds) sources.push({ type: 'Web seed', value: seed })
      for (const source of exactSources) sources.push({ type: 'Metadata source', value: source })

      logDiagnostic('INPUT', `Magnet: ${trackers.length} tracker(s), ${webSeeds.length} web seed(s), ${exactSources.length} exact source(s)`)
    } catch (error) {
      logDiagnostic('INPUT WARNING', `Could not inspect magnet parameters: ${error.message}`)
    }
  } else if (torrentId instanceof Uint8Array) {
    sources.push({ type: 'Input', value: '.torrent file loaded locally' })
    logDiagnostic('INPUT', `.torrent file: ${torrentId.byteLength} bytes`)
  }

  for (const tracker of DEFAULT_TRACKERS) {
    sources.push({ type: 'Fallback tracker', value: tracker })
  }

  renderSources(sources)
}

function updateSourceList (torrent) {
  const sources = []

  for (const tracker of torrent?.announce || []) {
    sources.push({ type: 'Active tracker', value: tracker })
  }

  for (const seed of torrent?.urlList || []) {
    sources.push({ type: 'Web seed', value: seed })
  }

  if (sources.length === 0) {
    for (const tracker of DEFAULT_TRACKERS) {
      sources.push({ type: 'Configured tracker', value: tracker })
    }
  }

  renderSources(sources)
}

function renderSources (sources) {
  elements.sourceList.replaceChildren()

  const seen = new Set()
  for (const source of sources) {
    const key = `${source.type}:${source.value}`
    if (seen.has(key)) continue
    seen.add(key)

    const row = document.createElement('div')
    row.className = 'source-row'

    const type = document.createElement('span')
    type.textContent = source.type

    const value = document.createElement('code')
    value.textContent = source.value

    row.append(type, value)
    elements.sourceList.append(row)
  }

  if (seen.size === 0) {
    const empty = document.createElement('div')
    empty.className = 'source-empty'
    empty.textContent = 'No sources detected yet.'
    elements.sourceList.append(empty)
  }
}

function renderFiles (torrent) {
  elements.filesList.replaceChildren()
  elements.filesSection.classList.remove('hidden')

  for (const file of torrent.files) {
    const row = document.createElement('div')
    row.className = 'file-row'

    const meta = document.createElement('div')
    meta.className = 'file-meta'

    const name = document.createElement('div')
    name.className = 'file-name'
    name.textContent = file.path

    const size = document.createElement('div')
    size.className = 'file-size'
    size.textContent = formatBytes(file.length)

    const action = document.createElement('a')
    action.className = 'file-action'
    action.textContent = streamingAvailable ? 'Open / Save' : 'Save when done'
    action.href = '#'

    if (streamingAvailable) {
      action.href = file.streamURL
      action.target = '_blank'
      action.rel = 'noopener'
      action.download = file.name
    } else {
      action.addEventListener('click', async event => {
        event.preventDefault()
        action.textContent = 'Preparing…'
        action.style.pointerEvents = 'none'

        try {
          const blob = await file.blob()
          const url = URL.createObjectURL(blob)
          const download = document.createElement('a')
          download.href = url
          download.download = file.name
          download.target = '_blank'
          download.click()
          window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
          action.textContent = 'Save again'
        } catch (error) {
          logDiagnostic('SAVE ERROR', error.message)
          setNotice(error.message, 'error')
          action.textContent = 'Try again'
        } finally {
          action.style.pointerEvents = ''
        }
      })
    }

    meta.append(name, size)
    row.append(meta, action)
    elements.filesList.append(row)
  }
}

function updateStats (torrent) {
  if (torrent !== activeTorrent) return

  const progress = Math.min(100, torrent.progress * 100)
  elements.progressBar.style.width = `${progress.toFixed(2)}%`
  elements.progressText.textContent = `${progress.toFixed(1)}%`
  elements.amountText.textContent = `${formatBytes(torrent.downloaded)} / ${formatBytes(torrent.length)}`
  elements.peersText.textContent = String(torrent.numPeers)
  elements.downloadSpeedText.textContent = `${formatBytes(torrent.downloadSpeed)}/s`
  elements.uploadSpeedText.textContent = `${formatBytes(torrent.uploadSpeed)}/s`
  elements.etaText.textContent = formatEta(torrent.timeRemaining)
  elements.elapsedText.textContent = sessionStartedAt ? formatElapsed(Date.now() - sessionStartedAt) : '—'

  if (torrent.infoHash) elements.infoHashText.textContent = torrent.infoHash
  if (torrent.metadata) elements.metadataText.textContent = 'Loaded'
}

function setPhase (phase) {
  elements.phaseText.textContent = phase
}

function setNotice (message, type = '') {
  elements.notice.textContent = message
  elements.notice.className = `notice${type ? ` ${type}` : ''}`
}

function logDiagnostic (category, message) {
  const elapsed = sessionStartedAt ? Date.now() - sessionStartedAt : 0
  const timestamp = sessionStartedAt ? `+${(elapsed / 1000).toFixed(1)}s` : 'boot'
  const line = `[${timestamp}] ${category}: ${message}`
  debugEntries.push(line)
  if (debugEntries.length > 250) debugEntries.shift()
  elements.debugLog.textContent = debugEntries.join('\n')
  elements.debugLog.scrollTop = elements.debugLog.scrollHeight
  console.log(line)
}

function resetStatus () {
  clearMetadataWatchdog()
  debugEntries = []
  metadataLoaded = false
  discoveredPeers = 0
  connectedPeers = 0
  sessionStartedAt = 0

  elements.torrentName.textContent = 'Loading metadata…'
  elements.progressBar.style.width = '0%'
  elements.progressText.textContent = '0%'
  elements.amountText.textContent = '0 B / 0 B'
  elements.peersText.textContent = '0'
  elements.downloadSpeedText.textContent = '0 B/s'
  elements.uploadSpeedText.textContent = '0 B/s'
  elements.etaText.textContent = '—'
  elements.phaseText.textContent = 'Idle'
  elements.elapsedText.textContent = '0s'
  elements.infoHashText.textContent = '—'
  elements.metadataText.textContent = 'Waiting'
  elements.discoveredText.textContent = '0'
  elements.connectedText.textContent = '0'
  elements.sourceList.replaceChildren()
  elements.debugLog.textContent = ''
  elements.filesSection.classList.add('hidden')
  elements.filesList.replaceChildren()
}

function clearMetadataWatchdog () {
  if (metadataWatchdog !== null) {
    clearTimeout(metadataWatchdog)
    metadataWatchdog = null
  }
}

function stopActiveTorrent () {
  clearMetadataWatchdog()

  if (refreshTimer !== null) {
    clearInterval(refreshTimer)
    refreshTimer = null
  }

  if (discoveryPoll !== null) {
    clearInterval(discoveryPoll)
    discoveryPoll = null
  }

  if (!activeTorrent) return

  const infoHash = activeTorrent.infoHash
  logDiagnostic('STOP', infoHash ? `Removing ${infoHash}` : 'Removing torrent before metadata')
  activeTorrent = null

  if (infoHash) client.remove(infoHash).catch(error => {
    logDiagnostic('REMOVE WARNING', error.message)
  })
}

function retryActiveTorrent () {
  if (!currentTorrentId) return
  const torrentId = currentTorrentId
  logDiagnostic('RETRY', 'Restarting torrent discovery')
  addTorrent(torrentId)
}

async function copyDiagnostics () {
  const summary = [
    'Torrent Web diagnostics',
    `Runtime: ${elements.runtimeBadge.textContent}`,
    `Phase: ${elements.phaseText.textContent}`,
    `Info hash: ${elements.infoHashText.textContent}`,
    `Metadata: ${elements.metadataText.textContent}`,
    `Discovered peers: ${elements.discoveredText.textContent}`,
    `Connected peers: ${elements.connectedText.textContent}`,
    '',
    elements.debugLog.textContent
  ].join('\n')

  try {
    await navigator.clipboard.writeText(summary)
    elements.copyLogButton.textContent = 'Copied'
    window.setTimeout(() => {
      elements.copyLogButton.textContent = 'Copy log'
    }, 1500)
  } catch {
    elements.copyLogButton.textContent = 'Copy failed'
  }
}

function formatBytes (bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / (1024 ** exponent)
  return `${value.toFixed(value >= 100 || exponent === 0 ? 0 : value >= 10 ? 1 : 2)} ${units[exponent]}`
}

function formatEta (milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return '—'
  const seconds = Math.ceil(milliseconds / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.ceil(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

function formatElapsed (milliseconds) {
  const seconds = Math.floor(milliseconds / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${seconds % 60}s`
}

elements.addMagnetButton.addEventListener('click', () => {
  const magnet = elements.magnetInput.value.trim()
  if (!magnet) {
    elements.statusCard.classList.remove('hidden')
    setNotice('Paste a magnet link first.', 'error')
    return
  }
  addTorrent(magnet)
})

elements.demoButton.addEventListener('click', () => {
  elements.magnetInput.value = DEMO_MAGNET
  addTorrent(DEMO_MAGNET)
})

elements.torrentFileInput.addEventListener('change', async event => {
  const [file] = event.target.files
  if (!file) return
  const data = new Uint8Array(await file.arrayBuffer())
  addTorrent(data)
})

elements.stopButton.addEventListener('click', () => {
  stopActiveTorrent()
  setPhase('Stopped')
  setNotice('Torrent stopped.')
})

elements.retryButton.addEventListener('click', retryActiveTorrent)
elements.copyLogButton.addEventListener('click', copyDiagnostics)

window.addEventListener('offline', () => logDiagnostic('NETWORK', 'Browser went offline'))
window.addEventListener('online', () => logDiagnostic('NETWORK', 'Browser is online'))
window.addEventListener('pagehide', () => stopActiveTorrent())

await initializeStreaming()
