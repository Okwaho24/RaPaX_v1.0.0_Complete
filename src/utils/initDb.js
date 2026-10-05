import { openDb, getDb, startAutoPersist } from './db.js';
import { ensureDirs } from './ensureDirs.js';

export { getDb };

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS products (product_id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, price_btc REAL, price_eth REAL, price_sol REAL, price_usdt REAL, price_fiat REAL, file_path TEXT NOT NULL, version TEXT NOT NULL DEFAULT '1.0.0', availability INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS payment_addresses (address_id TEXT PRIMARY KEY, transaction_id TEXT NOT NULL, currency TEXT NOT NULL, address TEXT NOT NULL UNIQUE, derivation_idx INTEGER, expected_amount REAL NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), expires_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS transactions (transaction_id TEXT PRIMARY KEY, product_id TEXT NOT NULL, buyer_wallet TEXT, currency TEXT NOT NULL, amount_expected REAL NOT NULL, amount_received REAL, tx_hash TEXT, status TEXT NOT NULL DEFAULT 'pending', confirmations INTEGER DEFAULT 0, product_version TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS fingerprints (fingerprint_id TEXT PRIMARY KEY, transaction_id TEXT NOT NULL, product_id TEXT NOT NULL, buyer_wallet TEXT, original_file_path TEXT NOT NULL, fingerprinted_file_path TEXT NOT NULL, file_hash TEXT NOT NULL, acerbe_response_raw TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS deliveries (delivery_id TEXT PRIMARY KEY, transaction_id TEXT NOT NULL, product_id TEXT NOT NULL, buyer_wallet TEXT, fingerprint_id TEXT NOT NULL, download_token TEXT NOT NULL UNIQUE, download_link TEXT NOT NULL, file_hash TEXT NOT NULL, expires_at TEXT NOT NULL, downloaded_at TEXT, download_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS audit_log (log_id TEXT PRIMARY KEY, event_type TEXT NOT NULL, transaction_id TEXT, product_id TEXT, fingerprint_id TEXT, delivery_id TEXT, actor TEXT, payload TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS operator_sessions (session_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), expires_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);
  CREATE INDEX IF NOT EXISTS idx_transactions_product ON transactions(product_id);
  CREATE INDEX IF NOT EXISTS idx_audit_event_type ON audit_log(event_type);
  CREATE INDEX IF NOT EXISTS idx_audit_transaction ON audit_log(transaction_id);
  CREATE INDEX IF NOT EXISTS idx_deliveries_token ON deliveries(download_token);
  CREATE INDEX IF NOT EXISTS idx_payment_addr_tx ON payment_addresses(transaction_id);
`;

export async function initDb() {
  ensureDirs();
  await openDb();
  const db = getDb();
  db.exec(SCHEMA);
  startAutoPersist(5000);
  console.log('[RaPaX™] Database initialised ✓');
}
