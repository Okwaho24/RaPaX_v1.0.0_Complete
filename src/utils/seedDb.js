// ─────────────────────────────────────────────────────────────────
//  RaPaX™ — Seed Script
// ─────────────────────────────────────────────────────────────────
console.log('[Seed] Starting...');

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { initDb, getDb } from './initDb.js';
import { persistDb } from './db.js';
import { ProductModel } from '../models/productModel.js';
import { config } from '../config/index.js';

console.log('[Seed] Imports loaded');

async function seed() {
  console.log('[Seed] seed() function starting');
  await initDb();
  console.log('[Seed] initDb() completed');

  const stubPath = path.join(config.storage.products, 'sample_product.txt');
  fs.writeFileSync(stubPath, 'This is a sample digital product file. Replace with actual content.');

  const products = [
    {
      name:        'Sovereign Beat Pack Vol. 1',
      description: 'Exclusive producer kit — 24 custom drumkits, 48 one-shots, 12 melody loops.',
      price_btc:   0.0008,
      price_eth:   0.012,
      price_sol:   0.5,
      price_usdt:  49.99,
      file_path:   stubPath,
      version:     '1.0.0',
      availability: true,
    },
    {
      name:        'RaPaX™ Developer SDK',
      description: 'Full integration SDK for building on the RaPaX™ vending protocol.',
      price_btc:   0.002,
      price_eth:   0.03,
      price_sol:   1.2,
      price_usdt:  129.00,
      file_path:   stubPath,
      version:     '1.0.0',
      availability: true,
    },
    {
      name:        'Stealth Template Pack',
      description: 'Unreleased design templates. Limited edition.',
      price_btc:   0.0004,
      price_eth:   0.006,
      price_sol:   0.25,
      price_usdt:  24.99,
      file_path:   stubPath,
      version:     '2.1.0',
      availability: true,
    },
  ];

  console.log('[Seed] Starting product creation loop');
  for (const p of products) {
    const created = ProductModel.create(p);
    console.log(`[Seed] Created product: ${created.name} (${created.product_id})`);
  }

  console.log('[Seed] Waiting 100ms before persist');
  await new Promise(resolve => setTimeout(resolve, 100));

  console.log('[Seed] Calling persistDb()');
  persistDb();
  console.log('\n[RaPaX™] Seed complete ✓');
  process.exit(0);
}

console.log('[Seed] Calling seed()');
seed().catch(err => {
  console.error('[Seed] Error:', err.message);
  console.error('[Seed] Stack:', err.stack);
  process.exit(1);
});
