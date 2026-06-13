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

// ── Equalizer (JS-driven, frequency-spectrum simulation) ──
let eqRaf = null
let eqClock = 0
const EQ_BARS = 24
// Per-bar config: phase offset and frequency multipliers for bass/mid/treble bands
const eqBarCfg = Array.from({ length: EQ_BARS }, (_, i) => {
  const pos = i / (EQ_BARS - 1) // 0 = left/bass, 1 = right/treble
  return {
    phase: i * 0.38,
    // Bass: slow & tall on the left, fades right
    bassFreq: 0.6 + pos * 0.3,
    bassAmp:  (1 - pos) * 20 + 4,
    // Mid: dominant in the middle
    midFreq:  1.4 + pos * 0.8,
    midAmp:   12 - Math.abs(pos - 0.5) * 16,
    // Treble: fast & small on the right
    trebFreq: 3.0 + pos * 3.0,
    trebAmp:  pos * 10,
  }
})

function buildEqualizer() {
  const eq = $('equalizer')
  const colors = [
    '#39ff14','#00fff5','#0080ff','#9d00ff','#ff2d9e','#ff8800',
    '#ffe600','#39ff14','#00fff5','#0080ff','#9d00ff','#ff2d9e',
    '#ff8800','#ffe600','#39ff14','#00fff5','#0080ff','#9d00ff',
    '#ff2d9e','#ff8800','#ffe600','#39ff14','#00fff5','#0080ff',
  ]
  for (let i = 0; i < EQ_BARS; i++) {
    const bar = document.createElement('div')
    bar.className = 'eq-bar'
    bar.style.background = `linear-gradient(to top, ${colors[i]}, rgba(255,255,255,.55))`
    bar.style.height = '3px'
    eq.appendChild(bar)
  }
  runEqualizer()
}

function runEqualizer() {
  const bars = $('equalizer').querySelectorAll('.eq-bar')
  eqClock += state.isPlaying ? 0.04 : 0

  bars.forEach((bar, i) => {
    const cfg = eqBarCfg[i]
    let h
    if (!state.isPlaying) {
      // Smooth decay to floor when paused
      h = Math.max(3, (parseFloat(bar.style.height) || 3) * 0.88)
    } else {
      // Overlapping sine waves simulate bass / mid / treble bands
      h = 3
        + Math.abs(Math.sin(eqClock * cfg.bassFreq + cfg.phase))          * cfg.bassAmp
        + Math.abs(Math.sin(eqClock * cfg.midFreq  + cfg.phase * 1.7))    * Math.max(0, cfg.midAmp)
        + Math.abs(Math.sin(eqClock * cfg.trebFreq + cfg.phase * 2.4))    * cfg.trebAmp
        + (Math.random() < 0.04 ? Math.random() * 7 : 0) // occasional spike
      h = Math.min(30, Math.max(3, h))
    }
    bar.style.height = h + 'px'
  })

  eqRaf = requestAnimationFrame(runEqualizer)
}

function setEqualizerPlaying(playing) {
  // state.isPlaying is already updated before this is called — no extra work needed
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
    $('oldPasswordInput').value = ''
    $('newPasswordInput').value = ''
    $('confirmPasswordInput').value = ''
    $('changePwError').classList.add('hidden')
    $('adminLoginPane').classList.add('hidden')
    $('adminChangePwPane').classList.remove('hidden')
    setTimeout(() => $('oldPasswordInput').focus(), 100)
  }
  $('cancelChangePwBtn').onclick = () => {
    $('adminChangePwPane').classList.add('hidden')
    $('adminLoginPane').classList.remove('hidden')
  }
  $('changePasswordBtn').onclick = changeAdminPassword

  // Admin playlist controls
  $('playPlaylistBtn').onclick  = playPartyPlaylist
  $('newPlaylistBtn').onclick   = newPartyPlaylist
  $('openPlaylistBtn').onclick  = openPlaylistPicker
  $('clearPlaylistBtn').onclick = clearPartyPlaylist

  // Playlist picker modal
  $('playlistPickerClose').onclick = () => $('playlistPickerModal').classList.add('hidden')
  $('playlistPickerModal').addEventListener('click', e => {
    if (e.target === $('playlistPickerModal')) $('playlistPickerModal').classList.add('hidden')
  })

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
      // Only use it if the current user owns it (or it's collaborative).
      // Spotify forbids reading/modifying tracks of playlists you don't own
      // (e.g. editorial playlists), which would 403 here on startup.
      const owned = pl.owner && pl.owner.id === state.userId
      if (owned || pl.collaborative) {
        state.partyPlaylistId = savedId
        state.partyPlaylistSnapshot = pl.snapshot_id
        await loadPlaylistTracks()
        return
      }
      // Not ours – drop it and create a fresh party playlist
      await api.setConfig('partyPlaylistId', null)
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
    state.playlistTracks = []
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

