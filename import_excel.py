import openpyxl
import os
import json
import urllib.request
import re

def cell_text(value):
    return str(value).strip() if value is not None else ''

def cell_number(value, fallback=0.0):
    if value is None or value == '':
        return fallback
    try:
        return max(0.0, float(str(value).replace('₱', '').replace(',', '').strip()))
    except (TypeError, ValueError):
        return fallback

env_path = os.path.join(os.path.dirname(__file__), '.env')
env_vars = {}
if os.path.exists(env_path):
    with open(env_path, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if '=' in line and not line.startswith('#'):
                k, v = line.split('=', 1)
                env_vars[k.strip()] = v.strip()

SUPABASE_URL = env_vars.get('SUPABASE_URL')
SUPABASE_KEY = env_vars.get('SUPABASE_SERVICE_ROLE_KEY')

if not SUPABASE_URL or not SUPABASE_KEY:
    print('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env')
    exit(1)

excel_path = os.path.join(os.environ.get('USERPROFILE', r'C:\Users\Ningmei'), 'Downloads', 'INVENTORY MAIN.xlsx')
print(f'Loading {excel_path}...')

wb = openpyxl.load_workbook(excel_path, read_only=True, data_only=True)
ws = wb['MASTERFILE MANAGEMENT']

items = []
header_found = False

for r in ws.iter_rows(values_only=True):
    if not any(r):
        continue
    row_strs = [str(c) for c in r if c is not None]
    if 'Items' in row_strs or 'Product Sku/no#' in row_strs:
        header_found = True
        continue
    
    if header_found:
        item_number = int(cell_number(r[5])) if len(r) > 5 else 0
        sku = cell_text(r[6]) if len(r) > 6 else ''
        name = cell_text(r[7]) if len(r) > 7 else ''
        category = cell_text(r[8]) if len(r) > 8 else ''
        description = cell_text(r[9]) if len(r) > 9 else ''
        supplier_cost = cell_number(r[10]) if len(r) > 10 else 0.0
        supplier = cell_text(r[11]) if len(r) > 11 else ''
        brand = cell_text(r[12]) if len(r) > 12 else ''
        other = cell_text(r[13]) if len(r) > 13 else ''
        selling_price = cell_number(r[14]) if len(r) > 14 else 0.0
        reorder = cell_number(r[15]) if len(r) > 15 else 0.0
        begin_inv = cell_number(r[16]) if len(r) > 16 else 0.0
            
        if name and name != 'None':
            items.append({
                'item_number': item_number,
                'begin_inventory': begin_inv,
                'name': name,
                'category': category if category else 'General',
                'description': description,
                'supplier': supplier,
                'supplier_cost': supplier_cost,
                'brand': brand,
                'variant': '',
                'other_details': other,
                'sku': sku,
                'unit': 'piece',
                'quantity': begin_inv,
                'unit_price': selling_price,
                'low_stock_threshold': reorder,
                'notes': ''
            })

print(f'Extracted {len(items)} items from Masterfile.')

# Insert into Supabase in batches
headers = {
    'apikey': SUPABASE_KEY,
    'Authorization': f'Bearer {SUPABASE_KEY}',
    'Content-Type': 'application/json',
    'Prefer': 'return=minimal'
}

batch_size = 100
existing_items = []
for offset in range(0, 1000000, 1000):
    request = urllib.request.Request(
        f'{SUPABASE_URL}/rest/v1/inventory_items?select=id,name,category,sku&limit=1000&offset={offset}',
        headers=headers
    )
    with urllib.request.urlopen(request) as response:
        page = json.loads(response.read().decode('utf-8'))
    existing_items.extend(page)
    if len(page) < 1000:
        break
else:
    raise RuntimeError('Inventory listing exceeded the supported importer page limit.')

def normalize(value):
    return str(value or '').strip().lower()

by_sku = {}
by_name_category = {}
for existing in existing_items:
    if existing.get('sku'):
        by_sku.setdefault(normalize(existing['sku']), []).append(existing)
    key = f"{normalize(existing.get('name'))}|{normalize(existing.get('category'))}"
    by_name_category.setdefault(key, []).append(existing)

updates = []
inserts = []
matched_ids = set()
for item in items:
    sku_matches = by_sku.get(normalize(item['sku']), []) if item['sku'] else []
    identity_key = f"{normalize(item['name'])}|{normalize(item['category'])}"
    matches = sku_matches or by_name_category.get(identity_key, [])
    if len(matches) > 1:
        raise RuntimeError(f"Multiple inventory rows match '{item['name']}'. Resolve duplicates before importing.")
    if not matches:
        inserts.append(item)
        continue
    existing_id = matches[0]['id']
    if existing_id in matched_ids:
        raise RuntimeError(f"Multiple spreadsheet rows match '{item['name']}'. Resolve duplicate masterfile rows.")
    matched_ids.add(existing_id)
    update = {key: value for key, value in item.items() if key != 'quantity'}
    update['id'] = existing_id
    updates.append(update)

for offset in range(0, len(updates), batch_size):
    batch = updates[offset:offset + batch_size]
    data = json.dumps(batch).encode('utf-8')
    update_headers = {**headers, 'Prefer': 'resolution=merge-duplicates,return=minimal'}
    request = urllib.request.Request(
        f'{SUPABASE_URL}/rest/v1/inventory_items?on_conflict=id',
        data=data, headers=update_headers, method='POST'
    )
    with urllib.request.urlopen(request):
        pass

for offset in range(0, len(inserts), batch_size):
    batch = inserts[offset:offset + batch_size]
    data = json.dumps(batch).encode('utf-8')
    insert_headers = {**headers, 'Prefer': 'return=minimal'}
    request = urllib.request.Request(
        f'{SUPABASE_URL}/rest/v1/inventory_items', data=data, headers=insert_headers, method='POST'
    )
    with urllib.request.urlopen(request):
        pass

print(f'Import completed. Added: {len(inserts)}; updated: {len(updates)}. Existing stock quantities were preserved.')
