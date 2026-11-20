// Cloudflare Workers + D1 Edge Backend for 云便签 (zero runtime dependencies)

const SLUG_REGEX = /^[a-zA-Z0-9_-]{2,64}$/;
const FILE_ID_REGEX = /^[a-zA-Z0-9-]{8,64}$/;
const RESERVED_SLUGS = new Set(['api', 'assets', 'favicon.ico', 'robots.txt', 'sitemap.xml', 'health', 'static']);
const VALID_MODES = new Set(['none', 'password', 'url-key']);
const MAX_NOTE_BYTES = 1.5 * 1024 * 1024; // 1.5 MB text
const MAX_ATTACHMENTS_PER_NOTE = 10;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MB per file on D1 Free Tier
const CHUNK_BYTES = 512 * 1024; // 512 KB raw (~682 KB base64, safely under D1 1 MB row limit)

const encoder = new TextEncoder();
const decoder = new TextDecoder();

let schemaPromise = null;
let lastCleanupAt = 0;

function bytesToBase64(bytes) {
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

/**
 * Fast, constant-time salted HMAC-SHA256 hash for the already-256-bit client authVerifier.
 * Runs in <0.2ms CPU — 100% safe for Cloudflare Workers Free Tier (10ms CPU limit).
 */
async function hashAuthVerifier(verifier) {
  if (!verifier || typeof verifier !== 'string') return null;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', salt, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(verifier)));
  return `hmac$${bytesToBase64(salt)}$${bytesToBase64(sig)}`;
}

async function verifyAuthVerifier(verifier, storedHash) {
  if (!storedHash) return true;
  if (!verifier || typeof verifier !== 'string') return false;
  const parts = storedHash.split('$');
  if (parts.length !== 3 || parts[0] !== 'hmac') return false;
  const salt = base64ToBytes(parts[1]);
  const expected = base64ToBytes(parts[2]);
  const key = await crypto.subtle.importKey('raw', salt, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const actual = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(verifier)));
  return timingSafeEqual(actual, expected);
}

async function getAtRestKey(env) {
  const secret = env.SERVER_MASTER_KEY || 'yunbianqian-default-edge-at-rest-key-v1';
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(secret));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function encryptAtRest(env, plaintext, aad) {
  const key = await getAtRestKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: encoder.encode(aad) },
      key,
      encoder.encode(plaintext)
    )
  );
  return JSON.stringify({ v: 2, iv: bytesToBase64(iv), data: bytesToBase64(ct) });
}

async function decryptAtRest(env, payloadJson, aad) {
  const key = await getAtRestKey(env);
  const parsed = JSON.parse(payloadJson);
  const iv = base64ToBytes(parsed.iv);
  const data = base64ToBytes(parsed.data);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(aad) },
    key,
    data
  );
  return decoder.decode(pt);
}

async function ensureSchema(db) {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await db.batch([
        db.prepare(`
          CREATE TABLE IF NOT EXISTS notes (
            slug TEXT PRIMARY KEY,
            encryption_mode TEXT NOT NULL,
            ciphertext TEXT NOT NULL,
            iv TEXT,
            salt TEXT,
            kdf_iterations INTEGER NOT NULL DEFAULT 600000,
            auth_hash TEXT,
            read_only INTEGER NOT NULL DEFAULT 0,
            burn_after_read INTEGER NOT NULL DEFAULT 0,
            version INTEGER NOT NULL DEFAULT 1,
            expires_at INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          )
        `),
        db.prepare(`
          CREATE TABLE IF NOT EXISTS attachments (
            id TEXT PRIMARY KEY,
            note_slug TEXT NOT NULL,
            encrypted_meta TEXT NOT NULL,
            file_iv TEXT,
            size_bytes INTEGER NOT NULL,
            encrypted INTEGER NOT NULL DEFAULT 1,
            created_at INTEGER NOT NULL
          )
        `),
        db.prepare(`
          CREATE TABLE IF NOT EXISTS attachment_chunks (
            attachment_id TEXT NOT NULL,
            chunk_index INTEGER NOT NULL,
            data_b64 TEXT NOT NULL,
            PRIMARY KEY (attachment_id, chunk_index)
          )
        `),
        db.prepare('CREATE INDEX IF NOT EXISTS idx_notes_expires_at ON notes(expires_at)'),
        db.prepare('CREATE INDEX IF NOT EXISTS idx_attachments_slug ON attachments(note_slug)'),
      ]);
    })().catch((err) => {
      schemaPromise = null;
      throw err;
    });
  }
  return schemaPromise;
}

