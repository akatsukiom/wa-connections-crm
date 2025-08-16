// src/webhooks.js
import axios from 'axios';

const WEBHOOK_URL   = process.env.WEBHOOK_URL || '';   // ej: https://tu-dominio.com/api/wa-webhook.php
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN || ''; // shared secret para validar en PHP

export async function fireWebhook(event, payload) {
  if (!WEBHOOK_URL) return; // si no hay URL, no dispares nada
  try {
    await axios.post(
      WEBHOOK_URL,
      { event, payload, ts: Date.now() },
      { headers: { 'X-Webhook-Token': WEBHOOK_TOKEN, 'Content-Type': 'application/json' }, timeout: 7000 }
    );
  } catch (e) {
    console.error('[webhook] error:', e.message);
  }
}
