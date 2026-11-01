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
  description text not null default '',
  supplier text not null default '',
  supplier_cost numeric(12,2) not null default 0 check (supplier_cost >= 0),
  brand text not null default '',
  variant text not null default '',
  other_details text not null default '',
  sku text not null default '',
  item_number integer check (item_number is null or item_number > 0),
  begin_inventory numeric(12,2) not null default 0 check (begin_inventory >= 0),
  unit text not null default 'piece',
  quantity numeric(12,2) not null default 0 check (quantity >= 0),
  unit_price numeric(12,2) not null default 0 check (unit_price >= 0),
  low_stock_threshold numeric(12,2) not null default 5 check (low_stock_threshold >= 0),
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.inventory_items add column if not exists description text not null default '';
alter table public.inventory_items add column if not exists supplier text not null default '';
alter table public.inventory_items add column if not exists supplier_cost numeric(12,2) not null default 0;
alter table public.inventory_items add column if not exists other_details text not null default '';
alter table public.inventory_items add column if not exists item_number integer;
alter table public.inventory_items add column if not exists begin_inventory numeric(12,2) not null default 0;
create unique index if not exists inventory_items_item_number_idx
  on public.inventory_items(item_number) where item_number is not null;

create table if not exists public.inventory_monitoring_snapshots (
  item_id uuid primary key references public.inventory_items(id) on delete cascade,
  total_in_items numeric(12,2) not null default 0,
  purchase_cost_amount numeric(30,2) not null default 0,
  sales_quantity numeric(12,2) not null default 0,
  cost_of_goods_sold numeric(30,2) not null default 0,
  sales_revenue numeric(30,2) not null default 0,
  profit numeric(30,2) not null default 0,
  damage_quantity numeric(12,2) not null default 0,
  damage_amount numeric(30,2) not null default 0,
  returns_quantity numeric(12,2) not null default 0,
  returns_amount numeric(30,2) not null default 0,
  credit_purchase_quantity numeric(12,2) not null default 0,
  credit_purchase_amount numeric(30,2) not null default 0,
  snapshot_updated_at timestamptz not null default now()
);
alter table public.inventory_monitoring_snapshots enable row level security;

create table if not exists public.inventory_transactions (
  id uuid primary key default gen_random_uuid(),
  item_id uuid references public.inventory_items(id) on delete set null,
  type text not null,
  quantity numeric(12,2) not null check (quantity > 0),
  note text not null default '',
  balance_after numeric(12,2) not null check (balance_after >= 0),
  supplier text not null default '',
  invoice_number text not null default '',
  purchase_type text check (purchase_type in ('cash','credit')),
  due_date date,
  unit_cost numeric(12,2) not null default 0 check (unit_cost >= 0),
  total_amount numeric(30,2) not null default 0 check (total_amount >= 0),
  amount_paid numeric(30,2) not null default 0 check (amount_paid >= 0),
  created_by uuid,
  created_at timestamptz not null default now()
);
alter table public.inventory_transactions drop constraint if exists inventory_transactions_type_check;
alter table public.inventory_transactions add constraint inventory_transactions_type_check
  check (type in ('stock_in','stock_out','adjustment','purchase_cash','purchase_credit','damage','customer_return','supplier_return'));
alter table public.inventory_transactions add column if not exists supplier text not null default '';
alter table public.inventory_transactions add column if not exists invoice_number text not null default '';
alter table public.inventory_transactions add column if not exists purchase_type text;
alter table public.inventory_transactions add column if not exists due_date date;
alter table public.inventory_transactions add column if not exists unit_cost numeric(12,2) not null default 0;
alter table public.inventory_transactions add column if not exists total_amount numeric(30,2) not null default 0;
alter table public.inventory_transactions add column if not exists amount_paid numeric(30,2) not null default 0;
alter table public.inventory_transactions add column if not exists created_by uuid;
alter table public.inventory_transactions drop constraint if exists inventory_transactions_purchase_type_check;
alter table public.inventory_transactions add constraint inventory_transactions_purchase_type_check
  check (purchase_type is null or purchase_type in ('cash','credit'));

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
  role text not null check (role in ('admin','staff')),
  created_at timestamptz not null default now()
);

