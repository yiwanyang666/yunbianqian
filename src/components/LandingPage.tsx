import { useState, type FormEvent } from 'react';
import {
  ArrowRight,
  Clock,
  Dices,
  FileLock2,
  Flame,
  KeyRound,
  Lock,
  Moon,
  ShieldCheck,
  Sparkles,
  Sun,
  Trash2,
  X,
} from 'lucide-react';
import type { RecentNoteItem, ThemeMode } from '../types';
import {
  formatRelativeTime,
  generateMemorableSlug,
  generateShortRandomSlug,
  isValidSlug,
  sanitizeSlugInput,
} from '../lib/slug';
import { generateUrlKey } from '../lib/crypto';

interface LandingPageProps {
  theme: ThemeMode;
  onToggleTheme: () => void;
  recentNotes: RecentNoteItem[];
  onRemoveRecent: (slug: string) => void;
  onClearRecent: () => void;
  onNavigateNote: (slug: string, options?: { urlKey?: string; initialMode?: 'password' | 'url-key' | 'none' }) => void;
}

export function LandingPage({
  theme,
  onToggleTheme,
  recentNotes,
  onRemoveRecent,
  onClearRecent,
  onNavigateNote,
}: LandingPageProps) {
  const [slugInput, setSlugInput] = useState('');
  const [error, setError] = useState('');

  const originDisplay =
    typeof window !== 'undefined' ? window.location.host : 'yunbianqian';

  const handleOpen = (e: FormEvent) => {
    e.preventDefault();
    const cleaned = sanitizeSlugInput(slugInput);
    if (!cleaned) {
      const random = generateMemorableSlug();
      onNavigateNote(random);
      return;
    }
    if (!isValidSlug(cleaned)) {
      setError('路径需为 2-64 位字母、数字、短横线或下划线');
      return;
    }
    setError('');
    onNavigateNote(cleaned);
  };

  const handleCreateInstantE2EE = () => {
    const slug = sanitizeSlugInput(slugInput);
    const targetSlug = slug && isValidSlug(slug) ? slug : generateShortRandomSlug(10);
    const urlKey = generateUrlKey();
    onNavigateNote(targetSlug, { urlKey, initialMode: 'url-key' });
  };

  const handleRollSlug = () => {
    setSlugInput(generateMemorableSlug());
    setError('');
  };

  return (
    <div className="min-h-screen bg-paper-grid hero-ambient flex flex-col">
      {/* Top minimal bar */}
      <header className="w-full max-w-5xl mx-auto px-5 sm:px-8 h-16 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-teal-700 dark:bg-teal-600 flex items-center justify-center shadow-sm shadow-teal-900/15">
            <Lock className="w-4 h-4 text-white" strokeWidth={2.2} />
          </div>
          <div className="flex items-baseline gap-2">
            <span className="font-semibold tracking-tight text-base text-zinc-900 dark:text-zinc-50">
              云便签
            </span>
            <span className="text-[11px] font-mono text-zinc-400 dark:text-zinc-500">
              CloudNote
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="hidden sm:inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full bg-teal-500/10 text-teal-800 dark:text-teal-300 border border-teal-500/20">
            <ShieldCheck className="w-3.5 h-3.5" />
            零知识 AES-256-GCM
          </span>
          <button
            type="button"
            onClick={onToggleTheme}
            className="p-2 rounded-lg text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100 hover:bg-zinc-900/5 dark:hover:bg-white/5 transition-colors cursor-pointer"
            title={theme === 'dark' ? '切换晨光纸韵模式' : '切换暗夜曜石模式'}
          >
            {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>
        </div>
      </header>

      {/* Main centered hero */}
      <main className="flex-1 flex flex-col items-center justify-center px-5 sm:px-8 py-10 sm:py-16">
        <div className="w-full max-w-2xl mx-auto text-center">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium bg-white/80 dark:bg-zinc-900/80 border border-zinc-200/80 dark:border-zinc-800 text-zinc-600 dark:text-zinc-300 shadow-xs mb-6">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
            免登录 · 自定义路径 · 本地端到端加密
          </div>

          <h1 className="text-3xl sm:text-5xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50 leading-[1.18]">
            极简、私密的在线云便签，
            <br className="hidden sm:inline" />
            <span className="text-teal-700 dark:text-teal-400">连服务器也无法窥探</span>
          </h1>

          <p className="mt-4 text-sm sm:text-base text-zinc-500 dark:text-zinc-400 max-w-lg mx-auto leading-relaxed">
            输入任意专属路径即刻在手机、电脑与平板间同步文字、代码与文件。支持密码锁与链接密钥两种零知识加密模式，所有加解密均在浏览器本地完成。
          </p>

          {/* URL Launcher Card */}
          <div className="mt-9 paper-sheet rounded-2xl p-3 sm:p-4 text-left">
            <form onSubmit={handleOpen} className="flex flex-col sm:flex-row gap-2.5">
              <div className="flex-1 flex items-center rounded-xl bg-zinc-50 dark:bg-zinc-950/70 border border-zinc-200/90 dark:border-zinc-800 focus-within:border-teal-600 dark:focus-within:border-teal-500 focus-within:ring-2 focus-within:ring-teal-500/15 transition-all px-3.5 h-12">
                <span className="text-xs sm:text-sm font-mono text-zinc-400 dark:text-zinc-500 select-none shrink-0 pr-1.5">
                  {originDisplay}/
                </span>
                <input
                  type="text"
                  value={slugInput}
                  onChange={(e) => {
                    setSlugInput(e.target.value);
                    if (error) setError('');
                  }}
                  placeholder="输入自定义路径，留空随机生成"
                  className="flex-1 min-w-0 bg-transparent border-none outline-none text-sm font-mono text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-600"
                  autoFocus
                  spellCheck={false}
                  autoComplete="off"
                />
                <button
                  type="button"
                  onClick={handleRollSlug}
                  className="p-1.5 -mr-1 rounded-lg text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-200/50 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
                  title="生成随机易记路径"
                >
                  <Dices className="w-4 h-4" />
                </button>
              </div>

              <button
                type="submit"
                className="h-12 px-5 rounded-xl bg-zinc-900 hover:bg-zinc-800 dark:bg-zinc-100 dark:hover:bg-white text-white dark:text-zinc-900 font-medium text-sm flex items-center justify-center gap-2 transition-colors shadow-xs cursor-pointer shrink-0"
              >
                进入便签
                <ArrowRight className="w-4 h-4" />
              </button>
            </form>

            {error && (
              <p className="mt-2 px-1 text-xs text-rose-500">{error}</p>
            )}

            <div className="mt-3 pt-3 border-t border-zinc-100 dark:border-zinc-800/80 flex flex-wrap items-center justify-between gap-2">
              <button
                type="button"
                onClick={handleCreateInstantE2EE}
                className="inline-flex items-center gap-2 text-xs sm:text-sm font-medium px-3.5 py-2 rounded-xl bg-teal-700/10 hover:bg-teal-700/15 dark:bg-teal-400/10 dark:hover:bg-teal-400/15 text-teal-800 dark:text-teal-300 transition-colors cursor-pointer"
              >
                <Sparkles className="w-3.5 h-3.5" />
                一键创建零知识密室（256-bit 链接密钥）
              </button>

              <span className="text-[11px] text-zinc-400 dark:text-zinc-500 px-1">
                支持随时在便签内切换密码锁 / 阅后即焚
              </span>
            </div>
          </div>

          {/* Recent local notes */}
          {recentNotes.length > 0 && (
            <div className="mt-6 text-left">
              <div className="flex items-center justify-between px-1 mb-2.5">
                <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400 flex items-center gap-1.5">
                  <Clock className="w-3.5 h-3.5" />
                  最近访问（仅存本机，不含密钥）
                </span>
                <button
                  type="button"
                  onClick={onClearRecent}
                  className="text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 inline-flex items-center gap-1 cursor-pointer transition-colors"
                >
                  <Trash2 className="w-3 h-3" />
                  清空
                </button>
              </div>
              <div className="flex flex-wrap gap-2">
                {recentNotes.map((item) => (
                  <div
                    key={item.slug}
                    className="group inline-flex items-center gap-1.5 pl-3 pr-1.5 py-1.5 rounded-xl bg-white/85 dark:bg-zinc-900/85 border border-zinc-200/80 dark:border-zinc-800 hover:border-teal-600/40 dark:hover:border-teal-500/40 transition-all text-xs"
                  >
                    <button
                      type="button"
                      onClick={() => onNavigateNote(item.slug)}
                      className="inline-flex items-center gap-1.5 cursor-pointer"
                    >
                      {item.mode === 'password' ? (
                        <Lock className="w-3 h-3 text-teal-600 dark:text-teal-400" />
                      ) : item.mode === 'url-key' ? (
                        <KeyRound className="w-3 h-3 text-emerald-600 dark:text-emerald-400" />
                      ) : (
                        <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                      )}
                      <span className="font-mono text-zinc-800 dark:text-zinc-200">
                        /{item.slug}
                      </span>
                      <span className="text-zinc-400 dark:text-zinc-500 text-[11px]">
                        {formatRelativeTime(item.visitedAt)}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => onRemoveRecent(item.slug)}
                      className="p-0.5 rounded-md text-zinc-300 hover:text-zinc-600 dark:text-zinc-600 dark:hover:text-zinc-300 opacity-60 group-hover:opacity-100 transition-opacity cursor-pointer"
                      aria-label={`移除 ${item.slug}`}
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Minimal 3-pillar security architecture strip */}
        <section className="w-full max-w-4xl mx-auto mt-14 sm:mt-16 grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="rounded-2xl p-5 bg-white/75 dark:bg-zinc-900/55 border border-zinc-200/70 dark:border-zinc-800/80 backdrop-blur-xs">
            <div className="w-9 h-9 rounded-xl bg-teal-500/10 text-teal-700 dark:text-teal-400 flex items-center justify-center mb-3.5">
              <ShieldCheck className="w-4.5 h-4.5" />
            </div>
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              真·零知识端到端加密
            </h3>
            <p className="mt-1.5 text-xs text-zinc-500 dark:text-zinc-400 leading-relaxed">
              基于浏览器原生 WebCrypto，使用 PBKDF2 60 万次迭代 + HKDF 域隔离 + AES-256-GCM，服务端只存认证密文。
            </p>
          </div>

          <div className="rounded-2xl p-5 bg-white/75 dark:bg-zinc-900/55 border border-zinc-200/70 dark:border-zinc-800/80 backdrop-blur-xs">
            <div className="w-9 h-9 rounded-xl bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 flex items-center justify-center mb-3.5">
              <FileLock2 className="w-4.5 h-4.5" />
            </div>
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              加密文件中转与本地二维码
            </h3>
            <p className="mt-1.5 text-xs text-zinc-500 dark:text-zinc-400 leading-relaxed">
              拖拽上传任意文件，文件名与二进制内容先在本地加密再传输；扫码跨端分享完全在本地渲染二维码，不泄露密钥。
            </p>
          </div>

          <div className="rounded-2xl p-5 bg-white/75 dark:bg-zinc-900/55 border border-zinc-200/70 dark:border-zinc-800/80 backdrop-blur-xs">
            <div className="w-9 h-9 rounded-xl bg-amber-500/10 text-amber-700 dark:text-amber-400 flex items-center justify-center mb-3.5">
              <Flame className="w-4.5 h-4.5" />
            </div>
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              阅后即焚 · 自动过期 · 实时同步
            </h3>
            <p className="mt-1.5 text-xs text-zinc-500 dark:text-zinc-400 leading-relaxed">
              支持 Markdown 分屏预览、多端实时推送、只读保护、自定义过期时间与密码核验后再销毁的防误触阅后即焚。
            </p>
          </div>
        </section>
        {/* Compact SEO-friendly FAQ section */}
        <section
          aria-label="常见问题"
          className="w-full max-w-4xl mx-auto mt-10 rounded-2xl p-5 sm:p-6 bg-white/65 dark:bg-zinc-900/45 border border-zinc-200/70 dark:border-zinc-800/70"
        >
          <h2 className="text-xs font-semibold tracking-wider uppercase text-zinc-400 dark:text-zinc-500 mb-3.5">
            关于云便签 · 常见问题
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs leading-relaxed">
            <div>
              <h3 className="font-semibold text-zinc-800 dark:text-zinc-200">
                免登录如何跨设备传输文本与文件？
              </h3>
              <p className="mt-1 text-zinc-500 dark:text-zinc-400">
                输入任意好记的自定义路径（如 <code className="font-mono">/work-2026</code>）即可生成专属在线剪贴板；在另一台设备打开相同链接或扫描本地二维码即可无缝同步文字、Markdown 笔记与加密附件。
              </p>
            </div>
            <div>
              <h3 className="font-semibold text-zinc-800 dark:text-zinc-200">
                为什么说云便签是「真·零知识端到端加密」？
              </h3>
              <p className="mt-1 text-zinc-500 dark:text-zinc-400">
                开启密码锁或链接密钥后，浏览器本地使用 WebCrypto AES-256-GCM 加密后才上传，密钥与密码绝不离开本机；你可随时在「零知识密文检查器」中核验服务端仅存的原始密文。
              </p>
            </div>
          </div>
        </section>
      </main>

      <footer className="py-5 text-center text-xs text-zinc-400 dark:text-zinc-600">
        云便签 · 免费免登录的端到端加密在线云便签与跨设备剪贴板 · 基于 Web Crypto API 本地加密
      </footer>
    </div>
  );
}
