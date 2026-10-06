// ─────────────────────────────────────────────────────────────────
//  RaPaX™ — Central Configuration
// ─────────────────────────────────────────────────────────────────
import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../');

export const config = {
  server: {
    port: parseInt(process.env.PORT || '4000', 10),
    env: process.env.NODE_ENV || 'development',
  },

  db: {
    path: path.resolve(ROOT, process.env.DB_PATH || 'rapax.db'),
  },

  storage: {
    products:      path.resolve(ROOT, process.env.PRODUCTS_DIR      || 'storage/products'),
    fingerprinted: path.resolve(ROOT, process.env.FINGERPRINTED_DIR || 'storage/fingerprinted'),
    logs:          path.resolve(ROOT, process.env.LOGS_DIR          || 'logs'),
  },

  auth: {
    operatorSecret: process.env.OPERATOR_SECRET || 'rapax_operator_secret',
    jwtSecret:      process.env.JWT_SECRET      || 'rapax_jwt_secret',
    jwtExpiresIn:   process.env.JWT_EXPIRES_IN  || '24h',
  },

  delivery: {
    linkTtl: parseInt(process.env.DOWNLOAD_LINK_TTL || '3600', 10),
  },

  acerbe: {
    baseUrl: process.env.ACERBE_BASE_URL || 'http://localhost:5000',
    apiKey:  process.env.ACERBE_API_KEY  || '',
  },

  blockchain: {
    btc: {
      network:       process.env.BTC_NETWORK      || 'mainnet',
      provider:      process.env.BTC_API_PROVIDER || 'blockcypher',
      apiToken:      process.env.BTC_API_TOKEN    || '',
      xpub:          process.env.BTC_XPUB         || '',
      confirmations: 2,
    },
    eth: {
      rpcUrl:        process.env.ETH_RPC_URL || '',
      confirmations: parseInt(process.env.ETH_CONFIRMATIONS_REQUIRED || '2', 10),
    },
    sol: {
      rpcUrl:        process.env.SOL_RPC_URL || 'https://api.mainnet-beta.solana.com',
      confirmations: parseInt(process.env.SOL_CONFIRMATIONS_REQUIRED || '1', 10),
    },
    usdt: {
      contractAddress: process.env.USDT_CONTRACT_ADDRESS || '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    },
    xrp: {
      rpcUrl:        process.env.XRP_RPC_URL || 'https://s1.ripple.com:51234',
      confirmations: parseInt(process.env.XRP_CONFIRMATIONS_REQUIRED || '1', 10),
    },
    xlm: {
      horizonUrl:    process.env.XLM_HORIZON_URL || 'https://horizon.stellar.org',
      confirmations: parseInt(process.env.XLM_CONFIRMATIONS_REQUIRED || '1', 10),
    },
    ltc: {
      apiToken:      process.env.BLOCKCYPHER_API || '',
      confirmations: parseInt(process.env.LTC_CONFIRMATIONS_REQUIRED || '3', 10),
    },
  },

  wallets: {
    btc:  process.env.BTC_WALLET  || '',
    eth:  process.env.ETH_WALLET  || '',
    sol:  process.env.SOL_WALLET  || '',
    usdt: process.env.USDT_WALLET || '',
    xrp:  process.env.XRP_WALLET  || '',
    xlm:  process.env.XLM_WALLET  || '',
    ltc:  process.env.LTC_WALLET  || '',
  },

  fiat: {
    enabled:              process.env.FIAT_ENABLED === 'true',
    stripeSecretKey:      process.env.STRIPE_SECRET_KEY      || '',
    stripeWebhookSecret:  process.env.STRIPE_WEBHOOK_SECRET  || '',
  },
};
