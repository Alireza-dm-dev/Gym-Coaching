import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { members } from "../../../../db/schema";
import {
  MEMBER_FIELDS, MemberField, MemberInput, badRequest, memberColumns,
  notFound, resolveMemberActor, serverError, toApiMember, toColumnValues, validators,
} from "../shared";

export const dynamic = "force-dynamic";

/**
 * Partial update. Only the listed profile fields may change: id, coachId,
 * photoUrl, createdAt and every session/package field are not addressable
 * here, and an unknown key is rejected rather than quietly ignored.
 */
function validatePatch(body: unknown): { error: string } | { value: Partial<MemberInput> } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { error: "Request body must be an object." };
  }
  const input = body as Record<string, unknown>;
  const keys = Object.keys(input);
  if (keys.length === 0) return { error: "Request body must contain at least one field." };

  const allowed = new Set<string>(MEMBER_FIELDS);
  const unknown = keys.filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    return { error: `Unsupported field(s): ${unknown.join(", ")}.` };
  }

  const collected: Partial<MemberInput> = {};
  for (const key of keys as MemberField[]) {
    const result = validators[key](input[key]);
    if ("error" in result) return result;
    Object.assign(collected, { [key]: result.value });
  }

  return { value: collected };
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const actor = await resolveMemberActor(request);
  if (actor instanceof Response) return actor;

  const { id: rawId } = await params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    return badRequest("Member id must be a positive whole number.");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("Request body must be valid JSON.");
  }

  const validated = validatePatch(body);
  if ("error" in validated) return badRequest(validated.error);

  try {
    const db = getDb();
    // An update that matches no row returns nothing, which is the 404 signal.
    const [row] = await db
      .update(members)
      .set(toColumnValues(validated.value))
      // Ownership is part of the WHERE, so a foreign Member is simply "not found".
      .where(
        actor.kind === "coach"
          ? and(eq(members.id, id), eq(members.coachId, actor.coachId))
          : eq(members.id, id)
      )
      .returning(memberColumns);

    if (!row) return notFound("Member not found.");

    return Response.json({ member: toApiMember(row) });
  } catch (error) {
    return serverError("PATCH /api/members/[id] failed", error, "Unable to update the member.");
  }
}
