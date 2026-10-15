// ─────────────────────────────────────────────────────────────────
//  RaPaX™ — Payment Service
//  Handles: address generation, blockchain monitoring,
//           payment confirmation, FIAT stub (inactive)
// ─────────────────────────────────────────────────────────────────
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';
import { config } from '../config/index.js';
import { PaymentAddressModel } from '../models/paymentAddressModel.js';
import { TransactionModel, TxStatus } from '../models/transactionModel.js';
import { auditLog, EventType } from '../utils/auditLogger.js';
import { getDb } from '../utils/initDb.js';
import { deriveBtcAddress } from './addressDerivation.js';
import { createCheckoutSession, fiatReady } from './stripeService.js';

// ── Supported currencies ──────────────────────────────────────────
export const SUPPORTED_CURRENCIES = ['USD', 'CAD', 'BTC', 'ETH', 'SOL', 'USDT', 'XRP'];

// Only currencies with per-purchase attribution are enabled for sale.
// ETH/USDT/SOL still use a shared static address, which cannot attribute
// payments to a buyer, so they stay OFF until upgraded.
const REQUESTED = (process.env.ENABLED_CURRENCIES || 'USD,CAD,XRP,BTC,SOL')
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
const READY = {
  USD: fiatReady(),
  CAD: fiatReady(),
  SOL: Boolean(config.wallets.sol),
  XRP: Boolean(config.wallets.xrp),
  BTC: Boolean(config.blockchain.btc.xpub),
};
// Only advertise rails that are fully configured. A misconfigured rail is dropped
// (and logged) instead of crashing the whole store.
export const ENABLED_CURRENCIES = REQUESTED.filter(c => {
  if (!(c in READY)) throw new Error(`${c} cannot be enabled: no per-purchase attribution implemented`);
  if (!READY[c]) { console.error(`[RaPaX™] ${c} requested but not configured — disabled`); return false; }
  return true;
});

// Smallest-unit conversion (avoid float comparison of money)
const SATS  = x => Math.round(Number(x) * 1e8);
const DROPS = x => Math.round(Number(x) * 1e6);

// BTC_NETWORK may be 'mainnet' (repo default), 'main', 'testnet' or 'test3'.
// BlockCypher only accepts 'main' / 'test3'.
const BTC_NET = ['test3', 'testnet'].includes(String(config.blockchain.btc.network).toLowerCase()) ? 'test3' : 'main';

// Destination tags for XRP start here; stored in payment_addresses.derivation_idx
const XRP_TAG_BASE = 100000;

// SOL: every open order gets a unique lamport-exact total (price + 1..99,999 lamports,
// at most 0.0001 SOL). The monitor matches the exact amount, so concurrent orders can't collide.
function uniqueSolAmount(price) {
  const base = Math.round(Number(price) * 1e9);
  const used = new Set(getDb().prepare(
    `SELECT amount_expected FROM transactions WHERE currency='SOL' AND status IN ('pending','confirming')`
  ).all([]).map(r => Math.round(r.amount_expected * 1e9)));
  for (let i = 0; i < 100; i++) {
    const total = base + 1 + crypto.randomInt(0, 99999);
    if (!used.has(total)) return total / 1e9;
  }
  throw new Error('Too many open SOL orders — try again shortly');
}

// ── Address Generator ─────────────────────────────────────────────
// In production: derive from HD wallet (xpub for BTC/ETH, keypair for SOL)
// Here we generate deterministic mock addresses tagged with the transaction
// so the blockchain monitor can correlate payments.

export const AddressGenerator = {

  // Returns { address, derivation_idx, destination_tag }.
  //  BTC: unique BIP84 address per purchase from BTC_XPUB (public key only).
  //  XRP: shared operator account + unique destination tag. The stored
  //       "address" is "<account>?dt=<tag>" so the UNIQUE constraint holds.
  generate(currency, _transactionId) {
    const cur = currency.toUpperCase();
    const db  = getDb();
    if (cur === 'BTC') {
      const xpub = config.blockchain.btc.xpub;
      if (!xpub) throw new Error('BTC_XPUB is not configured');
      const row = db.prepare(
        `SELECT COALESCE(MAX(derivation_idx), -1) AS m FROM payment_addresses WHERE currency='BTC'`
      ).get([]);
      const idx = (row?.m ?? -1) + 1;
      const address = deriveBtcAddress(xpub, idx, BTC_NET);
      return { address, derivation_idx: idx, destination_tag: null };
    }
    if (cur === 'XRP') {
      const acct = config.wallets.xrp;
      if (!acct) throw new Error('XRP_WALLET is not configured');
      const row = db.prepare(
        `SELECT COALESCE(MAX(derivation_idx), ${XRP_TAG_BASE - 1}) AS m FROM payment_addresses WHERE currency='XRP'`
      ).get([]);
      const tag = Math.max(row?.m ?? XRP_TAG_BASE - 1, XRP_TAG_BASE - 1) + 1;
      return { address: `${acct}?dt=${tag}`, derivation_idx: tag, destination_tag: tag };
    }
    if (cur === 'SOL') {
      // Shared operator wallet. Attribution = unique lamport-exact amount (see uniqueSolAmount).
      const w = config.wallets.sol;
      if (!w) throw new Error('SOL_WALLET is not configured');
      return { address: `${w}?o=${_transactionId}`, derivation_idx: null, destination_tag: null };
    }
    throw new Error(`Currency ${cur} is not enabled for sale`);
  },
};

