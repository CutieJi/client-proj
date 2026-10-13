# Materials Inventory

A modern, minimal inventory app for the handwritten building-material price list. Built with Node.js, Express, vanilla HTML/CSS/JavaScript, and Supabase PostgreSQL.

## Included

- Inventory table with search, category filter, and stock-level filter
- Summary cards for item count, total stock units, estimated inventory value, and low-stock items
- Add, edit, and delete material records
- Stock-in, stock-out, and adjustment forms
- Stock movement history
- Username/password login with display names and administrator/user roles
- Administrator-only account management; public registration is disabled
- Account sorting, self-service password changes, and confirmed sign-out
- Responsive layout and light/dark mode
- Supabase SQL schema and optional seed data

## Requirements

- Node.js 18 or later
- A Supabase project

## Setup

1. In Supabase, open **SQL Editor** and run `supabase/schema.sql`.
2. Optional: run `supabase/seed.sql` to insert the transcribed price list. The seed starts all quantities at `0` because the photo contains prices, not stock counts.
3. Copy `.env.example` to `.env`.
4. In Supabase **Project Settings → API**, copy the Project URL and the **service_role** key into `.env`:

   ```env
   PORT=3000
   SUPABASE_URL=https://YOUR_PROJECT.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVICE_ROLE_KEY
   ```

   Keep `.env` private and never commit it.
5. Create the initial admin in Supabase **SQL Editor** by replacing the example username, display name, and password
   values in `supabase/initial_admin.sql`, then running the script. It stores a bcrypt hash, not the plain-text password.
   After signing in, the admin can create, edit, reset passwords, and delete accounts from the dashboard's
   **User management** page. Passwords must be at least 8 characters (12 or more is recommended).
6. Install dependencies and start the app:

   ```bash
   npm install
   npm start
   ```

7. Visit `http://localhost:3000` to open the login page (`public/index.html`) and sign in with the admin username and
   password you set in SQL. The inventory dashboard is a separate page at `public/dashboard.html` and requires a valid
   session. The admin-only **User management** page creates, edits, and deletes accounts through restricted database
   functions. Apply `supabase/schema.sql` first to install these functions. There is no public registration;
   account-write APIs require an administrator session.

## Important security note

The authentication database uses only `public.accounts` for account data; there is no session table. Signed, expiring HTTP-only cookies keep users logged in, and the server checks the account in `accounts` on each request. Password changes invalidate existing cookies; account deletion and role changes take effect immediately. Cookie signatures use a key derived from the server-only Supabase `service_role` key, so no extra session-secret setting is needed; rotating the service key signs out users. The Supabase `service_role` key bypasses Row Level Security and is used by Express on the server only. Never put it in `public/app.js`, browser HTML, a public repository, or a deployed frontend. Keep `.env` private. Accounts contain username, bcrypt password hash, display name, role, and internal ID/creation time. Email is not used. Login and account password management use restricted database functions; the login function is executable only by the server's service role. All inventory APIs require a signed-in account and account write APIs require an administrator. Deploy behind HTTPS and set `NODE_ENV=production` so cookies are marked Secure. Apply `supabase/schema.sql` to create or migrate the account table and install the required functions; it removes a legacy `app_sessions` table if one exists. If migrating the older `app_users` table, usernames are generated from existing email local parts and email is removed; existing users need a password set by an administrator before they can sign in.

## Notes about the photographed price list

The initial list is a best-effort transcription. Several handwritten brand names, the CHB prices, sand wording, and the last category heading are unclear. Check `supabase/seed.sql` and correct those records in the app before relying on the prices. The numbers are prices, not confirmed quantities on hand.

## API endpoints

- `GET /api/health`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`
- `POST /api/auth/change-password`
- `GET /api/users` (administrator)
- `POST /api/users` (administrator)
- `PATCH /api/users/:id` (administrator)
- `DELETE /api/users/:id` (administrator)
- `GET /api/items?search=cement&category=Cement`
- `POST /api/items`
- `PATCH /api/items/:id`
- `DELETE /api/items/:id`
- `GET /api/summary`
- `GET /api/transactions`
- `POST /api/transactions`

## Suggested next steps for real use

Add server-side login rate limits and a transactional PostgreSQL function for stock changes. The simple stock-update route is a starter implementation and is not safe for simultaneous multi-user stock updates.
