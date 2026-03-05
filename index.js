#!/usr/bin/env node
/**
 * FlowCRM WhatsApp Bridge Server
 * 
 * Servidor standalone que conecta ao WhatsApp Web via Baileys
 * e expoe uma API HTTP para o CRM consumir.
 */

const http = require('http')
const fs = require('fs')
const path = require('path')

const PORT = process.env.PORT || 3001
const WEBHOOK_URL = process.env.WEBHOOK_URL || null
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '.data')
const AUTH_DIR = path.join(DATA_DIR, 'auth')
const STATUS_FILE = path.join(DATA_DIR, 'status.json')

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

async function sendMessage(jid, text) {
  if (!sock || connectionStatus !== 'connected') throw new Error('WhatsApp not connected')
  const formattedJid = jid.includes('@') ? jid : `${jid}@s.whatsapp.net`
  return await sock.sendMessage(formattedJid, { text })
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', chunk => body += chunk)
    req.on('end', () => { try { resolve(JSON.parse(body)) } catch { resolve({})
