// ─────────────────────────────────────────────────────────────────
//  RaPaX™ — Internal API Routes
//  GET  /held              — paid orders parked for operator action
//  POST /pipeline/release  — re-run a held order
//  POST /payment/confirm   — manually confirm a payment (webhook)
//  POST /delivery/issue    — manually issue a delivery
//  All protected by operator auth.
// ─────────────────────────────────────────────────────────────────
import { Router } from 'express';
import { operatorAuth } from '../middleware/auth.js';
import { TransactionModel, TxStatus } from '../models/transactionModel.js';
import { ProductModel } from '../models/productModel.js';
import { PaymentService } from '../services/paymentService.js';
import { Pipeline } from '../services/pipeline.js';
import { DeliveryService } from '../services/deliveryService.js';
import { FingerprintModel } from '../models/fingerprintModel.js';

const router = Router();

// All internal routes require operator auth
router.use(operatorAuth);

// ── GET /internal/held ───────────────────────────────────────────
router.get('/held', (_req, res) => res.json({ success: true, held: TransactionModel.listByStatus(TxStatus.HELD) }));

// ── POST /internal/pipeline/release ──────────────────────────────
// Re-run a HELD order after the cause was fixed.
router.post('/pipeline/release', async (req, res) => {
  const { transaction_id } = req.body;
  if (!transaction_id) return res.status(400).json({ error: 'transaction_id required' });
  try {
    const out = await Pipeline.release(transaction_id);
    res.json({ success: !out?.held, result: out?.held ? { held: true, reason: out.reason } : { delivery_id: out?.delivery?.delivery_id } });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ── POST /payment/confirm ─────────────────────────────────────────
// Webhook or manual confirmation of an on-chain payment
router.post('/payment/confirm', async (req, res) => {
  const { transaction_id, tx_hash, amount_received } = req.body;
  if (!transaction_id) return res.status(400).json({ error: 'transaction_id required' });

  try {
    const tx = await PaymentService.confirmPayment({
      transactionId:  transaction_id,
      txHash:         tx_hash || null,
      amountReceived: amount_received || null,
    });

    // Auto-run pipeline after confirmation
    Pipeline.run(transaction_id).catch(err =>
      console.error('[RaPaX™] Pipeline error post-confirm:', err.message)
    );

    res.json({ success: true, transaction: tx, message: 'Confirmed. Pipeline started.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /delivery/issue ──────────────────────────────────────────
// Manually issue a delivery for a fingerprinted transaction
router.post('/delivery/issue', async (req, res) => {
  const { transaction_id } = req.body;
  if (!transaction_id) return res.status(400).json({ error: 'transaction_id required' });

  const tx = TransactionModel.findById(transaction_id);
  if (!tx) return res.status(404).json({ error: 'Transaction not found' });

  const product     = ProductModel.findById(tx.product_id);
  const fingerprint = FingerprintModel.findByTransactionId(transaction_id);
  if (!fingerprint) return res.status(409).json({ error: 'Asset has not been fingerprinted yet' });

  try {
    const delivery = await DeliveryService.issueDelivery({
      transactionId: transaction_id,
      product,
      fingerprint,
    });
    res.json({ success: true, delivery });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
