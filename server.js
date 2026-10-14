require("dotenv").config();
const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const port = process.env.PORT || 3000;
app.use(express.json());

const configured = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
const sessionSecret = configured
  ? crypto.createHmac("sha256", process.env.SUPABASE_SERVICE_ROLE_KEY).update("materials-inventory-session-v1").digest()
  : null;
const supabase = configured
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    })
  : null;
const sessionCookie = "materials_session";
const sessionDurationMs = 30 * 24 * 60 * 60 * 1000;

function dbRequired(req, res, next) {
  if (!supabase) return res.status(503).json({ error: "Supabase is not configured. Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to .env." });
  next();
}
function fail(res, error) {
  console.error(error);
  return res.status(500).json({ error: error.message || "Something went wrong." });
}
function normalizeUsername(value) {
  return String(value || "").trim().toLowerCase();
}
function validUsername(username) {
  return /^[a-z0-9][a-z0-9._-]{2,31}$/.test(username);
}
function unauthenticated(req, res, message) {
  if (req.path === "/dashboard.html" || req.path === "/customer.html") return res.redirect("/");
  return res.status(401).json({ error: message });
}
function getCookie(req, name) {
  const cookie = req.headers.cookie?.split(";").map(value => value.trim()).find(value => value.startsWith(`${name}=`));
  return cookie ? cookie.slice(name.length + 1) : null;
}
function setSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${sessionCookie}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionDurationMs / 1000}${secure}`);
}
function clearSessionCookie(res) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${sessionCookie}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`);
}
function createSessionToken(userId, passwordHash) {
  if (!sessionSecret) throw new Error("Supabase must be configured before creating a session.");
  const payload = Buffer.from(JSON.stringify({
    userId,
    expiresAt: Date.now() + sessionDurationMs,
    credentialFingerprint: crypto.createHash("sha256").update(passwordHash).digest("hex")
  })).toString("base64url");
  const signature = crypto.createHmac("sha256", sessionSecret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}
function readSessionToken(token) {
  if (!sessionSecret || typeof token !== "string") return null;
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return null;

  const expectedSignature = crypto.createHmac("sha256", sessionSecret).update(payload).digest("base64url");
  const providedSignatureBytes = Buffer.from(signature);
  const expectedSignatureBytes = Buffer.from(expectedSignature);
  if (providedSignatureBytes.length !== expectedSignatureBytes.length
    || !crypto.timingSafeEqual(providedSignatureBytes, expectedSignatureBytes)) return null;

  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof claims.userId !== "string"
      || !Number.isFinite(claims.expiresAt)
      || claims.expiresAt <= Date.now()
      || typeof claims.credentialFingerprint !== "string"
      || !/^[a-f0-9]{64}$/.test(claims.credentialFingerprint)) return null;
    return claims;
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError) return null;
    throw error;
  }
}
async function requireAuth(req, res, next) {
  if (!supabase) return res.status(503).json({ error: "Supabase is not configured." });
  const token = getCookie(req, sessionCookie);
  if (!token) return unauthenticated(req, res, "Please sign in to continue.");
  const claims = readSessionToken(token);
  if (!claims) {
    clearSessionCookie(res);
    return unauthenticated(req, res, "Your session has expired. Please sign in again.");
  }
  const { data: user, error: userError } = await supabase.from("accounts")
    .select("user_id,username,email,phone_number,display_name,role,password_hash").eq("user_id", claims.userId).maybeSingle();
  if (userError) return fail(res, userError);
  if (!user || !user.password_hash) {
    clearSessionCookie(res);
    return unauthenticated(req, res, "This account is no longer active. Please sign in again.");
  }
  const fingerprint = crypto.createHash("sha256").update(user.password_hash).digest();
  const sessionFingerprint = Buffer.from(claims.credentialFingerprint, "hex");
  if (!crypto.timingSafeEqual(fingerprint, sessionFingerprint)) {
    clearSessionCookie(res);
    return unauthenticated(req, res, "Your account credentials have changed. Please sign in again.");
  }
  req.user = {
    user_id: user.user_id,
    username: user.username,
    email: user.email,
    phone_number: user.phone_number,
    display_name: user.display_name,
    role: user.role
  };
  next();
}
function staffRequired(req, res, next) {
  if (["admin", "user"].includes(req.user?.role)) return next();
  if (req.path === "/dashboard.html") return res.redirect("/customer.html");
  return res.status(403).json({ error: "A staff account is required." });
}
function customerRequired(req, res, next) {
  if (req.user?.role !== "customer") {
    if (req.path === "/customer.html") return res.redirect("/dashboard.html");
    return res.status(403).json({ error: "A customer account is required to place orders." });
  }
  next();
}
const publicOrderAttempts = new Map();
const publicOrderWindowMs = 15 * 60 * 1000;
function limitPublicOrderSubmissions(req, res, next) {
  const now = Date.now();
  const key = `${req.path}:${req.ip || req.socket.remoteAddress || "unknown"}`;
  const attempts = publicOrderAttempts.get(key);
  if (attempts && attempts.resetAt > now && attempts.count >= 10) {
    return res.status(429).json({ error: "Too many requests from this connection. Please try again later." });
  }
  if (publicOrderAttempts.size >= 10000 && !attempts) {
    for (const [address, window] of publicOrderAttempts) {
      if (window.resetAt <= now) publicOrderAttempts.delete(address);
    }
    if (publicOrderAttempts.size >= 10000) {
      publicOrderAttempts.delete(publicOrderAttempts.keys().next().value);
    }
  }
  publicOrderAttempts.set(key, attempts && attempts.resetAt > now
    ? { count: attempts.count + 1, resetAt: attempts.resetAt }
    : { count: 1, resetAt: now + publicOrderWindowMs });
  next();
}
app.get("/dashboard.html", requireAuth, staffRequired, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});
app.get("/customer.html", requireAuth, customerRequired, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "customer.html"));
});
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});
app.get(["/admin", "/login.html"], (req, res) => res.redirect("/"));
app.get("/order.html", (req, res) => res.redirect("/customer.html"));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (req, res) => res.json({ ok: true, supabaseConfigured: configured }));

