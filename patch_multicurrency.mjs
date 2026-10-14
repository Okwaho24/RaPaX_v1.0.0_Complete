import fs from 'fs';

const file = 'src/services/paymentService.js';
let src = fs.readFileSync(file, 'utf8');

// 1. Expand SUPPORTED_CURRENCIES
src = src.replace(
  `export const SUPPORTED_CURRENCIES = ['BTC', 'ETH', 'SOL', 'USDT'];`,
  `export const SUPPORTED_CURRENCIES = ['BTC', 'ETH', 'SOL', 'USDT', 'XRP'];`
);

// 2. Replace AddressGenerator
const oldGen = `export const AddressGenerator = {

  /**
   * Generate a unique payment address for a given currency + transaction.
   * Replace each stub with real HD derivation in production.
   */
  generate(currency, transactionId) {
    const tag = transactionId.replace(/-/g, '').slice(0, 16);
    switch (currency.toUpperCase()) {
      case 'BTC':
        // Production: derive from xpub using BIP44/BIP84
        return \`bc1q\${tag}rapaxbtc\`;
      case 'ETH':
      case 'USDT':
        // Production: derive from ETH xpub / use separate address per tx
        return \`0x\${tag}rapaxeth\`.toLowerCase();
      case 'SOL':
        // Production: derive from Solana HD wallet
        return \`\${tag}RAPAXSOL\`;
      default:
        throw new Error(\`Unsupported currency: \${currency}\`);
    }
  },
};`;

const newGen = `export const AddressGenerator = {

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
    if (!addr) throw new Error(\`No wallet configured for currency: \${currency}\`);
    return addr;
  },
};`;

if (!src.includes(`generate(currency, transactionId)`)) {
  console.error('ERROR: AddressGenerator.generate pattern not found — check file');
  process.exit(1);
}
src = src.replace(oldGen, newGen);

// 3. Add XRP monitor after SOL monitor
const solMonitorEnd = `  async SOL(address, expectedAmount) {
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
};`;

const solPlusXRP = `  async SOL(address, expectedAmount) {
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
};`;

if (!src.includes(solMonitorEnd)) {
  console.error('ERROR: SOL monitor closing pattern not found');
  process.exit(1);
}
src = src.replace(solMonitorEnd, solPlusXRP);

// 4. Expand REQUIRED_CONFIRMATIONS
src = src.replace(
  `const REQUIRED_CONFIRMATIONS = {
  BTC:  config.blockchain.btc.confirmations,
  ETH:  config.blockchain.eth.confirmations,
  SOL:  config.blockchain.sol.confirmations,
  USDT: config.blockchain.eth.confirmations,
};`,
  `const REQUIRED_CONFIRMATIONS = {
  BTC:  config.blockchain.btc.confirmations,
  ETH:  config.blockchain.eth.confirmations,
  SOL:  config.blockchain.sol.confirmations,
  USDT: config.blockchain.eth.confirmations,
  XRP:  config.blockchain.xrp.confirmations,
};`
);

fs.writeFileSync(file, src, 'utf8');
console.log('✓ paymentService.js — BTC/ETH/SOL/USDT/XRP patched');
