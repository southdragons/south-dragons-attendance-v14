-- ADDITIVE ONLY. Apply to the NEW project cuhkjnuwozgnqqqvqhnl after review.
-- Never run the old setup.sql against a populated database.
BEGIN;
CREATE TABLE IF NOT EXISTS public.attendance_reminder_deliveries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  target_date date NOT NULL,
  destination text NOT NULL CHECK (destination IN ('test','production')),
  retry_key uuid NOT NULL DEFAULT gen_random_uuid(),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','processing','sent','failed')),
  attempt_count integer NOT NULL DEFAULT 0,
  claimed_at timestamptz,
  sent_at timestamptz,
  last_http_status integer,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (target_date,destination),
  UNIQUE (retry_key)
);
ALTER TABLE public.attendance_reminder_deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.attendance_reminder_deliveries FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE ON public.attendance_reminder_deliveries TO service_role;
GRANT USAGE,SELECT ON SEQUENCE public.attendance_reminder_deliveries_id_seq TO service_role;

-- One atomic claim per calendar date and destination. An expired claim may be retried
-- with the SAME LINE retry key, so a lost LINE response does not cause a duplicate.
CREATE OR REPLACE FUNCTION public.claim_attendance_reminder(p_date date, p_destination text)
RETURNS TABLE (retry_key uuid, should_send boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v public.attendance_reminder_deliveries%ROWTYPE;
BEGIN
  IF p_destination NOT IN ('test','production') OR p_date IS NULL THEN RAISE EXCEPTION 'BAD_REQUEST'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('attendance-reminder:' || p_date::text || ':' || p_destination, 0));
  INSERT INTO public.attendance_reminder_deliveries (target_date,destination)
    VALUES (p_date,p_destination) ON CONFLICT (target_date,destination) DO NOTHING;
  SELECT * INTO v FROM public.attendance_reminder_deliveries d
    WHERE d.target_date=p_date AND d.destination=p_destination FOR UPDATE;
  IF v.state='sent' OR (v.state='processing' AND v.claimed_at > now()-interval '5 minutes') THEN
    RETURN QUERY SELECT v.retry_key, false;
    RETURN;
  END IF;
  UPDATE public.attendance_reminder_deliveries d
    SET state='processing',claimed_at=now(),attempt_count=d.attempt_count+1,last_error=NULL
    WHERE d.id=v.id;
  RETURN QUERY SELECT v.retry_key, true;
END $$;

CREATE OR REPLACE FUNCTION public.finish_attendance_reminder(
  p_date date, p_destination text, p_retry_key uuid,
  p_success boolean, p_status integer, p_error text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  UPDATE public.attendance_reminder_deliveries d SET
    state=CASE WHEN p_success THEN 'sent' ELSE 'failed' END,
    sent_at=CASE WHEN p_success THEN now() ELSE d.sent_at END,
    last_http_status=p_status,
    last_error=CASE WHEN p_success THEN NULL ELSE left(coalesce(p_error,'unknown'),200) END
  WHERE d.target_date=p_date AND d.destination=p_destination AND d.retry_key=p_retry_key
    AND d.state='processing';
  IF NOT FOUND THEN RAISE EXCEPTION 'CLAIM_NOT_FOUND'; END IF;
END $$;

-- Functions are callable ONLY by the service_role used inside Edge Functions.
REVOKE ALL ON FUNCTION public.claim_attendance_reminder(date,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.finish_attendance_reminder(date,text,uuid,boolean,integer,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_attendance_reminder(date,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_attendance_reminder(date,text,uuid,boolean,integer,text) TO service_role;
COMMIT;
