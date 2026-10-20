// ─────────────────────────────────────────────────────────────────
//  RaPaX™ — Cloudflare R2 Storage Service
// ─────────────────────────────────────────────────────────────────
import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
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

export function r2Configured() {
  return Boolean(config.r2.endpoint && config.r2.accessKeyId && config.r2.secretAccessKey && config.r2.bucket);
}

// Lists every object under a prefix (handles pagination). Returns [{ key, size, lastModified }].
export async function listR2(prefix) {
  const out = [];
  let token;
  do {
    const res = await r2.send(new ListObjectsV2Command({
      Bucket: BUCKET, Prefix: prefix, ContinuationToken: token,
    }));
    for (const o of res.Contents || []) {
      out.push({ key: o.Key, size: o.Size, lastModified: o.LastModified });
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return out;
}

export async function getObjectBuffer(key) {
  const res = await r2.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const chunks = [];
  for await (const c of res.Body) chunks.push(c);
  return Buffer.concat(chunks);
}
