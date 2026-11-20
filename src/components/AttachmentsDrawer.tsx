import { useRef, useState } from 'react';
import {
  Download,
  File,
  FileLock2,
  Loader2,
  Paperclip,
  ShieldCheck,
  Trash2,
  UploadCloud,
  X,
} from 'lucide-react';
import type { AttachmentRecord, EncryptionMode } from '../types';
import { formatBytes, formatRelativeTime } from '../lib/slug';

interface AttachmentsDrawerProps {
  open: boolean;
  onClose: () => void;
  attachments: AttachmentRecord[];
  encryptionMode: EncryptionMode;
  readOnly: boolean;
  burnedNow: boolean;
  uploading: boolean;
  downloadingId: string | null;
  onUploadFiles: (files: FileList | File[]) => void;
  onDownload: (att: AttachmentRecord) => void;
  onDelete: (id: string) => void;
}

export function AttachmentsDrawer({
  open,
  onClose,
  attachments,
  encryptionMode,
  readOnly,
  burnedNow,
  uploading,
  downloadingId,
  onUploadFiles,
  onDownload,
  onDelete,
}: AttachmentsDrawerProps) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  if (!open) return null;

  const canUpload = !readOnly && !burnedNow && !uploading;

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-zinc-950/35 backdrop-blur-xs"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md h-full bg-white dark:bg-[#12151B] border-l border-zinc-200 dark:border-zinc-800 shadow-2xl flex flex-col animate-fade-in-up">
        {/* Header */}
        <div className="px-5 py-4 border-b border-zinc-200/80 dark:border-zinc-800 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 flex items-center justify-center">
              <FileLock2 className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
                文件中转站 ({attachments.length}/10)
              </h3>
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                {encryptionMode === 'none'
                  ? '单文件最大 25 MB · 服务端静态加密存储'
                  : '文件名与内容均在本地 AES-256-GCM 加密后上传'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Upload Dropzone */}
        {!burnedNow && (
          <div className="p-4 border-b border-zinc-200/70 dark:border-zinc-800/80">
            <input
              ref={inputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files && e.target.files.length > 0) {
                  onUploadFiles(e.target.files);
                  e.target.value = '';
                }
              }}
            />
            <div
              onDragOver={(e) => {
                e.preventDefault();
                if (canUpload) setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                if (canUpload && e.dataTransfer.files.length > 0) {
                  onUploadFiles(e.dataTransfer.files);
                }
              }}
              onClick={() => canUpload && inputRef.current?.click()}
              className={`rounded-xl border-2 border-dashed p-5 text-center transition-all ${
                !canUpload
                  ? 'opacity-50 cursor-not-allowed border-zinc-200 dark:border-zinc-800'
                  : dragging
                    ? 'border-teal-500 bg-teal-500/8 cursor-pointer'
                    : 'border-zinc-200 dark:border-zinc-800 hover:border-teal-500/60 hover:bg-zinc-50 dark:hover:bg-zinc-900/50 cursor-pointer'
              }`}
            >
              {uploading ? (
                <div className="flex flex-col items-center gap-2 text-teal-600 dark:text-teal-400">
                  <Loader2 className="w-6 h-6 animate-spin" />
                  <span className="text-xs font-medium">
                    {encryptionMode === 'none' ? '正在上传文件…' : '正在本地加密并上传…'}
                  </span>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-1.5">
                  <UploadCloud className="w-6 h-6 text-zinc-400" />
                  <p className="text-xs font-medium text-zinc-700 dark:text-zinc-200">
                    {readOnly ? '只读状态下禁止上传' : '点击选择或拖拽文件到此处'}
                  </p>
                  <p className="text-[11px] text-zinc-400">
                    支持全格式文件 · 单文件 ≤ 25 MB
                  </p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* File list */}
        <div className="flex-1 overflow-y-auto p-4 space-y-2.5">
          {attachments.length === 0 ? (
            <div className="py-16 text-center text-zinc-400 dark:text-zinc-500 flex flex-col items-center gap-2">
              <Paperclip className="w-7 h-7 opacity-40" />
              <p className="text-xs">暂无附件</p>
            </div>
          ) : (
            attachments.map((att) => {
              const name = att.decryptedMeta?.name || `加密文件 (${att.id.slice(0, 8)})`;
              const size = att.decryptedMeta?.size ?? att.sizeBytes;
              const isDownloading = downloadingId === att.id;

              return (
                <div
                  key={att.id}
                  className="p-3 rounded-xl bg-zinc-50/80 dark:bg-zinc-900/60 border border-zinc-200/80 dark:border-zinc-800 flex items-center gap-3 group"
                >
                  <div className="w-9 h-9 rounded-lg bg-white dark:bg-zinc-800 border border-zinc-200/80 dark:border-zinc-700/80 flex items-center justify-center shrink-0 text-zinc-500 dark:text-zinc-400">
                    {att.encrypted ? (
                      <FileLock2 className="w-4 h-4 text-teal-600 dark:text-teal-400" />
                    ) : (
                      <File className="w-4 h-4" />
                    )}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium text-zinc-800 dark:text-zinc-100 truncate" title={name}>
                      {name}
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-[11px] text-zinc-400 dark:text-zinc-500">
                      <span>{formatBytes(size)}</span>
                      <span>·</span>
                      <span>{formatRelativeTime(att.createdAt)}</span>
                      {att.encrypted && (
                        <span className="inline-flex items-center gap-0.5 text-emerald-600 dark:text-emerald-400">
                          <ShieldCheck className="w-3 h-3" /> E2EE
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => onDownload(att)}
                      disabled={isDownloading}
                      className="p-2 rounded-lg text-zinc-500 hover:text-teal-700 dark:hover:text-teal-400 hover:bg-teal-500/10 transition-colors cursor-pointer disabled:opacity-50"
                      title={att.encrypted ? '本地解密并下载' : '下载文件'}
                    >
                      {isDownloading ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Download className="w-4 h-4" />
                      )}
                    </button>
                    {!readOnly && !burnedNow && (
                      <button
                        type="button"
                        onClick={() => onDelete(att.id)}
                        className="p-2 rounded-lg text-zinc-400 hover:text-rose-600 hover:bg-rose-500/10 transition-colors cursor-pointer"
                        title="删除附件"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
