/**
 * Pure profile-photo rules: type allow-list, magic-byte sniffing, the 2 MB
 * limit, and the server-generated object key / app URL format. No storage and
 * no authorization here; see `profile-photo-storage.ts` and the routes.
 */
export const MAX_PHOTO_BYTES = 2 * 1024 * 1024;

export const PHOTO_TYPES = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
} as const;

export type PhotoMime = keyof typeof PHOTO_TYPES;
export type PhotoExt = (typeof PHOTO_TYPES)[PhotoMime];
export type PhotoOwnerKind = "coach" | "member";

const MIME_BY_EXT: Record<PhotoExt, PhotoMime> = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" };

/** Declared `Content-Type` reduced to its bare, lowercase media type. */
export function normalizeMime(header: string | null): string {
  return (header ?? "").split(";")[0].trim().toLowerCase();
}

export function isPhotoMime(value: string): value is PhotoMime {
  return Object.prototype.hasOwnProperty.call(PHOTO_TYPES, value);
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const startsWith = (bytes: Uint8Array, signature: number[], offset = 0) =>
  bytes.length >= offset + signature.length && signature.every((b, i) => bytes[offset + i] === b);

/** The image type the bytes really are, or null. No decoder involved. */
export function sniffImageType(bytes: Uint8Array): PhotoMime | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, PNG_SIGNATURE)) return "image/png";
  // RIFF....WEBP
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  return null;
}

/** Fresh unpredictable identifier: 128 random bits, hex. */
export function randomPhotoId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** `profiles/<kind>/<rowId>/<random>.<ext>`: only server-known values, never client input. */
export function buildPhotoKey(kind: PhotoOwnerKind, rowId: number, ext: PhotoExt): string {
  return `profiles/${kind}/${rowId}/${randomPhotoId()}.${ext}`;
}

const KEY_PATTERN = /^profiles\/(coach|member)\/([1-9]\d{0,9})\/([0-9a-f]{32})\.(jpg|png|webp)$/;

/** Strict parse of a key; anything not produced by `buildPhotoKey` is null. */
export function parsePhotoKey(key: string): { kind: PhotoOwnerKind; id: number; ext: PhotoExt; mime: PhotoMime } | null {
  const m = KEY_PATTERN.exec(key);
  if (!m) return null;
  const ext = m[4] as PhotoExt;
  return { kind: m[1] as PhotoOwnerKind, id: Number(m[2]), ext, mime: MIME_BY_EXT[ext] };
}

const URL_PREFIX = "/api/photos/";
export const photoUrlForKey = (key: string) => `${URL_PREFIX}${key}`;

/** Key behind a stored `photoUrl`, or null when it is empty or not one of ours. */
export function keyFromPhotoUrl(url: string | null): string | null {
  if (!url || !url.startsWith(URL_PREFIX)) return null;
  const key = url.slice(URL_PREFIX.length);
  return parsePhotoKey(key) ? key : null;
}

export type PhotoValidation =
  | { ok: true; mime: PhotoMime; ext: PhotoExt }
  | { ok: false; status: 400 | 415; error: string };

/** Declared type must be allowed AND match the bytes. Spoofed or unknown → 415. */
export function validatePhotoBytes(declaredMime: string, bytes: Uint8Array): PhotoValidation {
  if (bytes.length === 0) return { ok: false, status: 400, error: "Image body must not be empty." };
  if (!isPhotoMime(declaredMime)) return { ok: false, status: 415, error: "Only JPEG, PNG or WebP images are allowed." };
  if (sniffImageType(bytes) !== declaredMime) return { ok: false, status: 415, error: "The file content does not match its image type." };
  return { ok: true, mime: declaredMime, ext: PHOTO_TYPES[declaredMime] };
}
