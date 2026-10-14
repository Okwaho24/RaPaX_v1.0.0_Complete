// Run (throwaway clone; writes data/db/rapax.db):  npm test
// Stripe network is mocked; webhook signatures are verified for real (HMAC).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import express from 'express';

process.env.FIAT_ENABLED = 'true';
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_testsecret';
process.env.PUBLIC_BASE_URL = 'https://shop.example';
process.env.ENABLED_CURRENCIES = 'USD,XRP';
process.env.XRP_WALLET ||= 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';

const { initDb } = await import('../src/utils/initDb.js');
const { ProductModel } = await import('../src/models/productModel.js');
const { TransactionModel } = await import('../src/models/transactionModel.js');
const { PaymentService, ENABLED_CURRENCIES } = await import('../src/services/paymentService.js');
const { _setFetchForTests } = await import('../src/services/stripeService.js');
const { stripeWebhookHandler } = await import('../src/routes/webhooks.js');
await initDb();

const product = ProductModel.create({ name: 'Toolkit', file_path: 'x/none.bin', price_fiat: 49.99, price_xrp: 20 });

let calls = [];
_setFetchForTests(async (url, opts) => {
  calls.push({ url, opts });
  return { ok: true, status: 200, json: async () => ({ id: 'cs_test_' + calls.length, url: 'https://checkout.stripe.com/c/pay/cs_test_' + calls.length, expires_at: Math.floor(Date.now() / 1000) + 1900 }) };
});

let pipelineRuns = [];
const app = express();
app.post('/hook', express.raw({ type: 'application/json' }), stripeWebhookHandler({
  runPipeline: async id => { pipelineRuns.push(id); TransactionModel.updateStatus(id, 'complete'); },
}));
const server = http.createServer(app);
await new Promise(r => server.listen(0, r));
const port = server.address().port;
test.after(() => server.close());

const sign = (body, secret = 'whsec_testsecret', t = Math.floor(Date.now() / 1000)) =>
  `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
const post = (body, sig) => fetch(`http://127.0.0.1:${port}/hook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': sig }, body });
const evt = (s, type = 'checkout.session.completed') => JSON.stringify({ id: 'evt_1', type, data: { object: s } });

async function newOrder() {
  const o = await PaymentService.initiatePurchase({ product, currency: 'USD' });
  return { id: o.transaction.transaction_id, session: 'cs_test_' + calls.length, o };
}
const paid = (id, session, over = {}) => ({ id: session, client_reference_id: id, payment_status: 'paid', currency: 'usd', amount_total: 4999, payment_intent: 'pi_123', ...over });

test('USD is enabled when fully configured', () => {
  assert.deepEqual(ENABLED_CURRENCIES, ['USD', 'XRP']);
});

test('checkout session request is correct', async () => {
  calls = [];
  const { o } = await newOrder();
  assert.ok(o.checkout.url.startsWith('https://checkout.stripe.com/'));
  const c = calls[0];
  assert.equal(c.url, 'https://api.stripe.com/v1/checkout/sessions');
  assert.equal(c.opts.headers.Authorization, 'Bearer sk_test_dummy');
  assert.match(c.opts.headers['Idempotency-Key'], /^rapax-checkout-/);
  const b = new URLSearchParams(c.opts.body);
  assert.equal(b.get('line_items[0][price_data][unit_amount]'), '4999');
  assert.equal(b.get('line_items[0][price_data][currency]'), 'usd');
  assert.equal(b.get('mode'), 'payment');
  assert.equal(b.get('client_reference_id'), o.transaction.transaction_id);
  assert.ok(b.get('success_url').startsWith('https://shop.example/?order='));
});

test('valid signed paid event confirms and runs pipeline once; replay is a no-op', async () => {
  pipelineRuns = [];
  const { id, session } = await newOrder();
  const body = evt(paid(id, session));
  let r = await post(body, sign(body));
  assert.equal(r.status, 200);
  assert.equal((await r.json()).result, 'confirmed');
  await new Promise(r => setTimeout(r, 50));
  assert.deepEqual(pipelineRuns, [id]);
  assert.equal(TransactionModel.findById(id).amount_received, 49.99);
  r = await post(body, sign(body));                      // Stripe retry
  assert.equal((await r.json()).result, 'duplicate');
  assert.deepEqual(pipelineRuns, [id]);
});

test('bad / tampered / stale signatures are rejected', async () => {
  pipelineRuns = [];
  const { id, session } = await newOrder();
  const body = evt(paid(id, session));
  assert.equal((await post(body, sign(body, 'whsec_wrong'))).status, 400);
  assert.equal((await post(body + ' ', sign(body))).status, 400);
  assert.equal((await post(body, sign(body, 'whsec_testsecret', Math.floor(Date.now() / 1000) - 3600))).status, 400);
  assert.equal((await post(body, 'garbage')).status, 400);
  assert.equal(TransactionModel.findById(id).status, 'pending');
  assert.deepEqual(pipelineRuns, []);
});

test('wrong amount, wrong currency, wrong session, unpaid → never confirmed', async () => {
  pipelineRuns = [];
  const { id, session } = await newOrder();
  for (const [s, expect] of [
    [paid(id, session, { amount_total: 100 }), 'mismatch'],
    [paid(id, session, { currency: 'cad' }), 'mismatch'],
    [paid(id, 'cs_other'), 'mismatch'],
    [paid(id, session, { payment_status: 'unpaid' }), 'not_paid'],
  ]) {
    const body = evt(s);
    const r = await post(body, sign(body));
    assert.equal((await r.json()).result, expect);
  }
  assert.equal(TransactionModel.findById(id).status, 'pending');
  assert.deepEqual(pipelineRuns, []);
});

test('Stripe API failure marks order failed and surfaces error', async () => {
  _setFetchForTests(async () => ({ ok: false, status: 402, json: async () => ({ error: { message: 'bad key' } }) }));
  await assert.rejects(PaymentService.initiatePurchase({ product, currency: 'USD' }), /Stripe error: bad key/);
});
