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
const WEBHOOK_URL = process.env.WEBHOOK_URL || null
// Use /data for Railway Volumes (persistent), fallback to local
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '.data')
const AUTH_DIR = path.join(DATA_DIR, 'auth')
const STATUS_FILE = path.join(DATA_DIR, 'status.json')

// Send webhook to CRM
async function sendWebhook(event, data) {
  if (!WEBHOOK_URL) return
  try {
    await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, ...data, timestamp: new Date().toISOString() }),
      signal: AbortSignal.timeout(10000),
    })
    console.log(`[Bridge] Webhook sent: ${event}`)
  } catch (err) {
    console.error(`[Bridge] Webhook failed (${event}):`, err.message)
  }
}

// Send message via WhatsApp
async function sendMessage(jid, text) {
  if (!sock || connectionStatus !== 'connected') {
    throw new Error('WhatsApp not connected')
  }
  const formattedJid = jid.includes('@') ? jid : `${jid}@s.whatsapp.net`
  const result = await sock.sendMessage(formattedJid, { text })
  return result
}

// Parse body from request
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', chunk => body += chunk)
    req.on('end', () => {
      try { resolve(JSON.parse(body)) } catch { resolve({}) }
    })
    req.on('error', reject)
  })
}

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })

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
        // Only stop reconnecting if user explicitly logged out
        const isLoggedOut = statusCode === DisconnectReason.loggedOut

        console.log('[Bridge] Connection closed, statusCode:', statusCode, 'loggedOut:', isLoggedOut)

        if (isLoggedOut) {
          connectionStatus = 'disconnected'
          currentQR = null
          connectedInfo = null
          if (fs.existsSync(AUTH_DIR)) {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true })
          }
          writeStatus()
          console.log('[Bridge] Logged out by user. Auth cleared.')
        } else {
          // Always reconnect for any other reason (network drop, timeout, server restart, etc.)
          connectionStatus = 'connecting'
          currentQR = null
          writeStatus()
          const delay = statusCode === 515 ? 1000 : 5000 // Faster retry for stream errors
          console.log(`[Bridge] Reconnecting in ${delay / 1000}s...`)
          setTimeout(() => startWhatsApp(), delay)
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

    // Listen for incoming messages and forward to CRM via webhook
    sock.ev.on('messages.upsert', (m) => {
      if (m.type === 'notify') {
        for (const msg of m.messages) {
          const jid = msg.key.remoteJid
          // Skip status broadcasts and groups for now
          if (!jid || jid === 'status@broadcast' || jid.endsWith('@g.us')) continue

          const text = msg.message?.conversation
            || msg.message?.extendedTextMessage?.text
            || msg.message?.imageMessage?.caption
            || msg.message?.videoMessage?.caption
            || ''

          const mediaType = msg.message?.imageMessage ? 'image'
            : msg.message?.videoMessage ? 'video'
            : msg.message?.audioMessage ? 'audio'
            : msg.message?.documentMessage ? 'document'
            : null

          const pushName = msg.pushName || null
          const fromMe = msg.key.fromMe || false

          console.log(`[Bridge] ${fromMe ? 'Sent' : 'Received'} ${jid}: ${text || '[media]'}`)

          sendWebhook('message', {
            messageId: msg.key.id,
            jid,
            fromMe,
            pushName,
            body: text || (mediaType ? `[${mediaType}]` : ''),
            mediaType,
            phone: jid.split('@')[0],
          })
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

  // POST /send - Send a message
  if (req.method === 'POST' && url.pathname === '/send') {
    try {
      const body = await parseBody(req)
      if (!body.jid || !body.text) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Missing jid or text' }))
        return
      }
      const result = await sendMessage(body.jid, body.text)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'sent', messageId: result.key.id }))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err.message }))
    }
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
  console.log(`  GET  /status     - Check connection status`)
  console.log(`  POST /connect    - Start WhatsApp connection`)
  console.log(`  POST /disconnect - Disconnect WhatsApp`)
  console.log(`  POST /send       - Send message { jid, text }`)
  console.log(`  GET  /health     - Health check`)
  console.log('')
  console.log('Webhook URL:', WEBHOOK_URL || '(not configured)')
  console.log('')
  console.log('Configure WEBHOOK_URL env var to receive messages in FlowCRM')
  console.log('')

  // Write initial status
  writeStatus()

  // Auto-connect if auth session exists from previous run
  if (fs.existsSync(AUTH_DIR) && fs.readdirSync(AUTH_DIR).length > 0) {
    console.log('[Bridge] Found existing auth session, auto-connecting...')
    startWhatsApp()
  } else {
    console.log('[Bridge] No auth session found, waiting for /connect request...')
  }
})