// ── Blockchain Monitors ───────────────────────────────────────────
// Each monitor exposes checkPayment(address, expectedAmount) → { received, confirmations, txHash }

const solTxCache = new Map();
let solList = { wallet: null, at: 0, items: [] };
async function solRpc(method, params) {
  const { data } = await axios.post(config.blockchain.sol.rpcUrl, { jsonrpc: '2.0', id: 1, method, params }, { timeout: 15000 });
  if (data.error) throw new Error(data.error.message || 'RPC error');
  return data.result;
}
async function solIncoming(wallet) {
  if (solList.wallet === wallet && Date.now() - solList.at < 15000) return solList.items;
  const sigs = await solRpc('getSignaturesForAddress', [wallet, { limit: 50, commitment: 'finalized' }]);
  const items = [];
  for (const s of sigs || []) {
    if (s.err) continue;
    let t = solTxCache.get(s.signature);
    if (!t) {
      const r = await solRpc('getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'finalized' }]);
      if (!r || r.meta?.err) continue;
      const keys = r.transaction.message.accountKeys.map(k => k.pubkey || k);
      const i = keys.indexOf(wallet);
      if (i < 0) continue;
      t = { sig: s.signature, lamports: r.meta.postBalances[i] - r.meta.preBalances[i], blockTime: r.blockTime || s.blockTime || 0 };
      solTxCache.set(s.signature, t);
      if (solTxCache.size > 2000) solTxCache.delete(solTxCache.keys().next().value);
    }
    if (t.lamports > 0) items.push(t);
  }
  solList = { wallet, at: Date.now(), items };
  return items;
}

export function _resetSolCacheForTests() { solList = { wallet: null, at: 0, items: [] }; }

export const BlockchainMonitor = {

  async BTC(address, _expectedAmount) {
    // Unique address per purchase: every output paid to it belongs to this buyer.
    // confirmations = lowest confirmation count among counted outputs.
    try {
      const url = `https://api.blockcypher.com/v1/btc/${BTC_NET}/addrs/${address}`;
      const params = { limit: 50, ...(config.blockchain.btc.apiToken ? { token: config.blockchain.btc.apiToken } : {}) };
      const { data } = await axios.get(url, { params, timeout: 10000 });
      const refs = [...(data.txrefs || []), ...(data.unconfirmed_txrefs || [])]
        // tx_input_n === -1 → this ref is an OUTPUT paying the address
        .filter(r => r.tx_input_n === -1);
      if (!refs.length) return { received: 0, confirmations: 0, txHash: null };
      const sats = refs.reduce((n, r) => n + (r.value || 0), 0);
      const conf = Math.min(...refs.map(r => r.confirmations || 0));
      return { received: sats / 1e8, confirmations: conf, txHash: refs[0].tx_hash || null };
    } catch (err) {
      console.error('[RaPaX™][BTC Monitor]', err.message);
      return { received: 0, confirmations: 0, txHash: null };
    }
  },

  async ETH(address, expectedAmount) {
    // Production: Etherscan or Alchemy — check ETH balance
    try {
      const url = `https://api.etherscan.io/api?module=account&action=balance&address=${address}&tag=latest`;
      const { data } = await axios.get(url, { timeout: 10000 });
      const balanceWei = BigInt(data.result || '0');
      const received   = Number(balanceWei) / 1e18;
      return { received, confirmations: received >= expectedAmount ? 2 : 0, txHash: null };
    } catch (err) {
      console.error('[RaPaX™][ETH Monitor]', err.message);
      return { received: 0, confirmations: 0, txHash: null };
    }
  },

  async USDT(address, expectedAmount) {
    // Production: ERC-20 Transfer event listener via Alchemy/Infura WebSocket
    // or Etherscan token transfer API
    try {
      const url = `https://api.etherscan.io/api?module=account&action=tokentx&contractaddress=${config.blockchain.usdt.contractAddress}&address=${address}&tag=latest`;
      const { data } = await axios.get(url, { timeout: 10000 });
      if (data.result && Array.isArray(data.result) && data.result.length > 0) {
        const tx      = data.result[0];
        const received = parseInt(tx.value, 10) / 1e6; // USDT has 6 decimals
        return { received, confirmations: parseInt(tx.confirmations, 10) || 0, txHash: tx.hash };
      }
      return { received: 0, confirmations: 0, txHash: null };
    } catch (err) {
      console.error('[RaPaX™][USDT Monitor]', err.message);
      return { received: 0, confirmations: 0, txHash: null };
    }
  },

  async SOL(storedAddress, expectedAmount, tx) {
    // Incoming FINALIZED transfers to the operator wallet whose lamport amount equals the
    // order's unique expected amount exactly, and which landed after the order was created.
    try {
      const wallet = storedAddress.split('?')[0];
      const want   = Math.round(expectedAmount * 1e9);
      const since  = tx?.created_at ? Date.parse(tx.created_at) / 1000 - 120 : 0;
      const hit = (await solIncoming(wallet)).find(t => t.lamports === want && t.blockTime >= since);
      return hit
        ? { received: hit.lamports / 1e9, confirmations: 99, txHash: hit.sig }
        : { received: 0, confirmations: 0, txHash: null };
    } catch (err) {
      console.error('[RaPaX™][SOL Monitor]', err.message);
      return { received: 0, confirmations: 0, txHash: null };
    }
  },

  async XRP(storedAddress, _expectedAmount) {
    // storedAddress = "<account>?dt=<tag>". Sum VALIDATED, successful Payments
    // to <account> carrying exactly this destination tag (delivered_amount, XRP only).
    try {
      const m = /^(r[1-9A-HJ-NP-Za-km-z]{24,34})\?dt=(\d+)$/.exec(storedAddress);
      if (!m) throw new Error('malformed stored XRP address');
      const [, account, tagStr] = m;
      const tag = Number(tagStr);
      let drops = 0, hash = null, marker;
      for (let page = 0; page < 3; page++) {            // up to 600 recent txs
        const { data } = await axios.post(config.blockchain.xrp.rpcUrl, {
          method: 'account_tx',
          params: [{ account, ledger_index_min: -1, ledger_index_max: -1, limit: 200, forward: false, ...(marker ? { marker } : {}) }],
        }, { timeout: 15000 });
        const r = data.result;
        if (!r || r.status !== 'success') throw new Error(r?.error || 'account_tx failed');
        for (const t of r.transactions || []) {
          const tx = t.tx || t.tx_json || {};
          if (!t.validated) continue;
          if (tx.TransactionType !== 'Payment' || tx.Destination !== account) continue;
          if (tx.DestinationTag !== tag) continue;
          if (t.meta?.TransactionResult !== 'tesSUCCESS') continue;
          const d = t.meta?.delivered_amount ?? t.meta?.DeliveredAmount;
          if (typeof d !== 'string') continue;           // IOU / partial-unknown → ignore
          drops += parseInt(d, 10);
          hash = hash || t.hash || tx.hash || null;
        }
        marker = r.marker;
        if (!marker) break;
      }
      // validated ledger = final on XRPL
      return { received: drops / 1e6, confirmations: drops > 0 ? 99 : 0, txHash: hash };
    } catch (err) {
      console.error('[RaPaX™][XRP Monitor]', err.message);
      return { received: 0, confirmations: 0, txHash: null };
    }
  },
};

// ── Required confirmations per currency ───────────────────────────
const REQUIRED_CONFIRMATIONS = {
  BTC:  config.blockchain.btc.confirmations ?? 2,
  ETH:  config.blockchain.eth.confirmations,
  SOL:  config.blockchain.sol.confirmations,
  USDT: config.blockchain.eth.confirmations,
  XRP:  config.blockchain.xrp.confirmations,
};

// ── PaymentService (main interface) ──────────────────────────────

export const PaymentService = {

  /**
   * Initiate a purchase: create transaction + unique payment address.
   * Returns { transaction, paymentAddress } to show buyer.
   */
  async initiatePurchase({ product, currency, buyerWallet = null }) {
    if (!ENABLED_CURRENCIES.includes(currency.toUpperCase())) {
      throw new Error(`Currency not enabled: ${currency}`);
    }

    const cur = currency.toUpperCase();
    const priceKey = cur === 'USD' ? 'price_fiat' : `price_${cur.toLowerCase()}`;
    let amount     = product[priceKey];

    if (!amount) throw new Error(`No ${cur} price set for this product`);
    if (cur === 'SOL') amount = uniqueSolAmount(amount);

    // 1. Create transaction record
    const tx = TransactionModel.create({
      product_id:      product.product_id,
      buyer_wallet:    buyerWallet,
      currency:        cur,
      amount_expected: amount,
      product_version: product.version,
    });

    if (cur === 'USD' || cur === 'CAD') {
      try {
        const checkout = await createCheckoutSession({ transaction: tx, product, amount });
        auditLog({ eventType: EventType.PAYMENT, transactionId: tx.transaction_id, productId: product.product_id,
          actor: buyerWallet || 'anonymous', payload: { action: 'PURCHASE_INITIATED', currency: cur, amount, session: checkout.session_id } });
        return { transaction: tx, paymentAddress: null, checkout };
      } catch (err) {
        TransactionModel.updateStatus(tx.transaction_id, TxStatus.FAILED);
        throw err;
      }
    }

    // 2. Generate unique payment address
    const gen = AddressGenerator.generate(cur, tx.transaction_id);
    const address = gen.address;

    const paymentAddr = PaymentAddressModel.create({
      transaction_id:  tx.transaction_id,
      currency:        cur,
      address,
      expected_amount: amount,
      derivation_idx:  gen.derivation_idx,
    });
    paymentAddr.destination_tag = gen.destination_tag;

    // 3. Audit log
    auditLog({
      eventType:     EventType.PAYMENT,
      transactionId: tx.transaction_id,
      productId:     product.product_id,
      actor:         buyerWallet || 'anonymous',
      payload:       { action: 'PURCHASE_INITIATED', currency: cur, amount, address },
    });

    return { transaction: tx, paymentAddress: paymentAddr };
  },

  /**
   * Poll a single pending transaction against the blockchain.
   * Called by the cron job in paymentPoller.js
   */
  async pollTransaction(transactionId) {
    const tx   = TransactionModel.findById(transactionId);
    if (!tx) return;
    if (!['pending','confirming'].includes(tx.status)) return;

    // Unpaid orders expire: card sessions after 2h, crypto after 24h grace.
    const ttl = ['USD', 'CAD'].includes(tx.currency) ? 2 * 3600e3 : 24 * 3600e3;
    if (tx.status === 'pending' && Date.now() - Date.parse(tx.created_at) > ttl) {
      TransactionModel.updateStatus(transactionId, TxStatus.EXPIRED);
      return;
    }

    const addrRecord = PaymentAddressModel.findByTransactionId(transactionId);
    if (!addrRecord) return;

    const monitor = BlockchainMonitor[tx.currency];
    if (!monitor) return;

    const { received, confirmations, txHash } = await monitor(addrRecord.address, tx.amount_expected, tx);

    const unit = tx.currency === 'BTC' ? SATS : tx.currency === 'SOL' ? (x => Math.round(Number(x) * 1e9)) : DROPS;
    if (unit(received) < unit(tx.amount_expected)) return; // not paid yet (integer compare)

    const required = REQUIRED_CONFIRMATIONS[tx.currency] || 2;
    const newStatus = confirmations >= required ? TxStatus.CONFIRMED : TxStatus.CONFIRMING;

    TransactionModel.updateStatus(transactionId, newStatus, {
      amount_received: received,
      tx_hash:         txHash,
      confirmations,
    });

    auditLog({
      eventType:     EventType.PAYMENT,
      transactionId,
      productId:     tx.product_id,
      actor:         tx.buyer_wallet || 'anonymous',
      payload:       { action: 'PAYMENT_DETECTED', received, confirmations, newStatus, txHash },
    });

    return newStatus;
  },

  /**
   * Manually confirm a payment (internal endpoint / webhook).
   */
  async confirmPayment({ transactionId, txHash, amountReceived }) {
    const tx = TransactionModel.findById(transactionId);
    if (!tx) throw new Error('Transaction not found');

    TransactionModel.updateStatus(transactionId, TxStatus.CONFIRMED, {
      tx_hash:         txHash,
      amount_received: amountReceived ?? tx.amount_expected,
      confirmations:   99, // manually confirmed
    });

    auditLog({
      eventType:     EventType.PAYMENT,
      transactionId,
      productId:     tx.product_id,
      actor:         'system',
      payload:       { action: 'PAYMENT_MANUALLY_CONFIRMED', txHash, amountReceived },
    });

    return TransactionModel.findById(transactionId);
  },
};

// ── FIAT Module (Future — INACTIVE) ──────────────────────────────
export const FiatService = {
  isEnabled() { return config.fiat.enabled; },

  async initiate() {
    if (!this.isEnabled()) throw new Error('FIAT payments are not yet activated.');
    // TODO: integrate Stripe / merchant rails
  },
};
