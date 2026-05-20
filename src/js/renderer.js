/* ══════════════════════════════════════════════════════════
   PARTY SHAKER 2000 — Renderer Logic
   ══════════════════════════════════════════════════════════ */

const api = window.electronAPI

// ── State ─────────────────────────────────────────────────
const state = {
  isAdmin: false,
  userId: null,
  partyPlaylistId: null,
  partyPlaylistSnapshot: null,
  playlistTracks: [],
  currentTrackUri: null,
  isPlaying: false,
  pollingTimer: null,
  volumeThrottle: null,
  dragSrcIndex: null,
  searchDebounce: null,
}

// ── DOM refs ───────────────────────────────────────────────
const $ = id => document.getElementById(id)

// ── Init ──────────────────────────────────────────────────
async function init() {
  buildEqualizer()
  bindWindowControls()
  bindAuthCallbackListener()

  const clientId = await api.getConfig('clientId')
  if (!clientId) {
    showScreen('setupScreen')
    bindSetupScreen()
    return
  }

  const authed = await api.isAuthenticated()
  if (!authed) {
    showScreen('loginScreen')
    bindLoginScreen()
    return
  }

  await startMainApp()
}

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'))
  $(id).classList.remove('hidden')
}

// ── Equalizer ─────────────────────────────────────────────
function buildEqualizer() {
  const eq = $('equalizer')
  const colors = [
    '#39ff14', '#00fff5', '#0080ff',
    '#9d00ff', '#ff2d9e', '#ff8800',
    '#ffe600', '#39ff14', '#00fff5',
    '#0080ff', '#9d00ff', '#ff2d9e',
    '#ff8800', '#ffe600', '#39ff14',
    '#00fff5', '#0080ff', '#9d00ff',
    '#ff2d9e', '#ff8800', '#ffe600',
    '#39ff14', '#00fff5', '#0080ff',
  ]
  for (let i = 0; i < 24; i++) {
    const bar = document.createElement('div')
    bar.className = 'eq-bar'
    const h = 10 + Math.floor(Math.random() * 22)
    const dur = (0.25 + Math.random() * 0.45).toFixed(2)
    const delay = (Math.random() * 0.4).toFixed(2)
    bar.style.cssText = `
      --h: ${h}px;
      --dur: ${dur}s;
      animation-delay: ${delay}s;
      background: linear-gradient(to top, ${colors[i]}, rgba(255,255,255,.6));
    `
    eq.appendChild(bar)
  }
}

function setEqualizerPlaying(playing) {
  $('equalizer').classList.toggle('eq-playing', playing)
}

// ── Window Controls ───────────────────────────────────────
function bindWindowControls() {
  $('btnMinimize').onclick = () => api.windowMinimize()
  $('btnMaximize').onclick = () => api.windowMaximize()
  $('btnClose').onclick    = () => api.windowClose()
}

// ── Setup Screen ──────────────────────────────────────────
function bindSetupScreen() {
  $('saveClientIdBtn').onclick = async () => {
    const clientId = $('clientIdInput').value.trim()
    if (!clientId || clientId.length < 10) {
      showToast('Bitte eine gültige Client ID eingeben', 'error')
      return
    }
    await api.setConfig('clientId', clientId)
    showScreen('loginScreen')
    bindLoginScreen()
  }
  $('clientIdInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') $('saveClientIdBtn').click()
  })
}

// ── Login Screen ──────────────────────────────────────────
function bindLoginScreen() {
  $('loginBtn').onclick = startLogin

  $('changeClientIdBtn').onclick = () => {
    showScreen('setupScreen')
    bindSetupScreen()
  }
}

async function startLogin() {
  const btn = $('loginBtn')
  btn.textContent = '⏳ Öffne Browser...'
  btn.disabled = true

  try {
    await api.startAuth()
  } catch (err) {
    btn.textContent = '🎧 MIT SPOTIFY EINLOGGEN'
    btn.disabled = false
    showToast('Login fehlgeschlagen: ' + err.message, 'error')
  }
}

