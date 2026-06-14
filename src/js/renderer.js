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
  currentDurationMs: 0,
  isPlaying: false,
  isSeeking: false,
  pollingTimer: null,
  volumeThrottle: null,
  dragSrcIndex: null,
  searchDebounce: null,
  autoHealedThisSession: false,
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
const EQ_MAX_H = 48
// Real-time system-audio analysis (Windows loopback). When available, the
// equalizer is driven by an actual FFT instead of the simulation below.
let eqAnalyser = null
let eqFreqData = null
let eqBinMap = null
let eqAudioCtx = null
// Spectrum layout (as requested): LEFT bars = high frequencies (fast, short,
// flickery), RIGHT bars = low frequencies (slow, tall, with a bass "kick").
// `f` is "bassness": 1 at the right edge (lows), 0 at the left edge (highs).
const eqBarCfg = Array.from({ length: EQ_BARS }, (_, i) => {
  const pos = i / (EQ_BARS - 1)
  const f = 1 - pos
  return {
    phase: i * 0.5,
    speed: 1.0 + (1 - f) * 5.0,   // treble (left) oscillates fast, bass (right) slow
    amp:   8 + f * 32,            // bass (right) reaches higher than treble (left)
    kick:  f * f * 30,            // the beat pulse mainly drives the bass (right) bars
    noise: (1 - f) * 14 + 2,      // treble (left) flickers more
    ease:  0.30 + (1 - f) * 0.45, // treble snaps quickly, bass swells smoothly
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

  // Pull a fresh FFT snapshot if real system-audio analysis is active
  let live = null
  if (eqAnalyser) {
    eqAnalyser.getByteFrequencyData(eqFreqData)
    live = eqFreqData
  }

  eqClock += state.isPlaying ? 0.05 : 0
  // Sharp periodic "kick" (simulated beat) that mostly drives the bass (right) bars
  const beat = Math.pow(Math.max(0, Math.sin(eqClock * 2.0)), 6)

  bars.forEach((bar, i) => {
    const cfg = eqBarCfg[i]
    const prev = parseFloat(bar.style.height) || 3
    let target
    if (live) {
      // Real spectrum. Display layout: LEFT = high freq, RIGHT = low freq, so
      // reverse into the low→high ordered bin map.
      const [lo, hi] = eqBinMap[EQ_BARS - 1 - i]
      let sum = 0
      for (let b = lo; b < hi; b++) sum += live[b]
      const avg = sum / Math.max(1, hi - lo)
      // Tilt: bass (right, t→1) is naturally loud → attenuate; treble (left,
      // t→0) is quiet → boost. Keeps the whole spectrum lively instead of the
      // right half sitting at the ceiling.
      const t = i / (EQ_BARS - 1)        // 0 = left/high … 1 = right/low
      const tilt = 1.7 - 1.25 * t
      target = 3 + (avg / 255) * EQ_MAX_H * tilt
    } else if (!state.isPlaying) {
      target = 3
    } else {
      // Simulation fallback: two overlapping waves per band + beat kick
      const wave =
          Math.abs(Math.sin(eqClock * cfg.speed + cfg.phase))           * 0.65
        + Math.abs(Math.sin(eqClock * cfg.speed * 1.7 + cfg.phase * 1.4)) * 0.35
      target = 3
        + wave * cfg.amp
        + beat * cfg.kick
        + (Math.random() < 0.06 ? Math.random() * cfg.noise : 0)
    }
    // Ease toward the target: snappy for live/treble, smoother bass swell/decay
    const ease = live ? 0.55 : (state.isPlaying ? cfg.ease : 0.12)
    const h = Math.min(EQ_MAX_H, Math.max(3, prev + (target - prev) * ease))
    bar.style.height = h + 'px'
  })

  eqRaf = requestAnimationFrame(runEqualizer)
}

function setEqualizerPlaying(playing) {
  // state.isPlaying is already updated before this is called — no extra work needed
}

// Map the FFT bins (index 0 = lowest freq … high index = highest freq) onto the
// EQ_BARS, log-spaced for a natural look. Returned ranges are in low→high freq
// order; the renderer reverses them so the LEFT bars show high frequencies.
function buildEqBinMap(binCount) {
  // Focus on the musically important range. With fftSize 512 each bin is ~94 Hz,
  // so ~90 bins ≈ 8.5 kHz. Start at bin 2 to skip the loudest sub-bass rumble
  // that otherwise pins the low-frequency bars to the top.
  const usable = Math.max(24, Math.min(binCount - 1, 90))
  const minBin = 2
  const ranges = []
  for (let k = 0; k < EQ_BARS; k++) {
    const lo = Math.floor(minBin * Math.pow(usable / minBin, k / EQ_BARS))
    let hi = Math.floor(minBin * Math.pow(usable / minBin, (k + 1) / EQ_BARS))
    if (hi <= lo) hi = lo + 1
    ranges.push([lo, hi])
  }
  return ranges
}

// Grab the Windows system-audio output as a MediaStream. Tries the legacy
// desktop-capture path first (works on the widest range of Electron versions),
// then the modern getDisplayMedia loopback path. Returns null if neither works.
async function captureSystemAudio() {
  const attempts = [
    () => navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'desktop' } },
      video: { mandatory: { chromeMediaSource: 'desktop', maxWidth: 2, maxHeight: 2, maxFrameRate: 1 } },
    }),
    () => navigator.mediaDevices.getDisplayMedia({ audio: true, video: true }),
  ]
  for (const attempt of attempts) {
    try {
      const stream = await attempt()
      stream.getVideoTracks().forEach(t => t.stop()) // we only need the audio
      if (stream.getAudioTracks().length) return stream
      stream.getTracks().forEach(t => t.stop())
    } catch (e) {
      console.warn('System-audio capture attempt failed:', e && e.message)
    }
  }
  return null
}

