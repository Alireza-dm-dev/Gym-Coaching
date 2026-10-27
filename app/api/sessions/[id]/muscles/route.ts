import { eq } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { muscleKeys, sessionMuscles, type MuscleKeyValue } from "../../../../../db/schema";
import { badRequest, notFound, serverError } from "../../../members/shared";
import { isSessionDetailExpired } from "../../../../../lib/session-retention";
import { canWriteSessionDetail, findAccessibleSession, resolveChildActor } from "../../shared";

// Session muscles are persisted state, so never serve them from a cached render.
export const dynamic = "force-dynamic";

const muscleOrder = new Map<MuscleKeyValue, number>(muscleKeys.map((muscle, index) => [muscle, index]));

/** Deterministic `muscleKeys` order, never insertion order. */
function canonicalOrder(muscles: MuscleKeyValue[]): MuscleKeyValue[] {
  return [...muscles].sort((a, b) => muscleOrder.get(a)! - muscleOrder.get(b)!);
}

function conflict(message: string) {
  return Response.json({ error: message }, { status: 409 });
}

function parseSessionId(rawId: string): { error: string } | { value: number } {
  const id = Number(rawId);
  if (!/^\d+$/.test(rawId) || !Number.isInteger(id) || id <= 0) {
    return { error: "Session id must be a positive whole number." };
  }
  return { value: id };
}

/** Only `muscles` is accepted: the complete desired set, canonical keys only. */
function validateMusclesInput(body: unknown): { error: string } | { value: MuscleKeyValue[] } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { error: "Request body must be an object." };
  }
  const input = body as Record<string, unknown>;
  const keys = Object.keys(input);

  const allowed = new Set<string>(["muscles"]);
  const unknown = keys.filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    return { error: `Unsupported field(s): ${unknown.join(", ")}.` };
  }

  if (input.muscles === undefined) return { error: "muscles is required." };
  if (!Array.isArray(input.muscles)) return { error: "muscles must be an array." };

  const allowedMuscles = new Set<string>(muscleKeys);
  const seen = new Set<string>();
  for (const item of input.muscles) {
    if (typeof item !== "string") return { error: "muscles must contain only strings." };
    if (!allowedMuscles.has(item)) return { error: `Unsupported muscle value: ${item}.` };
    if (seen.has(item)) return { error: `Duplicate muscle value: ${item}.` };
    seen.add(item);
  }

  return { value: input.muscles as MuscleKeyValue[] };
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const actor = await resolveChildActor(request, false);
  if (actor instanceof Response) return actor;

  const { id: rawId } = await params;
  const parsedId = parseSessionId(rawId);
  if ("error" in parsedId) return badRequest(parsedId.error);
  const id = parsedId.value;

  try {
    const db = getDb();

    // Ownership-scoped existence check first: muscles are never looked up (or
    // reported missing) for a session that isn't visible to the caller. Status is
    // deliberately not checked here — GET reads whatever is persisted for
    // any coach-scoped session, regardless of its current status.
    const session = await findAccessibleSession(actor, id);

    if (!session) return notFound("Session not found.");

    const rows = await db
      .select({ muscle: sessionMuscles.muscle })
      .from(sessionMuscles)
      .where(eq(sessionMuscles.sessionId, id));

    // A session with no muscle rows yet is not an error: 200 with `muscles: []`.
    return Response.json({ muscles: canonicalOrder(rows.map((row) => row.muscle)) }, { status: 200 });
  } catch (error) {
    return serverError(
      "GET /api/sessions/[id]/muscles failed",
      error,
      "Unable to read the session muscles."
    );
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const actor = await resolveChildActor(request, true);
  if (actor instanceof Response) return actor;

  const { id: rawId } = await params;
  const parsedId = parseSessionId(rawId);
  if ("error" in parsedId) return badRequest(parsedId.error);
  const id = parsedId.value;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("Request body must be valid JSON.");
  }

  const validated = validateMusclesInput(body);
  if ("error" in validated) return badRequest(validated.error);
  const muscles = validated.value;

  try {
    const db = getDb();

    const session = await findAccessibleSession(actor, id);

    if (!session) return notFound("Session not found.");
    // Order: visible (404) -> writable (403) -> lifecycle/retention (409).
    if (!canWriteSessionDetail(actor, session)) {
      return Response.json({ error: "Forbidden." }, { status: 403 });
    }
    if (session.status !== "completed") {
      // Deliberately covers both ordinary completed sessions and completed
      // former replacements (replacementForId stays populated on those) —
      // any other status, including a still-pending replacement, is rejected.
      return conflict("Only a completed session can have its muscles set.");
    }
    if (isSessionDetailExpired(session.scheduledAt)) {
      return conflict("This session is past the detail retention window.");
    }

    const deleteStatement = db.delete(sessionMuscles).where(eq(sessionMuscles.sessionId, id));

    if (muscles.length === 0) {
      // Whole-set replacement with an empty set is just the delete: there is
      // nothing to insert, and nothing else needs atomicity with it.
      await deleteStatement;
    } else {
      // Replace-in-place, not append: the old set and the new set are one
      // logical write, so the delete and every insert run inside a single D1
      // batch (one implicit transaction) — the same atomicity mechanism this
      // codebase already relies on for the absence/replacement pair in
      // `POST /api/sessions/absence`. A failure on any statement rolls back
      // the whole batch, so a failed insert can never leave the session with
      // its previous set silently deleted.
      const insertStatements = muscles.map((muscle) =>
        db.insert(sessionMuscles).values({ sessionId: id, muscle })
      );
      const statements = [deleteStatement, ...insertStatements] as unknown as Parameters<typeof db.batch>[0];
      await db.batch(statements);
    }

    const rows = await db
      .select({ muscle: sessionMuscles.muscle })
      .from(sessionMuscles)
      .where(eq(sessionMuscles.sessionId, id));

    return Response.json({ muscles: canonicalOrder(rows.map((row) => row.muscle)) }, { status: 200 });
  } catch (error) {
    return serverError(
      "PUT /api/sessions/[id]/muscles failed",
      error,
      "Unable to save the session muscles."
    );
  }
}
