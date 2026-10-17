// ─────────────────────────────────────────────────────────────────
//  RaPaX™ — Delivery Service
//  Generates secure expiring download tokens.
//  Resolves tokens to signed R2 URLs. Logs every delivery event.
// ─────────────────────────────────────────────────────────────────
import crypto from 'crypto';
import path from 'path';
import { DeliveryModel } from '../models/deliveryModel.js';
import { FingerprintModel } from '../models/fingerprintModel.js';
import { TransactionModel, TxStatus } from '../models/transactionModel.js';
import { auditLog, EventType } from '../utils/auditLogger.js';
import { getSignedDownloadUrl } from './r2Service.js';

export const DeliveryService = {

  async issueDelivery({ transactionId, product, fingerprint }) {
    const downloadToken = crypto.randomBytes(48).toString('hex');

    const delivery = DeliveryModel.create({
      transaction_id: transactionId,
      product_id:     product.product_id,
      buyer_wallet:   fingerprint.buyer_wallet,
      fingerprint_id: fingerprint.fingerprint_id,
      download_token: downloadToken,
      file_hash:      fingerprint.file_hash,
    });

    TransactionModel.updateStatus(transactionId, TxStatus.DELIVERING);

    auditLog({
      eventType:     EventType.DELIVERY,
      transactionId,
      productId:     product.product_id,
      fingerprintId: fingerprint.fingerprint_id,
      deliveryId:    delivery.delivery_id,
      actor:         fingerprint.buyer_wallet || 'anonymous',
      payload:       {
        action:        'DELIVERY_ISSUED',
        download_link: delivery.download_link,
        expires_at:    delivery.expires_at,
        file_hash:     delivery.file_hash,
      },
    });

    return delivery;
  },

  async resolveToken(token) {
    const delivery = DeliveryModel.findByToken(token);

    if (!delivery) {
      throw Object.assign(new Error('Invalid download token'), { status: 404 });
    }

    if (new Date(delivery.expires_at) < new Date()) {
      throw Object.assign(new Error('Download link has expired'), { status: 410 });
    }

    const fingerprint = FingerprintModel.findById(delivery.fingerprint_id);
    if (!fingerprint) {
      throw Object.assign(new Error('Fingerprint record missing'), { status: 500 });
    }

    const r2Key = fingerprint.fingerprinted_file_path;
    const signedUrl = await getSignedDownloadUrl(r2Key, 900, path.basename(r2Key));

    DeliveryModel.recordDownload(delivery.delivery_id);
    TransactionModel.updateStatus(delivery.transaction_id, TxStatus.COMPLETE);

    auditLog({
      eventType:     EventType.DELIVERY,
      transactionId: delivery.transaction_id,
      productId:     delivery.product_id,
      fingerprintId: delivery.fingerprint_id,
      deliveryId:    delivery.delivery_id,
      actor:         delivery.buyer_wallet || 'anonymous',
      payload:       {
        action:         'ASSET_DOWNLOADED',
        download_count: delivery.download_count + 1,
        file_hash:      delivery.file_hash,
      },
    });

    return {
      signedUrl,
      filename: path.basename(r2Key),
      delivery,
    };
  },
};
