// ─────────────────────────────────────────────────────────────────
//  RaPaX™ — Pipeline Orchestrator
//  confirmed payment → LexForge™ legal bundle → AcerbE™ stamped package (+ release gate) → R2 → delivery token
//  Retries transient failures; anything else (or exhausted retries) parks the order as HELD for the operator.
//  A paid order is never delivered unstamped and never silently lost.
// ─────────────────────────────────────────────────────────────────
import { TransactionModel, TxStatus } from '../models/transactionModel.js';
import { ProductModel } from '../models/productModel.js';
import { AcerbEService, buyerRef } from './acerbeService.js';
import { LexForgeService, FulfilmentError } from './lexforgeService.js';
import { DeliveryService } from './deliveryService.js';
import { FingerprintModel } from '../models/fingerprintModel.js';
import { DeliveryModel } from '../models/deliveryModel.js';
import { config } from '../config/index.js';
import { auditLog, EventType } from '../utils/auditLogger.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function alertOperator(message, tx) {
  console.error(`[RaPaX™][ALERT] ${message} (tx ${tx.transaction_id})`);
  const url = config.pipeline.alertWebhookUrl;
  if (!url) return;
  try {
    await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: `RaPaX™ order HELD: ${message} — tx ${tx.transaction_id}` }), signal: AbortSignal.timeout(10000) });
  } catch (e) { console.error('[RaPaX™][ALERT] webhook failed:', e.message); }
}

async function fulfilOnce(tx, product) {
  let fingerprint = FingerprintModel.findByTransactionId(tx.transaction_id);
  if (!fingerprint) {
    const bundle = await LexForgeService.bundle({ transaction: tx, product, buyerRef: buyerRef(tx) });
    fingerprint = await AcerbEService.package({ transactionId: tx.transaction_id, product, transaction: tx, bundle });
  }
  const existing = DeliveryModel.findByTransactionId(tx.transaction_id);
  return { fingerprint, delivery: existing ?? await DeliveryService.issueDelivery({ transactionId: tx.transaction_id, product, fingerprint }) };
}

export const Pipeline = {

  async run(transactionId) {
    const tx = TransactionModel.findById(transactionId);
    if (!tx) throw new Error(`Transaction ${transactionId} not found`);
    if (tx.status !== TxStatus.CONFIRMED) {
      console.warn(`[RaPaX™][Pipeline] Skipping — status is '${tx.status}', expected 'confirmed'`);
      return;
    }
    const product = ProductModel.findById(tx.product_id);
    if (!product) throw new Error(`Product ${tx.product_id} not found`);

    // Claim synchronously (before any await) so the poller, the webhook and a manual call cannot run the same order twice.
    TransactionModel.updateStatus(transactionId, TxStatus.FINGERPRINTING);
    console.log(`[RaPaX™][Pipeline] Starting for tx: ${transactionId}`);

    const { maxAttempts, backoffMs } = config.pipeline;
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const out = await fulfilOnce(TransactionModel.findById(transactionId), product);
        auditLog({ eventType: EventType.SYSTEM, transactionId, productId: product.product_id,
          fingerprintId: out.fingerprint.fingerprint_id, deliveryId: out.delivery.delivery_id, actor: buyerRef(tx),
          payload: { action: 'PIPELINE_COMPLETE', attempt, download_link: out.delivery.download_link } });
        return out;
      } catch (err) {
        lastErr = err;
        const retryable = err instanceof FulfilmentError ? err.retryable : true;
        console.error(`[RaPaX™][Pipeline] attempt ${attempt}/${maxAttempts} failed (${retryable ? 'retryable' : 'permanent'}): ${err.message}`);
        auditLog({ eventType: EventType.SYSTEM, transactionId, productId: product.product_id, actor: 'system',
          payload: { action: 'PIPELINE_ATTEMPT_FAILED', attempt, retryable, code: err.code ?? null, error: err.message } });
        if (!retryable || attempt === maxAttempts) break;
        await sleep(backoffMs[Math.min(attempt - 1, backoffMs.length - 1)] ?? 0);
      }
    }

    const reason = `${lastErr.code ? `[${lastErr.code}] ` : ''}${lastErr.message}`.slice(0, 500);
    TransactionModel.updateStatus(transactionId, TxStatus.HELD, { hold_reason: reason });
    auditLog({ eventType: EventType.SYSTEM, transactionId, productId: product.product_id, actor: 'system',
      payload: { action: 'PIPELINE_HELD', error: reason } });
    await alertOperator(reason, tx);
    return { held: true, reason };
  },

  /** Operator action after fixing the cause (templates reviewed, AcerbE back up, ...). */
  async release(transactionId) {
    const tx = TransactionModel.findById(transactionId);
    if (!tx) throw Object.assign(new Error('Transaction not found'), { status: 404 });
    if (tx.status !== TxStatus.HELD) throw Object.assign(new Error(`Transaction is '${tx.status}', not 'held'`), { status: 409 });
    TransactionModel.updateStatus(transactionId, TxStatus.CONFIRMED, { hold_reason: null });
    auditLog({ eventType: EventType.SYSTEM, transactionId, productId: tx.product_id, actor: 'operator', payload: { action: 'HELD_ORDER_RELEASED' } });
    return Pipeline.run(transactionId);
  },
};
