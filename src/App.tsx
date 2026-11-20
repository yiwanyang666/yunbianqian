import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import type { EncryptionMode, RecentNoteItem, ThemeMode, ToastItem } from './types';
import { isValidSlug } from './lib/slug';
import {
  clearRecentNotes,
  loadRecentNotes,
  loadTheme,
  recordRecentNote,
  removeRecentNote,
  saveTheme,
} from './lib/storage';
import { ToastContainer } from './components/Toast';

const LandingPage = lazy(() =>
  import('./components/LandingPage').then((m) => ({ default: m.LandingPage }))
);
const NoteWorkspace = lazy(() =>
  import('./components/NoteWorkspace').then((m) => ({ default: m.NoteWorkspace }))
);

function getSlugFromLocation(): string | null {
  const path = window.location.pathname.replace(/^\/+|\/+$/g, '');
  if (!path) return null;
  const decoded = decodeURIComponent(path);
  return isValidSlug(decoded) ? decoded : null;
}

export default function App() {
  const [slug, setSlug] = useState<string | null>(() => getSlugFromLocation());
  const [theme, setTheme] = useState<ThemeMode>(() => loadTheme());
  const [recentNotes, setRecentNotes] = useState<RecentNoteItem[]>(() => loadRecentNotes());
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
    saveTheme(theme);
  }, [theme]);

  useEffect(() => {
    document.title = slug
      ? `/${slug} — 云便签`
      : '云便签 — 免费免登录的端到端加密在线云便签与跨设备剪贴板';

    // Privacy + SEO: index landing page, prevent search engines from indexing private note slugs
    let robotsMeta = document.querySelector<HTMLMetaElement>('meta[name="robots"]');
    if (!robotsMeta) {
      robotsMeta = document.createElement('meta');
      robotsMeta.name = 'robots';
      document.head.appendChild(robotsMeta);
    }
    robotsMeta.content = slug ? 'noindex, nofollow' : 'index, follow';
  }, [slug]);

  useEffect(() => {
    const onPopState = () => {
      setSlug(getSlugFromLocation());
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const addToast = useCallback(
    (message: string, type: ToastItem['type'] = 'info') => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      setToasts((prev) => [...prev.slice(-3), { id, message, type }]);
      window.setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 3200);
    },
    []
  );

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
  }, []);

  const navigateToNote = useCallback(
    (targetSlug: string, options?: { urlKey?: string }) => {
      const hash = options?.urlKey ? `#k=${options.urlKey}` : '';
      window.history.pushState(null, '', `/${encodeURIComponent(targetSlug)}${hash}`);
      setSlug(targetSlug);
    },
    []
  );

  const navigateHome = useCallback(() => {
    window.history.pushState(null, '', '/');
    setSlug(null);
  }, []);

  const handleNoteVisited = useCallback((visitedSlug: string, mode: EncryptionMode) => {
    setRecentNotes(recordRecentNote(visitedSlug, mode));
  }, []);

  const handleRemoveRecent = useCallback((target: string) => {
    setRecentNotes(removeRecentNote(target));
  }, []);

  const handleClearRecent = useCallback(() => {
    clearRecentNotes();
    setRecentNotes([]);
  }, []);

  return (
    <>
      <Suspense
        fallback={
          <div className="min-h-screen flex items-center justify-center bg-[var(--paper-bg)] text-xs text-zinc-400">
            加载中…
          </div>
        }
      >
        {slug ? (
          <NoteWorkspace
            key={slug}
            slug={slug}
            theme={theme}
            onToggleTheme={toggleTheme}
            onBackHome={navigateHome}
            onNoteVisited={handleNoteVisited}
            onToast={addToast}
          />
        ) : (
          <LandingPage
            theme={theme}
            onToggleTheme={toggleTheme}
            recentNotes={recentNotes}
            onRemoveRecent={handleRemoveRecent}
            onClearRecent={handleClearRecent}
            onNavigateNote={navigateToNote}
          />
        )}
      </Suspense>
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </>
  );
}
