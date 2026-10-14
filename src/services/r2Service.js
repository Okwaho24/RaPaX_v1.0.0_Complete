// ─────────────────────────────────────────────────────────────────
//  RaPaX™ — Cloudflare R2 Storage Service
// ─────────────────────────────────────────────────────────────────
import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../config/index.js';

const r2 = new S3Client({
  region: 'auto',
  endpoint: config.r2.endpoint,
  credentials: {
    accessKeyId:     config.r2.accessKeyId,
    secretAccessKey: config.r2.secretAccessKey,
  },
});

const BUCKET = config.r2.bucket;

export async function uploadToR2(key, buffer, mimeType) {
  await r2.send(new PutObjectCommand({
    Bucket:      BUCKET,
    Key:         key,
    Body:        buffer,
    ContentType: mimeType,
  }));
  return key;
}

export async function getSignedDownloadUrl(key, expiresIn = 900) {
  const cmd = new GetObjectCommand({ Bucket: BUCKET, Key: key });
  return getSignedUrl(r2, cmd, { expiresIn });
}

export async function deleteFromR2(key) {
  await r2.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}
