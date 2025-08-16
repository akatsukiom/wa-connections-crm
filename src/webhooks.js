import axios from 'axios';

const WEBHOOK_URL = process.env.WEBHOOK_URL || '';

export async function fireWebhook(event, payload) {
  if (!WEBHOOK_URL) return;
  try {
    await axios.post(WEBHOOK_URL, { event, payload }, { timeout: 5000 });
  } catch (e) {
    console.error('Webhook error', e.message);
  }
}
