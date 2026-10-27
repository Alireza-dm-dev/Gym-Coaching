import { eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { coaches, members, users } from "../../../../db/schema";
import { authErrorResponse, requireRole } from "../../../../lib/authorization";
import { serverError } from "../../members/shared";

export const MIN_PASSWORD_LENGTH = 10;

/** Account/assignment management projection only: no profile, Session or Cycle data. */
export const adminMemberColumns = {
  id: members.id,
  name: members.name,
  userId: members.userId,
  email: users.email,
  isActive: users.isActive,
  coachId: coaches.id,
  coachName: coaches.name,
};

type AdminMemberRow = {
  id: number; name: string; userId: number | null; email: string | null;
  isActive: boolean | null; coachId: number; coachName: string;
};

export function toAdminMember(row: AdminMemberRow) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    userId: row.userId,
    isActive: row.isActive,
    coach: { id: row.coachId, name: row.coachName },
  };
}

/** Members JOIN coaches, LEFT JOIN users: profile-only Members have null account values. */
export function adminMemberQuery() {
  return getDb()
    .select(adminMemberColumns)
    .from(members)
    .innerJoin(coaches, eq(coaches.id, members.coachId))
    .leftJoin(users, eq(users.id, members.userId));
}

export async function loadAdminMember(id: number) {
  const [row] = await adminMemberQuery().where(eq(members.id, id)).limit(1);
  return row ? toAdminMember(row) : null;
}

export async function requireSuperAdmin(request: Request): Promise<Response | null> {
  try {
    await requireRole(request, "super_admin");
    return null;
  } catch (error) {
    return authErrorResponse(error) ?? serverError("Admin auth failed", error, "Unable to process the request.");
  }
}

/** Parses a JSON object body whose keys must all be in `allowed`; returns a message on failure. */
export async function readExactBody(request: Request, allowed: string[]): Promise<Record<string, unknown> | string> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return "Request body must be valid JSON.";
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return "Request body must be an object.";
  const input = body as Record<string, unknown>;
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) return `Unsupported field(s): ${unknown.join(", ")}.`;
  return input;
}

export function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}
