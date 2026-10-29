import { eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { coaches, members } from "../../../../db/schema";
import { authErrorResponse, requireUser } from "../../../../lib/authorization";
import { isPhotoMime, parsePhotoKey, photoUrlForKey } from "../../../../lib/profile-photo";
import { StorageUnavailableError, getProfilePhoto } from "../../../../lib/profile-photo-storage";
import { serverError } from "../../members/shared";

export const dynamic = "force-dynamic";

const NOT_FOUND = () => Response.json({ error: "Not found." }, { status: 404 });

/**
 * Private, authenticated photo delivery. Authorization comes from the database
 * (current assignment and the profile's CURRENT photoUrl), never from the key
 * prefix: an unauthorized or replaced key is indistinguishable from a missing one.
 */
export async function GET(request: Request, { params }: { params: Promise<{ key: string[] }> }) {
  const ctx = "GET /api/photos failed";
  try {
    const user = await requireUser(request);
    const key = (await params).key.join("/");
    const parsed = parsePhotoKey(key);
    if (!parsed) return NOT_FOUND();

    const db = getDb();
    let allowed = false;
    if (parsed.kind === "member") {
      const [row] = await db
        .select({ photoUrl: members.photoUrl, userId: members.userId, coachId: members.coachId })
        .from(members).where(eq(members.id, parsed.id)).limit(1);
      if (row?.photoUrl === photoUrlForKey(key)) {
        if (user.role === "super_admin") allowed = true;
        else if (user.role === "member") allowed = row.userId === user.id;
        else if (user.role === "coach") {
          const [coach] = await db.select({ userId: coaches.userId }).from(coaches).where(eq(coaches.id, row.coachId)).limit(1);
          allowed = coach?.userId === user.id;
        }
      }
    } else {
      const [row] = await db
        .select({ photoUrl: coaches.photoUrl, userId: coaches.userId })
        .from(coaches).where(eq(coaches.id, parsed.id)).limit(1);
      if (row?.photoUrl === photoUrlForKey(key)) {
        allowed = user.role === "super_admin" || (user.role === "coach" && row.userId === user.id);
      }
    }
    if (!allowed) return NOT_FOUND();

    const object = await getProfilePhoto(key);
    if (!object) return NOT_FOUND();

    const stored = object.httpMetadata?.contentType ?? "";
    return new Response(object.body, {
      headers: {
        "Content-Type": isPhotoMime(stored) ? stored : parsed.mime,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, max-age=31536000, immutable",
      },
    });
  } catch (error) {
    const response = authErrorResponse(error);
    if (response) return response;
    if (error instanceof StorageUnavailableError) {
      return Response.json({ error: "Photo storage is unavailable." }, { status: 503 });
    }
    return serverError(ctx, error, "Unable to load the photo.");
  }
}
