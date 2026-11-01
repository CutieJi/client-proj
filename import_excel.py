import openpyxl
import os
import json
import urllib.request
import re

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
        sku = str(r[6]).strip() if len(r) > 6 and r[6] is not None else ''
        name = str(r[7]).strip() if len(r) > 7 and r[7] is not None else ''
        category = str(r[8]).strip() if len(r) > 8 and r[8] is not None else ''
        description = str(r[9]).strip() if len(r) > 9 and r[9] is not None else ''
        supplier = str(r[11]).strip() if len(r) > 11 and r[11] is not None else ''
        brand = str(r[12]).strip() if len(r) > 12 and r[12] is not None else ''
        other = str(r[13]).strip() if len(r) > 13 and r[13] is not None else ''
        
        try:
            selling_price = float(r[14]) if len(r) > 14 and r[14] is not None else 0.0
        except:
            selling_price = 0.0
            
        try:
            reorder = float(r[15]) if len(r) > 15 and r[15] is not None else 5.0
        except:
            reorder = 5.0
            
        try:
            begin_inv = float(r[16]) if len(r) > 16 and r[16] is not None else 0.0
        except:
            begin_inv = 0.0
            
        if name and name != 'None':
            items.append({
                'name': name,
                'category': category if category else 'General',
                'brand': brand if brand else (supplier if supplier else ''),
                'variant': other if other else (description if description != name else ''),
                'sku': sku,
                'unit': 'piece',
                'quantity': max(0.0, begin_inv),
                'unit_price': max(0.0, selling_price),
                'low_stock_threshold': max(1.0, reorder),
                'notes': f'Supplier: {supplier}' if supplier else ''
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
total_inserted = 0

for i in range(0, len(items), batch_size):
    batch = items[i:i+batch_size]
    data = json.dumps(batch).encode('utf-8')
    req = urllib.request.Request(f'{SUPABASE_URL}/rest/v1/inventory_items', data=data, headers=headers, method='POST')
    try:
        with urllib.request.urlopen(req) as response:
            total_inserted += len(batch)
            print(f'Inserted batch {i//batch_size + 1}: {total_inserted}/{len(items)}')
    except urllib.error.HTTPError as e:
        print(f'Error batch {i//batch_size + 1}:', e.read().decode())
    except Exception as ex:
        print('Exception:', ex)

print(f'Import completed. Total items inserted: {total_inserted}')