app.post("/api/auth/login", dbRequired, async (req, res) => {
  const identifier = normalizeUsername(req.body?.identifier ?? req.body?.username);
  const password = String(req.body?.password || "");
  const validIdentifier = validUsername(identifier)
    || (identifier.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier));
  if (!validIdentifier || !password) return res.status(400).json({ error: "Enter a valid email or username and password." });
  const { data, error } = await supabase.rpc("authenticate_app_user", {
    p_identifier: identifier,
    p_password: password
  });
  if (error) return fail(res, error);
  const user = data?.[0];
  if (!user) return res.status(401).json({ error: "Invalid username or password." });

  const { data: account, error: accountError } = await supabase.from("accounts")
    .select("password_hash").eq("user_id", user.user_id).maybeSingle();
  if (accountError) return fail(res, accountError);
  if (!account?.password_hash) return fail(res, new Error("Authenticated account has no password hash."));
  setSessionCookie(res, createSessionToken(user.user_id, account.password_hash));
  res.json({ user });
});

app.post("/api/auth/register", dbRequired, limitPublicOrderSubmissions, async (req, res) => {
  const username = normalizeUsername(req.body?.username);
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const phoneNumber = typeof req.body?.phone_number === "string" ? req.body.phone_number.trim() : "";
  const displayName = typeof req.body?.display_name === "string" ? req.body.display_name.trim() : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  const confirmPassword = typeof req.body?.confirm_password === "string" ? req.body.confirm_password : "";
  if (!validUsername(username)) {
    return res.status(400).json({ error: "Username must be 3-32 characters: letters, numbers, periods, underscores, or hyphens." });
  }
  if (!displayName || displayName.length > 120) {
    return res.status(400).json({ error: "Name is required and must be 120 characters or fewer." });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return res.status(400).json({ error: "Enter a valid email address (254 characters or fewer)." });
  }
  if (!/^[0-9]{11}$/.test(phoneNumber)) {
    return res.status(400).json({ error: "Phone number must contain exactly 11 digits." });
  }
  if (password !== confirmPassword) return res.status(400).json({ error: "Passwords do not match." });
  if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });

  const { data, error } = await supabase.rpc("register_customer", {
    p_username: username,
    p_email: email,
    p_phone_number: phoneNumber,
    p_display_name: displayName,
    p_password: password
  });
  if (error) {
    if (error.code === "23505") return res.status(409).json({ error: "That username is already in use." });
    if (error.code === "P0001" && error.message.startsWith("That email address")) {
      return res.status(409).json({ error: error.message });
    }
    if (error.code === "P0001") return res.status(400).json({ error: error.message });
    return fail(res, error);
  }
  const user = data?.[0];
  if (!user) return fail(res, new Error("Customer account registration did not return an account."));
  const { data: account, error: accountError } = await supabase.from("accounts")
    .select("password_hash").eq("user_id", user.user_id).maybeSingle();
  if (accountError) return fail(res, accountError);
  if (!account?.password_hash) return fail(res, new Error("Registered customer has no password hash."));
  setSessionCookie(res, createSessionToken(user.user_id, account.password_hash));
  res.status(201).json({ user });
});

