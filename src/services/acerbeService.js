// ─────────────────────────────────────────────────────────────────
//  RaPaX™ — AcerbE™ Fingerprinting Service
//  Calls the AcerbE™ API to fingerprint an asset before delivery.
// ─────────────────────────────────────────────────────────────────
import axios from 'axios';
import { config } from '../config/index.js';
import { FingerprintModel } from '../models/fingerprintModel.js';
import { TransactionModel, TxStatus } from '../models/transactionModel.js';
import { auditLog, EventType } from '../utils/auditLogger.js';

export const AcerbEService = {

  /**
   * Send asset to AcerbE™ for fingerprinting.
   *
   * AcerbE™ contract:
   *   POST /fingerprint
   *   Body: { product_id, buyer_wallet, timestamp, file_path }
   *
   *   Response: { fingerprinted_file_path, fingerprint_id, hash }
   */
  async fingerprint({ transactionId, product, transaction }) {
    const payload = {
      product_id:     product.product_id,
      transaction_id: transactionId,
      buyer_wallet:   transaction.buyer_wallet ?? 'anonymous',
      timestamp:    new Date().toISOString(),
      file_path:    product.file_path,
    };

    // Mark transaction as fingerprinting
    TransactionModel.updateStatus(transactionId, TxStatus.FINGERPRINTING);

    let acerbeResponse;

    try {
      const { data } = await axios.post(
        `${config.acerbe.baseUrl}/fingerprint`,
        payload,
        {
          headers: {
            'Content-Type':  'application/json',
            'X-AcerbE-Key':  config.acerbe.apiKey,
          },
          timeout: 30000,
        }
      );
      acerbeResponse = data;

    } catch (err) {
      // AcerbE™ unavailable — use fallback local fingerprint in dev
      if (config.server.env !== 'production') {
        console.warn('[RaPaX™][AcerbE™] Service unreachable — using dev fallback fingerprint');
        acerbeResponse = await this._devFallback(payload);
      } else {
        TransactionModel.updateStatus(transactionId, TxStatus.FAILED);
        throw new Error(`AcerbE™ fingerprinting failed: ${err.message}`);
      }
    }

    const { fingerprinted_file_path, fingerprint_id, hash } = acerbeResponse;

    // Persist fingerprint record
    const fingerprint = FingerprintModel.create({
      fingerprint_id,
      transaction_id:          transactionId,
      product_id:              product.product_id,
      buyer_wallet:            transaction.buyer_wallet,
      original_file_path:      product.file_path,
      fingerprinted_file_path,
      file_hash:               hash,
      acerbe_response_raw:     acerbeResponse,
    });

    // Audit log
    auditLog({
      eventType:     EventType.FINGERPRINT,
      transactionId,
      productId:     product.product_id,
      fingerprintId: fingerprint_id,
      actor:         transaction.buyer_wallet || 'anonymous',
      payload:       {
        action:                  'FINGERPRINT_COMPLETE',
        fingerprint_id,
        file_hash:               hash,
        fingerprinted_file_path,
      },
    });

    return fingerprint;
  },

  /**
   * Development fallback when AcerbE™ is not reachable.
   * Copies the original file, appends a hash marker, simulates response.
   */
  async _devFallback(payload) {
    const { createHash } = await import('crypto');
    const { v4: uuidv4 }  = await import('uuid');
    const fs               = await import('fs');
    const path             = await import('path');
    const { config: cfg }  = await import('../config/index.js');

    const fingerprintId = uuidv4();
    const timestamp     = payload.timestamp.replace(/[:.]/g, '-');

    // Determine output path
    const origName = path.default.basename(payload.file_path);
    const destName = `fp_${fingerprintId}_${origName}`;
    const destPath = path.default.join(cfg.storage.fingerprinted, destName);

    // Copy file if it exists, otherwise create stub
    if (fs.default.existsSync(payload.file_path)) {
      fs.default.copyFileSync(payload.file_path, destPath);
      // Append fingerprint marker
      const marker = `\n\n[RAPAX_FINGERPRINT: ${fingerprintId} | BUYER: ${payload.buyer_wallet} | ${payload.timestamp}]`;
      fs.default.appendFileSync(destPath, marker);
    } else {
      const content = `[DEV STUB] Product: ${payload.product_id}\nBuyer: ${payload.buyer_wallet}\nTimestamp: ${payload.timestamp}\nFingerprint: ${fingerprintId}`;
      fs.default.writeFileSync(destPath, content);
    }

    const fileContent = fs.default.readFileSync(destPath);
    const hash        = createHash('sha256').update(fileContent).digest('hex');

    return {
      fingerprint_id:          fingerprintId,
      fingerprinted_file_path: destPath,
      hash,
    };
  },
};
