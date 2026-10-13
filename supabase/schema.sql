-- Materials Inventory schema for Supabase (PostgreSQL)
-- Run this file in Supabase Dashboard > SQL Editor.
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
do $$
declare
  extension_schema text;
begin
  select namespace.nspname
  into extension_schema
  from pg_extension as installed
  join pg_namespace as namespace on namespace.oid = installed.extnamespace
  where installed.extname = 'pgcrypto';

  if extension_schema <> 'extensions' then
    alter extension pgcrypto set schema extensions;
  end if;
end
$$;

create table if not exists public.inventory_items (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category text not null,
  brand text not null default '',
  variant text not null default '',
  sku text not null default '',
  unit text not null default 'piece',
  quantity numeric(12,2) not null default 0 check (quantity >= 0),
  unit_price numeric(12,2) not null default 0 check (unit_price >= 0),
  low_stock_threshold numeric(12,2) not null default 5 check (low_stock_threshold >= 0),
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.inventory_transactions (
  id uuid primary key default gen_random_uuid(),
  item_id uuid references public.inventory_items(id) on delete set null,
  type text not null check (type in ('stock_in','stock_out','adjustment')),
  quantity numeric(12,2) not null check (quantity > 0),
  note text not null default '',
  balance_after numeric(12,2) not null check (balance_after >= 0),
  created_at timestamptz not null default now()
);

do $$
begin
  if to_regclass('public.accounts') is null and to_regclass('public.app_users') is not null then
    alter table public.app_users rename to accounts;
  end if;
end
$$;

create table if not exists public.accounts (
  user_id uuid primary key default gen_random_uuid(),
  username text,
  password_hash text,
  display_name text not null default '',
  role text not null check (role in ('admin','user')),
  created_at timestamptz not null default now()
);

alter table public.accounts add column if not exists username text;
alter table public.accounts add column if not exists display_name text not null default '';
alter table public.accounts add column if not exists password_hash text;
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'accounts' and column_name = 'email'
  ) then
    execute $migration$
      with legacy_names as (
        select
          user_id,
          lower(regexp_replace(split_part(email, '@', 1), '[^a-zA-Z0-9._-]', '', 'g')) as base_username,
          row_number() over (
            partition by lower(regexp_replace(split_part(email, '@', 1), '[^a-zA-Z0-9._-]', '', 'g'))
            order by created_at, user_id
          ) as name_number
        from public.accounts
        where username is null
      )
      update public.accounts as users
      set
        username = case
          when length(legacy_names.base_username) between 3 and 32
            and legacy_names.base_username ~ '^[a-z0-9]'
            and legacy_names.name_number = 1
            then legacy_names.base_username
          else 'user_' || left(users.user_id::text, 12)
        end,
        display_name = coalesce(nullif(users.display_name, ''), split_part(users.email, '@', 1))
      from legacy_names
      where users.user_id = legacy_names.user_id
    $migration$;
  end if;
end
$$;

update public.accounts
set username = 'user_' || left(user_id::text, 12),
    display_name = coalesce(nullif(display_name, ''), 'User ' || left(user_id::text, 12))
where username is null;

alter table public.accounts alter column username set not null;
create unique index if not exists accounts_username_idx on public.accounts(username);
alter table public.accounts alter column user_id set default gen_random_uuid();

alter table public.accounts drop constraint if exists app_users_user_id_fkey;
alter table public.accounts drop constraint if exists accounts_user_id_fkey;
alter table public.accounts drop column if exists email;

drop table if exists public.app_sessions;

create index if not exists inventory_items_category_idx on public.inventory_items(category);
create index if not exists inventory_items_name_idx on public.inventory_items(name);
create index if not exists inventory_transactions_created_idx on public.inventory_transactions(created_at desc);
create index if not exists inventory_transactions_item_idx on public.inventory_transactions(item_id);

