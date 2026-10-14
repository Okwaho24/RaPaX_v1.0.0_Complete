// ─────────────────────────────────────────────────────────────────
//  RaPaX™ — Seed Script
// ─────────────────────────────────────────────────────────────────
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { initDb, getDb } from './initDb.js';
import { ProductModel } from '../models/productModel.js';
import { config } from '../config/index.js';

export async function seedProducts() {
  await initDb();
  const db = getDb();
  const existing = db.prepare('SELECT COUNT(*) as n FROM products').get();
  if (existing.n > 0) {
    console.log(`[RaPaX™] Auto-seed skipped — ${existing.n} products already exist.`);
    return;
  }

  const stubPath = path.join(config.storage.products, 'sample_product.txt');
  fs.mkdirSync(path.dirname(stubPath), { recursive: true });
  fs.writeFileSync(stubPath, 'Sample digital product file. Replace with actual content.');

  const products = [
    {
      name:         'Sovereign Beat Pack Vol. 1',
      description:  'Exclusive producer kit — 24 custom drumkits, 48 one-shots, 12 melody loops.',
      price_btc:    0.0008,
      price_eth:    0.012,
      price_sol:    0.5,
      price_usdt:   49.99,
      file_path:    stubPath,
      version:      '1.0.0',
      availability: true,
    },
    {
      name:         'RaPaX™ Developer SDK',
      description:  'Full integration SDK for building on the RaPaX™ vending protocol.',
      price_btc:    0.002,
      price_eth:    0.03,
      price_sol:    1.2,
      price_usdt:   129.00,
      file_path:    stubPath,
      version:      '1.0.0',
      availability: true,
    },
    {
      name:         'Stealth Template Pack',
      description:  'Unreleased design templates. Limited edition.',
      price_btc:    0.0004,
      price_eth:    0.006,
      price_sol:    0.25,
      price_usdt:   24.99,
      file_path:    stubPath,
      version:      '2.1.0',
      availability: true,
    },
  ];

  for (const p of products) {
    const created = ProductModel.create(p);
    console.log(`[RaPaX™] Seeded: ${created.name}`);
  }
  console.log('[RaPaX™] Auto-seed complete ✓');
}

// Allow direct execution: node src/utils/seedDb.js
if (process.argv[1].endsWith('seedDb.js')) {
  seedProducts().then(() => process.exit(0)).catch(err => {
    console.error('[Seed] Error:', err.message);
    process.exit(1);
  });
}
