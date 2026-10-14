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
  email text not null default '',
  phone_number text not null default '',
  password_hash text,
  display_name text not null default '',
  role text not null check (role in ('admin','user','customer')),
  created_at timestamptz not null default now()
);

alter table public.accounts add column if not exists username text;
alter table public.accounts add column if not exists email text;
alter table public.accounts add column if not exists phone_number text;
alter table public.accounts add column if not exists display_name text not null default '';
alter table public.accounts add column if not exists password_hash text;
alter table public.accounts drop constraint if exists accounts_role_check;
alter table public.accounts drop constraint if exists app_users_role_check;
alter table public.accounts add constraint accounts_role_check check (role in ('admin','user','customer'));
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

update public.accounts
set email = lower(trim(coalesce(email, ''))),
    phone_number = trim(coalesce(phone_number, ''));
alter table public.accounts alter column email set default '';
alter table public.accounts alter column email set not null;
alter table public.accounts alter column phone_number set default '';
alter table public.accounts alter column phone_number set not null;
alter table public.accounts drop constraint if exists accounts_phone_number_check;
alter table public.accounts add constraint accounts_phone_number_check
  check (phone_number ~ '^[0-9]{11}$') not valid;
alter table public.accounts alter column username set not null;
create unique index if not exists accounts_username_idx on public.accounts(username);
alter table public.accounts alter column user_id set default gen_random_uuid();

alter table public.accounts drop constraint if exists app_users_user_id_fkey;
alter table public.accounts drop constraint if exists accounts_user_id_fkey;

drop table if exists public.app_sessions;

create table if not exists public.client_orders (
  id uuid primary key default gen_random_uuid(),
  client_name text not null,
  client_email text not null default '',
  client_phone text not null default '',
  note text not null default '',
  total numeric(30,2) not null default 0 check (total >= 0),
  order_channel text not null default 'staff',
  ordered_by uuid references public.accounts(user_id) on delete set null,
  created_at timestamptz not null default now()
);
alter table public.client_orders add column if not exists client_email text not null default '';
alter table public.client_orders add column if not exists client_phone text not null default '';
alter table public.client_orders add column if not exists order_channel text not null default 'staff';

create table if not exists public.client_order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.client_orders(id) on delete cascade,
  item_id uuid references public.inventory_items(id) on delete set null,
  item_name text not null,
  unit text not null,
  quantity numeric(12,2) not null check (quantity > 0),
  unit_price numeric(12,2) not null check (unit_price >= 0),
  line_total numeric(30,2) not null check (line_total >= 0)
);

create index if not exists client_orders_created_idx on public.client_orders(created_at desc);
create index if not exists client_order_items_order_idx on public.client_order_items(order_id);
alter table public.client_orders enable row level security;
alter table public.client_order_items enable row level security;

drop function if exists public.place_client_order(text, text, jsonb, uuid);
drop function if exists public.place_client_order(text, text, text, text, jsonb, uuid);
create function public.place_client_order(
  p_client_name text,
  p_client_email text,
  p_client_phone text,
  p_note text,
  p_items jsonb,
  p_user_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  saved_order_id uuid;
  order_total numeric(30,2) := 0;
  line_total numeric(30,2);
  order_line record;
  item_row public.inventory_items%rowtype;
  next_quantity numeric(12,2);
begin
  if length(trim(coalesce(p_client_name, ''))) not between 1 and 120 then
    raise exception 'Client name is required and must be 120 characters or fewer.' using errcode = 'P0001';
  end if;
  if length(coalesce(p_client_email, '')) > 254 or length(coalesce(p_client_phone, '')) > 24 then
    raise exception 'Client contact details exceed the supported length.' using errcode = 'P0001';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'Add at least one item to the order.' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_items) = 0 then
    raise exception 'Add at least one item to the order.' using errcode = 'P0001';
  end if;

  insert into public.client_orders (client_name, client_email, client_phone, note, ordered_by, order_channel)
  values (
    trim(p_client_name), trim(coalesce(p_client_email, '')), trim(coalesce(p_client_phone, '')),
    trim(coalesce(p_note, '')), p_user_id,
    case when p_user_id is null or exists (
      select 1 from public.accounts where user_id = p_user_id and role = 'customer'
    ) then 'online' else 'staff' end
  )
  returning id into saved_order_id;

  for order_line in
    select entry.item_id, sum(entry.quantity) as quantity
    from jsonb_to_recordset(p_items) as entry(item_id uuid, quantity numeric)
    group by entry.item_id
    order by entry.item_id
  loop
    if order_line.quantity <= 0 or order_line.quantity > 9999999999.99 then
      raise exception 'Order quantities must be greater than zero and within the supported range.' using errcode = 'P0001';
    end if;

    select * into item_row
    from public.inventory_items
    where id = order_line.item_id
    for update;
    if not found then
      raise exception 'An ordered inventory item no longer exists.' using errcode = 'P0001';
    end if;
    if item_row.quantity < order_line.quantity then
      raise exception 'Not enough stock for % (available: %).', item_row.name, item_row.quantity using errcode = 'P0001';
    end if;

    next_quantity := item_row.quantity - order_line.quantity;
    line_total := round(item_row.unit_price * order_line.quantity, 2);
    update public.inventory_items
    set quantity = next_quantity, updated_at = now()
    where id = item_row.id;

    insert into public.client_order_items (
      order_id, item_id, item_name, unit, quantity, unit_price, line_total
    ) values (
      saved_order_id, item_row.id, item_row.name, item_row.unit, order_line.quantity,
      item_row.unit_price, line_total
    );

    insert into public.inventory_transactions (item_id, type, quantity, note, balance_after)
    values (
      item_row.id, 'stock_out', order_line.quantity,
      'Client order ' || left(saved_order_id::text, 8) || ': ' || trim(p_client_name),
      next_quantity
    );

    order_total := order_total + line_total;
  end loop;

  update public.client_orders set total = order_total where id = saved_order_id;
  return saved_order_id;