-- This starter app uses the service-role key only on the Node server.
-- Never place the service-role key in public/app.js or any browser HTML.
-- Do not expose the service-role key to users or commit .env.
alter table public.inventory_items enable row level security;
alter table public.inventory_transactions enable row level security;
alter table public.accounts enable row level security;

-- No public policies are added: browser clients cannot access these tables directly.
-- The Express server uses the server-side service role key.

create or replace function public.authenticate_app_user(p_username text, p_password text)
returns table (user_id uuid, username text, display_name text, role text)
language sql
security definer
set search_path = ''
as $$
  select users.user_id, users.username, users.display_name, users.role
  from public.accounts as users
  where users.username = lower(trim(p_username))
    and users.password_hash is not null
    and extensions.crypt(p_password, users.password_hash) = users.password_hash
  limit 1;
$$;

revoke all on function public.authenticate_app_user(text, text) from public, anon, authenticated;
grant execute on function public.authenticate_app_user(text, text) to service_role;

create or replace function public.change_app_user_password(
  p_user_id uuid,
  p_current_password text,
  p_new_password text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if length(coalesce(p_new_password, '')) < 8 then
    raise exception 'New password must be at least 8 characters.';
  end if;

  update public.accounts as users
  set password_hash = extensions.crypt(p_new_password, extensions.gen_salt('bf', 12))
  where users.user_id = p_user_id
    and users.password_hash is not null
    and extensions.crypt(p_current_password, users.password_hash) = users.password_hash;

  if not found then
    raise exception 'Current password is incorrect.';
  end if;
end;
$$;

revoke all on function public.change_app_user_password(uuid, text, text) from public, anon, authenticated;
grant execute on function public.change_app_user_password(uuid, text, text) to service_role;

create or replace function public.save_app_user(
  p_username text,
  p_display_name text,
  p_password text,
  p_role text,
  p_user_id uuid default null
)
returns table (user_id uuid, username text, display_name text, role text, created_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_username text := lower(trim(p_username));
  normalized_display_name text := trim(p_display_name);
  saved_user_id uuid;
begin
  if normalized_username is null or normalized_username !~ '^[a-z0-9][a-z0-9._-]{2,31}$' then
    raise exception 'Username must be 3-32 characters: letters, numbers, periods, underscores, or hyphens.';
  end if;
  if normalized_display_name = '' or length(normalized_display_name) > 120 then
    raise exception 'Display name is required and must be 120 characters or fewer.';
  end if;
  if p_role is null or p_role not in ('admin', 'user') then
    raise exception 'Choose a valid account role.';
  end if;

  if p_user_id is null then
    if length(coalesce(p_password, '')) < 8 then
      raise exception 'Password must be at least 8 characters.';
    end if;
    insert into public.accounts (username, display_name, password_hash, role)
    values (
      normalized_username,
      normalized_display_name,
      extensions.crypt(p_password, extensions.gen_salt('bf', 12)),
      p_role
    )
    returning accounts.user_id into saved_user_id;
  else
    if p_password is not null and p_password <> '' and length(p_password) < 8 then
      raise exception 'Password must be at least 8 characters.';
    end if;
    update public.accounts
    set username = normalized_username,
        display_name = normalized_display_name,
        password_hash = case
          when p_password is null or p_password = '' then password_hash
          else extensions.crypt(p_password, extensions.gen_salt('bf', 12))
        end,
        role = p_role
    where accounts.user_id = p_user_id
    returning accounts.user_id into saved_user_id;
    if saved_user_id is null then
      raise exception 'Account not found.';
    end if;
  end if;

  return query
  select users.user_id, users.username, users.display_name, users.role, users.created_at
  from public.accounts as users
  where users.user_id = saved_user_id;
end;
$$;

revoke all on function public.save_app_user(text, text, text, text, uuid) from public, anon, authenticated;
grant execute on function public.save_app_user(text, text, text, text, uuid) to service_role;
