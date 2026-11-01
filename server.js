require("dotenv").config();
const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const ExcelJS = require("exceljs");

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
function normalizeRole(role) {
  const normalizedRole = String(role || "").trim().toLowerCase();
  return normalizedRole === "user" ? "staff" : normalizedRole;
}
function validUsername(username) {
  return /^[a-z0-9][a-z0-9._-]{2,31}$/.test(username);
}
function unauthenticated(req, res, message) {
  if (req.path === "/dashboard.html") return res.redirect("/");
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
    role: normalizeRole(user.role)
  };
  next();
}
function staffRequired(req, res, next) {
  if (["admin", "staff"].includes(req.user?.role)) return next();
  if (req.path === "/dashboard.html") return res.redirect("/");
  return res.status(403).json({ error: "A valid staff or administrator account is required." });
}
function adminRequired(req, res, next) {
  if (req.user?.role === "admin") return next();
  return res.status(403).json({ error: "Only administrators are allowed to perform this action." });
}
async function recordActivity(req, res, activity, actor = req.user) {
  const { error } = await supabase.from("admin_activity_logs").insert({
    actor_id: actor.user_id,
    actor_name: actor.display_name || actor.username,
    actor_role: normalizeRole(actor.role),
    action: activity.action,
    entity_type: activity.entityType,
    entity_id: String(activity.entityId || ""),
    summary: activity.summary
  });
  if (error) {
    console.error("Failed to save admin activity log:", error);
    res.status(500).json({
      error: "The change was saved, but its activity log could not be saved."
    });
    return false;
  }
  return true;
}

app.get("/dashboard.html", requireAuth, staffRequired, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});
app.get(["/admin", "/login.html", "/customer.html", "/customer", "/customers", "/order.html", "/order"], (req, res) => res.redirect("/dashboard.html"));
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
  const authenticatedUser = { ...user, role: normalizeRole(user.role) };
  if (!await recordActivity(req, res, {
    action: "account.signed_in",
    entityType: "account",
    entityId: user.user_id,
    summary: `${authenticatedUser.display_name} signed in.`
  }, authenticatedUser)) return;
  setSessionCookie(res, createSessionToken(user.user_id, account.password_hash));
  res.json({ user });
});

app.post("/api/auth/logout", requireAuth, async (req, res) => {
  if (!await recordActivity(req, res, {
    action: "account.signed_out",
    entityType: "account",
    entityId: req.user.user_id,
    summary: `${req.user.display_name} signed out.`
  })) return;
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.use("/api", (req, res, next) => {
  if (["/health", "/auth/login", "/auth/logout"].includes(req.path)) return next();
  requireAuth(req, res, next);
});

app.use(["/api/items", "/api/summary", "/api/transactions", "/api/orders", "/api/customers", "/api/sales-summary"], staffRequired);

app.get("/api/auth/me", (req, res) => res.json({ user: req.user }));

app.get("/api/admin/activity-logs", adminRequired, async (req, res) => {
  const { data, error } = await supabase.from("admin_activity_logs")
    .select("id,actor_name,actor_role,action,entity_type,entity_id,summary,created_at")
    .order("created_at", { ascending: false }).limit(500);
  if (error) return fail(res, error);
  res.json(data);
});

app.patch("/api/auth/profile", async (req, res) => {
  const username = normalizeUsername(req.body?.username);
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const phoneNumber = typeof req.body?.phone_number === "string" ? req.body.phone_number.trim() : "";
  const displayName = typeof req.body?.display_name === "string" ? req.body.display_name.trim() : "";
  if (!validUsername(username)) {
    return res.status(400).json({ error: "Username must be 3-32 characters: letters, numbers, periods, underscores, or hyphens." });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return res.status(400).json({ error: "Enter a valid email address (254 characters or fewer)." });
  }
  if (!/^[0-9]{11}$/.test(phoneNumber)) {
    return res.status(400).json({ error: "Phone number must contain exactly 11 digits." });
  }
  if (!displayName || displayName.length > 120) {
    return res.status(400).json({ error: "Display name is required and must be 120 characters or fewer." });
  }

  const { data: matchingEmail, error: emailError } = await supabase.from("accounts")
    .select("user_id").eq("email", email).neq("user_id", req.user.user_id).limit(1).maybeSingle();
  if (emailError) return fail(res, emailError);
  if (matchingEmail) return res.status(409).json({ error: "That email address is already in use." });

  const { data, error } = await supabase.from("accounts")
    .update({ username, email, phone_number: phoneNumber, display_name: displayName })
    .eq("user_id", req.user.user_id)
    .in("role", req.user.role === "staff" ? ["staff", "user"] : [req.user.role])
    .select("user_id,username,email,phone_number,display_name,role").maybeSingle();
  if (error) {
    if (error.code === "23505") return res.status(409).json({ error: "That username is already in use." });
    return fail(res, error);
  }
  if (!data) return res.status(404).json({ error: "Account not found." });
  if (!await recordActivity(req, res, {
    action: "account.profile_updated",
    entityType: "account",
    entityId: data.user_id,
    summary: `${req.user.display_name} updated their account profile.`
  })) return;
  res.json({ user: { ...data, role: normalizeRole(data.role) } });
});

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
  if (!await recordActivity(req, res, {
    action: "account.password_changed",
    entityType: "account",
    entityId: req.user.user_id,
    summary: `${req.user.display_name} changed their password.`
  })) return;
  res.json({ ok: true });
});

