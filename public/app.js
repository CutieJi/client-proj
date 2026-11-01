const $ = (id) => document.getElementById(id);
const state = {
  items: [],
  inventoryMonitoring: [],
  inventoryMonitoringTotals: null,
  transactions: [],
  orders: [],
  customers: [],
  purchases: [],
  losses: [],
  activityLogs: [],
  monthlySummary: [],
  users: [],
  salesSummary: null,
  user: null,
  view: "inventory",
  toastTimer: null,
  itemToDelete: null,
  customerToDelete: null,
  userToDelete: null,
  purchaseToPay: null,
  customerPurchaseHistory: null,
  orderLines: [],
  nextOrderLineId: 1,
  pagination: {}
};

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
  $("toast").textContent = message;
  $("toast").classList.add("show");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => $("toast").classList.remove("show"), 3200);
}

function esc(value = "") {
  return String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function pageRows(key, rows) {
  const pagination = state.pagination[key] || (state.pagination[key] = { page: 1, limit: 10 });
  const pageCount = Math.max(1, Math.ceil(rows.length / pagination.limit));
  pagination.page = Math.min(Math.max(1, pagination.page), pageCount);
  const start = rows.length ? (pagination.page - 1) * pagination.limit : 0;
  const end = Math.min(start + pagination.limit, rows.length);
  const container = $(`pagination-${key}`);
  if (container) {
    container.innerHTML = `
      <label>Rows per page
        <select data-page-size aria-label="Rows per page">
          ${[10, 25, 50, 100, 250].map(limit => `<option value="${limit}"${limit === pagination.limit ? " selected" : ""}>${limit}</option>`).join("")}
        </select>
      </label>
      <div class="pagination-controls">
        <span>${rows.length ? `Showing ${start + 1}–${end} of ${rows.length}` : "Showing 0 of 0"}</span>
        <button type="button" class="secondary-button" data-page-prev ${pagination.page <= 1 ? "disabled" : ""}>Previous</button>
        <span>Page ${pagination.page} of ${pageCount}</span>
        <button type="button" class="secondary-button" data-page-next ${pagination.page >= pageCount ? "disabled" : ""}>Next</button>
      </div>`;
  }
  return rows.slice(start, end);
}

function renderPage(key) {
  const renderers = {
    inventory: renderItems,
    "inventory-monitoring": renderInventoryMonitoring,
    transactions: renderTransactions,
    purchases: renderPurchases,
    losses: renderLosses,
    monthly: renderMonthlySummary,
    orders: renderOrders,
    sales: renderDailySales,
    customers: renderCustomers,
    "customer-purchases": renderCustomerPurchases,
    users: renderUsers,
    activity: renderActivityLogs
  };
  renderers[key]?.();
}

function resetTablePage(key, renderer) {
  if (state.pagination[key]) state.pagination[key].page = 1;
  renderer();
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
    $("beginInventoryUnits").textContent = Number(summary.beginInventoryUnits).toLocaleString("en-PH");
    $("beginInventoryRetailAmount").textContent = money(summary.beginInventoryRetailAmount);
    $("beginInventoryCostValue").textContent = money(summary.beginInventoryCostValue);
    renderCategories();
    renderItems();
    renderMovementOptions();

    if (state.view === "transactions") await loadTransactions();
    if (state.view === "purchases") await loadPurchases();
    if (state.view === "losses") await loadLosses();
    if (state.view === "monthly") await loadMonthlySummary();
    if (state.view === "orders") await loadOrders();
    if (state.view === "sales") await loadSalesSummary();
    if (state.view === "customers") await loadCustomers();
    if (state.view === "inventory-monitoring") await loadInventoryMonitoring();
  } catch (error) {
    if (error.status === 401) return window.location.replace("/");
    $("connectionText").textContent = "Connection issue";
    $("inventoryBody").innerHTML = `<tr><td colspan="17" class="empty-cell">${esc(error.message)}</td></tr>`;
    $("rowCount").textContent = "Unable to load";
    ["beginInventoryUnits", "beginInventoryRetailAmount", "beginInventoryCostValue"].forEach(id => $(id).textContent = "—");
  }
}

function updateAddStockPreview(item) {
  const added = Number($("addStockQty").value);
  $("addStockNewTotal").textContent = Number.isFinite(added) && added > 0
    ? `${(Number(item.quantity) + added).toLocaleString("en-PH")} ${item.unit}`
    : "—";
}

function openAddStockModal(item) {
  $("addStockForm").reset();
  $("addStockItemId").value = item.id;
  $("addStockItemName").textContent = `${item.name}${item.variant ? ` · ${item.variant}` : ""}`;
  $("addStockCurrentQty").textContent = `${Number(item.quantity).toLocaleString("en-PH")} ${item.unit}`;
  $("addStockNewTotal").textContent = "—";
  $("addStockError").textContent = "";
  updateAddStockPreview(item);
  openModal("addStockModal");
}

