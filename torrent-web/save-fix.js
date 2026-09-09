const elements = {
  filesList: document.querySelector('#filesList'),
  notice: document.querySelector('#notice'),
  progressText: document.querySelector('#progressText'),
  phaseText: document.querySelector('#phaseText'),
  debugLog: document.querySelector('#debugLog')
}

function appendDiagnostic (category, message) {
  const line = `[save] ${category}: ${message}`
  if (elements.debugLog) {
    const current = elements.debugLog.textContent || ''
    elements.debugLog.textContent = current ? `${current}\n${line}` : line
    elements.debugLog.scrollTop = elements.debugLog.scrollHeight
  }
  console.log(line)
}

function setNotice (message, type = '') {
  if (!elements.notice) return
  elements.notice.textContent = message
  elements.notice.className = `notice${type ? ` ${type}` : ''}`
}

function formatBytes (bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / (1024 ** exponent)
  return `${value.toFixed(value >= 100 || exponent === 0 ? 0 : value >= 10 ? 1 : 2)} ${units[exponent]}`
}

function getFileName (row) {
  const path = row.querySelector('.file-name')?.textContent?.trim() || 'download'
  return path.split('/').pop() || 'download'
}

function ensureExportStatus (row) {
  let status = row.querySelector('.export-status')
  if (status) return status

  status = document.createElement('div')
  status.className = 'export-status'
  status.innerHTML = `
    <div class="export-status-row">
      <span>Saving to device</span>
      <strong class="export-status-text">Waiting</strong>
    </div>
    <div class="export-track"><div class="export-bar"></div></div>
  `
  row.append(status)
  return status
}

function updateExportStatus (status, loaded, total, label = 'Preparing') {
  const text = status.querySelector('.export-status-text')
  const bar = status.querySelector('.export-bar')

  if (total > 0) {
    const percent = Math.min(100, (loaded / total) * 100)
    text.textContent = `${percent.toFixed(0)}% · ${formatBytes(loaded)} / ${formatBytes(total)}`
    bar.style.width = `${percent}%`
  } else {
    text.textContent = loaded > 0 ? `${label} · ${formatBytes(loaded)}` : label
    bar.style.width = '0%'
  }
}

async function saveStreamToDevice (action) {
  const row = action.closest('.file-row')
  const streamUrl = action.dataset.streamUrl
  if (!row || !streamUrl) return

  const torrentProgress = Number.parseFloat(elements.progressText?.textContent || '0')
  const complete = elements.phaseText?.textContent === 'Complete' || torrentProgress >= 99.95

  if (!complete) {
    setNotice('For reliable saving on iPad, wait until the torrent reaches 100% before exporting the file.', 'error')
    appendDiagnostic('SAVE BLOCKED', `Torrent progress is ${torrentProgress}%`)
    return
  }

  const fileName = getFileName(row)
  const status = ensureExportStatus(row)
  const originalText = action.textContent
  action.textContent = 'Preparing…'
  action.style.pointerEvents = 'none'
  updateExportStatus(status, 0, 0, 'Starting')
  setNotice(`Preparing ${fileName} for Safari Downloads…`)
  appendDiagnostic('SAVE START', `${fileName} via in-page stream`)

  try {
    const response = await fetch(streamUrl, { cache: 'no-store' })
    if (!response.ok) throw new Error(`Stream request failed with HTTP ${response.status}`)

    const total = Number.parseInt(response.headers.get('content-length') || '0', 10) || 0
    const contentType = response.headers.get('content-type') || 'application/octet-stream'

    if (total > 800 * 1024 * 1024) {
      setNotice('This is a large file. Safari must temporarily hold the exported Blob in memory, so iPadOS may terminate the page if memory runs low.', 'error')
      appendDiagnostic('SAVE WARNING', `Large Blob export: ${formatBytes(total)}`)
    }

    let blob

    if (response.body?.getReader) {
      const reader = response.body.getReader()
      const chunks = []
      let loaded = 0

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        loaded += value.byteLength
        updateExportStatus(status, loaded, total)
      }

      blob = new Blob(chunks, { type: contentType })
      updateExportStatus(status, loaded, total || loaded)
    } else {
      updateExportStatus(status, 0, total, 'Building file')
      blob = await response.blob()
      updateExportStatus(status, blob.size, total || blob.size)
    }

    appendDiagnostic('SAVE READY', `${fileName}; Blob=${formatBytes(blob.size)}`)

    const objectUrl = URL.createObjectURL(blob)
    const download = document.createElement('a')
    download.href = objectUrl
    download.download = fileName
    download.style.display = 'none'
    document.body.append(download)
    download.click()
    download.remove()

    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 120_000)
    action.textContent = 'Save again'
    setNotice(`Safari download started for ${fileName}. Check the Downloads button or Files > Downloads.`, 'success')
    appendDiagnostic('SAVE DISPATCHED', `Download gesture dispatched for ${fileName}`)
  } catch (error) {
    action.textContent = 'Try again'
    setNotice(`Could not save the file: ${error.message}`, 'error')
    appendDiagnostic('SAVE ERROR', error.message)
    updateExportStatus(status, 0, 0, 'Failed')
  } finally {
    action.style.pointerEvents = ''
    if (action.textContent === 'Preparing…') action.textContent = originalText
  }
}

