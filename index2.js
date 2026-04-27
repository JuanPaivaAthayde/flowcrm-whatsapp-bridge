/**
 * ATUALIZAÇÃO DO BRIDGE - CORREÇÃO LID -> NÚMERO REAL
 * 
 * Este arquivo contém o código atualizado para o bridge do WhatsApp
 * que resolve automaticamente LIDs para números de telefone reais.
 * 
 * INSTRUÇÕES:
 * 1. Acesse o Railway -> flowcrm-whatsapp-bridge
 * 2. Substitua o conteúdo do arquivo index.ts pelo código abaixo
 * 3. Faça deploy
 */

import express from "express"
import { 
  makeWASocket, 
  DisconnectReason, 
  useMultiFileAuthState,
  WASocket,
  BaileysEventMap,
  proto,
  jidNormalizedUser
} from "@whiskeysockets/baileys"
import { Boom } from "@hapi/boom"
import QRCode from "qrcode"
import pino from "pino"

const app = express()
app.use(express.json())

let sock: WASocket | null = null
let qrCode: string | null = null
let connectionStatus: "disconnected" | "connecting" | "connected" = "disconnected"

// NOVO: Mapeamento LID -> Número Real
const lidToPhoneMap = new Map<string, string>()

// Mensagens armazenadas em memória
const chatsMap = new Map<string, {
  jid: string
  phone: string
  realPhone: string  // NOVO: Número real
  pushName: string
  lastMessage: string
  lastMessageAt: Date
  unreadCount: number
  messages: Array<{
    id: string
    body: string
    fromMe: boolean
    timestamp: Date
    pushName?: string
    quotedMessage?: { body: string; fromMe: boolean } | null
  }>
  profilePicUrl?: string | null
}>()

// NOVO: Função para extrair número real do JID ou LID
function extractRealPhone(jid: string, message?: proto.IWebMessageInfo): string {
  // Remove sufixo @s.whatsapp.net ou @lid
  const baseId = jid.split("@")[0]
  
  // Se é um LID, tenta resolver para número real
  if (jid.includes("@lid")) {
    // Verifica se já temos no mapa
    if (lidToPhoneMap.has(jid)) {
      return lidToPhoneMap.get(jid)!
    }
    
    // Tenta extrair do remoteJidAlt da mensagem (Baileys v7+)
    if (message?.key?.remoteJidAlt) {
      const realJid = message.key.remoteJidAlt
      const realPhone = realJid.split("@")[0]
      lidToPhoneMap.set(jid, realPhone)
      console.log(`[LID Resolver] Mapped ${jid} -> ${realPhone}`)
      return realPhone
    }
    
    // Tenta extrair do participantAlt
    if (message?.key?.participantAlt) {
      const realPhone = message.key.participantAlt.split("@")[0]
      lidToPhoneMap.set(jid, realPhone)
      console.log(`[LID Resolver] Mapped ${jid} -> ${realPhone} (via participantAlt)`)
      return realPhone
    }
    
    // Se não conseguiu resolver, retorna o LID mesmo
    return baseId
  }
  
  return baseId
}

