const SLUG_REGEX = /^[a-zA-Z0-9_-]{2,64}$/;
const RESERVED_SLUGS = new Set(['api', 'assets', 'favicon.ico', 'robots.txt', 'health', 'static']);

const ADJECTIVES = [
  'amber', 'cedar', 'cloud', 'coral', 'frost', 'ivory', 'jade', 'linen',
  'lunar', 'maple', 'misty', 'olive', 'pearl', 'prism', 'quiet', 'sage',
  'silk', 'slate', 'solar', 'velvet',
];

const NOUNS = [
  'brook', 'cove', 'crest', 'drift', 'folio', 'grove', 'harbor', 'haven',
  'ink', 'isle', 'leaf', 'note', 'page', 'quill', 'reed', 'scroll',
  'shore', 'spark', 'stone', 'vault',
];

export function isValidSlug(slug: string): boolean {
  if (!SLUG_REGEX.test(slug)) return false;
  if (RESERVED_SLUGS.has(slug.toLowerCase())) return false;
  return true;
}

export function sanitizeSlugInput(raw: string): string {
  return raw
    .trim()
    .replace(/^\/+/, '')
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/-{2,}/g, '-')
    .slice(0, 64);
}

export function generateMemorableSlug(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const adj = ADJECTIVES[bytes[0] % ADJECTIVES.length];
  const noun = NOUNS[bytes[1] % NOUNS.length];
  const num = ((bytes[2] << 8) | bytes[3]) % 9000 + 1000;
  return `${adj}-${noun}-${num}`;
}

export function generateShortRandomSlug(length = 8): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

export function parseUrlKeyFromHash(hash: string = window.location.hash): string | null {
  if (!hash || hash.length < 4) return null;
  const clean = hash.startsWith('#') ? hash.slice(1) : hash;
  const params = new URLSearchParams(clean);
  const k = params.get('k');
  if (k && /^[A-Za-z0-9_-]{40,50}$/.test(k)) {
    return k;
  }
  return null;
}

export function buildNoteUrl(slug: string, options?: { urlKey?: string | null; readOnlyParam?: boolean }): string {
  const origin = window.location.origin;
  const query = options?.readOnlyParam ? '?ro=1' : '';
  const hash = options?.urlKey ? `#k=${options.urlKey}` : '';
  return `${origin}/${encodeURIComponent(slug)}${query}${hash}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatRelativeTime(timestamp: number): string {
  const diff = Math.max(0, Date.now() - timestamp);
  const sec = Math.floor(diff / 1000);
  if (sec < 8) return '刚刚';
  if (sec < 60) return `${sec} 秒前`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} 天前`;
  return new Date(timestamp).toLocaleDateString('zh-CN');
}

export function formatExpiryCountdown(expiresAt: number | null | undefined): string {
  if (!expiresAt) return '永久保留';
  const remaining = expiresAt - Date.now();
  if (remaining <= 0) return '已过期';
  const min = Math.ceil(remaining / 60000);
  if (min < 60) return `${min} 分钟后过期`;
  const hr = Math.ceil(min / 60);
  if (hr < 48) return `${hr} 小时后过期`;
  const days = Math.ceil(hr / 24);
  return `${days} 天后过期`;
}

export const TTL_OPTIONS: { label: string; value: number | null; shortLabel: string }[] = [
  { label: '10 分钟后自动销毁', value: 10 * 60, shortLabel: '10 分钟' },
  { label: '1 小时后自动销毁', value: 60 * 60, shortLabel: '1 小时' },
  { label: '24 小时后自动销毁', value: 24 * 60 * 60, shortLabel: '24 小时' },
  { label: '7 天后自动销毁', value: 7 * 24 * 60 * 60, shortLabel: '7 天' },
  { label: '30 天后自动销毁', value: 30 * 24 * 60 * 60, shortLabel: '30 天' },
  { label: '不自动过期', value: null, shortLabel: '永久' },
];
