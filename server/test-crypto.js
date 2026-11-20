import assert from 'node:assert/strict';
import test from 'node:test';
import {
  encryptAtRest,
  decryptAtRest,
  encryptBufferAtRest,
  decryptBufferAtRest,
  hashAuthVerifier,
  verifyAuthVerifier,
} from './crypto-server.js';

test('server at-rest AES-256-GCM encrypts, decrypts, and enforces AAD', () => {
  const plaintext = '秘密云便签测试内容 CipherNote 🔐';
  const aad = 'rest:note:demo-slug';
  const encrypted = encryptAtRest(plaintext, aad);

  assert.ok(!encrypted.includes(plaintext), 'ciphertext must not contain plaintext');
  assert.equal(decryptAtRest(encrypted, aad), plaintext);

  // Wrong AAD must throw (prevents ciphertext transplant across slugs)
  assert.throws(() => decryptAtRest(encrypted, 'rest:note:other-slug'));

  // Tampered ciphertext must throw
  const parsed = JSON.parse(encrypted);
  parsed.data = Buffer.from('tampered').toString('base64');
  assert.throws(() => decryptAtRest(JSON.stringify(parsed), aad));
});

test('server buffer at-rest encryption round-trips binary payloads', () => {
  const raw = Buffer.from([0, 1, 2, 3, 255, 128, 64, 42]);
  const aad = 'rest:file:demo:1234';
  const packed = encryptBufferAtRest(raw, aad);
  assert.ok(packed.length === raw.length + 28);
  const decrypted = decryptBufferAtRest(packed, aad);
  assert.deepEqual(decrypted, raw);
  assert.throws(() => decryptBufferAtRest(packed, 'rest:file:demo:wrong'));
});

test('scrypt auth verifier hashing verifies valid and rejects invalid tokens', async () => {
  const verifier = 'base64url-client-derived-auth-verifier-token';
  const hash = await hashAuthVerifier(verifier);
  assert.ok(hash.startsWith('scrypt$'));
  assert.equal(await verifyAuthVerifier(verifier, hash), true);
  assert.equal(await verifyAuthVerifier('wrong-token', hash), false);
  assert.equal(await verifyAuthVerifier('', hash), false);
});

test('WebCrypto PBKDF2 + HKDF + AES-256-GCM AAD domain separation matches browser engine', async () => {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const pwKey = await crypto.subtle.importKey('raw', enc.encode('StrongP@ss!2026'), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const masterBits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100_000 },
    pwKey,
    256
  );
  const hkdfKey = await crypto.subtle.importKey('raw', masterBits, 'HKDF', false, [
    'deriveKey',
    'deriveBits',
  ]);
  const aesKey = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode('ciphernote:v1:enc') },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
  const authBits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode('ciphernote:v1:auth') },
    hkdfKey,
    256
  );
  assert.equal(authBits.byteLength, 32);

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = enc.encode('ciphernote:v1:note:test-room');
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad },
    aesKey,
    enc.encode('{"title":"测试","content":"零知识端到端加密"}')
  );
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad }, aesKey, ct);
  assert.equal(dec.decode(pt), '{"title":"测试","content":"零知识端到端加密"}');

  // Cross-slug AAD must fail decryption
  await assert.rejects(() =>
    crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: enc.encode('ciphernote:v1:note:other-room') },
      aesKey,
      ct
    )
  );
});
