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
const { execFile } = require('child_process')

// Convert audio buffer (webm/any) to ogg opus using ffmpeg
function convertToOggOpus(inputBuffer) {
  return new Promise((resolve, reject) => {
    const tmpInput = path.join(require('os').tmpdir(), `wa_in_${Date.now()}.webm`)
    const tmpOutput = path.join(require('os').tmpdir(), `wa_out_${Date.now()}.ogg`)
    fs.writeFileSync(tmpInput, inputBuffer)
    execFile('ffmpeg', [
      '-i', tmpInput,
      '-ar', '48000', '-ac', '1',
      '-c:a', 'libopus', '-b:a', '64k',
      '-application', 'voip',
      '-f', 'ogg', '-y', tmpOutput
    ], (err) => {
      try { fs.unlinkSync(tmpInput) } catch {}
      if (err) {
        try { fs.unlinkSync(tmpOutput) } catch {}
        console.error('[Bridge] ffmpeg error:', err.message)
        // Fallback: send original buffer as-is
        resolve(inputBuffer)
        return
      }
      try {
        const outputBuffer = fs.readFileSync(tmpOutput)
        fs.unlinkSync(tmpOutput)
        resolve(outputBuffer)
      } catch (readErr) {
        reject(readErr)
      }
    })
  })
}

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

// Send text message via WhatsApp (with optional reply)
async function sendMessage(jid, text, quotedMessageId) {
  if (!sock || connectionStatus !== 'connected') throw new Error('WhatsApp not connected')
  const formattedJid = jid.includes('@') ? jid : `${jid}@s.whatsapp.net`
  const content = { text }
  const options = {}
  if (quotedMessageId) {
    const chat = chatStore[formattedJid]
    if (chat) {
      const quotedMsg = chat.messages.find(m => m.messageId === quotedMessageId)
      if (quotedMsg && quotedMsg._raw) {
        options.quoted = quotedMsg._raw
      }
    }
  }
  const result = await sock.sendMessage(formattedJid, content, Object.keys(options).length > 0 ? options : undefined)
  return result
}

// Send media (image, document, video, audio) via WhatsApp
async function sendMedia(jid, { type, buffer, mimetype, filename, caption, quotedMessageId }) {
  if (!sock || connectionStatus !== 'connected') throw new Error('WhatsApp not connected')
  const formattedJid = jid.includes('@') ? jid : `${jid}@s.whatsapp.net`
  let content = {}
  if (type === 'image') {
    content = { image: buffer, mimetype: mimetype || 'image/jpeg', caption }
  } else if (type === 'video') {
    content = { video: buffer, mimetype: mimetype || 'video/mp4', caption }
  } else if (type === 'audio') {
    // Convert to ogg/opus using ffmpeg for WhatsApp compatibility
    console.log('[Bridge] Converting audio to ogg/opus...')
    const convertedBuffer = await convertToOggOpus(buffer)
    console.log('[Bridge] Audio converted, size:', convertedBuffer.length)
    buffer = convertedBuffer // use converted for both sending and storing
    content = { audio: convertedBuffer, mimetype: 'audio/ogg; codecs=opus', ptt: true }
  } else {
    content = { document: buffer, mimetype: mimetype || 'application/octet-stream', fileName: filename || 'file' }
  }
  // Build options separately (quoted for reply)
  const options = {}
  if (quotedMessageId) {
    const chat = chatStore[formattedJid]
    if (chat) {
      const quotedMsg = chat.messages.find(m => m.messageId === quotedMessageId)
      if (quotedMsg && quotedMsg._raw) {
        options.quoted = quotedMsg._raw
      }
    }
  }
  const result = await sock.sendMessage(formattedJid, content, Object.keys(options).length > 0 ? options : undefined)
  
  // Store sent media in mediaStore so it can be viewed in CRM
  if (result?.key?.id && buffer) {
    const keys = Object.keys(mediaStore)
    if (keys.length >= MAX_MEDIA_ITEMS) delete mediaStore[keys[0]]
    mediaStore[result.key.id] = { buffer, mimetype: mimetype || content.mimetype || 'application/octet-stream' }
    console.log(`[Bridge] Sent media stored: ${result.key.id}`)
  }
  return result
}

// Edit a sent message
async function editMessage(jid, messageId, newText) {
  if (!sock || connectionStatus !== 'connected') throw new Error('WhatsApp not connected')
  const formattedJid = jid.includes('@') ? jid : `${jid}@s.whatsapp.net`
  const key = { remoteJid: formattedJid, fromMe: true, id: messageId }
  const result = await sock.sendMessage(formattedJid, { text: newText, edit: key })
  // Update in store
  if (chatStore[formattedJid]) {
    const msg = chatStore[formattedJid].messages.find(m => m.messageId === messageId)
    if (msg) { msg.body = newText; msg.edited = true }
  }
  return result
}

