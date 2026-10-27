import { and, eq, isNull, notExists, sql } from "drizzle-orm";
import { getDb } from "../../../../../../db";
import { members, users } from "../../../../../../db/schema";
import { hashPassword } from "../../../../../../lib/auth-crypto";
import { badRequest, notFound, serverError } from "../../../../members/shared";
import { MIN_PASSWORD_LENGTH, loadAdminMember, parseId, readExactBody, requireSuperAdmin } from "../../shared";

export const dynamic = "force-dynamic";

/** Provision the initial login for an existing profile-only Member (no duplicate profile row). */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireSuperAdmin(request);
  if (denied) return denied;

  const id = parseId((await params).id);
  if (id === null) return notFound("Member not found.");

  const input = await readExactBody(request, ["email", "password"]);
  if (typeof input === "string") return badRequest(input);
  // Login lowercases its input, so only the normalized form is ever stored.
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  if (!email || !email.includes("@")) return badRequest("email must be a valid email address.");
  if (typeof input.password !== "string" || input.password.length < MIN_PASSWORD_LENGTH) {
    return badRequest(`password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }

  const db = getDb();
  const ctx = "POST /api/admin/members/[id]/account failed";
  try {
    const existing = await loadAdminMember(id);
    if (!existing) return notFound("Member not found.");
    if (existing.userId !== null) {
      return Response.json({ error: "This member already has a login account." }, { status: 409 });
    }

    const passwordHash = await hashPassword(input.password);
    // One atomic D1 batch: insert the User, link it only while the Member is
    // still unlinked, then drop the User again if nothing linked it (a
    // concurrent provision won the race). No orphan User or overwritten link
    // can survive the batch.
    await db.batch([
      db.insert(users).values({ role: "member", email, passwordHash, isActive: true }),
      db.update(members)
        .set({ userId: sql`(SELECT id FROM users WHERE email = ${email})` })
        .where(and(eq(members.id, id), isNull(members.userId))),
      db.delete(users).where(
        and(
          eq(users.email, email),
          notExists(db.select({ one: sql`1` }).from(members).where(eq(members.userId, users.id)))
        )
      ),
    ]);

    const after = await loadAdminMember(id);
    if (after && after.userId !== null && after.email === email) {
      return Response.json({ member: after }, { status: 201 });
    }
    return Response.json({ error: "This member already has a login account." }, { status: 409 });
  } catch (error) {
    // The batch rolled back. A taken email is the unique constraint (409);
    // otherwise it is a genuine failure.
    const [clash] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    if (clash) return Response.json({ error: "An account with this email already exists." }, { status: 409 });
    return serverError(ctx, error, "Unable to create the member account.");
  }
}
