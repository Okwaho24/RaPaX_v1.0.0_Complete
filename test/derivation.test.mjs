// Run: node --test test/derivation.test.mjs
// Vectors: BIP-84 spec (mnemonic "abandon ×11 about", account 0, external chain)
import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveBtcAddress, parseAccountKey } from '../src/services/addressDerivation.js';

const ZPUB = 'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';

test('BIP84 vector index 0', () => {
  assert.equal(deriveBtcAddress(ZPUB, 0), 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
});
test('BIP84 vector index 1', () => {
  assert.equal(deriveBtcAddress(ZPUB, 1), 'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g');
});
test('addresses are unique across 500 indices', () => {
  const s = new Set();
  for (let i = 0; i < 500; i++) s.add(deriveBtcAddress(ZPUB, i));
  assert.equal(s.size, 500);
});
test('private keys are refused', () => {
  assert.throws(() => parseAccountKey('zprv' + 'A'.repeat(107)), /REFUSING PRIVATE KEY/);
});
test('garbage and bad index rejected', () => {
  assert.throws(() => deriveBtcAddress('nope', 0));
  assert.throws(() => deriveBtcAddress(ZPUB, -1));
  assert.throws(() => deriveBtcAddress(ZPUB, 1.5));
});
