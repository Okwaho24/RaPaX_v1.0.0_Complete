import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import express from 'express';
import axios from 'axios';

process.env.FIAT_ENABLED = 'true';
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_testsecret';
process.env.PUBLIC_BASE_URL = 'https://shop.example';
process.env.ENABLED_CURRENCIES = 'USD,CAD,XRP,BTC,SOL';
process.env.SOL_WALLET = 'vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg';
process.env.XRP_WALLET = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';
process.env.BTC_XPUB = 'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';

const { initDb, getDb } = await import('../src/utils/initDb.js');
const { ProductModel } = await import('../src/models/productModel.js');
const { TransactionModel } = await import('../src/models/transactionModel.js');
const { PaymentService, ENABLED_CURRENCIES, _resetSolCacheForTests } = await import('../src/services/paymentService.js');
const { _setFetchForTests } = await import('../src/services/stripeService.js');
const { stripeWebhookHandler } = await import('../src/routes/webhooks.js');
await initDb();

const W = process.env.SOL_WALLET;
const product = ProductModel.create({ name: 'Multi', file_path: 'x/none.bin', price_fiat: 49, price_cad: 65, price_sol: 0.5, price_xrp: 20, price_btc: 0.001 });

// ── Solana RPC mock ──
let chain = [];   // [{sig, lamports, blockTime, err}]
axios.post = async (_url, body) => {
  if (body.method === 'getSignaturesForAddress') return { data: { result: chain.map(c => ({ signature: c.sig, err: c.err || null, blockTime: c.blockTime })) } };
  if (body.method === 'getTransaction') {
    const c = chain.find(x => x.sig === body.params[0]);
    return { data: { result: { blockTime: c.blockTime, meta: { err: c.err || null, preBalances: [5e9, 1e9], postBalances: [5e9 - c.lamports, 1e9 + c.lamports] },
      transaction: { message: { accountKeys: [{ pubkey: 'SenderSenderSenderSenderSenderSender1111' }, { pubkey: W }] } } } } };
  }
  throw new Error('unexpected rpc ' + body.method);
};
const now = () => Math.floor(Date.now() / 1000);
let n = 0;
const pay = (lamports, over = {}) => { chain.push({ sig: 'sig' + (++n), lamports, blockTime: now(), ...over }); _resetSolCacheForTests(); };

test('all five rails enabled', () => assert.deepEqual(ENABLED_CURRENCIES, ['USD', 'CAD', 'XRP', 'BTC', 'SOL']));

test('SOL: concurrent same-price orders get distinct exact amounts within 0.0001 SOL', async () => {
  const a = await PaymentService.initiatePurchase({ product, currency: 'SOL' });
  const b = await PaymentService.initiatePurchase({ product, currency: 'SOL' });
  const la = Math.round(a.transaction.amount_expected * 1e9), lb = Math.round(b.transaction.amount_expected * 1e9);
  assert.notEqual(la, lb);
  for (const l of [la, lb]) assert.ok(l > 5e8 && l <= 5e8 + 99999 + 1);
  assert.match(a.paymentAddress.address, new RegExp('^' + W + '\\?o='));
});

test('SOL: exact payment confirms only its own order; wrong/old/failed transfers ignored', async () => {
  chain = [];
  const a = await PaymentService.initiatePurchase({ product, currency: 'SOL' });
  const b = await PaymentService.initiatePurchase({ product, currency: 'SOL' });
  const la = Math.round(a.transaction.amount_expected * 1e9);
  pay(la + 1);                                             // wrong amount
  pay(la, { blockTime: now() - 7200 });                    // predates the order
  pay(la, { err: { InstructionError: [0, 'x'] } });        // failed tx
  assert.equal(await PaymentService.pollTransaction(a.transaction.transaction_id), undefined);
  pay(la);                                                 // correct
  assert.equal(await PaymentService.pollTransaction(a.transaction.transaction_id), 'confirmed');
  assert.equal(await PaymentService.pollTransaction(b.transaction.transaction_id), undefined);
  assert.ok(TransactionModel.findById(a.transaction.transaction_id).tx_hash.startsWith('sig'));
});

// ── CAD via webhook ──
let calls = [];
_setFetchForTests(async (url, opts) => { calls.push(opts); return { ok: true, status: 200, json: async () => ({ id: 'cs_cad_' + calls.length, url: 'https://checkout.stripe.com/c/pay/x', expires_at: now() + 1900 }) }; });
let runs = [];
const app = express();
app.post('/hook', express.raw({ type: 'application/json' }), stripeWebhookHandler({ runPipeline: async id => { runs.push(id); TransactionModel.updateStatus(id, 'complete'); } }));
const server = http.createServer(app); await new Promise(r => server.listen(0, r));
test.after(() => server.close());
const send = async obj => {
  const body = JSON.stringify({ type: 'checkout.session.completed', data: { object: obj } }); const t = now();
  const sig = `t=${t},v1=${crypto.createHmac('sha256', 'whsec_testsecret').update(`${t}.${body}`).digest('hex')}`;
  const r = await fetch(`http://127.0.0.1:${server.address().port}/hook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': sig }, body });
  return (await r.json()).result;
};

test('CAD: session is created in cad at the CAD price; only a cad payment confirms it', async () => {
  calls = []; runs = [];
  const o = await PaymentService.initiatePurchase({ product, currency: 'CAD' });
  const id = o.transaction.transaction_id;
  const b = new URLSearchParams(calls[0].body);
  assert.equal(b.get('line_items[0][price_data][currency]'), 'cad');
  assert.equal(b.get('line_items[0][price_data][unit_amount]'), '6500');
  const base = { id: 'cs_cad_1', client_reference_id: id, payment_status: 'paid', amount_total: 6500 };
  assert.equal(await send({ ...base, currency: 'usd' }), 'mismatch');       // wrong currency
  assert.equal(await send({ ...base, currency: 'cad', amount_total: 4900 }), 'mismatch');
  assert.deepEqual(runs, []);
  assert.equal(await send({ ...base, currency: 'cad' }), 'confirmed');
  await new Promise(r => setTimeout(r, 50));
  assert.deepEqual(runs, [id]);
});

test('product without a CAD price cannot be bought in CAD', async () => {
  const p2 = ProductModel.create({ name: 'USDonly', file_path: 'x/y', price_fiat: 10 });
  await assert.rejects(PaymentService.initiatePurchase({ product: p2, currency: 'CAD' }), /No CAD price/);
});

test('unpaid orders expire (card 2h, crypto 24h)', async () => {
  const x = await PaymentService.initiatePurchase({ product, currency: 'XRP' });
  const c = await PaymentService.initiatePurchase({ product, currency: 'CAD' });
  const old = h => new Date(Date.now() - h * 3600e3).toISOString();
  getDb().prepare('UPDATE transactions SET created_at=? WHERE transaction_id=?').run([old(25), x.transaction.transaction_id]);
  getDb().prepare('UPDATE transactions SET created_at=? WHERE transaction_id=?').run([old(3), c.transaction.transaction_id]);
  await PaymentService.pollTransaction(x.transaction.transaction_id);
  await PaymentService.pollTransaction(c.transaction.transaction_id);
  assert.equal(TransactionModel.findById(x.transaction.transaction_id).status, 'expired');
  assert.equal(TransactionModel.findById(c.transaction.transaction_id).status, 'expired');
});
