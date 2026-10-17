// Drives the full flow over HTTP against running RaPaX + LexForge + AcerbE. See run_e2e.sh. Exits non-zero on any failed expectation.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
const [phase, ...args] = process.argv.slice(2);
const E = process.env;
const R = E.RAPAX_URL;
const j = async (p, o = {}) => { const r = await fetch(R + p, o); let b = null; try { b = await r.json(); } catch {} return { s: r.status, b, r }; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitStatus(id, want, ms = 90000) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < ms) { last = (await j(`/api/purchase/status/${id}`)).b; if (want.includes(last?.status)) return last; await sleep(500); }
  throw new Error(`timeout waiting for ${want}, last=${JSON.stringify(last)}`);
}
const login = async () => (await j('/api/operator/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret: E.OPERATOR_SECRET }) })).b.token;
const auth = t => ({ authorization: `Bearer ${t}`, 'content-type': 'application/json' });
const order = (pid, extra = {}) => j('/api/purchase/initiate', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ product_id: pid, currency: 'BTC', wallet_address: 'bc1qe2ebuyer0000000000000000000000000000', jurisdiction: 'US', ...extra }) });

if (phase === 'setup') {
  const t = await login();
  const fd = new FormData();
  fd.append('name', 'E2E Test Product'); fd.append('price_btc', '0.001'); fd.append('version', '1.2.3');
  fd.append('file', new Blob([readFileSync(args[0])]), 'e2e_product.zip');
  const r = await j('/api/operator/products', { method: 'POST', headers: { authorization: `Bearer ${t}` }, body: fd });
  assert.equal(r.s, 201, JSON.stringify(r.b));
  writeFileSync(args[1], r.b.product.product_id);
  console.log('PASS setup: product uploaded to storage', r.b.product.product_id);
}

if (phase === 'refusals') {
  const pid = readFileSync(args[0], 'utf8');
  let r = await order(pid, { jurisdiction: 'JP' });
  assert.equal(r.s, 422, JSON.stringify(r.b)); assert.equal(r.b.code, 'jurisdiction_unsupported');
  r = await j('/api/purchase/initiate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ product_id: pid, currency: 'BTC' }) });
  assert.equal(r.s, 400); assert.equal(r.b.code, 'jurisdiction_required');
  console.log('PASS refusals: unsupported country and missing country rejected before any payment address is issued');
}

if (phase === 'unverified') {
  const r = await order(readFileSync(args[0], 'utf8'));
  assert.equal(r.s, 422, JSON.stringify(r.b)); assert.equal(r.b.code, 'content_not_verified');
  console.log('PASS unverified: with no human review sign-off the sale is refused before payment');
}

if (phase === 'sale') {
  const [pidFile, outZip, txFile] = args;
  const r = await order(readFileSync(pidFile, 'utf8'));
  assert.equal(r.s, 201, JSON.stringify(r.b));
  const txid = r.b.transaction_id; writeFileSync(txFile, txid);
  const t = await login();
  const c = await j('/api/internal/payment/confirm', { method: 'POST', headers: auth(t), body: JSON.stringify({ transaction_id: txid, tx_hash: 'e2e-' + txid, amount_received: r.b.amount_expected }) });
  assert.equal(c.s, 200, JSON.stringify(c.b));
  const st = await waitStatus(txid, ['delivering', 'complete', 'held']);
  if (E.EXPECT === 'held') {
    assert.equal(st.status, 'held'); assert.equal(st.download_link ?? null, null);
    console.log('PASS held: AcerbE down -> order parked, no download issued');
  } else {
    assert.ok(st.download_link, JSON.stringify(st));
    const token = st.download_link.split('/').pop();
    const d = await fetch(`${R}/api/download/${token}`, { redirect: 'manual' });
    assert.equal(d.status, 302);
    const z = await fetch(d.headers.get('location'));
    assert.equal(z.status, 200);
    writeFileSync(outZip, Buffer.from(await z.arrayBuffer()));
    console.log('PASS sale: paid -> docs -> stamped package -> storage -> token -> download', txid);
  }
}

if (phase === 'release') {
  const t = await login(); const txid = readFileSync(args[0], 'utf8');
  const held = (await j('/api/internal/held', { headers: auth(t) })).b.held.map(x => x.transaction_id);
  assert.ok(held.includes(txid), 'order should be listed as held');
  const r = await j('/api/internal/pipeline/release', { method: 'POST', headers: auth(t), body: JSON.stringify({ transaction_id: txid }) });
  assert.equal(r.s, 200, JSON.stringify(r.b));
  const st = await waitStatus(txid, ['delivering', 'complete']);
  assert.ok(st.download_link);
  console.log('PASS release: operator released held order after AcerbE recovered; delivery issued');
}
