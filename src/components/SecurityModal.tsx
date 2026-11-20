import { useEffect, useState, type FormEvent } from 'react';
import {
  AlertTriangle,
  Check,
  Clock,
  Copy,
  Eye,
  EyeOff,
  Flame,
  KeyRound,
  Loader2,
  Lock,
  LockOpen,
  ShieldCheck,
  ShieldOff,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';
import type { CryptoSnapshot, EncryptionMode } from '../types';
import { measurePasswordStrength } from '../lib/crypto';
import { formatExpiryCountdown, TTL_OPTIONS } from '../lib/slug';

interface SecurityModalProps {
  open: boolean;
  onClose: () => void;
  slug: string;
  currentMode: EncryptionMode;
  readOnly: boolean;
  burnAfterRead: boolean;
  expiresAt: number | null;
  noteExists: boolean;
  burnedNow: boolean;
  hasAttachments: boolean;
  snapshot: CryptoSnapshot | null;
  onApplySettings: (settings: {
    mode: EncryptionMode;
    newPassword?: string;
    readOnly: boolean;
    burnAfterRead: boolean;
    ttlSeconds?: number | null;
  }) => Promise<void>;
  onDestroyNote: () => Promise<void>;
  onLockScreen?: () => void;
}

export function SecurityModal({
  open,
  onClose,
  slug,
  currentMode,
  readOnly,
  burnAfterRead,
  expiresAt,
  noteExists,
  burnedNow,
  hasAttachments,
  snapshot,
  onApplySettings,
  onDestroyNote,
  onLockScreen,
}: SecurityModalProps) {
  const [tab, setTab] = useState<'settings' | 'inspector'>('settings');
  const [selectedMode, setSelectedMode] = useState<EncryptionMode>(currentMode);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [nextReadOnly, setNextReadOnly] = useState(readOnly);
  const [nextBurn, setNextBurn] = useState(burnAfterRead);
  const [selectedTtl, setSelectedTtl] = useState<number | null | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [confirmDestroy, setConfirmDestroy] = useState(false);
  const [destroying, setDestroying] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setSelectedMode(currentMode);
      setNextReadOnly(readOnly);
      setNextBurn(burnAfterRead);
      setSelectedTtl(undefined);
      setPassword('');
      setConfirmPassword('');
      setFormError('');
      setConfirmDestroy(false);
    }
  }, [open, currentMode, readOnly, burnAfterRead]);

  if (!open) return null;

  const strength = measurePasswordStrength(password);
  const isChangingKey =
    selectedMode !== currentMode || (selectedMode === 'password' && password.length > 0);

  const handleCopy = async (label: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(label);
      setTimeout(() => setCopiedField(null), 1600);
    } catch {
      // ignore
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError('');

    if (selectedMode === 'password') {
      const mustProvidePassword = currentMode !== 'password' || password.length > 0;
      if (mustProvidePassword) {
        if (password.length < 4) {
          setFormError('密码至少需要 4 个字符（建议使用 10 位以上强密码）');
          return;
        }
        if (password !== confirmPassword) {
          setFormError('两次输入的密码不一致');
          return;
        }
      }
    }

    setSaving(true);
    try {
      await onApplySettings({
        mode: selectedMode,
        newPassword: selectedMode === 'password' && password ? password : undefined,
        readOnly: nextReadOnly,
        burnAfterRead: nextBurn,
        ttlSeconds: selectedTtl,
      });
      setPassword('');
      setConfirmPassword('');
      onClose();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : '保存安全设置失败');
    } finally {
      setSaving(false);
    }
  };

  const handleDestroy = async () => {
    setDestroying(true);
    try {
      await onDestroyNote();
      onClose();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : '销毁失败');
    } finally {
      setDestroying(false);
      setConfirmDestroy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-zinc-950/45 backdrop-blur-xs"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-xl max-h-[90vh] flex flex-col paper-sheet rounded-2xl overflow-hidden animate-fade-in-up">
        {/* Modal Header */}
        <div className="px-5 py-4 border-b border-zinc-200/80 dark:border-zinc-800 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-teal-500/10 text-teal-700 dark:text-teal-400 flex items-center justify-center">
              <ShieldCheck className="w-4.5 h-4.5" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
                加密与安全中心
              </h3>
              <p className="text-[11px] font-mono text-zinc-400 dark:text-zinc-500">
                /{slug}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tabs */}
        <div className="px-5 pt-3 flex items-center gap-1 border-b border-zinc-200/70 dark:border-zinc-800/80">
          <button
            type="button"
            onClick={() => setTab('settings')}
            className={`px-3.5 py-2 text-xs font-medium border-b-2 transition-colors cursor-pointer ${
              tab === 'settings'
                ? 'border-teal-600 text-teal-700 dark:text-teal-400'
                : 'border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
            }`}
          >
            安全与权限设置
          </button>
          <button
            type="button"
            onClick={() => setTab('inspector')}
            className={`px-3.5 py-2 text-xs font-medium border-b-2 transition-colors cursor-pointer inline-flex items-center gap-1.5 ${
              tab === 'inspector'
                ? 'border-teal-600 text-teal-700 dark:text-teal-400'
                : 'border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
            }`}
          >
            <Terminal className="w-3.5 h-3.5" />
            零知识密文检查器
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5">
          {tab === 'settings' ? (
            burnedNow ? (
              <div className="text-center py-8 text-sm text-zinc-500 dark:text-zinc-400">
                此便签已触发阅后即焚并从服务器擦除，无法修改安全设置。
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-5">
                {/* Encryption Mode Picker */}
                <div>
                  <label className="block text-xs font-medium text-zinc-600 dark:text-zinc-300 mb-2">
                    加密模式
                  </label>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                    {[
                      {
                        id: 'password' as EncryptionMode,
                        title: '密码端到端加密',
                        desc: 'PBKDF2 60万次 + AES-256-GCM',
                        icon: Lock,
                      },
                      {
                        id: 'url-key' as EncryptionMode,
                        title: '链接密钥 E2EE',
                        desc: '256-bit 密钥藏于 #k= 片段',
                        icon: KeyRound,
                      },
                      {
                        id: 'none' as EncryptionMode,
                        title: '便捷跨端同步',
                        desc: '免密码直达 · 服务端静态加密',
                        icon: ShieldOff,
                      },
                    ].map((opt) => {
                      const Icon = opt.icon;
                      const active = selectedMode === opt.id;
                      return (
                        <button
                          key={opt.id}
                          type="button"
                          onClick={() => {
                            setSelectedMode(opt.id);
                            setFormError('');
                          }}
                          className={`text-left p-3 rounded-xl border transition-all cursor-pointer ${
                            active
                              ? 'border-teal-600 dark:border-teal-500 bg-teal-500/8 ring-1 ring-teal-500/20'
                              : 'border-zinc-200 dark:border-zinc-800 hover:border-zinc-300 dark:hover:border-zinc-700 bg-zinc-50/50 dark:bg-zinc-900/40'
                          }`}
                        >
                          <div className="flex items-center gap-2 mb-1">
                            <Icon
                              className={`w-3.5 h-3.5 ${
                                active
                                  ? 'text-teal-700 dark:text-teal-400'
                                  : 'text-zinc-400'
                              }`}
                            />
                            <span className="text-xs font-semibold text-zinc-900 dark:text-zinc-100">
                              {opt.title}
                            </span>
                          </div>
                          <p className="text-[11px] text-zinc-500 dark:text-zinc-400 leading-snug">
                            {opt.desc}
                          </p>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Password Fields */}
                {selectedMode === 'password' && (
                  <div className="p-4 rounded-xl bg-zinc-50 dark:bg-zinc-900/60 border border-zinc-200/80 dark:border-zinc-800 space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-zinc-700 dark:text-zinc-200">
                        {currentMode === 'password' ? '修改访问密码（留空则保持原密码）' : '设置访问密码'}
                      </span>
                      <span className="text-[11px] text-zinc-400">无法找回，请妥善记忆</span>
                    </div>

                    <div className="relative">
                      <input
                        type={showPw ? 'text' : 'password'}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder={currentMode === 'password' ? '输入新密码（可选）' : '输入访问密码'}
                        className="w-full h-10 pl-3 pr-9 rounded-lg bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 focus:border-teal-600 outline-none text-sm"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPw((v) => !v)}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600 cursor-pointer"
                      >
                        {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>

                    {password.length > 0 && (
                      <>
                        <input
                          type={showPw ? 'text' : 'password'}
                          value={confirmPassword}
                          onChange={(e) => setConfirmPassword(e.target.value)}
                          placeholder="再次确认密码"
                          className="w-full h-10 px-3 rounded-lg bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 focus:border-teal-600 outline-none text-sm"
                        />
                        <div className="space-y-1">
                          <div className="grid grid-cols-4 gap-1.5">
                            {[1, 2, 3, 4].map((level) => (
                              <div
                                key={level}
                                className={`h-1 rounded-full transition-colors ${
                                  strength.score >= level
                                    ? strength.barClass
                                    : 'bg-zinc-200 dark:bg-zinc-800'
                                }`}
                              />
                            ))}
                          </div>
                          <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                            强度：{strength.label}
                          </p>
                        </div>
                      </>
                    )}
                  </div>
                )}

                {isChangingKey && hasAttachments && (
                  <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/25 flex items-start gap-2 text-xs text-amber-800 dark:text-amber-300">
                    <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                    <span>
                      更换加密模式或密码后，旧密钥加密的附件将无法使用新密钥解密，系统会自动清理旧附件以防残留无法读取的密文。
                    </span>
                  </div>
                )}

                {/* TTL Picker */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-xs font-medium text-zinc-600 dark:text-zinc-300 flex items-center gap-1.5">
                      <Clock className="w-3.5 h-3.5" />
                      自动销毁时间
                    </label>
                    <span className="text-[11px] text-zinc-400">
                      当前：{formatExpiryCountdown(expiresAt)}
                    </span>
                  </div>
                  <div className="grid grid-cols-3 sm:grid-cols-6 gap-1.5">
                    {TTL_OPTIONS.map((opt) => {
                      const active = selectedTtl === opt.value;
                      return (
                        <button
                          key={opt.shortLabel}
                          type="button"
                          onClick={() => setSelectedTtl(opt.value)}
                          className={`py-2 px-2 rounded-lg text-xs font-medium border transition-colors cursor-pointer ${
                            active
                              ? 'border-teal-600 bg-teal-500/10 text-teal-800 dark:text-teal-300'
                              : 'border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100/70 dark:hover:bg-zinc-800/70'
                          }`}
                        >
                          {opt.shortLabel}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Toggles: Read-only & Burn after reading */}
                <div className="space-y-2.5">
                  <label className="flex items-center justify-between p-3.5 rounded-xl border border-zinc-200/80 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-900/40 cursor-pointer">
                    <div className="pr-4">
                      <div className="text-xs font-semibold text-zinc-900 dark:text-zinc-100 flex items-center gap-1.5">
                        <LockOpen className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400" />
                        只读保护模式
                      </div>
                      <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-0.5">
                        防止自己或他人误改内容；开启后需在此处关闭才能继续编辑。
                      </p>
                    </div>
                    <input
                      type="checkbox"
                      checked={nextReadOnly}
                      onChange={(e) => setNextReadOnly(e.target.checked)}
                      className="w-4 h-4 accent-teal-600 cursor-pointer"
                    />
                  </label>

                  <label className="flex items-center justify-between p-3.5 rounded-xl border border-zinc-200/80 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-900/40 cursor-pointer">
                    <div className="pr-4">
                      <div className="text-xs font-semibold text-zinc-900 dark:text-zinc-100 flex items-center gap-1.5">
                        <Flame className="w-3.5 h-3.5 text-rose-500" />
                        阅后即焚
                      </div>
                      <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-0.5">
                        下次打开并确认读取后，服务器将立即彻底擦除此便签与所有附件。
                      </p>
                    </div>
                    <input
                      type="checkbox"
                      checked={nextBurn}
                      onChange={(e) => setNextBurn(e.target.checked)}
                      className="w-4 h-4 accent-rose-600 cursor-pointer"
                    />
                  </label>
                </div>

                {formError && (
                  <p className="text-xs text-rose-500 bg-rose-500/8 border border-rose-500/20 rounded-lg px-3 py-2">
                    {formError}
                  </p>
                )}

                {/* Submit row */}
                <div className="flex items-center justify-between pt-2">
                  {currentMode === 'password' && onLockScreen ? (
                    <button
                      type="button"
                      onClick={() => {
                        onClose();
                        onLockScreen();
                      }}
                      className="text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-200 inline-flex items-center gap-1.5 cursor-pointer"
                    >
                      <Lock className="w-3.5 h-3.5" />
                      立即锁定当前页面
                    </button>
                  ) : (
                    <span />
                  )}

                  <button
                    type="submit"
                    disabled={saving}
                    className="px-5 py-2.5 rounded-xl bg-teal-700 hover:bg-teal-800 dark:bg-teal-600 dark:hover:bg-teal-500 text-white text-xs font-medium inline-flex items-center gap-2 transition-colors cursor-pointer disabled:opacity-50"
                  >
                    {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                    {saving ? '正在本地重新加密…' : '应用安全设置'}
                  </button>
                </div>

                {/* Danger zone */}
                {noteExists && (
                  <div className="pt-4 mt-2 border-t border-zinc-200/70 dark:border-zinc-800">
                    {!confirmDestroy ? (
                      <button
                        type="button"
                        onClick={() => setConfirmDestroy(true)}
                        className="text-xs text-rose-600 dark:text-rose-400 hover:underline inline-flex items-center gap-1.5 cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        彻底粉碎此便签与所有附件
                      </button>
                    ) : (
                      <div className="p-3 rounded-xl bg-rose-500/8 border border-rose-500/25 flex items-center justify-between gap-3">
                        <span className="text-xs text-rose-700 dark:text-rose-300">
                          确定永久删除？删除后无法恢复。
                        </span>
                        <div className="flex items-center gap-2 shrink-0">
                          <button
                            type="button"
                            onClick={() => setConfirmDestroy(false)}
                            className="px-2.5 py-1 rounded-lg text-xs text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 cursor-pointer"
                          >
                            取消
                          </button>
                          <button
                            type="button"
                            onClick={handleDestroy}
                            disabled={destroying}
                            className="px-3 py-1 rounded-lg text-xs bg-rose-600 hover:bg-rose-700 text-white font-medium cursor-pointer disabled:opacity-50"
                          >
                            {destroying ? '粉碎中…' : '确认粉碎'}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </form>
            )
          ) : (
            /* Crypto Inspector Tab */
            <div className="space-y-4">
              <div className="p-4 rounded-xl bg-teal-500/8 border border-teal-500/20 text-xs text-teal-900 dark:text-teal-200 leading-relaxed">
                {currentMode === 'none' ? (
                  <>
                    当前处于<strong>便捷跨端同步模式</strong>：文本在服务端落盘时使用服务端主密钥进行 AES-256-GCM 静态加密，但浏览器与服务器间未启用零知识密码加密。如需连服务器管理员也无法查看，请在「安全与权限设置」中开启<strong>密码端到端加密</strong>或<strong>链接密钥 E2EE</strong>。
                  </>
                ) : (
                  <>
                    <strong>零知识端到端加密已激活：</strong>您的明文仅存在于当前浏览器内存中。以下展示的是实际发送并存储在服务器数据库里的原始认证密文与加密参数——没有您的密码或 URL 片段密钥，服务端无法还原任何一个字符。
                  </>
                )}
              </div>

              {snapshot ? (
                <div className="space-y-3 font-mono text-xs">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    <div className="p-3 rounded-xl bg-zinc-50 dark:bg-zinc-900/70 border border-zinc-200/80 dark:border-zinc-800">
                      <div className="text-[10px] uppercase tracking-wider text-zinc-400 mb-1">
                        对称加密算法
                      </div>
                      <div className="text-zinc-800 dark:text-zinc-200 font-medium">
                        {snapshot.algorithm}
                      </div>
                    </div>
                    <div className="p-3 rounded-xl bg-zinc-50 dark:bg-zinc-900/70 border border-zinc-200/80 dark:border-zinc-800">
                      <div className="text-[10px] uppercase tracking-wider text-zinc-400 mb-1">
                        密钥派生与域隔离
                      </div>
                      <div className="text-zinc-800 dark:text-zinc-200 font-medium">
                        {snapshot.kdf}
                      </div>
                    </div>
                  </div>

                  <div className="p-3 rounded-xl bg-zinc-50 dark:bg-zinc-900/70 border border-zinc-200/80 dark:border-zinc-800">
                    <div className="text-[10px] uppercase tracking-wider text-zinc-400 mb-1">
                      AAD (防密文替换绑定数据)
                    </div>
                    <div className="text-zinc-700 dark:text-zinc-300 break-all">
                      {snapshot.aad}
                    </div>
                  </div>

                  {snapshot.iv && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                      <div className="p-3 rounded-xl bg-zinc-50 dark:bg-zinc-900/70 border border-zinc-200/80 dark:border-zinc-800">
                        <div className="text-[10px] uppercase tracking-wider text-zinc-400 mb-1">
                          本次随机 96-bit IV (每次保存刷新)
                        </div>
                        <div className="text-zinc-700 dark:text-zinc-300 break-all">
                          {snapshot.iv}
                        </div>
                      </div>
                      <div className="p-3 rounded-xl bg-zinc-50 dark:bg-zinc-900/70 border border-zinc-200/80 dark:border-zinc-800">
                        <div className="text-[10px] uppercase tracking-wider text-zinc-400 mb-1">
                          128-bit KDF Salt
                        </div>
                        <div className="text-zinc-700 dark:text-zinc-300 break-all">
                          {snapshot.salt || '—'}
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="p-3 rounded-xl bg-zinc-950 text-zinc-200 border border-zinc-800">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-[10px] uppercase tracking-wider text-zinc-400">
                        服务端实际存储载荷 ({snapshot.ciphertextBytes} bytes)
                      </span>
                      <button
                        type="button"
                        onClick={() => handleCopy('cipher', snapshot.ciphertextPreview)}
                        className="inline-flex items-center gap-1 text-[11px] text-teal-400 hover:text-teal-300 cursor-pointer"
                      >
                        {copiedField === 'cipher' ? (
                          <>
                            <Check className="w-3 h-3" /> 已复制
                          </>
                        ) : (
                          <>
                            <Copy className="w-3 h-3" /> 复制密文
                          </>
                        )}
                      </button>
                    </div>
                    <div className="max-h-36 overflow-y-auto break-all text-[11px] leading-relaxed text-emerald-300/90">
                      {snapshot.ciphertextPreview}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="py-10 text-center text-xs text-zinc-400">
                  输入内容并首次保存后，此处将实时显示服务端收到的原始密文与 IV/Salt 参数。
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