async function initAudioAnalyser() {
  if (eqAnalyser) return true
  const stream = await captureSystemAudio()
  if (!stream) return false
  try {
    eqAudioCtx = new (window.AudioContext || window.webkitAudioContext)()
    eqAudioCtx.resume().catch(() => {})
    const src = eqAudioCtx.createMediaStreamSource(stream)
    const analyser = eqAudioCtx.createAnalyser()
    analyser.fftSize = 512
    analyser.smoothingTimeConstant = 0.72
    src.connect(analyser)
    eqAnalyser = analyser
    eqFreqData = new Uint8Array(analyser.frequencyBinCount)
    eqBinMap = buildEqBinMap(analyser.frequencyBinCount)
    showToast('🎚 Live-Audioanalyse aktiv (System-Sound)', 'success')
    return true
  } catch (e) {
    console.warn('AnalyserNode setup failed:', e && e.message)
    return false
  }
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
  // Safety: make sure no modal overlay is left open (an open overlay would
  // block all clicks/typing, including the search field)
  $('adminModal').classList.add('hidden')
  $('playlistPickerModal').classList.add('hidden')
  bindMainApp()
  await loadUserProfile()
  await loadOrCreatePartyPlaylist()
  startPolling()

  // Drive the equalizer from real system audio (Windows loopback). Capture may
  // require a user gesture, so retry on the first click if the initial try fails.
  if (!(await initAudioAnalyser())) {
    const retry = async () => {
      if (await initAudioAnalyser()) document.removeEventListener('click', retry)
    }
    document.addEventListener('click', retry)
  }
}

function bindMainApp() {
  // Player controls
  $('prevBtn').onclick      = () => playerCommand('previous')
  $('playPauseBtn').onclick = () => togglePlayPause()
  $('nextBtn').onclick      = () => playerCommand('next')
  bindSeekBar()
  // Skip buttons start locked for guests (admin-only)
  applyAdminPlayerControls()

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

  // Escape closes any open dialog (safety against a blocking overlay)
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      $('adminModal').classList.add('hidden')
      $('playlistPickerModal').classList.add('hidden')
    }
  })
}

