// ─────────────────────────────────────────────────────────────────
//  RaPaX™ — AcerbE™ packaging client
//  Sends the paid product + this sale's legal documents to the AcerbE™ package service (POST /package).
//  AcerbE™ stamps every file, builds the ZIP, and runs its own release gate before returning anything.
//  RaPaX™ re-checks the package hash, stores the ZIP in R2, and records it. There is NO fallback:
//  if AcerbE™ cannot deliver a verified package, nothing is delivered (fail closed in every environment).
// ─────────────────────────────────────────────────────────────────
import crypto from 'crypto';
import path from 'path';
import { config } from '../config/index.js';
import { FingerprintModel } from '../models/fingerprintModel.js';
import { TransactionModel, TxStatus } from '../models/transactionModel.js';
import { auditLog, EventType } from '../utils/auditLogger.js';
import { downloadFromR2, uploadToR2 } from './r2Service.js';
import { FulfilmentError } from './lexforgeService.js';

export function buyerRef(transaction) {
  return transaction.buyer_wallet || 'anonymous';
}

export const AcerbEService = {

  async package({ transactionId, product, transaction, bundle }) {
    // Idempotent: a retry after the ZIP was stored must not stamp (and register) a second set of fingerprints.
    const existing = FingerprintModel.findByTransactionId(transactionId);
    if (existing) return existing;

    if (!product.file_path || !product.file_path.startsWith('products/')) {
      throw new FulfilmentError(`Product ${product.product_id} has no file in storage (file_path='${product.file_path}')`, { retryable: false, code: 'no_product_file' });
    }
    TransactionModel.updateStatus(transactionId, TxStatus.FINGERPRINTING);

    let productBytes;
    try { productBytes = await downloadFromR2(product.file_path); }
    catch (err) { throw new FulfilmentError(`Cannot read product from storage: ${err.message}`, { retryable: true, code: 'r2_read' }); }

    const meta = {
      transaction_id: transactionId,
      buyer_ref: buyerRef(transaction),
      product_id: product.product_id,
      product_name: product.name,
      timestamp_utc: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
      manifest_extra: {
        jurisdiction: transaction.jurisdiction,
        region: transaction.region || null,
        languages_shipped: bundle.languages_shipped,
        languages_unavailable: Object.keys(bundle.languages_unavailable || {}),
        product_version: product.version,
      },
    };
    const form = new FormData();
    form.append('meta', JSON.stringify(meta));
    form.append('docs', JSON.stringify(bundle.documents));
    form.append('product', new Blob([productBytes]), path.basename(product.file_path));

    let res;
    try {
      res = await fetch(`${config.acerbe.baseUrl}/package`, {
        method: 'POST', headers: { 'X-AcerbE-Key': config.acerbe.apiKey }, body: form,
        signal: AbortSignal.timeout(config.acerbe.timeoutMs),
      });
    } catch (err) {
      throw new FulfilmentError(`AcerbE™ unreachable: ${err.message}`, { retryable: true, code: 'acerbe_unreachable' });
    }

    if (res.status !== 200) {
      let body = null; try { body = await res.json(); } catch { /* ignore */ }
      const retryable = body?.retryable ?? res.status >= 500;
      throw new FulfilmentError(`AcerbE™ refused package (HTTP ${res.status}): ${body?.reason || 'no reason given'}`, { retryable, code: 'acerbe_refused' });
    }

    const zip = Buffer.from(await res.arrayBuffer());
    const sha = crypto.createHash('sha256').update(zip).digest('hex');
    const claimed = res.headers.get('x-acerbe-package-sha256');
    const count = parseInt(res.headers.get('x-acerbe-fingerprint-count') || '0', 10);
    const ids = (res.headers.get('x-acerbe-fingerprint-ids') || '').split(',').filter(Boolean);
    if (res.headers.get('content-type') !== 'application/zip' || claimed !== sha || count < 1 || ids.length !== count) {
      throw new FulfilmentError('AcerbE™ response failed integrity checks (type/hash/fingerprint count)', { retryable: true, code: 'acerbe_integrity' });
    }

    const r2Key = `deliveries/${transactionId}.zip`;
    try { await uploadToR2(r2Key, zip, 'application/zip'); }
    catch (err) { throw new FulfilmentError(`Cannot store package: ${err.message}`, { retryable: true, code: 'r2_write' }); }

    const fingerprint = FingerprintModel.create({
      fingerprint_id: res.headers.get('x-acerbe-fingerprint-hash') || sha,
      transaction_id: transactionId,
      product_id: product.product_id,
      buyer_wallet: transaction.buyer_wallet,
      original_file_path: product.file_path,
      fingerprinted_file_path: r2Key,
      file_hash: sha,
      acerbe_response_raw: { version: res.headers.get('x-acerbe-version'), fingerprint_ids: ids, package_sha256: sha, languages: bundle.languages_shipped },
    });

    auditLog({
      eventType: EventType.FINGERPRINT, transactionId, productId: product.product_id,
      fingerprintId: fingerprint.fingerprint_id, actor: buyerRef(transaction),
      payload: { action: 'PACKAGE_STAMPED_AND_STORED', fingerprint_count: count, package_sha256: sha, r2_key: r2Key, languages: bundle.languages_shipped },
    });
    return fingerprint;
  },
};
