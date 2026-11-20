import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const KEY_FILE = path.join(DATA_DIR, '.master.key');

let cachedMasterKey = null;

export function getMasterKey() {
  if (cachedMasterKey) return cachedMasterKey;

  if (process.env.CIPHERNOTE_MASTER_KEY) {
    const buf = Buffer.from(process.env.CIPHERNOTE_MASTER_KEY, 'hex');
    if (buf.length !== 32) {
      throw new Error('CIPHERNOTE_MASTER_KEY must be a 64-character hex string (32 bytes).');
    }
    cachedMasterKey = buf;
    return cachedMasterKey;
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(KEY_FILE)) {
    const hex = fs.readFileSync(KEY_FILE, 'utf8').trim();
    const buf = Buffer.from(hex, 'hex');
    if (buf.length === 32) {
      cachedMasterKey = buf;
      return cachedMasterKey;
    }
  }

  const key = crypto.randomBytes(32);
  fs.writeFileSync(KEY_FILE, key.toString('hex'), { mode: 0o600 });
  cachedMasterKey = key;
  return cachedMasterKey;
}

/**
 * Encrypt UTF-8 text at rest on server (AES-256-GCM with random 96-bit IV + AAD).
 */
export function encryptAtRest(plaintext, aadString = '') {
  const key = getMasterKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  if (aadString) {
    cipher.setAAD(Buffer.from(aadString, 'utf8'));
  }
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    v: 1,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: encrypted.toString('base64'),
  });
}

export function decryptAtRest(payloadJson, aadString = '') {
  const key = getMasterKey();
  const parsed = JSON.parse(payloadJson);
  const iv = Buffer.from(parsed.iv, 'base64');
  const tag = Buffer.from(parsed.tag, 'base64');
  const data = Buffer.from(parsed.data, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  if (aadString) {
    decipher.setAAD(Buffer.from(aadString, 'utf8'));
  }
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString('utf8');
}

export function encryptBufferAtRest(buffer, aadString = '') {
  const key = getMasterKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  if (aadString) {
    cipher.setAAD(Buffer.from(aadString, 'utf8'));
  }
  const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]);
}

export function decryptBufferAtRest(packedBuffer, aadString = '') {
  const key = getMasterKey();
  const iv = packedBuffer.subarray(0, 12);
  const tag = packedBuffer.subarray(12, 28);
  const data = packedBuffer.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  if (aadString) {
    decipher.setAAD(Buffer.from(aadString, 'utf8'));
  }
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

function scryptAsync(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 32, { N: 16384, r: 8, p: 1 }, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });
}

/**
 * Non-blocking async scrypt hash of client-supplied authVerifier.
 */
export async function hashAuthVerifier(verifier) {
  if (!verifier || typeof verifier !== 'string') return null;
  const salt = crypto.randomBytes(16);
  const derived = await scryptAsync(verifier, salt);
  return `scrypt$${salt.toString('base64')}$${derived.toString('base64')}`;
}

/**
 * Non-blocking constant-time verification of client-supplied authVerifier.
 */
export async function verifyAuthVerifier(verifier, storedHash) {
  if (!storedHash) return true;
  if (!verifier || typeof verifier !== 'string') return false;
  const parts = storedHash.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'base64');
  const expected = Buffer.from(parts[2], 'base64');
  const actual = await scryptAsync(verifier, salt);
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}
