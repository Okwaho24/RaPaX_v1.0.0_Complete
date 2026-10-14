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

// ── Supported currencies ──────────────────────────────────────────
export const SUPPORTED_CURRENCIES = ['BTC', 'ETH', 'SOL', 'USDT', 'XRP'];

// ── Address Generator ─────────────────────────────────────────────
// In production: derive from HD wallet (xpub for BTC/ETH, keypair for SOL)
// Here we generate deterministic mock addresses tagged with the transaction
// so the blockchain monitor can correlate payments.

export const AddressGenerator = {

  // Returns operator's static wallet address for the currency.
  // Poller checks balance on this address to detect payment.
  // TODO: upgrade to HD-derivation (unique address per tx) post-launch.
  generate(currency, _transactionId) {
    const wallets = {
      BTC:  config.wallets.btc,
      ETH:  config.wallets.eth,
      SOL:  config.wallets.sol,
      USDT: config.wallets.eth,  // ERC-20 USDT shares the ETH address
      XRP:  config.wallets.xrp,
    };
    const addr = wallets[currency.toUpperCase()];
    if (!addr) throw new Error(`No wallet configured for currency: ${currency}`);
    return addr;
  },
};

// ── Blockchain Monitors ───────────────────────────────────────────
// Each monitor exposes checkPayment(address, expectedAmount) → { received, confirmations, txHash }

export const BlockchainMonitor = {

  async BTC(address, expectedAmount) {
    // Production: BlockCypher API or own Bitcoin node RPC
    try {
      const url = `https://api.blockcypher.com/v1/btc/${config.blockchain.btc.network}/addrs/${address}/balance`;
      const params = config.blockchain.btc.apiToken
        ? { token: config.blockchain.btc.apiToken }
        : {};
      const { data } = await axios.get(url, { params, timeout: 10000 });
      return {
        received:      (data.final_balance || 0) / 1e8,
        confirmations: data.n_tx > 0 ? 3 : 0,
        txHash:        null, // enriched via address full endpoint in production
      };
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

  async SOL(address, expectedAmount) {
    // Production: Solana JSON-RPC getBalance or getConfirmedSignaturesForAddress2
    try {
      const { data } = await axios.post(config.blockchain.sol.rpcUrl, {
        jsonrpc: '2.0', id: 1,
        method:  'getBalance',
        params:  [address],
      }, { timeout: 10000 });
      const received = (data.result?.value || 0) / 1e9; // lamports → SOL
      return { received, confirmations: received >= expectedAmount ? 2 : 0, txHash: null };
    } catch (err) {
      console.error('[RaPaX™][SOL Monitor]', err.message);
      return { received: 0, confirmations: 0, txHash: null };
    }
  },

  async XRP(address, expectedAmount) {
    // Ripple public JSON-RPC — account_info returns balance in drops (1 XRP = 1,000,000 drops)
    try {
      const { data } = await axios.post(config.blockchain.xrp.rpcUrl, {
        method: 'account_info',
        params: [{ account: address, ledger_index: 'current' }],
      }, { timeout: 10000 });
      const drops    = data.result?.account_data?.Balance || '0';
      const received = parseInt(drops, 10) / 1e6;
      return { received, confirmations: received >= expectedAmount ? 2 : 0, txHash: null };
    } catch (err) {
      console.error('[RaPaX™][XRP Monitor]', err.message);
      return { received: 0, confirmations: 0, txHash: null };
    }
  },
};

// ── Required confirmations per currency ───────────────────────────
const REQUIRED_CONFIRMATIONS = {
  BTC:  config.blockchain.btc.confirmations,
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
    if (!SUPPORTED_CURRENCIES.includes(currency.toUpperCase())) {
      throw new Error(`Unsupported currency: ${currency}`);
    }

    const cur = currency.toUpperCase();
    const priceKey = `price_${cur.toLowerCase()}`;
    const amount   = product[priceKey];

    if (!amount) throw new Error(`No ${cur} price set for this product`);

    // 1. Create transaction record
    const tx = TransactionModel.create({
      product_id:      product.product_id,
      buyer_wallet:    buyerWallet,
      currency:        cur,
      amount_expected: amount,
      product_version: product.version,
    });

    // 2. Generate unique payment address
    const address = AddressGenerator.generate(cur, tx.transaction_id);

    const paymentAddr = PaymentAddressModel.create({
      transaction_id:  tx.transaction_id,
      currency:        cur,
      address,
      expected_amount: amount,
    });

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

    const addrRecord = PaymentAddressModel.findByTransactionId(transactionId);
    if (!addrRecord) return;

    const monitor = BlockchainMonitor[tx.currency];
    if (!monitor) return;

    const { received, confirmations, txHash } = await monitor(addrRecord.address, tx.amount_expected);

    if (received < tx.amount_expected) return; // not paid yet

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
