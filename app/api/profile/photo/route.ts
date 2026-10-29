import { eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { coaches, members } from "../../../../db/schema";
import { AuthError, authErrorResponse, requireCoach, requireMember, requireUser } from "../../../../lib/authorization";
import {
  MAX_PHOTO_BYTES, buildPhotoKey, keyFromPhotoUrl, normalizeMime, photoUrlForKey, validatePhotoBytes,
} from "../../../../lib/profile-photo";
import {
  StorageUnavailableError, deleteProfilePhoto, putProfilePhoto,
} from "../../../../lib/profile-photo-storage";
import { serverError } from "../../members/shared";

// Photo state is persisted, so never serve it from a cached render.
export const dynamic = "force-dynamic";

type Target = { kind: "coach" | "member"; id: number; photoUrl: string | null };

/**
 * The caller's own profile row, derived only from the session. Super Admin has
 * no photo; there is no id, key or URL in the request that could aim elsewhere.
 */
async function resolveTarget(request: Request): Promise<Target> {
  const user = await requireUser(request);
  const db = getDb();
  if (user.role === "coach") {
    const { coach } = await requireCoach(request);
    const [row] = await db.select({ photoUrl: coaches.photoUrl }).from(coaches).where(eq(coaches.id, coach.id)).limit(1);
    return { kind: "coach", id: coach.id, photoUrl: row?.photoUrl ?? null };
  }
  if (user.role === "member") {
    const { member } = await requireMember(request);
    const [row] = await db.select({ photoUrl: members.photoUrl }).from(members).where(eq(members.id, member.id)).limit(1);
    return { kind: "member", id: member.id, photoUrl: row?.photoUrl ?? null };
  }
  throw new AuthError(403, "Forbidden.");
}

async function setPhotoUrl(target: Target, photoUrl: string | null) {
  const db = getDb();
  if (target.kind === "coach") await db.update(coaches).set({ photoUrl }).where(eq(coaches.id, target.id));
  else await db.update(members).set({ photoUrl }).where(eq(members.id, target.id));
}

/** Best effort: a failed delete leaves an unreachable orphan, because reads check the current `photoUrl`. */
async function deleteOwnedObject(photoUrl: string | null, owner: Target) {
  const key = keyFromPhotoUrl(photoUrl);
  if (!key || !key.startsWith(`profiles/${owner.kind}/${owner.id}/`)) return;
  try {
    await deleteProfilePhoto(key);
  } catch (error) {
    console.error("Profile photo cleanup failed", error instanceof Error ? error.name : "unknown");
  }
}

function fail(error: unknown, ctx: string, message: string) {
  const response = authErrorResponse(error);
  if (response) return response;
  if (error instanceof StorageUnavailableError) {
    return Response.json({ error: "Photo storage is unavailable." }, { status: 503 });
  }
  return serverError(ctx, error, message);
}

/** Reads the body but never more than the limit; null means it was too large. */
async function readCapped(request: Request): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_PHOTO_BYTES) return null;
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_PHOTO_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export async function PUT(request: Request) {
  const ctx = "PUT /api/profile/photo failed";
  try {
    const target = await resolveTarget(request);

    const bytes = await readCapped(request);
    if (bytes === null) {
      return Response.json({ error: "Image must be 2 MB or smaller." }, { status: 413 });
    }
    const checked = validatePhotoBytes(normalizeMime(request.headers.get("content-type")), bytes);
    if (!checked.ok) return Response.json({ error: checked.error }, { status: checked.status });

    const key = buildPhotoKey(target.kind, target.id, checked.ext);
    const photoUrl = photoUrlForKey(key);

    // New object first; the row only points at it once it exists.
    await putProfilePhoto(key, bytes, checked.mime);
    try {
      await setPhotoUrl(target, photoUrl);
    } catch (error) {
      try { await deleteProfilePhoto(key); } catch { /* orphan is unreachable: no row points at it */ }
      throw error;
    }
    await deleteOwnedObject(target.photoUrl, target);
    return Response.json({ photoUrl });
  } catch (error) {
    return fail(error, ctx, "Unable to save the photo.");
  }
}

export async function DELETE(request: Request) {
  const ctx = "DELETE /api/profile/photo failed";
  try {
    const target = await resolveTarget(request);
    if (target.photoUrl !== null) {
      await setPhotoUrl(target, null);
      await deleteOwnedObject(target.photoUrl, target);
    }
    return Response.json({ photoUrl: null });
  } catch (error) {
    return fail(error, ctx, "Unable to remove the photo.");
  }
}