async function deleteNoteCascade(db, slug) {
  const atts = await db.prepare('SELECT id FROM attachments WHERE note_slug = ?').bind(slug).all();
  const batch = [];
  for (const row of atts.results || []) {
    batch.push(db.prepare('DELETE FROM attachment_chunks WHERE attachment_id = ?').bind(row.id));
  }
  batch.push(db.prepare('DELETE FROM attachments WHERE note_slug = ?').bind(slug));
  batch.push(db.prepare('DELETE FROM notes WHERE slug = ?').bind(slug));
  await db.batch(batch);
}

async function cleanupExpired(db) {
  const now = Date.now();
  const expired = await db
    .prepare('SELECT slug FROM notes WHERE expires_at IS NOT NULL AND expires_at <= ? LIMIT 50')
    .bind(now)
    .all();
  for (const row of expired.results || []) {
    await deleteNoteCascade(db, row.slug);
  }
}

async function getFreshNote(db, slug) {
  const row = await db.prepare('SELECT * FROM notes WHERE slug = ?').bind(slug).first();
  if (!row) return null;
  if (row.expires_at !== null && row.expires_at <= Date.now()) {
    await deleteNoteCascade(db, slug);
    return null;
  }
  return row;
}

async function getAttachmentList(env, db, slug, encryptionMode) {
  const rows = await db
    .prepare(
      'SELECT id, encrypted_meta, file_iv, size_bytes, encrypted, created_at FROM attachments WHERE note_slug = ? ORDER BY created_at DESC'
    )
    .bind(slug)
    .all();

  const out = [];
  for (const r of rows.results || []) {
    let meta = r.encrypted_meta;
    if (r.encrypted === 0 && encryptionMode === 'none') {
      try {
        meta = await decryptAtRest(env, r.encrypted_meta, `rest:fmeta:${slug}:${r.id}`);
      } catch {
        meta = JSON.stringify({ name: 'file', type: 'application/octet-stream', size: r.size_bytes });
      }
    }
    out.push({
      id: r.id,
      encryptedMeta: meta,
      fileIv: r.file_iv,
      sizeBytes: r.size_bytes,
      encrypted: Boolean(r.encrypted),
      createdAt: r.created_at,
    });
  }
  return out;
}

async function readAttachmentBytes(db, attachmentId) {
  const chunks = await db
    .prepare('SELECT data_b64 FROM attachment_chunks WHERE attachment_id = ? ORDER BY chunk_index ASC')
    .bind(attachmentId)
    .all();
  const buffers = (chunks.results || []).map((c) => base64ToBytes(c.data_b64));
  const total = buffers.reduce((sum, b) => sum + b.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const b of buffers) {
    merged.set(b, offset);
    offset += b.length;
  }
  return merged;
}

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, private',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    },
  });
}

function validateSlug(slug) {
  return Boolean(slug && SLUG_REGEX.test(slug) && !RESERVED_SLUGS.has(slug.toLowerCase()));
}

