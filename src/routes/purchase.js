// ─────────────────────────────────────────────────────────────────
//  RaPaX™ — Purchase Routes
//  POST /purchase/initiate
//  GET  /purchase/status/:transaction_id
// ─────────────────────────────────────────────────────────────────
import { Router } from 'express';
import { ProductModel } from '../models/productModel.js';
import { TransactionModel } from '../models/transactionModel.js';
import { PaymentAddressModel } from '../models/paymentAddressModel.js';
import { DeliveryModel } from '../models/deliveryModel.js';
import { PaymentService, SUPPORTED_CURRENCIES } from '../services/paymentService.js';

const router = Router();

router.post('/purchase/initiate', async (req, res) => {
  const { product_id, currency, wallet_address } = req.body;

  if (!product_id || !currency) {
    return res.status(400).json({ error: 'product_id and currency are required' });
  }

  if (!SUPPORTED_CURRENCIES.includes(currency.toUpperCase())) {
    return res.status(400).json({
      error: `Unsupported currency. Supported: ${SUPPORTED_CURRENCIES.join(', ')}`,
    });
  }

  const product = ProductModel.findById(product_id);
  if (!product)             return res.status(404).json({ error: 'Product not found' });
  if (!product.availability) return res.status(409).json({ error: 'Product is not available' });

  try {
    const { transaction, paymentAddress } = await PaymentService.initiatePurchase({
      product,
      currency,
      buyerWallet: wallet_address || null,
    });

    res.status(201).json({
      success:         true,
      transaction_id:  transaction.transaction_id,
      status:          transaction.status,
      currency:        transaction.currency,
      amount_expected: transaction.amount_expected,
      payment_address: paymentAddress.address,
      expires_at:      paymentAddress.expires_at,
      instructions:    `Send exactly ${transaction.amount_expected} ${transaction.currency} to the address above.`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/purchase/status/:transaction_id', (req, res) => {
  try {
    const tx = TransactionModel.findById(req.params.transaction_id);
    if (!tx) return res.status(404).json({ error: 'Transaction not found' });

    const paymentAddr = PaymentAddressModel.findByTransactionId(tx.transaction_id);
    const delivery    = DeliveryModel.findByTransactionId(tx.transaction_id);

    const response = {
      success:         true,
      transaction_id:  tx.transaction_id,
      status:          tx.status,
      currency:        tx.currency,
      amount_expected: tx.amount_expected,
      amount_received: tx.amount_received,
      confirmations:   tx.confirmations,
      created_at:      tx.created_at,
      updated_at:      tx.updated_at,
    };

    if (paymentAddr) {
      response.payment_address = paymentAddr.address;
      response.expires_at      = paymentAddr.expires_at;
    }

    if (delivery && (tx.status === 'delivering' || tx.status === 'complete')) {
      response.download_link = delivery.download_link || null;
      response.download_expires_at = delivery.expires_at || null;
    }

    res.json(response);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