app.get("/api/users", adminRequired, async (req, res) => {
  const { data, error } = await supabase.from("accounts")
    .select("user_id,username,email,phone_number,display_name,role,created_at")
    .order("created_at");
  if (error) return fail(res, error);
  res.json(data.map(account => ({ ...account, role: normalizeRole(account.role) })));
});

app.post("/api/users", adminRequired, (req, res) => saveAccount(req, res));

app.patch("/api/users/:id", adminRequired, (req, res) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.params.id)) {
    return res.status(400).json({ error: "Invalid account ID." });
  }
  return saveAccount(req, res, req.params.id);
});

app.delete("/api/users/:id", adminRequired, async (req, res) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.params.id)) {
    return res.status(400).json({ error: "Invalid account ID." });
  }
  const { data: target, error: targetError } = await supabase.from("accounts")
    .select("username,role").eq("user_id", req.params.id).maybeSingle();
  if (targetError) return fail(res, targetError);
  if (!target) return res.status(404).json({ error: "Account not found." });
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
  if (!await recordActivity(req, res, {
    action: "account.deleted",
    entityType: "account",
    entityId: req.params.id,
    summary: `Deleted account ${target.username} (${normalizeRole(target.role)}).`
  })) return;
  res.json({ ok: true });
});

async function saveAccount(req, res, userId = null) {
  const username = normalizeUsername(req.body?.username);
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const phoneNumber = typeof req.body?.phone_number === "string" ? req.body.phone_number.trim() : "";
  const displayName = String(req.body?.display_name || "").trim();
  const password = String(req.body?.password || "");
  const role = normalizeRole(req.body?.role) || (userId === null ? "staff" : "");
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
  if (!["admin", "staff"].includes(role)) {
    return res.status(400).json({ error: "Choose Staff or Administrator for this account." });
  }
  if ((userId === null || password) && password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters." });
  }

  const saveArguments = {
    p_username: username,
    p_email: email,
    p_phone_number: phoneNumber,
    p_display_name: displayName,
    p_password: password || null,
    p_role: role,
    p_actor_id: req.user.user_id,
    p_user_id: userId
  };
  let { data, error } = await supabase.rpc("save_app_user", saveArguments);
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
  const action = userId ? "account.updated" : "account.created";
  const passwordReset = userId && password ? " Password was reset." : "";
  if (!await recordActivity(req, res, {
    action,
    entityType: "account",
    entityId: user.user_id,
    summary: `${userId ? "Updated" : "Created"} ${normalizeRole(user.role)} account ${user.username}.${passwordReset}`
  })) return;
  res.status(userId ? 200 : 201).json({ ...user, role: normalizeRole(user.role) });
}

// INVENTORY ITEMS
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

// Admin only: create, update, delete inventory items
app.post("/api/items", adminRequired, async (req, res) => {
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
  if (!await recordActivity(req, res, {
    action: "inventory.item_created",
    entityType: "inventory_item",
    entityId: data.id,
    summary: `Created inventory item ${data.name}.`
  })) return;
  res.status(201).json(data);
});

app.patch("/api/items/:id", adminRequired, async (req, res) => {
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
  if (!await recordActivity(req, res, {
    action: "inventory.item_updated",
    entityType: "inventory_item",
    entityId: data.id,
    summary: `Updated inventory item ${data.name}.`
  })) return;
  res.json(data);
});