// Admin: create a brand-new empty party playlist (the old one stays in the
// user's Spotify account but is no longer tracked here)
async function newPartyPlaylist() {
  if (!confirm('Neue, leere Party Playlist erstellen?\n\nDie aktuelle Playlist bleibt in deinem Spotify-Account erhalten, wird hier aber nicht mehr angezeigt.')) {
    return
  }
  await api.setConfig('partyPlaylistId', null)
  state.partyPlaylistId = null
  state.playlistTracks = []
  await createPartyPlaylist()
}

// Admin: open the picker to choose an existing Spotify playlist as the active one
async function openPlaylistPicker() {
  const modal = $('playlistPickerModal')
  const list = $('playlistPickerList')
  list.innerHTML = '<div class="picker-loading"><span class="spinner"></span> Lade Playlists...</div>'
  modal.classList.remove('hidden')

  try {
    const playlists = []
    // No 'limit' param (rejected as "Invalid limit" in this setup); follow `next`
    let nextUrl = '/me/playlists'
    while (nextUrl) {
      const data = await api.spotifyGet(nextUrl)
      if (!data || !data.items) break
      playlists.push(...data.items.filter(p => p && p.id))
      nextUrl = data.next || null
    }
    // Only show playlists the user can actually read AND modify – their own
    // or collaborative ones. Spotify returns 403 for editorial/foreign playlists.
    const usable = playlists.filter(p =>
      (p.owner && p.owner.id === state.userId) || p.collaborative
    )
    renderPlaylistPicker(usable)
  } catch (err) {
    list.innerHTML = `<div class="picker-empty">Fehler beim Laden: ${escapeHtml(err.message)}</div>`
  }
}

function renderPlaylistPicker(playlists) {
  const list = $('playlistPickerList')
  if (playlists.length === 0) {
    list.innerHTML = '<div class="picker-empty">Keine Playlists gefunden.</div>'
    return
  }

  list.innerHTML = ''
  playlists.forEach(pl => {
    const isActive = pl.id === state.partyPlaylistId
    const art = (pl.images && pl.images.length > 0)
      ? `<img class="picker-art" src="${pl.images[pl.images.length - 1].url}" alt="">`
      : `<div class="picker-art-placeholder">🎵</div>`
    const total = (pl.tracks && typeof pl.tracks.total === 'number') ? pl.tracks.total : null
    const countLabel = total === null ? '' : `${total} Songs`
    const owner = pl.owner ? (pl.owner.display_name || pl.owner.id) : ''
    const meta = [countLabel, owner ? escapeHtml(owner) : ''].filter(Boolean).join(' · ')

    const div = document.createElement('div')
    div.className = `picker-item${isActive ? ' active' : ''}`
    div.innerHTML = `
      ${art}
      <div class="picker-info">
        <div class="picker-name">${escapeHtml(pl.name || 'Ohne Titel')}</div>
        <div class="picker-meta">${meta}</div>
      </div>
      ${isActive ? '<span class="picker-active-badge">AKTIV</span>' : ''}
    `
    div.onclick = () => setActivePlaylist(pl)
    list.appendChild(div)
  })
}

