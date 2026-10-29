import { env } from "cloudflare:workers";

/**
 * The only code that touches R2 for profile photos. Production and local
 * (Miniflare) run through the same `BUCKET` binding. No authorization here:
 * routes pass only server-generated keys. No filesystem or D1 fallback.
 */
export class StorageUnavailableError extends Error {
  constructor() {
    super("R2 binding `BUCKET` is unavailable.");
    this.name = "StorageUnavailableError";
  }
}

function bucket(): R2Bucket {
  if (!env.BUCKET) throw new StorageUnavailableError();
  return env.BUCKET;
}

export async function putProfilePhoto(key: string, bytes: ArrayBuffer | Uint8Array, contentType: string): Promise<void> {
  await bucket().put(key, bytes, { httpMetadata: { contentType } });
}

/** The object with a streaming body, or null when it does not exist. */
export async function getProfilePhoto(key: string): Promise<R2ObjectBody | null> {
  return bucket().get(key);
}

export async function deleteProfilePhoto(key: string): Promise<void> {
  await bucket().delete(key);
}
