// ─────────────────────────────────────────────────────────────────
//  RaPaX™ — LexForge™ client
//  availability(): dry run BEFORE payment — can we lawfully fulfil this sale?
//  bundle():       after payment — the jurisdiction/language-specific legal documents for this sale.
//  Requests are HMAC-signed (x-rapax-signature) with RAPAX_WEBHOOK_SECRET, the scheme LexForge already verifies.
// ─────────────────────────────────────────────────────────────────
import crypto from 'crypto';
import { config } from '../config/index.js';

export class FulfilmentError extends Error {
  constructor(message, { retryable = false, code = 'error', details = null } = {}) {
    super(message); this.retryable = retryable; this.code = code; this.details = details;
  }
}

async function signedPost(path, body) {
  if (!config.lexforge.secret || config.lexforge.secret.length < 32) {
    throw new FulfilmentError('RAPAX_WEBHOOK_SECRET is not configured (min 32 chars)', { retryable: false, code: 'config' });
  }
  const raw = JSON.stringify(body);
  const sig = 'sha256=' + crypto.createHmac('sha256', config.lexforge.secret).update(raw).digest('hex');
  let res;
  try {
    res = await fetch(`${config.lexforge.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-rapax-signature': sig },
      body: raw,
      signal: AbortSignal.timeout(config.lexforge.timeoutMs),
    });
  } catch (err) {
    throw new FulfilmentError(`LexForge™ unreachable: ${err.message}`, { retryable: true, code: 'unreachable' });
  }
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON body */ }
  return { status: res.status, data };
}

export const LexForgeService = {
  /** Never throws for a business "no": returns { available:false, code, reason }. Throws FulfilmentError if LexForge cannot answer. */
  async availability({ product_id, jurisdiction, region, language_pref }) {
    const { status, data } = await signedPost('/webhook/lexforge/availability', { product_id, jurisdiction, region, language_pref });
    if (status === 200 && data && typeof data.available === 'boolean') return data;
    throw new FulfilmentError(`LexForge™ availability check failed (HTTP ${status})`, { retryable: status >= 500, code: 'lexforge_error' });
  },

  async bundle({ transaction, product, buyerRef }) {
    const { status, data } = await signedPost('/webhook/lexforge/bundle', {
      transaction_id: transaction.transaction_id,
      product_id: product.product_id,
      product_name: product.name,
      product_version: product.version,
      buyer_ref: buyerRef,
      jurisdiction: transaction.jurisdiction,
      region: transaction.region || undefined,
      language_pref: transaction.language_pref || undefined,
    });
    if (status === 200 && data && Array.isArray(data.documents) && data.documents.length) return data;
    // 4xx = the content gate refused: retrying will not change that. 5xx / network = retry.
    throw new FulfilmentError(data?.error || data?.reason || `LexForge™ bundle refused (HTTP ${status})`,
      { retryable: status >= 500 || status === 0, code: data?.code || 'lexforge_error', details: data?.details });
  },
};