app.delete("/api/items/:id", adminRequired, async (req, res) => {
  const { data: item, error: readError } = await supabase.from("inventory_items")
    .select("id,name").eq("id", req.params.id).maybeSingle();
  if (readError) return fail(res, readError);
  if (!item) return res.status(404).json({ error: "Inventory item not found." });
  const { error } = await supabase.from("inventory_items").delete().eq("id", req.params.id);
  if (error) return fail(res, error);
  if (!await recordActivity(req, res, {
    action: "inventory.item_deleted",
    entityType: "inventory_item",
    entityId: item.id,
    summary: `Deleted inventory item ${item.name}.`
  })) return;
  res.json({ ok: true });
});

// Admin only: Quick Add Stock (e.g. Advance cement has 100, add 50 new arrived bags -> 150)
app.post("/api/items/:id/add-stock", adminRequired, async (req, res) => {
  const amount = Number(req.body?.added_quantity);
  const note = String(req.body?.note || "").trim();
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: "Enter a valid quantity to add (must be greater than 0)." });
  }

  const { data: item, error: readError } = await supabase.from("inventory_items").select("*").eq("id", req.params.id).maybeSingle();
  if (readError) return fail(res, readError);
  if (!item) return res.status(404).json({ error: "Inventory item not found." });

  const currentQuantity = Number(item.quantity || 0);
  const nextQuantity = currentQuantity + amount;

  const { data: updated, error: updateError } = await supabase.from("inventory_items")
    .update({ quantity: nextQuantity, updated_at: new Date().toISOString() }).eq("id", item.id).select().single();
  if (updateError) return fail(res, updateError);

  const txNote = note ? `New stock arrived: ${note}` : `Arrived stock added: +${amount} ${item.unit}`;
  await supabase.from("inventory_transactions")
    .insert({ item_id: item.id, type: "stock_in", quantity: amount, note: txNote, balance_after: nextQuantity });

  await recordActivity(req, res, {
    action: "inventory.stock_added",
    entityType: "inventory_item",
    entityId: item.id,
    summary: `Stock added to ${item.name}: +${amount} ${item.unit} (Previous: ${currentQuantity}, New Total: ${nextQuantity}).`
  });

  res.status(200).json({
    item: updated,
    added: amount,
    previous_quantity: currentQuantity,
    new_quantity: nextQuantity
  });
});

// Admin only: manual stock movement
app.post("/api/transactions", adminRequired, async (req, res) => {
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
    if (!await recordActivity(req, res, {
      action: "inventory.stock_changed",
      entityType: "inventory_item",
      entityId: item_id,
      summary: `${type.replace("_", " ")} ${amount} ${item.unit} of ${item.name}; resulting stock ${nextQuantity}. Movement record failed.`
    })) return;
    return res.status(500).json({ error: `Stock changed to ${nextQuantity}, but transaction log failed: ${txError.message}` });
  }
  if (!await recordActivity(req, res, {
    action: "inventory.stock_changed",
    entityType: "inventory_item",
    entityId: item_id,
    summary: `${type.replace("_", " ")} ${amount} ${item.unit} of ${item.name}; resulting stock ${nextQuantity}.`
  })) return;
  res.status(201).json({ item: updated, transaction });
});

// View transactions (stock deductions / stock movements)
app.get("/api/transactions", async (req, res) => {
  const { data, error } = await supabase.from("inventory_transactions")
    .select("id,item_id,type,quantity,note,balance_after,created_at,inventory_items(name,category,brand,variant,unit)")
    .order("created_at", { ascending: false }).limit(200);
  if (error) return fail(res, error);
  res.json(data);
});

