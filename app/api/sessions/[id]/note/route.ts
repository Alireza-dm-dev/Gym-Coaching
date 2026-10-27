import { eq, sql } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { sessionNotes } from "../../../../../db/schema";
import { badRequest, notFound, serverError } from "../../../members/shared";
import { isSessionDetailExpired } from "../../../../../lib/session-retention";
import { canWriteSessionDetail, findAccessibleSession, resolveChildActor } from "../../shared";

// Session notes are persisted state, so never serve them from a cached render.
export const dynamic = "force-dynamic";

/** Explicit projection: GET and PUT return the identical note shape. */
const noteColumns = {
  id: sessionNotes.id,
  sessionId: sessionNotes.sessionId,
  note: sessionNotes.note,
  createdAt: sessionNotes.createdAt,
  updatedAt: sessionNotes.updatedAt,
};

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

/** Only `note` is accepted; every other field is server-decided or read-only. */
function validateNoteInput(body: unknown): { error: string } | { value: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { error: "Request body must be an object." };
  }
  const input = body as Record<string, unknown>;
  const keys = Object.keys(input);

  const allowed = new Set<string>(["note"]);
  const unknown = keys.filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    return { error: `Unsupported field(s): ${unknown.join(", ")}.` };
  }

  if (input.note === undefined) return { error: "note is required." };
  if (typeof input.note !== "string") return { error: "note must be a string." };

  const trimmed = input.note.trim();
  if (!trimmed) return { error: "note must not be empty." };

  return { value: trimmed };
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

    // Ownership-scoped existence check first: a note is never looked up (or
    // reported missing) for a session that isn't visible to the caller.
    const session = await findAccessibleSession(actor, id);

    if (!session) return notFound("Session not found.");

    const [row] = await db
      .select(noteColumns)
      .from(sessionNotes)
      .where(eq(sessionNotes.sessionId, id))
      .limit(1);

    // A session with no note yet is not an error: 200 with `note: null`.
    return Response.json({ note: row ?? null }, { status: 200 });
  } catch (error) {
    return serverError(
      "GET /api/sessions/[id]/note failed",
      error,
      "Unable to read the session note."
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

  const validated = validateNoteInput(body);
  if ("error" in validated) return badRequest(validated.error);
  const note = validated.value;

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
      return conflict("Only a completed session can have a note.");
    }
    if (isSessionDetailExpired(session.scheduledAt)) {
      return conflict("This session is past the detail retention window.");
    }

    // A single conflict-safe upsert on the existing UNIQUE(session_id)
    // constraint: creates the first note, or updates the same row (same id)
    // on a second save, rather than a separate select-then-insert-or-update.
    const [row] = await db
      .insert(sessionNotes)
      .values({ sessionId: id, note })
      .onConflictDoUpdate({
        target: sessionNotes.sessionId,
        set: { note, updatedAt: sql`CURRENT_TIMESTAMP` },
      })
      .returning(noteColumns);

    return Response.json({ note: row }, { status: 200 });
  } catch (error) {
    return serverError(
      "PUT /api/sessions/[id]/note failed",
      error,
      "Unable to save the session note."
    );
  }
}