// NOVO: Função para atualizar mapeamento LID a partir de uma mensagem
function updateLidMapping(message: proto.IWebMessageInfo) {
  const jid = message.key?.remoteJid
  if (!jid || !jid.includes("@lid")) return
  
  // remoteJidAlt contém o JID real (número@s.whatsapp.net)
  if (message.key?.remoteJidAlt) {
    const realPhone = message.key.remoteJidAlt.split("@")[0]
    if (!lidToPhoneMap.has(jid)) {
      lidToPhoneMap.set(jid, realPhone)
      console.log(`[LID Resolver] New mapping: ${jid} -> ${realPhone}`)
      
      // Atualiza o chat existente se houver
      const chat = chatsMap.get(jid)
      if (chat) {
        chat.realPhone = realPhone
        chat.phone = realPhone
      }
    }
  }
}

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info")
  
  connectionStatus = "connecting"
  
  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: "silent" }),
    browser: ["FlowCRM", "Chrome", "1.0.0"],
    // NOVO: Habilitar sincronização de contatos para resolver LIDs
    syncFullHistory: false,
  })
  
  sock.ev.on("creds.update", saveCreds)
  
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update
    
    if (qr) {
      qrCode = await QRCode.toDataURL(qr)
      connectionStatus = "connecting"
    }
    
    if (connection === "close") {
      connectionStatus = "disconnected"
      qrCode = null
      const reason = (lastDisconnect?.error as Boom)?.output?.statusCode
      
      if (reason !== DisconnectReason.loggedOut) {
        setTimeout(connectToWhatsApp, 3000)
      }
    } else if (connection === "open") {
      connectionStatus = "connected"
      qrCode = null
      console.log("[WhatsApp] Connected successfully")
      
      // NOVO: Sincroniza contatos para resolver LIDs existentes
      await syncContactsForLidResolution()
    }
  })
  
  // NOVO: Listener para contacts.update - ajuda a resolver LIDs
  sock.ev.on("contacts.update", (contacts) => {
    for (const contact of contacts) {
      if (contact.id && contact.id.includes("@lid")) {
        // Verifica se temos o número real em algum campo
        const notify = (contact as any).notify
        const verifiedName = (contact as any).verifiedName
        const name = contact.name
        
        console.log(`[Contact Update] ${contact.id}:`, { notify, verifiedName, name })
      }
    }
  })
  
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    for (const message of messages) {
      // NOVO: Atualiza mapeamento LID
      updateLidMapping(message)
      
      const jid = message.key.remoteJid
      if (!jid || jid === "status@broadcast") continue
      
      // Extrai número real usando a nova função
      const realPhone = extractRealPhone(jid, message)
      const basePhone = jid.split("@")[0]
      
      const isFromMe = message.key.fromMe || false
      const pushName = message.pushName || "Desconhecido"
      
      // Extrai o corpo da mensagem
      let body = ""
      const msgContent = message.message
      if (msgContent) {
        body = msgContent.conversation ||
               msgContent.extendedTextMessage?.text ||
               msgContent.imageMessage?.caption ||
               msgContent.videoMessage?.caption ||
               msgContent.documentMessage?.caption ||
               (msgContent.audioMessage ? "[Áudio]" : "") ||
               (msgContent.stickerMessage ? "[Sticker]" : "") ||
               (msgContent.contactMessage ? "[Contato]" : "") ||
               (msgContent.locationMessage ? "[Localização]" : "") ||
               ""
      }
      
      // Quoted message
      let quotedMessage = null
      const contextInfo = msgContent?.extendedTextMessage?.contextInfo
      if (contextInfo?.quotedMessage) {
        const quoted = contextInfo.quotedMessage
        quotedMessage = {
          body: quoted.conversation || 
                quoted.extendedTextMessage?.text || 
                "[Mídia]",
          fromMe: contextInfo.participant === sock?.user?.id
        }
      }
      
      // Busca ou cria o chat
      let chat = chatsMap.get(jid)
      if (!chat) {
        // Tenta buscar foto do perfil
        let profilePicUrl: string | null = null
        try {
          profilePicUrl = await sock?.profilePictureUrl(jid, "preview") || null
        } catch { }
        
        chat = {
          jid,
          phone: realPhone,      // ATUALIZADO: Usa número real
          realPhone: realPhone,  // NOVO: Armazena número real
          pushName,
          lastMessage: body,
          lastMessageAt: new Date(Number(message.messageTimestamp) * 1000),
          unreadCount: isFromMe ? 0 : 1,
          messages: [],
          profilePicUrl
        }
        chatsMap.set(jid, chat)
      } else {
        // Atualiza chat existente
        chat.lastMessage = body || chat.lastMessage
        chat.lastMessageAt = new Date(Number(message.messageTimestamp) * 1000)
        if (!isFromMe) chat.unreadCount++
        if (pushName && pushName !== "Desconhecido") chat.pushName = pushName
        // NOVO: Atualiza número real se disponível
        if (realPhone && realPhone !== basePhone) {
          chat.realPhone = realPhone
          chat.phone = realPhone
        }
      }
      
      // Adiciona mensagem ao histórico
      chat.messages.push({
        id: message.key.id || Date.now().toString(),
        body,
        fromMe: isFromMe,
        timestamp: new Date(Number(message.messageTimestamp) * 1000),
        pushName: isFromMe ? undefined : pushName,
        quotedMessage
      })
      
      // Limita a 100 mensagens por chat
      if (chat.messages.length > 100) {
        chat.messages = chat.messages.slice(-100)
      }
    }
  })
}

// NOVO: Função para sincronizar contatos e resolver LIDs
async function syncContactsForLidResolution() {
  if (!sock) return
  
  try {
    // Busca a store de contatos do Baileys
    const store = (sock as any).store
    if (store?.contacts) {
      for (const [jid, contact] of Object.entries(store.contacts)) {
        if (jid.includes("@lid") && (contact as any).lid) {
          const realJid = (contact as any).lid
          const realPhone = realJid.split("@")[0]
          lidToPhoneMap.set(jid, realPhone)
          console.log(`[Store Sync] Mapped ${jid} -> ${realPhone}`)
        }
      }
    }
  } catch (error) {
    console.error("[Store Sync] Error:", error)
  }
}

// API Endpoints

app.get("/status", (req, res) => {
  res.json({
    status: connectionStatus,
    hasQR: !!qrCode,
    chatsCount: chatsMap.size,
    lidMappings: lidToPhoneMap.size  // NOVO: Mostra quantos LIDs foram resolvidos
  })
})