end;
$$;

revoke all on function public.place_client_order(text, text, text, text, jsonb, uuid) from public;
grant execute on function public.place_client_order(text, text, text, text, jsonb, uuid) to service_role;

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

drop function if exists public.authenticate_app_user(text, text);
create function public.authenticate_app_user(p_identifier text, p_password text)
returns table (user_id uuid, username text, email text, phone_number text, display_name text, role text)
language sql
security definer
set search_path = ''
as $$
  select users.user_id, users.username, users.email, users.phone_number, users.display_name, users.role
  from public.accounts as users
  where (
      users.username = lower(trim(p_identifier))
      or (
        users.email = lower(trim(p_identifier))
        and (
          select count(*)
          from public.accounts as matching_email
          where matching_email.email = lower(trim(p_identifier))
        ) = 1
      )
    )
    and users.password_hash is not null
    and extensions.crypt(p_password, users.password_hash) = users.password_hash
  limit 1;
$$;

revoke all on function public.authenticate_app_user(text, text) from public, anon, authenticated;
grant execute on function public.authenticate_app_user(text, text) to service_role;

drop function if exists public.register_customer(text, text, text);
create or replace function public.register_customer(
  p_username text,
  p_email text,
  p_phone_number text,
  p_display_name text,
  p_password text
)
returns table (user_id uuid, username text, email text, phone_number text, display_name text, role text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_username text := lower(trim(p_username));
  normalized_email text := lower(trim(p_email));
  normalized_phone_number text := trim(p_phone_number);
  normalized_display_name text := trim(p_display_name);
  saved_user_id uuid;
begin
  if normalized_username is null or normalized_username !~ '^[a-z0-9][a-z0-9._-]{2,31}$' then
    raise exception 'Username must be 3-32 characters: letters, numbers, periods, underscores, or hyphens.' using errcode = 'P0001';
  end if;
  if normalized_display_name is null or normalized_display_name = '' or length(normalized_display_name) > 120 then
    raise exception 'Name is required and must be 120 characters or fewer.' using errcode = 'P0001';
  end if;
  if normalized_email is null or normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' or length(normalized_email) > 254 then
    raise exception 'Enter a valid email address (254 characters or fewer).' using errcode = 'P0001';
  end if;
  if normalized_phone_number is null or normalized_phone_number !~ '^[0-9]{11}$' then
    raise exception 'Phone number must contain exactly 11 digits.' using errcode = 'P0001';
  end if;
  if length(coalesce(p_password, '')) < 8 then
    raise exception 'Password must be at least 8 characters.' using errcode = 'P0001';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(normalized_email, 0));
  if exists (select 1 from public.accounts where email = normalized_email) then
    raise exception 'That email address is already in use.' using errcode = 'P0001';
  end if;

  insert into public.accounts (username, email, phone_number, display_name, password_hash, role)
  values (
    normalized_username, normalized_email, normalized_phone_number, normalized_display_name,
    extensions.crypt(p_password, extensions.gen_salt('bf', 12)), 'customer'
  )
  returning accounts.user_id into saved_user_id;

  return query
  select users.user_id, users.username, users.email, users.phone_number, users.display_name, users.role
  from public.accounts as users
  where users.user_id = saved_user_id;
end;
$$;

