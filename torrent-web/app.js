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
  progressBar: document.querySelector('#progressBar'),
  progressText: document.querySelector('#progressText'),
  amountText: document.querySelector('#amountText'),
  peersText: document.querySelector('#peersText'),
  downloadSpeedText: document.querySelector('#downloadSpeedText'),
  uploadSpeedText: document.querySelector('#uploadSpeedText'),
  etaText: document.querySelector('#etaText'),
  notice: document.querySelector('#notice'),
  filesSection: document.querySelector('#filesSection'),
  filesList: document.querySelector('#filesList')
}

const client = new WebTorrent()
let activeTorrent = null
let refreshTimer = null
let streamingAvailable = false

client.on('error', error => setNotice(error.message, 'error'))

async function initializeStreaming () {
  if (!('serviceWorker' in navigator)) {
    elements.runtimeBadge.textContent = 'Blob mode'
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
  } catch (error) {
    console.warn('Service worker streaming unavailable', error)
    elements.runtimeBadge.textContent = 'Blob mode'
  }
}

function addTorrent (torrentId) {
  stopActiveTorrent()
  resetStatus()
  elements.statusCard.classList.remove('hidden')
  setNotice('Loading torrent metadata…')

  try {
    activeTorrent = client.add(torrentId, { announce: DEFAULT_TRACKERS }, torrent => {
      activeTorrent = torrent
      elements.torrentName.textContent = torrent.name || torrent.infoHash
      renderFiles(torrent)
      setNotice(
        'Metadata loaded. Looking for WebRTC peers or web seeds. A torrent with only traditional BitTorrent peers may remain at 0 peers.'
      )
      refreshTimer = window.setInterval(() => updateStats(torrent), 400)
      updateStats(torrent)

      torrent.on('done', () => {
        setNotice('Download complete. Files can now also be saved using Blob fallback.', 'success')
        updateStats(torrent)
      })

      torrent.on('warning', error => setNotice(error.message, 'error'))
      torrent.on('error', error => setNotice(error.message, 'error'))
    })
  } catch (error) {
    setNotice(error.message, 'error')
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
}

function setNotice (message, type = '') {
  elements.notice.textContent = message
  elements.notice.className = `notice${type ? ` ${type}` : ''}`
}

function resetStatus () {
  elements.torrentName.textContent = 'Loading metadata…'
  elements.progressBar.style.width = '0%'
  elements.progressText.textContent = '0%'
  elements.amountText.textContent = '0 B / 0 B'
  elements.peersText.textContent = '0'
  elements.downloadSpeedText.textContent = '0 B/s'
  elements.uploadSpeedText.textContent = '0 B/s'
  elements.etaText.textContent = '—'
  elements.filesSection.classList.add('hidden')
  elements.filesList.replaceChildren()
}

function stopActiveTorrent () {
  if (refreshTimer !== null) {
    clearInterval(refreshTimer)
    refreshTimer = null
  }

  if (!activeTorrent) return
  const infoHash = activeTorrent.infoHash
  activeTorrent = null
  if (infoHash) client.remove(infoHash).catch(() => {})
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
  setNotice('Torrent stopped.')
})

window.addEventListener('pagehide', () => stopActiveTorrent())

await initializeStreaming()