function patchFileAction (action) {
  if (action.dataset.saveFixApplied === 'true') return
  action.dataset.saveFixApplied = 'true'

  const rawHref = action.getAttribute('href') || ''
  const resolvedHref = action.href || ''

  if (!rawHref || rawHref === '#' || !resolvedHref.includes('/webtorrent/')) {
    if (action.textContent.includes('Save')) action.textContent = 'Save file'
    return
  }

  const row = action.closest('.file-row')
  if (!row) return

  action.dataset.streamUrl = resolvedHref
  action.href = '#'
  action.removeAttribute('target')
  action.removeAttribute('rel')
  action.removeAttribute('download')
  action.textContent = 'Save file'
  action.addEventListener('click', event => {
    event.preventDefault()
    saveStreamToDevice(action)
  })

  const open = document.createElement('a')
  open.className = 'file-action file-action-secondary'
  open.href = resolvedHref
  open.target = '_blank'
  open.rel = 'noopener'
  open.textContent = 'Open stream'

  const actions = document.createElement('div')
  actions.className = 'file-actions'
  action.replaceWith(actions)
  actions.append(action, open)

  appendDiagnostic('PATCH', `Enabled in-page Blob export for ${getFileName(row)}`)
}

function patchFileActions () {
  document.querySelectorAll('.file-action').forEach(patchFileAction)
}

const style = document.createElement('style')
style.textContent = `
  .file-row { grid-template-columns: minmax(0, 1fr) auto; }
  .file-actions { display: flex; gap: 7px; align-items: center; }
  .file-action-secondary { background: #141a27; color: #aeb8cb; }
  .export-status { grid-column: 1 / -1; margin-top: 2px; }
  .export-status-row { display: flex; justify-content: space-between; gap: 12px; margin-bottom: 6px; color: #7f899d; font-size: .72rem; }
  .export-status-row strong { color: #cfd6e6; font-weight: 600; }
  .export-track { height: 6px; overflow: hidden; border-radius: 999px; background: #242a38; }
  .export-bar { width: 0; height: 100%; background: #8ea2ff; transition: width .15s ease; }
  @media (max-width: 620px) {
    .file-row { grid-template-columns: minmax(0, 1fr); }
    .file-actions { width: 100%; }
    .file-actions .file-action { flex: 1; }
  }
`
document.head.append(style)

const observer = new MutationObserver(patchFileActions)
observer.observe(elements.filesList || document.body, { childList: true, subtree: true })
patchFileActions()
