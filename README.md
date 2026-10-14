# Materials Inventory

A modern, minimal inventory app for the handwritten building-material price list. Built with Node.js, Express, vanilla HTML/CSS/JavaScript, and Supabase PostgreSQL.

## Included

- Inventory table with search, category filter, and stock-level filter
- Summary cards for item count, total stock units, estimated inventory value, and low-stock items
- Add, edit, and delete material records
- Stock-in, stock-out, and adjustment forms
- Stock movement history
- Client order entry with saved order history, order totals, and automatic stock deductions
- Customer login by email or username and self-registration before ordering
- Authenticated customer ordering page; orders are stored and deducted from stock atomically
- Required display name, username, email address, and exactly 11-digit phone number on every new account
- Registration requires matching password confirmation; accounts can sign in with email or username
- Customer order contact details are taken from the signed-in account
- Username/password login with customer, staff, and administrator roles
- Staff account management for users and customers; administrator accounts remain admin-managed
- Account sorting, self-service password changes, and confirmed sign-out
- Responsive layout and light/dark mode
- Supabase SQL schema and optional seed data

## Requirements

- Node.js 18 or later
- A Supabase project

## Setup

1. In Supabase, open **SQL Editor** and run `supabase/schema.sql`.
   If this is an existing installation, rerun the updated schema to add account contact columns, the customer role,
   registration function, and client-order storage. Existing account emails are preserved when present; accounts
   without an email or phone number must be completed by an administrator before their details are current.
2. Optional: run `supabase/seed.sql` to insert the transcribed price list. The seed starts all quantities at `0` because the photo contains prices, not stock counts.
3. Copy `.env.example` to `.env`.
4. In Supabase **Project Settings → API**, copy the Project URL and the **service_role** key into `.env`:

   ```env
   PORT=3000
   SUPABASE_URL=https://YOUR_PROJECT.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVICE_ROLE_KEY
   ```

   Keep `.env` private and never commit it.
5. Create the initial admin in Supabase **SQL Editor** by replacing the example username, email, phone number,
   display name, and password values in `supabase/initial_admin.sql`, then running the script. It stores a bcrypt hash,
   not the plain-text password.
   After signing in, staff can create, edit, reset passwords, and delete user/customer accounts from the dashboard's
   **User management** page. Only admins can manage admin accounts or grant admin access. Passwords must be at least
   8 characters (12 or more is recommended).
6. Install dependencies and start the app:

   ```bash
   npm install
   npm start
   ```

7. Visit `http://localhost:3000` to sign in or create a customer account. Customer accounts can submit orders after
   signing in. Staff can also sign in from this page using the admin username and password created in SQL; staff
   accounts are managed from the **User management** page; regular staff can manage user/customer roles while admins
   manage all roles. The customer ordering page is
   `/customer.html` and the staff dashboard is `/dashboard.html`; both require the appropriate signed-in role.

## Deploying to Vercel

Import this project into Vercel and use the Express framework preset (Vercel can detect the root `server.js` Express
app). Set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `NODE_ENV=production` in the Vercel project's Environment
Variables, then redeploy. The app exports the Express application for Vercel while retaining `npm start` for local
development. All static assets, including the dashboard, are in `public/`; the dashboard route verifies the user's
session before serving it. No separate API URL or client-side
deployment rewrite is needed.

## Important security note

The authentication database uses only `public.accounts` for account data; there is no session table. Signed, expiring HTTP-only cookies keep users logged in, and the server checks the account in `accounts` on each request. Password changes invalidate existing cookies; account deletion and role changes take effect immediately. Cookie signatures use a key derived from the server-only Supabase `service_role` key, so no extra session-secret setting is needed; rotating the service key signs out users. The Supabase `service_role` key bypasses Row Level Security and is used by Express on the server only. Never put it in `public/app.js`, browser HTML, a public repository, or a deployed frontend. Keep `.env` private. Accounts store required username, email, phone number, display name, password hash, and role, plus internal ID/creation time. Login, customer registration, and account management use restricted database functions; registration can create customer-role accounts only. Inventory and order-management APIs require a signed-in account, customer ordering APIs require a customer account, staff can manage regular user/customer accounts, and only admins can manage admin accounts or grant admin access. Customer registration and order submission are each limited to 10 requests per IP address per 15 minutes. Deploy behind HTTPS and set `NODE_ENV=production` so cookies are marked Secure. Apply `supabase/schema.sql` to create or migrate the account table, customer role, and required functions; it removes a legacy `app_sessions` table if one exists. If migrating the older `app_users` table, usernames are generated from existing email local parts and existing email values are retained. Older accounts without email or phone details must be updated by an administrator, and existing users need a password set by an administrator before they can sign in.

## Notes about the photographed price list

The initial list is a best-effort transcription. Several handwritten brand names, the CHB prices, sand wording, and the last category heading are unclear. Check `supabase/seed.sql` and correct those records in the app before relying on the prices. The numbers are prices, not confirmed quantities on hand.

## API endpoints

- `GET /api/health`
- `POST /api/auth/login`
- `POST /api/auth/register` (creates a customer account and signs it in)
- `POST /api/auth/logout`
- `GET /api/auth/me`
- `POST /api/auth/change-password`
- `GET /api/users` (staff; non-admin staff see user/customer accounts only)
- `POST /api/users` (staff; only admins can create admin accounts)
- `PATCH /api/users/:id` (staff; only admins can manage admin accounts or grant admin access)
- `DELETE /api/users/:id` (staff; only admins can delete admin accounts)
- `GET /api/items?search=cement&category=Cement`
- `POST /api/items`
- `PATCH /api/items/:id`
- `DELETE /api/items/:id`
- `GET /api/summary`
- `GET /api/transactions`
- `POST /api/transactions`
- `GET /api/orders`
- `POST /api/orders` (records a client order, deducts stock, and creates stock-out history atomically)
- `GET /api/customer/items` (customer account required)
- `POST /api/customer/orders` (customer account required; limited to 10 requests per IP address per 15 minutes)

Customers sign in or register at `/`, then place orders at `/customer.html`. Staff sign in at `/` using their staff
account. The legacy `/admin` and `/login.html` paths redirect to the sign-in page. Customer name, email address, and
phone number are saved with successful orders, which appear in the dashboard's **Client orders** and **Stock movements**
views.

## Suggested next steps for real use

Add server-side login rate limits and a transactional PostgreSQL function for stock changes. The simple stock-update route is a starter implementation and is not safe for simultaneous multi-user stock updates.