function getAuthHeader(request, body) {
  const h = request.headers.get('X-Auth-Verifier');
  if (h) return h;
  if (body && typeof body.authVerifier === 'string') return body.authVerifier;
  return '';
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Non-API requests -> serve static SPA assets from Cloudflare Edge
    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }

    if (!env.DB) {
      return jsonResponse({ error: 'D1 数据库未绑定 (DB)' }, 500);
    }

    await ensureSchema(env.DB);

    // Opportunistic expired note cleanup every 5 minutes
    const now = Date.now();
    if (now - lastCleanupAt > 5 * 60 * 1000) {
      lastCleanupAt = now;
      ctx.waitUntil(cleanupExpired(env.DB).catch(() => {}));
    }

    const method = request.method;
    const pathname = url.pathname;

    if (method === 'GET' && pathname === '/api/health') {
      return jsonResponse({ ok: true, runtime: 'cloudflare-workers', syncMode: 'poll', time: Date.now() });
    }

    const parts = pathname.split('/').filter(Boolean);
    if (parts.length < 3 || parts[0] !== 'api' || parts[1] !== 'notes') {
      return jsonResponse({ error: 'API 路径不存在' }, 404);
    }

    let slug;
    try {
      slug = decodeURIComponent(parts[2]);
    } catch {
      return jsonResponse({ error: '无效的路径编码' }, 400);
    }

    if (!validateSlug(slug)) {
      return jsonResponse({ error: '路径仅支持 2-64 位字母、数字、短横线或下划线' }, 400);
    }

    const sub = parts[3] || '';
    const subId = parts[4] ? decodeURIComponent(parts[4]) : '';

    try {
      // SSE endpoint signals edge poll fallback cleanly (204)
      if (method === 'GET' && sub === 'events' && !subId) {
        return new Response(null, {
          status: 204,
          headers: { 'X-Sync-Mode': 'poll', 'Cache-Control': 'no-store' },
        });
      }

      // Lightweight metadata endpoint for polling sync on Cloudflare Edge
      if (method === 'GET' && sub === 'meta' && !subId) {
        const row = await getFreshNote(env.DB, slug);
        if (!row) return jsonResponse({ exists: false, slug });
        const att = await env.DB.prepare('SELECT COUNT(*) as cnt FROM attachments WHERE note_slug = ?')
          .bind(slug)
          .first();
        return jsonResponse({
          exists: true,
          slug,
          version: row.version,
          updatedAt: row.updated_at,
          burnAfterRead: Boolean(row.burn_after_read),
          attachmentCount: att?.cnt ?? 0,
        });
      }

      // GET /api/notes/:slug
      if (method === 'GET' && !sub) {
        const row = await getFreshNote(env.DB, slug);
        if (!row) return jsonResponse({ exists: false, slug });

        if (row.burn_after_read === 1) {
          const att = await env.DB.prepare('SELECT COUNT(*) as cnt FROM attachments WHERE note_slug = ?')
            .bind(slug)
            .first();
          return jsonResponse({
            exists: true,
            slug: row.slug,
            burnAfterRead: true,
            consumed: false,
            encryptionMode: row.encryption_mode,
            salt: row.salt,
            kdfIterations: row.kdf_iterations,
            hasAuth: Boolean(row.auth_hash),
            readOnly: Boolean(row.read_only),
            version: row.version,
            expiresAt: row.expires_at,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            attachmentCount: att?.cnt ?? 0,
          });
        }

        let ciphertext = row.ciphertext;
        if (row.encryption_mode === 'none') {
          ciphertext = await decryptAtRest(env, row.ciphertext, `rest:note:${slug}`);
        }

        const attachments = await getAttachmentList(env, env.DB, slug, row.encryption_mode);
        return jsonResponse({
          exists: true,
          slug: row.slug,
          burnAfterRead: false,
          encryptionMode: row.encryption_mode,
          ciphertext,
          iv: row.iv,
          salt: row.salt,
          kdfIterations: row.kdf_iterations,
          hasAuth: Boolean(row.auth_hash),
          readOnly: Boolean(row.read_only),
          version: row.version,
          expiresAt: row.expires_at,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          attachments,
        });
      }

      // POST /api/notes/:slug/consume
      if (method === 'POST' && sub === 'consume' && !subId) {
        const body = await request.json().catch(() => ({}));
        const row = await getFreshNote(env.DB, slug);
        if (!row) return jsonResponse({ error: '便签不存在或已被销毁' }, 404);

        const authVerifier = getAuthHeader(request, body);
        if (row.auth_hash && !(await verifyAuthVerifier(authVerifier, row.auth_hash))) {
          return jsonResponse({ error: '密码或密钥验证失败，便签未被销毁', code: 'AUTH_INVALID' }, 401);
        }

        let ciphertext = row.ciphertext;
        if (row.encryption_mode === 'none') {
          ciphertext = await decryptAtRest(env, row.ciphertext, `rest:note:${slug}`);
        }

        const attRows = await env.DB.prepare('SELECT * FROM attachments WHERE note_slug = ? ORDER BY created_at DESC')
          .bind(slug)
          .all();
        const inlineAttachments = [];
        for (const r of attRows.results || []) {
          let meta = r.encrypted_meta;
          if (r.encrypted === 0 && row.encryption_mode === 'none') {
            try {
              meta = await decryptAtRest(env, r.encrypted_meta, `rest:fmeta:${slug}:${r.id}`);
            } catch {
              meta = JSON.stringify({ name: 'file', type: 'application/octet-stream', size: r.size_bytes });
            }
          }
          const bytes = await readAttachmentBytes(env.DB, r.id);
          inlineAttachments.push({
            id: r.id,
            encryptedMeta: meta,
            fileIv: r.file_iv,
            sizeBytes: r.size_bytes,
            encrypted: Boolean(r.encrypted),
            createdAt: r.created_at,
            inlineDataBase64: bytesToBase64(bytes),
          });
        }

        await deleteNoteCascade(env.DB, slug);

        return jsonResponse({
          exists: true,
          burnedNow: true,
          slug: row.slug,
          burnAfterRead: true,
          encryptionMode: row.encryption_mode,
          ciphertext,
          iv: row.iv,
          salt: row.salt,
          kdfIterations: row.kdf_iterations,
          readOnly: true,
          version: row.version,
          expiresAt: row.expires_at,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          attachments: inlineAttachments,
        });
      }

      // POST /api/notes/:slug/verify
      if (method === 'POST' && sub === 'verify' && !subId) {
        const body = await request.json().catch(() => ({}));
        const row = await getFreshNote(env.DB, slug);
        if (!row) return jsonResponse({ error: '便签不存在' }, 404);
        const authVerifier = getAuthHeader(request, body);
        const valid = await verifyAuthVerifier(authVerifier, row.auth_hash);
        if (!valid) return jsonResponse({ valid: false, error: '密码或密钥错误' }, 401);
        return jsonResponse({ valid: true });
      }

      // PUT /api/notes/:slug
      if (method === 'PUT' && !sub) {
        const body = await request.json().catch(() => null);
        if (!body) return jsonResponse({ error: 'JSON 格式错误' }, 400);

        const {
          encryptionMode,
          ciphertext,
          iv = null,
          salt = null,
          kdfIterations = 600000,
          newAuthVerifier,
          readOnly,
          burnAfterRead,
          ttlSeconds,
          expectedVersion,
          allowReadOnlyChange = false,
          clearAttachments = false,
        } = body;

        if (!VALID_MODES.has(encryptionMode)) return jsonResponse({ error: '不支持的加密模式' }, 400);
        if (typeof ciphertext !== 'string') return jsonResponse({ error: '缺少便签内容' }, 400);
        if (encoder.encode(ciphertext).length > MAX_NOTE_BYTES) {
          return jsonResponse({ error: '便签内容超过 1.5MB 边缘存储上限' }, 413);
        }
        if (encryptionMode !== 'none' && (!iv || !salt)) {
          return jsonResponse({ error: '端到端加密模式必须提供 IV 和 Salt' }, 400);
        }

        const existing = await getFreshNote(env.DB, slug);
        const authVerifier = getAuthHeader(request, body);
        const ts = Date.now();

        if (existing) {
          if (existing.auth_hash && !(await verifyAuthVerifier(authVerifier, existing.auth_hash))) {
            return jsonResponse({ error: '无权修改此加密便签，请先验证密码/密钥', code: 'AUTH_REQUIRED' }, 401);
          }
          if (existing.read_only === 1 && !allowReadOnlyChange) {
            return jsonResponse({ error: '此便签处于只读保护状态', code: 'READ_ONLY' }, 403);
          }
          if (typeof expectedVersion === 'number' && existing.version !== expectedVersion) {
            return jsonResponse(
              { error: '其他设备已更新此便签', code: 'VERSION_CONFLICT', serverVersion: existing.version },
              409
            );
          }
        }

        const storedCiphertext =
          encryptionMode === 'none'
            ? await encryptAtRest(env, ciphertext, `rest:note:${slug}`)
            : ciphertext;

        let authHash = existing ? existing.auth_hash : null;
        if (newAuthVerifier !== undefined) {
          authHash = newAuthVerifier === null ? null : await hashAuthVerifier(newAuthVerifier);
        }

        let expiresAt = existing ? existing.expires_at : null;
        if (ttlSeconds === null) {
          expiresAt = null;
        } else if (typeof ttlSeconds === 'number' && ttlSeconds > 0) {
          expiresAt = ts + Math.min(ttlSeconds, 365 * 24 * 3600) * 1000;
        }

        const nextReadOnly =
          typeof readOnly === 'boolean' ? (readOnly ? 1 : 0) : existing ? existing.read_only : 0;
        const nextBurn =
          typeof burnAfterRead === 'boolean'
            ? burnAfterRead
              ? 1
              : 0
            : existing
              ? existing.burn_after_read
              : 0;
        const nextVersion = existing ? existing.version + 1 : 1;
        const clampedKdf = Math.max(100000, Math.min(Number(kdfIterations) || 600000, 2000000));

        if (existing) {
          if (clearAttachments === true) {
            const oldAtts = await env.DB.prepare('SELECT id FROM attachments WHERE note_slug = ?')
              .bind(slug)
              .all();
            const delBatch = (oldAtts.results || []).map((a) =>
              env.DB.prepare('DELETE FROM attachment_chunks WHERE attachment_id = ?').bind(a.id)
            );
            delBatch.push(env.DB.prepare('DELETE FROM attachments WHERE note_slug = ?').bind(slug));
            await env.DB.batch(delBatch);
          }
          await env.DB.prepare(
            `UPDATE notes SET
              encryption_mode = ?, ciphertext = ?, iv = ?, salt = ?, kdf_iterations = ?,
              auth_hash = ?, read_only = ?, burn_after_read = ?, version = ?, expires_at = ?, updated_at = ?
            WHERE slug = ?`
          )
            .bind(
              encryptionMode,
              storedCiphertext,
              encryptionMode === 'none' ? null : iv,
              encryptionMode === 'none' ? null : salt,
              clampedKdf,
              authHash,
              nextReadOnly,
              nextBurn,
              nextVersion,
              expiresAt,
              ts,
              slug
            )
            .run();
        } else {
          await env.DB.prepare(
            `INSERT INTO notes (
              slug, encryption_mode, ciphertext, iv, salt, kdf_iterations,
              auth_hash, read_only, burn_after_read, version, expires_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
            .bind(
              slug,
              encryptionMode,
              storedCiphertext,
              encryptionMode === 'none' ? null : iv,
              encryptionMode === 'none' ? null : salt,
              clampedKdf,
              authHash,
              nextReadOnly,
              nextBurn,
              nextVersion,
              expiresAt,
              ts,
              ts
            )
            .run();
        }

        return jsonResponse({
          ok: true,
          slug,
          version: nextVersion,
          encryptionMode,
          hasAuth: Boolean(authHash),
          readOnly: Boolean(nextReadOnly),
          burnAfterRead: Boolean(nextBurn),
          expiresAt,
          updatedAt: ts,
          createdAt: existing ? existing.created_at : ts,
        });
      }

      // DELETE /api/notes/:slug
      if (method === 'DELETE' && !sub) {
        const existing = await getFreshNote(env.DB, slug);
        if (!existing) return jsonResponse({ ok: true, deleted: false });

        const authVerifier = getAuthHeader(request, null);
        if (existing.auth_hash && !(await verifyAuthVerifier(authVerifier, existing.auth_hash))) {
          return jsonResponse({ error: '无权销毁此加密便签' }, 401);
        }
        await deleteNoteCascade(env.DB, slug);
        return jsonResponse({ ok: true, deleted: true });
      }

      // POST /api/notes/:slug/attachments (chunked in D1 — works on 100% Free Tier without R2!)
      if (method === 'POST' && sub === 'attachments' && !subId) {
        const existing = await getFreshNote(env.DB, slug);
        if (!existing) return jsonResponse({ error: '请先保存便签后再上传附件' }, 404);

        const authVerifier = getAuthHeader(request, null);
        if (existing.auth_hash && !(await verifyAuthVerifier(authVerifier, existing.auth_hash))) {
          return jsonResponse({ error: '无权上传附件到此加密便签' }, 401);
        }
        if (existing.read_only === 1) {
          return jsonResponse({ error: '只读状态下无法上传附件' }, 403);
        }
        const cntRow = await env.DB.prepare('SELECT COUNT(*) as cnt FROM attachments WHERE note_slug = ?')
          .bind(slug)
          .first();
        if ((cntRow?.cnt ?? 0) >= MAX_ATTACHMENTS_PER_NOTE) {
          return jsonResponse({ error: `单个便签最多支持 ${MAX_ATTACHMENTS_PER_NOTE} 个附件` }, 400);
        }

        const rawFileId = request.headers.get('X-File-Id') || crypto.randomUUID();
        if (!FILE_ID_REGEX.test(rawFileId)) return jsonResponse({ error: '无效的文件 ID' }, 400);

        const metaHeader = request.headers.get('X-Encrypted-Meta');
        if (!metaHeader) return jsonResponse({ error: '缺少文件元数据' }, 400);

        let metaString;
        try {
          metaString = decoder.decode(base64ToBytes(metaHeader));
          JSON.parse(metaString);
        } catch {
          return jsonResponse({ error: '文件元数据格式错误' }, 400);
        }

        const isClientEncrypted = request.headers.get('X-File-Encrypted') === '1';
        const fileIv = request.headers.get('X-File-Iv') || null;
        if (existing.encryption_mode !== 'none' && (!isClientEncrypted || !fileIv)) {
          return jsonResponse({ error: '加密便签的附件必须在本地加密后上传' }, 400);
        }

        const rawBytes = new Uint8Array(await request.arrayBuffer());
        if (rawBytes.length === 0) return jsonResponse({ error: '文件内容为空' }, 400);
        if (rawBytes.length > MAX_ATTACHMENT_BYTES + 1024) {
          return jsonResponse({ error: 'Cloudflare 免费版单文件上限为 10 MB' }, 413);
        }

        let storedMeta = metaString;
        if (!isClientEncrypted && existing.encryption_mode === 'none') {
          storedMeta = await encryptAtRest(env, metaString, `rest:fmeta:${slug}:${rawFileId}`);
        }

        const ts = Date.now();
        const stmtsBatch = [
          env.DB.prepare(
            `INSERT INTO attachments (id, note_slug, encrypted_meta, file_iv, size_bytes, encrypted, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          ).bind(rawFileId, slug, storedMeta, isClientEncrypted ? fileIv : null, rawBytes.length, isClientEncrypted ? 1 : 0, ts),
        ];

        for (let offset = 0, idx = 0; offset < rawBytes.length; offset += CHUNK_BYTES, idx++) {
          const slice = rawBytes.subarray(offset, Math.min(offset + CHUNK_BYTES, rawBytes.length));
          stmtsBatch.push(
            env.DB.prepare(
              'INSERT INTO attachment_chunks (attachment_id, chunk_index, data_b64) VALUES (?, ?, ?)'
            ).bind(rawFileId, idx, bytesToBase64(slice))
          );
        }

        await env.DB.batch(stmtsBatch);

        return jsonResponse({
          ok: true,
          attachment: {
            id: rawFileId,
            encryptedMeta: metaString,
            fileIv: isClientEncrypted ? fileIv : null,
            sizeBytes: rawBytes.length,
            encrypted: isClientEncrypted,
            createdAt: ts,
          },
        });
      }

      // GET /api/notes/:slug/attachments/:id
      if (method === 'GET' && sub === 'attachments' && subId) {
        const note = await getFreshNote(env.DB, slug);
        if (!note) return jsonResponse({ error: '便签不存在' }, 404);
        if (note.burn_after_read === 1) {
          return jsonResponse({ error: '阅后即焚便签的附件仅在解锁读取时下发' }, 403);
        }
        const att = await env.DB.prepare('SELECT id FROM attachments WHERE id = ? AND note_slug = ?')
          .bind(subId, slug)
          .first();
        if (!att) return jsonResponse({ error: '附件不存在' }, 404);

        const bytes = await readAttachmentBytes(env.DB, subId);
        return new Response(bytes, {
          status: 200,
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(bytes.length),
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
          },
        });
      }

      // DELETE /api/notes/:slug/attachments/:id
      if (method === 'DELETE' && sub === 'attachments' && subId) {
        const note = await getFreshNote(env.DB, slug);
        if (!note) return jsonResponse({ error: '便签不存在' }, 404);
        const authVerifier = getAuthHeader(request, null);
        if (note.auth_hash && !(await verifyAuthVerifier(authVerifier, note.auth_hash))) {
          return jsonResponse({ error: '无权删除附件' }, 401);
        }
        if (note.read_only === 1) return jsonResponse({ error: '只读状态下无法删除附件' }, 403);

        await env.DB.batch([
          env.DB.prepare('DELETE FROM attachment_chunks WHERE attachment_id = ?').bind(subId),
          env.DB.prepare('DELETE FROM attachments WHERE id = ? AND note_slug = ?').bind(subId, slug),
        ]);
        return jsonResponse({ ok: true });
      }

      return jsonResponse({ error: '不支持的请求方法' }, 405);
    } catch (err) {
      return jsonResponse({ error: err?.message || '服务器内部错误' }, 500);
    }
  },
};