// ── Auth Callback Listener ────────────────────────────────
function bindAuthCallbackListener() {
  api.onAuthComplete(async (data) => {
    if (data.success) {
      await startMainApp()
    } else {
      const btn = $('loginBtn')
      if (btn) {
        btn.textContent = '🎧 MIT SPOTIFY EINLOGGEN'
        btn.disabled = false
      }
      showToast('Login fehlgeschlagen: ' + (data.error || 'Unbekannter Fehler'), 'error')
    }
  })
}

// ── Main App ──────────────────────────────────────────────
async function startMainApp() {
  showScreen('mainApp')
  bindMainApp()
  await loadUserProfile()
  await loadOrCreatePartyPlaylist()
  startPolling()
}

function bindMainApp() {
  // Player controls
  $('prevBtn').onclick      = () => playerCommand('previous')
  $('playPauseBtn').onclick = () => togglePlayPause()
  $('nextBtn').onclick      = () => playerCommand('next')

  $('volumeSlider').oninput = e => {
    const vol = e.target.value
    $('volValue').textContent = vol
    clearTimeout(state.volumeThrottle)
    state.volumeThrottle = setTimeout(() => setVolume(vol), 300)
  }

  $('volIcon').onclick = () => {
    const slider = $('volumeSlider')
    const newVol = slider.value === '0' ? '70' : '0'
    slider.value = newVol
    $('volValue').textContent = newVol
    setVolume(newVol)
  }

  // Search
  $('searchBtn').onclick = doSearch
  $('searchInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') doSearch()
  })

  // Admin
  $('adminToggleBtn').onclick = () => showAdminModal()
  $('adminModalClose').onclick = closeAdminModal
  $('adminCancelBtn').onclick  = closeAdminModal
  $('adminLoginBtn').onclick   = attemptAdminLogin
  $('adminPasswordInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') attemptAdminLogin()
    $('adminLoginError').classList.add('hidden')
  })
  $('showChangePwBtn').onclick = () => {
    $('adminLoginPane').classList.add('hidden')
    $('adminChangePwPane').classList.remove('hidden')
  }
  $('cancelChangePwBtn').onclick = () => {
    $('adminChangePwPane').classList.add('hidden')
    $('adminLoginPane').classList.remove('hidden')
  }
  $('changePasswordBtn').onclick = changeAdminPassword

  // Admin playlist controls
  $('playPlaylistBtn').onclick  = playPartyPlaylist
  $('clearPlaylistBtn').onclick = clearPartyPlaylist

  // Logout
  $('logoutBtn').onclick = async () => {
    stopPolling()
    await api.logout()
    showScreen('loginScreen')
    bindLoginScreen()
  }

  // Close modal on overlay click
  $('adminModal').addEventListener('click', e => {
    if (e.target === $('adminModal')) closeAdminModal()
  })
}

// ── User Profile ──────────────────────────────────────────
async function loadUserProfile() {
  try {
    const me = await api.spotifyGet('/me')
    state.userId = me.id
    await api.setConfig('userId', me.id)
    $('userName').textContent = me.display_name || me.id
    if (me.images && me.images.length > 0) {
      $('userAvatar').src = me.images[0].url
      $('userAvatar').classList.remove('hidden')
    }
  } catch (err) {
    console.error('Profile load failed:', err)
  }
}

// ── Party Playlist ────────────────────────────────────────
async function loadOrCreatePartyPlaylist() {
  const savedId = await api.getConfig('partyPlaylistId')

  if (savedId) {
    try {
      const pl = await api.spotifyGet(`/playlists/${savedId}`)
      state.partyPlaylistId = savedId
      state.partyPlaylistSnapshot = pl.snapshot_id
      await loadPlaylistTracks()
      return
    } catch {
      // Playlist deleted or inaccessible – clear the saved ID and create a new one
      await api.setConfig('partyPlaylistId', null)
    }
  }

  await createPartyPlaylist()
}

