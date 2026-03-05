#!/usr/bin/env node
/**
 * FlowCRM WhatsApp Bridge Server
 * 
 * Servidor standalone que conecta ao WhatsApp Web via Baileys
 * e expoe uma API HTTP para o CRM consumir.
 * 
 * USO:
 *   cd whatsapp-bridge
 *   npm install
 *   node index.js
 * 
 * O servidor roda na porta 3001 (ou PORT env).
 * O CRM se conecta a http://localhost:3001
 */

const http = require('http')
const fs = require('fs')
const path = require('path')

const PORT = process.env.PORT || 3001
const AUTH_DIR = path.join(__dirname, '.auth-data')
const STATUS_FILE = path.join(__dirname, '.status.json')

// State
let sock = null
let currentQR = null
let connectionStatus = 'disconnected' // disconnected | connecting | qr_ready | connected | error
let connectedInfo = null
let lastError = null

function writeStatus() {
  const data = {
    status: connectionStatus,
    qrCode: currentQR,
    phoneNumber: connectedInfo?.phoneNumber || null,
    pushName: connectedInfo?.pushName || null,
    error: lastError,
    updatedAt: new Date().toISOString()
  }
  fs.writeFileSync(STATUS_FILE, JSON.stringify(data))
}

async function startWhatsApp() {
  try {
    connectionStatus = 'connecting'
    currentQR = null
    lastError = null
    writeStatus()

    // Dynamic import for ESM baileys
    const baileys = await import('@whiskeysockets/baileys')
    const makeWASocket = baileys.default?.default || baileys.default || baileys.makeWASocket
    const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, Browsers } = baileys

    const pino = (await import('pino')).default
    const logger = pino({ level: 'silent' })

    const QRCode = (await import('qrcode')).default

    if (!fs.existsSync(AUTH_DIR)) {
      fs.mkdirSync(AUTH_DIR, { recursive: true })
    }

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
    const { version } = await fetchLatestBaileysVersion()

    console.log('[Bridge] Baileys version:', version.join('.'))
    console.log('[Bridge] Connecting to WhatsApp...')

    sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      browser: Browsers.ubuntu('FlowCRM'),
      logger,
      printQRInTerminal: true,
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
    })

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update

      if (qr) {
        console.log('[Bridge] QR Code received, generating image...')
        try {
          currentQR = await QRCode.toDataURL(qr, {
            width: 400,
            margin: 2,
            color: { dark: '#000000', light: '#ffffff' }
          })
          connectionStatus = 'qr_ready'
          writeStatus()
          console.log('[Bridge] QR Code ready - scan with your phone!')
        } catch (err) {
          console.error('[Bridge] QR generation error:', err)
          lastError = 'Failed to generate QR code'
          connectionStatus = 'error'
          writeStatus()
        }
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut

        console.log('[Bridge] Connection closed, statusCode:', statusCode, 'reconnecting:', shouldReconnect)

        if (shouldReconnect) {
          connectionStatus = 'connecting'
          currentQR = null
          writeStatus()
          setTimeout(() => startWhatsApp(), 3000)
        } else {
          connectionStatus = 'disconnected'
          currentQR = null
          connectedInfo = null
          // Clear auth on logout
          if (fs.existsSync(AUTH_DIR)) {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true })
          }
          writeStatus()
          console.log('[Bridge] Logged out. Auth cleared.')
        }
      }

      if (connection === 'open') {
        console.log('[Bridge] Connected to WhatsApp!')
        const user = sock.user
        connectionStatus = 'connected'
        currentQR = null
        connectedInfo = {
          phoneNumber: user?.id?.split(':')[0] || user?.id?.split('@')[0] || 'Unknown',
          pushName: user?.name || 'Unknown'
        }
        writeStatus()
        console.log('[Bridge] Phone:', connectedInfo.phoneNumber, '| Name:', connectedInfo.pushName)
      }
    })

    // Listen for messages (log them)
    sock.ev.on('messages.upsert', (m) => {
      if (m.type === 'notify') {
        for (const msg of m.messages) {
          if (!msg.key.fromMe) {
            const from = msg.key.remoteJid
            const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '[media]'
            console.log(`[Bridge] Message from ${from}: ${text}`)
          }
        }
      }
    })

  } catch (err) {
    console.error('[Bridge] Fatal error:', err)
    lastError = err.message || 'Unknown error'
    connectionStatus = 'error'
    writeStatus()
  }
}

async function disconnectWhatsApp() {
  try {
    if (sock) {
      await sock.logout()
      sock = null
    }
  } catch {
    // ignore
  }
  connectionStatus = 'disconnected'
  currentQR = null
  connectedInfo = null
  lastError = null
  // Clear auth
  if (fs.existsSync(AUTH_DIR)) {
    fs.rmSync(AUTH_DIR, { recursive: true, force: true })
  }
  writeStatus()
}

// HTTP Server with CORS
const server = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  const url = new URL(req.url, `http://localhost:${PORT}`)

  // GET /status - Return current status
  if (req.method === 'GET' && url.pathname === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      status: connectionStatus,
      qrCode: currentQR,
      phoneNumber: connectedInfo?.phoneNumber || null,
      pushName: connectedInfo?.pushName || null,
      error: lastError,
    }))
    return
  }

  // POST /connect - Start connection
  if (req.method === 'POST' && url.pathname === '/connect') {
    if (connectionStatus === 'connected') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'connected', message: 'Already connected' }))
      return
    }
    startWhatsApp()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'connecting', message: 'Starting connection...' }))
    return
  }

  // POST /disconnect - Disconnect
  if (req.method === 'POST' && url.pathname === '/disconnect') {
    await disconnectWhatsApp()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'disconnected', message: 'Disconnected' }))
    return
  }

  // GET /health - Health check (Railway usa para verificar se esta vivo)
  if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/')) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, status: connectionStatus, uptime: process.uptime() }))
    return
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'Not found' }))
})

server.listen(PORT, () => {
  console.log('=========================================')
  console.log('  FlowCRM WhatsApp Bridge Server')
  console.log(`  Running on http://localhost:${PORT}`)
  console.log('=========================================')
  console.log('')
  console.log('Endpoints:')
  console.log(`  GET  http://localhost:${PORT}/status     - Check status`)
  console.log(`  POST http://localhost:${PORT}/connect    - Start connection`)
  console.log(`  POST http://localhost:${PORT}/disconnect - Disconnect`)
  console.log('')
  console.log('Configure this URL in FlowCRM > Canais > WhatsApp Lite')
  console.log('')

  // Write initial status
  writeStatus()
})
