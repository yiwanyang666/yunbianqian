import { useEffect, useRef, useState } from 'react';
import { Check, Copy, Eye, KeyRound, Lock, QrCode, ShieldCheck, X } from 'lucide-react';
import type { EncryptionMode } from '../types';
import { buildNoteUrl } from '../lib/slug';

interface ShareModalProps {
  open: boolean;
  onClose: () => void;
  slug: string;
  mode: EncryptionMode;
  urlKey: string | null;
  burnAfterRead: boolean;
}

export function ShareModal({
  open,
  onClose,
  slug,
  mode,
  urlKey,
  burnAfterRead,
}: ShareModalProps) {
  const [readOnlyLink, setReadOnlyLink] = useState(false);
  const [includeKey, setIncludeKey] = useState(true);
  const [copied, setCopied] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const shareUrl = buildNoteUrl(slug, {
    urlKey: mode === 'url-key' && includeKey ? urlKey : null,
    readOnlyParam: readOnlyLink,
  });

  useEffect(() => {
    if (!open || !canvasRef.current) return;
    let cancelled = false;
    import('qrcode').then((QRCode) => {
      if (cancelled || !canvasRef.current) return;
      QRCode.toCanvas(
        canvasRef.current,
        shareUrl,
        {
          width: 196,
          margin: 2,
          color: {
            dark: '#18181b',
            light: '#ffffff',
          },
          errorCorrectionLevel: 'M',
        },
        () => {}
      );
    });
    return () => {
      cancelled = true;
    };
  }, [open, shareUrl]);

  if (!open) return null;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // ignore
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-zinc-950/45 backdrop-blur-xs"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md paper-sheet rounded-2xl overflow-hidden animate-fade-in-up">
        <div className="px-5 py-4 border-b border-zinc-200/80 dark:border-zinc-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <QrCode className="w-4.5 h-4.5 text-teal-600 dark:text-teal-400" />
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
              跨端分享与扫码
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {/* Local QR Code */}
          <div className="flex flex-col items-center">
            <div className="p-3 bg-white rounded-2xl border border-zinc-200 shadow-xs">
              <canvas ref={canvasRef} className="block rounded-lg" />
            </div>
            <p className="mt-2.5 text-[11px] text-zinc-400 dark:text-zinc-500 flex items-center gap-1">
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-500" />
              二维码 100% 在本机浏览器生成，链接与密钥不经第三方
            </p>
          </div>

          {/* Share Options */}
          <div className="space-y-2">
            <label className="flex items-center justify-between px-3 py-2.5 rounded-xl bg-zinc-50 dark:bg-zinc-900/60 border border-zinc-200/80 dark:border-zinc-800 cursor-pointer">
              <span className="text-xs text-zinc-700 dark:text-zinc-300 flex items-center gap-2">
                <Eye className="w-3.5 h-3.5 text-zinc-400" />
                以只读预览视图打开 (?ro=1)
              </span>
              <input
                type="checkbox"
                checked={readOnlyLink}
                onChange={(e) => setReadOnlyLink(e.target.checked)}
                className="w-4 h-4 accent-teal-600 cursor-pointer"
              />
            </label>

            {mode === 'url-key' && urlKey && (
              <label className="flex items-center justify-between px-3 py-2.5 rounded-xl bg-zinc-50 dark:bg-zinc-900/60 border border-zinc-200/80 dark:border-zinc-800 cursor-pointer">
                <span className="text-xs text-zinc-700 dark:text-zinc-300 flex items-center gap-2">
                  <KeyRound className="w-3.5 h-3.5 text-emerald-500" />
                  链接中包含解密密钥 (#k=...)
                </span>
                <input
                  type="checkbox"
                  checked={includeKey}
                  onChange={(e) => setIncludeKey(e.target.checked)}
                  className="w-4 h-4 accent-teal-600 cursor-pointer"
                />
              </label>
            )}
          </div>

          {/* Copyable URL */}
          <div className="flex items-center gap-2">
            <input
              type="text"
              readOnly
              value={shareUrl}
              onFocus={(e) => e.currentTarget.select()}
              className="flex-1 min-w-0 h-10 px-3 rounded-xl bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-xs font-mono text-zinc-700 dark:text-zinc-300 outline-none"
            />
            <button
              type="button"
              onClick={handleCopy}
              className="h-10 px-4 rounded-xl bg-zinc-900 hover:bg-zinc-800 dark:bg-zinc-100 dark:hover:bg-white text-white dark:text-zinc-900 text-xs font-medium inline-flex items-center gap-1.5 transition-colors cursor-pointer shrink-0"
            >
              {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              {copied ? '已复制' : '复制链接'}
            </button>
          </div>

          {/* Privacy Context Hint */}
          <div className="p-3 rounded-xl bg-zinc-50 dark:bg-zinc-900/50 border border-zinc-200/70 dark:border-zinc-800/80 text-[11px] text-zinc-500 dark:text-zinc-400 leading-relaxed flex items-start gap-2">
            <Lock className="w-3.5 h-3.5 shrink-0 mt-0.5 text-teal-600 dark:text-teal-400" />
            <span>
              {mode === 'password'
                ? '此便签受密码端到端保护，分享链接不含密码，请通过其他通道单独告知对方解锁密码。'
                : mode === 'url-key'
                  ? 'URL 片段 #k=... 包含 256-bit 解密密钥，浏览器不会将其发送给服务器；请仅分享给信任的人。'
                  : '当前为便捷同步模式，知道链接的人即可访问。如需私密传输，请开启加密。'}
              {burnAfterRead && '（已开启阅后即焚：首次读取后即永久销毁）'}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
