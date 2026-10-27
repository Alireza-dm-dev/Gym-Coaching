-- Local development identity backfill. Not for production.
--
-- Backfills `users` rows for the existing Coach/Member fixtures seeded by
-- `db/seed-local.sql`, and links each profile to its new identity row via
-- `coaches.user_id` / `members.user_id`.
--
-- Re-runnable: User rows are inserted idempotently by stable fixture email
-- (INSERT OR IGNORE against the UNIQUE `email` column, not by assuming
-- autoincrement ids), and the profile links are re-applied by email lookup
-- every run rather than only on first insert — so running this twice leaves
-- user count, links, and role/profile pairings unchanged.
--
-- password_hash is NULL for every row: SEC0C (authentication) has not been
-- built yet, so no credential is invented here. is_active defaults to true.

INSERT OR IGNORE INTO users (role, email) VALUES
  ('coach',  'coach1@example.test'),
  ('member', 'member1@example.test'),
  ('member', 'member2@example.test'),
  ('member', 'member3@example.test'),
  ('member', 'member4@example.test');

UPDATE coaches
SET user_id = (SELECT id FROM users WHERE email = 'coach1@example.test')
WHERE id = 1;

UPDATE members
SET user_id = (SELECT id FROM users WHERE email = 'member1@example.test')
WHERE id = 1;

UPDATE members
SET user_id = (SELECT id FROM users WHERE email = 'member2@example.test')
WHERE id = 2;

UPDATE members
SET user_id = (SELECT id FROM users WHERE email = 'member3@example.test')
WHERE id = 3;

UPDATE members
SET user_id = (SELECT id FROM users WHERE email = 'member4@example.test')
WHERE id = 4;
