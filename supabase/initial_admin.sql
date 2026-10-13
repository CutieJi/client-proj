-- Create or reset the first administrator account in Supabase SQL Editor.
-- Replace these example values before running. Never commit real passwords.
do $$
declare
  account_username constant text := 'admin';
  account_display_name constant text := 'System Administrator';
  account_password constant text := 'REPLACE_WITH_A_UNIQUE_PASSWORD';
begin
  if account_username !~ '^[a-z0-9][a-z0-9._-]{2,31}$' then
    raise exception 'Username must be 3-32 lowercase letters, numbers, periods, underscores, or hyphens.';
  end if;
  if length(trim(account_display_name)) not between 1 and 120 then
    raise exception 'Display name must be between 1 and 120 characters.';
  end if;
  if length(account_password) < 8 or account_password = 'REPLACE_WITH_A_UNIQUE_PASSWORD' then
    raise exception 'Set a unique password of at least 8 characters before running this script.';
  end if;

  insert into public.accounts (username, display_name, password_hash, role)
  values (
    account_username,
    trim(account_display_name),
    extensions.crypt(account_password, extensions.gen_salt('bf', 12)),
    'admin'
  )
  on conflict (username) do update
  set display_name = excluded.display_name,
      password_hash = excluded.password_hash,
      role = 'admin';
end
$$;