async function createPartyPlaylist() {
  try {
    const now = new Date()
    const dateStr = now.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })
    // Use /me/playlists – does not require a user ID and avoids permission edge cases
    const pl = await api.spotifyPost('/me/playlists', {
      name: `Party Shaker - ${dateStr}`,
      description: 'Party Playlist - erstellt mit Party Shaker 2000',
      public: true,
    })
    if (!pl || !pl.id) throw new Error('Ungültige API-Antwort: ' + JSON.stringify(pl))
    state.partyPlaylistId = pl.id
    state.partyPlaylistSnapshot = pl.snapshot_id
    await api.setConfig('partyPlaylistId', pl.id)
    renderPlaylist()
    showToast('🎉 Party Playlist erstellt!', 'success')
  } catch (err) {
    console.error('Playlist creation failed:', err)
    showToast('Playlist konnte nicht erstellt werden: ' + err.message, 'error')
    // Show a "create" button in the UI so the user can retry
    renderPlaylistCreationFailed()
  }
}

function renderPlaylistCreationFailed() {
  const container = $('partyPlaylist')
  $('trackCount').textContent = '–'
  container.innerHTML = `
    <div class="empty-state">
      <span class="empty-icon">⚠️</span>
      <span>Playlist konnte nicht erstellt werden.</span>
      <button id="retryCreateBtn" class="neon-btn primary" style="margin-top:12px">
        🔄 PLAYLIST ERSTELLEN
      </button>
    </div>
  `
  $('retryCreateBtn').onclick = createPartyPlaylist
}

async function loadPlaylistTracks() {
  if (!state.partyPlaylistId) return
  try {
    const data = await api.spotifyGet(
      `/playlists/${state.partyPlaylistId}/tracks?limit=100`
    )
    state.playlistTracks = (data.items || [])
      .filter(item => item.track && item.track.id)
      .map(item => item.track)
    renderPlaylist()
  } catch (err) {
    console.error('Failed to load tracks:', err)
  }
}

// ── Playback Polling ──────────────────────────────────────
function startPolling() {
  stopPolling()
  pollPlayback()
  state.pollingTimer = setInterval(pollPlayback, 3000)
}

function stopPolling() {
  if (state.pollingTimer) {
    clearInterval(state.pollingTimer)
    state.pollingTimer = null
  }
}

async function pollPlayback() {
  try {
    const data = await api.spotifyGet('/me/player')
    if (!data) {
      updatePlayerDisplay(null)
      return
    }
    updatePlayerDisplay(data)
  } catch (err) {
    if (!err.message.includes('204') && !err.message.includes('No Content')) {
      console.warn('Polling error:', err.message)
    }
  }
}