// Parse JSON body from request
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

// Parse raw body as Buffer for media uploads
function parseRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })

// In-memory chat store
const chatStore = {}
const MAX_MESSAGES_PER_CHAT = 200

// Media store: { [messageId]: { buffer: Buffer, mimetype: string } }
const mediaStore = {}
const MAX_MEDIA_ITEMS = 500

async function downloadAndStoreMedia(msg) {
  try {
    const baileys = await import('@whiskeysockets/baileys')
    const downloadContentFromMessage = baileys.downloadContentFromMessage || baileys.default?.downloadContentFromMessage
    
    const audioMsg = msg.message?.audioMessage
    const imageMsg = msg.message?.imageMessage
    const videoMsg = msg.message?.videoMessage
    const docMsg = msg.message?.documentMessage
    const stickerMsg = msg.message?.stickerMessage

    // Determine media message and type
    const mediaMsg = audioMsg || imageMsg || videoMsg || docMsg || stickerMsg
    if (!mediaMsg) { console.log('[Bridge] No media message found in:', msg.key.id); return null }

    const mediaType = audioMsg ? 'audio' : imageMsg ? 'image' : videoMsg ? 'video' : docMsg ? 'document' : 'sticker'
    const mimetype = mediaMsg.mimetype || 'application/octet-stream'
    const msgId = msg.key.id

    console.log(`[Bridge] Downloading media ${msgId} (${mediaType}, ${mimetype})...`)

    // Try downloadContentFromMessage first (more reliable)
    if (downloadContentFromMessage) {
      try {
        const dlType = audioMsg ? (mediaMsg.ptt ? 'ptt' : 'audio') : mediaType
        const stream = await downloadContentFromMessage(mediaMsg, dlType)
        const chunks = []
        for await (const chunk of stream) { chunks.push(chunk) }
        const buffer = Buffer.concat(chunks)
        if (buffer.length > 0) {
          const keys = Object.keys(mediaStore)
          if (keys.length >= MAX_MEDIA_ITEMS) delete mediaStore[keys[0]]
          mediaStore[msgId] = { buffer, mimetype }
          console.log(`[Bridge] Media stored via stream: ${msgId} (${mimetype}, ${buffer.length} bytes)`)
          return msgId
        }
      } catch (streamErr) {
        console.log('[Bridge] downloadContentFromMessage failed:', streamErr.message)
      }
    }

    // Fallback: try downloadMediaMessage
    const downloadMediaMessage = baileys.downloadMediaMessage || baileys.default?.downloadMediaMessage
    if (downloadMediaMessage) {
      const buffer = await downloadMediaMessage(msg, 'buffer', {})
      if (buffer && buffer.length > 0) {
        const keys = Object.keys(mediaStore)
        if (keys.length >= MAX_MEDIA_ITEMS) delete mediaStore[keys[0]]
        mediaStore[msgId] = { buffer, mimetype }
        console.log(`[Bridge] Media stored via download: ${msgId} (${mimetype}, ${buffer.length} bytes)`)
        return msgId
      }
    }

    console.log('[Bridge] Both download methods failed for:', msgId)
    return null
  } catch (err) {
    console.error('[Bridge] Media download failed:', err.message)
    return null
  }
}

// Profile picture cache { [jid]: { url: string | null, fetchedAt: number } }
const profilePicCache = {}
const PROFILE_PIC_TTL = 1000 * 60 * 60 // 1 hour cache

async function getProfilePicUrl(jid, forceRefresh = false) {
  const formattedJid = jid.includes('@') ? jid : `${jid}@s.whatsapp.net`
  const cached = profilePicCache[formattedJid]
  if (!forceRefresh && cached && Date.now() - cached.fetchedAt < PROFILE_PIC_TTL) return cached.url
  if (!sock || connectionStatus !== 'connected') {
    console.log('[Bridge] Cannot fetch profile pic - not connected')
    return null
  }
  try {
    console.log(`[Bridge] Fetching profile pic for ${formattedJid}...`)
    const url = await sock.profilePictureUrl(formattedJid, 'image')
    console.log(`[Bridge] Profile pic found: ${url ? 'yes' : 'no (private)'}`)
    profilePicCache[formattedJid] = { url, fetchedAt: Date.now() }
    return url
  } catch {
    // No profile pic or privacy settings block it
    profilePicCache[formattedJid] = { url: null, fetchedAt: Date.now() }
    return null
  }
}

