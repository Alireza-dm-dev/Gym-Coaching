import { asc } from "drizzle-orm";
import { members } from "../../../../db/schema";
import { serverError } from "../../members/shared";
import { adminMemberQuery, requireSuperAdmin, toAdminMember } from "./shared";

// Account data is persisted state, so never serve it from a cached render.
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = await requireSuperAdmin(request);
  if (denied) return denied;

  try {
    // One query, no per-Member lookups; unpaginated at the expected ~300 Members.
    const rows = await adminMemberQuery().orderBy(asc(members.id));
    return Response.json({ members: rows.map(toAdminMember) });
  } catch (error) {
    return serverError("GET /api/admin/members failed", error, "Unable to load members.");
  }
}