// CUSTOMER DATABASE (Staff can add, edit, delete, view; Admin can view)
// Includes complete purchase history, items bought, and date of purchase
app.get(["/api/customers", "/api/order-clients"], async (req, res) => {
  const { data: customers, error } = await supabase.from("customers")
    .select("*").order("name");
  if (error) {
    console.warn("Could not query customers table:", error.message);
    return res.json([]);
  }

  // Load all client orders with items to attach purchase history to each customer
  const { data: allOrders } = await supabase.from("client_orders")
    .select("id,receipt_number,created_at,client_name,client_email,client_phone,note,total,client_order_items(item_name,unit,quantity,unit_price,line_total)")
    .order("created_at", { ascending: false });

  const ordersList = allOrders || [];

  const enhancedCustomers = (customers || []).map(cust => {
    // Match orders by phone or name
    const custPhone = cust.phone ? String(cust.phone).trim() : "";
    const custName = String(cust.name || "").trim().toLowerCase();

    const matchedOrders = ordersList.filter(o => {
      const oPhone = o.client_phone ? String(o.client_phone).trim() : "";
      const oName = String(o.client_name || "").trim().toLowerCase();
      return (custPhone && oPhone === custPhone) || (oName === custName);
    });

    let totalPurchases = 0;
    const allItemsBought = [];

    matchedOrders.forEach(o => {
      totalPurchases += Number(o.total || 0);
      (o.client_order_items || []).forEach(it => {
        allItemsBought.push(`${it.item_name} (${Number(it.quantity).toLocaleString("en-PH")} ${it.unit})`);
      });
    });

    const uniqueItemsSummary = [...new Set(allItemsBought)].slice(0, 5).join(", ") + (allItemsBought.length > 5 ? "..." : "");

    return {
      ...cust,
      orders_count: matchedOrders.length,
      total_purchases: totalPurchases,
      last_purchase_date: matchedOrders[0]?.created_at || null,
      purchased_items_summary: uniqueItemsSummary || "No purchases recorded yet",
      purchases: matchedOrders.map(o => ({
        id: o.id,
        receipt_number: `OR-${String(o.receipt_number).padStart(8, "0")}`,
        date: o.created_at,
        total: o.total,
        note: o.note,
        items: o.client_order_items || []
      }))
    };
  });

  res.json(enhancedCustomers);
});

app.post("/api/customers", async (req, res) => {
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const phone = typeof req.body?.phone === "string" ? req.body.phone.trim() : "";
  const address = typeof req.body?.address === "string" ? req.body.address.trim() : "";
  const notes = typeof req.body?.notes === "string" ? req.body.notes.trim() : "";
  if (!name || name.length > 120) return res.status(400).json({ error: "Customer name is required (120 characters max)." });
  if (email && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254)) {
    return res.status(400).json({ error: "Enter a valid email address." });
  }
  if (phone && !/^[0-9]{11}$/.test(phone)) {
    return res.status(400).json({ error: "Phone number must contain exactly 11 digits." });
  }
  const { data, error } = await supabase.from("customers")
    .insert({ name, email, phone, address, notes, created_by: req.user.user_id })
    .select().single();
  if (error) return fail(res, error);
  if (!await recordActivity(req, res, {
    action: "customer.created",
    entityType: "customer",
    entityId: data.id,
    summary: `Customer encoded: ${data.name}.`
  })) return;
  res.status(201).json(data);
});

app.patch("/api/customers/:id", async (req, res) => {
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const phone = typeof req.body?.phone === "string" ? req.body.phone.trim() : "";
  const address = typeof req.body?.address === "string" ? req.body.address.trim() : "";
  const notes = typeof req.body?.notes === "string" ? req.body.notes.trim() : "";
  if (!name || name.length > 120) return res.status(400).json({ error: "Customer name is required (120 characters max)." });
  if (email && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254)) {
    return res.status(400).json({ error: "Enter a valid email address." });
  }
  if (phone && !/^[0-9]{11}$/.test(phone)) {
    return res.status(400).json({ error: "Phone number must contain exactly 11 digits." });
  }
  const { data, error } = await supabase.from("customers")
    .update({ name, email, phone, address, notes, updated_at: new Date().toISOString() })
    .eq("id", req.params.id).select().single();
  if (error) return fail(res, error);
  if (!data) return res.status(404).json({ error: "Customer not found." });
  if (!await recordActivity(req, res, {
    action: "customer.updated",
    entityType: "customer",
    entityId: data.id,
    summary: `Customer updated: ${data.name}.`
  })) return;
  res.json(data);
});

app.delete("/api/customers/:id", async (req, res) => {
  const { data: customer, error: readError } = await supabase.from("customers")
    .select("id,name").eq("id", req.params.id).maybeSingle();
  if (readError) return fail(res, readError);
  if (!customer) return res.status(404).json({ error: "Customer not found." });
  const { error } = await supabase.from("customers").delete().eq("id", req.params.id);
  if (error) return fail(res, error);
  if (!await recordActivity(req, res, {
    action: "customer.deleted",
    entityType: "customer",
    entityId: customer.id,
    summary: `Customer deleted: ${customer.name}.`
  })) return;
  res.json({ ok: true });
});

