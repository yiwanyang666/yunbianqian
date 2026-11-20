import type { AttachmentMeta, NotePayload } from '../types';

export const DEFAULT_PBKDF2_ITERATIONS = 600_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function isWebCryptoAvailable(): boolean {
  return typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.subtle !== 'undefined';
}

export function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlToBytes(base64Url: string): Uint8Array<ArrayBuffer> {
  let b64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4 !== 0) {
    b64 += '=';
  }
  return base64ToBytes(b64);
}

export function utf8ToBase64(text: string): string {
  return bytesToBase64(encoder.encode(text));
}

export function generateSaltBase64(): string {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  return bytesToBase64(salt);
}

export function generateRandomIv(): Uint8Array<ArrayBuffer> {
  const iv = new Uint8Array(new ArrayBuffer(12));
  crypto.getRandomValues(iv);
  return iv;
}

export function generateUrlKey(): string {
  const keyBytes = new Uint8Array(32); // 256 bits
  crypto.getRandomValues(keyBytes);
  return bytesToBase64Url(keyBytes);
}

/**
 * Domain-separated HKDF key expansion:
 * Derives an AES-256-GCM encryption key AND an independent auth verifier
 * from a 256-bit master secret so the server never learns a single bit of encKey.
 */
async function expandMasterSecret(
  masterBytes: Uint8Array<ArrayBuffer>,
  saltBytes: Uint8Array<ArrayBuffer>
): Promise<{ encKey: CryptoKey; authVerifier: string }> {
  const hkdfKey = await crypto.subtle.importKey('raw', masterBytes, 'HKDF', false, [
    'deriveKey',
    'deriveBits',
  ]);

  const encKey = await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: saltBytes,
      info: encoder.encode('ciphernote:v1:enc'),
    },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );

  const authBits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: saltBytes,
      info: encoder.encode('ciphernote:v1:auth'),
    },
    hkdfKey,
    256
  );

  const authDigest = await crypto.subtle.digest('SHA-256', authBits);
  const authVerifier = bytesToBase64Url(new Uint8Array(authDigest));

  return { encKey, authVerifier };
}

/**
 * Derive encryption key + auth verifier from user password using PBKDF2-HMAC-SHA256 (600,000 iters) + HKDF.
 */
export async function deriveKeysFromPassword(
  password: string,
  saltBase64: string,
  iterations: number = DEFAULT_PBKDF2_ITERATIONS
): Promise<{ encKey: CryptoKey; authVerifier: string }> {
  const saltBytes = base64ToBytes(saltBase64);
  const pwKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );

  const masterBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: saltBytes,
      iterations,
    },
    pwKey,
    256
  );

  return expandMasterSecret(new Uint8Array(masterBits), saltBytes);
}

/**
 * Derive encryption key + auth verifier from a 256-bit URL fragment key (#k=...) via HKDF.
 */
export async function deriveKeysFromUrlKey(
  urlKeyBase64Url: string,
  saltBase64: string
): Promise<{ encKey: CryptoKey; authVerifier: string }> {
  const rawKey = base64UrlToBytes(urlKeyBase64Url);
  if (rawKey.length !== 32) {
    throw new Error('无效的链接密钥长度');
  }
  const saltBytes = base64ToBytes(saltBase64);
  return expandMasterSecret(rawKey, saltBytes);
}

export function buildNoteAad(slug: string): string {
  return `ciphernote:v1:note:${slug}`;
}

export function buildFileAad(slug: string, fileId: string): string {
  return `ciphernote:v1:file:${slug}:${fileId}`;
}

export function buildFileMetaAad(slug: string, fileId: string): string {
  return `ciphernote:v1:fmeta:${slug}:${fileId}`;
}

export async function encryptNotePayload(
  payload: NotePayload,
  encKey: CryptoKey,
  slug: string
): Promise<{ ciphertext: string; iv: string; aad: string }> {
  const iv = generateRandomIv();
  const aadStr = buildNoteAad(slug);
  const plaintextBytes = encoder.encode(JSON.stringify(payload));

  const encrypted = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: encoder.encode(aadStr),
    },
    encKey,
    plaintextBytes
  );

  return {
    ciphertext: bytesToBase64(new Uint8Array(encrypted)),
    iv: bytesToBase64(iv),
    aad: aadStr,
  };
}

