// ─────────────────────────────────────────────────────────────────
//  RaPaX™ — Download Route
//  GET /download/:token
//  Resolves token → signed R2 URL → 302 redirect.
//  No file paths exposed. Token-only access.
// ─────────────────────────────────────────────────────────────────
import { Router } from 'express';
import { DeliveryService } from '../services/deliveryService.js';

const router = Router();

router.get('/download/:token', async (req, res) => {
  try {
    const { signedUrl } = await DeliveryService.resolveToken(req.params.token);
    res.redirect(302, signedUrl);
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ error: err.message });
  }
});

export default router;