// CLIENT ORDERS
async function saveClientOrder(req, res, userId) {
  const clientName = typeof req.body?.client_name === "string" ? req.body.client_name.trim() : "";
  const clientEmail = typeof req.body?.client_email === "string" ? req.body.client_email.trim() : "";
  const clientPhone = typeof req.body?.client_phone === "string" ? req.body.client_phone.trim() : "";
  const note = typeof req.body?.note === "string" ? req.body.note.trim() : "";
  const items = req.body?.items;
  if (!clientName || clientName.length > 120) {
    return res.status(400).json({ error: "Client name is required and must be 120 characters or fewer." });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clientEmail) || clientEmail.length > 254) {
    return res.status(400).json({ error: "Enter a valid email address (254 characters or fewer)." });
  }
  if (!/^[0-9]{11}$/.test(clientPhone)) {
    return res.status(400).json({ error: "Phone number must contain exactly 11 digits." });
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
  const { data: savedOrder, error: orderReadError } = await supabase.from("client_orders")
    .select("id,receipt_number,created_at,client_name,client_email,client_phone,note,total,client_order_items(item_name,unit,quantity,unit_price,line_total)")
    .eq("id", orderId).single();
  if (orderReadError) {
    console.error("Order was saved and logged, but the receipt details could not be loaded:", orderReadError);
    return res.status(500).json({
      error: `Order ${orderId} was saved, but its receipt could not be loaded.`
    });
  }
  const receiptNumber = Number(savedOrder.receipt_number);
  const referenceNumber = `OR-${String(receiptNumber).padStart(8, "0")}`;

  // Automatically sync or record customer in customer database with their address
  const clientAddress = typeof req.body?.client_address === "string" ? req.body.client_address.trim() : "";
  try {
    const { data: existingCust } = await supabase.from("customers")
      .select("id,address").or(`phone.eq.${clientPhone},name.ilike.${clientName}`).limit(1).maybeSingle();

    if (existingCust) {
      if (clientAddress && !existingCust.address) {
        await supabase.from("customers").update({ address: clientAddress, updated_at: new Date().toISOString() }).eq("id", existingCust.id);
      }
    } else {
      await supabase.from("customers").insert({
        name: clientName,
        phone: clientPhone,
        email: clientEmail,
        address: clientAddress,
        notes: `Customer from order ${referenceNumber}`,
        created_by: userId
      });
    }
  } catch (custSyncErr) {
    console.warn("Customer sync warning:", custSyncErr.message);
  }

  if (!await recordActivity(req, res, {
    action: "order.placed",
    entityType: "client_order",
    entityId: orderId,
    summary: `Order ${referenceNumber} recorded for ${clientName} (${quantities.size} item${quantities.size === 1 ? "" : "s"}).`
  })) return;
  res.status(201).json({ ...savedOrder, reference_number: referenceNumber });
}

app.post("/api/orders", (req, res) => saveClientOrder(req, res, req.user.user_id));

app.get("/api/orders", async (req, res) => {
  const { data, error } = await supabase.from("client_orders")
    .select("id,receipt_number,client_name,client_email,client_phone,note,total,order_channel,created_at,ordered_by_account:accounts!client_orders_ordered_by_fkey(display_name),client_order_items(item_name,unit,quantity,unit_price,line_total)")
    .order("created_at", { ascending: false }).limit(200);
  if (error) return fail(res, error);
  res.json(data);
});

// SALES PER DAY
app.get("/api/sales-summary", async (req, res) => {
  const { data, error } = await supabase.from("client_orders")
    .select("id,receipt_number,total,created_at,client_name,client_order_items(quantity,line_total)")
    .order("created_at", { ascending: false });
  if (error) return fail(res, error);
  const salesByDay = new Map();
  let totalSales = 0;
  let totalOrders = (data || []).length;
  let totalItemsSold = 0;

  for (const order of data || []) {
    const day = new Date(order.created_at).toISOString().slice(0, 10);
    const amount = Number(order.total || 0);
    const itemsCount = (order.client_order_items || []).reduce((acc, it) => acc + Number(it.quantity || 0), 0);
    totalItemsSold += itemsCount;

    const entry = salesByDay.get(day) || { date: day, orders: 0, total: 0, itemsSold: 0 };
    entry.orders += 1;
    entry.total += amount;
    entry.itemsSold += itemsCount;
    salesByDay.set(day, entry);
    totalSales += amount;
  }

  res.json({
    totalSales,
    totalOrders,
    totalItemsSold,
    daily: [...salesByDay.values()].sort((a, b) => b.date.localeCompare(a.date))
  });
});

