const { app, BrowserWindow, ipcMain, shell } = require('electron')
const path = require('path')
const http = require('http')
const https = require('https')
const crypto = require('crypto')
const fs = require('fs')

const SPOTIFY_REDIRECT_URI = 'http://127.0.0.1:8888/callback'
const SPOTIFY_SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'playlist-read-private',
  'playlist-read-collaborative',
  'playlist-modify-public',
  'playlist-modify-private',
  'user-read-email',
  'user-read-private',
].join(' ')

let mainWindow
let config = {}
let callbackServer = null
let codeVerifier = null

function getConfigPath() {
  return path.join(app.getPath('userData'), 'config.json')
}

function loadConfig() {
  try {
    const data = fs.readFileSync(getConfigPath(), 'utf8')
    config = JSON.parse(data)
  } catch {
    config = {}
  }
}

function saveConfig() {
  try {
    fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2))
  } catch (err) {
    console.error('Failed to save config:', err)
  }
}

function generateCodeVerifier() {
  return crypto.randomBytes(64).toString('base64url')
}

function generateCodeChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url')
}

function hashPassword(password) {
  return crypto.createHash('sha256').update(password + 'party-shaker-2000-salt').digest('hex')
}

async function spotifyRequest(method, endpoint, body = null) {
  const token = await getValidToken()
  if (!token) throw new Error('Not authenticated')

  const fullUrl = endpoint.startsWith('http')
    ? endpoint
    : `https://api.spotify.com/v1${endpoint}`

  return new Promise((resolve, reject) => {
    const headers = {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json',
    }

    let bodyData = null
    if (body !== null && body !== undefined) {
      bodyData = JSON.stringify(body)
      headers['Content-Type'] = 'application/json'
      headers['Content-Length'] = Buffer.byteLength(bodyData)
    }

    // Canonical form: parse the URL into discrete options. Passing a URL string
    // together with an options object can drop the query string in some
    // Electron/Node builds, which made Spotify reject the (missing) limit param.
    const u = new URL(fullUrl)
    const options = {
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: method.toUpperCase(),
      headers,
    }

    const req = https.request(options, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        if (res.statusCode === 204 || res.statusCode === 202) {
          resolve(null)
        } else if (res.statusCode >= 200 && res.statusCode < 300) {
          if (!data) { resolve(null); return }
          try { resolve(JSON.parse(data)) }
          catch { resolve(null) }
        } else {
          const msg = `Spotify API ${res.statusCode}: ${data}`
          console.error(`[Spotify] ${method.toUpperCase()} ${fullUrl} → ${res.statusCode}`)
          reject(new Error(msg))
        }
      })
    })

    req.on('error', reject)
    if (bodyData) req.write(bodyData)
    req.end()
  })
}

async function getValidToken() {
  if (!config.accessToken) return null
  const now = Date.now()
  if (config.tokenExpiry && now >= config.tokenExpiry - 60000) {
    try {
      await refreshAccessToken()
    } catch (err) {
      console.error('Token refresh failed:', err)
      config.accessToken = null
      config.refreshToken = null
      saveConfig()
      return null
    }
  }
  return config.accessToken
}

async function refreshAccessToken() {
  if (!config.refreshToken || !config.clientId) {
    throw new Error('No refresh token or client ID')
  }

  const postData = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: config.refreshToken,
    client_id: config.clientId,
  }).toString()

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'accounts.spotify.com',
      path: '/api/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
      },
    }
    const req = https.request(options, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        try {
          const json = JSON.parse(data)
          if (!json.access_token) { reject(new Error('Refresh failed: ' + data)); return }
          config.accessToken = json.access_token
          config.tokenExpiry = Date.now() + (json.expires_in * 1000)
          if (json.refresh_token) config.refreshToken = json.refresh_token
          saveConfig()
          resolve(json.access_token)
        } catch (err) { reject(err) }
      })
    })
    req.on('error', reject)
    req.write(postData)
    req.end()
  })
}

async function exchangeCodeForToken(code) {
  const postData = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: SPOTIFY_REDIRECT_URI,
    client_id: config.clientId,
    code_verifier: codeVerifier,
  }).toString()

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'accounts.spotify.com',
      path: '/api/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
      },
    }
    const req = https.request(options, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        try {
          const json = JSON.parse(data)
          if (!json.access_token) { reject(new Error(`Token exchange failed: ${data}`)); return }
          config.accessToken = json.access_token
          config.refreshToken = json.refresh_token
          config.tokenExpiry = Date.now() + (json.expires_in * 1000)
          config.grantedScopes = json.scope || ''
          saveConfig()
          resolve(json)
        } catch (err) { reject(err) }
      })
    })
    req.on('error', reject)
    req.write(postData)
    req.end()
  })
}

