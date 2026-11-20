import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  stmts,
  UPLOADS_DIR,
  deleteNoteAndFiles,
  safeUnlinkUpload,
} from './db.js';
import {
  encryptAtRest,
  decryptAtRest,
  encryptBufferAtRest,
  decryptBufferAtRest,
  hashAuthVerifier,
  verifyAuthVerifier,
} from './crypto-server.js';
import { addSubscriber, broadcastToSlug, getActiveViewerCount } from './sse.js';

const SLUG_REGEX = /^[a-zA-Z0-9_-]{2,64}$/;
const FILE_ID_REGEX = /^[a-zA-Z0-9-]{8,64}$/;
const RESERVED_SLUGS = new Set([
  'api',
  'assets',
  'favicon.ico',
  'robots.txt',
  'health',
  'static',
]);
const VALID_MODES = new Set(['none', 'password', 'url-key']);
const MAX_NOTE_BYTES = 3 * 1024 * 1024;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_ATTACHMENTS_PER_NOTE = 10;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

// Sliding window rate limiter
const rateBuckets = new Map();
function checkRateLimit(key, maxRequests, windowMs) {
  const now = Date.now();
  let timestamps = rateBuckets.get(key);
  if (!timestamps) {
    timestamps = [];
    rateBuckets.set(key, timestamps);
  }
  const cutoff = now - windowMs;
  while (timestamps.length > 0 && timestamps[0] <= cutoff) {
    timestamps.shift();
  }
  if (timestamps.length >= maxRequests) return false;
  timestamps.push(now);
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, arr] of rateBuckets.entries()) {
    if (arr.length === 0 || now - arr[arr.length - 1] > 5 * 60 * 1000) {
      rateBuckets.delete(k);
    }
  }
}, 60 * 1000).unref();

function validateSlug(slug) {
  return Boolean(slug && SLUG_REGEX.test(slug) && !RESERVED_SLUGS.has(slug.toLowerCase()));
}

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) {
    return fwd.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    Pragma: 'no-cache',
  });
  res.end(body);
}

function readJsonBody(req, limitBytes = MAX_JSON_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let aborted = false;

    req.on('data', (chunk) => {
      if (aborted) return;
      total += chunk.length;
      if (total > limitBytes) {
        aborted = true;
        reject(Object.assign(new Error('请求体过大'), { status: 413 }));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (aborted) return;
      if (total === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('JSON 格式错误'), { status: 400 }));
      }
    });
    req.on('error', (err) => {
      if (!aborted) reject(err);
    });
  });
}

function readRawBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let aborted = false;
    req.on('data', (chunk) => {
      if (aborted) return;
      total += chunk.length;
      if (total > limitBytes) {
        aborted = true;
        reject(Object.assign(new Error('单个文件不能超过 25 MB'), { status: 413 }));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!aborted) resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (!aborted) reject(err);
    });
  });
}

/**
 * Stream raw encrypted upload directly to disk with hard byte limit (~64KB peak RAM).
 */
async function streamBodyToFile(req, destPath, limitBytes) {
  let totalBytes = 0;
  const limiter = new Transform({
    transform(chunk, _enc, cb) {
      totalBytes += chunk.length;
      if (totalBytes > limitBytes) {
        cb(Object.assign(new Error('单个文件不能超过 25 MB'), { status: 413 }));
        return;
      }
      cb(null, chunk);
    },
  });

  const ws = fs.createWriteStream(destPath);
  try {
    await pipeline(req, limiter, ws);
    return totalBytes;
  } catch (err) {
    fs.unlink(destPath, () => {});
    throw err;
  }
}

function getFreshNote(slug) {
  const row = stmts.getNote.get(slug);
  if (!row) return null;
  if (row.expires_at !== null && row.expires_at <= Date.now()) {
    deleteNoteAndFiles(slug);
    return null;
  }
  return row;
}

function getAttachmentList(slug, encryptionMode) {
  const rows = stmts.listAttachments.all(slug);
  return rows.map((r) => {
    let meta = r.encrypted_meta;
    if (r.encrypted === 0 && encryptionMode === 'none') {
      try {
        meta = decryptAtRest(r.encrypted_meta, `rest:fmeta:${slug}:${r.id}`);
      } catch {
        meta = JSON.stringify({ name: 'file', type: 'application/octet-stream', size: r.size_bytes });
      }
    }
    return {
      id: r.id,
      encryptedMeta: meta,
      fileIv: r.file_iv,
      sizeBytes: r.size_bytes,
      encrypted: Boolean(r.encrypted),
      createdAt: r.created_at,
    };
  });
}