alter table public.accounts add column if not exists username text;
alter table public.accounts add column if not exists email text;
alter table public.accounts add column if not exists phone_number text;
alter table public.accounts add column if not exists display_name text not null default '';
alter table public.accounts add column if not exists password_hash text;
alter table public.accounts drop constraint if exists accounts_role_check;
alter table public.accounts drop constraint if exists app_users_role_check;
update public.accounts set role = 'staff' where role = 'user';
update public.accounts set role = 'staff' where role = 'customer' or role = 'user';
alter table public.accounts add constraint accounts_role_check check (role in ('admin','staff'));
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

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'inventory_transactions_created_by_fkey'
      and conrelid = 'public.inventory_transactions'::regclass
  ) then
    alter table public.inventory_transactions
      add constraint inventory_transactions_created_by_fkey
      foreign key (created_by) references public.accounts(user_id) on delete set null;
  end if;
end
$$;

create table if not exists public.inventory_purchase_payments (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references public.inventory_transactions(id) on delete cascade,
  amount numeric(30,2) not null check (amount > 0),
  note text not null default '',
  recorded_by uuid references public.accounts(user_id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists inventory_purchase_payments_transaction_idx
  on public.inventory_purchase_payments(transaction_id, created_at desc);
alter table public.inventory_purchase_payments enable row level security;

create table if not exists public.monthly_inventory_closings (
  id uuid primary key default gen_random_uuid(),
  year integer not null check (year between 2000 and 2100),
  month integer not null check (month between 1 and 12),
  ending_date date not null,
  ending_amount numeric(12,2) not null check (ending_amount >= 0),
  ending_quantity numeric(12,2) not null check (ending_quantity >= 0),
  updated_by uuid references public.accounts(user_id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (year, month),
  check (extract(year from ending_date) = year and extract(month from ending_date) = month)
);
alter table public.monthly_inventory_closings enable row level security;

create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text not null default '',
  email text not null default '',
  address text not null default '',
  notes text not null default '',
  created_by uuid references public.accounts(user_id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists customers_name_idx on public.customers(name);
alter table public.customers enable row level security;

create table if not exists public.admin_activity_logs (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.accounts(user_id) on delete set null,
  actor_name text not null,
  actor_role text not null,
  action text not null,
  entity_type text not null,
  entity_id text not null default '',
  summary text not null,
  created_at timestamptz not null default now()
);
create index if not exists admin_activity_logs_created_idx
  on public.admin_activity_logs(created_at desc);
alter table public.admin_activity_logs enable row level security;

alter table public.accounts drop constraint if exists app_users_user_id_fkey;
alter table public.accounts drop constraint if exists accounts_user_id_fkey;

drop table if exists public.app_sessions;

create table if not exists public.client_orders (
  id uuid primary key default gen_random_uuid(),
  receipt_number bigint generated by default as identity not null,
  client_name text not null,
  client_email text not null default '',
  client_phone text not null default '',
  client_address text not null default '',
  note text not null default '',
  discount_total numeric(30,2) not null default 0 check (discount_total >= 0),
  total numeric(30,2) not null default 0 check (total >= 0),
  order_channel text not null default 'staff',
  ordered_by uuid references public.accounts(user_id) on delete set null,
  created_at timestamptz not null default now()
);
alter table public.client_orders add column if not exists receipt_number bigint generated by default as identity;
alter table public.client_orders add column if not exists client_email text not null default '';
alter table public.client_orders add column if not exists client_phone text not null default '';
alter table public.client_orders add column if not exists client_address text not null default '';
alter table public.client_orders add column if not exists discount_total numeric(30,2) not null default 0;
alter table public.client_orders add column if not exists order_channel text not null default 'staff';
create unique index if not exists client_orders_receipt_number_idx on public.client_orders(receipt_number);

create table if not exists public.client_order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.client_orders(id) on delete cascade,
  item_id uuid references public.inventory_items(id) on delete set null,
  item_name text not null,
  unit text not null,
  quantity numeric(12,2) not null check (quantity > 0),
  unit_price numeric(12,2) not null check (unit_price >= 0),
  line_total numeric(30,2) not null check (line_total >= 0),
  unit_cost numeric(12,2) not null default 0 check (unit_cost >= 0),
  cost_total numeric(30,2) not null default 0 check (cost_total >= 0)
);
alter table public.client_order_items add column if not exists unit_cost numeric(12,2) not null default 0;
alter table public.client_order_items add column if not exists cost_total numeric(30,2) not null default 0;

create index if not exists client_orders_created_idx on public.client_orders(created_at desc);
create index if not exists client_order_items_order_idx on public.client_order_items(order_id);
alter table public.client_orders enable row level security;
alter table public.client_order_items enable row level security;

create unique index if not exists admin_activity_logs_order_once_idx
  on public.admin_activity_logs(entity_id)
  where action = 'order.placed' and entity_type = 'client_order';
insert into public.admin_activity_logs (
  actor_id, actor_name, actor_role, action, entity_type, entity_id, summary, created_at
)
select
  orders.ordered_by,
  coalesce(accounts.display_name, case when orders.order_channel = 'online' then 'Customer' else 'Former account' end),
  coalesce(accounts.role, case when orders.order_channel = 'online' then 'customer' else 'staff' end),
  'order.placed',
  'client_order',
  orders.id::text,
  (case when orders.order_channel = 'online' then 'Customer' else 'Staff' end)
    || ' order OR-' || lpad(orders.receipt_number::text, 8, '0')
    || ' recorded with ' || count(order_items.id)::text
    || ' item type' || case when count(order_items.id) = 1 then '' else 's' end || '.',
  orders.created_at
from public.client_orders as orders
left join public.accounts as accounts on accounts.user_id = orders.ordered_by
left join public.client_order_items as order_items on order_items.order_id = orders.id
where not exists (
  select 1 from public.admin_activity_logs as activity
  where activity.action = 'order.placed'
    and activity.entity_type = 'client_order'
    and activity.entity_id = orders.id::text
)
group by orders.id, accounts.display_name, accounts.role;

create or replace function public.add_inventory_stock(
  p_item_id uuid,
  p_added_quantity numeric,
  p_note text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  item_row public.inventory_items%rowtype;
  previous_quantity numeric(12,2);
  next_quantity numeric(12,2);
  stock_note text := trim(coalesce(p_note, ''));
begin
  if p_added_quantity is null or p_added_quantity <= 0 or p_added_quantity > 9999999999.99 then
    raise exception 'Enter a valid quantity to add (must be greater than 0).' using errcode = 'P0001';
  end if;
  if length(stock_note) > 300 then
    raise exception 'Stock note must be 300 characters or fewer.' using errcode = 'P0001';
  end if;

  select * into item_row
  from public.inventory_items
  where id = p_item_id
  for update;
  if not found then
    raise exception 'Inventory item not found.' using errcode = 'P0001';
  end if;

  previous_quantity := item_row.quantity;
  next_quantity := previous_quantity + p_added_quantity;
  if next_quantity > 9999999999.99 then
    raise exception 'The resulting stock exceeds the supported quantity range.' using errcode = 'P0001';
  end if;

  update public.inventory_items
  set quantity = next_quantity, updated_at = now()
  where id = p_item_id
  returning * into item_row;

  insert into public.inventory_transactions (item_id, type, quantity, note, balance_after)
  values (
    p_item_id,
    'stock_in',
    p_added_quantity,
    case when stock_note = '' then 'Arrived stock added' else 'New stock arrived: ' || stock_note end,
    next_quantity
  );

  return jsonb_build_object(
    'item', to_jsonb(item_row),
    'added', p_added_quantity,
    'previous_quantity', previous_quantity,
    'new_quantity', next_quantity
  );
end;
$$;

revoke all on function public.add_inventory_stock(uuid, numeric, text) from public;
grant execute on function public.add_inventory_stock(uuid, numeric, text) to service_role;

create or replace function public.record_inventory_event(
  p_item_id uuid,
  p_type text,
  p_quantity numeric,
  p_unit_cost numeric,
  p_supplier text,
  p_invoice_number text,
  p_due_date date,
  p_amount_paid numeric,
  p_note text,
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  item_row public.inventory_items%rowtype;
  transaction_row public.inventory_transactions%rowtype;
  previous_quantity numeric(12,2);
  next_quantity numeric(12,2);
  event_total numeric(30,2);
  paid numeric(30,2);
begin
  if p_type not in ('purchase_cash','purchase_credit','damage','customer_return','supplier_return') then
    raise exception 'Choose a supported purchase, damage, or return type.' using errcode = 'P0001';
  end if;
  if p_quantity is null or p_quantity <= 0 or p_quantity > 9999999999.99 then
    raise exception 'Quantity must be greater than zero and within the supported range.' using errcode = 'P0001';
  end if;
  if length(trim(coalesce(p_supplier, ''))) > 120
    or length(trim(coalesce(p_invoice_number, ''))) > 120
    or length(trim(coalesce(p_note, ''))) > 500 then
    raise exception 'Supplier, invoice, or note exceeds the supported length.' using errcode = 'P0001';
  end if;

  select * into item_row
  from public.inventory_items
  where id = p_item_id
  for update;
  if not found then
    raise exception 'Inventory item not found.' using errcode = 'P0001';
  end if;

  if coalesce(p_unit_cost, item_row.supplier_cost) < 0
    or coalesce(p_unit_cost, item_row.supplier_cost) > 9999999999.99 then
    raise exception 'Unit cost must be zero or greater.' using errcode = 'P0001';
  end if;

  previous_quantity := item_row.quantity;
  event_total := round(coalesce(p_unit_cost, item_row.supplier_cost) * p_quantity, 2);
  paid := coalesce(p_amount_paid, 0);
  if p_type = 'purchase_cash' then
    paid := event_total;
  elsif p_type = 'purchase_credit' and (paid < 0 or paid > event_total) then
    raise exception 'Initial payment must be between zero and the purchase total.' using errcode = 'P0001';
  elsif p_type not in ('purchase_cash','purchase_credit') then
    paid := 0;
  end if;
  if p_type = 'purchase_credit' and paid < event_total and p_due_date is null then
    raise exception 'A due date is required for an unpaid credit purchase.' using errcode = 'P0001';
  end if;

  if p_type in ('purchase_cash','purchase_credit','customer_return') then
    next_quantity := item_row.quantity + p_quantity;
  else
    next_quantity := item_row.quantity - p_quantity;
    if next_quantity < 0 then
      raise exception 'Not enough stock for this damage or return.' using errcode = 'P0001';
    end if;
  end if;
  if next_quantity > 9999999999.99 then
    raise exception 'The resulting stock exceeds the supported quantity range.' using errcode = 'P0001';
  end if;

  update public.inventory_items
  set quantity = next_quantity, updated_at = now()
  where id = p_item_id
  returning * into item_row;

  insert into public.inventory_transactions (
    item_id, type, quantity, note, balance_after, supplier, invoice_number,
    purchase_type, due_date, unit_cost, total_amount, amount_paid, created_by
  )
  values (
    p_item_id, p_type, p_quantity, trim(coalesce(p_note, '')), next_quantity,
    trim(coalesce(p_supplier, '')), trim(coalesce(p_invoice_number, '')),
    case when p_type = 'purchase_cash' then 'cash' when p_type = 'purchase_credit' then 'credit' else null end,
    p_due_date, coalesce(p_unit_cost, item_row.supplier_cost), event_total, paid, p_user_id
  )
  returning * into transaction_row;

  if p_type = 'purchase_credit' and paid > 0 then
    insert into public.inventory_purchase_payments (transaction_id, amount, note, recorded_by)
    values (transaction_row.id, paid, 'Initial payment', p_user_id);
  end if;

  return jsonb_build_object(
    'item', to_jsonb(item_row),
    'transaction', to_jsonb(transaction_row),
    'previous_quantity', previous_quantity,
    'new_quantity', next_quantity
  );
end;
$$;

revoke all on function public.record_inventory_event(uuid, text, numeric, numeric, text, text, date, numeric, text, uuid) from public;
grant execute on function public.record_inventory_event(uuid, text, numeric, numeric, text, text, date, numeric, text, uuid) to service_role;

create or replace function public.record_inventory_purchase_payment(
  p_transaction_id uuid,
  p_amount numeric,
  p_note text,
  p_user_id uuid
)
returns public.inventory_transactions
language plpgsql
security definer
set search_path = ''
as $$
declare
  purchase_row public.inventory_transactions%rowtype;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'Payment amount must be greater than zero.' using errcode = 'P0001';
  end if;
  select * into purchase_row
  from public.inventory_transactions
  where id = p_transaction_id and type = 'purchase_credit'
  for update;
  if not found then
    raise exception 'Credit purchase not found.' using errcode = 'P0001';
  end if;
  if purchase_row.amount_paid + p_amount > purchase_row.total_amount then
    raise exception 'Payment exceeds the remaining balance.' using errcode = 'P0001';
  end if;

  update public.inventory_transactions
  set amount_paid = amount_paid + p_amount
  where id = p_transaction_id
  returning * into purchase_row;
  insert into public.inventory_purchase_payments (transaction_id, amount, note, recorded_by)
  values (p_transaction_id, p_amount, trim(coalesce(p_note, '')), p_user_id);
  return purchase_row;
end;
$$;

revoke all on function public.record_inventory_purchase_payment(uuid, numeric, text, uuid) from public;
grant execute on function public.record_inventory_purchase_payment(uuid, numeric, text, uuid) to service_role;

drop function if exists public.place_client_order(text, text, jsonb, uuid);
drop function if exists public.place_client_order(text, text, text, text, jsonb, uuid);
drop function if exists public.place_client_order(text, text, text, text, text, jsonb, uuid);
drop function if exists public.place_client_order(text, text, text, text, text, jsonb, uuid, numeric);
create function public.place_client_order(
  p_client_name text,
  p_client_email text,
  p_client_phone text,
  p_client_address text,
  p_note text,
  p_items jsonb,
  p_user_id uuid,
  p_discount numeric default 0
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
  line_cost numeric(30,2);
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
  if length(trim(coalesce(p_client_address, ''))) not between 1 and 300 then
    raise exception 'Client address is required and must be 300 characters or fewer.' using errcode = 'P0001';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'Add at least one item to the order.' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_items) = 0 then
    raise exception 'Add at least one item to the order.' using errcode = 'P0001';
  end if;

  insert into public.client_orders (client_name, client_email, client_phone, client_address, note, discount_total, ordered_by, order_channel)
  values (
    trim(p_client_name), trim(coalesce(p_client_email, '')), trim(coalesce(p_client_phone, '')),
    trim(p_client_address), trim(coalesce(p_note, '')), 0, p_user_id,
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
    line_cost := round(item_row.supplier_cost * order_line.quantity, 2);
    update public.inventory_items
    set quantity = next_quantity, updated_at = now()
    where id = item_row.id;

    insert into public.client_order_items (
      order_id, item_id, item_name, unit, quantity, unit_price, line_total, unit_cost, cost_total
    ) values (
      saved_order_id, item_row.id, item_row.name, item_row.unit, order_line.quantity,
      item_row.unit_price, line_total, item_row.supplier_cost, line_cost
    );

    insert into public.inventory_transactions (item_id, type, quantity, note, balance_after)
    values (
      item_row.id, 'stock_out', order_line.quantity,
      'Client order ' || left(saved_order_id::text, 8) || ': ' || trim(p_client_name),
      next_quantity
    );

    order_total := order_total + line_total;
  end loop;

  if coalesce(p_discount, 0) < 0 or coalesce(p_discount, 0) > order_total then
    raise exception 'Discount must be between zero and the order subtotal.' using errcode = 'P0001';
  end if;
  update public.client_orders
  set discount_total = coalesce(p_discount, 0), total = order_total - coalesce(p_discount, 0)
  where id = saved_order_id;
  return saved_order_id;
end;
$$;

revoke all on function public.place_client_order(text, text, text, text, text, jsonb, uuid, numeric) from public;
grant execute on function public.place_client_order(text, text, text, text, text, jsonb, uuid, numeric) to service_role;

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

drop function if exists public.register_customer(text, text, text, text, text);
drop function if exists public.register_customer(text, text, text);

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
  if actor_role is distinct from 'admin' then
    raise exception 'Only administrators can manage accounts.';
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
  if p_role is null or p_role not in ('admin', 'staff') then
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
  if actor_role is distinct from 'admin' then
    raise exception 'Only administrators can manage accounts.';
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
  delete from public.accounts where user_id = p_user_id;
end;
$$;

revoke all on function public.delete_app_user(uuid, uuid) from public, anon, authenticated;
grant execute on function public.delete_app_user(uuid, uuid) to service_role;
