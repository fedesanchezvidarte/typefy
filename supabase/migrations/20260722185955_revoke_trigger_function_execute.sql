-- Close the REST RPC surface on our SECURITY DEFINER trigger functions.
--
-- Postgres grants EXECUTE to PUBLIC on new functions by default, so PostgREST exposes
-- handle_new_user() and touch_updated_at() at /rest/v1/rpc/<fn>, callable by anon and
-- authenticated (Supabase advisors 0028/0029). They are only ever invoked by triggers,
-- and trigger execution does not check the session role's EXECUTE privilege, so revoking
-- EXECUTE from the API roles removes the exposure without affecting the triggers.
revoke execute on function public.handle_new_user()
from
	public,
	anon,
	authenticated;

revoke execute on function public.touch_updated_at()
from
	public,
	anon,
	authenticated;
