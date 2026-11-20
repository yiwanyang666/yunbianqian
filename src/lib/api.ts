import type { AttachmentRecord, EncryptionMode, ServerNoteResponse } from '../types';
import { utf8ToBase64 } from './crypto';

export class ApiError extends Error {
  status: number;
  code?: string;
  serverVersion?: number;

  constructor(message: string, status: number, code?: string, serverVersion?: number) {
    super(message);
    this.status = status;
    this.code = code;
    this.serverVersion = serverVersion;
  }
}

async function parseJsonOrThrow(res: Response) {
  let data: Record<string, unknown> = {};
  try {
    data = await res.json();
  } catch {
    // ignore
  }
  if (!res.ok) {
    throw new ApiError(
      (typeof data.error === 'string' && data.error) || `请求失败 (${res.status})`,
      res.status,
      typeof data.code === 'string' ? data.code : undefined,
      typeof data.serverVersion === 'number' ? data.serverVersion : undefined
    );
  }
  return data;
}

export async function fetchNote(slug: string): Promise<ServerNoteResponse> {
  const res = await fetch(`/api/notes/${encodeURIComponent(slug)}`, {
    method: 'GET',
    cache: 'no-store',
  });
  return (await parseJsonOrThrow(res)) as unknown as ServerNoteResponse;
}

export async function consumeBurnNote(
  slug: string,
  authVerifier?: string | null
): Promise<ServerNoteResponse> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (authVerifier) headers['X-Auth-Verifier'] = authVerifier;
  const res = await fetch(`/api/notes/${encodeURIComponent(slug)}/consume`, {
    method: 'POST',
    headers,
    body: JSON.stringify({}),
  });
  return (await parseJsonOrThrow(res)) as unknown as ServerNoteResponse;
}

export async function verifyNoteAuth(slug: string, authVerifier: string): Promise<boolean> {
  const res = await fetch(`/api/notes/${encodeURIComponent(slug)}/verify`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Auth-Verifier': authVerifier,
    },
    body: JSON.stringify({}),
  });
  if (res.status === 401) return false;
  await parseJsonOrThrow(res);
  return true;
}

export interface SaveNoteInput {
  slug: string;
  encryptionMode: EncryptionMode;
  ciphertext: string;
  iv?: string | null;
  salt?: string | null;
  kdfIterations?: number;
  authVerifier?: string | null;
  newAuthVerifier?: string | null | undefined;
  readOnly?: boolean;
  burnAfterRead?: boolean;
  ttlSeconds?: number | null | undefined;
  expectedVersion?: number;
  clientId: string;
  allowReadOnlyChange?: boolean;
  clearAttachments?: boolean;
}