app.post("/api/auth/logout", async (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.use("/api", (req, res, next) => {
  if (["/health", "/auth/login", "/auth/register", "/auth/logout"].includes(req.path)) return next();
  requireAuth(req, res, next);
});

app.use(["/api/items", "/api/summary", "/api/transactions", "/api/orders"], staffRequired);

app.get("/api/auth/me", (req, res) => res.json({ user: req.user }));

app.post("/api/auth/change-password", async (req, res) => {
  const currentPassword = String(req.body?.current_password || "");
  const newPassword = String(req.body?.new_password || "");
  if (!currentPassword) return res.status(400).json({ error: "Enter your current password." });
  if (newPassword.length < 8) return res.status(400).json({ error: "New password must be at least 8 characters." });

  const { error } = await supabase.rpc("change_app_user_password", {
    p_user_id: req.user.user_id,
    p_current_password: currentPassword,
    p_new_password: newPassword
  });
  if (error) {
    if (error.code === "P0001") return res.status(400).json({ error: error.message });
    return fail(res, error);
  }
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get("/api/users", staffRequired, async (req, res) => {
  let query = supabase.from("accounts")
    .select("user_id,username,email,phone_number,display_name,role,created_at");
  if (req.user.role !== "admin") query = query.neq("role", "admin");
  const { data, error } = await query.order("created_at");
  if (error) return fail(res, error);
  res.json(data);
});

async function saveAccount(req, res, userId = null) {
  const username = normalizeUsername(req.body?.username);
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const phoneNumber = typeof req.body?.phone_number === "string" ? req.body.phone_number.trim() : "";
  const displayName = String(req.body?.display_name || "").trim();
  const password = String(req.body?.password || "");
  const role = req.body?.role;
  if (!validUsername(username)) {
    return res.status(400).json({ error: "Username must be 3-32 characters: letters, numbers, periods, underscores, or hyphens." });
  }
  if (!displayName || displayName.length > 120) {
    return res.status(400).json({ error: "Display name is required and must be 120 characters or fewer." });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return res.status(400).json({ error: "Enter a valid email address (254 characters or fewer)." });
  }
  if (!/^[0-9]{11}$/.test(phoneNumber)) {
    return res.status(400).json({ error: "Phone number must contain exactly 11 digits." });
  }
  if (!["admin", "user", "customer"].includes(role)) {
    return res.status(400).json({ error: "Choose a valid account role." });
  }
  if ((userId === null || password) && password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters." });
  }

  const { data, error } = await supabase.rpc("save_app_user", {
    p_username: username,
    p_email: email,
    p_phone_number: phoneNumber,
    p_display_name: displayName,
    p_password: password || null,
    p_role: role,
    p_actor_id: req.user.user_id,
    p_user_id: userId
  });
  if (error) {
    if (error.code === "23505") return res.status(409).json({ error: "That username is already in use." });
    if (error.code === "P0001" && error.message.startsWith("That email address")) {
      return res.status(409).json({ error: error.message });
    }
    if (error.code === "P0001" && error.message.startsWith("Only administrators")) {
      return res.status(403).json({ error: error.message });
    }
    if (error.code === "P0001") return res.status(400).json({ error: error.message });
    return fail(res, error);
  }
  const user = data?.[0];
  if (!user) return res.status(404).json({ error: "Account not found." });
  res.status(userId ? 200 : 201).json(user);
}

app.post("/api/users", staffRequired, (req, res) => saveAccount(req, res));

app.patch("/api/users/:id", staffRequired, (req, res) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.params.id)) {
    return res.status(400).json({ error: "Invalid account ID." });
  }
  return saveAccount(req, res, req.params.id);
});

app.delete("/api/users/:id", staffRequired, async (req, res) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.params.id)) {
    return res.status(400).json({ error: "Invalid account ID." });
  }
  const { error } = await supabase.rpc("delete_app_user", {
    p_actor_id: req.user.user_id,
    p_user_id: req.params.id
  });
  if (error) {
    if (error.code === "P0001" && error.message.startsWith("Only administrators")) {
      return res.status(403).json({ error: error.message });
    }
    if (error.code === "P0001") return res.status(400).json({ error: error.message });
    return fail(res, error);
  }
  res.json({ ok: true });
});