function updatePlayerDisplay(data) {
  if (!data || !data.item) {
    $('lcdTrackText').textContent = 'Kein Track aktiv'
    $('lcdArtist').textContent = 'Spotify öffnen & Playlist starten'
    $('lcdCurrentTime').textContent = '0:00'
    $('lcdTotalTime').textContent = '0:00'
    $('lcdTimeFill').style.width = '0%'
    $('playPauseBtn').textContent = '▶'
    $('albumArt').classList.add('hidden')
    $('albumArtPlaceholder').style.display = ''
    setEqualizerPlaying(false)
    state.isPlaying = false
    state.currentTrackUri = null
    return
  }

  const track = data.item
  const isPlaying = data.is_playing
  state.isPlaying = isPlaying
  state.currentTrackUri = track.uri

  // Track name (with scrolling marquee if long)
  const trackEl = $('lcdTrackText')
  const scrollEl = $('lcdTrackScroll')
  const newName = track.name
  if (trackEl.textContent !== newName) {
    trackEl.textContent = newName + '  ·  ' + newName + '   '
    scrollEl.classList.toggle('scrolling', newName.length > 28)
  }

  // Artist
  const artists = track.artists.map(a => a.name).join(', ')
  $('lcdArtist').textContent = artists

  // Times
  const cur = data.progress_ms || 0
  const dur = track.duration_ms || 1
  $('lcdCurrentTime').textContent = formatMs(cur)
  $('lcdTotalTime').textContent = formatMs(dur)
  $('lcdTimeFill').style.width = `${(cur / dur * 100).toFixed(1)}%`

  // Play/pause button
  $('playPauseBtn').textContent = isPlaying ? '⏸' : '▶'

  // Album art
  if (track.album && track.album.images && track.album.images.length > 0) {
    const imgUrl = track.album.images[0].url
    if ($('albumArt').src !== imgUrl) {
      $('albumArt').src = imgUrl
    }
    $('albumArt').classList.remove('hidden')
    $('albumArtPlaceholder').style.display = 'none'
  }

  // Volume
  if (data.device && data.device.volume_percent != null) {
    const vol = data.device.volume_percent
    $('volumeSlider').value = vol
    $('volValue').textContent = vol
  }

  // EQ animation
  setEqualizerPlaying(isPlaying)

  // Highlight current track in playlist
  highlightCurrentInPlaylist(track.uri)
}

function highlightCurrentInPlaylist(uri) {
  document.querySelectorAll('.playlist-item').forEach(el => {
    el.classList.toggle('playing', el.dataset.uri === uri)
  })
}

// ── Player Commands ───────────────────────────────────────
async function togglePlayPause() {
  try {
    if (state.isPlaying) {
      await api.spotifyPut('/me/player/pause', null)
      state.isPlaying = false
      $('playPauseBtn').textContent = '▶'
      setEqualizerPlaying(false)
    } else {
      await api.spotifyPut('/me/player/play', null)
      state.isPlaying = true
      $('playPauseBtn').textContent = '⏸'
      setEqualizerPlaying(true)
    }
    setTimeout(pollPlayback, 500)
  } catch (err) {
    handlePlaybackError(err)
  }
}

async function playerCommand(command) {
  try {
    await api.spotifyPost(`/me/player/${command}`, null)
    setTimeout(pollPlayback, 600)
  } catch (err) {
    handlePlaybackError(err)
  }
}

async function setVolume(vol) {
  try {
    await api.spotifyPut(`/me/player/volume?volume_percent=${vol}`, null)
  } catch {
    // Silently ignore volume errors (no active device)
  }
}

async function playPartyPlaylist() {
  if (!state.partyPlaylistId) return
  try {
    await api.spotifyPut('/me/player/play', {
      context_uri: `spotify:playlist:${state.partyPlaylistId}`,
    })
    showToast('▶ Party Playlist wird abgespielt!', 'success')
    setTimeout(pollPlayback, 800)
  } catch (err) {
    handlePlaybackError(err)
  }
}

function handlePlaybackError(err) {
  if (err.message.includes('403') || err.message.includes('Premium')) {
    showToast('⚠ Spotify Premium wird für die Wiedergabesteuerung benötigt', 'warning')
  } else if (err.message.includes('404') || err.message.includes('device')) {
    showToast('⚠ Kein aktives Spotify-Gerät gefunden. Öffne Spotify zuerst!', 'warning')
  } else {
    showToast('Fehler: ' + err.message, 'error')
  }
}

// ── Search ────────────────────────────────────────────────
async function doSearch() {
  const query = $('searchInput').value.trim()
  if (!query) return

  const btn = $('searchBtn')
  btn.textContent = '⏳'
  btn.disabled = true

  try {
    const data = await api.spotifyGet(
      `/search?q=${encodeURIComponent(query)}&type=track&limit=20`
    )
    renderSearchResults(data.tracks.items || [])
  } catch (err) {
    showToast('Suche fehlgeschlagen: ' + err.message, 'error')
  } finally {
    btn.textContent = 'SUCHEN'
    btn.disabled = false
  }
}

