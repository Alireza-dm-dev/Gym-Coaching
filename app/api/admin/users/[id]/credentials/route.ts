import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "../../../../../../db";
import { authSessions, users } from "../../../../../../db/schema";
import { hashPassword } from "../../../../../../lib/auth-crypto";
import { badRequest, notFound, serverError } from "../../../../members/shared";
import { MIN_PASSWORD_LENGTH, parseId, readExactBody, requireSuperAdmin } from "../../../members/shared";

export const dynamic = "force-dynamic";

const safeUser = { id: users.id, role: users.role, email: users.email, isActive: users.isActive };

/**
 * Super Admin corrects a Coach/Member login email and/or sets a new password.
 * Super Admin accounts are not manageable here, and `isActive` is untouched
 * (use the status route). Any actual credential change purges every auth
 * session of the target in the same atomic batch.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireSuperAdmin(request);
  if (denied) return denied;

  const id = parseId((await params).id);
  if (id === null) return notFound("User not found.");

  const input = await readExactBody(request, ["email", "password"]);
  if (typeof input === "string") return badRequest(input);
  if (input.email === undefined && input.password === undefined) {
    return badRequest("Provide email, password or both.");
  }

  // Login lowercases its input, so only the normalized form is ever stored.
  let email: string | undefined;
  if (input.email !== undefined) {
    email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
    if (!email || !email.includes("@")) return badRequest("email must be a valid email address.");
  }
  let password: string | undefined;
  if (input.password !== undefined) {
    if (typeof input.password !== "string" || input.password.length < MIN_PASSWORD_LENGTH) {
      return badRequest(`password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    }
    password = input.password;
  }

  const db = getDb();
  const ctx = "PATCH /api/admin/users/[id]/credentials failed";
  try {
    const [user] = await db.select(safeUser).from(users).where(eq(users.id, id)).limit(1);
    if (!user) return notFound("User not found.");
    if (user.role === "super_admin") {
      return Response.json({ error: "Super Admin accounts cannot be changed here." }, { status: 409 });
    }

    const emailChanges = email !== undefined && email !== user.email;
    if (!emailChanges && password === undefined) return Response.json({ user }); // pure no-op

    if (emailChanges) {
      const [clash] = await db.select({ id: users.id }).from(users).where(eq(users.email, email!)).limit(1);
      if (clash) return Response.json({ error: "An account with this email already exists." }, { status: 409 });
    }

    const passwordHash = password === undefined ? undefined : await hashPassword(password);
    // One atomic D1 batch: the update and the session purge commit together or
    // not at all (a unique-constraint race on email rolls both back).
    const [updated] = await db.batch([
      db.update(users)
        .set({
          ...(emailChanges ? { email } : {}),
          ...(passwordHash === undefined ? {} : { passwordHash }),
          updatedAt: sql`CURRENT_TIMESTAMP`,
        })
        .where(and(eq(users.id, id), inArray(users.role, ["coach", "member"])))
        .returning(safeUser),
      db.delete(authSessions).where(
        and(
          eq(authSessions.userId, id),
          inArray(authSessions.userId, db.select({ id: users.id }).from(users).where(and(eq(users.id, id), inArray(users.role, ["coach", "member"]))))
        )
      ),
    ]);
    if (updated.length === 0) return notFound("User not found.");
    return Response.json({ user: updated[0] });
  } catch (error) {
    if (email !== undefined) {
      const [clash] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
      if (clash && clash.id !== id) {
        return Response.json({ error: "An account with this email already exists." }, { status: 409 });
      }
    }
    return serverError(ctx, error, "Unable to update the credentials.");
  }
}
