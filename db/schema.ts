import { sql } from "drizzle-orm";
import {
  AnySQLiteColumn,
  check,
  index,
  integer,
  real,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";

/**
 * Session lifecycle states.
 *
 * `replacement` marks a session created to make up for an earlier `absent`
 * session; it points back at the original through `replacementForId`.
 */
export const sessionStatuses = [
  "scheduled",
  "completed",
  "absent",
  "cancelled",
  "replacement",
] as const;

export type SessionStatus = (typeof sessionStatuses)[number];

/**
 * Canonical machine-persisted muscle keys. Matches `MuscleKey` in
 * `app/coach-app.tsx` exactly; UI display labels are a presentation concern
 * mapped separately and never persisted.
 */
export const muscleKeys = [
  "shoulders",
  "chest",
  "arms",
  "core",
  "back",
  "glutes",
  "quads",
  "hamstrings",
  "calves",
] as const;

export type MuscleKeyValue = (typeof muscleKeys)[number];

/**
 * Fixed three-level access model. No fourth `admin` role: Super Admin's
 * ability to create/manage Coach-level accounts is expressed through
 * `coach`, not a separate role (see SEC0A).
 */
export const userRoles = ["super_admin", "coach", "member"] as const;

export type UserRole = (typeof userRoles)[number];

/**
 * Central identity/account table, separate from the `coaches`/`members`
 * domain profiles (see SEC0A: identity ≠ profile ≠ ownership).
 * `passwordHash` is nullable because SEC0C (authentication) has not been
 * built yet — a null hash means the identity row exists but password login
 * has not been provisioned.
 */
export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  role: text("role", { enum: userRoles }).notNull(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash"),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const coaches = sqliteTable("coaches", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  /**
   * Nullable + unique for this migration: existing Coach rows predate User
   * identities. `NO ACTION` on delete so removing a User identity never
   * cascades into deleting Coach domain data; deactivation (`users.isActive`)
   * is the intended path, not deletion.
   */
  userId: integer("user_id").unique().references(() => users.id, { onDelete: "no action" }),
  name: text("name").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const members = sqliteTable(
  "members",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** Nullable + unique for this migration, same rationale as `coaches.userId`. */
    userId: integer("user_id").unique().references(() => users.id, { onDelete: "no action" }),
    coachId: integer("coach_id")
      .notNull()
      .references(() => coaches.id),
    name: text("name").notNull(),
    /** Stored as entered, digits only by convention: no units or formatting. */
    phone: text("phone"),
    /** Canonical unit: kilograms. Real, so values such as 72.5 are preserved. */
    weightKg: real("weight_kg"),
    /** Canonical unit: centimetres. */
    heightCm: integer("height_cm"),
    goal: text("goal").notNull(),
    /** Recurring default start time as canonical "HH:MM". */
    defaultStartTime: text("default_start_time").notNull(),
    defaultDurationMinutes: integer("default_duration_minutes").notNull(),
    /** JSON array of weekday codes, e.g. ["Sat","Mon","Wed"]. */
    preferredDays: text("preferred_days").notNull(),
    photoUrl: text("photo_url"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("members_coach_id_idx").on(table.coachId)]
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    memberId: integer("member_id")
      .notNull()
      .references(() => members.id),
    coachId: integer("coach_id")
      .notNull()
      .references(() => coaches.id),
    scheduledAt: text("scheduled_at").notNull(),
    status: text("status", { enum: sessionStatuses }).notNull().default("scheduled"),
    durationMinutes: integer("duration_minutes"),
    replacementForId: integer("replacement_for_id").references(
      (): AnySQLiteColumn => sessions.id
    ),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    // Serves Coach range reads: WHERE coach_id = ? AND scheduled_at BETWEEN ... ORDER BY scheduled_at.
    index("sessions_coach_id_scheduled_at_idx").on(table.coachId, table.scheduledAt),
    // Serves Member history reads: WHERE member_id = ? ORDER BY scheduled_at DESC LIMIT ...
    index("sessions_member_id_scheduled_at_idx").on(table.memberId, table.scheduledAt),
  ]
);

/**
 * At most one persisted note per session (MVP), enforced with a UNIQUE
 * constraint rather than left to future API logic. Deliberately carries no
 * memberId/coachId/date: those all come from the parent `sessions` row via
 * `sessionId`, and a note's visible date is the parent's `scheduled_at`, not
 * a value stored here. `onDelete: "cascade"` is scoped to this one new
 * relation — a note has no meaning without its session — and does not touch
 * any existing session foreign key's "no action" convention.
 */
export const sessionNotes = sqliteTable("session_notes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sessionId: integer("session_id")
    .notNull()
    .unique()
    .references(() => sessions.id, { onDelete: "cascade" }),
  note: text("note").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

/**
 * Structured per-Session muscle selection. A completed Session may have zero
 * or more rows here, one per trained muscle. No freshness ("days ago") is
 * stored: that is derived later from completed Sessions' `scheduledAt`.
 * `onDelete: "cascade"` mirrors `sessionNotes`; a muscle row has no meaning
 * without its parent Session.
 */
export const sessionMuscles = sqliteTable(
  "session_muscles",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sessionId: integer("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    muscle: text("muscle", { enum: muscleKeys }).notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [unique().on(table.sessionId, table.muscle)]
);

/**
 * Opaque DB-backed login sessions (SEC0C1). Only the SHA-256 of the raw
 * session token is stored (`tokenHash`); the raw token lives only in the
 * client cookie. Role and `isActive` are resolved fresh from `users` on each
 * request, so nothing identity-related is copied here. `expiresAt` is a UTC
 * ISO timestamp. Sessions cascade with their User; this differs from
 * Coach/Member profile FKs, which never cascade.
 */
export const authSessions = sqliteTable(
  "auth_sessions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: text("expires_at").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("auth_sessions_user_id_idx").on(table.userId)]
);

/**
 * Member-entered menstrual-cycle timing (SEC0G5c1). Timing only: no symptoms,
 * notes, prediction or cycle length. Belongs to the Member, not to a Coach, so
 * there is deliberately no `coachId`: Coach visibility is derived from the
 * Member's CURRENT `members.coachId` and follows reassignment. Dates are plain
 * Gregorian `YYYY-MM-DD` keys (no time/timezone). Not subject to the 30-day
 * Session-detail retention. The UNIQUE (member_id, period_start) enforces one
 * record per Member per period start and doubles as the read index for
 * `WHERE member_id = ? ORDER BY period_start DESC`.
 */
export const memberCycles = sqliteTable(
  "member_cycles",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    memberId: integer("member_id")
      .notNull()
      .references(() => members.id),
    periodStart: text("period_start").notNull(),
    periodEnd: text("period_end"),
    pmsStart: text("pms_start"),
    pmsEnd: text("pms_end"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [unique("member_cycles_member_id_period_start_unique").on(table.memberId, table.periodStart)]
);

/** Canonical meal types. The single source for the API, TypeScript and the DB CHECK. */
export const mealTypes = ["breakfast", "lunch", "dinner", "snack"] as const;

export type MealType = (typeof mealTypes)[number];

/**
 * A Member's own food log entry: what they ate (free-text `description`, no
 * calories/macros) and when. Belongs to the Member, not to a Coach, so there
 * is deliberately no `coachId`: Coach visibility is derived from the Member's
 * CURRENT `members.coachId` and follows reassignment. `loggedAt` is a UTC ISO
 * instant; Tehran day/week grouping is derived at read time. Not subject to
 * the Session-detail retention. The (member_id, logged_at) index serves both
 * the Member range read and the Coach range read (after scoping through
 * `members`). Hard-deleted by the Member; Member FK follows the existing
 * Member-owned convention (no cascade; Members are never hard-deleted).
 */
export const memberMeals = sqliteTable(
  "member_meals",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    memberId: integer("member_id")
      .notNull()
      .references(() => members.id),
    loggedAt: text("logged_at").notNull(),
    mealType: text("meal_type", { enum: mealTypes }).notNull(),
    description: text("description").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("member_meals_member_id_logged_at_idx").on(table.memberId, table.loggedAt),
    check(
      "member_meals_meal_type_check",
      sql`${table.mealType} IN ('breakfast', 'lunch', 'dinner', 'snack')`
    ),
  ]
);