function upsertChat(jid, { pushName, body, fromMe, messageId, timestamp, mediaType, quotedMessageId, quotedBody, _raw, hasMedia }) {
  const phone = jid.split('@')[0]
  if (!chatStore[jid]) {
    chatStore[jid] = { jid, phone, pushName: pushName || phone, lastMessage: '', lastMessageAt: new Date().toISOString(), unreadCount: 0, messages: [] }
  }
  const chat = chatStore[jid]
  if (pushName && pushName !== phone) chat.pushName = pushName
  const ts = timestamp || new Date().toISOString()
  
  // Check duplicate
  if (messageId && chat.messages.some(m => m.messageId === messageId)) return chat

  const msg = { messageId, fromMe: !!fromMe, body: body || '', timestamp: ts, mediaType: mediaType || null, quotedMessageId: quotedMessageId || null, quotedBody: quotedBody || null, edited: false, hasMedia: !!hasMedia }
  if (_raw) msg._raw = _raw // store raw baileys message for reply context
  chat.messages.push(msg)
  if (chat.messages.length > MAX_MESSAGES_PER_CHAT) chat.messages = chat.messages.slice(-MAX_MESSAGES_PER_CHAT)
  
  chat.lastMessage = body || ''
  chat.lastMessageAt = ts
  if (!fromMe) chat.unreadCount = (chat.unreadCount || 0) + 1
  return chat
}

