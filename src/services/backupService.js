// ─────────────────────────────────────────────────────────────────
//  RaPaX™ — Database Backup Service
//  Consistent SQLite snapshot (better-sqlite3 online backup API — safe with WAL, never a raw file
//  copy) → gzip → R2 under backups/rapax/. Keeps the newest BACKUP_KEEP snapshots.
// ─────────────────────────────────────────────────────────────────
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { promisify } from 'util';
import cron from 'node-cron';
import { config } from '../config/index.js';
import { getDb, getDbPath } from '../utils/db.js';
import { uploadToR2, listR2, deleteFromR2, r2Configured } from './r2Service.js';

const gzip = promisify(zlib.gzip);
const PREFIX = 'backups/rapax/';
const KEEP = Math.max(5, Number.parseInt(process.env.BACKUP_KEEP ?? '60', 10) || 60);

let inFlight = false;
let last = { at: null, ok: null, key: null, bytes: null, error: null };

export function backupStatus() {
  return { ...last, enabled: r2Configured(), keep: KEEP };
}

export async function listBackups() {
  const all = await listR2(PREFIX);
  return all.sort((a, b) => (a.key < b.key ? 1 : -1)); // newest first (keys are ISO timestamps)
}

async function prune() {
  const all = await listBackups();
  const stale = all.slice(KEEP);
  for (const o of stale) await deleteFromR2(o.key);
  return stale.length;
}

export async function runBackup() {
  if (!r2Configured()) throw new Error('R2 is not configured — backup skipped');
  if (inFlight) throw new Error('A backup is already running');
  inFlight = true;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const tmp = path.join(path.dirname(getDbPath()), `.backup-${stamp}.tmp`);
  try {
    await getDb().backup(tmp);
    const gz = await gzip(await fs.promises.readFile(tmp));
    const key = `${PREFIX}rapax-${stamp}.db.gz`;
    await uploadToR2(key, gz, 'application/gzip');
    let pruned = 0;
    try { pruned = await prune(); } catch (e) { console.error('[RaPaX™][Backup] Prune failed (backup itself succeeded):', e.message); }
    last = { at: new Date().toISOString(), ok: true, key, bytes: gz.length, error: null };
    console.log(`[RaPaX™][Backup] OK ${key} (${gz.length} bytes gz), pruned ${pruned}`);
    return last;
  } catch (e) {
    last = { at: new Date().toISOString(), ok: false, key: null, bytes: null, error: e.message };
    console.error('[RaPaX™][Backup] FAILED:', e.message);
    throw e;
  } finally {
    inFlight = false;
    fs.promises.rm(tmp, { force: true }).catch(() => {});
  }
}

let task = null;
export function startBackupScheduler() {
  if (process.env.BACKUP_ENABLED === 'false') { console.log('[RaPaX™][Backup] Disabled (BACKUP_ENABLED=false)'); return; }
  if (!r2Configured()) { console.error('[RaPaX™][Backup] R2 not configured — scheduled backups NOT running'); return; }
  const expr = process.env.BACKUP_CRON || '17 */6 * * *'; // every 6 h at :17
  if (!cron.validate(expr)) { console.error(`[RaPaX™][Backup] Invalid BACKUP_CRON "${expr}" — scheduled backups NOT running`); return; }
  task = cron.schedule(expr, () => { runBackup().catch(() => {}); });
  // One shortly after boot so every deploy leaves a fresh restore point.
  setTimeout(() => { runBackup().catch(() => {}); }, 90 * 1000).unref();
  console.log(`[RaPaX™][Backup] Scheduled (${expr}), keeping newest ${KEEP}; DB at ${getDbPath()}`);
}

export function stopBackupScheduler() { if (task) { task.stop(); task = null; } }
