import { randomUUID } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { ImageAttachmentDto } from "../shared/contracts.js";

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

export interface StoredImage extends ImageAttachmentDto { path: string }

export class AttachmentService {
  private readonly images = new Map<string, StoredImage>();

  async addImage(filePath: string): Promise<ImageAttachmentDto> {
    if (!path.isAbsolute(filePath)) throw attachmentError("IMAGE_PATH_INVALID", "Görsel yolu geçersiz.");
    const canonical = await realpath(filePath).catch(() => { throw attachmentError("IMAGE_NOT_FOUND", "Görsel bulunamadı."); });
    const extension = path.extname(canonical).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(extension)) {
      throw attachmentError("IMAGE_TYPE_UNSUPPORTED", "PNG, JPEG veya WebP görsel seçin.");
    }
    const details = await stat(canonical);
    if (!details.isFile() || details.size <= 0 || details.size > MAX_IMAGE_BYTES) {
      throw attachmentError("IMAGE_SIZE_INVALID", "Görsel 20 MB'den küçük ve boş olmayan bir dosya olmalıdır.");
    }
    const bytes = await readFile(canonical);
    const mimeType = detectMime(bytes);
    const extensionMatches = mimeType === "image/png"
      ? extension === ".png"
      : mimeType === "image/jpeg"
        ? extension === ".jpg" || extension === ".jpeg"
        : extension === ".webp";
    if (!extensionMatches) throw attachmentError("IMAGE_SIGNATURE_INVALID", "Görsel uzantısı ile dosya imzası eşleşmiyor.");
    validateImage(bytes, mimeType);
    const stored: StoredImage = {
      id: randomUUID(),
      name: path.basename(canonical),
      sizeBytes: details.size,
      mimeType,
      path: canonical,
    };
    this.images.set(stored.id, stored);
    return publicImage(stored);
  }

  async resolve(ids: readonly string[]): Promise<StoredImage[]> {
    return Promise.all(ids.map(async (id) => {
      const image = this.images.get(id);
      if (!image) throw attachmentError("IMAGE_ATTACHMENT_STALE", "Görsel eki artık kullanılamıyor; yeniden seçin.");
      const canonical = await realpath(image.path).catch(() => {
        throw attachmentError("IMAGE_ATTACHMENT_STALE", "Görsel eki artık kullanılamıyor; yeniden seçin.");
      });
      const details = await stat(canonical).catch(() => {
        throw attachmentError("IMAGE_ATTACHMENT_STALE", "Görsel eki artık kullanılamıyor; yeniden seçin.");
      });
      if (!details.isFile() || details.size !== image.sizeBytes || canonical !== image.path) {
        throw attachmentError("IMAGE_ATTACHMENT_CHANGED", "Görsel eki seçildikten sonra değişti; yeniden seçin.");
      }
      const bytes = await readFile(canonical).catch(() => {
        throw attachmentError("IMAGE_ATTACHMENT_STALE", "Görsel eki artık okunamıyor; yeniden seçin.");
      });
      try {
        const mimeType = detectMime(bytes);
        validateImage(bytes, mimeType);
        if (mimeType !== image.mimeType) throw new Error("mime_changed");
      } catch {
        throw attachmentError("IMAGE_ATTACHMENT_CHANGED", "Görsel eki seçildikten sonra bozuldu; yeniden seçin.");
      }
      return image;
    }));
  }

  remove(ids: readonly string[]): void {
    for (const id of ids) this.images.delete(id);
  }

  clear(): void {
    this.images.clear();
  }
}

function detectMime(signature: Buffer): ImageAttachmentDto["mimeType"] {
  if (signature.length >= 8 && signature.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return "image/png";
  }
  if (signature.length >= 3 && signature[0] === 0xff && signature[1] === 0xd8 && signature[2] === 0xff) {
    return "image/jpeg";
  }
  if (signature.length >= 12 && signature.toString("ascii", 0, 4) === "RIFF" && signature.toString("ascii", 8, 12) === "WEBP") {
    return "image/webp";
  }
  throw attachmentError("IMAGE_SIGNATURE_INVALID", "Görsel dosya imzası doğrulanamadı.");
}

function validateImage(bytes: Buffer, mimeType: ImageAttachmentDto["mimeType"]): void {
  const valid = mimeType === "image/png"
    ? validPng(bytes)
    : mimeType === "image/jpeg"
      ? validJpeg(bytes)
      : validWebp(bytes);
  if (!valid) throw attachmentError("IMAGE_CONTENT_INVALID", "Görsel dosyası bozuk veya eksik.");
}

function validPng(bytes: Buffer): boolean {
  if (bytes.length < 45) return false;
  let offset = 8;
  let sawHeader = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (end > bytes.length) return false;
    const expectedCrc = bytes.readUInt32BE(offset + 8 + length);
    if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== expectedCrc) return false;
    if (!sawHeader) {
      if (type !== "IHDR" || length !== 13) return false;
      if (bytes.readUInt32BE(offset + 8) === 0 || bytes.readUInt32BE(offset + 12) === 0) return false;
      sawHeader = true;
    }
    if (type === "IEND") return length === 0 && end === bytes.length;
    offset = end;
  }
  return false;
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function validJpeg(bytes: Buffer): boolean {
  if (bytes.length < 12 || bytes[0] !== 0xff || bytes[1] !== 0xd8
    || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) return false;
  let offset = 2;
  let sawFrame = false;
  while (offset < bytes.length - 2) {
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return false;
    const marker = bytes[offset++]!;
    if (marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return false;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return false;
    if (isJpegFrameMarker(marker)) {
      if (length < 7 || bytes.readUInt16BE(offset + 3) === 0 || bytes.readUInt16BE(offset + 5) === 0) return false;
      sawFrame = true;
    }
    if (marker === 0xda) return sawFrame;
    offset += length;
  }
  return sawFrame;
}

function isJpegFrameMarker(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
}

function validWebp(bytes: Buffer): boolean {
  if (bytes.length < 20 || bytes.toString("ascii", 0, 4) !== "RIFF"
    || bytes.toString("ascii", 8, 12) !== "WEBP" || bytes.readUInt32LE(4) + 8 !== bytes.length) return false;
  const type = bytes.toString("ascii", 12, 16);
  const length = bytes.readUInt32LE(16);
  if (20 + length > bytes.length) return false;
  if (type === "VP8X") return length >= 10;
  if (type === "VP8L") return length >= 5 && bytes[20] === 0x2f;
  if (type === "VP8 ") {
    return length >= 10 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a;
  }
  return false;
}

function publicImage(image: StoredImage): ImageAttachmentDto {
  return { id: image.id, name: image.name, sizeBytes: image.sizeBytes, mimeType: image.mimeType };
}

function attachmentError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
