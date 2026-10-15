// ─────────────────────────────────────────────────────────────────
//  RaPaX™ — Webhooks. MUST be mounted BEFORE express.json():
//  signature verification needs the raw request bytes.
// ─────────────────────────────────────────────────────────────────
import express, { Router } from 'express';
import { verifyStripeSignature, handleStripeEvent } from '../services/stripeService.js';

const router = Router();

export function stripeWebhookHandler(opts = {}) {
  return async (req, res) => {
    let event;
    try {
      event = verifyStripeSignature(req.body, req.get('stripe-signature'));
    } catch (err) {
      return res.status(400).json({ error: 'Invalid signature' });
    }
    try {
      const result = await handleStripeEvent(event, opts);
      return res.status(200).json({ received: true, result });
    } catch (err) {
      console.error('[RaPaX™][Stripe webhook]', err.message);
      return res.status(500).json({ error: 'Webhook processing failed' }); // Stripe will retry
    }
  };
}

router.post('/webhooks/stripe', express.raw({ type: 'application/json', limit: '1mb' }), stripeWebhookHandler());

export default router;