function getAuthHeader(req, body) {
  const h = req.headers['x-auth-verifier'];
  if (typeof h === 'string' && h.length > 0) return h;
  if (body && typeof body.authVerifier === 'string') return body.authVerifier;
  return '';
}

export async function handleApiRequest(req, res, urlObj) {
  const method = req.method || 'GET';
  const pathname = urlObj.pathname;

  // GET /api/health
  if (method === 'GET' && pathname === '/api/health') {
    const mem = process.memoryUsage();
    return sendJson(res, 200, {
      ok: true,
      runtime: 'node',
      syncMode: 'sse',
      time: Date.now(),
      rssMB: Math.round((mem.rss / 1024 / 1024) * 10) / 10,
      heapUsedMB: Math.round((mem.heapUsed / 1024 / 1024) * 10) / 10,
    });
  }

  // Match /api/notes/:slug[/...]
  const parts = pathname.split('/').filter(Boolean); // ['api', 'notes', slug, ...]
  if (parts.length < 3 || parts[0] !== 'api' || parts[1] !== 'notes') {
    return sendJson(res, 404, { error: 'API 路径不存在' });
  }

  let slug;
  try {
    slug = decodeURIComponent(parts[2]);
  } catch {
    return sendJson(res, 400, { error: '无效的路径编码' });
  }

  if (!validateSlug(slug)) {
    return sendJson(res, 400, { error: '路径仅支持 2-64 位字母、数字、短横线或下划线' });
  }

  const sub = parts[3] || '';
  const subId = parts[4] ? decodeURIComponent(parts[4]) : '';

  try {
    // 1. SSE: GET /api/notes/:slug/events
    if (method === 'GET' && sub === 'events' && !subId) {
      const clientId = urlObj.searchParams.get('clientId') || crypto.randomUUID();
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders?.();

      const unsubscribe = addSubscriber(slug, res, clientId);
      res.write(
        `event: connected\ndata: ${JSON.stringify({ viewers: getActiveViewerCount(slug) })}\n\n`
      );

      const heartbeat = setInterval(() => {
        try {
          res.write(': ping\n\n');
        } catch {
          clearInterval(heartbeat);
        }
      }, 25000);

      req.on('close', () => {
        clearInterval(heartbeat);
        unsubscribe();
      });
      return;
    }

    // 1.5 Lightweight metadata endpoint
    if (method === 'GET' && sub === 'meta' && !subId) {
      const row = getFreshNote(slug);
      if (!row) return sendJson(res, 200, { exists: false, slug });
      const attCount = stmts.countAttachments.get(slug).cnt;
      return sendJson(res, 200, {
        exists: true,
        slug,
        version: row.version,
        updatedAt: row.updated_at,
        burnAfterRead: Boolean(row.burn_after_read),
        attachmentCount: attCount,
      });
    }

    // 2. GET /api/notes/:slug
    if (method === 'GET' && !sub) {
      const row = getFreshNote(slug);
      if (!row) return sendJson(res, 200, { exists: false, slug });

      if (row.burn_after_read === 1) {
        const attCount = stmts.countAttachments.get(slug).cnt;
        return sendJson(res, 200, {
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
          attachmentCount: attCount,
        });
      }

      let ciphertext = row.ciphertext;
      if (row.encryption_mode === 'none') {
        try {
          ciphertext = decryptAtRest(row.ciphertext, `rest:note:${slug}`);
        } catch {
          return sendJson(res, 500, { error: '服务端静态解密失败' });
        }
      }

      return sendJson(res, 200, {
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
        attachments: getAttachmentList(slug, row.encryption_mode),
      });
    }

    // 3. POST /api/notes/:slug/consume
    if (method === 'POST' && sub === 'consume' && !subId) {
      const ip = getClientIp(req);
      if (!checkRateLimit(`consume:${ip}:${slug}`, 12, 60 * 1000)) {
        return sendJson(res, 429, { error: '尝试次数过多，请稍后再试' });
      }
      const body = await readJsonBody(req, 64 * 1024);
      const row = getFreshNote(slug);
      if (!row) return sendJson(res, 404, { error: '便签不存在或已被销毁' });

      const authVerifier = getAuthHeader(req, body);
      if (row.auth_hash && !(await verifyAuthVerifier(authVerifier, row.auth_hash))) {
        return sendJson(res, 401, {
          error: '密码或密钥验证失败，便签未被销毁',
          code: 'AUTH_INVALID',
        });
      }

      let ciphertext = row.ciphertext;
      if (row.encryption_mode === 'none') {
        try {
          ciphertext = decryptAtRest(row.ciphertext, `rest:note:${slug}`);
        } catch {
          return sendJson(res, 500, { error: '服务端静态解密失败' });
        }
      }

      const attRows = stmts.listAttachmentsFull.all(slug);
      const inlineAttachments = [];
      for (const r of attRows) {
        let meta = r.encrypted_meta;
        if (r.encrypted === 0 && row.encryption_mode === 'none') {
          try {
            meta = decryptAtRest(r.encrypted_meta, `rest:fmeta:${slug}:${r.id}`);
          } catch {
            meta = JSON.stringify({ name: 'file', type: 'application/octet-stream', size: r.size_bytes });
          }
        }
        let dataBase64 = null;
        const fullPath = path.join(UPLOADS_DIR, r.storage_name);
        if (fs.existsSync(fullPath)) {
          let buf = await fs.promises.readFile(fullPath);
          if (r.encrypted === 0 && row.encryption_mode === 'none') {
            try {
              buf = decryptBufferAtRest(buf, `rest:file:${slug}:${r.id}`);
            } catch {
              // fallback
            }
          }
          dataBase64 = buf.toString('base64');
        }
        inlineAttachments.push({
          id: r.id,
          encryptedMeta: meta,
          fileIv: r.file_iv,
          sizeBytes: r.size_bytes,
          encrypted: Boolean(r.encrypted),
          createdAt: r.created_at,
          inlineDataBase64: dataBase64,
        });
      }

      deleteNoteAndFiles(slug);
      broadcastToSlug(slug, 'note-burned', { slug, burnedAt: Date.now() });

      return sendJson(res, 200, {
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

    // 4. POST /api/notes/:slug/verify
    if (method === 'POST' && sub === 'verify' && !subId) {
      const ip = getClientIp(req);
      if (!checkRateLimit(`verify:${ip}:${slug}`, 15, 60 * 1000)) {
        return sendJson(res, 429, { error: '验证过于频繁，请 1 分钟后再试' });
      }
      const body = await readJsonBody(req, 32 * 1024);
      const row = getFreshNote(slug);
      if (!row) return sendJson(res, 404, { error: '便签不存在' });
      const authVerifier = getAuthHeader(req, body);
      const valid = await verifyAuthVerifier(authVerifier, row.auth_hash);
      if (!valid) return sendJson(res, 401, { valid: false, error: '密码或密钥错误' });
      return sendJson(res, 200, { valid: true });
    }

    // 5. PUT /api/notes/:slug
    if (method === 'PUT' && !sub) {
      const ip = getClientIp(req);
      if (!checkRateLimit(`put:${ip}`, 120, 60 * 1000)) {
        return sendJson(res, 429, { error: '保存频率过高，请稍候' });
      }
      const body = await readJsonBody(req, MAX_JSON_BYTES);
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
        clientId,
        allowReadOnlyChange = false,
        clearAttachments = false,
      } = body;

      if (!VALID_MODES.has(encryptionMode)) {
        return sendJson(res, 400, { error: '不支持的加密模式' });
      }
      if (typeof ciphertext !== 'string') {
        return sendJson(res, 400, { error: '缺少便签内容' });
      }
      if (Buffer.byteLength(ciphertext, 'utf8') > MAX_NOTE_BYTES) {
        return sendJson(res, 413, { error: '便签内容超过 3MB 上限' });
      }
      if (encryptionMode !== 'none' && (!iv || !salt)) {
        return sendJson(res, 400, { error: '端到端加密模式必须提供 IV 和 Salt' });
      }

      const existing = getFreshNote(slug);
      const authVerifier = getAuthHeader(req, body);
      const now = Date.now();

      if (existing) {
        if (existing.auth_hash && !(await verifyAuthVerifier(authVerifier, existing.auth_hash))) {
          return sendJson(res, 401, {
            error: '无权修改此加密便签，请先验证密码/密钥',
            code: 'AUTH_REQUIRED',
          });
        }
        if (existing.read_only === 1 && !allowReadOnlyChange) {
          return sendJson(res, 403, { error: '此便签处于只读保护状态', code: 'READ_ONLY' });
        }
        if (typeof expectedVersion === 'number' && existing.version !== expectedVersion) {
          return sendJson(res, 409, {
            error: '其他设备已更新此便签',
            code: 'VERSION_CONFLICT',
            serverVersion: existing.version,
          });
        }
      }

      const storedCiphertext =
        encryptionMode === 'none'
          ? encryptAtRest(ciphertext, `rest:note:${slug}`)
          : ciphertext;

      let authHash = existing ? existing.auth_hash : null;
      if (newAuthVerifier !== undefined) {
        authHash = newAuthVerifier === null ? null : await hashAuthVerifier(newAuthVerifier);
      }

      let expiresAt = existing ? existing.expires_at : null;
      if (ttlSeconds === null) {
        expiresAt = null;
      } else if (typeof ttlSeconds === 'number' && ttlSeconds > 0) {
        expiresAt = now + Math.min(ttlSeconds, 365 * 24 * 3600) * 1000;
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
          const oldFiles = stmts.listAttachmentStorage.all(slug);
          stmts.deleteAllAttachments.run(slug);
          for (const f of oldFiles) safeUnlinkUpload(f.storage_name);
        }
        stmts.updateNote.run(
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
          now,
          slug
        );
      } else {
        stmts.insertNote.run(
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
          now,
          now
        );
      }

      broadcastToSlug(
        slug,
        'note-updated',
        {
          slug,
          version: nextVersion,
          updatedAt: now,
          encryptionMode,
          readOnly: Boolean(nextReadOnly),
          burnAfterRead: Boolean(nextBurn),
          expiresAt,
        },
        clientId || null
      );

      return sendJson(res, 200, {
        ok: true,
        slug,
        version: nextVersion,
        encryptionMode,
        hasAuth: Boolean(authHash),
        readOnly: Boolean(nextReadOnly),
        burnAfterRead: Boolean(nextBurn),
        expiresAt,
        updatedAt: now,
        createdAt: existing ? existing.created_at : now,
      });
    }

    // 6. DELETE /api/notes/:slug
    if (method === 'DELETE' && !sub) {
      const existing = getFreshNote(slug);
      if (!existing) return sendJson(res, 200, { ok: true, deleted: false });

      const authVerifier = getAuthHeader(req, null);
      if (existing.auth_hash && !(await verifyAuthVerifier(authVerifier, existing.auth_hash))) {
        return sendJson(res, 401, { error: '无权销毁此加密便签' });
      }

      deleteNoteAndFiles(slug);
      const clientId = typeof req.headers['x-client-id'] === 'string' ? req.headers['x-client-id'] : null;
      broadcastToSlug(slug, 'note-deleted', { slug, deletedAt: Date.now() }, clientId);
      return sendJson(res, 200, { ok: true, deleted: true });
    }

    // 7. POST /api/notes/:slug/attachments (streaming upload!)
    if (method === 'POST' && sub === 'attachments' && !subId) {
      const existing = getFreshNote(slug);
      if (!existing) return sendJson(res, 404, { error: '请先保存便签后再上传附件' });

      const authVerifier = getAuthHeader(req, null);
      if (existing.auth_hash && !(await verifyAuthVerifier(authVerifier, existing.auth_hash))) {
        return sendJson(res, 401, { error: '无权上传附件到此加密便签' });
      }
      if (existing.read_only === 1) {
        return sendJson(res, 403, { error: '只读状态下无法上传附件' });
      }
      if (stmts.countAttachments.get(slug).cnt >= MAX_ATTACHMENTS_PER_NOTE) {
        return sendJson(res, 400, { error: `单个便签最多支持 ${MAX_ATTACHMENTS_PER_NOTE} 个附件` });
      }

      const rawFileId =
        typeof req.headers['x-file-id'] === 'string'
          ? req.headers['x-file-id']
          : crypto.randomUUID();
      if (!FILE_ID_REGEX.test(rawFileId)) {
        return sendJson(res, 400, { error: '无效的文件 ID' });
      }

      const metaHeader = req.headers['x-encrypted-meta'];
      if (typeof metaHeader !== 'string' || !metaHeader) {
        return sendJson(res, 400, { error: '缺少文件元数据' });
      }
      let metaString;
      try {
        metaString = Buffer.from(metaHeader, 'base64').toString('utf8');
        JSON.parse(metaString);
      } catch {
        return sendJson(res, 400, { error: '文件元数据格式错误' });
      }

      const isClientEncrypted = req.headers['x-file-encrypted'] === '1';
      const fileIv = typeof req.headers['x-file-iv'] === 'string' ? req.headers['x-file-iv'] : null;
      if (existing.encryption_mode !== 'none' && (!isClientEncrypted || !fileIv)) {
        return sendJson(res, 400, { error: '加密便签的附件必须在本地加密后上传' });
      }

      const storageName = `${crypto.randomUUID()}.bin`;
      const fullPath = path.join(UPLOADS_DIR, storageName);
      let storedMeta = metaString;
      let sizeBytes = 0;

      if (isClientEncrypted) {
        // Zero-RAM-buffering streaming write directly to disk!
        sizeBytes = await streamBodyToFile(req, fullPath, MAX_ATTACHMENT_BYTES + 1024);
        if (sizeBytes === 0) {
          fs.unlink(fullPath, () => {});
          return sendJson(res, 400, { error: '文件内容为空' });
        }
      } else {
        const rawBuf = await readRawBody(req, MAX_ATTACHMENT_BYTES + 1024);
        if (rawBuf.length === 0) return sendJson(res, 400, { error: '文件内容为空' });
        sizeBytes = rawBuf.length;
        storedMeta = encryptAtRest(metaString, `rest:fmeta:${slug}:${rawFileId}`);
        const encBuf = encryptBufferAtRest(rawBuf, `rest:file:${slug}:${rawFileId}`);
        await fs.promises.writeFile(fullPath, encBuf);
      }

      const now = Date.now();
      stmts.insertAttachment.run(
        rawFileId,
        slug,
        storageName,
        storedMeta,
        isClientEncrypted ? fileIv : null,
        sizeBytes,
        isClientEncrypted ? 1 : 0,
        now
      );

      const clientId = typeof req.headers['x-client-id'] === 'string' ? req.headers['x-client-id'] : null;
      broadcastToSlug(slug, 'attachments-updated', { slug, updatedAt: now }, clientId);

      return sendJson(res, 200, {
        ok: true,
        attachment: {
          id: rawFileId,
          encryptedMeta: metaString,
          fileIv: isClientEncrypted ? fileIv : null,
          sizeBytes,
          encrypted: isClientEncrypted,
          createdAt: now,
        },
      });
    }

    // 8. GET /api/notes/:slug/attachments/:id (streaming download!)
    if (method === 'GET' && sub === 'attachments' && subId) {
      const note = getFreshNote(slug);
      if (!note) return sendJson(res, 404, { error: '便签不存在' });
      if (note.burn_after_read === 1) {
        return sendJson(res, 403, { error: '阅后即焚便签的附件仅在解锁读取时下发' });
      }
      const att = stmts.getAttachment.get(subId, slug);
      if (!att) return sendJson(res, 404, { error: '附件不存在' });

      const fullPath = path.join(UPLOADS_DIR, att.storage_name);
      if (!fs.existsSync(fullPath)) return sendJson(res, 404, { error: '附件文件已丢失' });

      if (att.encrypted === 0 && note.encryption_mode === 'none') {
        const packed = await fs.promises.readFile(fullPath);
        const plain = decryptBufferAtRest(packed, `rest:file:${slug}:${att.id}`);
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': plain.length,
          'Cache-Control': 'no-store',
        });
        return res.end(plain);
      }

      // Stream encrypted ciphertext directly from disk (~64KB RAM!)
      const stat = await fs.promises.stat(fullPath);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': stat.size,
        'Cache-Control': 'no-store',
      });
      const rs = fs.createReadStream(fullPath);
      rs.on('error', () => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
      rs.pipe(res);
      return;
    }

    // 9. DELETE /api/notes/:slug/attachments/:id
    if (method === 'DELETE' && sub === 'attachments' && subId) {
      const note = getFreshNote(slug);
      if (!note) return sendJson(res, 404, { error: '便签不存在' });

      const authVerifier = getAuthHeader(req, null);
      if (note.auth_hash && !(await verifyAuthVerifier(authVerifier, note.auth_hash))) {
        return sendJson(res, 401, { error: '无权删除附件' });
      }
      if (note.read_only === 1) {
        return sendJson(res, 403, { error: '只读状态下无法删除附件' });
      }

      const att = stmts.getAttachmentStorage.get(subId, slug);
      if (!att) return sendJson(res, 404, { error: '附件不存在' });

      stmts.deleteAttachment.run(subId, slug);
      safeUnlinkUpload(att.storage_name);

      const clientId = typeof req.headers['x-client-id'] === 'string' ? req.headers['x-client-id'] : null;
      broadcastToSlug(slug, 'attachments-updated', { slug, updatedAt: Date.now() }, clientId);
      return sendJson(res, 200, { ok: true });
    }

    return sendJson(res, 405, { error: '不支持的请求方法' });
  } catch (err) {
    const status = typeof err?.status === 'number' ? err.status : 500;
    return sendJson(res, status, { error: err?.message || '服务器内部错误' });
  }
}