app.get("/qr", (req, res) => {
  if (qrCode) {
    res.json({ qr: qrCode })
  } else if (connectionStatus === "connected") {
    res.json({ connected: true })
  } else {
    res.status(404).json({ error: "QR code not available" })
  }
})

app.get("/chats", (req, res) => {
  const chats = Array.from(chatsMap.values())
    .map(chat => ({
      jid: chat.jid,
      phone: chat.realPhone || chat.phone,  // ATUALIZADO: Prioriza número real
      realPhone: chat.realPhone,             // NOVO: Inclui número real
      pushName: chat.pushName,
      lastMessage: chat.lastMessage,
      lastMessageAt: chat.lastMessageAt.toISOString(),
      unreadCount: chat.unreadCount,
      messageCount: chat.messages.length,
      profilePicUrl: chat.profilePicUrl
    }))
    .sort((a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime())
  
  res.json(chats)
})

app.get("/messages/:jid", (req, res) => {
  const { jid } = req.params
  const chat = chatsMap.get(jid)
  
  if (!chat) {
    return res.status(404).json({ error: "Chat not found" })
  }
  
  // Marca como lido
  chat.unreadCount = 0
  
  res.json({
    ...chat,
    phone: chat.realPhone || chat.phone,  // ATUALIZADO
    messages: chat.messages.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
  })
})

app.post("/send", async (req, res) => {
  const { jid, message, quotedId } = req.body
  
  if (!sock || connectionStatus !== "connected") {
    return res.status(503).json({ error: "WhatsApp not connected" })
  }
  
  try {
    let options: any = {}
    
    if (quotedId) {
      const chat = chatsMap.get(jid)
      const quotedMsg = chat?.messages.find(m => m.id === quotedId)
      if (quotedMsg) {
        options.quoted = {
          key: { remoteJid: jid, id: quotedId },
          message: { conversation: quotedMsg.body }
        }
      }
    }
    
    const result = await sock.sendMessage(jid, { text: message }, options)
    
    // Adiciona a mensagem enviada ao chat
    const chat = chatsMap.get(jid)
    if (chat && result) {
      chat.messages.push({
        id: result.key.id || Date.now().toString(),
        body: message,
        fromMe: true,
        timestamp: new Date(),
        quotedMessage: options.quoted ? { body: options.quoted.message.conversation, fromMe: false } : null
      })
      chat.lastMessage = message
      chat.lastMessageAt = new Date()
    }
    
    res.json({ success: true, messageId: result?.key?.id })
  } catch (error) {
    console.error("Error sending message:", error)
    res.status(500).json({ error: "Failed to send message" })
  }
})

app.post("/send-media", async (req, res) => {
  const { jid, mediaUrl, caption, mediaType } = req.body
  
  if (!sock || connectionStatus !== "connected") {
    return res.status(503).json({ error: "WhatsApp not connected" })
  }
  
  try {
    const response = await fetch(mediaUrl)
    const buffer = Buffer.from(await response.arrayBuffer())
    
    let messageContent: any
    
    if (mediaType === "image") {
      messageContent = { image: buffer, caption }
    } else if (mediaType === "video") {
      messageContent = { video: buffer, caption }
    } else if (mediaType === "audio") {
      messageContent = { audio: buffer, mimetype: "audio/mpeg" }
    } else {
      messageContent = { 
        document: buffer, 
        mimetype: "application/octet-stream",
        fileName: "file"
      }
    }
    
    const result = await sock.sendMessage(jid, messageContent)
    
    res.json({ success: true, messageId: result?.key?.id })
  } catch (error) {
    console.error("Error sending media:", error)
    res.status(500).json({ error: "Failed to send media" })
  }
})

// NOVO: Endpoint para obter mapeamentos LID
app.get("/lid-mappings", (req, res) => {
  const mappings: Record<string, string> = {}
  lidToPhoneMap.forEach((phone, lid) => {
    mappings[lid] = phone
  })
  res.json(mappings)
})

// NOVO: Endpoint para resolver LID manualmente
app.post("/resolve-lid", async (req, res) => {
  const { lid, realPhone } = req.body
  
  if (!lid || !realPhone) {
    return res.status(400).json({ error: "lid and realPhone are required" })
  }
  
  lidToPhoneMap.set(lid, realPhone)
  
  // Atualiza o chat se existir
  const chat = chatsMap.get(lid)
  if (chat) {
    chat.realPhone = realPhone
    chat.phone = realPhone
  }
  
  res.json({ success: true, message: `Mapped ${lid} -> ${realPhone}` })
})

app.post("/logout", async (req, res) => {
  if (sock) {
    await sock.logout()
    chatsMap.clear()
    lidToPhoneMap.clear()  // NOVO: Limpa mapeamentos
    qrCode = null
    connectionStatus = "disconnected"
  }
  res.json({ success: true })
})

const PORT = process.env.PORT || 3001
app.listen(PORT, () => {
  console.log(`Bridge running on port ${PORT}`)
  connectToWhatsApp()
})
