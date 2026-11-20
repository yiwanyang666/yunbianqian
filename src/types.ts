export type EncryptionMode = 'none' | 'password' | 'url-key';

export interface NotePayload {
  title: string;
  content: string;
}

export interface AttachmentMeta {
  name: string;
  type: string;
  size: number;
}

export interface AttachmentRecord {
  id: string;
  encryptedMeta: string;
  fileIv: string | null;
  sizeBytes: number;
  encrypted: boolean;
  createdAt: number;
  inlineDataBase64?: string | null;
  // Decrypted client-side metadata (populated after decrypt)
  decryptedMeta?: AttachmentMeta;
}

export interface ServerNoteResponse {
  exists: boolean;
  slug: string;
  burnAfterRead?: boolean;
  consumed?: boolean;
  burnedNow?: boolean;
  encryptionMode?: EncryptionMode;
  ciphertext?: string;
  iv?: string | null;
  salt?: string | null;
  kdfIterations?: number;
  hasAuth?: boolean;
  readOnly?: boolean;
  version?: number;
  expiresAt?: number | null;
  createdAt?: number;
  updatedAt?: number;
  attachmentCount?: number;
  attachments?: AttachmentRecord[];
}

export interface CryptoSession {
  mode: EncryptionMode;
  encKey: CryptoKey | null;
  authVerifier: string | null;
  salt: string | null;
  kdfIterations: number;
  urlKey: string | null; // only populated in 'url-key' mode
}

export interface CryptoSnapshot {
  mode: EncryptionMode;
  algorithm: string;
  kdf: string;
  aad: string;
  iv: string | null;
  salt: string | null;
  ciphertextPreview: string;
  ciphertextBytes: number;
}

export interface RecentNoteItem {
  slug: string;
  mode: EncryptionMode;
  visitedAt: number;
}

export type EditorViewMode = 'edit' | 'split' | 'preview';
export type ThemeMode = 'light' | 'dark';

export interface ToastItem {
  id: string;
  message: string;
  type: 'success' | 'error' | 'info' | 'warning';
}
