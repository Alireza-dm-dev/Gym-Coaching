import { members } from "../../../db/schema";
import { authErrorResponse, requireCoach, requireUser } from "../../../lib/authorization";

export type MemberActor = { kind: "coach"; coachId: number } | { kind: "super_admin" };

/**
 * Resolves the caller for Member management routes. Members get 403; Coaches
 * resolve through requireCoach; Super Admin needs no Coach profile.
 * Returns the actor or a ready-made error Response (401/403).
 */
export async function resolveMemberActor(
  request: Request
): Promise<MemberActor | Response> {
  try {
    const user = await requireUser(request);
    if (user.role === "super_admin") return { kind: "super_admin" };
    if (user.role === "coach") {
      const { coach } = await requireCoach(request);
      return { kind: "coach", coachId: coach.id };
    }
    return Response.json({ error: "Forbidden." }, { status: 403 });
  } catch (error) {
    const response = authErrorResponse(error);
    if (response) return response;
    return serverError("Member actor resolution failed", error, "Unable to process the request.");
  }
}

// Weekday codes exactly as the UI's day picker emits them.
export const WEEKDAYS = ["Sat", "Sun", "Mon", "Tue", "Wed", "Thu", "Fri"];
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Shared projection: GET, POST and PATCH all return the identical shape. */
export const memberColumns = {
  id: members.id,
  name: members.name,
  coachId: members.coachId,
  phone: members.phone,
  weightKg: members.weightKg,
  heightCm: members.heightCm,
  goal: members.goal,
  defaultStartTime: members.defaultStartTime,
  defaultDurationMinutes: members.defaultDurationMinutes,
  preferredDays: members.preferredDays,
  photoUrl: members.photoUrl,
};

export type MemberRow = {
  id: number; name: string; coachId: number; phone: string | null;
  weightKg: number | null; heightCm: number | null; goal: string;
  defaultStartTime: string; defaultDurationMinutes: number;
  preferredDays: string; photoUrl: string | null;
};

/**
 * `preferred_days` is stored as JSON text because SQLite has no array type.
 * Anything that is not a JSON array of strings is corrupt persisted data, so
 * this throws rather than degrading to an empty list: an empty array would be
 * indistinguishable from a member who genuinely trains on no days.
 */
export function parsePreferredDays(value: string, memberId: number): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`member ${memberId}: preferred_days is not valid JSON`);
  }

  if (!Array.isArray(parsed) || !parsed.every((day) => typeof day === "string")) {
    throw new Error(
      `member ${memberId}: preferred_days is not a JSON array of strings`
    );
  }

  return parsed;
}

export function toApiMember(row: MemberRow) {
  return { ...row, preferredDays: parsePreferredDays(row.preferredDays, row.id) };
}

export function badRequest(message: string) {
  return Response.json({ error: message }, { status: 400 });
}

export function notFound(message: string) {
  return Response.json({ error: message }, { status: 404 });
}

export function serverError(context: string, error: unknown, message: string) {
  // The underlying message can name bindings, config paths and row contents,
  // so keep it in the server logs and return a fixed string to the client.
  console.error(context, error);
  return Response.json({ error: message }, { status: 500 });
}

export type MemberInput = {
  name: string; phone: string; weightKg: number; heightCm: number;
  goal: string; defaultStartTime: string; defaultDurationMinutes: number;
  preferredDays: string[];
};

export const MEMBER_FIELDS = [
  "name", "phone", "weightKg", "heightCm",
  "goal", "defaultStartTime", "defaultDurationMinutes", "preferredDays",
] as const;

export type MemberField = (typeof MEMBER_FIELDS)[number];

type Result<T> = { error: string } | { value: T };

function requiredText(value: unknown, field: string): Result<string> {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? { value: trimmed } : { error: `${field} must be a non-empty string.` };
}

/**
 * One validator per field, shared by POST (all required) and PATCH (partial).
 * Nothing is coerced: "abc" is rejected outright, never turned into NaN or 0.
 * A supplied field can never be cleared — partial does not mean nullable.
 */
export const validators: {
  [K in MemberField]: (value: unknown) => Result<MemberInput[K]>;
} = {
  name: (value) => requiredText(value, "name"),
  phone: (value) => requiredText(value, "phone"),
  goal: (value) => requiredText(value, "goal"),
  weightKg: (value) =>
    typeof value === "number" && Number.isFinite(value) && value > 0
      ? { value }
      : { error: "weightKg must be a positive number." },
  heightCm: (value) =>
    typeof value === "number" && Number.isInteger(value) && value > 0
      ? { value }
      : { error: "heightCm must be a positive whole number." },
  defaultDurationMinutes: (value) =>
    typeof value === "number" && Number.isInteger(value) && value > 0
      ? { value }
      : { error: "defaultDurationMinutes must be a positive whole number." },
  defaultStartTime: (value) => {
    const trimmed = typeof value === "string" ? value.trim() : "";
    return TIME_PATTERN.test(trimmed)
      ? { value: trimmed }
      : { error: "defaultStartTime must be a 24-hour HH:MM value." };
  },
  preferredDays: (value) =>
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((day) => typeof day === "string" && WEEKDAYS.includes(day))
      ? { value: value as string[] }
      : { error: `preferredDays must be a non-empty array of ${WEEKDAYS.join(", ")}.` },
};

/** Maps validated input onto column values; preferredDays becomes JSON text. */
export function toColumnValues(patch: Partial<MemberInput>) {
  return {
    ...(patch.name !== undefined && { name: patch.name }),
    ...(patch.phone !== undefined && { phone: patch.phone }),
    ...(patch.weightKg !== undefined && { weightKg: patch.weightKg }),
    ...(patch.heightCm !== undefined && { heightCm: patch.heightCm }),
    ...(patch.goal !== undefined && { goal: patch.goal }),
    ...(patch.defaultStartTime !== undefined && { defaultStartTime: patch.defaultStartTime }),
    ...(patch.defaultDurationMinutes !== undefined && {
      defaultDurationMinutes: patch.defaultDurationMinutes,
    }),
    ...(patch.preferredDays !== undefined && {
      preferredDays: JSON.stringify(patch.preferredDays),
    }),
  };
}
