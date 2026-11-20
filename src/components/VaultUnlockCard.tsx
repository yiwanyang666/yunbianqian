import { useState, type FormEvent } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Eye,
  EyeOff,
  Flame,
  KeyRound,
  Loader2,
  Lock,
  Paperclip,
  ShieldCheck,
} from 'lucide-react';
import type { EncryptionMode } from '../types';
import { formatExpiryCountdown } from '../lib/slug';

interface VaultUnlockCardProps {
  slug: string;
  encryptionMode: EncryptionMode;
  burnAfterRead: boolean;
  hasUrlKeyInHash: boolean;
  kdfIterations?: number;
  expiresAt?: number | null;
  attachmentCount?: number;
  isProcessing: boolean;
  error: string;
  shakeKey: number;
  onUnlockPassword: (password: string) => void;
  onSubmitManualUrlKey: (keyOrUrl: string) => void;
  onConfirmBurnConsume: () => void;
  onBackHome: () => void;
}

export function VaultUnlockCard({
  slug,
  encryptionMode,
  burnAfterRead,
  hasUrlKeyInHash,
  kdfIterations = 600000,
  expiresAt,
  attachmentCount = 0,
  isProcessing,
  error,
  shakeKey,
  onUnlockPassword,
  onSubmitManualUrlKey,
  onConfirmBurnConsume,
  onBackHome,
}: VaultUnlockCardProps) {
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [manualKey, setManualKey] = useState('');

  const handlePasswordSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!password.trim() || isProcessing) return;
    onUnlockPassword(password);
  };

  const handleManualKeySubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!manualKey.trim() || isProcessing) return;
    onSubmitManualUrlKey(manualKey.trim());
  };

  const needsPassword = encryptionMode === 'password';
  const needsUrlKey = encryptionMode === 'url-key' && !hasUrlKeyInHash;
  const needsBurnConfirmOnly = burnAfterRead && !needsPassword && !needsUrlKey;

  return (
    <div className="min-h-[calc(100vh-4rem)] flex items-center justify-center px-4 py-12">
      <div
        key={shakeKey}
        className={`w-full max-w-md paper-sheet rounded-2xl p-6 sm:p-7 ${
          error ? 'animate-shake' : 'animate-fade-in-up'
        }`}
      >
        <div className="flex items-center justify-between mb-5">
          <button
            type="button"
            onClick={onBackHome}
            className="inline-flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-200 transition-colors cursor-pointer"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            返回首页
          </button>
          <span className="font-mono text-xs px-2.5 py-1 rounded-lg bg-zinc-100 dark:bg-zinc-800/80 text-zinc-600 dark:text-zinc-300">
            /{slug}
          </span>
        </div>

        {/* Icon & Title */}
        <div className="flex flex-col items-center text-center">
          <div
            className={`w-13 h-13 rounded-2xl flex items-center justify-center mb-4 ${
              burnAfterRead
                ? 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-500/20'
                : 'bg-teal-500/10 text-teal-700 dark:text-teal-400 border border-teal-500/20'
            }`}
          >
            {burnAfterRead ? (
              <Flame className="w-6 h-6" />
            ) : needsUrlKey ? (
              <KeyRound className="w-6 h-6" />
            ) : (
              <Lock className="w-6 h-6" />
            )}
          </div>

          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
            {needsBurnConfirmOnly
              ? '阅后即焚便签'
              : needsUrlKey
                ? '需要链接密钥才能解密'
                : '此便签已端到端加密'}
          </h2>

          <p className="mt-1.5 text-xs sm:text-sm text-zinc-500 dark:text-zinc-400 leading-relaxed">
            {needsBurnConfirmOnly
              ? '此便签已开启阅后即焚，点击查看后将立即从服务器永久擦除。'
              : needsUrlKey
                ? '该便签采用 256-bit 链接片段密钥（#k=...）加密，密钥从未上传到服务器。请使用完整链接打开，或粘贴下方密钥。'
                : '密文在您的浏览器中本地解密，密码永远不会发送到服务器。'}
          </p>
        </div>

        {/* Burn warning banner */}
        {burnAfterRead && (
          <div className="mt-5 p-3.5 rounded-xl bg-rose-500/8 border border-rose-500/20 flex items-start gap-2.5 text-xs text-rose-700 dark:text-rose-300">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <div className="leading-relaxed">
              <strong>阅后即焚提示：</strong>
              {needsPassword
                ? '密码校验通过后，服务端将立即永久销毁此便签及附件（若输错密码则不会销毁）。'
                : '点击下方按钮读取后，服务端会立即永久销毁此便签及所有附件，无法二次访问。'}
              {attachmentCount > 0 && (
                <span className="inline-flex items-center gap-1 ml-1.5 font-medium">
                  <Paperclip className="w-3 h-3" />含 {attachmentCount} 个加密附件
                </span>
              )}
            </div>
          </div>
        )}

        {/* Forms */}
        {needsPassword && (
          <form onSubmit={handlePasswordSubmit} className="mt-5 space-y-3.5">
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="请输入解锁密码"
                autoFocus
                disabled={isProcessing}
                className="w-full h-11 pl-3.5 pr-10 rounded-xl bg-zinc-50 dark:bg-zinc-950/70 border border-zinc-200 dark:border-zinc-800 focus:border-teal-600 dark:focus:border-teal-500 focus:ring-2 focus:ring-teal-500/15 outline-none text-sm text-zinc-900 dark:text-zinc-100 transition-all"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 cursor-pointer"
                tabIndex={-1}
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>

            {error && (
              <p className="text-xs text-rose-500 px-0.5">{error}</p>
            )}

            <button
              type="submit"
              disabled={!password.trim() || isProcessing}
              className={`w-full h-11 rounded-xl font-medium text-sm flex items-center justify-center gap-2 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
                burnAfterRead
                  ? 'bg-rose-600 hover:bg-rose-700 text-white'
                  : 'bg-teal-700 hover:bg-teal-800 dark:bg-teal-600 dark:hover:bg-teal-500 text-white'
              }`}
            >
              {isProcessing ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  正在本地派生密钥 ({(kdfIterations / 1000).toFixed(0)}k PBKDF2)…
                </>
              ) : burnAfterRead ? (
                <>
                  <Flame className="w-4 h-4" />
                  解密查看并永久销毁
                </>
              ) : (
                <>
                  <ShieldCheck className="w-4 h-4" />
                  本地解密打开
                </>
              )}
            </button>
          </form>
        )}

        {needsUrlKey && (
          <form onSubmit={handleManualKeySubmit} className="mt-5 space-y-3.5">
            <input
              type="text"
              value={manualKey}
              onChange={(e) => setManualKey(e.target.value)}
              placeholder="粘贴包含 #k=... 的完整链接或 43 位密钥"
              autoFocus
              disabled={isProcessing}
              className="w-full h-11 px-3.5 rounded-xl bg-zinc-50 dark:bg-zinc-950/70 border border-zinc-200 dark:border-zinc-800 focus:border-teal-600 dark:focus:border-teal-500 focus:ring-2 focus:ring-teal-500/15 outline-none text-xs font-mono text-zinc-900 dark:text-zinc-100 transition-all"
            />
            {error && <p className="text-xs text-rose-500 px-0.5">{error}</p>}
            <button
              type="submit"
              disabled={!manualKey.trim() || isProcessing}
              className="w-full h-11 rounded-xl bg-teal-700 hover:bg-teal-800 dark:bg-teal-600 dark:hover:bg-teal-500 text-white font-medium text-sm flex items-center justify-center gap-2 transition-colors cursor-pointer disabled:opacity-50"
            >
              {isProcessing ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <KeyRound className="w-4 h-4" />
              )}
              使用密钥解密
            </button>
          </form>
        )}

        {needsBurnConfirmOnly && (
          <div className="mt-5 space-y-3">
            {error && <p className="text-xs text-rose-500 text-center">{error}</p>}
            <button
              type="button"
              onClick={onConfirmBurnConsume}
              disabled={isProcessing}
              className="w-full h-11 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-medium text-sm flex items-center justify-center gap-2 transition-colors cursor-pointer disabled:opacity-50"
            >
              {isProcessing ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  正在提取并销毁…
                </>
              ) : (
                <>
                  <Flame className="w-4 h-4" />
                  确认查看并立即销毁
                </>
              )}
            </button>
          </div>
        )}

        {/* Meta footer */}
        <div className="mt-6 pt-4 border-t border-zinc-100 dark:border-zinc-800/80 flex items-center justify-between text-[11px] text-zinc-400 dark:text-zinc-500">
          <span>
            {encryptionMode === 'password'
              ? `AES-256-GCM · PBKDF2 ${(kdfIterations / 1000).toFixed(0)}k`
              : encryptionMode === 'url-key'
                ? 'AES-256-GCM · 256-bit URL Key'
                : '服务端静态加密'}
          </span>
          <span>{formatExpiryCountdown(expiresAt)}</span>
        </div>
      </div>
    </div>
  );
}
