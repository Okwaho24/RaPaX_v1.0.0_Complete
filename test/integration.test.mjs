// Run from repo root, in a THROWAWAY clone (it writes data/db/rapax.db):
//   BTC_XPUB=<zpub> XRP_WALLET=<r-address> node --test test/integration.test.mjs
// Network calls are mocked. Nothing touches real chains or Railway.
import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';

process.env.ENABLED_CURRENCIES ||= 'BTC,XRP';
process.env.FIAT_ENABLED = 'false';
process.env.BTC_XPUB ||= 'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';
process.env.XRP_WALLET ||= 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';

const { initDb } = await import('../src/utils/initDb.js');
const { ProductModel } = await import('../src/models/productModel.js');
const { PaymentService } = await import('../src/services/paymentService.js');
const { TransactionModel } = await import('../src/models/transactionModel.js');
await initDb();

const product = ProductModel.create({
  name: 'TEST', file_path: 'test/none.bin', price_btc: 0.001, price_xrp: 25,
});

// ── mock network ──
let btcReplies = {};   // address → BlockCypher body
let xrpTxs = [];       // account_tx transactions
axios.get = async (url) => {
  const addr = url.split('/addrs/')[1];
  return { data: btcReplies[addr] || { txrefs: [], unconfirmed_txrefs: [] } };
};
axios.post = async () => ({ data: { result: { status: 'success', transactions: xrpTxs } } });

test('two BTC buyers get different addresses; each paid only by own address', async () => {
  const a = await PaymentService.initiatePurchase({ product, currency: 'BTC' });
  const b = await PaymentService.initiatePurchase({ product, currency: 'BTC' });
  assert.notEqual(a.paymentAddress.address, b.paymentAddress.address);
  assert.match(a.paymentAddress.address, /^bc1q/);

  // buyer A pays in full, 3 confs. Buyer B has paid nothing.
  btcReplies[a.paymentAddress.address] = {
    txrefs: [{ tx_hash: 'aa', tx_input_n: -1, value: 100000, confirmations: 3 }],
  };
  assert.equal(await PaymentService.pollTransaction(a.transaction.transaction_id), 'confirmed');
  assert.equal(await PaymentService.pollTransaction(b.transaction.transaction_id), undefined);
  assert.equal(TransactionModel.findById(b.transaction.transaction_id).status, 'pending');
});

test('BTC underpayment and unconfirmed are not confirmed', async () => {
  const c = await PaymentService.initiatePurchase({ product, currency: 'BTC' });
  btcReplies[c.paymentAddress.address] = {
    txrefs: [{ tx_hash: 'cc', tx_input_n: -1, value: 99999, confirmations: 5 }],
  };
  assert.equal(await PaymentService.pollTransaction(c.transaction.transaction_id), undefined);
  btcReplies[c.paymentAddress.address] = {
    unconfirmed_txrefs: [{ tx_hash: 'cd', tx_input_n: -1, value: 100000, confirmations: 0 }],
  };
  assert.equal(await PaymentService.pollTransaction(c.transaction.transaction_id), 'confirming');
});

test('BTC spent-output refs (tx_output_n) are not counted as receipts', async () => {
  const d = await PaymentService.initiatePurchase({ product, currency: 'BTC' });
  btcReplies[d.paymentAddress.address] = {
    txrefs: [{ tx_hash: 'dd', tx_output_n: -1, tx_input_n: 0, value: 100000, confirmations: 9 }],
  };
  assert.equal(await PaymentService.pollTransaction(d.transaction.transaction_id), undefined);
});

test('XRP: unique tags; only matching tag + success + validated counts', async () => {
  const x = await PaymentService.initiatePurchase({ product, currency: 'XRP' });
  const y = await PaymentService.initiatePurchase({ product, currency: 'XRP' });
  const acct = process.env.XRP_WALLET;
  const tx = (tag, amt, over = {}) => ({
    validated: true, hash: 'H' + tag,
    tx: { TransactionType: 'Payment', Destination: acct, DestinationTag: tag },
    meta: { TransactionResult: 'tesSUCCESS', delivered_amount: String(amt * 1e6) }, ...over,
  });
  const tagX = x.paymentAddress.destination_tag, tagY = y.paymentAddress.destination_tag;
  assert.notEqual(tagX, tagY);
  xrpTxs = [
    tx(tagY, 25, { meta: { TransactionResult: 'tecPATH_DRY', delivered_amount: '25000000' } }), // failed
    tx(tagX, 25),                                      // good for X
    tx(tagY, 25, { validated: false }),                // not validated
    { validated: true, tx: { TransactionType: 'Payment', Destination: acct }, meta: { TransactionResult: 'tesSUCCESS', delivered_amount: '25000000' } }, // no tag
  ];
  assert.equal(await PaymentService.pollTransaction(x.transaction.transaction_id), 'confirmed');
  assert.equal(await PaymentService.pollTransaction(y.transaction.transaction_id), undefined);
});

test('ETH / USDT are refused', async () => {
  for (const c of ['ETH', 'USDT']) {
    await assert.rejects(PaymentService.initiatePurchase({ product, currency: c }), /not enabled/);
  }
});

test('public listing exposes price_xrp; migration is idempotent', async () => {
  assert.equal(ProductModel.listPublic().find(p => p.product_id === product.product_id).price_xrp, 25);
  await initDb(); // second run must not throw on duplicate column
});
