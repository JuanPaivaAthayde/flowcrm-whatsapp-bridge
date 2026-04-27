import pkg from '@whiskeysockets/baileys';
const { 
  default: makeWASocket, 
  DisconnectReason, 
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} = pkg;
import express from 'express';
import QRCode from 'qrcode';
import pino from 'pino';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3001;

// Logger
const logger = pino({ level: 'silent' });

// State
let sock = null;
let qrCode = null;
let connectionStatus = 'disconnected';
let lastDisconnectReason = null;

// Store for chats and messages
const chats = new Map();
const messageStore = new Map();

// LID to Phone mapping - KEY FEATURE for resolving real phone numbers
const lidToPhoneMap = new Map();

// Helper to extract phone from JID
function jidToPhone(jid) {
  if (!jid) return null;
  return jid.split('@')[0];
}

// Helper to check if JID is a LID
function isLidJid(jid) {
  return jid && jid.includes('@lid');
}

// Get real phone number from JID (resolves LID if possible)
function getRealPhone(jid) {
  if (!jid) return null;
  
  // If it's a LID, try to get the real phone from our map
  if (isLidJid(jid)) {
    const realPhone = lidToPhoneMap.get(jid);
    if (realPhone) return realPhone;
    // Fallback to extracting from LID (not the real number but better than nothing)
    return jidToPhone(jid);
  }
  
  // Regular JID - extract phone directly
  return jidToPhone(jid);
}

// Store LID mapping when we discover it
function storeLidMapping(lidJid, realJid) {
  if (lidJid && realJid && isLidJid(lidJid) && !isLidJid(realJid)) {
    const realPhone = jidToPhone(realJid);
    if (realPhone) {
      lidToPhoneMap.set(lidJid, realPhone);
      console.log(`[LID Mapping] ${lidJid} -> ${realPhone}`);
    }
  }
}

async function connectToWhatsApp() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const { version } = await fetchLatestBaileysVersion();
    
    console.log(`Using Baileys version: ${version.join('.')}`);

    sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      printQRInTerminal: false,
      logger,
      generateHighQualityLinkPreview: true,
      syncFullHistory: false,
      markOnlineOnConnect: true,
    });

    // Connection events
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      
      if (qr) {
        qrCode = await QRCode.toDataURL(qr);
        connectionStatus = 'waiting_qr';
        console.log('QR Code generated');
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        lastDisconnectReason = statusCode;
        connectionStatus = 'disconnected';
        
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        console.log(`Connection closed. Status: ${statusCode}. Reconnecting: ${shouldReconnect}`);
        
        if (shouldReconnect) {
          setTimeout(connectToWhatsApp, 3000);
        }
      } else if (connection === 'open') {
        connectionStatus = 'connected';
        qrCode = null;
        console.log('Connected to WhatsApp');
        
        // Try to sync contacts to build LID mappings
        try {
          const contacts = await sock.store?.contacts || {};
          for (const [jid, contact] of Object.entries(contacts)) {
            if (contact.lid) {
              storeLidMapping(contact.lid, jid);
            }
          }
        } catch (e) {
          console.log('Could not sync contacts:', e.message);
        }
      }
    });

    // Save credentials when updated
    sock.ev.on('creds.update', saveCreds);

    // Handle incoming messages
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        if (!msg.message) continue;
        
        const jid = msg.key.remoteJid;
        if (!jid || jid === 'status@broadcast') continue;

        // KEY: Check for remoteJidAlt to get real phone number from LID
        if (msg.key.remoteJidAlt && isLidJid(jid)) {
          storeLidMapping(jid, msg.key.remoteJidAlt);
        }
        
        // Also check participant and participantAlt for group messages
        if (msg.key.participant && msg.key.participantAlt) {
          storeLidMapping(msg.key.participant, msg.key.participantAlt);
        }

        // Extract message content
        const messageContent = msg.message;
        let body = '';
        let messageType = 'unknown';

        if (messageContent.conversation) {
          body = messageContent.conversation;
          messageType = 'text';
        } else if (messageContent.extendedTextMessage?.text) {
          body = messageContent.extendedTextMessage.text;
          messageType = 'text';
        } else if (messageContent.imageMessage) {
          body = messageContent.imageMessage.caption || '[Imagem]';
          messageType = 'image';
        } else if (messageContent.videoMessage) {
          body = messageContent.videoMessage.caption || '[Video]';
          messageType = 'video';
        } else if (messageContent.audioMessage) {
          body = '[Audio]';
          messageType = 'audio';
        } else if (messageContent.documentMessage) {
          body = messageContent.documentMessage.fileName || '[Documento]';
          messageType = 'document';
        } else if (messageContent.stickerMessage) {
          body = '[Sticker]';
          messageType = 'sticker';
        } else if (messageContent.contactMessage) {
          body = '[Contato]';
          messageType = 'contact';
        } else if (messageContent.locationMessage) {
          body = '[Localizacao]';
          messageType = 'location';
        }

        // Get real phone number (resolves LID if possible)
        const realPhone = getRealPhone(jid);
        const phone = jidToPhone(jid);
        
        // Get contact name
        let pushName = msg.pushName || '';
        try {
          const contact = await sock.store?.contacts?.[jid];
          if (contact?.name) pushName = contact.name;
          if (contact?.notify) pushName = contact.notify;
        } catch (e) {}

        // Store message
        if (!messageStore.has(jid)) {
          messageStore.set(jid, []);
        }
        messageStore.get(jid).push({
          id: msg.key.id,
          body,
          type: messageType,
          fromMe: msg.key.fromMe || false,
          timestamp: msg.messageTimestamp,
          pushName,
        });

        // Update chat
        const existingChat = chats.get(jid) || {
          jid,
          phone,
          realPhone: realPhone !== phone ? realPhone : undefined,
          pushName,
          unreadCount: 0,
          messageCount: 0,
          profilePicUrl: null,
        };

        existingChat.lastMessage = body;
        existingChat.lastMessageAt = new Date(msg.messageTimestamp * 1000).toISOString();
        existingChat.messageCount = (messageStore.get(jid) || []).length;
        existingChat.pushName = pushName || existingChat.pushName;
        
        // Update realPhone if we now have it
        if (realPhone && realPhone !== phone) {
          existingChat.realPhone = realPhone;
        }
        
        if (!msg.key.fromMe) {
          existingChat.unreadCount = (existingChat.unreadCount || 0) + 1;
        }

        // Try to get profile picture
        if (!existingChat.profilePicUrl) {
          try {
            existingChat.profilePicUrl = await sock.profilePictureUrl(jid, 'image');
          } catch (e) {
            existingChat.profilePicUrl = null;
          }
        }

        chats.set(jid, existingChat);
        console.log(`Message from ${pushName || phone}: ${body.substring(0, 50)}...`);
      }
    });

  } catch (error) {
    console.error('Error connecting:', error);
    connectionStatus = 'error';
    setTimeout(connectToWhatsApp, 5000);
  }
}

