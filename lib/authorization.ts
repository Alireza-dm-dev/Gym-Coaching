import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { coaches, members } from "../db/schema";
import {
  AuthenticatedUser, UserRole, getCurrentUser,
} from "./auth-session";

/**
 * Thrown by the require* helpers; routes convert it with `authErrorResponse`.
 * 401 = no valid session. 403 = authenticated but wrong role, or the role has
 * no linked profile (an unusable account, so it fails closed as a permission
 * failure rather than leaking linkage details through a 500).
 */
export class AuthError extends Error {
  constructor(public readonly status: 401 | 403, message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export function authErrorResponse(error: unknown): Response | null {
  return error instanceof AuthError
    ? Response.json({ error: error.message }, { status: error.status })
    : null;
}

export async function requireUser(request: Request): Promise<AuthenticatedUser> {
  const user = await getCurrentUser(request);
  if (!user) throw new AuthError(401, "Not authenticated.");
  return user;
}

export async function requireRole(
  request: Request,
  role: UserRole
): Promise<AuthenticatedUser> {
  const user = await requireUser(request);
  if (user.role !== role) throw new AuthError(403, "Forbidden.");
  return user;
}

const NO_PROFILE = "Account is not set up for this role.";

/** Role is checked first; a stray profile link never grants a role. */
export async function requireCoach(request: Request) {
  const user = await requireRole(request, "coach");
  const [coach] = await getDb()
    .select({ id: coaches.id, userId: coaches.userId, name: coaches.name })
    .from(coaches)
    .where(eq(coaches.userId, user.id))
    .limit(1);
  if (!coach) throw new AuthError(403, NO_PROFILE);
  return { user, coach };
}

export async function requireMember(request: Request) {
  const user = await requireRole(request, "member");
  const [member] = await getDb()
    .select({
      id: members.id,
      userId: members.userId,
      coachId: members.coachId,
      name: members.name,
    })
    .from(members)
    .where(eq(members.userId, user.id))
    .limit(1);
  if (!member) throw new AuthError(403, NO_PROFILE);
  return { user, member };
}