async function setActivePlaylist(pl) {
  state.partyPlaylistId = pl.id
  state.partyPlaylistSnapshot = pl.snapshot_id || null
  state.playlistTracks = []
  await api.setConfig('partyPlaylistId', pl.id)
  $('playlistPickerModal').classList.add('hidden')
  renderPlaylist()
  await loadPlaylistTracks()
  showToast(`📂 "${pl.name}" geöffnet`, 'success')
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
    const tracks = []
    // Read tracks from the playlist object itself. The /playlists/{id} endpoint
    // works reliably, whereas the /playlists/{id}/tracks sub-endpoint can return
    // 403 in some Spotify app configurations. The playlist object already embeds
    // the first 100 tracks plus a `next` link for further pages.
    const pl = await api.spotifyGet(`/playlists/${state.partyPlaylistId}`)
    if (pl && pl.snapshot_id) state.partyPlaylistSnapshot = pl.snapshot_id

    const collect = items => {
      for (const item of (items || [])) {
        if (item && item.track && item.track.id) tracks.push(item.track)
      }
    }

    let page = pl && pl.tracks ? pl.tracks : null
    collect(page && page.items)

    // Follow pagination if the playlist has more than 100 tracks. If a page
    // request fails (e.g. 403 on the tracks endpoint), keep what we already have.
    let nextUrl = page ? page.next : null
    while (nextUrl) {
      try {
        const data = await api.spotifyGet(nextUrl)
        collect(data && data.items)
        nextUrl = data ? data.next : null
      } catch (pageErr) {
        console.warn('Pagination stopped:', pageErr.message)
        break
      }
    }

    state.playlistTracks = tracks
    renderPlaylist()
  } catch (err) {
    console.error('Failed to load tracks:', err)
    if (err.message.includes('403')) {
      showToast('Diese Playlist kann nicht gelesen werden (nur eigene Playlists werden unterstützt).', 'warning')
    } else {
      showToast('Songs konnten nicht geladen werden: ' + err.message, 'error')
    }
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
    // No 'limit' param: this Spotify setup rejects it with "Invalid limit".
    // Spotify defaults to 20 results, which meets the minimum we need.
    const params = new URLSearchParams({ q: query, type: 'track' })
    const data = await api.spotifyGet(`https://api.spotify.com/v1/search?${params}`)
    renderSearchResults((data.tracks && data.tracks.items) || [])
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

  container.innerHTML = `<div class="results-count">${tracks.length} Treffer</div>`
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

    const addBtn = div.querySelector('.add-btn')

    async function triggerAdd() {
      if (addBtn.disabled) return
      addBtn.textContent = '⏳'
      addBtn.disabled = true
      const success = await addTrackToPlaylist(track.uri)
      addBtn.textContent = success ? '✓' : '+ ADD'
      if (!success) addBtn.disabled = false
    }

    addBtn.onclick = triggerAdd
    // Double-click anywhere on the row also adds the track
    div.ondblclick = triggerAdd

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
    if (err.message.includes('403')) {
      await handleWriteForbidden()
    } else {
      showToast('Fehler beim Hinzufügen: ' + err.message, 'error')
    }
    return false
  }
}

// Shown when Spotify refuses a write (403). Almost always a missing-scope token.
async function handleWriteForbidden() {
  const scopes = await api.getConfig('grantedScopes')
  const hasModify = scopes && scopes.includes('playlist-modify')
  console.warn('Granted scopes:', scopes)
  if (hasModify) {
    showToast('Spotify verweigert den Schreibzugriff (403). Du kannst nur eigene Playlists bearbeiten – erstelle mit "✨ NEUE" eine neue.', 'error')
  } else {
    showToast('Keine Schreib-Berechtigung. Bitte LOGOUT klicken und neu einloggen (Zustimmung erteilen).', 'error')
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
  const oldPw = $('oldPasswordInput').value
  const newPw = $('newPasswordInput').value
  const confirmPw = $('confirmPasswordInput').value

  $('changePwError').classList.add('hidden')

  // Verify the current password first — without it, no change is allowed
  const oldOk = await api.checkPassword(oldPw)
  if (!oldOk) {
    $('changePwError').textContent = '❌ Aktuelles Passwort ist falsch'
    $('changePwError').classList.remove('hidden')
    $('oldPasswordInput').select()
    return
  }

  if (newPw.length < 4) {
    $('changePwError').textContent = '❌ Neues Passwort muss mindestens 4 Zeichen haben'
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
