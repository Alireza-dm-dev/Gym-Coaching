/**
 * TEMPORARY FIRST-PRODUCTION-ADMIN BOOTSTRAP.
 * REMOVE IMMEDIATELY AFTER THE FIRST SUPER ADMIN IS CREATED.
 *
 * Exists only because the Sites-managed D1 cannot be reached by the CLI
 * (`scripts/bootstrap-production-admin.ts`). The route has no authentication of
 * its own, so the Site must stay owner-only/private for as long as it is
 * deployed. Its only protection in code is database-side and one-time: it
 * refuses once any `super_admin` exists, so it can never reset or add an admin.
 * It creates one `users` row and nothing else: no profile, no session, no login.
 */
import { sql } from "drizzle-orm";
import { getDb } from "../../../../db";
import { hashPassword } from "../../../../lib/auth-crypto";
import { MIN_PASSWORD_LENGTH } from "../../admin/coaches/route";
import { badRequest } from "../../members/shared";

export const dynamic = "force-dynamic";

const ADMIN_EXISTS = "A Super Admin already exists. Bootstrap refused.";
const EMAIL_EXISTS = "An account with this email already exists.";
const conflict = (error: string) => Response.json({ error }, { status: 409 });
/** Drizzle errors carry the query parameters (email, password hash), so log only the error name. */
const fail = (context: string, error: unknown, message = "Unable to create the Super Admin.") => {
  console.error(context, error instanceof Error ? error.name : "UnknownError");
  return Response.json({ error: message }, { status: 500 });
};

/** Same rule as the CLI bootstrap: strict shape, and `.test` (every fixture domain) refused. */
function validateEmail(raw: unknown): { email: string } | { error: string } {
  const email = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!email) return { error: "email is required." };
  if (!/^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(email)) return { error: "email must be a valid email address." };
  const domain = email.split("@")[1];
  if (domain === "test" || domain.endsWith(".test")) return { error: "Fixture/test email domains (*.test) are not allowed." };
  return { email };
}

type DbRow = Record<string, unknown>;

export async function POST(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^application\/json\s*(;|$)/i.test(contentType)) {
    return Response.json({ error: "Content-Type must be application/json." }, { status: 415 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("Request body must be valid JSON.");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return badRequest("Request body must be an object.");
  const input = body as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== "email" && key !== "password")) return badRequest("Only email and password are accepted.");

  const checked = validateEmail(input.email);
  if ("error" in checked) return badRequest(checked.error);
  const { email } = checked;
  if (typeof input.password !== "string" || input.password.length < MIN_PASSWORD_LENGTH) {
    return badRequest(`password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }

  try {
    const db = getDb();
    const all = async (query: ReturnType<typeof sql>) => (await db.all(query)) as DbRow[];

    const [table] = await all(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'`);
    if (!table) return Response.json({ error: "Database schema is not ready." }, { status: 500 });

    const state = async () => {
      const [row] = await all(sql`SELECT
        (SELECT COUNT(*) FROM users WHERE role = 'super_admin') AS admins,
        (SELECT COUNT(*) FROM users WHERE email = ${email}) AS same_email`);
      return { admins: Number(row?.admins), sameEmail: Number(row?.same_email) };
    };
    const refusal = (s: { admins: number; sameEmail: number }) =>
      s.admins > 0 ? conflict(ADMIN_EXISTS) : s.sameEmail > 0 ? conflict(EMAIL_EXISTS) : null;

    const before = await state();
    const early = refusal(before);
    if (early) return early;

    const passwordHash = await hashPassword(input.password);

    // One atomic statement: the guards repeat the checks so a request that
    // slips in between them and the write cannot create a second admin.
    let changes = 0;
    try {
      const result = await db.run(sql`INSERT INTO users (role, email, password_hash, is_active)
        SELECT 'super_admin', ${email}, ${passwordHash}, 1
        WHERE NOT EXISTS (SELECT 1 FROM users WHERE role = 'super_admin')
        AND NOT EXISTS (SELECT 1 FROM users WHERE email = ${email})`);
      changes = Number(result.meta?.changes ?? 0);
    } catch (error) {
      // A concurrent insert of the same email trips the unique constraint.
      const lost = refusal(await state());
      if (lost) return lost;
      throw error;
    }
    if (changes === 0) {
      return refusal(await state()) ?? fail("first-admin bootstrap insert changed no rows", null);
    }

    const admins = await all(sql`SELECT email, is_active AS active FROM users WHERE role = 'super_admin'`);
    if (admins.length !== 1 || admins[0].email !== email || Number(admins[0].active) !== 1) {
      return fail("first-admin bootstrap verification failed", null, "Unable to verify the Super Admin.");
    }

    return Response.json({ created: true, email, role: "super_admin" }, { status: 201 });
  } catch (error) {
    return fail("POST /api/bootstrap/first-admin failed", error);
  }
}