revoke all on function public.register_customer(text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.register_customer(text, text, text, text, text) to service_role;

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

drop function if exists public.save_app_user(text, text, text, text, text, text, uuid);
drop function if exists public.save_app_user(text, text, text, text, uuid);
create or replace function public.save_app_user(
  p_username text,
  p_email text,
  p_phone_number text,
  p_display_name text,
  p_password text,
  p_role text,
  p_actor_id uuid,
  p_user_id uuid default null
)
returns table (user_id uuid, username text, email text, phone_number text, display_name text, role text, created_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_username text := lower(trim(p_username));
  normalized_email text := lower(trim(p_email));
  normalized_phone_number text := trim(p_phone_number);
  normalized_display_name text := trim(p_display_name);
  actor_role text;
  existing_role text;
  saved_user_id uuid;
begin
  select users.role into actor_role
  from public.accounts as users
  where users.user_id = p_actor_id
  for share;
  if actor_role is null or actor_role not in ('admin', 'user') then
    raise exception 'A staff account is required to manage accounts.';
  end if;
  if normalized_username is null or normalized_username !~ '^[a-z0-9][a-z0-9._-]{2,31}$' then
    raise exception 'Username must be 3-32 characters: letters, numbers, periods, underscores, or hyphens.';
  end if;
  if normalized_display_name is null or normalized_display_name = '' or length(normalized_display_name) > 120 then
    raise exception 'Display name is required and must be 120 characters or fewer.';
  end if;
  if normalized_email is null or normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' or length(normalized_email) > 254 then
    raise exception 'Enter a valid email address (254 characters or fewer).';
  end if;
  if normalized_phone_number is null or normalized_phone_number !~ '^[0-9]{11}$' then
    raise exception 'Phone number must contain exactly 11 digits.';
  end if;
  if p_role is null or p_role not in ('admin', 'user', 'customer') then
    raise exception 'Choose a valid account role.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(normalized_email, 0));
  if exists (
    select 1 from public.accounts as existing_email
    where existing_email.email = normalized_email
      and existing_email.user_id is distinct from p_user_id
  ) then
    raise exception 'That email address is already in use.' using errcode = 'P0001';
  end if;

  if p_user_id is null then
    if p_role = 'admin' and actor_role <> 'admin' then
      raise exception 'Only administrators can grant administrator access.';
    end if;
    if length(coalesce(p_password, '')) < 8 then
      raise exception 'Password must be at least 8 characters.';
    end if;
    insert into public.accounts (username, email, phone_number, display_name, password_hash, role)
    values (
      normalized_username,
      normalized_email,
      normalized_phone_number,
      normalized_display_name,
      extensions.crypt(p_password, extensions.gen_salt('bf', 12)),
      p_role
    )
    returning accounts.user_id into saved_user_id;
  else
    select users.role into existing_role
    from public.accounts as users
    where users.user_id = p_user_id
    for update;
    if existing_role is null then
      raise exception 'Account not found.';
    end if;
    if actor_role <> 'admin' and (existing_role = 'admin' or p_role = 'admin') then
      raise exception 'Only administrators can manage administrator accounts or grant administrator access.';
    end if;
    if p_user_id = p_actor_id and p_role <> existing_role then
      raise exception 'You cannot change your own account role.';
    end if;
    if p_password is not null and p_password <> '' and length(p_password) < 8 then
      raise exception 'Password must be at least 8 characters.';
    end if;
    update public.accounts
    set username = normalized_username,
        email = normalized_email,
        phone_number = normalized_phone_number,
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
  select users.user_id, users.username, users.email, users.phone_number, users.display_name, users.role, users.created_at
  from public.accounts as users
  where users.user_id = saved_user_id;
end;
$$;

revoke all on function public.save_app_user(text, text, text, text, text, text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.save_app_user(text, text, text, text, text, text, uuid, uuid) to service_role;

create or replace function public.delete_app_user(p_actor_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_role text;
  target_role text;
begin
  select users.role into actor_role
  from public.accounts as users
  where users.user_id = p_actor_id
  for share;
  if actor_role is null or actor_role not in ('admin', 'user') then
    raise exception 'A staff account is required to manage accounts.';
  end if;
  if p_actor_id = p_user_id then
    raise exception 'You cannot delete your own account.';
  end if;

  select users.role into target_role
  from public.accounts as users
  where users.user_id = p_user_id
  for update;
  if target_role is null then
    raise exception 'Account not found.';
  end if;
  if actor_role <> 'admin' and target_role = 'admin' then
    raise exception 'Only administrators can delete administrator accounts.';
  end if;

  delete from public.accounts where user_id = p_user_id;
end;
$$;

revoke all on function public.delete_app_user(uuid, uuid) from public, anon, authenticated;
grant execute on function public.delete_app_user(uuid, uuid) to service_role;
