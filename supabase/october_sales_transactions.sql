-- Historical October 2026 sales imported from the workbook's Sales Transactions tab.
-- Run supabase/schema.sql and supabase/inventory_items.sql first.
-- Inserts 37 actual transaction lines (307 units) directly into the app's existing order tables.
-- It does not change inventory quantities or add stock-out transactions.
-- Safe to run again: stable IDs are generated from each source spreadsheet row.
-- Source: https://docs.google.com/spreadsheets/d/1Z7Uku8-J5rvMqz4QsiUHXWlJFfnaycWjI_YxOyTP3kA/edit
-- Source totals: sales 33495.00, discounts 435.00, COGS 29111.40, profit 4383.60.

begin;

with october_sales_transactions_import (
  source_row, sku, transaction_date, item_name, category, description,
  supplier_cost, selling_price, customer, quantity, discount,
  sales_amount, cost_of_goods_sold, profit
) as (
values
  (17, '5193', DATE '2026-10-01', 'CWN  3', 'Nails', 'CWN  3   kl', 55.00, 100.00, '', 1.00, 0.00, 100.00, 55.00, 45.00),
  (18, '5192', DATE '2026-10-01', 'CWN  2', 'Nails', 'CWN  2    kl', 55.00, 100.00, '', 0.50, 0.00, 50.00, 27.50, 22.50),
  (19, '5194', DATE '2026-10-01', 'CWN  4', 'Nails', 'CWN  4   kl', 55.00, 100.00, '', 0.50, 0.00, 50.00, 27.50, 22.50),
  (20, '5296', DATE '2026-10-01', 'Umbrella Nail   box', 'Nails', 'Umbrella Nail   box', 1480.00, 2150.00, '', 0.50, 0.00, 1075.00, 740.00, 335.00),
  (21, '5210', DATE '2026-10-01', 'Cutting Disc Sunrise Red', 'Disc', 'Cutting Disc Sunrise Red', 6.50, 25.00, '', 2.00, 0.00, 50.00, 13.00, 37.00),
  (22, '5193', DATE '2026-10-01', 'CWN  3', 'Nails', 'CWN  3   kl', 55.00, 100.00, '', 1.00, 0.00, 100.00, 55.00, 45.00),
  (23, '5217', DATE '2026-10-01', 'Flap Disc  #60', 'Disc', 'Flap Disc  #60', 17.00, 65.00, '', 1.00, 0.00, 65.00, 17.00, 48.00),
  (24, '5210', DATE '2026-10-01', 'Cutting Disc Sunrise Red', 'Disc', 'Cutting Disc Sunrise Red', 6.50, 25.00, '', 1.00, 0.00, 25.00, 6.50, 18.50),
  (25, '5332', DATE '2026-10-01', 'Solvent Cement', 'HARDWARE ITEMS', 'Solvent Cement Neltex  100cc', 40.00, 90.00, '', 1.00, 0.00, 90.00, 40.00, 50.00),
  (26, '5539', DATE '2026-10-01', 'PVC  TEE 1/2 B', 'PVC FITTINGS', 'PVC  TEE 1/2 B', 4.95, 15.00, '', 2.00, 0.00, 30.00, 9.90, 20.10),
  (27, '5194', DATE '2026-10-01', 'CWN  4', 'Nails', 'CWN  4   kl', 55.00, 100.00, '', 1.00, 0.00, 100.00, 55.00, 45.00),
  (28, '5374', DATE '2026-10-01', 'Buildrite Putty master LTR', 'Buildrite', 'Buildrite Putty master LTR', 103.00, 365.00, '', 1.00, 80.00, 285.00, 103.00, 182.00),
  (29, '5319', DATE '2026-10-01', 'Blind rivets 3/16*3/4  S.BOX', 'HARDWARE ITEMS', 'Blind rivets 3/16*3/4  S.BOX', 175.00, 320.00, '', 1.00, 55.00, 265.00, 175.00, 90.00),
  (30, '5421', DATE '2026-10-01', 'Prosil Silicon Sealant white', 'HARDWARE ITEMS', 'Prosil Silicon Sealant white', 180.00, 225.00, '', 1.00, 0.00, 225.00, 180.00, 45.00),
  (31, '1001', DATE '2026-10-01', 'eagle cement', 'CEMENT', 'Eagle Cement', 210.00, 225.00, '', 4.00, 0.00, 900.00, 840.00, 60.00),
  (32, '5135', DATE '2026-10-01', 'A/B  1*1  2.5mm   B          1/8', 'ANGLE BAR', 'A/B  1*1  2.5mm   B', 220.00, 295.00, '', 1.00, 0.00, 295.00, 220.00, 75.00),
  (33, '', DATE '2026-10-01', 'Unspecified workbook item (source row 33)', '', '', 0.00, 0.00, '', 1.00, 0.00, 0.00, 0.00, 0.00),
  (34, '5264', DATE '2026-10-01', 'Welding Rod 6013 POLONET   KL', 'Welding Rod', 'Welding Rod 6013 POLONET  KL', 60.00, 100.00, '', 0.25, 0.00, 25.00, 15.00, 10.00),
  (35, '5303', DATE '2026-10-01', 'Blind rivets 1/8*1/2  Pc', 'HARDWARE ITEMS', 'Blind rivets 1/8*1/2  Pc', 0.15, 0.75, '', 100.00, 0.00, 75.00, 15.00, 60.00),
  (36, '5820', DATE '2026-10-01', 'Hakito T. Adhessive Gray', '', 'Hakito T. Adhessive Gray', 150.00, 230.00, '', 5.00, 0.00, 1150.00, 750.00, 400.00),
  (37, '5194', DATE '2026-10-01', 'CWN  4', 'Nails', 'CWN  4   kl', 55.00, 100.00, '', 1.00, 0.00, 100.00, 55.00, 45.00),
  (38, '5193', DATE '2026-10-01', 'CWN  3', 'Nails', 'CWN  3   kl', 55.00, 100.00, '', 1.00, 0.00, 100.00, 55.00, 45.00),
  (39, '6033', DATE '2026-10-01', 'Levelhose/yellow', 'HARDWARE ITEMS', 'Level Hose/mtr', 12.00, 25.00, '', 4.00, 0.00, 100.00, 48.00, 52.00),
  (40, '5827', DATE '2026-10-01', 'COCO 2*3*10', 'coco', 'COCO 2*3*10', 145.00, 180.00, 'SIR LARRY/ALTO', 1.00, 0.00, 180.00, 145.00, 35.00),
  (41, '5824', DATE '2026-10-01', 'COCO 2*2*10', 'coco', 'COCO 2*2*10', 97.00, 120.00, 'SIR LARRY/ALTO', 2.00, 0.00, 240.00, 194.00, 46.00),
  (42, '2001', DATE '2026-10-01', '10mm cx', 'RSB', '10mm cx', 139.00, 148.00, 'SIR LARRY/ALTO', 100.00, 0.00, 14800.00, 13900.00, 900.00),
  (43, '2002', DATE '2026-10-01', '12mm cx', 'RSB', '12mm cx', 196.00, 215.00, 'SIR LARRY/ALTO', 40.00, 200.00, 8400.00, 7840.00, 560.00),
  (44, '2003', DATE '2026-10-01', '9mm 1.7', 'RSB', '9mm  1.7', 79.00, 95.00, 'SIR LARRY/ALTO', 20.00, 0.00, 1900.00, 1580.00, 320.00),
  (45, '5438', DATE '2026-10-01', 'GI Wire #16 Roll  18kls  C', 'HARDWARE ITEMS', 'GI Wire #16 Roll  18kls  C', 990.00, 1350.00, 'SIR LARRY/ALTO', 1.00, 100.00, 1250.00, 990.00, 260.00),
  (46, '5135', DATE '2026-10-01', 'A/B  1*1  2.5mm   B          1/8', 'ANGLE BAR', 'A/B  1*1  2.5mm   B', 220.00, 295.00, '', 1.00, 0.00, 295.00, 220.00, 75.00),
  (47, '5495', DATE '2026-10-01', 'PVC Pipe #1/2 (B) ord', 'PVC PIPES BLUE', 'PVC Pipe #1/2 (B) ord', 0.00, 85.00, '', 2.00, 0.00, 170.00, 0.00, 170.00),
  (48, '5073', DATE '2026-10-01', '1/4 Marine GL', 'PLYWOOD', '1/4 Marine GL China', 335.00, 370.00, '', 1.00, 0.00, 370.00, 335.00, 35.00),
  (49, '5507', DATE '2026-10-01', 'elbow 90x2', 'PVC FITTINGS', 'elbow 90x2', 15.00, 35.00, '', 2.00, 0.00, 70.00, 30.00, 40.00),
  (50, '5513', DATE '2026-10-01', 'tee 2x2', 'PVC FITTINGS', 'tee 2x2', 20.00, 45.00, '', 2.00, 0.00, 90.00, 40.00, 50.00),
  (51, '5332', DATE '2026-10-01', 'Solvent Cement', 'HARDWARE ITEMS', 'Solvent Cement Neltex  100cc', 40.00, 90.00, '', 1.00, 0.00, 90.00, 40.00, 50.00),
  (52, '5855', DATE '2026-10-01', 'SD  1*2*12', 'SD', 'SD  1*2*12', 140.00, 180.00, '', 2.00, 0.00, 360.00, 280.00, 80.00),
  (53, '5199', DATE '2026-10-01', 'Concrete Nail  3', 'Nails', 'Concrete Nail  3', 60.00, 100.00, '', 0.25, 0.00, 25.00, 15.00, 10.00)
),
inserted_orders as (
  insert into public.client_orders (
    id, client_name, client_email, client_phone, client_address, note,
    discount_total, total, order_channel, ordered_by, created_at
  )
  select
    md5('workbook-sales-october-2026:' || source.source_row::text)::uuid,
    source.customer,
    '',
    '',
    '',
    'Workbook Sales Transactions import, October 2026, source row ' || source.source_row::text,
    source.discount,
    source.sales_amount,
    'staff',
    null,
    source.transaction_date::timestamp at time zone 'UTC'
  from october_sales_transactions_import as source
  on conflict (id) do nothing
  returning id
)
insert into public.client_order_items (
  id, order_id, item_id, item_name, unit, quantity, unit_price,
  line_total, unit_cost, cost_total
)
select
  md5('workbook-sales-october-2026-item:' || source.source_row::text)::uuid,
  imported.id,
  matched_item.id,
  source.item_name,
  coalesce(matched_item.unit, 'piece'),
  source.quantity,
  source.selling_price,
  source.sales_amount + source.discount,
  source.supplier_cost,
  source.cost_of_goods_sold
from october_sales_transactions_import as source
join inserted_orders as imported
  on imported.id = md5('workbook-sales-october-2026:' || source.source_row::text)::uuid
left join lateral (
  select item.id, item.unit
  from public.inventory_items as item
  where source.sku <> '' and item.sku = source.sku
  order by item.item_number nulls last, item.id
  limit 1
) as matched_item on true
on conflict (id) do nothing;

commit;