app.get("/api/orders/export", async (req, res) => {
  const exportedOrders = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase.from("client_orders")
      .select("id,receipt_number,client_name,client_email,client_phone,note,total,order_channel,created_at,ordered_by_account:accounts!client_orders_ordered_by_fkey(display_name),client_order_items(item_name,unit,quantity,unit_price,line_total)")
      .order("created_at", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) return fail(res, error);
    exportedOrders.push(...data);
    if (data.length < pageSize) break;
  }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Materials Inventory";
  workbook.created = new Date();

  const ordersSheet = workbook.addWorksheet("Orders");
  ordersSheet.columns = [
    { header: "Receipt reference", key: "reference", width: 20 },
    { header: "Order ID", key: "id", width: 38 },
    { header: "Date", key: "date", width: 22 },
    { header: "Customer", key: "customer", width: 26 },
    { header: "Email", key: "email", width: 32 },
    { header: "Phone", key: "phone", width: 16 },
    { header: "Recorded by", key: "recordedBy", width: 24 },
    { header: "Items", key: "items", width: 52 },
    { header: "Note", key: "note", width: 36 },
    { header: "Total sales", key: "total", width: 16 }
  ];

  const salesByDay = new Map();
  let totalSales = 0;
  for (const order of exportedOrders) {
    const total = Number(order.total);
    const items = (order.client_order_items || [])
      .map(item => `${item.item_name} (${item.quantity} ${item.unit})`)
      .join("; ");
    ordersSheet.addRow({
      reference: `OR-${String(order.receipt_number).padStart(8, "0")}`,
      id: order.id,
      date: new Date(order.created_at),
      customer: order.client_name,
      email: order.client_email,
      phone: order.client_phone,
      recordedBy: order.ordered_by_account?.display_name || "Former account",
      items,
      note: order.note,
      total
    });

    const day = new Date(order.created_at).toISOString().slice(0, 10);
    const sales = salesByDay.get(day) || { orders: 0, total: 0 };
    sales.orders += 1;
    sales.total += total;
    salesByDay.set(day, sales);
    totalSales += total;
  }

  ordersSheet.getColumn("date").numFmt = "yyyy-mm-dd hh:mm";
  ordersSheet.getColumn("total").numFmt = '"₱"#,##0.00';
  ordersSheet.autoFilter = { from: "A1", to: "J1" };
  ordersSheet.views = [{ state: "frozen", ySplit: 1 }];

  const salesSheet = workbook.addWorksheet("Sales Summary");
  salesSheet.addRow(["Daily Sales Report"]);
  salesSheet.addRow(["Total sales", totalSales]);
  salesSheet.addRow(["Number of orders", exportedOrders.length]);
  salesSheet.addRow([]);
  salesSheet.addRow(["Date", "Orders", "Sales"]);
  for (const [day, sales] of [...salesByDay].sort(([a], [b]) => a.localeCompare(b))) {
    salesSheet.addRow([day, sales.orders, sales.total]);
  }
  salesSheet.getRow(1).font = { bold: true, size: 16 };
  salesSheet.getRow(5).font = { bold: true };
  salesSheet.getColumn(1).width = 24;
  salesSheet.getColumn(2).width = 18;
  salesSheet.getColumn(3).width = 20;
  salesSheet.getCell("B2").numFmt = '"₱"#,##0.00';
  salesSheet.getColumn(3).numFmt = '"₱"#,##0.00';
  salesSheet.autoFilter = { from: "A5", to: "C5" };
  salesSheet.views = [{ state: "frozen", ySplit: 5 }];

  const file = await workbook.xlsx.writeBuffer();
  res.set({
    "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": `attachment; filename="orders-sales-${new Date().toISOString().slice(0, 10)}.xlsx"`,
    "Cache-Control": "private, no-store"
  });
  res.send(Buffer.from(file));
});

app.get("/{*path}", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

if (require.main === module) {
  app.listen(port, () => console.log(`Materials Inventory running at http://localhost:${port}`));
}
module.exports = app;
