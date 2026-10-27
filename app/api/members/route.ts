import { asc, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { coaches, members } from "../../../db/schema";
import {
  MEMBER_FIELDS, MemberInput, badRequest, memberColumns, resolveMemberActor,
  serverError, toApiMember, validators,
} from "./shared";

// Member records are persisted state, so never serve them from a cached render.
export const dynamic = "force-dynamic";

/** Create requires every field; PATCH reuses the same validators partially. */
function validateNewMember(body: unknown): { error: string } | { value: MemberInput } {
  if (typeof body !== "object" || body === null) {
    return { error: "Request body must be an object." };
  }
  const input = body as Record<string, unknown>;
  const collected: Partial<MemberInput> = {};

  for (const field of MEMBER_FIELDS) {
    if (input[field] === undefined) return { error: `${field} is required.` };
    const result = validators[field](input[field]);
    if ("error" in result) return result;
    Object.assign(collected, { [field]: result.value });
  }

  return { value: collected as MemberInput };
}

export async function GET(request: Request) {
  const actor = await resolveMemberActor(request);
  if (actor instanceof Response) return actor;

  try {
    const db = getDb();
    // createdAt is exposed on the roster only: the Coach Calendar needs it so a Member is never
    // "Not recorded" for days before they existed. Other Member responses are unchanged.
    const base = db.select({ ...memberColumns, createdAt: members.createdAt }).from(members);
    const rows = await (actor.kind === "coach"
      ? base.where(eq(members.coachId, actor.coachId))
      : base
    ).orderBy(asc(members.id));

    return Response.json({ members: rows.map(toApiMember) });
  } catch (error) {
    return serverError("GET /api/members failed", error, "Unable to load members.");
  }
}

export async function POST(request: Request) {
  const actor = await resolveMemberActor(request);
  if (actor instanceof Response) return actor;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("Request body must be valid JSON.");
  }

  // Identity and ownership are never accepted from the body. Super Admin's
  // coachId is a target assignment; for a Coach it is rejected outright.
  const input = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const forbidden = ["userId", "role", ...(actor.kind === "coach" ? ["coachId"] : [])]
    .filter((key) => key in input);
  if (forbidden.length > 0) return badRequest(`Unsupported field(s): ${forbidden.join(", ")}.`);

  const validated = validateNewMember(body);
  if ("error" in validated) return badRequest(validated.error);

  try {
    const db = getDb();
    let coachId: number;
    if (actor.kind === "coach") {
      coachId = actor.coachId;
    } else {
      const target = input.coachId;
      if (typeof target !== "number" || !Number.isInteger(target) || target <= 0) {
        return badRequest("coachId must be a positive whole number.");
      }
      const [coach] = await db
        .select({ id: coaches.id })
        .from(coaches)
        .where(eq(coaches.id, target))
        .limit(1);
      if (!coach) return badRequest("coachId does not match an existing coach.");
      coachId = coach.id;
    }

    const [row] = await db
      .insert(members)
      .values({
        coachId,
        photoUrl: null,
        ...validated.value,
        preferredDays: JSON.stringify(validated.value.preferredDays),
      })
      .returning(memberColumns);

    return Response.json({ member: toApiMember(row) }, { status: 201 });
  } catch (error) {
    return serverError("POST /api/members failed", error, "Unable to create the member.");
  }
}
