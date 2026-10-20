import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { config } from '../config/index.js';

// Single source of truth for the DB location: config.db.path (env DB_PATH).
// In production on Railway DB_PATH must point inside the persistent volume (e.g. /data/rapax.db),
// otherwise the database lives on the container's ephemeral disk and is lost on every deploy.
const dbPath = config.db.path;

fs.mkdirSync(path.dirname(dbPath), { recursive: true });

let _db = null;

function open() {
  const db = new Database(dbPath, { fileMustExist: false });
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  return db;
}

export async function openDb() {
  if (!_db) _db = open();
  return _db;
}

export function getDb() {
  if (!_db) _db = open();
  return _db;
}

export function getDbPath() {
  return dbPath;
}

export function closeDb() {
  if (_db) {
    try { _db.close(); } finally { _db = null; }
  }
}

export function startAutoPersist() {}
