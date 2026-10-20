// ─────────────────────────────────────────────────────────────────
//  RaPaX™ — Internal API Routes
//  POST /fingerprint       — trigger AcerbE™ pipeline manually
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
import { AcerbEService } from '../services/acerbeService.js';
import { DeliveryService } from '../services/deliveryService.js';
import { FingerprintModel } from '../models/fingerprintModel.js';
import { runBackup, listBackups, backupStatus } from '../services/backupService.js';

const router = Router();

// All internal routes require operator auth
router.use(operatorAuth);

// ── POST /internal/fingerprint ────────────────────────────────────
router.post('/fingerprint', async (req, res) => {
  const { transaction_id } = req.body;
  if (!transaction_id) return res.status(400).json({ error: 'transaction_id required' });

  const tx = TransactionModel.findById(transaction_id);
  if (!tx) return res.status(404).json({ error: 'Transaction not found' });

  const product = ProductModel.findById(tx.product_id);
  if (!product) return res.status(404).json({ error: 'Product not found' });

  try {
    const fingerprint = await AcerbEService.fingerprint({
      transactionId: transaction_id,
      product,
      transaction: tx,
    });
    res.json({ success: true, fingerprint });
  } catch (err) {
    res.status(500).json({ error: err.message });
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

// ── POST /internal/backup — take a DB backup to R2 now ────────────
router.post('/backup', async (req, res) => {
  try { res.json({ success: true, ...(await runBackup()) }); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── GET /internal/backups — status + list of stored backups ───────
router.get('/backups', async (req, res) => {
  try { res.json({ status: backupStatus(), backups: await listBackups() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