export async function decryptNotePayload(
  ciphertextBase64: string,
  ivBase64: string,
  encKey: CryptoKey,
  slug: string
): Promise<NotePayload> {
  const iv = base64ToBytes(ivBase64);
  const data = base64ToBytes(ciphertextBase64);
  const aadStr = buildNoteAad(slug);

  const decrypted = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: encoder.encode(aadStr),
    },
    encKey,
    data
  );

  const parsed = JSON.parse(decoder.decode(decrypted));
  return {
    title: typeof parsed.title === 'string' ? parsed.title : '',
    content: typeof parsed.content === 'string' ? parsed.content : '',
  };
}

export async function encryptFileForUpload(
  file: File,
  encKey: CryptoKey,
  slug: string,
  fileId: string
): Promise<{
  encryptedBytes: Uint8Array<ArrayBuffer>;
  fileIv: string;
  encryptedMetaJson: string;
}> {
  const meta: AttachmentMeta = {
    name: file.name,
    type: file.type || 'application/octet-stream',
    size: file.size,
  };

  // Encrypt filename & metadata
  const metaIv = generateRandomIv();
  const metaEncrypted = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: metaIv,
      additionalData: encoder.encode(buildFileMetaAad(slug, fileId)),
    },
    encKey,
    encoder.encode(JSON.stringify(meta))
  );

  const encryptedMetaJson = JSON.stringify({
    ciphertext: bytesToBase64(new Uint8Array(metaEncrypted)),
    iv: bytesToBase64(metaIv),
  });

  // Encrypt binary file body
  const fileBuffer = await file.arrayBuffer();
  const fileIv = generateRandomIv();
  const bodyEncrypted = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: fileIv,
      additionalData: encoder.encode(buildFileAad(slug, fileId)),
    },
    encKey,
    fileBuffer
  );

  return {
    encryptedBytes: new Uint8Array(bodyEncrypted),
    fileIv: bytesToBase64(fileIv),
    encryptedMetaJson,
  };
}

export async function decryptFileMeta(
  encryptedMetaJson: string,
  encKey: CryptoKey,
  slug: string,
  fileId: string
): Promise<AttachmentMeta> {
  const parsed = JSON.parse(encryptedMetaJson);
  const iv = base64ToBytes(parsed.iv);
  const data = base64ToBytes(parsed.ciphertext);

  const decrypted = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: encoder.encode(buildFileMetaAad(slug, fileId)),
    },
    encKey,
    data
  );

  return JSON.parse(decoder.decode(decrypted)) as AttachmentMeta;
}

export async function decryptFileBytes(
  encryptedBytes: ArrayBuffer,
  fileIvBase64: string,
  encKey: CryptoKey,
  slug: string,
  fileId: string
): Promise<ArrayBuffer> {
  const iv = base64ToBytes(fileIvBase64);
  return crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: encoder.encode(buildFileAad(slug, fileId)),
    },
    encKey,
    encryptedBytes
  );
}

export function measurePasswordStrength(password: string): {
  score: number;
  label: string;
  barClass: string;
} {
  if (!password) {
    return { score: 0, label: '请输入密码', barClass: 'bg-zinc-300 dark:bg-zinc-700' };
  }
  let score = 0;
  if (password.length >= 6) score += 1;
  if (password.length >= 10) score += 1;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score += 1;
  if (/\d/.test(password) && /[^a-zA-Z0-9]/.test(password)) score += 1;
  if (password.length >= 16) score = Math.min(4, score + 1);

  if (score <= 1) return { score: 1, label: '偏弱 · 建议增加长度或字符种类', barClass: 'bg-rose-500' };
  if (score === 2) return { score: 2, label: '中等 · 适合临时中转', barClass: 'bg-amber-500' };
  if (score === 3) return { score: 3, label: '较强 · 安全可靠', barClass: 'bg-teal-500' };
  return { score: 4, label: '极强 · 高强度密码', barClass: 'bg-emerald-500' };
}
