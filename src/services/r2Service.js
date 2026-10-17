// ─────────────────────────────────────────────────────────────────
//  RaPaX™ — Cloudflare R2 Storage Service
// ─────────────────────────────────────────────────────────────────
import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../config/index.js';

const r2 = new S3Client({
  region: 'auto',
  endpoint: config.r2.endpoint,
  forcePathStyle: true, // R2 accepts path-style; also lets S3-compatible test servers work
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

export async function downloadFromR2(key, maxBytes = 600 * 1024 * 1024) {
  const out = await r2.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  if (out.ContentLength && out.ContentLength > maxBytes) throw new Error(`R2 object ${key} exceeds ${maxBytes} bytes`);
  const chunks = [];
  let n = 0;
  for await (const c of out.Body) { n += c.length; if (n > maxBytes) throw new Error(`R2 object ${key} exceeds ${maxBytes} bytes`); chunks.push(c); }
  return Buffer.concat(chunks);
}

export async function getSignedDownloadUrl(key, expiresIn = 900, filename = null) {
  const cmd = new GetObjectCommand({ Bucket: BUCKET, Key: key,
    ...(filename ? { ResponseContentDisposition: `attachment; filename="${filename.replace(/[^A-Za-z0-9._-]/g, '_')}"` } : {}) });
  return getSignedUrl(r2, cmd, { expiresIn });
}

export async function deleteFromR2(key) {
  await r2.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}