function renderSearchResults(tracks) {
  const container = $('searchResults')
  if (tracks.length === 0) {
    container.innerHTML = '<div class="no-results">Keine Ergebnisse gefunden 😔</div>'
    return
  }

  const existingUris = new Set(state.playlistTracks.map(t => t.uri))

  container.innerHTML = ''
  tracks.forEach(track => {
    const alreadyAdded = existingUris.has(track.uri)
    const art = track.album.images.length > 0
      ? `<img class="result-art" src="${track.album.images.slice(-1)[0].url}" alt="">`
      : `<div class="result-art-placeholder">🎵</div>`

    const artists = track.artists.map(a => a.name).join(', ')
    const duration = formatMs(track.duration_ms)

    const div = document.createElement('div')
    div.className = 'search-result-item'
    div.innerHTML = `
      ${art}
      <div class="result-info">
        <div class="result-name">${escapeHtml(track.name)}</div>
        <div class="result-artist">${escapeHtml(artists)}</div>
      </div>
      <span class="result-duration">${duration}</span>
      <button class="add-btn" data-uri="${track.uri}" ${alreadyAdded ? 'disabled' : ''}>
        ${alreadyAdded ? '✓' : '+ ADD'}
      </button>
    `

    div.querySelector('.add-btn').onclick = async (e) => {
      const btn = e.currentTarget
      if (btn.disabled) return
      btn.textContent = '⏳'
      btn.disabled = true
      const success = await addTrackToPlaylist(track.uri)
      btn.textContent = success ? '✓' : '+ ADD'
      if (!success) btn.disabled = false
    }

    container.appendChild(div)
  })
}

// ── Playlist Management ───────────────────────────────────
async function addTrackToPlaylist(uri) {
  if (!state.partyPlaylistId) {
    showToast('Keine Party Playlist vorhanden', 'error')
    return false
  }

  try {
    const data = await api.spotifyPost(
      `/playlists/${state.partyPlaylistId}/tracks`,
      { uris: [uri] }
    )
    state.partyPlaylistSnapshot = data.snapshot_id
    await loadPlaylistTracks()
    showToast('🎵 Song zur Party Playlist hinzugefügt!', 'success')
    return true
  } catch (err) {
    showToast('Fehler beim Hinzufügen: ' + err.message, 'error')
    return false
  }
}

async function removeTrackFromPlaylist(uri, index) {
  if (!state.partyPlaylistId) return
  try {
    const data = await api.spotifyDelete(
      `/playlists/${state.partyPlaylistId}/tracks`,
      {
        tracks: [{ uri }],
        snapshot_id: state.partyPlaylistSnapshot,
      }
    )
    state.partyPlaylistSnapshot = data.snapshot_id
    state.playlistTracks.splice(index, 1)
    renderPlaylist()
    showToast('Song entfernt', 'success')
  } catch (err) {
    showToast('Fehler beim Entfernen: ' + err.message, 'error')
  }
}

async function reorderPlaylistTrack(fromIndex, toIndex) {
  if (!state.partyPlaylistId || fromIndex === toIndex) return
  if (toIndex < 0 || toIndex >= state.playlistTracks.length) return

  // Optimistic UI update
  const tracks = [...state.playlistTracks]
  const [moved] = tracks.splice(fromIndex, 1)
  tracks.splice(toIndex, 0, moved)
  state.playlistTracks = tracks
  renderPlaylist()

  try {
    const insertBefore = toIndex > fromIndex ? toIndex + 1 : toIndex
    const data = await api.spotifyPut(
      `/playlists/${state.partyPlaylistId}/tracks`,
      {
        range_start: fromIndex,
        insert_before: insertBefore,
        range_length: 1,
        snapshot_id: state.partyPlaylistSnapshot,
      }
    )
    state.partyPlaylistSnapshot = data.snapshot_id
  } catch (err) {
    // Reload on failure
    showToast('Sortierung fehlgeschlagen – lade neu', 'error')
    await loadPlaylistTracks()
  }
}

