// ─────────────────────────────────────────────────────────────────
//  RaPaX™ — Payment Poller (Cron Job)
//  Polls pending/confirming transactions every 60 seconds.
//  When confirmed → runs Pipeline.
// ─────────────────────────────────────────────────────────────────
import cron from 'node-cron';
import { TransactionModel, TxStatus } from '../models/transactionModel.js';
import { PaymentService } from './paymentService.js';
import { Pipeline } from './pipeline.js';
import { getDb } from '../utils/initDb.js';
import { startPipeline } from './stripeService.js';

// Paid orders stuck in 'confirmed' (pipeline crashed / server restarted) are retried.
const retries = new Map();
const MAX_RETRIES = 5;
function sweepStuckConfirmed() {
  // A run that died mid-way (crash/redeploy) leaves the order in 'fingerprinting'. A live run is bounded well under 30 min.
  const stale = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  getDb().prepare(`UPDATE transactions SET status='confirmed', updated_at=? WHERE status='fingerprinting' AND updated_at < ?`)
    .run([new Date().toISOString(), stale]);
  const cutoff = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  const rows = getDb().prepare(
    `SELECT transaction_id FROM transactions WHERE status='confirmed' AND updated_at < ?`
  ).all([cutoff]);
  for (const { transaction_id: id } of rows) {
    const n = (retries.get(id) || 0) + 1;
    if (n > MAX_RETRIES) continue;            // leave for the operator
    retries.set(id, n);
    console.log(`[RaPaX™][Poller] Retrying stuck confirmed order ${id} (attempt ${n})`);
    startPipeline(id, id2 => Pipeline.run(id2));
  }
}

let running = false;

export function startPaymentPoller() {
  // Run every 60 seconds
  cron.schedule('*/60 * * * * *', async () => {
    if (running) return; // prevent overlap
    running = true;

    try {
      sweepStuckConfirmed();
      const pending = TransactionModel.listPending();
      if (pending.length === 0) { running = false; return; }

      console.log(`[RaPaX™][Poller] Checking ${pending.length} pending transaction(s)…`);

      for (const tx of pending) {
        try {
          const newStatus = await PaymentService.pollTransaction(tx.transaction_id);

          if (newStatus === TxStatus.CONFIRMED) {
            console.log(`[RaPaX™][Poller] Confirmed: ${tx.transaction_id} — starting pipeline…`);
            await Pipeline.run(tx.transaction_id);
          }
        } catch (err) {
          console.error(`[RaPaX™][Poller] Error on tx ${tx.transaction_id}:`, err.message);
        }
      }
    } finally {
      running = false;
    }
  });

  console.log('[RaPaX™] Payment poller started (every 60s)');
}
