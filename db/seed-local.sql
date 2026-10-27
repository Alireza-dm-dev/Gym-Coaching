-- Local development seed. Not for production.
--
-- Re-runnable: every statement is INSERT OR IGNORE against an explicit primary
-- key, so a second run is a no-op rather than a duplicate or an error.
--
-- The explicit ids 1-4 deliberately mirror the mock member ids currently
-- hardcoded in the UI, so seeded rows line up with the existing fixtures.
--
-- Profile values are copied verbatim from `initialStudents` in
-- app/coach-app.tsx. `preferred_days` is a JSON array of weekday codes.
-- No member currently has a photo, so `photo_url` is NULL for all four.

INSERT OR IGNORE INTO coaches (id, name) VALUES
  (1, 'Jordan Lee');

INSERT OR IGNORE INTO members
  (id, coach_id, name, goal, default_start_time, default_duration_minutes, preferred_days, photo_url)
VALUES
  (1, 1, 'Alex Morgan',  'Strength & mobility', '08:30', 50, '["Sat","Mon","Wed"]', NULL),
  (2, 1, 'Maya Chen',    'Build endurance',     '10:00', 60, '["Sun","Tue","Thu"]', NULL),
  (3, 1, 'Daniel Reed',  'Return to training',  '14:30', 60, '["Mon","Wed","Fri"]', NULL),
  (4, 1, 'Nina Patel',   'Body composition',    '17:00', 45, '["Sat","Tue"]',       NULL);
