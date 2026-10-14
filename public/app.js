const $ = (id) => document.getElementById(id);
const state = { items: [], users: [], user: null, view: "inventory", toastTimer: null, itemToDelete: null, userToDelete: null, orderLines: [], nextOrderLineId: 1 };
const money = (n) => new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP", maximumFractionDigits: 2 }).format(Number(n || 0));
const dateTime = (s) => new Date(s).toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" });
const dateOnly = (s) => s ? new Date(s).toLocaleDateString("en-PH", { dateStyle: "medium" }) : "—";

async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}
function toast(message) {
  $("toast").textContent = message; $("toast").classList.add("show");
  clearTimeout(state.toastTimer); state.toastTimer = setTimeout(() => $("toast").classList.remove("show"), 3200);
}
function esc(value = "") {
  return String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function stockStatus(item) {
  const qty = Number(item.quantity), threshold = Number(item.low_stock_threshold);
  if (qty <= 0) return ["Out of stock", "stock-empty"];
  if (qty <= threshold) return ["Low stock", "stock-low"];
  return ["In stock", "stock-good"];
}
async function loadAll() {
  try {
    const [items, summary, health] = await Promise.all([api("/api/items"), api("/api/summary"), api("/api/health")]);
    state.items = items;
    $("connectionText").textContent = health.supabaseConfigured ? "Connected" : "Setup needed";
    $("totalItems").textContent = summary.totalItems.toLocaleString("en-PH");
    $("stockUnits").textContent = summary.stockUnits.toLocaleString("en-PH");
    $("inventoryValue").textContent = money(summary.inventoryValue);
    $("lowStock").textContent = summary.lowStock.toLocaleString("en-PH");
    renderCategories(); renderItems(); renderMovementOptions(); renderOrderLines();
    if (state.view === "transactions") await loadTransactions();
    if (state.view === "orders") await loadOrders();
  } catch (error) {
    if (error.status === 401) return window.location.replace("/login.html");
    $("connectionText").textContent = "Connection issue";
    $("inventoryBody").innerHTML = `<tr><td colspan="8" class="empty-cell">${esc(error.message)}<br><br>Check your .env file and run supabase/schema.sql in the Supabase SQL Editor.</td></tr>`;
    $("rowCount").textContent = "Unable to load";
    ["totalItems", "stockUnits", "inventoryValue", "lowStock"].forEach(id => $(id).textContent = "—");
  }
}
function renderCategories() {
  const select = $("categoryFilter"), current = select.value || "All categories";
  const cats = [...new Set(state.items.map(x => x.category))].sort();
  select.innerHTML = `<option>All categories</option>${cats.map(c => `<option>${esc(c)}</option>`).join("")}`;
  select.value = cats.includes(current) ? current : "All categories";
}
function renderItems() {
  const search = $("searchInput").value.trim().toLowerCase();
  const category = $("categoryFilter").value, stock = $("stockFilter").value;
  const rows = state.items.filter(item => {
    const haystack = [item.name, item.brand, item.variant, item.sku, item.category].join(" ").toLowerCase();
    const status = stockStatus(item)[0];
    return (!search || haystack.includes(search)) && (category === "All categories" || item.category === category) &&
      (stock === "all" || (stock === "low" && status !== "In stock") || (stock === "available" && Number(item.quantity) > 0) || (stock === "empty" && Number(item.quantity) <= 0));
  });
  const direction = $("inventoryDateSort").value === "oldest" ? 1 : -1;
  rows.sort((a, b) => direction * ((Date.parse(a.created_at) || 0) - (Date.parse(b.created_at) || 0)));
  $("inventoryBody").innerHTML = rows.length ? rows.map(item => {
    const [status, cls] = stockStatus(item);
    return `<tr>
      <td><div class="material-name">${esc(item.name)}</div><div class="material-meta">${esc([item.brand, item.variant].filter(Boolean).join(" · ") || "No brand or size entered")}</div></td>
      <td><span class="category-pill">${esc(item.category)}</span></td>
      <td>${esc(item.sku || "—")}</td><td class="quantity-cell">${Number(item.quantity).toLocaleString("en-PH")} <span style="font-weight:400;color:#8993a1">${esc(item.unit)}</span></td>
      <td class="price-cell">${money(item.unit_price)}</td><td>${esc(dateOnly(item.created_at))}</td><td><span class="stock-badge ${cls}">${status}</span></td>
      <td><div class="row-actions"><button class="small-action" data-action="edit" data-id="${item.id}">Edit</button><button class="small-action" data-action="move" data-id="${item.id}">Stock</button><button class="small-action" data-action="delete" data-id="${item.id}">Delete</button></div></td>
    </tr>`;
  }).join("") : `<tr><td colspan="8" class="empty-cell">No materials match your filters.</td></tr>`;
  $("rowCount").textContent = `Showing ${rows.length} of ${state.items.length} items`;
}
function renderMovementOptions() {
  const select = $("movementItem"), selectedId = select.value;
  const query = $("movementSearch").value.trim().toLowerCase();
  const matches = state.items.filter(item =>
    [item.name, item.brand, item.variant, item.sku, item.category].join(" ").toLowerCase().includes(query));
  const selected = state.items.find(item => String(item.id) === selectedId);
  if (selected && !matches.some(item => item.id === selected.id)) matches.unshift(selected);
  select.innerHTML = `<option value="">${state.items.length ? "Select a material" : "No inventory items available"}</option>` +
    matches.map(item => `<option value="${esc(item.id)}">${esc(item.name)}${item.brand ? " · " + esc(item.brand) : ""}${item.variant ? " · " + esc(item.variant) : ""} (stock: ${Number(item.quantity)})</option>`).join("");
  select.value = selectedId;
}
function renderOrderLines() {
  const container = $("orderLines");
  if (!container) return;
  container.innerHTML = state.orderLines.length ? state.orderLines.map(line => {
    const selectedItem = state.items.find(item => String(item.id) === line.itemId);
    const options = state.items.map(item => `<option value="${esc(item.id)}"${String(item.id) === line.itemId ? " selected" : ""}${Number(item.quantity) <= 0 && String(item.id) !== line.itemId ? " disabled" : ""}>${esc(item.name)}${item.variant ? ` · ${esc(item.variant)}` : ""} (stock: ${Number(item.quantity).toLocaleString("en-PH")})</option>`).join("");
    const quantityMax = selectedItem ? `max="${Number(selectedItem.quantity)}"` : "";
    return `<div class="order-line" data-order-line="${line.id}">
      <label class="field">Material<select data-order-item required>
        <option value="">${state.items.length ? "Select a material" : "No inventory items available"}</option>${options}
      </select></label>
      <label class="field">Quantity<input data-order-quantity type="number" min="0.01" step="0.01" ${quantityMax} value="${esc(line.quantity)}" required></label>
      <button class="icon-button order-line-remove" type="button" data-order-remove aria-label="Remove item" ${state.orderLines.length === 1 ? "disabled" : ""}>×</button>
    </div>`;
  }).join("") : `<p class="order-lines-empty">Add at least one material to this order.</p>`;
  updateOrderTotal();
}
function updateOrderTotal() {
  const quantities = new Map();
  state.orderLines.forEach(line => {
    const quantity = Number(line.quantity);
    if (line.itemId && Number.isFinite(quantity) && quantity > 0) {
      quantities.set(line.itemId, (quantities.get(line.itemId) || 0) + Math.round(quantity * 100));
    }
  });
  const total = [...quantities].reduce((sum, [itemId, quantityCents]) => {
    const item = state.items.find(product => String(product.id) === itemId);
    return item ? sum + Math.round(Number(item.unit_price) * quantityCents) / 100 : sum;
  }, 0);
  $("orderTotal").textContent = money(total);
}
function openOrderModal() {
  $("orderForm").reset();
  $("orderError").textContent = "";
  state.orderLines = [{ id: state.nextOrderLineId++, itemId: "", quantity: "1" }];
  renderOrderLines();
  openModal("orderModal");
}
async function loadOrders() {
  try {
    const orders = await api("/api/orders");
    $("ordersBody").innerHTML = orders.length ? orders.map(order => {
      const items = order.client_order_items || [];
      const itemSummary = items.map(item => `<div class="material-name">${esc(item.item_name)} · ${Number(item.quantity).toLocaleString("en-PH")} ${esc(item.unit)}</div><div class="material-meta">${money(item.line_total)}</div>`).join("");
      const orderNote = order.note ? `<div class="material-meta">${esc(order.note)}</div>` : "";
      const contactDetails = [order.client_email, order.client_phone].filter(Boolean).map(esc).join("<br>");
      return `<tr>
        <td>${esc(dateTime(order.created_at))}<div class="material-meta">Order ${esc(order.id.slice(0, 8))}</div></td>
        <td><div class="material-name">${esc(order.client_name)}</div>${contactDetails ? `<div class="material-meta">${contactDetails}</div>` : ""}${orderNote}</td>
        <td>${itemSummary}</td>
        <td class="price-cell">${money(order.total)}</td>
        <td>${esc(order.order_channel === "online" ? "Customer website" : order.ordered_by_account?.display_name || "Former account")}</td>
      </tr>`;
    }).join("") : `<tr><td colspan="5" class="empty-cell">No client orders yet. Record an order to start the history.</td></tr>`;
  } catch (error) {
    if (error.status === 401) return window.location.replace("/login.html");
    $("ordersBody").innerHTML = `<tr><td colspan="5" class="empty-cell">${esc(error.message)}</td></tr>`;
  }
}
function renderUsers() {
  const direction = $("userSort").value;
  const rows = [...state.users];
  if (direction.startsWith("date-")) {
    const multiplier = direction === "date-oldest" ? 1 : -1;
    rows.sort((a, b) => multiplier * ((Date.parse(a.created_at) || 0) - (Date.parse(b.created_at) || 0)));
  } else {
    const [key, order] = direction.split("-");
    const field = key === "name" ? "display_name" : key;
    const multiplier = order === "desc" ? -1 : 1;
    rows.sort((a, b) => multiplier * String(a[field] || "").localeCompare(String(b[field] || ""), undefined, { sensitivity: "base" }));
  }
  $("usersBody").innerHTML = rows.length ? rows.map(user => `<tr>
    <td>${esc(user.username)}</td><td>${esc(user.email || "—")}</td><td>${esc(user.phone_number || "—")}</td>
    <td>${esc(user.display_name)}</td>
    <td><span class="category-pill">${({ admin: "Administrator", user: "User", customer: "Customer" })[user.role] || esc(user.role)}</span></td>
    <td>${esc(dateOnly(user.created_at))}</td><td class="user-actions">
      <button class="small-action" data-user-action="edit" data-id="${esc(user.user_id)}">Edit</button>
      ${user.user_id === state.user.user_id ? "" : `<button class="small-action" data-user-action="delete" data-id="${esc(user.user_id)}">Delete</button>`}
    </td>
  </tr>`).join("") : `<tr><td colspan="7" class="empty-cell">No accounts found.</td></tr>`;
}
function openModal(id) { $(id).classList.remove("hidden"); }
function closeModal(id) { $(id).classList.add("hidden"); }
function closeProfileMenu() {
  $("profileDropdown").classList.add("hidden");
  $("profileTrigger").setAttribute("aria-expanded", "false");
}
function resetItemForm() {
  $("itemForm").reset(); $("itemId").value = ""; $("itemQuantity").value = "0"; $("itemPrice").value = "0"; $("itemThreshold").value = "5";
  $("modalTitle").textContent = "Add material"; $("saveItemBtn").textContent = "Save item"; $("itemError").textContent = "";
}
function editItem(item) {
  resetItemForm();
  $("modalTitle").textContent = "Edit material"; $("saveItemBtn").textContent = "Save changes"; $("itemId").value = item.id;
  const map = { itemName: "name", itemCategory: "category", itemBrand: "brand", itemVariant: "variant", itemSku: "sku", itemUnit: "unit", itemQuantity: "quantity", itemPrice: "unit_price", itemThreshold: "low_stock_threshold", itemNotes: "notes" };
  Object.entries(map).forEach(([id, key]) => $(id).value = item[key] ?? "");
  openModal("itemModal");
}
async function loadTransactions() {
  try {
    const rows = await api("/api/transactions");
    const direction = $("movementDateSort").value === "oldest" ? 1 : -1;
    rows.sort((a, b) => direction * ((Date.parse(a.created_at) || 0) - (Date.parse(b.created_at) || 0)));
    $("transactionsBody").innerHTML = rows.length ? rows.map(x => `<tr>
      <td>${esc(dateTime(x.created_at))}</td>
      <td><div class="material-name">${esc(x.inventory_items?.name || "Deleted item")}</div><div class="material-meta">${esc(x.inventory_items?.category || "")}</div></td>
      <td><span class="category-pill">${({ stock_in: "Stock in", stock_out: "Stock out", adjustment: "Adjustment" })[x.type] || esc(x.type)}</span></td>
      <td>${Number(x.quantity).toLocaleString("en-PH")} ${esc(x.inventory_items?.unit || "")}</td>
      <td class="quantity-cell">${Number(x.balance_after).toLocaleString("en-PH")}</td><td>${esc(x.note || "—")}</td>
    </tr>`).join("") : `<tr><td colspan="6" class="empty-cell">No stock movements yet. Record a movement to start the log.</td></tr>`;
  } catch (error) {
    if (error.status === 401) return window.location.replace("/login.html");
    $("transactionsBody").innerHTML = `<tr><td colspan="6" class="empty-cell">${esc(error.message)}</td></tr>`;
  }
}
function openAccountModal(user = null) {
  $("accountForm").reset();
  $("accountId").value = user?.user_id || "";
  $("accountUsername").value = user?.username || "";
  $("accountEmail").value = user?.email || "";
  $("accountPhoneNumber").value = user?.phone_number || "";
  $("accountDisplayName").value = user?.display_name || "";
  $("accountRole").value = user?.role || "user";
  $("accountRole").disabled = user?.user_id === state.user.user_id;
  $("accountPassword").value = "";
  $("accountPassword").required = !user;
  $("accountPasswordHint").textContent = user
    ? "Leave blank to keep the current password; enter at least 8 characters to change it."
    : "At least 8 characters.";
  $("accountModalTitle").textContent = user ? "Edit account" : "Add account";
  $("saveAccountBtn").textContent = user ? "Save changes" : "Create account";
  $("accountError").textContent = "";
  openModal("accountModal");
}
async function loadUsers() {
  try {
    state.users = await api("/api/users");
    renderUsers();
  } catch (error) {
    if (error.status === 401) return window.location.replace("/login.html");
    $("usersBody").innerHTML = `<tr><td colspan="7" class="empty-cell">${esc(error.message)}</td></tr>`;
  }
}
function showApp(user) {
  state.user = user;
  $("appShell").classList.remove("hidden");
  $("headerDisplayName").textContent = user.display_name;
  const initials = user.display_name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join("");
  $("profileAvatar").textContent = initials.toUpperCase() || user.username.slice(0, 2).toUpperCase();
  $("usersNavLink").classList.toggle("hidden", !["admin", "user"].includes(user.role));
  $("accountRole").querySelector('option[value="admin"]').disabled = user.role !== "admin";
  setView("inventory");
  loadAll();
}
function setView(view) {
  if (view === "users" && !["admin", "user"].includes(state.user?.role)) view = "inventory";
  state.view = view;
  document.querySelectorAll(".nav-link").forEach(b => b.classList.toggle("active", b.dataset.view === view));
  const viewName = { inventory: "Inventory", transactions: "Stock movements", orders: "Client orders", users: "User management" }[view];
  $("crumbCurrent").textContent = viewName;
  $("pageTitle").textContent = viewName;
  $("pageSubtitle").textContent = view === "inventory" ? "Track materials, stock levels, and current prices." : view === "users" ? "Manage accounts for your inventory workspace." : view === "orders" ? "Record client purchases and review saved order history." : "A clear record of every stock-in, stock-out, and adjustment.";
  $("addItemBtn").classList.toggle("hidden", view !== "inventory");
  $("statsGrid").classList.toggle("hidden", view !== "inventory");
  $("inventoryPanel").classList.toggle("hidden", view !== "inventory");
  $("transactionsPanel").classList.toggle("hidden", view !== "transactions");
  $("ordersPanel").classList.toggle("hidden", view !== "orders");
  $("usersPanel").classList.toggle("hidden", view !== "users");
  if (view === "transactions") loadTransactions();
  if (view === "orders") loadOrders();
  if (view === "users") loadUsers();
}
$("profileTrigger").addEventListener("click", () => {
  const isOpen = !$("profileDropdown").classList.contains("hidden");
  $("profileDropdown").classList.toggle("hidden", isOpen);
  $("profileTrigger").setAttribute("aria-expanded", String(!isOpen));
});
$("logoutBtn").addEventListener("click", () => {
  closeProfileMenu();
  openModal("logoutModal");
});
$("confirmLogoutBtn").addEventListener("click", async () => {
  const button = $("confirmLogoutBtn");
  button.disabled = true;
  try {
    await api("/api/auth/logout", { method: "POST" });
    window.location.replace("/?logged_out=1");
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
});
$("changePasswordBtn").addEventListener("click", () => {
  closeProfileMenu();
  $("changePasswordForm").reset();
  $("changePasswordError").textContent = "";
  openModal("changePasswordModal");
});
$("changePasswordForm").addEventListener("submit", async event => {
  event.preventDefault();
  $("changePasswordError").textContent = "";
  const password = $("newPassword").value;
  if (password !== $("confirmNewPassword").value) {
    $("changePasswordError").textContent = "New passwords do not match.";
    return;
  }
  const button = $("savePasswordBtn");
  button.disabled = true;
  try {
    await api("/api/auth/change-password", {
      method: "POST",
      body: JSON.stringify({
        current_password: $("currentPassword").value,
        new_password: password
      })
    });
    window.location.replace("/?password_changed=1");
  } catch (error) {
    if (error.status === 401) return window.location.replace("/login.html");
    $("changePasswordError").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
$("addAccountBtn").addEventListener("click", () => openAccountModal());
$("userSort").addEventListener("change", renderUsers);
$("accountPhoneNumber").addEventListener("input", event => {
  event.target.value = event.target.value.replace(/\D/g, "").slice(0, 11);
});
$("accountForm").addEventListener("submit", async event => {
  event.preventDefault();
  $("accountError").textContent = "";
  const id = $("accountId").value;
  const button = $("saveAccountBtn");
  button.disabled = true;
  try {
    await api(id ? `/api/users/${encodeURIComponent(id)}` : "/api/users", {
      method: id ? "PATCH" : "POST",
      body: JSON.stringify({
        username: $("accountUsername").value,
        email: $("accountEmail").value,
        phone_number: $("accountPhoneNumber").value,
        display_name: $("accountDisplayName").value,
        password: $("accountPassword").value,
        role: $("accountRole").value
      })
    });
    closeModal("accountModal");
    toast(id ? "Account updated." : "Account created.");
    await loadUsers();
  } catch (error) {
    if (error.status === 401) return window.location.replace("/login.html");
    $("accountError").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
$("usersBody").addEventListener("click", event => {
  const button = event.target.closest("button[data-user-action]");
  if (!button) return;
  const user = state.users.find(account => account.user_id === button.dataset.id);
  if (!user) return;
  if (button.dataset.userAction === "edit") {
    openAccountModal(user);
    return;
  }
  if (button.dataset.userAction === "delete" && user.user_id !== state.user.user_id) {
    state.userToDelete = user;
    $("accountDeleteName").textContent = `${user.display_name} (@${user.username})`;
    openModal("accountDeleteModal");
  }
});
$("confirmAccountDeleteBtn").addEventListener("click", async () => {
  const user = state.userToDelete;
  if (!user) return;
  const button = $("confirmAccountDeleteBtn");
  button.disabled = true;
  try {
    await api(`/api/users/${encodeURIComponent(user.user_id)}`, { method: "DELETE" });
    state.userToDelete = null;
    closeModal("accountDeleteModal");
    toast("Account deleted.");
    await loadUsers();
  } catch (error) {
    if (error.status === 401) return window.location.replace("/login.html");
    toast(error.message);
  } finally {
    button.disabled = false;
  }
});
$("accountDeleteModal").addEventListener("click", event => {
  if (event.target.closest("[data-close='accountDeleteModal']")) state.userToDelete = null;
});
$("addItemBtn").addEventListener("click", () => { resetItemForm(); openModal("itemModal"); });
$("refreshBtn").addEventListener("click", loadAll);
$("searchInput").addEventListener("input", renderItems);
$("categoryFilter").addEventListener("change", renderItems);
$("stockFilter").addEventListener("change", renderItems);
$("inventoryDateSort").addEventListener("change", renderItems);
$("movementDateSort").addEventListener("change", loadTransactions);
$("movementSearch").addEventListener("input", renderMovementOptions);
$("newOrderBtn").addEventListener("click", openOrderModal);
$("addOrderLineBtn").addEventListener("click", () => {
  state.orderLines.push({ id: state.nextOrderLineId++, itemId: "", quantity: "1" });
  renderOrderLines();
});
$("orderLines").addEventListener("change", event => {
  const row = event.target.closest("[data-order-line]");
  if (!row) return;
  const line = state.orderLines.find(item => String(item.id) === row.dataset.orderLine);
  if (!line) return;
  if (event.target.matches("[data-order-item]")) {
    line.itemId = event.target.value;
    renderOrderLines();
  } else if (event.target.matches("[data-order-quantity]")) {
    line.quantity = event.target.value;
    updateOrderTotal();
  }
});
$("orderLines").addEventListener("input", event => {
  if (!event.target.matches("[data-order-quantity]")) return;
  const row = event.target.closest("[data-order-line]");
  const line = state.orderLines.find(item => String(item.id) === row?.dataset.orderLine);
  if (!line) return;
  line.quantity = event.target.value;
  updateOrderTotal();
});
$("orderLines").addEventListener("click", event => {
  if (!event.target.closest("[data-order-remove]")) return;
  const row = event.target.closest("[data-order-line]");
  state.orderLines = state.orderLines.filter(line => String(line.id) !== row?.dataset.orderLine);
  renderOrderLines();
});
$("orderForm").addEventListener("submit", async event => {
  event.preventDefault();
  $("orderError").textContent = "";
  if (!state.orderLines.length || state.orderLines.some(line => !line.itemId || !Number.isFinite(Number(line.quantity)) || Number(line.quantity) <= 0)) {
    $("orderError").textContent = "Choose a material and enter a quantity greater than zero for every order line.";
    return;
  }
  const button = $("saveOrderBtn");
  button.disabled = true;
  try {
    await api("/api/orders", {
      method: "POST",
      body: JSON.stringify({
        client_name: $("orderClientName").value,
        note: $("orderNote").value,
        items: state.orderLines.map(line => ({ item_id: line.itemId, quantity: line.quantity }))
      })
    });
    closeModal("orderModal");
    toast("Client order saved and recorded.");
    await loadAll();
  } catch (error) {
    if (error.status === 401) return window.location.replace("/login.html");
    $("orderError").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
document.querySelectorAll(".nav-link").forEach(b => b.addEventListener("click", () => { setView(b.dataset.view); $("sidebar").classList.remove("open"); }));
document.addEventListener("click", event => {
  if (!window.matchMedia("(max-width: 720px)").matches) return;
  const sidebar = $("sidebar");
  if (!sidebar.classList.contains("open")
    || sidebar.contains(event.target)
    || $("menuToggle").contains(event.target)) return;
  sidebar.classList.remove("open");
  $("menuToggle").setAttribute("aria-expanded", "false");
  $("menuToggle").setAttribute("aria-label", "Open navigation");
});
document.querySelectorAll("[data-close]").forEach(b => b.addEventListener("click", () => closeModal(b.dataset.close)));
document.querySelectorAll(".modal-backdrop").forEach(m => m.addEventListener("click", e => {
  if (e.target === m && m.id !== "deleteModal") closeModal(m.id);
}));
document.addEventListener("click", event => {
  if (!event.target.closest("#profileMenu")) closeProfileMenu();
});
document.addEventListener("keydown", e => {
  if (e.key === "Escape") {
    closeProfileMenu();
    state.itemToDelete = null;
    document.querySelectorAll(".modal-backdrop").forEach(m => closeModal(m.id));
  }
});
$("inventoryBody").addEventListener("click", async e => {
  const button = e.target.closest("button[data-action]"); if (!button) return;
  const item = state.items.find(x => String(x.id) === button.dataset.id); if (!item) return;
  if (button.dataset.action === "edit") return editItem(item);
  if (button.dataset.action === "move") {
    $("movementSearch").value = "";
    renderMovementOptions();
    $("movementItem").value = item.id;
    $("movementError").textContent = "";
    openModal("movementModal");
    return;
  }
  if (button.dataset.action === "delete") {
    state.itemToDelete = item;
    $("deleteItemName").textContent = item.name;
    openModal("deleteModal");
  }
});
$("confirmDeleteBtn").addEventListener("click", async () => {
  const item = state.itemToDelete;
  if (!item) return;
  const button = $("confirmDeleteBtn");
  button.disabled = true;
  try {
    await api(`/api/items/${item.id}`, { method: "DELETE" });
    state.itemToDelete = null;
    closeModal("deleteModal");
    toast("Item deleted.");
    await loadAll();
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
});
$("deleteModal").addEventListener("click", e => {
  if (e.target.closest("[data-close='deleteModal']")) state.itemToDelete = null;
});
$("itemForm").addEventListener("submit", async e => {
  e.preventDefault(); $("itemError").textContent = "";
  const id = $("itemId").value;
  const payload = {
    name: $("itemName").value, category: $("itemCategory").value, brand: $("itemBrand").value,
    variant: $("itemVariant").value, sku: $("itemSku").value, unit: $("itemUnit").value,
    quantity: $("itemQuantity").value, unit_price: $("itemPrice").value,
    low_stock_threshold: $("itemThreshold").value, notes: $("itemNotes").value
  };
  try {
    await api(id ? `/api/items/${id}` : "/api/items", { method: id ? "PATCH" : "POST", body: JSON.stringify(payload) });
    closeModal("itemModal"); toast(id ? "Item updated." : "Item added."); await loadAll();
  } catch (error) { $("itemError").textContent = error.message; }
});
$("newMovementBtn").addEventListener("click", () => {
  $("movementForm").reset();
  $("movementSearch").value = "";
  renderMovementOptions();
  $("movementError").textContent = "";
  openModal("movementModal");
});
$("movementForm").addEventListener("submit", async e => {
  e.preventDefault(); $("movementError").textContent = "";
  try {
    await api("/api/transactions", {
      method: "POST", body: JSON.stringify({
        item_id: $("movementItem").value, type: $("movementType").value,
        quantity: $("movementQuantity").value, note: $("movementNote").value
      })
    });
    closeModal("movementModal"); toast("Stock movement recorded."); await loadAll();
  } catch (error) { $("movementError").textContent = error.message; }
});
$("menuToggle").addEventListener("click", () => {
  const isMobile = window.matchMedia("(max-width: 720px)").matches;
  const sidebar = $("sidebar");
  const isOpen = isMobile
    ? sidebar.classList.toggle("open")
    : $("appShell").classList.toggle("sidebar-collapsed");
  $("menuToggle").setAttribute("aria-expanded", String(isMobile ? isOpen : !isOpen));
  $("menuToggle").setAttribute("aria-label", isMobile
    ? (isOpen ? "Close navigation" : "Open navigation")
    : (isOpen ? "Show sidebar" : "Hide sidebar"));
});
api("/api/auth/me")
  .then(result => {
    showApp(result.user);
    const query = new URLSearchParams(window.location.search);
    if (query.has("logged_in")) {
      toast("Logged in successfully.");
      window.history.replaceState({}, "", "/dashboard.html");
    }
  })
  .catch(error => {
    if (error.status === 401) return window.location.replace("/login.html");
    $("connectionText").textContent = error.message;
  });
