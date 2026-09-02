import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { MultipartFile } from '@fastify/multipart';
import { loadConfig } from '../../config.js';
import { getDb } from '../../db.js';
import { RuleError } from '../../errors.js';
import type { ActorContext } from '../../lib/context.js';

const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
const MAGIC: [RegExp, Buffer][] = [
  [/^image\/jpeg$/, Buffer.from([0xff, 0xd8, 0xff])],
  [/^image\/png$/, Buffer.from([0x89, 0x50, 0x4e, 0x47])],
  [/^image\/webp$/, Buffer.from('RIFF')],
  [/^application\/pdf$/, Buffer.from('%PDF')],
];

/**
 * Stores an uploaded photo/document on disk under a content-addressed name.
 * File type is validated by MIME *and* magic bytes; the original name is only
 * metadata (never used as a path).
 */
export async function saveAttachment(ctx: ActorContext, entityType: string, entityId: string, file: MultipartFile) {
  if (!ALLOWED.has(file.mimetype)) throw new RuleError('UNSUPPORTED_FILE', `File type ${file.mimetype} not allowed`);
  const buf = await file.toBuffer();
  if (buf.length === 0) throw new RuleError('EMPTY_FILE', 'Empty file');
  const magic = MAGIC.find(([re]) => re.test(file.mimetype));
  if (magic && !buf.subarray(0, magic[1].length).equals(magic[1])) throw new RuleError('FILE_CONTENT_MISMATCH', 'File content does not match its declared type');
  const sha = createHash('sha256').update(buf).digest('hex');
  const cfg = loadConfig();
  const dir = path.resolve(cfg.UPLOAD_DIR, entityType, sha.slice(0, 2));
  await mkdir(dir, { recursive: true });
  const ext = file.mimetype === 'application/pdf' ? 'pdf' : file.mimetype.split('/')[1]!;
  const storagePath = path.join(dir, `${sha}.${ext}`);
  await writeFile(storagePath, buf, { flag: 'w' });
  return getDb().attachments.create({
    data: {
      entity_type: entityType,
      entity_id: entityId,
      file_name: path.basename(file.filename ?? 'file').slice(0, 255),
      mime_type: file.mimetype,
      size_bytes: buf.length,
      storage_path: path.relative(path.resolve(cfg.UPLOAD_DIR), storagePath),
      sha256: sha,
      uploaded_by: ctx.userId,
    },
  });
}
