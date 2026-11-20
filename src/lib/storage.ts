import type { EncryptionMode, RecentNoteItem, ThemeMode } from '../types';

const RECENT_KEY = 'ciphernote:recent:v1';
const THEME_KEY = 'ciphernote:theme:v1';
const WIDE_KEY = 'ciphernote:wide:v1';

export function loadRecentNotes(): RecentNoteItem[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, 8);
  } catch {
    return [];
  }
}

/**
 * Note: Only stores the slug and mode locally for quick access.
 * NEVER persists passwords or URL fragment keys to localStorage.
 */
export function recordRecentNote(slug: string, mode: EncryptionMode): RecentNoteItem[] {
  const existing = loadRecentNotes().filter((item) => item.slug !== slug);
  const next: RecentNoteItem[] = [{ slug, mode, visitedAt: Date.now() }, ...existing].slice(0, 8);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // ignore storage quota
  }
  return next;
}

export function removeRecentNote(slug: string): RecentNoteItem[] {
  const next = loadRecentNotes().filter((item) => item.slug !== slug);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
  return next;
}

export function clearRecentNotes(): void {
  try {
    localStorage.removeItem(RECENT_KEY);
  } catch {
    // ignore
  }
}

export function loadTheme(): ThemeMode {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    // ignore
  }
  if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches) {
    return 'dark';
  }
  return 'light';
}

export function saveTheme(theme: ThemeMode): void {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // ignore
  }
}

export function loadWideEditor(): boolean {
  try {
    return localStorage.getItem(WIDE_KEY) === '1';
  } catch {
    return false;
  }
}

export function saveWideEditor(wide: boolean): void {
  try {
    localStorage.setItem(WIDE_KEY, wide ? '1' : '0');
  } catch {
    // ignore
  }
}
