// ─────────────────────────────────────────────────────────────────
//  RaPaX™ — Stripe Checkout (USD card payments)
//  No SDK: Stripe REST API + manual webhook signature verification.
//  Flow: initiate → hosted Checkout Session → buyer pays on Stripe →
//        signed webhook → verify amount → CONFIRMED → Pipeline.run
//  Card data never touches this server.
// ─────────────────────────────────────────────────────────────────
import crypto from 'crypto';
import { config } from '../config/index.js';
import { getDb } from '../utils/initDb.js';
import { TransactionModel, TxStatus } from '../models/transactionModel.js';
import { auditLog, EventType } from '../utils/auditLogger.js';

const STRIPE_API = 'https://api.stripe.com/v1';
const FIAT = ['USD', 'CAD'];
const SIG_TOLERANCE_SEC = 300;
const SESSION_TTL_SEC   = 30 * 60;           // Stripe minimum is 30 min

// Test seam — never set in production code
let _fetch = (...a) => fetch(...a);
export function _setFetchForTests(fn) { _fetch = fn; }

export function fiatReady() {
  const f = config.fiat;
  return Boolean(f.enabled && f.stripeSecretKey && f.stripeWebhookSecret && f.publicBaseUrl);
}

const toCents = usd => Math.round(Number(usd) * 100);

function form(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v === undefined || v === null) continue;
    if (typeof v === 'object') form(v, key, out);
    else out.push([key, String(v)]);
  }
  return out;
}

export async function createCheckoutSession({ transaction, product, amount }) {
  if (!fiatReady()) throw new Error('Card payments are not enabled');
  const cents = toCents(amount);
  if (!Number.isInteger(cents) || cents < 50) throw new Error('Invalid card amount (minimum 0.50)');
  const base = config.fiat.publicBaseUrl.replace(/\/+$/, '');
  const id   = transaction.transaction_id;

  const body = new URLSearchParams(form({
    mode: 'payment',
    client_reference_id: id,
    metadata: { transaction_id: id, product_id: product.product_id },
    payment_intent_data: { metadata: { transaction_id: id, product_id: product.product_id } },
    line_items: { 0: { quantity: 1, price_data: {
      currency: transaction.currency.toLowerCase(), unit_amount: cents,
      product_data: { name: String(product.name).slice(0, 250) },
    } } },
    success_url: `${base}/?order=${id}`,
    cancel_url:  `${base}/?cancelled=${id}`,
    expires_at:  Math.floor(Date.now() / 1000) + SESSION_TTL_SEC + 60,
  }));

  const res = await _fetch(`${STRIPE_API}/checkout/sessions`, {
    method: 'POST',
    headers: {
      Authorization:     `Bearer ${config.fiat.stripeSecretKey}`,
      'Content-Type':    'application/x-www-form-urlencoded',
      'Idempotency-Key': `rapax-checkout-${id}`,
    },
    body,
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.id || !data.url) {
    throw new Error(`Stripe error: ${data?.error?.message || res.status}`);
  }
  getDb().prepare(`UPDATE transactions SET provider_ref=? WHERE transaction_id=?`).run([data.id, id]);
  return { session_id: data.id, url: data.url, expires_at: new Date((data.expires_at || 0) * 1000).toISOString() };
}

// ── Webhook signature (Stripe v1 scheme) ─────────────────────────
export function verifyStripeSignature(rawBody, header, secret = config.fiat.stripeWebhookSecret, nowSec = Math.floor(Date.now() / 1000)) {
  if (!header || !secret || !Buffer.isBuffer(rawBody)) throw new Error('Missing signature');
  const parts = Object.fromEntries(header.split(',').map(p => p.trim().split('=')).filter(p => p.length === 2).map(([k, v]) => [k, v]));
  const t = Number(parts.t);
  const sigs = header.split(',').map(p => p.trim()).filter(p => p.startsWith('v1=')).map(p => p.slice(3));
  if (!Number.isFinite(t) || !sigs.length) throw new Error('Malformed signature header');
  if (Math.abs(nowSec - t) > SIG_TOLERANCE_SEC) throw new Error('Signature timestamp outside tolerance');
  const expected = crypto.createHmac('sha256', secret).update(`${t}.`).update(rawBody).digest();
  const ok = sigs.some(s => {
    const b = Buffer.from(s, 'hex');
    return b.length === expected.length && crypto.timingSafeEqual(b, expected);
  });
  if (!ok) throw new Error('Signature mismatch');
  return JSON.parse(rawBody.toString('utf8'));
}

// ── Event handling ───────────────────────────────────────────────
const inFlight = new Set();

export async function handleStripeEvent(event, { runPipeline } = {}) {
  const type = event?.type;
  if (type !== 'checkout.session.completed' && type !== 'checkout.session.async_payment_succeeded') {
    return 'ignored';
  }
  const s = event.data?.object || {};
  if (s.payment_status !== 'paid') return 'not_paid';

  const txid = s.client_reference_id || s.metadata?.transaction_id;
  const tx   = txid ? TransactionModel.findById(txid) : null;
  if (!tx || !FIAT.includes(tx.currency)) return 'unknown_tx';

  const row = getDb().prepare(`SELECT provider_ref FROM transactions WHERE transaction_id=?`).get([txid]);
  const expectedCents = toCents(tx.amount_expected);
  if (row?.provider_ref !== s.id || s.currency !== tx.currency.toLowerCase() || s.amount_total !== expectedCents) {
    auditLog({ eventType: EventType.PAYMENT, transactionId: txid, productId: tx.product_id, actor: 'stripe',
      payload: { action: 'STRIPE_MISMATCH', session: s.id, currency: s.currency, amount_total: s.amount_total, expectedCents } });
    return 'mismatch';
  }

  if (['pending', 'confirming'].includes(tx.status)) {
    TransactionModel.updateStatus(txid, TxStatus.CONFIRMED, {
      amount_received: s.amount_total / 100,
      tx_hash: typeof s.payment_intent === 'string' ? s.payment_intent : s.id,
      confirmations: 99,
    });
    auditLog({ eventType: EventType.PAYMENT, transactionId: txid, productId: tx.product_id, actor: 'stripe',
      payload: { action: 'STRIPE_PAID', session: s.id, amount_total: s.amount_total } });
  } else if (tx.status !== TxStatus.CONFIRMED) {
    return 'duplicate';                       // already delivering/complete/failed/expired
  }

  await startPipeline(txid, runPipeline);
  return 'confirmed';
}

// Fire-and-forget so the webhook answers fast. On failure the paid order is put
// back to CONFIRMED so the retry sweep re-runs it (a paid buyer must never be stranded).
export async function startPipeline(txid, runPipeline) {
  if (inFlight.has(txid)) return;
  inFlight.add(txid);
  const run = runPipeline || (async id => (await import('./pipeline.js')).Pipeline.run(id));
  run(txid)
    .catch(err => {
      console.error('[RaPaX™][Stripe] pipeline failed for paid order', txid, err.message);
      const cur = TransactionModel.findById(txid);
      if (cur && cur.status === TxStatus.FAILED) TransactionModel.updateStatus(txid, TxStatus.CONFIRMED);
    })
    .finally(() => inFlight.delete(txid));
}
