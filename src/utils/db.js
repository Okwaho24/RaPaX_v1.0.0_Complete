import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.resolve(__dirname, '../../data/db/rapax.db');

// Ensure the data/db directory exists before opening
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

let _db = null;

export async function openDb() {
  if (!_db) {
    _db = new Database(dbPath, { fileMustExist: false });
    _db.pragma('journal_mode = WAL');
  }
  return _db;
}

export function getDb() {
  if (!_db) {
    _db = new Database(dbPath, { fileMustExist: false });
    _db.pragma('journal_mode = WAL');
  }
  return _db;
}

export function startAutoPersist() {}