function startCallbackServer(resolve, reject) {
  if (callbackServer) {
    callbackServer.close()
    callbackServer = null
  }

  callbackServer = http.createServer((req, res) => {
    const reqUrl = new URL(req.url, 'http://127.0.0.1:8888')
    if (reqUrl.pathname !== '/callback') {
      res.writeHead(404)
      res.end()
      return
    }

    const code = reqUrl.searchParams.get('code')
    const error = reqUrl.searchParams.get('error')

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(`<!DOCTYPE html>
<html>
<head><style>
  body{background:#0d0d1a;color:#39ff14;font-family:monospace;
       display:flex;justify-content:center;align-items:center;
       height:100vh;margin:0;font-size:28px;text-align:center;}
  .box{border:2px solid #39ff14;padding:40px;box-shadow:0 0 30px #39ff14;}
</style></head>
<body><div class="box">
  ✓ Auth complete!<br>
  <small style="font-size:16px;color:#00fff5">You can close this tab and return to Party Shaker</small>
</div><script>setTimeout(()=>window.close(),2500)</script></body>
</html>`)

    if (callbackServer) {
      callbackServer.close()
      callbackServer = null
    }

    if (code) {
      exchangeCodeForToken(code)
        .then(resolve)
        .catch(reject)
    } else {
      reject(new Error(error || 'No authorization code received'))
    }
  })

  callbackServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      reject(new Error('Port 8888 is already in use. Please close any other apps using this port.'))
    } else {
      reject(err)
    }
  })

  callbackServer.listen(8888, '127.0.0.1')
}

app.whenReady().then(() => {
  loadConfig()

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 980,
    minHeight: 680,
    frame: false,
    backgroundColor: '#0d0d1a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  })

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'))

  // F12 toggles the DevTools console (helps diagnose API/runtime issues)
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') {
      mainWindow.webContents.toggleDevTools()
      event.preventDefault()
    }
  })
})

app.on('window-all-closed', () => {
  if (callbackServer) callbackServer.close()
  if (process.platform !== 'darwin') app.quit()
})

// IPC Handlers

ipcMain.handle('get-config', (_, key) => config[key] !== undefined ? config[key] : null)

ipcMain.handle('set-config', (_, key, value) => {
  config[key] = value
  saveConfig()
  return true
})

ipcMain.handle('get-all-config', () => {
  const safe = { ...config }
  delete safe.accessToken
  delete safe.refreshToken
  return safe
})

ipcMain.handle('start-auth', () => {
  if (!config.clientId) {
    return { success: false, error: 'No Client ID configured' }
  }

  codeVerifier = generateCodeVerifier()
  const codeChallenge = generateCodeChallenge(codeVerifier)

  const authUrl = new URL('https://accounts.spotify.com/authorize')
  authUrl.searchParams.set('client_id', config.clientId)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('redirect_uri', SPOTIFY_REDIRECT_URI)
  authUrl.searchParams.set('scope', SPOTIFY_SCOPES)
  authUrl.searchParams.set('code_challenge_method', 'S256')
  authUrl.searchParams.set('code_challenge', codeChallenge)
  // Force the consent screen so all requested scopes are granted fresh
  authUrl.searchParams.set('show_dialog', 'true')

  return new Promise((resolve) => {
    startCallbackServer(
      () => {
        mainWindow.webContents.send('auth-complete', { success: true })
        resolve({ success: true })
      },
      (err) => {
        mainWindow.webContents.send('auth-complete', { success: false, error: err.message })
        resolve({ success: false, error: err.message })
      }
    )
    shell.openExternal(authUrl.toString())
  })
})

ipcMain.handle('is-authenticated', async () => {
  const token = await getValidToken()
  return !!token
})

ipcMain.handle('logout', () => {
  config.accessToken = null
  config.refreshToken = null
  config.tokenExpiry = null
  config.userId = null
  config.partyPlaylistId = null
  saveConfig()
  return true
})

ipcMain.handle('spotify-request', async (_, { method, endpoint, body }) => {
  return spotifyRequest(method, endpoint, body)
})

ipcMain.handle('check-password', (_, password) => {
  const storedHash = config.adminPasswordHash
  const inputHash = hashPassword(password)
  if (!storedHash) {
    return inputHash === hashPassword('party2000')
  }
  return inputHash === storedHash
})

ipcMain.handle('set-admin-password', (_, newPassword) => {
  config.adminPasswordHash = hashPassword(newPassword)
  saveConfig()
  return true
})

ipcMain.handle('window-minimize', () => mainWindow.minimize())

ipcMain.handle('window-maximize', () => {
  if (mainWindow.isMaximized()) mainWindow.unmaximize()
  else mainWindow.maximize()
})

ipcMain.handle('window-close', () => mainWindow.close())