export async function saveNote(input: SaveNoteInput): Promise<{
  ok: boolean;
  slug: string;
  version: number;
  encryptionMode: EncryptionMode;
  hasAuth: boolean;
  readOnly: boolean;
  burnAfterRead: boolean;
  expiresAt: number | null;
  updatedAt: number;
  createdAt: number;
}> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (input.authVerifier) {
    headers['X-Auth-Verifier'] = input.authVerifier;
  }

  const res = await fetch(`/api/notes/${encodeURIComponent(input.slug)}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      encryptionMode: input.encryptionMode,
      ciphertext: input.ciphertext,
      iv: input.iv ?? null,
      salt: input.salt ?? null,
      kdfIterations: input.kdfIterations ?? 600_000,
      newAuthVerifier: input.newAuthVerifier,
      readOnly: input.readOnly,
      burnAfterRead: input.burnAfterRead,
      ttlSeconds: input.ttlSeconds,
      expectedVersion: input.expectedVersion,
      clientId: input.clientId,
      allowReadOnlyChange: input.allowReadOnlyChange,
      clearAttachments: input.clearAttachments,
    }),
  });

  return (await parseJsonOrThrow(res)) as unknown as ReturnType<typeof saveNote>;
}

export async function deleteNote(
  slug: string,
  authVerifier: string | null,
  clientId: string
): Promise<void> {
  const headers: Record<string, string> = { 'X-Client-Id': clientId };
  if (authVerifier) headers['X-Auth-Verifier'] = authVerifier;
  const res = await fetch(`/api/notes/${encodeURIComponent(slug)}`, {
    method: 'DELETE',
    headers,
  });
  await parseJsonOrThrow(res);
}

export async function uploadAttachment(params: {
  slug: string;
  fileId: string;
  bodyBytes: Uint8Array<ArrayBuffer>;
  metaJson: string;
  encrypted: boolean;
  fileIv: string | null;
  authVerifier: string | null;
  clientId: string;
}): Promise<AttachmentRecord> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/octet-stream',
    'X-File-Id': params.fileId,
    'X-Encrypted-Meta': utf8ToBase64(params.metaJson),
    'X-File-Encrypted': params.encrypted ? '1' : '0',
    'X-Client-Id': params.clientId,
  };
  if (params.fileIv) headers['X-File-Iv'] = params.fileIv;
  if (params.authVerifier) headers['X-Auth-Verifier'] = params.authVerifier;

  const res = await fetch(`/api/notes/${encodeURIComponent(params.slug)}/attachments`, {
    method: 'POST',
    headers,
    body: params.bodyBytes,
  });
  const data = await parseJsonOrThrow(res);
  return data.attachment as AttachmentRecord;
}

export async function downloadAttachmentBytes(slug: string, id: string): Promise<ArrayBuffer> {
  const res = await fetch(
    `/api/notes/${encodeURIComponent(slug)}/attachments/${encodeURIComponent(id)}`,
    { method: 'GET', cache: 'no-store' }
  );
  if (!res.ok) {
    let msg = `下载失败 (${res.status})`;
    try {
      const j = await res.json();
      if (j.error) msg = j.error;
    } catch {
      // ignore
    }
    throw new ApiError(msg, res.status);
  }
  return res.arrayBuffer();
}

export async function deleteAttachment(
  slug: string,
  id: string,
  authVerifier: string | null,
  clientId: string
): Promise<void> {
  const headers: Record<string, string> = { 'X-Client-Id': clientId };
  if (authVerifier) headers['X-Auth-Verifier'] = authVerifier;
  const res = await fetch(
    `/api/notes/${encodeURIComponent(slug)}/attachments/${encodeURIComponent(id)}`,
    { method: 'DELETE', headers }
  );
  await parseJsonOrThrow(res);
}

let cachedSyncMode: 'sse' | 'poll' | null = null;

async function detectSyncMode(): Promise<'sse' | 'poll'> {
  if (cachedSyncMode) return cachedSyncMode;
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    const data = await res.json();
    cachedSyncMode = data.syncMode === 'poll' ? 'poll' : 'sse';
  } catch {
    cachedSyncMode = 'sse';
  }
  return cachedSyncMode;
}

export function subscribeNoteEvents(
  slug: string,
  clientId: string,
  handlers: {
    onConnected?: (viewers: number) => void;
    onNoteUpdated?: (data: { version: number; updatedAt: number }) => void;
    onNoteDeleted?: () => void;
    onNoteBurned?: () => void;
    onAttachmentsUpdated?: () => void;
    onError?: () => void;
  }
): () => void {
  let closed = false;
  let es: EventSource | null = null;
  let pollTimer: number | null = null;
  let lastSeenVersion: number | null = null;
  let lastSeenAttCount: number | null = null;

  detectSyncMode().then((mode) => {
    if (closed) return;

    if (mode === 'poll') {
      // Lightweight visibility-aware polling for Cloudflare Workers Edge
      handlers.onConnected?.(1);
      const poll = async () => {
        if (closed || document.visibilityState === 'hidden') return;
        try {
          const res = await fetch(`/api/notes/${encodeURIComponent(slug)}/meta`, {
            cache: 'no-store',
          });
          if (!res.ok) return;
          const data = await res.json();
          if (!data.exists) {
            if (lastSeenVersion !== null && lastSeenVersion > 0) {
              lastSeenVersion = 0;
              handlers.onNoteDeleted?.();
            }
            return;
          }
          if (lastSeenVersion === null) {
            lastSeenVersion = data.version;
            lastSeenAttCount = data.attachmentCount ?? 0;
            return;
          }
          if (data.version > lastSeenVersion) {
            lastSeenVersion = data.version;
            handlers.onNoteUpdated?.({ version: data.version, updatedAt: data.updatedAt });
          }
          if (
            typeof data.attachmentCount === 'number' &&
            lastSeenAttCount !== null &&
            data.attachmentCount !== lastSeenAttCount
          ) {
            lastSeenAttCount = data.attachmentCount;
            handlers.onAttachmentsUpdated?.();
          }
        } catch {
          // ignore transient poll hiccup
        }
      };
      poll();
      pollTimer = window.setInterval(poll, 10000);
      return;
    }

    // Native real-time SSE for Node.js server
    es = new EventSource(
      `/api/notes/${encodeURIComponent(slug)}/events?clientId=${encodeURIComponent(clientId)}`
    );

    es.addEventListener('connected', (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data);
        handlers.onConnected?.(data.viewers ?? 1);
      } catch {
        handlers.onConnected?.(1);
      }
    });

    es.addEventListener('note-updated', (e) => {
      try {
        handlers.onNoteUpdated?.(JSON.parse((e as MessageEvent).data));
      } catch {
        // ignore
      }
    });

    es.addEventListener('note-deleted', () => handlers.onNoteDeleted?.());
    es.addEventListener('note-burned', () => handlers.onNoteBurned?.());
    es.addEventListener('attachments-updated', () => handlers.onAttachmentsUpdated?.());
    es.onerror = () => handlers.onError?.();
  });

  return () => {
    closed = true;
    if (es) es.close();
    if (pollTimer !== null) window.clearInterval(pollTimer);
  };
}
