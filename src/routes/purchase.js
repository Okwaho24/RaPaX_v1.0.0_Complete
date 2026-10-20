// ─────────────────────────────────────────────────────────────────
//  RaPaX™ — Purchase Routes
//  POST /purchase/initiate
//  GET  /purchase/status/:transaction_id
// ─────────────────────────────────────────────────────────────────
import { config } from '../config/index.js';
import { Router } from 'express';
import { ProductModel } from '../models/productModel.js';
import { TransactionModel } from '../models/transactionModel.js';
import { PaymentAddressModel } from '../models/paymentAddressModel.js';
import { DeliveryModel } from '../models/deliveryModel.js';
import { LexForgeService } from '../services/lexforgeService.js';
import { PaymentService, SUPPORTED_CURRENCIES, ENABLED_CURRENCIES } from '../services/paymentService.js';

const router = Router();

function publicOrigin(req) {
  if (config.fiat.publicBaseUrl) return config.fiat.publicBaseUrl.replace(/\/+$/, '');
  const proto = (req.get('x-forwarded-proto') || req.protocol || 'http').split(',')[0].trim();
  return `${proto}://${req.get('host')}`;
}

// "<account>?dt=<tag>" (XRP) → separate fields for the buyer; BTC passes through
function splitAddress(stored) {
  const x = /^(.+)\?dt=(\d+)$/.exec(stored);
  if (x) return { payment_address: x[1], destination_tag: Number(x[2]) };
  const o = /^(.+)\?o=[0-9a-f-]+$/i.exec(stored);          // SOL: shared wallet, unique amount
  return { payment_address: o ? o[1] : stored };
}

router.post('/purchase/initiate', async (req, res) => {
  const { product_id, currency, wallet_address, jurisdiction, region, language_pref } = req.body;

  if (!product_id || !currency) {
    return res.status(400).json({ error: 'product_id and currency are required' });
  }

  if (typeof currency !== 'string' || !ENABLED_CURRENCIES.includes(currency.toUpperCase())) {
    return res.status(400).json({
      error: `Currency not available. Accepted: ${ENABLED_CURRENCIES.join(', ')}`,
    });
  }

  const product = ProductModel.findById(product_id);
  if (!product)             return res.status(404).json({ error: 'Product not found' });
  if (!product.availability) return res.status(409).json({ error: 'Product is not available' });

  // Legal documents are jurisdiction- and language-specific. Refuse BEFORE taking payment if we cannot supply them.
  if (typeof jurisdiction !== 'string' || !/^[A-Z]{2}$/.test(jurisdiction)) {
    return res.status(400).json({ error: 'jurisdiction (ISO 3166-1 alpha-2 country code, upper case, e.g. "CA") is required', code: 'jurisdiction_required' });
  }
  if (region != null && (typeof region !== 'string' || !/^[A-Z]{2}-[A-Z0-9]{1,3}$/.test(region))) {
    return res.status(400).json({ error: 'region must look like "CA-QC"', code: 'invalid_region' });
  }
  if (language_pref != null && (typeof language_pref !== 'string' || !/^(auto|all|[A-Za-z]{2}([_-][A-Za-z]{2,5})?)$/.test(language_pref))) {
    return res.status(400).json({ error: "language_pref must be 'auto', 'all' or a language code", code: 'invalid_language' });
  }
  try {
    const avail = await LexForgeService.availability({ product_id, jurisdiction, region: region || undefined, language_pref: language_pref || undefined });
    if (!avail.available) {
      return res.status(422).json({ error: 'This product cannot be sold with correct legal documents for your location yet.', code: avail.code || 'unavailable', reason: avail.reason });
    }
  } catch (err) {
    // Cannot confirm we can fulfil → do not take money.
    console.error('[RaPaX™] LexForge availability failed:', err.message);
    return res.status(503).json({ error: 'Checkout temporarily unavailable. No payment was taken.', code: 'fulfilment_unavailable' });
  }

  try {
    const { transaction, paymentAddress, checkout } = await PaymentService.initiatePurchase({
      product,
      currency,
      buyerWallet: wallet_address || null,
      jurisdiction,
      region: region || null,
      languagePref: language_pref || null,
    });

    if (checkout) {
      return res.status(201).json({
        success:         true,
        transaction_id:  transaction.transaction_id,
        status:          transaction.status,
        currency:        transaction.currency,
        amount_expected: transaction.amount_expected,
        checkout_url:    checkout.url,
        expires_at:      checkout.expires_at,
        instructions:    'Complete payment on the secure Stripe page. Your download appears here automatically.',
      });
    }

    res.status(201).json({
      success:         true,
      transaction_id:  transaction.transaction_id,
      status:          transaction.status,
      currency:        transaction.currency,
      amount_expected: transaction.amount_expected,
      ...splitAddress(paymentAddress.address),
      expires_at:      paymentAddress.expires_at,
      instructions:    transaction.currency === 'XRP'
        ? `Send exactly ${transaction.amount_expected} XRP to the address with the DESTINATION TAG shown. Payments without the tag cannot be matched.`
        : `Send exactly ${transaction.currency === 'SOL' ? transaction.amount_expected.toFixed(9) : transaction.amount_expected} ${transaction.currency} to the address above. The amount is unique to your order — do not round it.`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/payment-methods', (_req, res) => res.json({ currencies: ENABLED_CURRENCIES }));

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
      Object.assign(response, splitAddress(paymentAddr.address));
      response.expires_at      = paymentAddr.expires_at;
    }

    if (tx.status === 'held') {
      response.message = 'Payment received. Your order needs a manual check before delivery; you will be contacted. No further payment is needed.';
    }

    if (delivery && (tx.status === 'delivering' || tx.status === 'complete')) {
      response.download_link = delivery.download_token ? `${publicOrigin(req)}/api/download/${delivery.download_token}` : null;
      response.download_expires_at = delivery.expires_at || null;
    }

    res.json(response);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
