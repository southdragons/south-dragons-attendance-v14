-- Repair the attendance writer role in the v1.4 project.
-- No table privileges or RLS policies are changed.
grant usage on schema auth to sd_attendance_writer;
grant execute on function auth.uid() to sd_attendance_writer;
