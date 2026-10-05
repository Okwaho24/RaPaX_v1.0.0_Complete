// ─────────────────────────────────────────────────────────────────
//  RaPaX™ — File-Based Database (JSON)
//  Products stored as JSON manifest + audit log in data/db/.
// ─────────────────────────────────────────────────────────────────
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../');
const dataDir = path.resolve(ROOT, 'data/db');
const manifestPath = path.join(dataDir, 'manifest.json');

function ensureDataDir() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
}

function loadManifest() {
  ensureDataDir();
  if (fs.existsSync(manifestPath)) {
    const raw = fs.readFileSync(manifestPath, 'utf8');
    return JSON.parse(raw);
  }
  return { products: {}, audit_log: [] };
}

function saveManifest(manifest) {
  ensureDataDir();
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
}

class FileDb {
  prepare(sql) {
    const sqlNorm = sql.replace(/\s+/g, ' ').trim();
    
    return {
      run: (...args) => {
        const params = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
        const manifest = loadManifest();
        
        if (sqlNorm.includes('INSERT INTO products')) {
          const [id, name, desc, pbtc, peth, psol, pusdt, pfiat, fpath, ver, avail, cat, uat] = params;
          manifest.products[id] = {
            product_id: id, name, description: desc,
            price_btc: pbtc, price_eth: peth, price_sol: psol, price_usdt: pusdt, price_fiat: pfiat,
            file_path: fpath, version: ver, availability: avail,
            created_at: cat, updated_at: uat
          };
          saveManifest(manifest);
          return { changes: 1, lastInsertRowid: null };
        }
        
        if (sqlNorm.includes('INSERT INTO audit_log')) {
          manifest.audit_log.push({
            log_id: params[0], event_type: params[1], transaction_id: params[2],
            product_id: params[3], fingerprint_id: params[4], delivery_id: params[5],
            actor: params[6], payload: params[7], created_at: params[8]
          });
          saveManifest(manifest);
          return { changes: 1, lastInsertRowid: null };
        }
        
        return { changes: 0, lastInsertRowid: null };
      },
      
      get: (...args) => {
        const params = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
        const manifest = loadManifest();
        if (sqlNorm.includes('SELECT') && sqlNorm.includes('products') && sqlNorm.includes('WHERE')) {
          const id = params[0];
          return manifest.products[id] || null;
        }
        return null;
      },
      
      all: (...args) => {
        const params = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
        const manifest = loadManifest();
        let results = Object.values(manifest.products);
        
        // Handle WHERE availability=1
        if (sqlNorm.includes('WHERE availability=1')) {
          results = results.filter(p => p.availability === 1);
        }
        
        // Handle ORDER BY created_at DESC
        if (sqlNorm.includes('ORDER BY created_at DESC')) {
          results.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        }
        
        return results;
      }
    };
  }
  
  exec(sql) {
    return this;
  }
  
  close() {}
}

let _db = null;

export async function openDb() {
  ensureDataDir();
  if (!_db) {
    _db = new FileDb();
  }
  return _db;
}

export function getDb() {
  if (!_db) {
    _db = new FileDb();
  }
  return _db;
}

export function persistDb() {}
export function startAutoPersist() {}
