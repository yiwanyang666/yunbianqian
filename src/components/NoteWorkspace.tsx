import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Check,
  Cloud,
  CloudOff,
  Columns2,
  Copy,
  Download,
  Eye,
  Flame,
  KeyRound,
  Loader2,
  Lock,
  Maximize2,
  Minimize2,
  Moon,
  Paperclip,
  PenLine,
  RefreshCw,
  Save,
  Share2,
  ShieldAlert,
  ShieldCheck,
  Sun,
  UploadCloud,
} from 'lucide-react';
import type {
  AttachmentMeta,
  AttachmentRecord,
  CryptoSession,
  CryptoSnapshot,
  EditorViewMode,
  EncryptionMode,
  NotePayload,
  ServerNoteResponse,
  ThemeMode,
} from '../types';
import {
  ApiError,
  consumeBurnNote,
  deleteAttachment,
  deleteNote,
  downloadAttachmentBytes,
  fetchNote,
  saveNote,
  subscribeNoteEvents,
  uploadAttachment,
} from '../lib/api';
import {
  base64ToBytes,
  buildNoteAad,
  DEFAULT_PBKDF2_ITERATIONS,
  decryptFileBytes,
  decryptFileMeta,
  decryptNotePayload,
  deriveKeysFromPassword,
  deriveKeysFromUrlKey,
  encryptFileForUpload,
  encryptNotePayload,
  generateSaltBase64,
  generateUrlKey,
  isWebCryptoAvailable,
} from '../lib/crypto';
import {
  formatExpiryCountdown,
  formatRelativeTime,
  parseUrlKeyFromHash,
} from '../lib/slug';
import { loadWideEditor, saveWideEditor } from '../lib/storage';

const VaultUnlockCard = lazy(() =>
  import('./VaultUnlockCard').then((m) => ({ default: m.VaultUnlockCard }))
);
const SecurityModal = lazy(() =>
  import('./SecurityModal').then((m) => ({ default: m.SecurityModal }))
);
const ShareModal = lazy(() =>
  import('./ShareModal').then((m) => ({ default: m.ShareModal }))
);
const AttachmentsDrawer = lazy(() =>
  import('./AttachmentsDrawer').then((m) => ({ default: m.AttachmentsDrawer }))
);

const MAX_CIPHERTEXT_PREVIEW_CHARS = 4096;

interface NoteWorkspaceProps {
  slug: string;
  theme: ThemeMode;
  onToggleTheme: () => void;
  onBackHome: () => void;
  onNoteVisited: (slug: string, mode: EncryptionMode) => void;
  onToast: (message: string, type?: 'success' | 'error' | 'info' | 'warning') => void;
}

type SyncState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error' | 'conflict';