// INVENTORY
function renderCategories() {
  const select = $("categoryFilter"), current = select.value || "All categories";
  const cats = [...new Set(state.items.map(x => x.category))].filter(Boolean).sort();
  select.innerHTML = `<option>All categories</option>${cats.map(c => `<option>${esc(c)}</option>`).join("")}`;
  select.value = cats.includes(current) ? current : "All categories";
  const itemCategories = $("itemCategories");
  const masterfileCategories = [...new Set(state.items.map(item => item.category).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  itemCategories.innerHTML = [...new Set([...masterfileCategories, "Other"])]
    .map(category => `<option value="${esc(category)}"></option>`).join("");
}

function renderItems() {
  const search = $("searchInput").value.trim().toLowerCase();
  const category = $("categoryFilter").value, stock = $("stockFilter").value;
  const isAdmin = state.user?.role === "admin";

  const rows = state.items.filter(item => {
    const haystack = [item.item_number, item.name, item.description, item.supplier, item.other_details, item.brand, item.variant, item.sku, item.category].join(" ").toLowerCase();
    const status = stockStatus(item)[0];
    return (!search || haystack.includes(search)) && (category === "All categories" || item.category === category) &&
      (stock === "all" || (stock === "low" && status !== "In stock") || (stock === "available" && Number(item.quantity) > 0) || (stock === "empty" && Number(item.quantity) <= 0));
  });

  rows.sort((a, b) => {
    const aNumber = Number(a.item_number) || Number.MAX_SAFE_INTEGER;
    const bNumber = Number(b.item_number) || Number.MAX_SAFE_INTEGER;
    return aNumber - bNumber || String(a.sku || "").localeCompare(String(b.sku || ""), undefined, { numeric: true, sensitivity: "base" });
  });
  const visibleRows = pageRows("inventory", rows);

  $("inventoryActionsHeader").textContent = isAdmin ? "Actions" : "Status / Permissions";

  $("inventoryBody").innerHTML = rows.length ? visibleRows.map(item => {
    const [status, cls] = stockStatus(item);
    const actionsHtml = isAdmin
      ? `<div class="row-actions">
           <button class="small-action" data-action="add-stock" data-id="${item.id}" style="font-weight:700;color:#237a55;background:#eaf6ef;border:1px solid #c9ecda;">＋ Add stock</button>
           <button class="small-action" data-action="edit" data-id="${item.id}">Edit</button>
           <button class="small-action" data-action="delete" data-id="${item.id}">Delete</button>
         </div>`
      : `<span style="color:#7b8492;font-size:11px;">View only (Staff)</span>`;

    return `<tr>
      <td>${item.item_number ? esc(item.item_number) : "—"}</td>
      <td>${esc(item.sku || "—")}</td>
      <td><div class="material-name">${esc(item.name)}</div>${item.variant ? `<div class="material-meta">${esc(item.variant)}</div>` : ""}</td>
      <td><span class="category-pill">${esc(item.category)}</span></td>
      <td>${esc(item.description || "—")}</td>
      <td class="price-cell">${money(item.supplier_cost)}</td>
      <td>${esc(item.supplier || "—")}</td>
      <td>${esc(item.brand || "—")}</td>
      <td>${esc(item.other_details || "—")}</td>
      <td class="price-cell">${money(item.unit_price)}</td>
      <td>${Number(item.low_stock_threshold).toLocaleString("en-PH")}</td>
      <td class="quantity-cell">${Number(item.begin_inventory || 0).toLocaleString("en-PH")}</td>
      <td class="price-cell">${money(Number(item.begin_inventory || 0) * Number(item.unit_price || 0))}</td>
      <td class="price-cell">${money(Number(item.begin_inventory || 0) * Number(item.supplier_cost || 0))}</td>
      <td class="quantity-cell">${Number(item.quantity).toLocaleString("en-PH")} <span style="font-weight:400;color:#8993a1">${esc(item.unit)}</span></td>
      <td><span class="stock-badge ${cls}">${status}</span></td>
      <td>${actionsHtml}</td>
    </tr>`;
  }).join("") : `<tr><td colspan="17" class="empty-cell">No materials match your filters.</td></tr>`;

  $("rowCount").textContent = `${rows.length} matching items`;
}

async function loadInventoryMonitoring() {
  try {
    const result = await api("/api/inventory-monitoring");
    state.inventoryMonitoring = result.items;
    state.inventoryMonitoringTotals = result.totals;
    $("monitoringTotalItems").textContent = Number(result.totals.itemCount).toLocaleString("en-PH");
    $("monitoringStockUnits").textContent = Number(result.totals.stockUnits).toLocaleString("en-PH");
    $("monitoringRetailAmount").textContent = money(result.totals.retailAmount);
    $("monitoringCostValue").textContent = money(result.totals.costValue);
    renderInventoryMonitoringCategories();
    renderInventoryMonitoring();
  } catch (error) {
    if (error.status === 401) return window.location.replace("/");
    $("inventoryMonitoringBody").innerHTML = `<tr><td colspan="27" class="empty-cell">${esc(error.message)}</td></tr>`;
    $("monitoringRowCount").textContent = "Unable to load inventory monitoring data";
  }
}

function renderInventoryMonitoringCategories() {
  const select = $("monitoringCategoryFilter");
  const current = select.value || "all";
  const categories = [...new Set(state.inventoryMonitoring.map(item => item.category).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  select.innerHTML = `<option value="all">All categories</option>${categories.map(category =>
    `<option value="${esc(category)}">${esc(category)}</option>`
  ).join("")}`;
  select.value = categories.includes(current) ? current : "all";
}

function renderInventoryMonitoring() {
  const search = $("monitoringSearchInput").value.trim().toLowerCase();
  const category = $("monitoringCategoryFilter").value;
  const stockLevel = $("monitoringStockFilter").value;
  const rows = state.inventoryMonitoring.filter(item => {
    const text = [item.item_number, item.sku, item.name, item.category, item.description, item.supplier, item.brand, item.other_details]
      .join(" ").toLowerCase();
    return (!search || text.includes(search))
      && (category === "all" || item.category === category)
      && (stockLevel === "all" || item.stock_level === stockLevel);
  });
  rows.sort((a, b) => Number(a.item_number || Number.MAX_SAFE_INTEGER) - Number(b.item_number || Number.MAX_SAFE_INTEGER)
    || String(a.sku || "").localeCompare(String(b.sku || ""), undefined, { numeric: true, sensitivity: "base" }));
  const visibleRows = pageRows("inventory-monitoring", rows);
  const quantity = value => Number(value || 0).toLocaleString("en-PH");
  const rowCell = (value, css = "") => `<td${css ? ` class="${css}"` : ""}>${value}</td>`;
  $("inventoryMonitoringBody").innerHTML = rows.length ? visibleRows.map(item => `<tr>
    ${rowCell(item.item_number ? esc(item.item_number) : "—")}
    ${rowCell(esc(item.sku || "—"))}
    ${rowCell(`<strong>${esc(item.name)}</strong>`)}
    ${rowCell(esc(item.category))}
    ${rowCell(esc(item.description || "—"))}
    ${rowCell(money(item.supplier_cost), "price-cell")}
    ${rowCell(esc(item.supplier || "—"))}
    ${rowCell(esc(item.brand || "—"))}
    ${rowCell(esc(item.other_details || "—"))}
    ${rowCell(money(item.unit_price), "price-cell")}
    ${rowCell(quantity(item.low_stock_threshold))}
    ${rowCell(quantity(item.quantity))}
    ${rowCell(money(item.retail_amount), "price-cell")}
    ${rowCell(money(item.inventory_cost_value), "price-cell")}
    ${rowCell(`<span class="stock-badge ${item.stock_level === "OUT OF STOCKS" ? "stock-empty" : item.stock_level === "RE-ORDER" ? "stock-low" : "stock-good"}">${esc(item.stock_level)}</span>`)}
    ${rowCell(quantity(item.total_in_items))}
    ${rowCell(money(item.purchase_cost_amount), "price-cell")}
    ${rowCell(quantity(item.sales_quantity))}
    ${rowCell(money(item.cost_of_goods_sold), "price-cell")}
    ${rowCell(money(item.sales_revenue), "price-cell")}
    ${rowCell(money(item.profit), "price-cell")}
    ${rowCell(quantity(item.damage_quantity))}
    ${rowCell(money(item.damage_amount), "price-cell")}
    ${rowCell(quantity(item.returns_quantity))}
    ${rowCell(money(item.returns_amount), "price-cell")}
    ${rowCell(quantity(item.credit_purchase_quantity))}
    ${rowCell(money(item.credit_purchase_amount), "price-cell")}
  </tr>`).join("") : `<tr><td colspan="27" class="empty-cell">No inventory items match these filters.</td></tr>`;
  $("monitoringRowCount").textContent = `Showing ${rows.length} of ${state.inventoryMonitoring.length} inventory items`;
}

function resetItemForm() {
  $("itemForm").reset();
  $("itemId").value = "";
  $("itemNumber").value = "";
  $("itemQuantity").value = "0";
  $("itemQuantity").dataset.manuallySet = "false";
  $("itemBeginInventory").value = "0";
  $("itemSupplierCost").value = "0";
  $("itemPrice").value = "0";
  $("itemThreshold").value = "0";
  updateItemAmountPreviews();
  $("modalTitle").textContent = "Add material";
  $("saveItemBtn").textContent = "Save item";
  $("itemError").textContent = "";
}

function editItem(item) {
  resetItemForm();
  $("modalTitle").textContent = "Edit material";
  $("saveItemBtn").textContent = "Save changes";
  $("itemId").value = item.id;
  const map = {
    itemNumber: "item_number",
    itemName: "name",
    itemCategory: "category",
    itemBrand: "brand",
    itemVariant: "variant",
    itemSku: "sku",
    itemSupplier: "supplier",
    itemUnit: "unit",
    itemQuantity: "quantity",
    itemSupplierCost: "supplier_cost",
    itemPrice: "unit_price",
    itemThreshold: "low_stock_threshold",
    itemBeginInventory: "begin_inventory",
    itemDescription: "description",
    itemOtherDetails: "other_details",
    itemNotes: "notes"
  };
  Object.entries(map).forEach(([id, key]) => $(id).value = item[key] ?? "");
  updateItemAmountPreviews();
  openModal("itemModal");
}

function updateItemAmountPreviews() {
  const beginning = Number($("itemBeginInventory").value) || 0;
  if (!$("itemId").value && $("itemQuantity").dataset.manuallySet !== "true") {
    $("itemQuantity").value = $("itemBeginInventory").value || "0";
  }
  $("itemRetailInventoryAmount").value = money(beginning * (Number($("itemPrice").value) || 0));
  $("itemInventoryCostValueAmount").value = money(beginning * (Number($("itemSupplierCost").value) || 0));
}

// STOCK MOVEMENTS & DEDUCTIONS
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

async function loadTransactions() {
  try {
    const rows = await api("/api/transactions");
    state.transactions = rows;
    renderTransactions();
  } catch (error) {
    if (error.status === 401) return window.location.replace("/");
    $("transactionsBody").innerHTML = `<tr><td colspan="6" class="empty-cell">${esc(error.message)}</td></tr>`;
  }
}

function renderTransactions() {
  const typeFilter = $("movementTypeFilter").value;
  const rows = state.transactions.filter(x => typeFilter === "all" || x.type === typeFilter);
  const direction = $("movementDateSort").value === "oldest" ? 1 : -1;
  rows.sort((a, b) => direction * ((Date.parse(a.created_at) || 0) - (Date.parse(b.created_at) || 0)));
  const visibleRows = pageRows("transactions", rows);

  $("transactionsBody").innerHTML = rows.length ? visibleRows.map(x => {
    const movementLabel = {
      stock_in: "Stock in (+)",
      stock_out: "Stock out / Deducted (-)",
      adjustment: "Adjustment (=)"
    }[x.type] || esc(x.type);

    const movementPillCls = x.type === "stock_out" ? "style='background:#fff0ef;color:#b74343;border:1px solid #fbd0ce;'" :
      x.type === "stock_in" ? "style='background:#eaf6ef;color:#237a55;border:1px solid #c9ecda;'" : "";

    return `<tr>
      <td>${esc(dateTime(x.created_at))}</td>
      <td><div class="material-name">${esc(x.inventory_items?.name || "Deleted item")}</div><div class="material-meta">${esc(x.inventory_items?.category || "")}</div></td>
      <td><span class="category-pill" ${movementPillCls}>${movementLabel}</span></td>
      <td><strong>${Number(x.quantity).toLocaleString("en-PH")}</strong> ${esc(x.inventory_items?.unit || "")}</td>
      <td class="quantity-cell">${Number(x.balance_after).toLocaleString("en-PH")}</td>
      <td>${esc(x.note || "—")}</td>
    </tr>`;
  }).join("") : `<tr><td colspan="6" class="empty-cell">No stock movements found matching filter.</td></tr>`;
}

function inventoryOptions(selectedId = "") {
  return `<option value="">Select a material</option>` + state.items.map(item =>
    `<option value="${esc(item.id)}"${String(item.id) === String(selectedId) ? " selected" : ""}>${esc(item.name)}${item.variant ? ` · ${esc(item.variant)}` : ""} (stock: ${Number(item.quantity).toLocaleString("en-PH")} ${esc(item.unit)})</option>`
  ).join("");
}

async function loadPurchases() {
  try {
    state.purchases = await api("/api/purchases");
    renderPurchases();
  } catch (error) {
    if (error.status === 401) return window.location.replace("/");
    $("purchasesBody").innerHTML = `<tr><td colspan="9" class="empty-cell">${esc(error.message)}</td></tr>`;
    $("purchaseCount").textContent = "Unable to load";
  }
}

function renderPurchases() {
    const rows = pageRows("purchases", state.purchases);
    const isAdmin = state.user?.role === "admin";
    $("purchasesBody").innerHTML = state.purchases.length ? rows.map(purchase => {
      const balance = Math.max(0, Number(purchase.total_amount) - Number(purchase.amount_paid));
      const payments = (purchase.inventory_purchase_payments || []).reduce((sum, payment) => sum + Number(payment.amount), 0);
      return `<tr>
        <td>${esc(dateTime(purchase.created_at))}</td>
        <td><div class="material-name">${esc(purchase.inventory_items?.name || "Deleted item")}</div><div class="material-meta">${Number(purchase.quantity).toLocaleString("en-PH")} ${esc(purchase.inventory_items?.unit || "")}</div></td>
        <td>${esc(purchase.supplier || "—")}<div class="material-meta">${esc(purchase.invoice_number || "No invoice")}</div></td>
        <td><span class="category-pill">${purchase.type === "purchase_credit" ? "Credit" : "Cash"}</span>${purchase.due_date ? `<div class="material-meta">Due ${esc(dateOnly(purchase.due_date))}</div>` : ""}</td>
        <td>${Number(purchase.quantity).toLocaleString("en-PH")}</td>
        <td class="price-cell">${money(purchase.total_amount)}</td>
        <td class="price-cell">${money(purchase.amount_paid)}${payments > Number(purchase.amount_paid) ? `<div class="material-meta">Payments logged: ${money(payments)}</div>` : ""}</td>
        <td class="price-cell">${money(balance)}</td>
        <td>${isAdmin && balance > 0 ? `<button class="small-action" data-purchase-payment="${esc(purchase.id)}">Record payment</button>` : "—"}</td>
      </tr>`;
    }).join("") : `<tr><td colspan="9" class="empty-cell">No purchases recorded yet.</td></tr>`;
    $("purchaseCount").textContent = `Showing ${state.purchases.length} purchase records`;
}

async function loadLosses() {
  try {
    state.losses = await api("/api/damage-returns");
    renderLosses();
  } catch (error) {
    if (error.status === 401) return window.location.replace("/");
    $("lossesBody").innerHTML = `<tr><td colspan="7" class="empty-cell">${esc(error.message)}</td></tr>`;
    $("lossCount").textContent = "Unable to load";
  }
}

function renderLosses() {
    const labels = { damage: "Damage / write-off", customer_return: "Customer return", supplier_return: "Supplier return" };
    const rows = pageRows("losses", state.losses);
    $("lossesBody").innerHTML = state.losses.length ? rows.map(event => `<tr>
      <td>${esc(dateTime(event.created_at))}</td>
      <td><div class="material-name">${esc(event.inventory_items?.name || "Deleted item")}</div><div class="material-meta">${esc(event.inventory_items?.sku || "")}</div></td>
      <td><span class="category-pill">${labels[event.type] || esc(event.type)}</span></td>
      <td>${Number(event.quantity).toLocaleString("en-PH")} ${esc(event.inventory_items?.unit || "")}</td>
      <td class="price-cell">${money(event.total_amount)}</td>
      <td>${Number(event.balance_after).toLocaleString("en-PH")}</td>
      <td>${esc(event.note || "—")}</td>
    </tr>`).join("") : `<tr><td colspan="7" class="empty-cell">No damage or return records yet.</td></tr>`;
    $("lossCount").textContent = `Showing ${state.losses.length} records`;
}

async function loadMonthlySummary() {
  try {
    const year = $("summaryYear").value || String(new Date().getFullYear());
    const result = await api(`/api/management-summary?year=${encodeURIComponent(year)}`);
    state.monthlySummary = result.months;
    renderMonthlySummary();
  } catch (error) {
    if (error.status === 401) return window.location.replace("/");
    $("monthlySummaryBody").innerHTML = `<tr><td colspan="10" class="empty-cell">${esc(error.message)}</td></tr>`;
  }
}

function renderMonthlySummary() {
    const resultYear = Number($("summaryYear").value || new Date().getFullYear());
    const rows = pageRows("monthly", state.monthlySummary);
    const monthNames = new Intl.DateTimeFormat("en", { month: "long", timeZone: "UTC" });
    $("monthlySummaryBody").innerHTML = rows.map(entry => `<tr>
      <td><strong>${monthNames.format(new Date(Date.UTC(resultYear, entry.month - 1, 1)))}</strong></td>
      <td class="price-cell">${money(entry.cashPurchases)}</td>
      <td class="price-cell">${money(entry.creditPurchases)}</td>
      <td class="price-cell">${money(entry.creditPayments)}</td>
      <td class="price-cell">${money(entry.sales)}</td>
      <td class="price-cell">${money(entry.discounts)}</td>
      <td class="price-cell">${money(entry.costOfGoodsSold)}</td>
      <td class="price-cell">${money(entry.grossProfit)}</td>
      <td>${Number(entry.returnsQty).toLocaleString("en-PH")} <span class="material-meta">${money(entry.returnsAmount)}</span></td>
      <td>${Number(entry.damagedQty).toLocaleString("en-PH")} <span class="material-meta">${money(entry.damageAmount)}</span></td>
    </tr>`).join("");
}

// CLIENT ORDERS
async function loadOrders() {
  try {
    const orders = await api("/api/orders");
    state.orders = orders;
    renderOrders();
  } catch (error) {
    if (error.status === 401) return window.location.replace("/");
    $("ordersBody").innerHTML = `<tr><td colspan="5" class="empty-cell">${esc(error.message)}</td></tr>`;
  }
}

function renderOrders() {
    const orders = state.orders;
    const visibleOrders = pageRows("orders", orders);
    $("ordersBody").innerHTML = orders.length ? visibleOrders.map(order => {
      const items = order.client_order_items || [];
      const itemSummary = items.map(item => `<div class="material-name">${esc(item.item_name)} · <strong>${Number(item.quantity).toLocaleString("en-PH")} ${esc(item.unit)}</strong></div><div class="material-meta">${money(item.line_total)}</div>`).join("");
      const orderNote = order.note ? `<div class="material-meta">${esc(order.note)}</div>` : "";
      const contactDetails = [order.client_phone, order.client_email].filter(Boolean).map(esc).join(" · ");
      return `<tr>
        <td>${esc(dateTime(order.created_at))}<div class="material-meta">${esc(`OR-${String(order.receipt_number).padStart(8, "0")}`)}</div></td>
        <td><div class="material-name">${esc(order.client_name)}</div>${contactDetails ? `<div class="material-meta">${contactDetails}</div>` : ""}${orderNote}</td>
        <td>${itemSummary}</td>
        <td class="price-cell">${money(order.total)}${Number(order.discount_total) > 0 ? `<div class="material-meta">Discount: ${money(order.discount_total)}</div>` : ""}</td>
        <td>${esc(order.ordered_by_account?.display_name || "Staff")}</td>
      </tr>`;
    }).join("") : `<tr><td colspan="5" class="empty-cell">No client orders yet. Staff can record orders to deduct stock.</td></tr>`;
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
  const discount = Number($("orderDiscount").value || 0);
  $("orderSubtotal").textContent = money(total);
  $("orderDiscountDisplay").textContent = money(discount);
  $("orderTotal").textContent = money(total - discount);
}

async function openOrderModal() {
  $("orderForm").reset();
  $("orderError").textContent = "";
  $("orderClientName").value = "";
  $("orderClientEmail").value = "";
  $("orderClientPhone").value = "";
  $("orderClientAddress").value = "";
  $("orderClientSelect").disabled = true;
  $("orderClientSelect").innerHTML = `<option value="new">Loading customers from database…</option>`;
  state.orderLines = [{ id: state.nextOrderLineId++, itemId: "", quantity: "1" }];
  renderOrderLines();
  openModal("orderModal");

  try {
    const customers = await api("/api/customers");
    state.customers = customers;
    $("orderClientSelect").innerHTML = `<option value="new">Walk-in / New customer</option>` +
      customers.map(c => `<option value="${esc(c.id)}">${esc(c.name)}${c.phone ? " · " + esc(c.phone) : ""}</option>`).join("");
    $("orderClientSelect").value = "new";
  } catch (error) {
    $("orderClientSelect").innerHTML = `<option value="new">Walk-in / New customer</option>`;
    if (error.status === 401) return window.location.replace("/");
    toast(`Saved customers could not be loaded: ${error.message}`);
  } finally {
    $("orderClientSelect").disabled = false;
  }
}

function onOrderClientSelected() {
  const val = $("orderClientSelect").value;
  if (val === "new") {
    $("orderClientName").value = "";
    $("orderClientEmail").value = "";
    $("orderClientPhone").value = "";
    $("orderClientAddress").value = "";
    return;
  }
  const customer = state.customers.find(c => String(c.id) === val);
  if (customer) {
    $("orderClientName").value = customer.name || "";
    $("orderClientEmail").value = customer.email || "";
    $("orderClientPhone").value = customer.phone || "";
    $("orderClientAddress").value = customer.address || "";
  }
}

function showOrderReceipt(order) {
  const items = order.client_order_items || [];
  $("receiptContent").innerHTML = `
    <div class="receipt-hero">
      <span class="receipt-success-icon" aria-hidden="true">✓</span>
      <strong class="receipt-status">ORDER CONFIRMED &amp; STOCK DEDUCTED</strong>
      <span class="receipt-brand">MATERIALS INVENTORY</span>
      <strong class="receipt-amount">${money(order.total)}</strong>
      <span class="receipt-amount-label">Order total</span>
    </div>
    <h3>Order receipt</h3>
    <p class="receipt-reference"><span>Reference number</span><strong>${esc(order.reference_number)}</strong></p>
    <div class="receipt-meta">
      <span>Date</span><strong>${esc(dateTime(order.created_at))}</strong>
      <span>Customer</span><strong>${esc(order.client_name)}</strong>
      <span>Phone</span><strong>${esc(order.client_phone)}</strong>
      <span>Email</span><strong>${esc(order.client_email || "None")}</strong>
      <span>Address</span><strong>${esc(order.client_address)}</strong>
      ${state.user?.display_name ? `<span>Encoded by</span><strong>${esc(state.user.display_name)}</strong>` : ""}
    </div>
    <div class="receipt-items">${items.map(item => `<div class="receipt-item">
      <span>${esc(item.item_name)}<small>${Number(item.quantity).toLocaleString("en-PH")} ${esc(item.unit)} × ${money(item.unit_price)}</small></span>
      <strong>${money(item.line_total)}</strong>
    </div>`).join("")}
    <div class="receipt-item"><span>Discount</span><strong>−${money(order.discount_total)}</strong></div></div>
    ${order.note ? `<p class="receipt-note"><span>Note</span>${esc(order.note)}</p>` : ""}
    <div class="receipt-total"><span>Total</span><strong>${money(order.total)}</strong></div>
    <p class="receipt-disclaimer">Stock has been deducted from the main inventory. Order receipt for business records.</p>`;
  openModal("receiptModal");
}

// SALES PER DAY
async function loadSalesSummary() {
  try {
    const data = await api("/api/sales-summary");
    state.salesSummary = data;
    $("salesTotalRevenue").textContent = money(data.totalSales);
    $("salesTotalOrders").textContent = Number(data.totalOrders).toLocaleString("en-PH");
    $("salesTotalItems").textContent = Number(data.totalItemsSold).toLocaleString("en-PH");
    $("salesTotalDiscounts").textContent = money(data.totalDiscounts);
    $("salesGrossProfit").textContent = money(data.grossProfit);

    const todayStr = new Date().toISOString().slice(0, 10);
    const todayEntry = (data.daily || []).find(d => d.date === todayStr);
    $("salesTodayRevenue").textContent = money(todayEntry?.total || 0);
    $("salesTodayCount").textContent = `${todayEntry?.orders || 0} orders today`;

    renderDailySales();
  } catch (error) {
    if (error.status === 401) return window.location.replace("/");
    $("dailySalesBody").innerHTML = `<tr><td colspan="7" class="empty-cell">${esc(error.message)}</td></tr>`;
  }
}

function renderDailySales() {
    const dailyRows = state.salesSummary?.daily || [];
    const visibleRows = pageRows("sales", dailyRows);
    $("dailySalesBody").innerHTML = dailyRows.length ? visibleRows.map(row => `<tr>
      <td><strong>${esc(dateOnly(row.date))}</strong> (${esc(row.date)})</td>
      <td><strong>${Number(row.orders).toLocaleString("en-PH")}</strong> order${row.orders === 1 ? "" : "s"}</td>
      <td><strong>${Number(row.itemsSold).toLocaleString("en-PH")}</strong> units deducted</td>
      <td class="price-cell">${money(row.discounts)}</td>
      <td class="price-cell"><strong>${money(row.total)}</strong></td>
      <td class="price-cell">${money(row.costOfGoods)}</td>
      <td class="price-cell"><strong>${money(row.grossProfit)}</strong></td>
    </tr>`).join("") : `<tr><td colspan="7" class="empty-cell">No sales recorded yet. Client orders will appear here aggregated daily.</td></tr>`;
}

// CUSTOMER DATABASE
async function loadCustomers() {
  try {
    const customers = await api("/api/customers");
    state.customers = customers;
    renderCustomers();
  } catch (error) {
    if (error.status === 401) return window.location.replace("/");
    $("customersBody").innerHTML = `<tr><td colspan="7" class="empty-cell">${esc(error.message)}</td></tr>`;
  }
}

function renderCustomers() {
  const search = $("customerSearchInput").value.trim().toLowerCase();
  const rows = state.customers.filter(c => {
    const text = [c.name, c.phone, c.email, c.address, c.notes].join(" ").toLowerCase();
    return !search || text.includes(search);
  });

  const visibleRows = pageRows("customers", rows);
  $("customersBody").innerHTML = rows.length ? visibleRows.map(c => `<tr>
    <td><strong>${esc(c.name)}</strong></td>
    <td>${esc(c.phone || "—")}</td>
    <td>${esc(c.address || "—")}</td>
    <td>${esc(c.last_purchase_date ? dateTime(c.last_purchase_date) : "—")}</td>
    <td>${esc(c.purchased_items_summary || "No purchases recorded yet")}</td>
    <td title="${Number(c.orders_count || 0)} orders">${money(c.total_purchases)}</td>
    <td>
      <div class="row-actions">
        <button class="small-action" data-customer-action="history" data-id="${esc(c.id)}">Purchases (${Number(c.orders_count || 0)})</button>
        <button class="small-action" data-customer-action="edit" data-id="${esc(c.id)}">Edit</button>
        <button class="small-action" data-customer-action="delete" data-id="${esc(c.id)}">Delete</button>
      </div>
    </td>
  </tr>`).join("") : `<tr><td colspan="7" class="empty-cell">No customers found. Click "＋ Add customer" to encode one.</td></tr>`;

  $("customerCount").textContent = `Showing ${rows.length} of ${state.customers.length} customers in database`;
}

function showCustomerPurchases(customer) {
  state.customerPurchaseHistory = customer;
  if (state.pagination["customer-purchases"]) state.pagination["customer-purchases"].page = 1;
  $("historyCustName").textContent = customer.name || "—";
  $("historyCustPhone").textContent = customer.phone || "No phone number";
  $("historyCustAddress").textContent = customer.address || "No address recorded";
  $("historyTotalPurchases").textContent = money(customer.total_purchases);
  $("historyOrdersCount").textContent = `${Number(customer.orders_count || 0)} order${Number(customer.orders_count || 0) === 1 ? "" : "s"}`;
  renderCustomerPurchases();
  openModal("customerPurchasesModal");
}

function renderCustomerPurchases() {
  const purchases = state.customerPurchaseHistory?.purchases || [];
  const visiblePurchases = pageRows("customer-purchases", purchases);
  $("customerPurchasesBody").innerHTML = purchases.length ? visiblePurchases.map(purchase => {
    const items = (purchase.items || []).map(item =>
      `${esc(item.item_name)} · ${Number(item.quantity).toLocaleString("en-PH")} ${esc(item.unit)} (${money(item.line_total)})`
    ).join("<br>");
    const details = [purchase.note, purchase.address].filter(Boolean).map(esc).join("<br>");
    return `<tr>
      <td>${esc(dateTime(purchase.date))}</td>
      <td>${esc(purchase.receipt_number)}</td>
      <td>${items || "—"}</td>
      <td class="price-cell">${money(purchase.total)}</td>
      <td>${details || "—"}</td>
    </tr>`;
  }).join("") : `<tr><td colspan="5" class="empty-cell">No purchases recorded for this customer yet.</td></tr>`;
}

function openCustomerModal(customer = null) {
  $("customerForm").reset();
  $("customerId").value = customer?.id || "";
  $("custName").value = customer?.name || "";
  $("custPhone").value = customer?.phone || "";
  $("custEmail").value = customer?.email || "";
  $("custAddress").value = customer?.address || "";
  $("custNotes").value = customer?.notes || "";
  $("customerError").textContent = "";
  $("customerModalTitle").textContent = customer ? "Edit customer" : "Add customer";
  $("saveCustomerBtn").textContent = customer ? "Save changes" : "Encode customer";
  openModal("customerModal");
}

// USER MANAGEMENT (Admin Only)
async function loadUsers() {
  try {
    state.users = await api("/api/users");
    renderUsers();
  } catch (error) {
    if (error.status === 401) return window.location.replace("/");
    $("usersBody").innerHTML = `<tr><td colspan="7" class="empty-cell">${esc(error.message)}</td></tr>`;
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
  const visibleRows = pageRows("users", rows);
  $("usersBody").innerHTML = rows.length ? visibleRows.map(user => `<tr>
    <td><strong>${esc(user.username)}</strong></td>
    <td>${esc(user.email || "—")}</td>
    <td>${esc(user.phone_number || "—")}</td>
    <td>${esc(user.display_name)}</td>
    <td><span class="category-pill">${({ admin: "Super Admin", staff: "Staff" })[user.role] || esc(user.role)}</span></td>
    <td>${esc(dateOnly(user.created_at))}</td>
    <td class="user-actions">
      <button class="small-action" data-user-action="edit" data-id="${esc(user.user_id)}">Edit</button>
      ${user.user_id === state.user.user_id ? "" : `<button class="small-action" data-user-action="delete" data-id="${esc(user.user_id)}">Delete</button>`}
    </td>
  </tr>`).join("") : `<tr><td colspan="7" class="empty-cell">No accounts found.</td></tr>`;
}

function openAccountModal(user = null) {
  $("accountForm").reset();
  $("accountId").value = user?.user_id || "";
  $("accountUsername").value = user?.username || "";
  $("accountEmail").value = user?.email || "";
  $("accountPhoneNumber").value = user?.phone_number || "";
  $("accountDisplayName").value = user?.display_name || "";
  $("accountRole").value = user ? user.role : "staff";
  $("accountRole").disabled = user?.user_id === state.user.user_id;
  $("accountPassword").value = "";
  $("accountPassword").required = !user;
  $("accountPasswordHint").textContent = user
    ? "Leave blank to keep the current password; enter at least 8 characters to change."
    : "At least 8 characters.";
  $("accountModalTitle").textContent = user ? "Edit account" : "Add account";
  $("saveAccountBtn").textContent = user ? "Save changes" : "Create account";
  $("accountError").textContent = "";
  openModal("accountModal");
}

// ACTIVITY LOGS (Admin Only)
async function loadActivityLogs() {
  try {
    state.activityLogs = await api("/api/admin/activity-logs");
    renderActivityLogs();
  } catch (error) {
    if (error.status === 401) return window.location.replace("/");
    $("activityBody").innerHTML = `<tr><td colspan="5" class="empty-cell">${esc(error.message)}</td></tr>`;
  }
}

function renderActivityLogs() {
    const logs = pageRows("activity", state.activityLogs);
    $("activityBody").innerHTML = state.activityLogs.length ? logs.map(log => `<tr>
      <td>${esc(dateTime(log.created_at))}</td>
      <td>${esc(log.actor_name)}</td>
      <td><span class="category-pill">${esc(({ admin: "Super Admin", staff: "Staff" })[log.actor_role] || log.actor_role)}</span></td>
      <td>${esc(log.action.replace(/[._]/g, " "))}</td>
      <td>${esc(log.summary)}</td>
    </tr>`).join("") : `<tr><td colspan="5" class="empty-cell">No activity has been recorded yet.</td></tr>`;
}

// UI HELPERS
function openModal(id) { $(id).classList.remove("hidden"); }
function closeModal(id) { $(id).classList.add("hidden"); }
function closeProfileMenu() {
  $("profileDropdown").classList.add("hidden");
  $("profileTrigger").setAttribute("aria-expanded", "false");
}

function showApp(user) {
  state.user = user;
  $("appShell").classList.remove("hidden");
  $("headerDisplayName").textContent = `${user.display_name} (${user.role === "admin" ? "Super Admin" : "Staff"})`;
  const initials = user.display_name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join("");
  $("profileAvatar").textContent = initials.toUpperCase() || user.username.slice(0, 2).toUpperCase();

  const isAdmin = user.role === "admin";
  $("usersNavLink").classList.toggle("hidden", !isAdmin);
  $("activityNavLink").classList.toggle("hidden", !isAdmin);
  const currentYear = new Date().getFullYear();
  $("summaryYear").innerHTML = Array.from({ length: 7 }, (_, index) => currentYear + 2 - index)
    .map(year => `<option value="${year}">${year}</option>`).join("");
  $("summaryYear").value = String(currentYear);

  // Admin controls inventory editing; staff encodes orders and customers
  $("addItemBtn").classList.toggle("hidden", !isAdmin);
  $("newMovementBtn").classList.toggle("hidden", !isAdmin);

  setView("inventory");
  loadAll();
}

function setView(view) {
  if (["users", "activity"].includes(view) && state.user?.role !== "admin") view = "inventory";
  state.view = view;
  document.querySelectorAll(".nav-link").forEach(b => b.classList.toggle("active", b.dataset.view === view));

  const isAdmin = state.user?.role === "admin";

  const viewMeta = {
    inventory: {
      title: "Inventory",
      eyebrow: "MATERIALS MANAGEMENT",
      subtitle: isAdmin ? "Track materials, stock levels, and edit inventory." : "Review materials and current stock levels (view-only for staff)."
    },
    "inventory-monitoring": {
      title: "Inventory Monitoring",
      eyebrow: "MASTERFILE REPORT",
      subtitle: "Review Masterfile item details and monitor current inventory, purchases, sales, damage, and returns."
    },
    transactions: {
      title: "Stock movements & deductions",
      eyebrow: "STOCK CONTROL",
      subtitle: "Track inventory additions, deductions from client orders, and manual adjustments."
    },
    purchases: {
      title: "Purchases and credit",
      eyebrow: "SUPPLIER MANAGEMENT",
      subtitle: "Record cash and credit purchases, supplier references, due dates, and payments."
    },
    losses: {
      title: "Damage and returns",
      eyebrow: "INVENTORY ADJUSTMENTS",
      subtitle: "Track damaged stock, returns to suppliers, and items returned by customers."
    },
    monthly: {
      title: "Monthly summary",
      eyebrow: "BUSINESS PERFORMANCE",
      subtitle: "Review monthly purchases, net sales, discounts, cost of goods sold, and gross profit."
    },
    orders: {
      title: "Client orders",
      eyebrow: "ORDER ENCODING",
      subtitle: "Encode and review client orders. Items ordered automatically deduct from inventory stock."
    },
    sales: {
      title: "Sales per day",
      eyebrow: "REVENUE & PERFORMANCE",
      subtitle: "Track daily sales volume, items deducted, and revenue totals."
    },
    customers: {
      title: "Customer database",
      eyebrow: "CUSTOMER DIRECTORY",
      subtitle: "Encode customer database, contact details, and site delivery information."
    },
    users: {
      title: "User management",
      eyebrow: "ADMINISTRATION",
      subtitle: "Create and manage staff and administrator accounts."
    },
    activity: {
      title: "Activity logs",
      eyebrow: "AUDIT TRAIL",
      subtitle: "Detailed audit trail of changes made across inventory, orders, and customer database."
    }
  }[view];

  $("crumbCurrent").textContent = viewMeta.title;
  $("pageTitle").textContent = viewMeta.title;
  $("pageEyebrow").textContent = viewMeta.eyebrow;
  $("pageSubtitle").textContent = viewMeta.subtitle;

  // Toggle heading action buttons
  $("addItemBtn").classList.toggle("hidden", view !== "inventory" || !isAdmin);
  $("pageNewOrderBtn").classList.toggle("hidden", view !== "orders");
  $("pageAddCustomerBtn").classList.toggle("hidden", view !== "customers");
  $("newPurchaseBtn").classList.toggle("hidden", view !== "purchases" || !isAdmin);
  $("newLossBtn").classList.toggle("hidden", view !== "losses" || !isAdmin);

  // Toggle stat cards
  $("statsGrid").classList.toggle("hidden", view !== "inventory");
  $("monitoringStatsGrid").classList.toggle("hidden", view !== "inventory-monitoring");
  $("salesStatsGrid").classList.toggle("hidden", view !== "sales");

  // Toggle main panels
  $("inventoryPanel").classList.toggle("hidden", view !== "inventory");
  $("inventoryMonitoringPanel").classList.toggle("hidden", view !== "inventory-monitoring");
  $("transactionsPanel").classList.toggle("hidden", view !== "transactions");
  $("purchasesPanel").classList.toggle("hidden", view !== "purchases");
  $("lossesPanel").classList.toggle("hidden", view !== "losses");
  $("monthlyPanel").classList.toggle("hidden", view !== "monthly");
  $("ordersPanel").classList.toggle("hidden", view !== "orders");
  $("salesPanel").classList.toggle("hidden", view !== "sales");
  $("customersPanel").classList.toggle("hidden", view !== "customers");
  $("usersPanel").classList.toggle("hidden", view !== "users");
  $("activityPanel").classList.toggle("hidden", view !== "activity");

  if (view === "inventory") renderItems();
  if (view === "inventory-monitoring") loadInventoryMonitoring();
  if (view === "transactions") loadTransactions();
  if (view === "purchases") loadPurchases();
  if (view === "losses") loadLosses();
  if (view === "monthly") loadMonthlySummary();
  if (view === "orders") loadOrders();
  if (view === "sales") loadSalesSummary();
  if (view === "customers") loadCustomers();
  if (view === "users") loadUsers();
  if (view === "activity") loadActivityLogs();
}

// EVENT LISTENERS
$("profileTrigger").addEventListener("click", () => {
  const isOpen = !$("profileDropdown").classList.contains("hidden");
  $("profileDropdown").classList.toggle("hidden", isOpen);
  $("profileTrigger").setAttribute("aria-expanded", String(!isOpen));
});

$("editProfileBtn").addEventListener("click", () => {
  closeProfileMenu();
  $("profileForm").reset();
  $("profileUsername").value = state.user.username;
  $("profileEmail").value = state.user.email;
  $("profilePhoneNumber").value = state.user.phone_number;
  $("profileDisplayName").value = state.user.display_name;
  $("profileError").textContent = "";
  openModal("profileModal");
});

$("profilePhoneNumber").addEventListener("input", e => {
  e.target.value = e.target.value.replace(/\D/g, "").slice(0, 11);
});

$("profileForm").addEventListener("submit", async event => {
  event.preventDefault();
  $("profileError").textContent = "";
  const button = $("saveProfileBtn");
  button.disabled = true;
  try {
    const result = await api("/api/auth/profile", {
      method: "PATCH",
      body: JSON.stringify({
        username: $("profileUsername").value,
        email: $("profileEmail").value,
        phone_number: $("profilePhoneNumber").value,
        display_name: $("profileDisplayName").value
      })
    });
    state.user = result.user;
    $("headerDisplayName").textContent = `${result.user.display_name} (${result.user.role === "admin" ? "Super Admin" : "Staff"})`;
    closeModal("profileModal");
    toast("Profile updated.");
  } catch (error) {
    if (error.status === 401) return window.location.replace("/");
    $("profileError").textContent = error.message;
  } finally {
    button.disabled = false;
  }
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
    if (error.status === 401) return window.location.replace("/");
    $("changePasswordError").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

// Inventory events
$("addItemBtn").addEventListener("click", () => { resetItemForm(); openModal("itemModal"); });
$("refreshBtn").addEventListener("click", loadAll);
$("refreshInventoryMonitoringBtn").addEventListener("click", loadInventoryMonitoring);
$("itemBeginInventory").addEventListener("input", updateItemAmountPreviews);
$("itemPrice").addEventListener("input", updateItemAmountPreviews);
$("itemSupplierCost").addEventListener("input", updateItemAmountPreviews);
$("itemQuantity").addEventListener("input", () => {
  if (!$("itemId").value) $("itemQuantity").dataset.manuallySet = "true";
});
$("monitoringSearchInput").addEventListener("input", () => resetTablePage("inventory-monitoring", renderInventoryMonitoring));
$("monitoringCategoryFilter").addEventListener("change", () => resetTablePage("inventory-monitoring", renderInventoryMonitoring));
$("monitoringStockFilter").addEventListener("change", () => resetTablePage("inventory-monitoring", renderInventoryMonitoring));
$("searchInput").addEventListener("input", () => resetTablePage("inventory", renderItems));
$("categoryFilter").addEventListener("change", () => resetTablePage("inventory", renderItems));
$("stockFilter").addEventListener("change", () => resetTablePage("inventory", renderItems));

$("inventoryBody").addEventListener("click", async e => {
  const button = e.target.closest("button[data-action]");
  if (!button) return;
  const item = state.items.find(x => String(x.id) === button.dataset.id);
  if (!item) return;

  if (button.dataset.action === "edit") return editItem(item);
  if (button.dataset.action === "add-stock") return openAddStockModal(item);
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

$("addStockQty").addEventListener("input", () => {
  const item = state.items.find(x => String(x.id) === $("addStockItemId").value);
  if (item) updateAddStockPreview(item);
});

$("addStockForm").addEventListener("submit", async event => {
  event.preventDefault();
  $("addStockError").textContent = "";
  const itemId = $("addStockItemId").value;
  const button = $("confirmAddStockBtn");
  button.disabled = true;
  try {
    await api(`/api/items/${encodeURIComponent(itemId)}/add-stock`, {
      method: "POST",
      body: JSON.stringify({
        added_quantity: $("addStockQty").value,
        note: $("addStockNote").value
      })
    });
    closeModal("addStockModal");
    toast("New stock added to the existing quantity.");
    await loadAll();
  } catch (error) {
    if (error.status === 401) return window.location.replace("/");
    $("addStockError").textContent = error.message;
  } finally {
    button.disabled = false;
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

function updatePurchaseFields() {
  const isCredit = $("purchaseType").value === "credit";
  $("purchasePaidField").classList.toggle("hidden", !isCredit);
  $("purchaseDueField").classList.toggle("hidden", !isCredit);
}

$("newPurchaseBtn").addEventListener("click", () => {
  $("purchaseForm").reset();
  $("purchaseItem").innerHTML = inventoryOptions();
  $("purchaseError").textContent = "";
  updatePurchaseFields();
  openModal("purchaseModal");
});

$("purchaseType").addEventListener("change", updatePurchaseFields);
$("purchaseItem").addEventListener("change", () => {
  const item = state.items.find(entry => String(entry.id) === $("purchaseItem").value);
  if (!item) return;
  $("purchaseSupplier").value = item.supplier || "";
  $("purchaseUnitCost").value = Number(item.supplier_cost || 0).toFixed(2);
});

$("purchaseForm").addEventListener("submit", async event => {
  event.preventDefault();
  $("purchaseError").textContent = "";
  const button = $("savePurchaseBtn");
  button.disabled = true;
  try {
    await api("/api/purchases", {
      method: "POST",
      body: JSON.stringify({
        item_id: $("purchaseItem").value,
        purchase_type: $("purchaseType").value,
        quantity: $("purchaseQuantity").value,
        unit_cost: $("purchaseUnitCost").value,
        supplier: $("purchaseSupplier").value,
        invoice_number: $("purchaseInvoice").value,
        amount_paid: $("purchaseType").value === "credit" ? $("purchasePaid").value || "0" : "0",
        due_date: $("purchaseType").value === "credit" ? $("purchaseDueDate").value : "",
        note: $("purchaseNote").value
      })
    });
    closeModal("purchaseModal");
    toast("Purchase recorded and stock updated.");
    await loadAll();
    await loadPurchases();
  } catch (error) {
    if (error.status === 401) return window.location.replace("/");
    $("purchaseError").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

$("purchasesBody").addEventListener("click", event => {
  const button = event.target.closest("[data-purchase-payment]");
  if (!button) return;
  state.purchaseToPay = state.purchases.find(purchase => String(purchase.id) === button.dataset.purchasePayment);
  if (!state.purchaseToPay) return;
  const balance = Number(state.purchaseToPay.total_amount) - Number(state.purchaseToPay.amount_paid);
  $("paymentForm").reset();
  $("paymentAmount").max = balance.toFixed(2);
  $("paymentBalanceText").textContent = `Remaining balance: ${money(balance)}`;
  $("paymentError").textContent = "";
  openModal("paymentModal");
});

$("paymentForm").addEventListener("submit", async event => {
  event.preventDefault();
  if (!state.purchaseToPay) return;
  const button = $("savePaymentBtn");
  button.disabled = true;
  $("paymentError").textContent = "";
  try {
    await api(`/api/purchases/${encodeURIComponent(state.purchaseToPay.id)}/payments`, {
      method: "POST",
      body: JSON.stringify({ amount: $("paymentAmount").value, note: $("paymentNote").value })
    });
    closeModal("paymentModal");
    state.purchaseToPay = null;
    toast("Credit payment recorded.");
    await loadPurchases();
  } catch (error) {
    if (error.status === 401) return window.location.replace("/");
    $("paymentError").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

$("newLossBtn").addEventListener("click", () => {
  $("lossForm").reset();
  $("lossItem").innerHTML = inventoryOptions();
  $("lossError").textContent = "";
  openModal("lossModal");
});

$("lossForm").addEventListener("submit", async event => {
  event.preventDefault();
  const button = $("saveLossBtn");
  button.disabled = true;
  $("lossError").textContent = "";
  try {
    await api("/api/damage-returns", {
      method: "POST",
      body: JSON.stringify({
        item_id: $("lossItem").value,
        type: $("lossType").value,
        quantity: $("lossQuantity").value,
        note: $("lossNote").value
      })
    });
    closeModal("lossModal");
    toast("Damage / return record saved and stock updated.");
    await loadAll();
    await loadLosses();
  } catch (error) {
    if (error.status === 401) return window.location.replace("/");
    $("lossError").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

$("itemForm").addEventListener("submit", async e => {
  e.preventDefault();
  $("itemError").textContent = "";
  const id = $("itemId").value;
  const payload = {
    item_number: $("itemNumber").value ? Number($("itemNumber").value) : null,
    name: $("itemName").value,
    category: $("itemCategory").value,
    description: $("itemDescription").value,
    supplier: $("itemSupplier").value,
    supplier_cost: $("itemSupplierCost").value,
    brand: $("itemBrand").value,
    variant: $("itemVariant").value,
    other_details: $("itemOtherDetails").value,
    sku: $("itemSku").value,
    unit: $("itemUnit").value,
    quantity: $("itemQuantity").value,
    unit_price: $("itemPrice").value,
    low_stock_threshold: $("itemThreshold").value,
    begin_inventory: $("itemBeginInventory").value,
    notes: $("itemNotes").value
  };
  try {
    await api(id ? `/api/items/${id}` : "/api/items", { method: id ? "PATCH" : "POST", body: JSON.stringify(payload) });
    closeModal("itemModal");
    toast(id ? "Item updated." : "Item added to inventory.");
    await loadAll();
  } catch (error) {
    $("itemError").textContent = error.message;
  }
});

// Stock Movements & Deductions events
$("newMovementBtn").addEventListener("click", () => {
  $("movementForm").reset();
  $("movementSearch").value = "";
  renderMovementOptions();
  $("movementError").textContent = "";
  openModal("movementModal");
});

$("movementSearch").addEventListener("input", renderMovementOptions);
$("movementDateSort").addEventListener("change", () => resetTablePage("transactions", renderTransactions));
$("movementTypeFilter").addEventListener("change", () => resetTablePage("transactions", renderTransactions));

$("movementForm").addEventListener("submit", async e => {
  e.preventDefault();
  $("movementError").textContent = "";
  try {
    await api("/api/transactions", {
      method: "POST",
      body: JSON.stringify({
        item_id: $("movementItem").value,
        type: $("movementType").value,
        quantity: $("movementQuantity").value,
        note: $("movementNote").value
      })
    });
    closeModal("movementModal");
    toast("Stock movement recorded.");
    await loadAll();
  } catch (error) {
    $("movementError").textContent = error.message;
  }
});

// Order Events
$("newOrderBtn").addEventListener("click", openOrderModal);
$("pageNewOrderBtn").addEventListener("click", openOrderModal);
$("orderClientSelect").addEventListener("change", onOrderClientSelected);
$("orderDiscount").addEventListener("input", updateOrderTotal);
$("orderClientPhone").addEventListener("input", e => {
  e.target.value = e.target.value.replace(/\D/g, "").slice(0, 11);
});

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
  $("orderConfirmClient").textContent = $("orderClientName").value.trim();
  $("orderConfirmItems").textContent = `${state.orderLines.length} item type${state.orderLines.length === 1 ? "" : "s"}`;
  $("orderConfirmTotal").textContent = $("orderTotal").textContent;
  const subtotal = Number($("orderSubtotal").textContent.replace(/[^\d.-]/g, ""));
  if (Number($("orderDiscount").value) > subtotal) {
    $("orderError").textContent = "Discount cannot be greater than the order subtotal.";
    return;
  }
  openModal("orderConfirmModal");
});

$("confirmOrderBtn").addEventListener("click", async () => {
  closeModal("orderConfirmModal");
  const button = $("saveOrderBtn");
  button.disabled = true;
  try {
    const order = await api("/api/orders", {
      method: "POST",
      body: JSON.stringify({
        client_name: $("orderClientName").value,
        client_email: $("orderClientEmail").value,
        client_phone: $("orderClientPhone").value,
        client_address: $("orderClientAddress").value,
        discount: $("orderDiscount").value,
        note: $("orderNote").value,
        items: state.orderLines.map(line => ({ item_id: line.itemId, quantity: line.quantity }))
      })
    });
    closeModal("orderModal");
    showOrderReceipt(order);
    toast("Order placed and stock deducted.");
    await loadAll();
  } catch (error) {
    if (error.status === 401) return window.location.replace("/");
    $("orderError").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

$("exportOrdersBtn").addEventListener("click", async () => {
  const button = $("exportOrdersBtn");
  button.disabled = true;
  try {
    const response = await fetch("/api/orders/export");
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      if (response.status === 401) return window.location.replace("/");
      throw new Error(data.error || `Export failed (${response.status})`);
    }
    const file = await response.blob();
    const url = URL.createObjectURL(file);
    const link = document.createElement("a");
    link.href = url;
    link.download = `orders-sales-${new Date().toISOString().slice(0, 10)}.xlsx`;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    toast("Orders and sales exported to Excel.");
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
});

// Sales per day events
$("refreshSalesBtn").addEventListener("click", loadSalesSummary);
$("summaryYear").addEventListener("change", loadMonthlySummary);

// Customer database events
$("addCustomerBtn").addEventListener("click", () => openCustomerModal());
$("pageAddCustomerBtn").addEventListener("click", () => openCustomerModal());
$("refreshCustomersBtn").addEventListener("click", loadCustomers);
$("customerSearchInput").addEventListener("input", () => resetTablePage("customers", renderCustomers));

$("custPhone").addEventListener("input", e => {
  e.target.value = e.target.value.replace(/\D/g, "").slice(0, 11);
});

$("customerForm").addEventListener("submit", async e => {
  e.preventDefault();
  $("customerError").textContent = "";
  const id = $("customerId").value;
  const button = $("saveCustomerBtn");
  button.disabled = true;
  try {
    await api(id ? `/api/customers/${encodeURIComponent(id)}` : "/api/customers", {
      method: id ? "PATCH" : "POST",
      body: JSON.stringify({
        name: $("custName").value,
        phone: $("custPhone").value,
        email: $("custEmail").value,
        address: $("custAddress").value,
        notes: $("custNotes").value
      })
    });
    closeModal("customerModal");
    toast(id ? "Customer details updated." : "Customer encoded into database.");
    await loadCustomers();
  } catch (error) {
    if (error.status === 401) return window.location.replace("/");
    $("customerError").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

$("customersBody").addEventListener("click", e => {
  const button = e.target.closest("button[data-customer-action]");
  if (!button) return;
  const customer = state.customers.find(c => String(c.id) === button.dataset.id);
  if (!customer) return;

  if (button.dataset.customerAction === "edit") {
    openCustomerModal(customer);
  } else if (button.dataset.customerAction === "history") {
    showCustomerPurchases(customer);
  } else if (button.dataset.customerAction === "delete") {
    state.customerToDelete = customer;
    $("deleteCustomerName").textContent = customer.name;
    openModal("customerDeleteModal");
  }
});

$("confirmCustomerDeleteBtn").addEventListener("click", async () => {
  const customer = state.customerToDelete;
  if (!customer) return;
  const button = $("confirmCustomerDeleteBtn");
  button.disabled = true;
  try {
    await api(`/api/customers/${encodeURIComponent(customer.id)}`, { method: "DELETE" });
    state.customerToDelete = null;
    closeModal("customerDeleteModal");
    toast("Customer removed from database.");
    await loadCustomers();
  } catch (error) {
    if (error.status === 401) return window.location.replace("/");
    toast(error.message);
  } finally {
    button.disabled = false;
  }
});

$("customerDeleteModal").addEventListener("click", e => {
  if (e.target.closest("[data-close='customerDeleteModal']")) state.customerToDelete = null;
});

// User Management Events (Admin)
$("addAccountBtn").addEventListener("click", () => openAccountModal());
$("userSort").addEventListener("change", () => resetTablePage("users", renderUsers));
$("accountPhoneNumber").addEventListener("input", e => {
  e.target.value = e.target.value.replace(/\D/g, "").slice(0, 11);
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
    if (error.status === 401) return window.location.replace("/");
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
    if (error.status === 401) return window.location.replace("/");
    toast(error.message);
  } finally {
    button.disabled = false;
  }
});

$("accountDeleteModal").addEventListener("click", event => {
  if (event.target.closest("[data-close='accountDeleteModal']")) state.userToDelete = null;
});

// Activity logs
$("refreshActivityBtn").addEventListener("click", loadActivityLogs);

// Receipt print
$("printReceiptBtn").addEventListener("click", () => {
  $("receiptModal").classList.add("receipt-print-target");
  document.body.classList.add("receipt-printing");
  window.print();
  window.setTimeout(() => {
    document.body.classList.remove("receipt-printing");
    $("receiptModal").classList.remove("receipt-print-target");
  }, 1000);
});

// Navigation & Generic modals
document.addEventListener("change", event => {
  const select = event.target.closest("[data-page-size]");
  if (!select) return;
  const container = select.closest(".table-pagination");
  const key = container?.id.replace("pagination-", "");
  if (!key) return;
  const current = state.pagination[key] || { page: 1, limit: 10 };
  state.pagination[key] = { page: 1, limit: Number(select.value) || current.limit };
  renderPage(key);
});

document.addEventListener("click", event => {
  const button = event.target.closest("[data-page-prev], [data-page-next]");
  if (!button || button.disabled) return;
  const container = button.closest(".table-pagination");
  const key = container?.id.replace("pagination-", "");
  if (!key) return;
  const current = state.pagination[key] || (state.pagination[key] = { page: 1, limit: 10 });
  current.page += button.hasAttribute("data-page-next") ? 1 : -1;
  renderPage(key);
});

document.querySelectorAll(".nav-link").forEach(b => b.addEventListener("click", () => {
  setView(b.dataset.view);
  $("sidebar").classList.remove("open");
}));

document.querySelectorAll("[data-close]").forEach(b => b.addEventListener("click", () => closeModal(b.dataset.close)));
document.querySelectorAll(".modal-backdrop").forEach(m => m.addEventListener("click", e => {
  if (e.target === m && m.id !== "deleteModal" && m.id !== "customerDeleteModal" && m.id !== "accountDeleteModal") closeModal(m.id);
}));

document.addEventListener("click", event => {
  if (!event.target.closest("#profileMenu")) closeProfileMenu();
});

document.addEventListener("keydown", e => {
  if (e.key === "Escape") {
    closeProfileMenu();
    state.itemToDelete = null;
    state.customerToDelete = null;
    document.querySelectorAll(".modal-backdrop").forEach(m => closeModal(m.id));
  }
});

$("menuToggle").addEventListener("click", () => {
  const isMobile = window.matchMedia("(max-width: 720px)").matches;
  const sidebar = $("sidebar");
  const isOpen = isMobile
    ? sidebar.classList.toggle("open")
    : $("appShell").classList.toggle("sidebar-collapsed");
  $("menuToggle").setAttribute("aria-expanded", String(isMobile ? isOpen : !isOpen));
});

// Init
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
    if (error.status === 401) return window.location.replace("/");
    $("connectionText").textContent = error.message;
  });