async function clearPartyPlaylist() {
  if (!state.partyPlaylistId) return
  if (state.playlistTracks.length === 0) return

  if (!confirm('Alle Songs aus der Party Playlist löschen?')) return

  try {
    const tracks = state.playlistTracks.map(t => ({ uri: t.uri }))
    await api.spotifyDelete(
      `/playlists/${state.partyPlaylistId}/tracks`,
      { tracks, snapshot_id: state.partyPlaylistSnapshot }
    )
    state.playlistTracks = []
    renderPlaylist()
    showToast('🗑 Playlist geleert', 'warning')
    await loadPlaylistTracks()
  } catch (err) {
    showToast('Fehler: ' + err.message, 'error')
  }
}

// ── Render Playlist ───────────────────────────────────────
function renderPlaylist() {
  const container = $('partyPlaylist')
  const count = state.playlistTracks.length
  $('trackCount').textContent = count + (count === 1 ? ' Song' : ' Songs')

  if (count === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <span class="empty-icon">🎵</span>
        <span>Noch keine Songs! Suche nach einem Lied und füge es hinzu.</span>
      </div>
    `
    return
  }

  container.innerHTML = ''
  state.playlistTracks.forEach((track, index) => {
    const artists = track.artists.map(a => a.name).join(', ')
    const duration = formatMs(track.duration_ms)
    const isPlaying = track.uri === state.currentTrackUri

    const art = track.album && track.album.images && track.album.images.length > 0
      ? `<img class="item-art" src="${track.album.images.slice(-1)[0].url}" alt="">`
      : `<div class="item-art-placeholder">🎵</div>`

    const playingIndicator = isPlaying
      ? `<div class="playing-indicator"><span></span><span></span><span></span></div>`
      : `<span class="item-num">${index + 1}</span>`

    const adminBtns = state.isAdmin ? `
      <div class="item-admin-btns">
        <span class="drag-handle" title="Ziehen zum Sortieren">⠿</span>
        <button class="item-btn up" data-index="${index}" title="Nach oben">▲</button>
        <button class="item-btn down" data-index="${index}" title="Nach unten">▼</button>
        <button class="item-btn delete" data-index="${index}" data-uri="${track.uri}" title="Entfernen">✕</button>
      </div>
    ` : ''

    const div = document.createElement('div')
    div.className = `playlist-item${isPlaying ? ' playing' : ''}`
    div.dataset.uri = track.uri
    div.dataset.index = index

    div.innerHTML = `
      ${playingIndicator}
      ${art}
      <div class="item-info">
        <div class="item-name">${escapeHtml(track.name)}</div>
        <div class="item-artist">${escapeHtml(artists)}</div>
      </div>
      <span class="item-duration">${duration}</span>
      ${adminBtns}
    `

    if (state.isAdmin) {
      div.draggable = true
      div.addEventListener('dragstart', onDragStart)
      div.addEventListener('dragover', onDragOver)
      div.addEventListener('dragleave', onDragLeave)
      div.addEventListener('drop', onDrop)
      div.addEventListener('dragend', onDragEnd)

      div.querySelector('.item-btn.up').onclick = () =>
        reorderPlaylistTrack(index, index - 1)
      div.querySelector('.item-btn.down').onclick = () =>
        reorderPlaylistTrack(index, index + 1)
      div.querySelector('.item-btn.delete').onclick = () =>
        removeTrackFromPlaylist(track.uri, index)
    }

    container.appendChild(div)
  })
}

// ── Drag & Drop ───────────────────────────────────────────
function onDragStart(e) {
  state.dragSrcIndex = parseInt(this.dataset.index)
  this.classList.add('dragging')
  e.dataTransfer.effectAllowed = 'move'
  e.dataTransfer.setData('text/plain', state.dragSrcIndex)
}

function onDragOver(e) {
  e.preventDefault()
  e.dataTransfer.dropEffect = 'move'
  this.classList.add('drag-over')
}

function onDragLeave() {
  this.classList.remove('drag-over')
}

function onDrop(e) {
  e.preventDefault()
  this.classList.remove('drag-over')
  const toIndex = parseInt(this.dataset.index)
  if (state.dragSrcIndex !== null && state.dragSrcIndex !== toIndex) {
    reorderPlaylistTrack(state.dragSrcIndex, toIndex)
  }
  state.dragSrcIndex = null
}

function onDragEnd() {
  this.classList.remove('dragging')
  document.querySelectorAll('.playlist-item').forEach(el => el.classList.remove('drag-over'))
  state.dragSrcIndex = null
}

// ── Admin Mode ────────────────────────────────────────────
function showAdminModal() {
  if (state.isAdmin) {
    exitAdminMode()
    return
  }
  $('adminPasswordInput').value = ''
  $('adminLoginError').classList.add('hidden')
  $('adminLoginPane').classList.remove('hidden')
  $('adminChangePwPane').classList.add('hidden')
  $('adminModal').classList.remove('hidden')
  setTimeout(() => $('adminPasswordInput').focus(), 100)
}

function closeAdminModal() {
  $('adminModal').classList.add('hidden')
}

async function attemptAdminLogin() {
  const pw = $('adminPasswordInput').value
  const ok = await api.checkPassword(pw)

  if (ok) {
    closeAdminModal()
    enterAdminMode()
  } else {
    $('adminLoginError').classList.remove('hidden')
    $('adminPasswordInput').select()
  }
}

function enterAdminMode() {
  state.isAdmin = true
  $('adminBadge').classList.remove('hidden')
  $('adminToggleBtn').textContent = '🔓 ADMIN AN'
  $('adminToggleBtn').classList.add('primary')
  $('adminToggleBtn').classList.remove('secondary')
  $('adminPlaylistControls').classList.remove('hidden')
  renderPlaylist()
  showToast('👑 Admin-Modus aktiviert', 'success')
}

function exitAdminMode() {
  state.isAdmin = false
  $('adminBadge').classList.add('hidden')
  $('adminToggleBtn').textContent = '👑 ADMIN'
  $('adminToggleBtn').classList.remove('primary')
  $('adminToggleBtn').classList.add('secondary')
  $('adminPlaylistControls').classList.add('hidden')
  renderPlaylist()
  showToast('Admin-Modus deaktiviert', 'warning')
}

async function changeAdminPassword() {
  const newPw = $('newPasswordInput').value
  const confirmPw = $('confirmPasswordInput').value

  $('changePwError').classList.add('hidden')

  if (newPw.length < 4) {
    $('changePwError').textContent = '❌ Passwort muss mindestens 4 Zeichen haben'
    $('changePwError').classList.remove('hidden')
    return
  }

  if (newPw !== confirmPw) {
    $('changePwError').textContent = '❌ Passwörter stimmen nicht überein'
    $('changePwError').classList.remove('hidden')
    return
  }

  await api.setAdminPassword(newPw)
  closeAdminModal()
  showToast('✓ Passwort geändert!', 'success')
}

// ── Utilities ──────────────────────────────────────────────
function formatMs(ms) {
  if (!ms || ms < 0) return '0:00'
  const totalSecs = Math.floor(ms / 1000)
  const mins = Math.floor(totalSecs / 60)
  const secs = totalSecs % 60
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

let toastTimer = null
function showToast(message, type = '') {
  const toast = $('toast')
  toast.textContent = message
  toast.className = `toast ${type}`
  toast.classList.remove('hidden')

  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    toast.classList.add('hidden')
  }, 3200)
}

// ── Boot ──────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init)