export function NoteWorkspace({
  slug,
  theme,
  onToggleTheme,
  onBackHome,
  onNoteVisited,
  onToast,
}: NoteWorkspaceProps) {
  const clientIdRef = useRef<string>(
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2)
  );

  // Loading & Lock state
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [locked, setLocked] = useState(false);
  const [serverMeta, setServerMeta] = useState<ServerNoteResponse | null>(null);
  const [unlockProcessing, setUnlockProcessing] = useState(false);
  const [unlockError, setUnlockError] = useState('');
  const [shakeKey, setShakeKey] = useState(0);

  // Note content & metadata
  const [noteExists, setNoteExists] = useState(false);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [version, setVersion] = useState<number>(0);
  const [readOnly, setReadOnly] = useState(false);
  const [burnAfterRead, setBurnAfterRead] = useState(false);
  const [burnedNow, setBurnedNow] = useState(false);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  // Crypto session & inspector snapshot
  const [cryptoSession, setCryptoSession] = useState<CryptoSession>({
    mode: 'none',
    encKey: null,
    authVerifier: null,
    salt: null,
    kdfIterations: DEFAULT_PBKDF2_ITERATIONS,
    urlKey: null,
  });
  const [cryptoSnapshot, setCryptoSnapshot] = useState<CryptoSnapshot | null>(null);

  // Attachments
  const [attachments, setAttachments] = useState<AttachmentRecord[]>([]);
  const [attachmentsOpen, setAttachmentsOpen] = useState(false);
  const [uploadingFile, setUploadingFile] = useState(false);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [draggingOverPage, setDraggingOverPage] = useState(false);

  // UI & Sync state
  const isReadOnlyQuery = useMemo(
    () => new URLSearchParams(window.location.search).get('ro') === '1',
    []
  );
  const [viewMode, setViewMode] = useState<EditorViewMode>(isReadOnlyQuery ? 'preview' : 'edit');
  const [wideMode, setWideMode] = useState<boolean>(() => loadWideEditor());
  const [syncState, setSyncState] = useState<SyncState>('idle');
  const [remoteUpdateAvailable, setRemoteUpdateAvailable] = useState(false);
  const [sseConnected, setSseConnected] = useState(false);
  const [securityOpen, setSecurityOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [copiedSlug, setCopiedSlug] = useState(false);
  const [copiedText, setCopiedText] = useState(false);

  // Refs for latest values inside timers/callbacks
  const dirtyRef = useRef(false);
  const saveTimerRef = useRef<number | null>(null);
  const sessionRef = useRef<CryptoSession>(cryptoSession);
  sessionRef.current = cryptoSession;
  const titleRef = useRef(title);
  titleRef.current = title;
  const contentRef = useRef(content);
  contentRef.current = content;
  const versionRef = useRef(version);
  versionRef.current = version;
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const burnRef = useRef(burnAfterRead);
  burnRef.current = burnAfterRead;

  const webCryptoOk = isWebCryptoAvailable();

  const buildSnapshot = useCallback(
    (
      mode: EncryptionMode,
      rawCiphertext: string,
      iv: string | null,
      salt: string | null,
      kdfIterations: number
    ): CryptoSnapshot => {
      const bytes = new TextEncoder().encode(rawCiphertext).length;
      const preview =
        rawCiphertext.length > MAX_CIPHERTEXT_PREVIEW_CHARS
          ? `${rawCiphertext.slice(0, MAX_CIPHERTEXT_PREVIEW_CHARS)}… (已省略剩余 ${rawCiphertext.length - MAX_CIPHERTEXT_PREVIEW_CHARS} 字符以节省内存)`
          : rawCiphertext;
      if (mode === 'password') {
        return {
          mode,
          algorithm: 'AES-256-GCM (96-bit Random IV + 128-bit Auth Tag)',
          kdf: `PBKDF2-HMAC-SHA256 (${kdfIterations.toLocaleString()} 次) + HKDF-SHA256`,
          aad: buildNoteAad(slug),
          iv,
          salt,
          ciphertextPreview: preview,
          ciphertextBytes: bytes,
        };
      }
      if (mode === 'url-key') {
        return {
          mode,
          algorithm: 'AES-256-GCM (96-bit Random IV + 128-bit Auth Tag)',
          kdf: '256-bit URL 片段密钥 (#k=) + HKDF-SHA256 域隔离',
          aad: buildNoteAad(slug),
          iv,
          salt,
          ciphertextPreview: preview,
          ciphertextBytes: bytes,
        };
      }
      return {
        mode,
        algorithm: '服务端落盘 AES-256-GCM 静态加密（未启用浏览器 E2EE）',
        kdf: '无客户端密钥派生',
        aad: `rest:note:${slug}`,
        iv: null,
        salt: null,
        ciphertextPreview: preview,
        ciphertextBytes: bytes,
      };
    },
    [slug]
  );

  const decryptAttachmentsMetadata = useCallback(
    async (
      list: AttachmentRecord[],
      mode: EncryptionMode,
      encKey: CryptoKey | null
    ): Promise<AttachmentRecord[]> => {
      const resolved = await Promise.all(
        list.map(async (att) => {
          try {
            let meta: AttachmentMeta;
            if (att.encrypted && encKey && mode !== 'none') {
              meta = await decryptFileMeta(att.encryptedMeta, encKey, slug, att.id);
            } else {
              meta = JSON.parse(att.encryptedMeta) as AttachmentMeta;
            }
            return { ...att, decryptedMeta: meta };
          } catch {
            return {
              ...att,
              decryptedMeta: {
                name: `加密附件 (${att.id.slice(0, 8)})`,
                type: 'application/octet-stream',
                size: att.sizeBytes,
              },
            };
          }
        })
      );
      return resolved;
    },
    [slug]
  );

  const applyDecryptedNote = useCallback(
    async (
      res: ServerNoteResponse,
      payload: NotePayload,
      session: CryptoSession,
      wasBurnedNow = false
    ) => {
      setTitle(payload.title);
      setContent(payload.content);
      setNoteExists(!wasBurnedNow);
      setVersion(res.version ?? 1);
      setReadOnly(Boolean(res.readOnly) || wasBurnedNow);
      setBurnAfterRead(Boolean(res.burnAfterRead));
      setBurnedNow(wasBurnedNow);
      setExpiresAt(res.expiresAt ?? null);
      setUpdatedAt(res.updatedAt ?? Date.now());
      setCryptoSession(session);
      setCryptoSnapshot(
        res.ciphertext
          ? buildSnapshot(
              session.mode,
              res.ciphertext,
              res.iv ?? null,
              session.salt,
              session.kdfIterations
            )
          : null
      );
      const decryptedAtts = await decryptAttachmentsMetadata(
        res.attachments ?? [],
        session.mode,
        session.encKey
      );
      setAttachments(decryptedAtts);
      setLocked(false);
      setSyncState('saved');
      dirtyRef.current = false;
      setRemoteUpdateAvailable(false);
      onNoteVisited(slug, session.mode);
    },
    [buildSnapshot, decryptAttachmentsMetadata, onNoteVisited, slug]
  );

  // Initial load of note
  const loadNoteFromServer = useCallback(
    async (silent = false) => {
      if (!silent) {
        setLoading(true);
        setLoadError('');
      }
      try {
        const res = await fetchNote(slug);
        setServerMeta(res);

        if (!res.exists) {
          // Brand new note
          const urlKey = parseUrlKeyFromHash();
          if (urlKey && webCryptoOk) {
            const salt = generateSaltBase64();
            const { encKey, authVerifier } = await deriveKeysFromUrlKey(urlKey, salt);
            const session: CryptoSession = {
              mode: 'url-key',
              encKey,
              authVerifier,
              salt,
              kdfIterations: DEFAULT_PBKDF2_ITERATIONS,
              urlKey,
            };
            setCryptoSession(session);
            onNoteVisited(slug, 'url-key');
          } else {
            setCryptoSession({
              mode: 'none',
              encKey: null,
              authVerifier: null,
              salt: null,
              kdfIterations: DEFAULT_PBKDF2_ITERATIONS,
              urlKey: null,
            });
            onNoteVisited(slug, 'none');
          }
          setNoteExists(false);
          setTitle('');
          setContent('');
          setVersion(0);
          setReadOnly(false);
          setBurnAfterRead(false);
          setBurnedNow(false);
          setExpiresAt(null);
          setUpdatedAt(null);
          setAttachments([]);
          setCryptoSnapshot(null);
          setLocked(false);
          setSyncState('idle');
          dirtyRef.current = false;
          return;
        }

        const mode = res.encryptionMode ?? 'none';

        // If burn-after-reading, ALWAYS pause at gate before consuming!
        if (res.burnAfterRead) {
          setLocked(true);
          setUnlockError('');
          return;
        }

        // Normal password note: check if we already hold the unlocked key in memory for silent refresh
        if (mode === 'password') {
          const cur = sessionRef.current;
          if (
            silent &&
            cur.mode === 'password' &&
            cur.encKey &&
            cur.salt === res.salt &&
            res.ciphertext &&
            res.iv
          ) {
            try {
              const payload = await decryptNotePayload(res.ciphertext, res.iv, cur.encKey, slug);
              await applyDecryptedNote(res, payload, cur);
              return;
            } catch {
              // Key changed remotely; require re-unlock
            }
          }
          setLocked(true);
          setUnlockError('');
          return;
        }

        // Normal URL-key note
        if (mode === 'url-key') {
          const urlKey = parseUrlKeyFromHash() || sessionRef.current.urlKey;
          if (!urlKey || !res.salt || !res.ciphertext || !res.iv) {
            setLocked(true);
            setUnlockError('');
            return;
          }
          try {
            const { encKey, authVerifier } = await deriveKeysFromUrlKey(urlKey, res.salt);
            const payload = await decryptNotePayload(res.ciphertext, res.iv, encKey, slug);
            await applyDecryptedNote(res, payload, {
              mode: 'url-key',
              encKey,
              authVerifier,
              salt: res.salt,
              kdfIterations: res.kdfIterations ?? DEFAULT_PBKDF2_ITERATIONS,
              urlKey,
            });
          } catch {
            setLocked(true);
            setUnlockError('链接中的密钥不正确或密文已被篡改，无法解密。');
          }
          return;
        }

        // Normal quick-sync ('none') note
        let payload: NotePayload = { title: '', content: '' };
        if (res.ciphertext) {
          try {
            const parsed = JSON.parse(res.ciphertext);
            payload = {
              title: typeof parsed.title === 'string' ? parsed.title : '',
              content: typeof parsed.content === 'string' ? parsed.content : '',
            };
          } catch {
            payload = { title: '', content: res.ciphertext };
          }
        }
        await applyDecryptedNote(res, payload, {
          mode: 'none',
          encKey: null,
          authVerifier: null,
          salt: null,
          kdfIterations: DEFAULT_PBKDF2_ITERATIONS,
          urlKey: null,
        });
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : '加载便签失败');
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [applyDecryptedNote, onNoteVisited, slug, webCryptoOk]
  );

  useEffect(() => {
    loadNoteFromServer(false);
    return () => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    };
  }, [loadNoteFromServer]);

  // SSE live sync subscription
  useEffect(() => {
    if (loading || burnedNow) return;
    const unsubscribe = subscribeNoteEvents(slug, clientIdRef.current, {
      onConnected: () => setSseConnected(true),
      onError: () => setSseConnected(false),
      onNoteUpdated: (ev) => {
        if (ev.version <= versionRef.current) return;
        if (!dirtyRef.current && !locked) {
          loadNoteFromServer(true).then(() => {
            onToast('已自动同步来自其他设备的最新内容', 'info');
          });
        } else {
          setRemoteUpdateAvailable(true);
        }
      },
      onNoteDeleted: () => {
        onToast('此便签已被其他设备彻底销毁', 'warning');
        setNoteExists(false);
        setTitle('');
        setContent('');
        setAttachments([]);
        setVersion(0);
        setSyncState('idle');
      },
      onNoteBurned: () => {
        onToast('此便签已触发阅后即焚并销毁', 'warning');
        setNoteExists(false);
        setBurnedNow(true);
        setReadOnly(true);
      },
      onAttachmentsUpdated: () => {
        if (!locked && !burnedNow) {
          fetchNote(slug)
            .then(async (res) => {
              if (res.exists && res.attachments) {
                const cur = sessionRef.current;
                const dec = await decryptAttachmentsMetadata(res.attachments, cur.mode, cur.encKey);
                setAttachments(dec);
              }
            })
            .catch(() => {});
        }
      },
    });
    return unsubscribe;
  }, [burnedNow, decryptAttachmentsMetadata, loadNoteFromServer, locked, loading, onToast, slug]);

  // Persist note to server
  const persistNote = useCallback(
    async (options?: { forceOverwrite?: boolean; silentToast?: boolean }) => {
      if (burnedNow) return;
      if (readOnlyRef.current && !options?.forceOverwrite) return;

      const curSession = sessionRef.current;
      const payload: NotePayload = {
        title: titleRef.current,
        content: contentRef.current,
      };

      setSyncState('saving');
      try {
        let ciphertext: string;
        let iv: string | null = null;
        let salt: string | null = curSession.salt;

        if (curSession.mode !== 'none') {
          if (!curSession.encKey) {
            throw new Error('缺少本地加密密钥，请重新解锁');
          }
          const enc = await encryptNotePayload(payload, curSession.encKey, slug);
          ciphertext = enc.ciphertext;
          iv = enc.iv;
        } else {
          ciphertext = JSON.stringify(payload);
        }

        const result = await saveNote({
          slug,
          encryptionMode: curSession.mode,
          ciphertext,
          iv,
          salt,
          kdfIterations: curSession.kdfIterations,
          authVerifier: curSession.authVerifier,
          newAuthVerifier: !noteExists ? curSession.authVerifier : undefined,
          readOnly: readOnlyRef.current,
          burnAfterRead: burnRef.current,
          expectedVersion:
            !options?.forceOverwrite && versionRef.current > 0 ? versionRef.current : undefined,
          clientId: clientIdRef.current,
        });

        setNoteExists(true);
        setVersion(result.version);
        setUpdatedAt(result.updatedAt);
        setExpiresAt(result.expiresAt);
        setSyncState('saved');
        dirtyRef.current = false;
        setRemoteUpdateAvailable(false);
        setCryptoSnapshot(
          buildSnapshot(curSession.mode, ciphertext, iv, salt, curSession.kdfIterations)
        );
        onNoteVisited(slug, curSession.mode);
        if (!options?.silentToast) {
          onToast('已加密并同步到云端', 'success');
        }
      } catch (err) {
        if (err instanceof ApiError && err.code === 'VERSION_CONFLICT') {
          setSyncState('conflict');
          setRemoteUpdateAvailable(true);
          onToast('检测到其他设备有更新，请选择拉取最新或覆盖保存', 'warning');
          return;
        }
        setSyncState('error');
        onToast(err instanceof Error ? err.message : '保存失败', 'error');
      }
    },
    [buildSnapshot, burnedNow, noteExists, onNoteVisited, onToast, slug]
  );

  // Schedule debounced autosave
  const scheduleAutosave = useCallback(() => {
    if (readOnlyRef.current || burnedNow) return;
    dirtyRef.current = true;
    setSyncState('dirty');
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      persistNote({ silentToast: true });
    }, 1000);
  }, [burnedNow, persistNote]);

  // Keyboard shortcut Ctrl+S / Cmd+S
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (!locked && !readOnlyRef.current && !burnedNow) {
          if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
          persistNote({ silentToast: false });
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [burnedNow, locked, persistNote]);

  // Unlock password handler (both normal & burn-after-reading)
  const handleUnlockPassword = async (password: string) => {
    if (!serverMeta || !serverMeta.salt) return;
    setUnlockProcessing(true);
    setUnlockError('');
    try {
      const iters = serverMeta.kdfIterations ?? DEFAULT_PBKDF2_ITERATIONS;
      const { encKey, authVerifier } = await deriveKeysFromPassword(
        password,
        serverMeta.salt,
        iters
      );

      let targetRes = serverMeta;
      let burned = false;

      if (serverMeta.burnAfterRead) {
        // Server verifies authVerifier BEFORE destroying!
        targetRes = await consumeBurnNote(slug, authVerifier);
        burned = true;
      }

      if (!targetRes.ciphertext || !targetRes.iv) {
        throw new Error('缺少加密密文数据');
      }

      const payload = await decryptNotePayload(targetRes.ciphertext, targetRes.iv, encKey, slug);
      await applyDecryptedNote(
        targetRes,
        payload,
        {
          mode: 'password',
          encKey,
          authVerifier,
          salt: serverMeta.salt,
          kdfIterations: iters,
          urlKey: null,
        },
        burned
      );
      if (burned) {
        onToast('便签已解密并从服务器永久销毁', 'warning');
      }
    } catch (err) {
      setShakeKey((k) => k + 1);
      if (err instanceof ApiError) {
        setUnlockError(err.message);
      } else {
        setUnlockError('密码不正确，无法解密（本地 AES-GCM 校验未通过）');
      }
    } finally {
      setUnlockProcessing(false);
    }
  };

  // Manual URL key submission
  const handleSubmitManualUrlKey = async (input: string) => {
    if (!serverMeta || !serverMeta.salt) return;
    setUnlockProcessing(true);
    setUnlockError('');
    try {
      let extractedKey = input.trim();
      const hashIdx = extractedKey.indexOf('#');
      if (hashIdx !== -1) {
        const parsed = parseUrlKeyFromHash(extractedKey.slice(hashIdx));
        if (parsed) extractedKey = parsed;
      }
      const { encKey, authVerifier } = await deriveKeysFromUrlKey(extractedKey, serverMeta.salt);

      let targetRes = serverMeta;
      let burned = false;
      if (serverMeta.burnAfterRead) {
        targetRes = await consumeBurnNote(slug, authVerifier);
        burned = true;
      }
      if (!targetRes.ciphertext || !targetRes.iv) {
        throw new Error('缺少密文数据');
      }
      const payload = await decryptNotePayload(targetRes.ciphertext, targetRes.iv, encKey, slug);

      // Update hash silently so sharing works seamlessly
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#k=${extractedKey}`);

      await applyDecryptedNote(
        targetRes,
        payload,
        {
          mode: 'url-key',
          encKey,
          authVerifier,
          salt: serverMeta.salt,
          kdfIterations: serverMeta.kdfIterations ?? DEFAULT_PBKDF2_ITERATIONS,
          urlKey: extractedKey,
        },
        burned
      );
      if (burned) {
        onToast('便签已解密并从服务器永久销毁', 'warning');
      }
    } catch (err) {
      setShakeKey((k) => k + 1);
      setUnlockError(err instanceof ApiError ? err.message : '链接密钥无效，无法解密');
    } finally {
      setUnlockProcessing(false);
    }
  };

  // Burn-after-reading consume for url-key (with key present) or quick-sync ('none')
  const handleConfirmBurnConsume = async () => {
    if (!serverMeta) return;
    setUnlockProcessing(true);
    setUnlockError('');
    try {
      const mode = serverMeta.encryptionMode ?? 'none';
      if (mode === 'url-key') {
        const urlKey = parseUrlKeyFromHash();
        if (!urlKey || !serverMeta.salt) {
          throw new Error('缺少链接密钥');
        }
        const { encKey, authVerifier } = await deriveKeysFromUrlKey(urlKey, serverMeta.salt);
        const consumed = await consumeBurnNote(slug, authVerifier);
        if (!consumed.ciphertext || !consumed.iv) throw new Error('密文为空');
        const payload = await decryptNotePayload(consumed.ciphertext, consumed.iv, encKey, slug);
        await applyDecryptedNote(
          consumed,
          payload,
          {
            mode: 'url-key',
            encKey,
            authVerifier,
            salt: serverMeta.salt,
            kdfIterations: serverMeta.kdfIterations ?? DEFAULT_PBKDF2_ITERATIONS,
            urlKey,
          },
          true
        );
      } else {
        const consumed = await consumeBurnNote(slug, null);
        let payload: NotePayload = { title: '', content: '' };
        if (consumed.ciphertext) {
          try {
            const p = JSON.parse(consumed.ciphertext);
            payload = { title: p.title || '', content: p.content || '' };
          } catch {
            payload = { title: '', content: consumed.ciphertext };
          }
        }
        await applyDecryptedNote(
          consumed,
          payload,
          {
            mode: 'none',
            encKey: null,
            authVerifier: null,
            salt: null,
            kdfIterations: DEFAULT_PBKDF2_ITERATIONS,
            urlKey: null,
          },
          true
        );
      }
      onToast('已读取并从服务器永久销毁此便签', 'warning');
    } catch (err) {
      setUnlockError(err instanceof Error ? err.message : '读取失败');
    } finally {
      setUnlockProcessing(false);
    }
  };

  // Apply security settings (re-encrypt, change password, toggle readOnly / burn / TTL)
  const handleApplySecuritySettings = async (settings: {
    mode: EncryptionMode;
    newPassword?: string;
    readOnly: boolean;
    burnAfterRead: boolean;
    ttlSeconds?: number | null;
  }) => {
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);

    const prevSession = sessionRef.current;
    let nextSession: CryptoSession = { ...prevSession };
    let newAuthVerifier: string | null | undefined = undefined;
    let clearAttachments = false;

    if (settings.mode === 'password') {
      const mustRekey = prevSession.mode !== 'password' || Boolean(settings.newPassword);
      if (mustRekey) {
        if (!settings.newPassword) throw new Error('请设置访问密码');
        const salt = generateSaltBase64();
        const { encKey, authVerifier } = await deriveKeysFromPassword(
          settings.newPassword,
          salt,
          DEFAULT_PBKDF2_ITERATIONS
        );
        nextSession = {
          mode: 'password',
          encKey,
          authVerifier,
          salt,
          kdfIterations: DEFAULT_PBKDF2_ITERATIONS,
          urlKey: null,
        };
        newAuthVerifier = authVerifier;
        clearAttachments = attachments.length > 0;
        if (window.location.hash) {
          window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
        }
      }
    } else if (settings.mode === 'url-key') {
      if (prevSession.mode !== 'url-key') {
        const urlKey = generateUrlKey();
        const salt = generateSaltBase64();
        const { encKey, authVerifier } = await deriveKeysFromUrlKey(urlKey, salt);
        nextSession = {
          mode: 'url-key',
          encKey,
          authVerifier,
          salt,
          kdfIterations: DEFAULT_PBKDF2_ITERATIONS,
          urlKey,
        };
        newAuthVerifier = authVerifier;
        clearAttachments = attachments.length > 0;
        window.history.replaceState(
          null,
          '',
          `${window.location.pathname}${window.location.search}#k=${urlKey}`
        );
      }
    } else {
      // 'none'
      if (prevSession.mode !== 'none') {
        nextSession = {
          mode: 'none',
          encKey: null,
          authVerifier: null,
          salt: null,
          kdfIterations: DEFAULT_PBKDF2_ITERATIONS,
          urlKey: null,
        };
        newAuthVerifier = null;
        clearAttachments = attachments.length > 0;
        if (window.location.hash) {
          window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
        }
      }
    }

    const payload: NotePayload = { title, content };
    let ciphertext: string;
    let iv: string | null = null;
    if (nextSession.mode !== 'none' && nextSession.encKey) {
      const enc = await encryptNotePayload(payload, nextSession.encKey, slug);
      ciphertext = enc.ciphertext;
      iv = enc.iv;
    } else {
      ciphertext = JSON.stringify(payload);
    }

    const res = await saveNote({
      slug,
      encryptionMode: nextSession.mode,
      ciphertext,
      iv,
      salt: nextSession.salt,
      kdfIterations: nextSession.kdfIterations,
      authVerifier: prevSession.authVerifier,
      newAuthVerifier: !noteExists ? nextSession.authVerifier : newAuthVerifier,
      readOnly: settings.readOnly,
      burnAfterRead: settings.burnAfterRead,
      ttlSeconds: settings.ttlSeconds,
      clientId: clientIdRef.current,
      allowReadOnlyChange: true,
      clearAttachments,
    });

    setCryptoSession(nextSession);
    setNoteExists(true);
    setVersion(res.version);
    setReadOnly(res.readOnly);
    setBurnAfterRead(res.burnAfterRead);
    setExpiresAt(res.expiresAt);
    setUpdatedAt(res.updatedAt);
    setSyncState('saved');
    dirtyRef.current = false;
    if (clearAttachments) setAttachments([]);
    setCryptoSnapshot(
      buildSnapshot(nextSession.mode, ciphertext, iv, nextSession.salt, nextSession.kdfIterations)
    );
    onNoteVisited(slug, nextSession.mode);
    onToast(
      nextSession.mode === 'password'
        ? '密码端到端加密已生效'
        : nextSession.mode === 'url-key'
          ? '链接密钥加密已生效，请妥善保存完整网址'
          : '安全设置已更新',
      'success'
    );
  };

  const handleDestroyNote = async () => {
    await deleteNote(slug, sessionRef.current.authVerifier, clientIdRef.current);
    onToast('便签与所有附件已永久粉碎', 'success');
    onBackHome();
  };

  const handleLockScreenNow = () => {
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    setTitle('');
    setContent('');
    setAttachments([]);
    setCryptoSession({
      mode: 'password',
      encKey: null,
      authVerifier: null,
      salt: null,
      kdfIterations: DEFAULT_PBKDF2_ITERATIONS,
      urlKey: null,
    });
    loadNoteFromServer(false);
    onToast('已清除内存密钥并锁定页面', 'info');
  };

  // Upload files (with client-side E2EE when active)
  const handleUploadFiles = async (fileList: FileList | File[]) => {
    const files = Array.from(fileList);
    if (files.length === 0) return;

    // Ensure note exists before attaching
    if (!noteExists) {
      await persistNote({ silentToast: true });
    }

    const cur = sessionRef.current;
    setUploadingFile(true);
    let successCount = 0;

    try {
      for (const file of files) {
        if (file.size > 25 * 1024 * 1024) {
          onToast(`"${file.name}" 超过 25 MB 限制`, 'error');
          continue;
        }
        const fileId = crypto.randomUUID();
        let bodyBytes: Uint8Array<ArrayBuffer>;
        let metaJson: string;
        let fileIv: string | null = null;
        let encrypted = false;

        if (cur.mode !== 'none' && cur.encKey) {
          const enc = await encryptFileForUpload(file, cur.encKey, slug, fileId);
          bodyBytes = enc.encryptedBytes;
          metaJson = enc.encryptedMetaJson;
          fileIv = enc.fileIv;
          encrypted = true;
        } else {
          bodyBytes = new Uint8Array(await file.arrayBuffer());
          metaJson = JSON.stringify({
            name: file.name,
            type: file.type || 'application/octet-stream',
            size: file.size,
          });
        }

        const created = await uploadAttachment({
          slug,
          fileId,
          bodyBytes,
          metaJson,
          encrypted,
          fileIv,
          authVerifier: cur.authVerifier,
          clientId: clientIdRef.current,
        });

        const withMeta: AttachmentRecord = {
          ...created,
          decryptedMeta: {
            name: file.name,
            type: file.type || 'application/octet-stream',
            size: file.size,
          },
        };
        setAttachments((prev) => [withMeta, ...prev]);
        successCount += 1;
      }

      if (successCount > 0) {
        onToast(
          cur.mode !== 'none'
            ? `已本地加密并上传 ${successCount} 个文件`
            : `已上传 ${successCount} 个文件`,
          'success'
        );
      }
    } catch (err) {
      onToast(err instanceof Error ? err.message : '文件上传失败', 'error');
    } finally {
      setUploadingFile(false);
    }
  };

  // Download & decrypt file
  const handleDownloadAttachment = async (att: AttachmentRecord) => {
    setDownloadingId(att.id);
    try {
      let rawBuffer: ArrayBuffer;
      if (att.inlineDataBase64) {
        rawBuffer = base64ToBytes(att.inlineDataBase64).buffer;
      } else {
        rawBuffer = await downloadAttachmentBytes(slug, att.id);
      }

      let finalBuffer = rawBuffer;
      const cur = sessionRef.current;
      if (att.encrypted) {
        if (!cur.encKey || !att.fileIv) {
          throw new Error('缺少解密密钥或 IV');
        }
        finalBuffer = await decryptFileBytes(rawBuffer, att.fileIv, cur.encKey, slug, att.id);
      }

      const fileName = att.decryptedMeta?.name || `file-${att.id.slice(0, 8)}`;
      const mimeType = att.decryptedMeta?.type || 'application/octet-stream';
      const blob = new Blob([finalBuffer], { type: mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (err) {
      onToast(err instanceof Error ? err.message : '解密下载失败', 'error');
    } finally {
      setDownloadingId(null);
    }
  };

  const handleDeleteAttachment = async (id: string) => {
    try {
      await deleteAttachment(slug, id, sessionRef.current.authVerifier, clientIdRef.current);
      setAttachments((prev) => prev.filter((a) => a.id !== id));
      onToast('附件已删除', 'info');
    } catch (err) {
      onToast(err instanceof Error ? err.message : '删除失败', 'error');
    }
  };

  // Lazy-loaded sanitized Markdown (only parsed when preview/split is visible)
  const [renderedHtml, setRenderedHtml] = useState('');
  const mdRendererRef = useRef<((text: string) => string) | null>(null);

  useEffect(() => {
    if (viewMode === 'edit') return;
    let cancelled = false;
    const renderNow = (fn: (text: string) => string) => {
      if (!cancelled) setRenderedHtml(fn(content));
    };

    if (mdRendererRef.current) {
      const timer = window.setTimeout(() => renderNow(mdRendererRef.current!), viewMode === 'split' ? 90 : 0);
      return () => {
        cancelled = true;
        window.clearTimeout(timer);
      };
    }

    import('../lib/markdown').then((m) => {
      mdRendererRef.current = m.renderSafeMarkdown;
      renderNow(m.renderSafeMarkdown);
    });
    return () => {
      cancelled = true;
    };
  }, [content, viewMode]);

  // Zero-allocation single-pass character & line count
  const stats = useMemo(() => {
    const chars = content.length;
    if (chars === 0) return { chars: 0, lines: 0 };
    let lines = 1;
    for (let i = 0; i < chars; i++) {
      if (content.charCodeAt(i) === 10) lines++;
    }
    return { chars, lines };
  }, [content]);

  const handleCopyAll = async () => {
    const full = title ? `# ${title}\n\n${content}` : content;
    try {
      await navigator.clipboard.writeText(full);
      setCopiedText(true);
      onToast('已复制全文到剪贴板', 'success');
      setTimeout(() => setCopiedText(false), 1600);
    } catch {
      onToast('复制失败，请手动全选复制', 'error');
    }
  };

  const handleExportMarkdown = () => {
    const full = title ? `# ${title}\n\n${content}` : content;
    const blob = new Blob([full], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${title ? title.replace(/[\\/:*?"<>|]/g, '_') : slug}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  };

  const handleCopySlugUrl = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopiedSlug(true);
      onToast('已复制当前便签链接', 'success');
      setTimeout(() => setCopiedSlug(false), 1500);
    } catch {
      // ignore
    }
  };

  const isE2EE = cryptoSession.mode !== 'none';

  return (
    <div
      className="min-h-screen flex flex-col bg-[var(--paper-bg)]"
      onDragOver={(e) => {
        if (!locked && !readOnly && !burnedNow && e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDraggingOverPage(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDraggingOverPage(false);
      }}
      onDrop={(e) => {
        if (!locked && !readOnly && !burnedNow && e.dataTransfer.files.length > 0) {
          e.preventDefault();
          setDraggingOverPage(false);
          handleUploadFiles(e.dataTransfer.files);
        } else {
          setDraggingOverPage(false);
        }
      }}
    >
      {/* Top Floating Workspace Bar */}
      <header className="sticky top-0 z-30 h-14 px-3 sm:px-6 bg-[var(--paper-bg)]/85 backdrop-blur-md border-b border-zinc-200/75 dark:border-zinc-800/80 flex items-center justify-between gap-2">
        {/* Left: Brand & Slug */}
        <div className="flex items-center gap-2 min-w-0">
          <button
            type="button"
            onClick={onBackHome}
            className="w-8 h-8 rounded-lg bg-teal-700 hover:bg-teal-800 dark:bg-teal-600 dark:hover:bg-teal-500 flex items-center justify-center shrink-0 transition-colors cursor-pointer"
            title="返回云便签首页"
          >
            <Lock className="w-4 h-4 text-white" strokeWidth={2.2} />
          </button>

          <button
            type="button"
            onClick={handleCopySlugUrl}
            className="group flex items-center gap-1.5 px-2.5 py-1 rounded-lg hover:bg-zinc-200/60 dark:hover:bg-zinc-800/80 transition-colors min-w-0 cursor-pointer"
            title="点击复制便签完整链接"
          >
            <span className="font-mono text-xs sm:text-sm font-medium text-zinc-800 dark:text-zinc-100 truncate max-w-[120px] sm:max-w-[200px]">
              /{slug}
            </span>
            {copiedSlug ? (
              <Check className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
            ) : (
              <Copy className="w-3 h-3 text-zinc-400 opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
            )}
          </button>

          {/* Security Status Pill */}
          {!locked && !loading && (
            <button
              type="button"
              onClick={() => setSecurityOpen(true)}
              className={`hidden md:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border cursor-pointer shrink-0 ${
                isE2EE
                  ? 'bg-emerald-500/10 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/25 dark:border-emerald-400/30 hover:bg-emerald-500/20'
                  : 'bg-amber-500/10 dark:bg-amber-500/15 text-amber-800 dark:text-amber-300 border-amber-500/25 dark:border-amber-400/30 hover:bg-amber-500/20'
              }`}
              title="点击打开加密与安全中心 / 查看原始密文"
            >
              {cryptoSession.mode === 'password' ? (
                <>
                  <ShieldCheck className="w-3.5 h-3.5" />
                  <span>密码 E2EE</span>
                </>
              ) : cryptoSession.mode === 'url-key' ? (
                <>
                  <KeyRound className="w-3.5 h-3.5" />
                  <span>链接密钥 E2EE</span>
                </>
              ) : (
                <>
                  <ShieldAlert className="w-3.5 h-3.5" />
                  <span>便捷模式 · 点击加密</span>
                </>
              )}
            </button>
          )}
        </div>

        {/* Center: View Mode Segmented Control */}
        {!locked && !loading && !loadError && (
          <div className="hidden sm:flex items-center p-0.5 rounded-xl bg-zinc-200/70 dark:bg-zinc-900/90 border border-zinc-200/80 dark:border-zinc-800">
            {[
              { id: 'edit' as EditorViewMode, label: '编辑', icon: PenLine },
              { id: 'split' as EditorViewMode, label: '分屏', icon: Columns2 },
              { id: 'preview' as EditorViewMode, label: '预览', icon: Eye },
            ].map((m) => {
              const Icon = m.icon;
              const active = viewMode === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setViewMode(m.id)}
                  className={`px-2.5 py-1 rounded-lg text-xs font-medium inline-flex items-center gap-1.5 cursor-pointer ${
                    active
                      ? 'bg-white dark:bg-zinc-700/90 text-zinc-900 dark:text-white shadow-xs'
                      : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-100'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  {m.label}
                </button>
              );
            })}
          </div>
        )}

        {/* Right: Actions */}
        <div className="flex items-center gap-1 sm:gap-1.5">
          {!locked && !loading && !loadError && (
            <>
              {/* Mobile security icon */}
              <button
                type="button"
                onClick={() => setSecurityOpen(true)}
                className={`md:hidden p-2 rounded-lg transition-colors cursor-pointer ${
                  isE2EE
                    ? 'text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10'
                    : 'text-amber-600 dark:text-amber-400 hover:bg-amber-500/10'
                }`}
                title="加密与安全设置"
              >
                {isE2EE ? <ShieldCheck className="w-4 h-4" /> : <ShieldAlert className="w-4 h-4" />}
              </button>

              {/* Attachments */}
              <button
                type="button"
                onClick={() => setAttachmentsOpen(true)}
                className="relative px-2.5 py-1.5 rounded-lg text-xs font-medium text-zinc-600 dark:text-zinc-200 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 inline-flex items-center gap-1.5 cursor-pointer"
                title="加密文件中转站"
              >
                <Paperclip className="w-4 h-4" />
                <span className="hidden lg:inline">文件</span>
                {attachments.length > 0 && (
                  <span className="px-1.5 py-0.2 rounded-full bg-teal-600 text-white text-[10px] font-mono leading-4">
                    {attachments.length}
                  </span>
                )}
              </button>

              {/* Share / QR */}
              {!burnedNow && (
                <button
                  type="button"
                  onClick={() => setShareOpen(true)}
                  className="px-2.5 py-1.5 rounded-lg text-xs font-medium text-zinc-600 dark:text-zinc-200 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 inline-flex items-center gap-1.5 cursor-pointer"
                  title="分享链接与本地二维码"
                >
                  <Share2 className="w-4 h-4" />
                  <span className="hidden lg:inline">分享</span>
                </button>
              )}

              {/* Manual Save / Sync Status Button */}
              {!burnedNow && !readOnly && (
                <button
                  type="button"
                  onClick={() => {
                    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
                    persistNote({ silentToast: false });
                  }}
                  disabled={syncState === 'saving'}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium inline-flex items-center gap-1.5 cursor-pointer ${
                    syncState === 'dirty'
                      ? 'bg-teal-700 hover:bg-teal-800 text-white'
                      : syncState === 'error' || syncState === 'conflict'
                        ? 'bg-rose-600 hover:bg-rose-700 text-white'
                        : 'bg-zinc-200/70 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-100 hover:bg-zinc-300/70 dark:hover:bg-zinc-700'
                  }`}
                  title="保存并加密同步 (Ctrl+S)"
                >
                  {syncState === 'saving' ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : syncState === 'saved' ? (
                    <Cloud className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                  ) : syncState === 'error' || syncState === 'conflict' ? (
                    <CloudOff className="w-3.5 h-3.5" />
                  ) : (
                    <Save className="w-3.5 h-3.5" />
                  )}
                  <span className="hidden sm:inline">
                    {syncState === 'saving'
                      ? '加密中'
                      : syncState === 'dirty'
                        ? '保存'
                        : syncState === 'saved'
                          ? '已同步'
                          : syncState === 'conflict'
                            ? '冲突'
                            : '保存'}
                  </span>
                </button>
              )}

              {/* Wide mode toggle */}
              <button
                type="button"
                onClick={() => {
                  const next = !wideMode;
                  setWideMode(next);
                  saveWideEditor(next);
                }}
                className="hidden xl:flex p-2 rounded-lg text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
                title={wideMode ? '切换专注纸张宽度' : '切换宽屏画布'}
              >
                {wideMode ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
              </button>
            </>
          )}

          {/* Theme toggle */}
          <button
            type="button"
            onClick={onToggleTheme}
            className="p-2 rounded-lg text-zinc-600 hover:text-zinc-900 dark:text-amber-300/90 dark:hover:text-amber-200 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 cursor-pointer"
            title={theme === 'dark' ? '切换晨光纸韵模式' : '切换暗夜曜石模式'}
          >
            {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>
        </div>
      </header>

      {/* Non-HTTPS WebCrypto warning */}
      {!webCryptoOk && (
        <div className="bg-amber-500/12 border-b border-amber-500/25 px-4 py-2 text-xs text-amber-800 dark:text-amber-300 text-center">
          当前环境未启用 HTTPS（非安全上下文），浏览器 Web Crypto API 不可用。请通过 localhost 或 HTTPS 访问以启用端到端加密。
        </div>
      )}

      {/* Drag & drop overlay */}
      {draggingOverPage && (
        <div className="fixed inset-0 z-40 bg-teal-950/30 backdrop-blur-xs flex items-center justify-center pointer-events-none">
          <div className="paper-sheet rounded-2xl px-8 py-6 flex flex-col items-center gap-2 border-2 border-dashed border-teal-500">
            <UploadCloud className="w-9 h-9 text-teal-600 dark:text-teal-400" />
            <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              松开即可{isE2EE ? '本地加密并上传' : '上传'}附件到此便签
            </p>
          </div>
        </div>
      )}

      {/* Main Content Area */}
      {loading ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-zinc-400">
          <Loader2 className="w-6 h-6 animate-spin text-teal-600" />
          <span className="text-xs">正在读取便签…</span>
        </div>
      ) : loadError ? (
        <div className="flex-1 flex flex-col items-center justify-center px-4 text-center">
          <AlertCircle className="w-9 h-9 text-rose-500 mb-3" />
          <p className="text-sm font-medium text-zinc-800 dark:text-zinc-200">{loadError}</p>
          <div className="mt-4 flex items-center gap-2">
            <button
              type="button"
              onClick={() => loadNoteFromServer(false)}
              className="px-4 py-2 rounded-xl bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 text-xs font-medium cursor-pointer"
            >
              重试
            </button>
            <button
              type="button"
              onClick={onBackHome}
              className="px-4 py-2 rounded-xl border border-zinc-200 dark:border-zinc-800 text-xs text-zinc-600 dark:text-zinc-300 cursor-pointer"
            >
              返回首页
            </button>
          </div>
        </div>
      ) : locked && serverMeta ? (
        <Suspense
          fallback={
            <div className="flex-1 flex items-center justify-center text-xs text-zinc-400">
              <Loader2 className="w-5 h-5 animate-spin text-teal-600" />
            </div>
          }
        >
          <VaultUnlockCard
            slug={slug}
            encryptionMode={serverMeta.encryptionMode ?? 'password'}
            burnAfterRead={Boolean(serverMeta.burnAfterRead)}
            hasUrlKeyInHash={Boolean(parseUrlKeyFromHash())}
            kdfIterations={serverMeta.kdfIterations}
            expiresAt={serverMeta.expiresAt}
            attachmentCount={serverMeta.attachmentCount}
            isProcessing={unlockProcessing}
            error={unlockError}
            shakeKey={shakeKey}
            onUnlockPassword={handleUnlockPassword}
            onSubmitManualUrlKey={handleSubmitManualUrlKey}
            onConfirmBurnConsume={handleConfirmBurnConsume}
            onBackHome={onBackHome}
          />
        </Suspense>
      ) : (
        <main className="flex-1 flex flex-col px-3 sm:px-6 py-4 sm:py-6">
          <div
            className={`w-full mx-auto flex-1 flex flex-col transition-all duration-200 ${
              wideMode || viewMode === 'split' ? 'max-w-7xl' : 'max-w-4xl'
            }`}
          >
            {/* Contextual Banners */}
            {burnedNow && (
              <div className="mb-3 px-4 py-3 rounded-xl bg-rose-500/10 border border-rose-500/25 flex flex-wrap items-center justify-between gap-2 text-xs text-rose-700 dark:text-rose-300">
                <div className="flex items-center gap-2">
                  <Flame className="w-4 h-4 shrink-0" />
                  <span>
                    <strong>已阅后即焚：</strong>此便签及附件已从服务器永久擦除，当前内容仅存在于本页内存中。请及时复制或导出保存。
                  </span>
                </div>
                <button
                  type="button"
                  onClick={handleExportMarkdown}
                  className="px-2.5 py-1 rounded-lg bg-rose-600 hover:bg-rose-700 text-white font-medium cursor-pointer"
                >
                  导出备份
                </button>
              </div>
            )}

            {remoteUpdateAvailable && !burnedNow && (
              <div className="mb-3 px-4 py-2.5 rounded-xl bg-teal-500/10 border border-teal-500/25 flex flex-wrap items-center justify-between gap-2 text-xs text-teal-900 dark:text-teal-200">
                <span className="flex items-center gap-2">
                  <RefreshCw className="w-3.5 h-3.5" />
                  检测到其他设备保存了新版本。
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => loadNoteFromServer(true)}
                    className="px-2.5 py-1 rounded-lg bg-teal-700 hover:bg-teal-800 text-white font-medium cursor-pointer"
                  >
                    拉取最新内容
                  </button>
                  <button
                    type="button"
                    onClick={() => persistNote({ forceOverwrite: true })}
                    className="px-2.5 py-1 rounded-lg border border-teal-600/30 hover:bg-teal-500/10 font-medium cursor-pointer"
                  >
                    以本机内容覆盖
                  </button>
                </div>
              </div>
            )}

            {readOnly && !burnedNow && (
              <div className="mb-3 px-4 py-2 rounded-xl bg-zinc-200/60 dark:bg-zinc-800/70 border border-zinc-300/60 dark:border-zinc-700/70 flex items-center justify-between text-xs text-zinc-600 dark:text-zinc-300">
                <span className="flex items-center gap-1.5">
                  <Lock className="w-3.5 h-3.5" />
                  当前便签已开启只读保护，内容不可直接编辑。
                </span>
                <button
                  type="button"
                  onClick={() => setSecurityOpen(true)}
                  className="text-teal-700 dark:text-teal-400 hover:underline font-medium cursor-pointer"
                >
                  管理权限
                </button>
              </div>
            )}

            {/* Mobile view switcher */}
            <div className="sm:hidden mb-3 flex items-center justify-center p-0.5 rounded-xl bg-zinc-200/60 dark:bg-zinc-800/80">
              {(['edit', 'preview'] as EditorViewMode[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setViewMode(m)}
                  className={`flex-1 py-1.5 rounded-lg text-xs font-medium cursor-pointer ${
                    viewMode === m
                      ? 'bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-50 shadow-xs'
                      : 'text-zinc-500'
                  }`}
                >
                  {m === 'edit' ? '编辑' : 'Markdown 预览'}
                </button>
              ))}
            </div>

            {/* Paper Canvas Sheet */}
            <div className="paper-sheet rounded-2xl flex-1 flex flex-col overflow-hidden min-h-[calc(100vh-11.5rem)]">
              {/* Optional Note Title Bar */}
              <div className="px-5 sm:px-8 pt-5 sm:pt-7 pb-3 border-b border-zinc-100 dark:border-zinc-800/70">
                <input
                  type="text"
                  value={title}
                  readOnly={readOnly || burnedNow}
                  onChange={(e) => {
                    setTitle(e.target.value);
                    scheduleAutosave();
                  }}
                  placeholder="无标题便签（可选，同样端到端加密）"
                  className="w-full bg-transparent border-none outline-none text-lg sm:text-xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50 placeholder:text-zinc-300 dark:placeholder:text-zinc-700"
                />
              </div>

              {/* Editor / Split / Preview Body */}
              <div
                className={`flex-1 grid ${
                  viewMode === 'split' ? 'grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-zinc-100 dark:divide-zinc-800/80' : 'grid-cols-1'
                }`}
              >
                {(viewMode === 'edit' || viewMode === 'split') && (
                  <textarea
                    value={content}
                    readOnly={readOnly || burnedNow}
                    onChange={(e) => {
                      setContent(e.target.value);
                      scheduleAutosave();
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Tab' && !readOnly && !burnedNow) {
                        e.preventDefault();
                        const target = e.currentTarget;
                        const start = target.selectionStart;
                        const end = target.selectionEnd;
                        const next = content.slice(0, start) + '  ' + content.slice(end);
                        setContent(next);
                        scheduleAutosave();
                        requestAnimationFrame(() => {
                          target.selectionStart = target.selectionEnd = start + 2;
                        });
                      }
                    }}
                    placeholder="直接输入或粘贴任意文字、代码片段、Markdown 笔记…&#10;&#10;· 停止输入 1 秒后自动加密同步（或按 Ctrl/Cmd + S 立即保存）&#10;· 直接将文件拖拽到此页面即可加密中转&#10;· 点击顶部状态胶囊可设置密码锁、阅后即焚或查看服务端原始密文"
                    className="w-full h-full min-h-[55vh] px-5 sm:px-8 py-5 bg-transparent border-none outline-none resize-none text-[15px] leading-[1.8] text-zinc-800 dark:text-zinc-100 placeholder:text-zinc-400/70 dark:placeholder:text-zinc-600 font-sans selection:bg-teal-500/20"
                    spellCheck={false}
                  />
                )}

                {(viewMode === 'preview' || viewMode === 'split') && (
                  <div
                    className="px-5 sm:px-8 py-5 overflow-y-auto prose-note text-zinc-800 dark:text-zinc-100 bg-zinc-50/35 dark:bg-zinc-950/20"
                    dangerouslySetInnerHTML={{ __html: renderedHtml }}
                  />
                )}
              </div>

              {/* Subtle Bottom Status Bar */}
              <div className="px-4 sm:px-6 py-2.5 border-t border-zinc-100 dark:border-zinc-800/80 bg-zinc-50/50 dark:bg-zinc-900/30 flex flex-wrap items-center justify-between gap-2 text-[11px] text-zinc-400 dark:text-zinc-500">
                <div className="flex flex-wrap items-center gap-3 tabular-nums">
                  <span className="inline-flex items-center gap-1.5">
                    <span
                      className={`w-1.5 h-1.5 rounded-full ${
                        sseConnected ? 'bg-emerald-500' : 'bg-zinc-400'
                      }`}
                    />
                    {sseConnected ? '实时同步已连接' : '离线监听'}
                  </span>
                  <span>{stats.chars} 字符</span>
                  <span className="hidden sm:inline">{stats.lines} 行</span>
                  {updatedAt && (
                    <span className="hidden md:inline">
                      上次同步：{formatRelativeTime(updatedAt)}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => setSecurityOpen(true)}
                    className="hover:text-zinc-700 dark:hover:text-zinc-300 transition-colors cursor-pointer"
                  >
                    {burnAfterRead ? '阅后即焚' : formatExpiryCountdown(expiresAt)}
                  </button>
                </div>

                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={handleCopyAll}
                    className="inline-flex items-center gap-1 hover:text-zinc-700 dark:hover:text-zinc-200 transition-colors cursor-pointer"
                  >
                    {copiedText ? <Check className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3" />}
                    复制全文
                  </button>
                  <button
                    type="button"
                    onClick={handleExportMarkdown}
                    className="inline-flex items-center gap-1 hover:text-zinc-700 dark:hover:text-zinc-200 transition-colors cursor-pointer"
                  >
                    <Download className="w-3 h-3" />
                    导出 .md
                  </button>
                </div>
              </div>
            </div>
          </div>
        </main>
      )}

      {/* Lazy-mounted Modals & Drawers (zero memory/bundle until opened) */}
      <Suspense fallback={null}>
        {securityOpen && (
          <SecurityModal
            open={securityOpen}
            onClose={() => setSecurityOpen(false)}
            slug={slug}
            currentMode={cryptoSession.mode}
            readOnly={readOnly}
            burnAfterRead={burnAfterRead}
            expiresAt={expiresAt}
            noteExists={noteExists}
            burnedNow={burnedNow}
            hasAttachments={attachments.length > 0}
            snapshot={cryptoSnapshot}
            onApplySettings={handleApplySecuritySettings}
            onDestroyNote={handleDestroyNote}
            onLockScreen={cryptoSession.mode === 'password' ? handleLockScreenNow : undefined}
          />
        )}

        {shareOpen && (
          <ShareModal
            open={shareOpen}
            onClose={() => setShareOpen(false)}
            slug={slug}
            mode={cryptoSession.mode}
            urlKey={cryptoSession.urlKey}
            burnAfterRead={burnAfterRead}
          />
        )}

        {attachmentsOpen && (
          <AttachmentsDrawer
            open={attachmentsOpen}
            onClose={() => setAttachmentsOpen(false)}
            attachments={attachments}
            encryptionMode={cryptoSession.mode}
            readOnly={readOnly}
            burnedNow={burnedNow}
            uploading={uploadingFile}
            downloadingId={downloadingId}
            onUploadFiles={handleUploadFiles}
            onDownload={handleDownloadAttachment}
            onDelete={handleDeleteAttachment}
          />
        )}
      </Suspense>
    </div>
  );
}