// API Routes

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Get connection status and QR code
app.get('/status', (req, res) => {
  res.json({
    status: connectionStatus,
    qrCode: connectionStatus === 'waiting_qr' ? qrCode : null,
    lastDisconnectReason,
  });
});

// Get all chats with realPhone resolved
app.get('/chats', (req, res) => {
  const chatList = Array.from(chats.values())
    .sort((a, b) => new Date(b.lastMessageAt || 0) - new Date(a.lastMessageAt || 0));
  
  res.json({
    success: true,
    chats: chatList,
    count: chatList.length,
  });
});

// Get messages for a specific chat
app.get('/messages/:jid', (req, res) => {
  const { jid } = req.params;
  const decodedJid = decodeURIComponent(jid);
  
  const messages = messageStore.get(decodedJid) || [];
  const chat = chats.get(decodedJid);
  
  // Mark as read
  if (chat) {
    chat.unreadCount = 0;
    chats.set(decodedJid, chat);
  }
  
  res.json({
    success: true,
    messages: messages.sort((a, b) => a.timestamp - b.timestamp),
    chat,
  });
});

// Send message
app.post('/send', async (req, res) => {
  const { jid, message, mediaUrl, mediaType } = req.body;
  
  if (!sock || connectionStatus !== 'connected') {
    return res.status(503).json({ success: false, error: 'WhatsApp not connected' });
  }
  
  if (!jid || (!message && !mediaUrl)) {
    return res.status(400).json({ success: false, error: 'Missing jid or message/mediaUrl' });
  }

  try {
    let sentMsg;
    
    if (mediaUrl) {
      // Send media message
      const mediaContent = {
        [mediaType || 'image']: { url: mediaUrl },
        caption: message || '',
      };
      sentMsg = await sock.sendMessage(jid, mediaContent);
    } else {
      // Send text message
      sentMsg = await sock.sendMessage(jid, { text: message });
    }

    // Store sent message
    if (!messageStore.has(jid)) {
      messageStore.set(jid, []);
    }
    messageStore.get(jid).push({
      id: sentMsg.key.id,
      body: message,
      type: 'text',
      fromMe: true,
      timestamp: Math.floor(Date.now() / 1000),
    });

    // Update chat
    const chat = chats.get(jid);
    if (chat) {
      chat.lastMessage = message;
      chat.lastMessageAt = new Date().toISOString();
      chat.messageCount = messageStore.get(jid).length;
      chats.set(jid, chat);
    }

    res.json({ success: true, messageId: sentMsg.key.id });
  } catch (error) {
    console.error('Error sending message:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Disconnect WhatsApp
app.post('/disconnect', async (req, res) => {
  try {
    if (sock) {
      await sock.logout();
      sock = null;
    }
    connectionStatus = 'disconnected';
    qrCode = null;
    chats.clear();
    messageStore.clear();
    lidToPhoneMap.clear();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Reconnect WhatsApp
app.post('/reconnect', async (req, res) => {
  try {
    if (sock) {
      sock.end();
      sock = null;
    }
    connectionStatus = 'reconnecting';
    await connectToWhatsApp();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Resolve LID to real phone (manual endpoint)
app.get('/resolve-lid/:lid', (req, res) => {
  const { lid } = req.params;
  const realPhone = lidToPhoneMap.get(decodeURIComponent(lid));
  res.json({
    success: true,
    lid,
    realPhone: realPhone || null,
    resolved: !!realPhone,
  });
});

// Get all LID mappings (for debugging)
app.get('/lid-mappings', (req, res) => {
  const mappings = Object.fromEntries(lidToPhoneMap);
  res.json({
    success: true,
    mappings,
    count: lidToPhoneMap.size,
  });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`WhatsApp Bridge running on port ${PORT}`);
  connectToWhatsApp();
});
