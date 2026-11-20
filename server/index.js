import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleApiRequest } from './routes.js';
import { cleanupExpiredNotes } from './db.js';
import { getMasterKey } from './crypto-server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.resolve(__dirname, '..', 'dist');
const PORT = Number(process.env.PORT) || 3456;
const HOST = process.env.HOST || '0.0.0.0';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const CSP_HEADER = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join('; ');

getMasterKey();
cleanupExpiredNotes();
setInterval(() => cleanupExpiredNotes(), 60 * 1000).unref();

function setSecurityHeaders(res) {
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Content-Security-Policy', CSP_HEADER);
}

/**
 * Serve static file with pre-compressed Brotli/Gzip negotiation & ETag 304 support.
 */
function serveStaticFile(req, res, filePath, isImmutable) {
  let stat;
  try {
    stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
  } catch {
    return false;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag });
    res.end();
    return true;
  }

  // Prefer pre-compressed .br or .gz if present
  const acceptEncoding = String(req.headers['accept-encoding'] || '');
  let targetPath = filePath;
  let encoding = null;

  if (acceptEncoding.includes('br') && fs.existsSync(`${filePath}.br`)) {
    targetPath = `${filePath}.br`;
    encoding = 'br';
  } else if (acceptEncoding.includes('gzip') && fs.existsSync(`${filePath}.gz`)) {
    targetPath = `${filePath}.gz`;
    encoding = 'gzip';
  }

  const targetStat = targetPath === filePath ? stat : fs.statSync(targetPath);
  const headers = {
    'Content-Type': contentType,
    'Content-Length': targetStat.size,
    ETag: etag,
    Vary: 'Accept-Encoding',
    'Cache-Control': isImmutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  };
  if (encoding) {
    headers['Content-Encoding'] = encoding;
  }

  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  fs.createReadStream(targetPath).pipe(res);
  return true;
}

const server = http.createServer(async (req, res) => {
  setSecurityHeaders(res);

  let urlObj;
  try {
    urlObj = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  } catch {
    res.writeHead(400);
    res.end('Bad Request');
    return;
  }

  // API endpoints
  if (urlObj.pathname.startsWith('/api/')) {
    await handleApiRequest(req, res, urlObj);
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    res.end('Method Not Allowed');
    return;
  }

  // Serve static built assets
  if (fs.existsSync(DIST_DIR)) {
    const reqPath = decodeURIComponent(urlObj.pathname);
    if (reqPath !== '/' && !reqPath.includes('..')) {
      const candidate = path.resolve(DIST_DIR, reqPath.replace(/^\/+/, ''));
      if (candidate.startsWith(DIST_DIR)) {
        const isHashedAsset = reqPath.startsWith('/assets/');
        if (serveStaticFile(req, res, candidate, isHashedAsset)) {
          return;
        }
      }
    }

    // SPA fallback for /<slug>
    const indexHtml = path.join(DIST_DIR, 'index.html');
    if (serveStaticFile(req, res, indexHtml, false)) {
      return;
    }
  }

  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('CipherNote API running. Run "npm run build" first.');
});

server.keepAliveTimeout = 30000;
server.headersTimeout = 35000;

server.listen(PORT, HOST, () => {
  const rss = (process.memoryUsage().rss / 1024 / 1024).toFixed(1);
  console.log(`\n  云便签 零依赖极轻服务已启动 (RSS ~${rss} MB)`);
  console.log(`  ➜  本地访问: http://localhost:${PORT}`);
  console.log(`  ➜  纯 Node.js 原生架构 (node:http + node:sqlite + Brotli/Gzip + 流式加密存储)\n`);
});