function getChats() {
  return Object.values(chatStore)
    .sort((a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime())
    .map(({ jid, phone, pushName, lastMessage, lastMessageAt, unreadCount, messages }) => ({
      jid, phone, pushName, lastMessage, lastMessageAt, unreadCount, messageCount: messages.length,
      profilePicUrl: profilePicCache[jid]?.url || null,
    }))
}

// Fetch profile pics for all chats in background (non-blocking)
async function fetchAllProfilePics() {
  const jids = Object.keys(chatStore)
  for (const jid of jids) {
    if (!profilePicCache[jid] || Date.now() - profilePicCache[jid].fetchedAt > PROFILE_PIC_TTL) {
      await getProfilePicUrl(jid).catch(() => {})
      // Small delay to avoid rate limiting
      await new Promise(r => setTimeout(r, 200))
    }
  }
}

function getChatMessages(jid) {
  return (chatStore[jid]?.messages || []).map(({ _raw, ...msg }) => ({
    ...msg,
    mediaAvailable: msg.hasMedia && !!mediaStore[msg.messageId],
  }))
}

function markChatRead(jid) {
  if (chatStore[jid]) chatStore[jid].unreadCount = 0
}

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

    // Listen for incoming messages - store locally + forward via webhook
    sock.ev.on('messages.upsert', (m) => {
      if (m.type === 'notify' || m.type === 'append') {
        for (const msg of m.messages) {
          const jid = msg.key.remoteJid
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
          const body = text || (mediaType ? `[${mediaType}]` : '')
          const timestamp = msg.messageTimestamp ? new Date(Number(msg.messageTimestamp) * 1000).toISOString() : new Date().toISOString()

          // Extract reply context
          const contextInfo = msg.message?.extendedTextMessage?.contextInfo || msg.message?.imageMessage?.contextInfo || msg.message?.videoMessage?.contextInfo || null
          const quotedMessageId = contextInfo?.stanzaId || null
          const quotedBody = contextInfo?.quotedMessage?.conversation || contextInfo?.quotedMessage?.extendedTextMessage?.text || null

          // Store in memory (keep _raw for reply chaining)
          const hasMedia = !!(msg.message?.audioMessage || msg.message?.imageMessage || msg.message?.videoMessage || msg.message?.documentMessage)
          upsertChat(jid, { pushName, body, fromMe, messageId: msg.key.id, timestamp, mediaType, quotedMessageId, quotedBody, _raw: msg, hasMedia })

          // Download and store media in background
          if (hasMedia) {
            downloadAndStoreMedia(msg).catch(() => {})
          }

          // Fetch profile pic if not cached (for new contacts)
          if (!profilePicCache[jid] && !fromMe) {
            getProfilePicUrl(jid).catch(() => {})
          }

          console.log(`[Bridge] ${fromMe ? 'Sent' : 'Received'} ${jid}: ${body || '[empty]'}`)

          sendWebhook('message', {
            messageId: msg.key.id, jid, fromMe, pushName,
            body, mediaType, phone: jid.split('@')[0], quotedMessageId, quotedBody,
          })
        }
      }
    })

    // Listen for message updates (edits, deletes, etc.)
    sock.ev.on('messages.update', (updates) => {
      for (const update of updates) {
        const jid = update.key?.remoteJid
        if (!jid || !chatStore[jid]) continue
        // Handle message edit
        if (update.update?.message) {
          const editedText = update.update.message?.conversation || update.update.message?.extendedTextMessage?.text
          if (editedText) {
            const msg = chatStore[jid].messages.find(m => m.messageId === update.key.id)
            if (msg) { msg.body = editedText; msg.edited = true }
          }
        }
      }
    })

    // Listen for history sync (existing chats when connecting)
    sock.ev.on('messaging-history.set', ({ chats: syncedChats, messages: syncedMessages }) => {
      console.log(`[Bridge] History sync: ${syncedChats?.length || 0} chats, ${syncedMessages?.length || 0} messages`)
      if (syncedMessages) {
        for (const msg of syncedMessages) {
          const jid = msg.key?.remoteJid
          if (!jid || jid === 'status@broadcast' || jid.endsWith('@g.us')) continue
          const text = msg.message?.conversation
            || msg.message?.extendedTextMessage?.text
            || msg.message?.imageMessage?.caption
            || msg.message?.videoMessage?.caption
            || ''
          const fromMe = msg.key?.fromMe || false
          const timestamp = msg.messageTimestamp ? new Date(Number(msg.messageTimestamp) * 1000).toISOString() : new Date().toISOString()
          const mediaType = msg.message?.imageMessage ? 'image' : msg.message?.videoMessage ? 'video' : msg.message?.audioMessage ? 'audio' : msg.message?.documentMessage ? 'document' : null
          const hasMedia = !!mediaType
          upsertChat(jid, { pushName: msg.pushName || null, body: text || (mediaType ? `[${mediaType}]` : ''), fromMe, messageId: msg.key?.id, timestamp, mediaType, hasMedia, _raw: msg })
          if (hasMedia) downloadAndStoreMedia(msg).catch(() => {})
        }
      }
      console.log(`[Bridge] Store now has ${Object.keys(chatStore).length} chats`)
      // Fetch profile pics in background after sync
      setTimeout(() => fetchAllProfilePics(), 2000)
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

  // POST /send - Send a text message (with optional reply)
  if (req.method === 'POST' && url.pathname === '/send') {
    try {
      const body = await parseBody(req)
      if (!body.jid || !body.text) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Missing jid or text' }))
        return
      }
      const result = await sendMessage(body.jid, body.text, body.quotedMessageId)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'sent', messageId: result.key.id }))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err.message }))
    }
    return
  }

  // POST /send-media - Send media (file, image, audio)
  // Expects JSON: { jid, type: 'image'|'video'|'audio'|'document', base64, mimetype, filename, caption, quotedMessageId }
  if (req.method === 'POST' && url.pathname === '/send-media') {
    try {
      const body = await parseBody(req)
      if (!body.jid || !body.type || !body.base64) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Missing jid, type, or base64' }))
        return
      }
      const buffer = Buffer.from(body.base64, 'base64')
      const result = await sendMedia(body.jid, {
        type: body.type,
        buffer,
        mimetype: body.mimetype,
        filename: body.filename,
        caption: body.caption,
        quotedMessageId: body.quotedMessageId,
      })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'sent', messageId: result.key.id }))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err.message }))
    }
    return
  }

  // POST /edit-message - Edit a sent message
  if (req.method === 'POST' && url.pathname === '/edit-message') {
    try {
      const body = await parseBody(req)
      if (!body.jid || !body.messageId || !body.text) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Missing jid, messageId, or text' }))
        return
      }
      await editMessage(body.jid, body.messageId, body.text)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'edited' }))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err.message }))
    }
    return
  }

  // GET /media?messageId=xxx - Serve stored media content
  if (req.method === 'GET' && url.pathname === '/media') {
    const messageId = url.searchParams.get('messageId')
    if (!messageId) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Missing messageId parameter' }))
      return
    }
    const media = mediaStore[messageId]
    if (!media) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Media not found' }))
      return
    }
    res.writeHead(200, {
      'Content-Type': media.mimetype,
      'Content-Length': media.buffer.length,
      'Cache-Control': 'public, max-age=86400',
    })
    res.end(media.buffer)
    return
  }

  // GET /profile-pic?jid=xxx&force=true - Get profile picture URL
  if (req.method === 'GET' && url.pathname === '/profile-pic') {
    const jid = url.searchParams.get('jid')
    const force = url.searchParams.get('force') === 'true'
    if (!jid) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Missing jid parameter' }))
      return
    }
    const picUrl = await getProfilePicUrl(jid, force)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ jid, profilePicUrl: picUrl }))
    return
  }

  // POST /fetch-all-pics - Force fetch all profile pictures
  if (req.method === 'POST' && url.pathname === '/fetch-all-pics') {
    fetchAllProfilePics().catch(() => {})
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'fetching', message: 'Fetching profile pics in background' }))
    return
  }

  // GET /chats - List all chats with last message (includes profile pics)
  if (req.method === 'GET' && url.pathname === '/chats') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ chats: getChats() }))
    return
  }

  // GET /messages?jid=xxx - Get messages for a specific chat
  if (req.method === 'GET' && url.pathname === '/messages') {
    const jid = url.searchParams.get('jid')
    if (!jid) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Missing jid parameter' }))
      return
    }
    // Mark as read when fetching messages
    markChatRead(jid)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ jid, messages: getChatMessages(jid) }))
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
