// RaPaX™ — list / fetch DB backups. NEVER overwrites the live database.
//   node scripts/restore_db.mjs              → list backups (newest first)
//   node scripts/restore_db.mjs <key>        → download + verify, write <DB_PATH>.restored
import 'dotenv/config';
import fs from 'fs';
import zlib from 'zlib';
import Database from 'better-sqlite3';
import { config } from '../src/config/index.js';
import { listR2, getObjectBuffer } from '../src/services/r2Service.js';

const key = process.argv[2];
const all = (await listR2('backups/rapax/')).sort((a, b) => (a.key < b.key ? 1 : -1));
if (!key) {
  if (!all.length) console.log('No backups found.');
  for (const o of all) console.log(`${o.key}  ${o.size} bytes  ${o.lastModified?.toISOString?.() ?? ''}`);
  process.exit(0);
}
const out = `${config.db.path}.restored`;
if (fs.existsSync(out)) { console.error(`STOPPED: ${out} already exists. Move it away first.`); process.exit(1); }
const raw = zlib.gunzipSync(await getObjectBuffer(key));
fs.writeFileSync(out, raw);
const db = new Database(out, { readonly: true });
const ic = db.pragma('integrity_check', { simple: true });
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
db.close();
console.log(`Wrote ${out}\nintegrity_check: ${ic}\ntables: ${tables.join(', ')}`);
if (ic !== 'ok') process.exit(2);
console.log('Live database untouched. To use it: stop the service, move this file over the live DB, start the service.');