// ── User Profile ──────────────────────────────────────────
async function loadUserProfile() {
  try {
    const me = await api.spotifyGet('/me')
    state.userId = me.id
    await api.setConfig('userId', me.id)
    $('userName').textContent = me.display_name || me.id
    const avatar = $('userAvatar')
    avatar.onerror = () => { avatar.style.display = 'none' }
    if (me.images && me.images.length > 0) {
      avatar.src = me.images[0].url
      avatar.classList.remove('hidden')
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
    // Use /me/playlists – does not require a user ID and avoids permission edge cases.
    // Create as PUBLIC (the original, working behaviour): adding tracks to a
    // public playlist you own works reliably. Switching this to private was a
    // regression that caused 403 Forbidden on adding tracks.
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
    // Post-migration playlists expose their item count under `items.total`;
    // older responses used `tracks.total`.
    const countObj = pl.items || pl.tracks
    const total = (countObj && typeof countObj.total === 'number') ? countObj.total : null
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
    // Read items from the playlist object itself, which embeds the first page
    // plus a `next` link. Field names depend on API era: `items` (post the
    // March 2026 migration) or `tracks` (older responses).
    const pl = await api.spotifyGet(`/playlists/${state.partyPlaylistId}`)
    if (pl && pl.snapshot_id) state.partyPlaylistSnapshot = pl.snapshot_id

    // Post-migration each entry is `.item`; pre-migration it was `.track`.
    const collect = items => {
      for (const entry of (items || [])) {
        const t = entry && (entry.item || entry.track)
        if (t && t.id) tracks.push(t)
      }
    }

    // The playlist object embeds its items under `items` (new) or `tracks`
    // (old). If neither is present, fetch the dedicated /items endpoint.
    let page = pl && (pl.items || pl.tracks) ? (pl.items || pl.tracks) : null
    if (!page || !page.items) {
      try { page = await api.spotifyGet(`/playlists/${state.partyPlaylistId}/items`) }
      catch (e) { console.warn('items endpoint read failed:', e.message) }
    }
    collect(page && page.items)

    // Follow pagination if the playlist has more than 100 tracks. If a page
    // request fails (e.g. 403 on the tracks endpoint), keep what we already have.
    // Follow pagination. Spotify's `next` URL still points to /tracks on old
    // responses; rewrite it to /items to stay on the new endpoint.
    let nextUrl = page ? page.next : null
    while (nextUrl) {
      try {
        const safeUrl = nextUrl.replace(/\/playlists\/([^/]+)\/tracks/, '/playlists/$1/items')
        const data = await api.spotifyGet(safeUrl)
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
  state.currentDurationMs = dur
  $('lcdCurrentTime').textContent = formatMs(cur)
  $('lcdTotalTime').textContent = formatMs(dur)
  // Don't fight the user while they're dragging the seek handle
  if (!state.isSeeking) {
    $('lcdTimeFill').style.width = `${(cur / dur * 100).toFixed(1)}%`
  }

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

// Admin: seek to a fraction (0..1) of the current track via the progress bar
async function seekToFraction(frac) {
  if (!state.isAdmin || !state.currentDurationMs) return
  const ms = Math.round(Math.max(0, Math.min(1, frac)) * state.currentDurationMs)
  try {
    await api.spotifyPut(`/me/player/seek?position_ms=${ms}`, null)
    setTimeout(pollPlayback, 500)
  } catch (err) {
    handlePlaybackError(err)
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

// Admin only: start the party playlist at a specific track (via double-click).
async function playTrackInPlaylist(index) {
  if (!state.isAdmin || !state.partyPlaylistId) return
  const track = state.playlistTracks[index]
  try {
    await api.spotifyPut('/me/player/play', {
      context_uri: `spotify:playlist:${state.partyPlaylistId}`,
      offset: { position: index },
    })
    showToast(`▶ ${track ? track.name : 'Titel'} wird abgespielt`, 'success')
    setTimeout(pollPlayback, 600)
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
    // Spotify's Feb 2026 dev-mode migration capped /search at limit=10 (max)
    // and dropped the default to 5 (hence the earlier "Invalid limit" on 20).
    // Request the new maximum of 10 per page and page through with `offset`,
    // accumulating across requests and stopping gracefully on error/empty.
    const seen = new Set()
    const all = []

    const fetchPage = async (offset) => {
      const params = new URLSearchParams({ q: query, type: 'track', limit: '10' })
      if (offset > 0) params.set('offset', String(offset))
      const data = await api.spotifyGet(`https://api.spotify.com/v1/search?${params}`)
      return (data && data.tracks && data.tracks.items) || []
    }

    // First page is the one we know always works (no extra params).
    const firstPage = await fetchPage(0)
    for (const t of firstPage) {
      if (t && t.uri && !seen.has(t.uri)) { seen.add(t.uri); all.push(t) }
    }

    // Try to pull more via offset. Page size is whatever the first page gave us
    // (typically ~5). Keep going until we have enough or a page fails/repeats.
    const pageSize = firstPage.length || 5
    const TARGET = 25
    let offset = pageSize
    while (all.length < TARGET && offset < 200) {
      let page
      try {
        page = await fetchPage(offset)
      } catch {
        break // offset rejected too — keep what we have
      }
      if (!page.length) break
      let added = 0
      for (const t of page) {
        if (t && t.uri && !seen.has(t.uri)) { seen.add(t.uri); all.push(t); added++ }
      }
      if (added === 0) break // no new tracks — stop to avoid looping
      offset += page.length
    }

    renderSearchResults(all)
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
    await createPartyPlaylist()
    if (!state.partyPlaylistId) return false
  }

  try {
    // Spotify's March 2026 migration replaced /playlists/{id}/tracks with
    // /playlists/{id}/items (the old path now returns 403 for dev-mode apps).
    const data = await api.spotifyPost(
      `/playlists/${state.partyPlaylistId}/items`,
      { uris: [uri] }
    )
    state.partyPlaylistSnapshot = data && data.snapshot_id
    await loadPlaylistTracks()
    showToast('🎵 Song zur Party Playlist hinzugefügt!', 'success')
    return true
  } catch (err) {
    if (err.message.includes('403')) {
      // Token, scopes, ownership and TLS are all confirmed fine, and a fresh
      // PUBLIC playlist is forbidden too — so this is a Spotify-side block, not
      // something the code can work around. Just report it clearly.
      await handleWriteForbidden(err)
    } else {
      showToast('Fehler beim Hinzufügen: ' + err.message, 'error')
    }
    return false
  }
}

async function isPlaylistOwnedByUser(playlistId) {
  try {
    const pl = await api.spotifyGet(`/playlists/${playlistId}`)
    return !!(pl && pl.owner && pl.owner.id === state.userId)
  } catch {
    return false
  }
}

// Shown when Spotify refuses a write (403) even though we own the playlist.
async function handleWriteForbidden(err) {
  const scopes = await api.getConfig('grantedScopes')
  console.warn('Write forbidden. Granted scopes:', scopes, '| error:', err && err.message)
  const tlsMatch = err && err.message ? err.message.match(/\[TLS-Aussteller: ([^\]]+)\]/) : null
  const issuer = tlsMatch ? tlsMatch[1] : '?'
  const legitIssuers = ['DigiCert', 'Amazon', 'GlobalSign', 'Lets Encrypt', 'Let\'s Encrypt']
  const tlsClean = legitIssuers.some(ca => issuer.includes(ca))

  const hasModify = typeof scopes === 'string' &&
    (scopes.includes('playlist-modify-public') || scopes.includes('playlist-modify-private'))

  if (!tlsClean && issuer !== '?') {
    // Suspicious issuer: antivirus/proxy is likely intercepting HTTPS
    showToast(`403 + verdächtiger TLS-Aussteller: ${issuer}. Antivirus oder Proxy blockiert möglicherweise die Verbindung zu Spotify.`, 'error', 14000)
  } else if (!hasModify) {
    // The modify scopes weren't actually granted — re-login is the fix.
    showToast(
      `403: Schreib-Berechtigung fehlt im Token. Erteilte Rechte: ${scopes || '(keine)'} — bitte LOGOUT + neu einloggen und im Spotify-Dialog alles bestätigen.`,
      'error',
      16000
    )
  } else {
    // Scopes are present and TLS is fine (DigiCert = echtes Spotify-Zertifikat).
    // 403 kommt direkt von Spotify — häufigste Ursache: App im "Development Mode"
    // ohne User-Management-Eintrag.
    showToast(
      '403: Rechte sind vorhanden, Spotify verweigert trotzdem. Lösung: developer.spotify.com → deine App → Settings → User Management → deine Spotify-E-Mail hinzufügen. Danach LOGOUT + neu einloggen.',
      'error',
      16000
    )
  }
}

// Replace the whole playlist contents with `uris` via PUT (the same /items
// endpoint that reordering uses). This avoids the ambiguous DELETE request-body
// format after the 2026 migration. Handles >100 items by appending the rest
// with POST. Passing [] empties the playlist.
async function replacePlaylistItems(uris) {
  const put = await api.spotifyPut(
    `/playlists/${state.partyPlaylistId}/items`,
    { uris: uris.slice(0, 100) }
  )
  if (put && put.snapshot_id) state.partyPlaylistSnapshot = put.snapshot_id
  for (let i = 100; i < uris.length; i += 100) {
    const post = await api.spotifyPost(
      `/playlists/${state.partyPlaylistId}/items`,
      { uris: uris.slice(i, i + 100) }
    )
    if (post && post.snapshot_id) state.partyPlaylistSnapshot = post.snapshot_id
  }
}

async function removeTrackFromPlaylist(uri, index) {
  if (!state.partyPlaylistId) return
  try {
    const remaining = state.playlistTracks
      .filter((_, i) => i !== index)
      .map(t => t.uri)
    await replacePlaylistItems(remaining)
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
      `/playlists/${state.partyPlaylistId}/items`,
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
    await replacePlaylistItems([])
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
      div.classList.add('admin-playable')
      div.title = 'Doppelklick: sofort abspielen'
      div.addEventListener('dragstart', onDragStart)
      div.addEventListener('dragover', onDragOver)
      div.addEventListener('dragleave', onDragLeave)
      div.addEventListener('drop', onDrop)
      div.addEventListener('dragend', onDragEnd)

      // Admin only: double-click a row to start the playlist at that track
      div.addEventListener('dblclick', () => playTrackInPlaylist(index))

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

// Skip (prev/next) is admin-only: guests must not jump around the party
// playlist. Grey the buttons out and disable them unless admin mode is active.
function applyAdminPlayerControls() {
  const adminOnly = ['prevBtn', 'nextBtn']
  adminOnly.forEach(id => {
    const btn = $(id)
    if (!btn) return
    btn.disabled = !state.isAdmin
    btn.classList.toggle('admin-locked', !state.isAdmin)
    btn.title = state.isAdmin
      ? (id === 'prevBtn' ? 'Vorheriger Titel' : 'Nächster Titel')
      : 'Nur als Admin verfügbar'
  })
  // Progress bar is draggable (seek) only for admins
  const seekBar = $('lcdTimeBar')
  if (seekBar) {
    seekBar.classList.toggle('admin-seekable', state.isAdmin)
    seekBar.title = state.isAdmin ? 'Ziehen zum Vor-/Zurückspulen' : ''
  }
}

// Drag/click the progress bar to seek (admin only)
function bindSeekBar() {
  const bar = $('lcdTimeBar')
  if (!bar) return
  let dragging = false

  const fracFromEvent = (e) => {
    const rect = bar.getBoundingClientRect()
    const frac = (e.clientX - rect.left) / rect.width
    return Math.max(0, Math.min(1, frac))
  }
  const paint = (frac) => { $('lcdTimeFill').style.width = (frac * 100) + '%' }

  bar.addEventListener('pointerdown', (e) => {
    if (!state.isAdmin || !state.currentDurationMs) return
    dragging = true
    state.isSeeking = true
    try { bar.setPointerCapture(e.pointerId) } catch { /* ignore */ }
    paint(fracFromEvent(e))
  })
  bar.addEventListener('pointermove', (e) => {
    if (!dragging) return
    paint(fracFromEvent(e))
  })
  bar.addEventListener('pointerup', async (e) => {
    if (!dragging) return
    dragging = false
    const frac = fracFromEvent(e)
    paint(frac)
    try { bar.releasePointerCapture(e.pointerId) } catch { /* ignore */ }
    await seekToFraction(frac)
    state.isSeeking = false
  })
}

function enterAdminMode() {
  state.isAdmin = true
  $('adminBadge').classList.remove('hidden')
  $('adminToggleBtn').textContent = '🔓 ADMIN AN'
  $('adminToggleBtn').classList.add('primary')
  $('adminToggleBtn').classList.remove('secondary')
  $('adminPlaylistControls').classList.remove('hidden')
  applyAdminPlayerControls()
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
  applyAdminPlayerControls()
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
function showToast(message, type = '', duration = 3200) {
  const toast = $('toast')
  toast.textContent = message
  toast.className = `toast ${type}`
  toast.classList.remove('hidden')

  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    toast.classList.add('hidden')
  }, duration)
}

// ── Boot ──────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init)