app.get("/api/items", async (req, res) => {
  let query = supabase.from("inventory_items").select("*").order("category").order("name");
  if (req.query.search) query = query.or(`name.ilike.%${req.query.search}%,brand.ilike.%${req.query.search}%,sku.ilike.%${req.query.search}%`);
  if (req.query.category && req.query.category !== "All categories") query = query.eq("category", req.query.category);
  const { data, error } = await query;
  if (error) return fail(res, error);
  res.json(data);
});

app.get("/api/summary", async (req, res) => {
  const { data, error } = await supabase.from("inventory_items").select("quantity,unit_price,low_stock_threshold");
  if (error) return fail(res, error);
  const rows = data || [];
  res.json({
    totalItems: rows.length,
    stockUnits: rows.reduce((n, x) => n + Number(x.quantity || 0), 0),
    inventoryValue: rows.reduce((n, x) => n + Number(x.quantity || 0) * Number(x.unit_price || 0), 0),
    lowStock: rows.filter(x => Number(x.quantity || 0) <= Number(x.low_stock_threshold || 0)).length
  });
});

app.post("/api/items", async (req, res) => {
  const { name, category, brand = "", variant = "", unit = "piece", quantity = 0, unit_price = 0, low_stock_threshold = 5, sku = "", notes = "" } = req.body || {};
  if (!name?.trim() || !category?.trim()) return res.status(400).json({ error: "Item name and category are required." });
  const payload = {
    name: name.trim(), category: category.trim(), brand: brand.trim(), variant: variant.trim(),
    unit, quantity: Number(quantity), unit_price: Number(unit_price),
    low_stock_threshold: Number(low_stock_threshold), sku: sku.trim(), notes: notes.trim()
  };
  if (![payload.quantity, payload.unit_price, payload.low_stock_threshold].every(Number.isFinite) || payload.quantity < 0 || payload.unit_price < 0 || payload.low_stock_threshold < 0) {
    return res.status(400).json({ error: "Quantity, price and low-stock threshold must be zero or greater." });
  }
  const { data, error } = await supabase.from("inventory_items").insert(payload).select().single();
  if (error) return fail(res, error);
  res.status(201).json(data);
});

app.patch("/api/items/:id", async (req, res) => {
  const allowed = ["name", "category", "brand", "variant", "unit", "quantity", "unit_price", "low_stock_threshold", "sku", "notes"];
  const payload = {};
  for (const key of allowed) if (req.body[key] !== undefined) payload[key] = req.body[key];
  for (const key of ["quantity", "unit_price", "low_stock_threshold"]) {
    if (payload[key] !== undefined) {
      payload[key] = Number(payload[key]);
      if (!Number.isFinite(payload[key]) || payload[key] < 0) return res.status(400).json({ error: `${key} must be zero or greater.` });
    }
  }
  if (payload.name !== undefined && !String(payload.name).trim()) return res.status(400).json({ error: "Item name is required." });
  payload.updated_at = new Date().toISOString();
  const { data, error } = await supabase.from("inventory_items").update(payload).eq("id", req.params.id).select().single();
  if (error) return fail(res, error);
  res.json(data);
});

app.delete("/api/items/:id", async (req, res) => {
  const { error } = await supabase.from("inventory_items").delete().eq("id", req.params.id);
  if (error) return fail(res, error);
  res.json({ ok: true });
});

app.post("/api/transactions", async (req, res) => {
  const { item_id, type, quantity, note = "" } = req.body || {};
  const amount = Number(quantity);
  if (!item_id || !["stock_in", "stock_out", "adjustment"].includes(type) || !Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: "Choose an item, transaction type and a quantity greater than zero." });
  }
  const { data: item, error: readError } = await supabase.from("inventory_items").select("*").eq("id", item_id).single();
  if (readError) return fail(res, readError);
  let nextQuantity = type === "stock_in" ? Number(item.quantity) + amount :
    type === "stock_out" ? Number(item.quantity) - amount : amount;
  if (nextQuantity < 0) return res.status(400).json({ error: "Not enough stock for this stock-out." });
  const { data: updated, error: updateError } = await supabase.from("inventory_items")
    .update({ quantity: nextQuantity, updated_at: new Date().toISOString() }).eq("id", item_id).select().single();
  if (updateError) return fail(res, updateError);
  const { data: transaction, error: txError } = await supabase.from("inventory_transactions")
    .insert({ item_id, type, quantity: amount, note: String(note).trim(), balance_after: nextQuantity }).select().single();
  if (txError) {
    // Keep the item update visible; tell the operator the stock changed but its log did not save.
    return res.status(500).json({ error: `Stock changed to ${nextQuantity}, but transaction log failed: ${txError.message}` });
  }
  res.status(201).json({ item: updated, transaction });
});

