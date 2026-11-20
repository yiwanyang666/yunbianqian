import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.join(__dirname, 'data');
export const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const DB_PATH = path.join(DATA_DIR, 'ciphernote.db');

fs.mkdirSync(UPLOADS_DIR, { recursive: true });

export const db = new DatabaseSync(DB_PATH);

// Tuned for ultra-low RAM footprint & clean WAL durability
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA synchronous = NORMAL;
  PRAGMA cache_size = -2000;
  PRAGMA mmap_size = 0;
  PRAGMA temp_store = FILE;
  PRAGMA journal_size_limit = 4194304;

  CREATE TABLE IF NOT EXISTS notes (
    slug TEXT PRIMARY KEY,
    encryption_mode TEXT NOT NULL CHECK (encryption_mode IN ('none', 'password', 'url-key')),
    ciphertext TEXT NOT NULL,
    iv TEXT,
    salt TEXT,
    kdf_iterations INTEGER NOT NULL DEFAULT 600000,
    auth_hash TEXT,
    read_only INTEGER NOT NULL DEFAULT 0,
    burn_after_read INTEGER NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 1,
    expires_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,
    note_slug TEXT NOT NULL,
    storage_name TEXT NOT NULL,
    encrypted_meta TEXT NOT NULL,
    file_iv TEXT,
    size_bytes INTEGER NOT NULL,
    encrypted INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (note_slug) REFERENCES notes(slug) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_notes_expires_at ON notes(expires_at);
  CREATE INDEX IF NOT EXISTS idx_attachments_slug ON attachments(note_slug);
`);

// Cached prepared statements (zero SQL re-parsing overhead per request)
export const stmts = {
  getNote: db.prepare('SELECT * FROM notes WHERE slug = ?'),
  deleteNote: db.prepare('DELETE FROM notes WHERE slug = ?'),
  getExpiredSlugs: db.prepare('SELECT slug FROM notes WHERE expires_at IS NOT NULL AND expires_at <= ?'),
  insertNote: db.prepare(`
    INSERT INTO notes (
      slug, encryption_mode, ciphertext, iv, salt, kdf_iterations,
      auth_hash, read_only, burn_after_read, version, expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  updateNote: db.prepare(`
    UPDATE notes SET
      encryption_mode = ?, ciphertext = ?, iv = ?, salt = ?, kdf_iterations = ?,
      auth_hash = ?, read_only = ?, burn_after_read = ?, version = ?, expires_at = ?, updated_at = ?
    WHERE slug = ?
  `),
  countAttachments: db.prepare('SELECT COUNT(*) as cnt FROM attachments WHERE note_slug = ?'),
  listAttachments: db.prepare(
    'SELECT id, encrypted_meta, file_iv, size_bytes, encrypted, created_at FROM attachments WHERE note_slug = ? ORDER BY created_at DESC'
  ),
  listAttachmentsFull: db.prepare('SELECT * FROM attachments WHERE note_slug = ? ORDER BY created_at DESC'),
  listAttachmentStorage: db.prepare('SELECT storage_name FROM attachments WHERE note_slug = ?'),
  getAttachment: db.prepare('SELECT * FROM attachments WHERE id = ? AND note_slug = ?'),
  getAttachmentStorage: db.prepare('SELECT storage_name FROM attachments WHERE id = ? AND note_slug = ?'),
  insertAttachment: db.prepare(`
    INSERT INTO attachments (
      id, note_slug, storage_name, encrypted_meta, file_iv, size_bytes, encrypted, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),
  deleteAttachment: db.prepare('DELETE FROM attachments WHERE id = ? AND note_slug = ?'),
  deleteAllAttachments: db.prepare('DELETE FROM attachments WHERE note_slug = ?'),
};

export function safeUnlinkUpload(storageName) {
  if (!storageName || storageName.includes('..') || storageName.includes('/') || storageName.includes('\\')) {
    return;
  }
  const fullPath = path.join(UPLOADS_DIR, storageName);
  fs.unlink(fullPath, () => {});
}

export function deleteNoteAndFiles(slug) {
  const files = stmts.listAttachmentStorage.all(slug);
  stmts.deleteNote.run(slug);
  for (const f of files) {
    safeUnlinkUpload(f.storage_name);
  }
}

export function cleanupExpiredNotes() {
  const expired = stmts.getExpiredSlugs.all(Date.now());
  for (const row of expired) {
    deleteNoteAndFiles(row.slug);
  }
  return expired.length;
}
