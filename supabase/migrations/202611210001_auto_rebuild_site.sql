-- Rebuild the static site automatically whenever a live partner page appears, changes or disappears,
-- so the owner never has to trigger a deploy by hand.
-- Setup (once, in the Supabase SQL editor; the URL is a secret, keep it out of git):
--   select vault.create_secret('https://api.netlify.com/build_hooks/<id>', 'netlify_build_hook');
-- Without that secret the trigger does nothing.

create extension if not exists pg_net with schema extensions;

create function private.rebuild_site()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  hook text;
begin
  -- Only live rows are built, so only changes into, out of or within 'live' need a rebuild.
  if (tg_op <> 'INSERT' and old.status = 'live') or (tg_op <> 'DELETE' and new.status = 'live') then
    select s.decrypted_secret into hook from vault.decrypted_secrets s where s.name = 'netlify_build_hook';
    if hook is not null then
      perform net.http_post(url := hook, body := '{}'::jsonb);
    end if;
  end if;
  return null;
end $$;
revoke all on function private.rebuild_site() from public, anon, authenticated;

create trigger partners_rebuild_site
  after insert or update or delete on public.partners
  for each row execute function private.rebuild_site();