app.get("/api/transactions", async (req, res) => {
  const { data, error } = await supabase.from("inventory_transactions")
    .select("id,item_id,type,quantity,note,balance_after,created_at,inventory_items(name,category,brand,variant,unit)")
    .order("created_at", { ascending: false }).limit(100);
  if (error) return fail(res, error);
  res.json(data);
});

async function saveClientOrder(req, res, userId, isCustomer = false) {
  const clientName = isCustomer ? req.user.display_name : typeof req.body?.client_name === "string" ? req.body.client_name.trim() : "";
  const clientEmail = isCustomer ? req.user.email : typeof req.body?.client_email === "string" ? req.body.client_email.trim() : "";
  const clientPhone = isCustomer ? req.user.phone_number : typeof req.body?.client_phone === "string" ? req.body.client_phone.trim() : "";
  const note = typeof req.body?.note === "string" ? req.body.note.trim() : "";
  const items = req.body?.items;
  if (!clientName || clientName.length > 120) {
    return res.status(400).json({ error: "Client name is required and must be 120 characters or fewer." });
  }
  if ((userId === null || isCustomer) && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clientEmail) || clientEmail.length > 254)) {
    return res.status(400).json({ error: "Enter a valid email address (254 characters or fewer)." });
  }
  if ((userId === null || isCustomer) && (!/^[+0-9() .-]{7,24}$/.test(clientPhone) || !/[0-9]/.test(clientPhone))) {
    return res.status(400).json({ error: "Enter a valid phone number using 7–24 digits, spaces, or + ( ) . -." });
  }
  if (note.length > 500) return res.status(400).json({ error: "Order note must be 500 characters or fewer." });
  if (!Array.isArray(items) || items.length === 0 || items.length > 100) {
    return res.status(400).json({ error: "Add between 1 and 100 items to the order." });
  }

  const quantities = new Map();
  for (const entry of items) {
    const itemId = entry?.item_id;
    const rawQuantity = entry?.quantity;
    const quantityText = String(rawQuantity ?? "");
    const quantity = Number(quantityText);
    if (typeof itemId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(itemId)
      || !/^\d+(?:\.\d{1,2})?$/.test(quantityText)
      || !Number.isFinite(quantity) || quantity <= 0 || quantity > 9999999999.99) {
      return res.status(400).json({ error: "Each order item must have a valid inventory item and a quantity greater than zero with at most two decimal places." });
    }
    const combinedCents = (quantities.get(itemId) || 0) + Math.round(quantity * 100);
    if (!Number.isSafeInteger(combinedCents) || combinedCents > 999999999999) {
      return res.status(400).json({ error: "Combined order quantities exceed the supported range." });
    }
    quantities.set(itemId, combinedCents);
  }

  const { data: orderId, error } = await supabase.rpc("place_client_order", {
    p_client_name: clientName,
    p_client_email: clientEmail,
    p_client_phone: clientPhone,
    p_note: note,
    p_items: [...quantities].map(([item_id, quantityCents]) => ({ item_id, quantity: quantityCents / 100 })),
    p_user_id: userId
  });
  if (error) {
    if (error.code === "P0001") return res.status(400).json({ error: error.message });
    return fail(res, error);
  }
  res.status(201).json({ id: orderId });
}

app.get("/api/customer/items", customerRequired, async (req, res) => {
  const { data, error } = await supabase.from("inventory_items")
    .select("id,name,category,brand,variant,unit,quantity,unit_price")
    .gt("quantity", 0).order("category").order("name");
  if (error) return fail(res, error);
  res.json(data);
});

app.post("/api/customer/orders", customerRequired, limitPublicOrderSubmissions, (req, res) => saveClientOrder(req, res, req.user.user_id, true));
app.post("/api/orders", (req, res) => saveClientOrder(req, res, req.user.user_id));

app.get("/api/orders", async (req, res) => {
  const { data, error } = await supabase.from("client_orders")
    .select("id,client_name,client_email,client_phone,note,total,order_channel,created_at,ordered_by_account:accounts!client_orders_ordered_by_fkey(display_name),client_order_items(item_name,unit,quantity,unit_price,line_total)")
    .order("created_at", { ascending: false }).limit(100);
  if (error) return fail(res, error);
  res.json(data);
});

app.get("/{*path}", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});
if (require.main === module) {
  app.listen(port, () => console.log(`Materials Inventory running at http://localhost:${port}`));
}
module.exports = app;
