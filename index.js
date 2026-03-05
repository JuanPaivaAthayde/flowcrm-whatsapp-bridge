#!/usr/bin/env node
const http = require('http')
const fs = require('fs')
const path = require('path')

const PORT = process.env.PORT || 3001
const WEBHOOK_URL = process.env.WEBHOOK_URL || null
const AUTH_DIR = path.join(__dirname, '.auth-data')
const STATUS_FILE = path.join(__dirname, '.status.json')

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
  const formattedJ
