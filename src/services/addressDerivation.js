// ─────────────────────────────────────────────────────────────────
//  RaPaX™ — Address Derivation (BIP84 native segwit, bc1q…)
//  Derives per-purchase receive addresses from an ACCOUNT-LEVEL
//  extended PUBLIC key (zpub/xpub). The server never holds a private
//  key or seed. Path used: <account xpub> / 0 / <index>
// ─────────────────────────────────────────────────────────────────
import { HDKey } from '@scure/bip32';
import * as btc from '@scure/btc-signer';

// SLIP-132 version bytes (public only)
const VERSIONS = {
  xpub: { private: 0x0488ade4, public: 0x0488b21e },
  zpub: { private: 0x04b2430c, public: 0x04b24746 },
};

const NETWORKS = { main: btc.NETWORK, test3: btc.TEST_NETWORK };

export function parseAccountKey(extendedKey) {
  if (typeof extendedKey !== 'string' || extendedKey.length < 100) {
    throw new Error('BTC_XPUB is missing or malformed');
  }
  const key = extendedKey.trim();
  const prefix = key.slice(0, 4);
  if (key.startsWith('xprv') || key.startsWith('zprv') || key.startsWith('tprv')) {
    throw new Error('REFUSING PRIVATE KEY: BTC_XPUB must be a PUBLIC key (xpub/zpub). Rotate that key now.');
  }
  const versions = VERSIONS[prefix];
  if (!versions) throw new Error(`Unsupported key prefix "${prefix}". Use zpub (BIP84) or xpub.`);
  const hd = HDKey.fromExtendedKey(key, versions);
  if (hd.privateKey) throw new Error('BTC_XPUB contains private material');
  return hd;
}

export function deriveBtcAddress(extendedKey, index, network = 'main') {
  if (!Number.isInteger(index) || index < 0 || index >= 0x80000000) {
    throw new Error('Invalid derivation index');
  }
  const net = NETWORKS[network];
  if (!net) throw new Error(`Unsupported BTC network "${network}" (use main or test3)`);
  const child = parseAccountKey(extendedKey).deriveChild(0).deriveChild(index);
  return btc.p2wpkh(child.publicKey, net).address;
}
