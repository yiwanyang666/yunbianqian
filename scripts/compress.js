import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.resolve(__dirname, '..', 'dist');
const COMPRESSIBLE_EXTS = new Set(['.js', '.css', '.html', '.svg', '.json', '.txt']);

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(full));
    } else if (COMPRESSIBLE_EXTS.has(path.extname(entry.name))) {
      files.push(full);
    }
  }
  return files;
}

if (!fs.existsSync(DIST_DIR)) {
  process.exit(0);
}

let rawTotal = 0;
let brTotal = 0;
let gzTotal = 0;

for (const file of walk(DIST_DIR)) {
  const raw = fs.readFileSync(file);
  if (raw.length < 256) continue;
  rawTotal += raw.length;

  const br = zlib.brotliCompressSync(raw, {
    params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 },
  });
  fs.writeFileSync(`${file}.br`, br);
  brTotal += br.length;

  const gz = zlib.gzipSync(raw, { level: 9 });
  fs.writeFileSync(`${file}.gz`, gz);
  gzTotal += gz.length;
}

console.log(
  `Pre-compressed dist assets: raw ${(rawTotal / 1024).toFixed(1)} KB -> brotli ${(brTotal / 1024).toFixed(1)} KB | gzip ${(gzTotal / 1024).toFixed(1)} KB`
);
