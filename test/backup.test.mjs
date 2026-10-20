// RaPaX™ — backup service test against a tiny in-process fake S3 (no network, no real R2).
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const key = decodeURIComponent(u.pathname.split('/').slice(2).join('/'));
  if (req.method === 'PUT') {
    const c = []; req.on('data', d => c.push(d));
    req.on('end', () => { store.set(key, Buffer.concat(c)); res.writeHead(200, { ETag: '"x"' }); res.end(); });
  } else if (req.method === 'DELETE') { store.delete(key); res.writeHead(204); res.end(); }
  else if (req.method === 'GET' && u.searchParams.get('list-type') === '2') {
    const prefix = u.searchParams.get('prefix') || '';
    const items = [...store.keys()].filter(k => k.startsWith(prefix)).map(k =>
      `<Contents><Key>${k}</Key><Size>${store.get(k).length}</Size><LastModified>2026-01-01T00:00:00.000Z</LastModified></Contents>`).join('');
    res.writeHead(200, { 'Content-Type': 'application/xml' });
    res.end(`<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>${items}</ListBucketResult>`);
  } else if (req.method === 'GET') {
    const b = store.get(key); if (!b) { res.writeHead(404); return res.end(); }
    res.writeHead(200); res.end(b);
  } else { res.writeHead(405); res.end(); }
});

let tmp;
before(async () => {
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rapax-bk-'));
  process.env.DB_PATH = path.join(tmp, 'vol', 'rapax.db');
  process.env.R2_ENDPOINT = `http://127.0.0.1:${srv.address().port}`;
  process.env.R2_ACCESS_KEY_ID = 'k'; process.env.R2_SECRET_ACCESS_KEY = 's';
  process.env.R2_BUCKET_NAME = 'b'; process.env.BACKUP_KEEP = '5';
});
after(() => { srv.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('DB honours DB_PATH, backup is a valid gzip SQLite snapshot, old backups are pruned', async () => {
  const { getDb, getDbPath, closeDb } = await import('../src/utils/db.js');
  const { runBackup, listBackups } = await import('../src/services/backupService.js');
  assert.equal(getDbPath(), process.env.DB_PATH);
  const db = getDb();
  db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t(v) VALUES (\'hello\');');
  assert.ok(fs.existsSync(process.env.DB_PATH), 'db file created at DB_PATH');

  const r = await runBackup();
  assert.match(r.key, /^backups\/rapax\/rapax-.*\.db\.gz$/);
  const raw = zlib.gunzipSync(store.get(r.key));
  assert.equal(raw.subarray(0, 15).toString(), 'SQLite format 3');
  const out = path.join(tmp, 'restored.db'); fs.writeFileSync(out, raw);
  const { default: Database } = await import('better-sqlite3');
  const rdb = new Database(out, { readonly: true });
  assert.equal(rdb.pragma('integrity_check', { simple: true }), 'ok');
  assert.equal(rdb.prepare('SELECT v FROM t').get().v, 'hello');
  rdb.close();

  for (let i = 0; i < 8; i++) { await new Promise(r => setTimeout(r, 5)); await runBackup(); }
  const list = await listBackups();
  assert.equal(list.length, 5, 'retention keeps newest BACKUP_KEEP');
  assert.ok(!fs.readdirSync(path.dirname(process.env.DB_PATH)).some(f => f.endsWith('.tmp')), 'no temp files left');
  closeDb();
});
