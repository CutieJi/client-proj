const $ = (id) => document.getElementById(id);
const state = {
  items: [],
  inventoryMonitoring: [],
  inventoryMonitoringTotals: null,
  dashboardSummary: null,
  transactions: [],
  orders: [],
  salesTransactions: [],
  customers: [],
  purchases: [],
  losses: [],
  activityLogs: [],
  monthlySummary: [],
  monthlyClosings: [],
  users: [],
  salesSummary: null,
  user: null,
  view: "dashboard",
  purchaseType: "cash",
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
    damage: renderLosses,
    returns: renderLosses,
    monthly: renderMonthlySummary,
    orders: renderOrders,
    "sales-transactions": renderSalesTransactions,
    sales: renderDailySales,
    "sales-customers": renderDailySales,
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

function sortMaterialsAlphabetically(items) {
  return [...items].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
      || (a.variant || "").localeCompare(b.variant || "", undefined, { sensitivity: "base" })
  );
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

    if (state.view === "dashboard") await loadDashboard();
    if (state.view === "transactions") await loadTransactions();
    if (state.view === "purchases-direct" || state.view === "purchases-credit") await loadPurchases();
    if (state.view === "damage" || state.view === "returns") await loadLosses();
    if (state.view === "monthly") await loadMonthlySummary();
    if (state.view === "orders") await loadOrders();
    if (state.view === "sales-transactions") await loadSalesTransactions();
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
  renderItemCategoryOptions();
}

function renderItemCategoryOptions(selectedCategory = "") {
  const defaultCategories = [
    "Cement", "RSB", "Aggregates", "CHB", "Tubulars", "Plywood",
    "Adhesives / Skimcoat", "Paints", "Pipes & Fittings", "Electrical",
    "Hardware Items", "Other"
  ];
  const categories = [...new Set([
    ...state.items.map(item => item.category),
    selectedCategory,
    ...defaultCategories
  ].filter(category => typeof category === "string" && category.trim()))]
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  $("itemCategories").innerHTML = categories
    .map(category => `<option value="${esc(category)}"></option>`).join("");
}

async function loadDashboard() {
  const year = $("dashboardYear").value || String(new Date().getFullYear());
  $("dashboardDate").textContent = new Intl.DateTimeFormat("en-PH", { dateStyle: "long" }).format(new Date());
  $("dashboardError").textContent = "";
  try {
    const summary = await api(`/api/management-summary?year=${encodeURIComponent(year)}`);
    state.dashboardSummary = summary;
    renderDashboard();
  } catch (error) {
    if (error.status === 401) return window.location.replace("/");
    $("dashboardError").textContent = error.message;
  }
}

function renderDashboard() {
  const months = state.dashboardSummary?.months || [];
  const items = state.items;
  const totalQuantity = items.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
  const retailAmount = items.reduce((sum, item) => sum + Number(item.quantity || 0) * Number(item.unit_price || 0), 0);
  const costValue = items.reduce((sum, item) => sum + Number(item.quantity || 0) * Number(item.supplier_cost || 0), 0);
  const totals = months.reduce((all, month) => ({
    sales: all.sales + Number(month.sales || 0),
    cogs: all.cogs + Number(month.costOfGoodsSold || 0),
    profit: all.profit + Number(month.grossProfit || 0),
    cash: all.cash + Number(month.cashPurchases || 0),
    credit: all.credit + Number(month.creditPurchases || 0)
  }), { sales: 0, cogs: 0, profit: 0, cash: 0, credit: 0 });

  $("dashboardRetailAmount").textContent = money(retailAmount);
  $("dashboardStockUnits").textContent = totalQuantity.toLocaleString("en-PH");
  $("dashboardCostValue").textContent = money(costValue);
  $("dashboardSales").textContent = money(totals.sales);
  $("dashboardCogs").textContent = money(totals.cogs);
  $("dashboardProfit").textContent = money(totals.profit);
  $("dashboardCashPurchases").textContent = money(totals.cash);
  $("dashboardCreditPurchases").textContent = money(totals.credit);

  const monthNames = Array.from({ length: 12 }, (_, index) =>
    new Intl.DateTimeFormat("en", { month: "short", timeZone: "UTC" }).format(new Date(Date.UTC(2020, index, 1))));
  const selectedMonth = Number($("dashboardMonth").value) || new Date().getMonth() + 1;
  const monthSummary = months.find(month => Number(month.month) === selectedMonth) || {};
  const monthlyRows = [
    ["Sales", money(monthSummary.sales || 0)],
    ["Cost of Good Sold", money(monthSummary.costOfGoodsSold || 0)],
    ["Gross Profit", money(monthSummary.grossProfit || 0)],
    ["Cash Purchases", money(monthSummary.cashPurchases || 0)],
    ["Credit Purchases", money(monthSummary.creditPurchases || 0)],
    ["Credit Payments", money(monthSummary.creditPayments || 0)],
    ["Items Sold", Number(monthSummary.salesQty || 0).toLocaleString("en-PH")]
  ];
  $("dashboardMonthlySummary").innerHTML = monthlyRows.map(([label, value]) =>
    `<div class="dashboard-summary-row"><span>${label}</span><strong>${value}</strong></div>`).join("");

  const maxSales = Math.max(0, ...months.map(month => Number(month.sales || 0)));
  $("dashboardMonthChart").innerHTML = months.map(month => {
    const sales = Number(month.sales || 0);
    const width = maxSales > 0 ? Math.max(sales > 0 ? 2 : 0, sales / maxSales * 100) : 0;
    return `<div class="dashboard-month-row"><span>${monthNames[month.month - 1]}</span><div class="dashboard-bar-track"><i style="width:${width}%"></i></div><strong>${money(sales)}</strong></div>`;
  }).join("");

  const topMonths = [...months].filter(month => Number(month.sales || 0) > 0)
    .sort((a, b) => Number(b.sales || 0) - Number(a.sales || 0)).slice(0, 3);
  $("dashboardTopMonths").innerHTML = topMonths.length ? topMonths.map((month, index) =>
    `<div class="dashboard-rank-row"><span class="dashboard-rank">${index + 1}</span><strong>${monthNames[month.month - 1]}</strong><span>${money(month.sales)}</span></div>`
  ).join("") : `<p class="dashboard-empty">No monthly sales recorded for ${esc($("dashboardYear").value)}.</p>`;

  const topSellers = state.dashboardSummary?.topSellers || [];
  $("dashboardBestSellers").innerHTML = topSellers.length
    ? topSellers.map((item, index) => `<div class="dashboard-rank-row"><span class="dashboard-rank">${index + 1}</span><strong>${esc(item.name)}</strong><span>${Number(item.quantity).toLocaleString("en-PH")} sold</span></div>`).join("")
    : `<p class="dashboard-empty">No sales recorded for ${esc($("dashboardYear").value)}.</p>`;

  const itemFilter = $("dashboardItemFilter");
  const selectedItemId = itemFilter.value || "all";
  const sortedItems = [...items].sort((a, b) => {
    const aNumber = Number(a.item_number) || Number.MAX_SAFE_INTEGER;
    const bNumber = Number(b.item_number) || Number.MAX_SAFE_INTEGER;
    return aNumber - bNumber || a.name.localeCompare(b.name);
  });
  itemFilter.innerHTML = `<option value="all">Select an item</option>${sortMaterialsAlphabetically(items).map(item =>
    `<option value="${esc(item.id)}">${esc(item.item_number ? `${item.item_number} · ` : "")}${esc(item.name)}</option>`
  ).join("")}`;
  itemFilter.value = items.some(item => String(item.id) === selectedItemId) ? selectedItemId : "all";
  const currentItem = items.find(item => String(item.id) === itemFilter.value);
  $("dashboardItemSummary").innerHTML = currentItem
    ? `<div class="dashboard-summary-row"><span>Category / SKU</span><strong>${esc(currentItem.category)} · ${esc(currentItem.sku || "—")}</strong></div>
       <div class="dashboard-summary-row"><span>Current Quantity</span><strong>${Number(currentItem.quantity || 0).toLocaleString("en-PH")} ${esc(currentItem.unit)}</strong></div>
       <div class="dashboard-summary-row"><span>Retail Inventory Amount</span><strong>${money(Number(currentItem.quantity || 0) * Number(currentItem.unit_price || 0))}</strong></div>
       <div class="dashboard-summary-row"><span>Inventory Cost Value</span><strong>${money(Number(currentItem.quantity || 0) * Number(currentItem.supplier_cost || 0))}</strong></div>`
    : `<p class="dashboard-empty">Choose an item to view its current inventory summary.</p>`;
  const currentItems = sortedItems;
  $("dashboardCurrentInventory").innerHTML = currentItems.length
    ? currentItems.map(item => `<div class="dashboard-inventory-row"><span><strong>${esc(item.name)}</strong><small>${esc(item.category)}</small></span><b>${Number(item.quantity || 0).toLocaleString("en-PH")} ${esc(item.unit)}</b></div>`).join("")
    : `<p class="dashboard-empty">No inventory items.</p>`;
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
  renderItemCategoryOptions();
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
  renderItemCategoryOptions(item.category);
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
    sortMaterialsAlphabetically(matches).map(item => `<option value="${esc(item.id)}">${esc(item.name)}${item.brand ? " · " + esc(item.brand) : ""}${item.variant ? " · " + esc(item.variant) : ""} (stock: ${Number(item.quantity)})</option>`).join("");
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
  return `<option value="">Select a material</option>` + sortMaterialsAlphabetically(state.items).map(item =>
    `<option value="${esc(item.id)}"${String(item.id) === String(selectedId) ? " selected" : ""}>${esc(item.name)}${item.variant ? ` · ${esc(item.variant)}` : ""} (stock: ${Number(item.quantity).toLocaleString("en-PH")} ${esc(item.unit)})</option>`
  ).join("");
}

async function loadPurchases() {
  try {
    state.purchases = await api("/api/purchases");
    renderPurchases();
  } catch (error) {
    if (error.status === 401) return window.location.replace("/");
    $("purchasesBody").innerHTML = `<tr><td colspan="${state.view === "purchases-credit" ? 16 : 9}" class="empty-cell">${esc(error.message)}</td></tr>`;
    $("purchaseCount").textContent = "Unable to load";
  }
}

function renderPurchases() {
  const isCredit = state.view === "purchases-credit";
  const type = isCredit ? "credit" : "cash";
  const month = Number($("purchaseMonth").value) || new Date().getMonth() + 1;
  const year = Number($("purchaseYear").value) || new Date().getFullYear();
  const allRows = state.purchases.filter(purchase => {
    const purchaseType = purchase.purchase_type || (purchase.type === "purchase_credit" ? "credit" : "cash");
    const created = new Date(purchase.created_at);
    return purchaseType === type && created.getUTCFullYear() === year && created.getUTCMonth() + 1 === month;
  });
  const visibleRows = pageRows("purchases", allRows);
  const isAdmin = state.user?.role === "admin";
  const amount = allRows.reduce((sum, purchase) => sum + Number(purchase.total_amount || 0), 0);
  const quantity = allRows.reduce((sum, purchase) => sum + Number(purchase.quantity || 0), 0);
  const paid = allRows.reduce((sum, purchase) => sum + Number(purchase.amount_paid || 0), 0);
  const balance = Math.max(0, amount - paid);
  const monthName = new Intl.DateTimeFormat("en", { month: "long", timeZone: "UTC" })
    .format(new Date(Date.UTC(year, month - 1, 1)));

  $("purchasesTitle").textContent = isCredit ? "Credit Purchase Transaction" : "Direct Purchase Transaction";
  $("purchasesDescription").textContent = isCredit
    ? `${monthName} ${year} supplier credit purchases, due dates, payments, and remaining balances.`
    : `${monthName} ${year} direct purchases, matching the workbook's purchase transaction columns.`;
  $("newPurchaseBtn").textContent = `＋ Record ${isCredit ? "credit" : "direct"} purchase`;
  $("purchasesTable").classList.toggle("purchases-credit-table", isCredit);
  $("purchasesTable").classList.toggle("purchases-direct-table", !isCredit);
  $("purchaseTotalLabel").textContent = isCredit ? "Total credit purchased" : "Total purchased";
  $("purchaseTotalAmount").textContent = money(amount);
  $("purchaseTotalQuantity").textContent = quantity.toLocaleString("en-PH");
  $("purchasePaidCard").classList.toggle("hidden", !isCredit);
  $("purchaseBalanceCard").classList.toggle("hidden", !isCredit);
  $("purchasePaidAmount").textContent = money(paid);
  $("purchaseBalanceAmount").textContent = money(balance);

  $("purchasesTableHead").innerHTML = (isCredit
    ? ["Product SKU/no#", "Date", "Items", "Category", "Description", "Supplier cost", "Selling price", "Invoice#", "Due date", "Paid status", "Quantity", "Amount to pay", "Payments", "Paid amount", "Balance", "Action"]
    : ["Product SKU/no#", "Date", "Items", "Category", "Description", "Supplier cost", "Selling price", "Quantity", "Purchased amount"]
  ).map(label => `<th>${label}</th>`).join("");
  $("purchasesBody").innerHTML = allRows.length ? visibleRows.map(purchase => {
    const item = purchase.inventory_items || {};
    const amountPaid = Number(purchase.amount_paid || 0);
    const remaining = Math.max(0, Number(purchase.total_amount || 0) - amountPaid);
    const payments = purchase.inventory_purchase_payments || [];
    const status = remaining <= 0 ? "Paid"
      : amountPaid > 0 ? "Partially paid"
        : purchase.due_date && new Date(`${purchase.due_date}T00:00:00Z`) < new Date() ? "Overdue" : "Unpaid";
    const columns = [
      `<td>${esc(item.sku || item.item_number || "—")}</td>`,
      `<td>${esc(dateOnly(purchase.created_at))}</td>`,
      `<td><div class="material-name">${esc(item.name || "Deleted item")}</div></td>`,
      `<td>${esc(item.category || "—")}</td>`,
      `<td>${esc(item.description || "—")}</td>`,
      `<td class="price-cell">${money(purchase.unit_cost)}</td>`,
      `<td class="price-cell">${money(item.unit_price)}</td>`
    ];
    if (isCredit) {
      columns.push(
        `<td>${esc(purchase.invoice_number || "—")}</td>`,
        `<td>${esc(purchase.due_date ? dateOnly(purchase.due_date) : "—")}</td>`,
        `<td><span class="category-pill purchase-status-${status.toLowerCase().replaceAll(" ", "-")}">${status}</span></td>`,
        `<td class="quantity-cell">${Number(purchase.quantity).toLocaleString("en-PH")} ${esc(item.unit || "")}</td>`,
        `<td class="price-cell">${money(purchase.total_amount)}</td>`,
        `<td>${payments.length}</td>`,
        `<td class="price-cell">${money(amountPaid)}</td>`,
        `<td class="price-cell">${money(remaining)}</td>`,
        `<td>${isAdmin && remaining > 0 ? `<button class="small-action" data-purchase-payment="${esc(purchase.id)}">Record payment</button>` : "—"}</td>`
      );
    } else {
      columns.push(
        `<td class="quantity-cell">${Number(purchase.quantity).toLocaleString("en-PH")} ${esc(item.unit || "")}</td>`,
        `<td class="price-cell">${money(purchase.total_amount)}</td>`
      );
    }
    return `<tr>${columns.join("")}</tr>`;
  }).join("") : `<tr><td colspan="${isCredit ? 16 : 9}" class="empty-cell">No ${isCredit ? "credit" : "direct"} purchases recorded for ${esc(monthName)} ${year}.</td></tr>`;
  $("purchaseCount").textContent = `Showing ${allRows.length} ${isCredit ? "credit" : "direct"} purchase records`;
}

async function loadLosses() {
  try {
    state.losses = await api("/api/damage-returns");
    renderLosses();
  } catch (error) {
    if (error.status === 401) return window.location.replace("/");
    const isReturns = state.view === "returns";
    $(`${isReturns ? "returns" : "damage"}Body`).innerHTML = `<tr><td colspan="${isReturns ? 12 : 11}" class="empty-cell">${esc(error.message)}</td></tr>`;
    $(`${isReturns ? "returns" : "damage"}Count`).textContent = "Unable to load";
  }
}

function renderLosses() {
  const isReturns = state.view === "returns";
  const month = Number($("lossMonth").value) || new Date().getMonth() + 1;
  const year = Number($("lossYear").value) || new Date().getFullYear();
  const records = state.losses.filter(event => {
    const created = new Date(event.created_at);
    const isReturn = event.type === "customer_return" || event.type === "supplier_return";
    return isReturn === isReturns
      && created.getUTCFullYear() === year
      && created.getUTCMonth() + 1 === month;
  });
  const visibleRows = pageRows(isReturns ? "returns" : "damage", records);
  const quantity = records.reduce((sum, event) => sum + Number(event.quantity || 0), 0);
  const supplierCost = records.reduce((sum, event) => sum + Number(event.total_amount || 0), 0);
  const returnValue = records.reduce((sum, event) =>
    sum + Number(event.quantity || 0) * Number(event.inventory_items?.unit_price || 0), 0);
  const monthName = new Intl.DateTimeFormat("en", { month: "long", timeZone: "UTC" })
    .format(new Date(Date.UTC(year, month - 1, 1)));

  $("lossAmountLabel").textContent = isReturns ? "Total returns" : "Total damage items";
  $("lossQuantityLabel").textContent = isReturns ? "Returned quantity" : "Quantity damaged";
  $("lossTotalAmount").textContent = money(isReturns ? returnValue : supplierCost);
  $("lossTotalQuantity").textContent = quantity.toLocaleString("en-PH");
  $("lossSupplierCostCard").classList.toggle("hidden", !isReturns);
  $("lossSupplierCostAmount").textContent = money(supplierCost);
  $("newLossBtn").textContent = `＋ Record ${isReturns ? "return" : "damage"}`;
  $("damageDescription").textContent = `${monthName} ${year} damaged stock records, matching the workbook columns.`;
  $("returnsDescription").textContent = `${monthName} ${year} customer and supplier returns, matching the workbook columns.`;

  const body = $(`${isReturns ? "returns" : "damage"}Body`);
  const count = $(`${isReturns ? "returns" : "damage"}Count`);
  body.innerHTML = records.length ? visibleRows.map(event => {
    const item = event.inventory_items || {};
    const amount = isReturns ? Number(event.quantity || 0) * Number(item.unit_price || 0) : Number(event.total_amount || 0);
    const columns = [
      `<td>${esc(item.sku || item.item_number || "—")}</td>`,
      `<td>${esc(dateOnly(event.created_at))}</td>`,
      `<td><div class="material-name">${esc(item.name || "Deleted item")}</div></td>`,
      `<td>${esc(item.category || "—")}</td>`,
      `<td>${esc(item.description || "—")}</td>`
    ];
    if (isReturns) {
      columns.push(`<td><span class="category-pill">${event.type === "supplier_return" ? "Supplier return" : "Customer return"}</span></td>`);
    }
    columns.push(
      `<td class="price-cell">${money(event.unit_cost)}</td>`,
      `<td class="price-cell">${money(item.unit_price)}</td>`,
      `<td class="quantity-cell">${Number(event.quantity).toLocaleString("en-PH")} ${esc(item.unit || "")}</td>`,
      `<td class="price-cell">${money(amount)}</td>`,
      `<td class="quantity-cell">${Number(event.balance_after).toLocaleString("en-PH")}</td>`,
      `<td>${esc(event.note || "—")}</td>`
    );
    return `<tr>${columns.join("")}</tr>`;
  }).join("") : `<tr><td colspan="${isReturns ? 12 : 11}" class="empty-cell">No ${isReturns ? "return" : "damage"} records for ${esc(monthName)} ${year}.</td></tr>`;
  count.textContent = `Showing ${records.length} ${isReturns ? "return" : "damage"} records`;
}

async function loadMonthlySummary() {
  $("monthlyClosingsError").textContent = "";
  $("monthlySummaryError").textContent = "";
  try {
    const year = $("summaryYear").value || String(new Date().getFullYear());
    const [summary, closings] = await Promise.all([
      api(`/api/management-summary?year=${encodeURIComponent(year)}`),
      api(`/api/monthly-inventory-closings?year=${encodeURIComponent(year)}`)
    ]);
    state.monthlySummary = summary.months;
    state.monthlyClosings = closings;
    renderMonthlySummary();
  } catch (error) {
    if (error.status === 401) return window.location.replace("/");
    $("monthlySummaryError").textContent = error.message;
    $("monthlySummaryBody").innerHTML = `<tr><td colspan="14" class="empty-cell">${esc(error.message)}</td></tr>`;
    $("monthlyClosingsBody").innerHTML = `<tr><td colspan="5" class="empty-cell">Unable to load ending inventory records.</td></tr>`;
  }
}

function renderMonthlySummary() {
  const resultYear = Number($("summaryYear").value || new Date().getFullYear());
  const months = state.monthlySummary || [];
  const monthNames = new Intl.DateTimeFormat("en", { month: "long", timeZone: "UTC" });
  const monthRows = Array.from({ length: 12 }, (_, index) =>
    months.find(entry => Number(entry.month) === index + 1) || { month: index + 1 });
  const quantity = value => Number(value || 0).toLocaleString("en-PH");
  $("monthlySummaryBody").innerHTML = monthRows.map(entry => `<tr>
    <td><strong>${monthNames.format(new Date(Date.UTC(resultYear, entry.month - 1, 1)))}</strong></td>
    <td class="quantity-cell">${quantity(entry.cashPurchaseQty)}</td><td class="price-cell">${money(entry.cashPurchases)}</td>
    <td class="quantity-cell">${quantity(entry.creditPurchaseQty)}</td><td class="price-cell">${money(entry.creditPurchases)}</td>
    <td class="quantity-cell">${quantity(entry.salesQty)}</td><td class="price-cell">${money(entry.sales)}</td>
    <td class="quantity-cell">${quantity(entry.salesQty)}</td><td class="price-cell">${money(entry.costOfGoodsSold)}</td>
    <td class="price-cell">${money(entry.grossProfit)}</td>
    <td class="quantity-cell">${quantity(entry.returnsQty)}</td><td class="price-cell">${money(entry.returnsAmount)}</td>
    <td class="quantity-cell">${quantity(entry.damagedQty)}</td><td class="price-cell">${money(entry.damageAmount)}</td>
  </tr>`).join("");

  const total = monthRows.reduce((totals, entry) => {
    for (const key of ["cashPurchaseQty", "cashPurchases", "creditPurchaseQty", "creditPurchases",
      "salesQty", "sales", "costOfGoodsSold", "grossProfit", "returnsQty", "returnsAmount", "damagedQty", "damageAmount"]) {
      totals[key] += Number(entry[key] || 0);
    }
    return totals;
  }, { cashPurchaseQty: 0, cashPurchases: 0, creditPurchaseQty: 0, creditPurchases: 0, salesQty: 0,
    sales: 0, costOfGoodsSold: 0, grossProfit: 0, returnsQty: 0, returnsAmount: 0, damagedQty: 0, damageAmount: 0 });
  $("monthlySummaryTotals").innerHTML = `<tr>
    <th>Total</th>
    <th>${quantity(total.cashPurchaseQty)}</th><th>${money(total.cashPurchases)}</th>
    <th>${quantity(total.creditPurchaseQty)}</th><th>${money(total.creditPurchases)}</th>
    <th>${quantity(total.salesQty)}</th><th>${money(total.sales)}</th>
    <th>${quantity(total.salesQty)}</th><th>${money(total.costOfGoodsSold)}</th>
    <th>${money(total.grossProfit)}</th>
    <th>${quantity(total.returnsQty)}</th><th>${money(total.returnsAmount)}</th>
    <th>${quantity(total.damagedQty)}</th><th>${money(total.damageAmount)}</th>
  </tr>`;
  renderMonthlyClosings(resultYear, monthNames);
}

function renderMonthlyClosings(year, monthNames) {
  const isAdmin = state.user?.role === "admin";
  const closings = new Map((state.monthlyClosings || []).map(entry => [Number(entry.month), entry]));
  $("monthlyClosingsBody").innerHTML = Array.from({ length: 12 }, (_, index) => {
    const month = index + 1;
    const closing = closings.get(month);
    const label = monthNames.format(new Date(Date.UTC(year, index, 1)));
    if (!isAdmin) {
      return `<tr><td><strong>${label}</strong></td><td data-label="Ending date">${closing ? esc(closing.ending_date) : "—"}</td>
        <td class="price-cell" data-label="Ending amount">${closing ? money(closing.ending_amount) : "—"}</td>
        <td class="quantity-cell" data-label="Ending quantity">${closing ? Number(closing.ending_quantity).toLocaleString("en-PH") : "—"}</td>
        <td data-label="Action">—</td></tr>`;
    }
    return `<tr data-closing-month="${month}">
      <td><strong>${label}</strong></td>
      <td data-label="Ending date"><input data-closing-date type="date" aria-label="${label} ending date" value="${esc(closing?.ending_date || "")}"></td>
      <td data-label="Ending amount"><input data-closing-amount type="number" min="0" max="9999999999.99" step="0.01" aria-label="${label} ending amount" value="${closing ? esc(closing.ending_amount) : ""}"></td>
      <td data-label="Ending quantity"><input data-closing-quantity type="number" min="0" max="9999999999.99" step="0.01" aria-label="${label} ending quantity" value="${closing ? esc(closing.ending_quantity) : ""}"></td>
      <td class="monthly-closing-actions" data-label="Action">
        <button type="button" class="small-action" data-closing-save>Save</button>
        ${closing ? `<button type="button" class="small-action" data-closing-clear>Clear</button>` : ""}
        <span data-closing-status role="status"></span>
      </td>
    </tr>`;
  }).join("");
}

async function saveMonthlyClosing(row, button) {
  const year = Number($("summaryYear").value);
  const month = Number(row.dataset.closingMonth);
  const endingDate = row.querySelector("[data-closing-date]").value;
  const endingAmount = row.querySelector("[data-closing-amount]").value;
  const endingQuantity = row.querySelector("[data-closing-quantity]").value;
  if (!endingDate || endingAmount === "" || endingQuantity === "") {
    $("monthlyClosingsError").textContent = "Enter the ending date, amount, and quantity before saving.";
    return;
  }
  $("monthlyClosingsError").textContent = "";
  button.disabled = true;
  try {
    const saved = await api("/api/monthly-inventory-closings", {
      method: "POST",
      body: JSON.stringify({
        year,
        month,
        ending_date: endingDate,
        ending_amount: endingAmount,
        ending_quantity: endingQuantity
      })
    });
    state.monthlyClosings = [
      ...(state.monthlyClosings || []).filter(entry => Number(entry.month) !== month),
      saved
    ];
    renderMonthlySummary();
    toast("Ending inventory saved.");
  } catch (error) {
    if (error.status === 401) return window.location.replace("/");
    $("monthlyClosingsError").textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function clearMonthlyClosing(row, button) {
  const year = Number($("summaryYear").value);
  const month = Number(row.dataset.closingMonth);
  $("monthlyClosingsError").textContent = "";
  button.disabled = true;
  try {
    await api(`/api/monthly-inventory-closings/${year}/${month}`, { method: "DELETE" });
    state.monthlyClosings = (state.monthlyClosings || []).filter(entry => Number(entry.month) !== month);
    renderMonthlySummary();
    toast("Ending inventory cleared.");
  } catch (error) {
    if (error.status === 401) return window.location.replace("/");
    $("monthlyClosingsError").textContent = error.message;
  } finally {
    button.disabled = false;
  }
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
    const options = sortMaterialsAlphabetically(state.items).map(item => `<option value="${esc(item.id)}"${String(item.id) === line.itemId ? " selected" : ""}${Number(item.quantity) <= 0 && String(item.id) !== line.itemId ? " disabled" : ""}>${esc(item.name)}${item.variant ? ` · ${esc(item.variant)}` : ""} (stock: ${Number(item.quantity).toLocaleString("en-PH")})</option>`).join("");
    const quantityMax = selectedItem ? `max="${Number(selectedItem.quantity)}"` : "";
    return `<div class="order-line" data-order-line="${line.id}">
      <label class="field"><span class="field-label">Material <span class="required-mark">*</span></span><select data-order-item required>
        <option value="">${state.items.length ? "Select a material" : "No inventory items available"}</option>${options}
      </select></label>
      <label class="field"><span class="field-label">Quantity <span class="required-mark">*</span></span><input data-order-quantity type="number" min="0.01" step="0.01" ${quantityMax} value="${esc(line.quantity)}" required></label>
      <button class="icon-button order-line-remove" type="button" data-order-remove aria-label="Remove item" ${state.orderLines.length === 1 ? "disabled" : ""}>×</button>
    </div>`;
  }).join("") : `<p class="order-lines-empty">Add at least one material to this order.</p>`;
  updateOrderTotal();
}

async function loadSalesTransactions() {
  const year = $("salesTransactionYear").value || String(new Date().getFullYear());
  $("salesTransactionsError").textContent = "";
  try {
    const data = await api(`/api/sales-transactions?year=${encodeURIComponent(year)}`);
    state.salesTransactions = data.months || [];
    renderSalesTransactions();
  } catch (error) {
    if (error.status === 401) return window.location.replace("/");
    state.salesTransactions = [];
    renderSalesTransactions();
    $("salesTransactionsError").textContent = error.message;
  }
}

function renderSalesTransactions() {
  const monthNumber = Number($("salesTransactionMonth").value) || new Date().getMonth() + 1;
  const month = (state.salesTransactions || []).find(entry => entry.month === monthNumber)
    || { month: monthNumber, rows: [], summary: {} };
  const label = new Intl.DateTimeFormat("en", { month: "long", timeZone: "UTC" })
    .format(new Date(Date.UTC(2020, month.month - 1, 1)));
  const rows = month.rows || [];
  const totals = month.summary || {};
  $("salesTransactionQty").textContent = Number(totals.quantity || 0).toLocaleString("en-PH");
  $("salesTransactionAmount").textContent = money(totals.retailSales ?? totals.sales);
  $("salesTransactionCogs").textContent = money(totals.costOfGoodsSold);
  $("salesTransactionProfit").textContent = money(totals.profit);
  $("salesTransactionsHeading").textContent = `${label} ${$("salesTransactionYear").value} sales transactions, matching the workbook. Client orders automatically appear here.`;
  $("salesTransactionsMonths").innerHTML = `<section class="sales-month-section">
    <header class="sales-month-heading">
      <div><p>JIJ Constructions · Materials Trading</p><h3>${label} Sales Transaction</h3></div>
      <span>${esc($("salesTransactionYear").value)}</span>
    </header>
    <div class="sales-month-total"><strong>TOTAL SALES AND QUANTITY SOLD</strong><span>${money(totals.sales)}</span><span>${Number(totals.quantity || 0).toLocaleString("en-PH")}</span></div>
    <div class="table-wrap">
      <table class="sales-transactions-table">
        <thead><tr>
          <th>Product Sku/no#</th><th>Date</th><th>Items</th><th>Category</th><th>Description</th>
          <th>Supplier Cost</th><th>Selling price</th><th>Customers</th><th>Quantity</th><th>Discount</th>
          <th>Sales amount</th><th>Cost of Good Sold</th><th>Profit</th>
        </tr></thead>
        <tbody id="salesTransactionsBody"></tbody>
      </table>
    </div>
    <div class="table-pagination" id="pagination-sales-transactions"></div>
  </section>`;
  const visibleRows = pageRows("sales-transactions", rows);
  const renderedRows = rows.length ? visibleRows.map(row => `<tr>
      <td>${esc(row.sku || row.item_number || "—")}</td>
      <td>${esc(dateOnly(row.date))}</td>
      <td><strong>${esc(row.item_name)}</strong></td>
      <td>${esc(row.category || "—")}</td>
      <td>${esc(row.description || "—")}</td>
      <td class="price-cell">${money(row.supplier_cost)}</td>
      <td class="price-cell">${money(row.selling_price)}</td>
      <td>${esc(row.customer)}</td>
      <td class="quantity-cell">${Number(row.quantity).toLocaleString("en-PH")} ${esc(row.unit || "")}</td>
      <td class="price-cell">${money(row.discount)}</td>
      <td class="price-cell"><strong>${money(row.sales_amount)}</strong></td>
      <td class="price-cell">${money(row.cost_of_goods_sold)}</td>
      <td class="price-cell"><strong>${money(row.profit)}</strong></td>
    </tr>`).join("") : `<tr><td colspan="13" class="empty-cell">No sales transactions recorded for ${label}. Record a client order to add sales.</td></tr>`;
  $("salesTransactionsBody").innerHTML = renderedRows;
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
  const year = $("salesYear").value || String(new Date().getFullYear());
  const month = $("salesMonth").value || String(new Date().getMonth() + 1);
  $("salesError").textContent = "";
  try {
    const data = await api(`/api/sales-summary?year=${encodeURIComponent(year)}&month=${encodeURIComponent(month)}`);
    state.salesSummary = data;
    renderDailySales();
  } catch (error) {
    if (error.status === 401) return window.location.replace("/");
    state.salesSummary = null;
    renderDailySales();
    $("salesError").textContent = error.message;
  }
}

function renderDailySales() {
  const data = state.salesSummary || {};
  const totals = data.totals || {};
  const dailyRows = data.daily || [];
  const customerRows = data.customers || [];
  const month = Number($("salesMonth").value) || new Date().getMonth() + 1;
  const year = Number($("salesYear").value) || new Date().getFullYear();
  const monthName = new Intl.DateTimeFormat("en", { month: "long", timeZone: "UTC" })
    .format(new Date(Date.UTC(year, month - 1, 1)));
  const percent = value => `${Number(value || 0).toFixed(2)}%`;

  $("salesTotalRevenue").textContent = money(totals.sales);
  $("salesTotalItems").textContent = Number(totals.quantity || 0).toLocaleString("en-PH");
  $("salesTotalCost").textContent = money(totals.costOfGoodsSold);
  $("salesGrossProfit").textContent = money(totals.grossProfit);
  $("salesTotalDiscounts").textContent = money(totals.discounts);
  $("salesDiscountRate").textContent = percent(totals.discountRate);
  $("salesCustomerTrackerHeading").textContent = `${monthName} ${year} Customer Tracker`;

  const visibleDays = pageRows("sales", dailyRows);
  $("dailySalesBody").innerHTML = dailyRows.length ? visibleDays.map(row => `<tr>
    <td><strong>${esc(dateOnly(row.date))}</strong></td>
    <td>${row.manualEntries
      ? (row.orders ? "Client orders + manual sales" : "Manual sales")
      : row.orders ? "Client orders" : "—"}</td>
    <td class="price-cell"><strong>${money(row.sales)}</strong></td>
    <td class="quantity-cell">${Number(row.quantity || 0).toLocaleString("en-PH")}</td>
    <td class="price-cell">${money(row.costOfGoodsSold)}</td>
    <td class="price-cell"><strong>${money(row.grossProfit)}</strong></td>
    <td class="price-cell">${money(row.discounts)}</td>
    <td>${percent(row.discountRate)}</td>
  </tr>`).join("") : `<tr><td colspan="8" class="empty-cell">No daily sales data is available for ${esc(monthName)} ${year}.</td></tr>`;

  const visibleCustomers = pageRows("sales-customers", customerRows);
  $("monthlyCustomersBody").innerHTML = customerRows.length ? visibleCustomers.map(row => `<tr>
    <td><strong>${esc(row.customer)}</strong></td>
    <td class="quantity-cell">${Number(row.quantity || 0).toLocaleString("en-PH")}</td>
    <td class="price-cell">${money(row.sales)}</td>
    <td class="price-cell">${money(row.costOfGoodsSold)}</td>
    <td class="price-cell">${money(row.discounts)}</td>
    <td class="price-cell"><strong>${money(row.grossProfit)}</strong></td>
  </tr>`).join("") : `<tr><td colspan="6" class="empty-cell">No customer sales recorded for ${esc(monthName)} ${year}.</td></tr>`;
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
  $("accountPasswordRequiredMark").classList.toggle("hidden", Boolean(user));
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
  $("manageNavGroup").classList.toggle("hidden", !isAdmin);
  const currentYear = new Date().getFullYear();
  $("summaryYear").innerHTML = Array.from({ length: 7 }, (_, index) => currentYear + 2 - index)
    .map(year => `<option value="${year}">${year}</option>`).join("");
  $("summaryYear").value = String(currentYear);
  $("dashboardYear").innerHTML = $("summaryYear").innerHTML;
  $("dashboardYear").value = String(currentYear);
  $("dashboardMonth").innerHTML = Array.from({ length: 12 }, (_, index) =>
    `<option value="${index + 1}">${new Intl.DateTimeFormat("en", { month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2020, index, 1)))}</option>`
  ).join("");
  $("dashboardMonth").value = String(new Date().getMonth() + 1);
  $("salesTransactionYear").innerHTML = $("summaryYear").innerHTML;
  $("salesTransactionYear").value = String(currentYear);
  $("salesTransactionMonth").innerHTML = $("dashboardMonth").innerHTML;
  $("salesTransactionMonth").value = String(new Date().getMonth() + 1);
  $("salesYear").innerHTML = $("summaryYear").innerHTML;
  $("salesYear").value = String(currentYear);
  $("salesMonth").innerHTML = $("dashboardMonth").innerHTML;
  $("salesMonth").value = String(new Date().getMonth() + 1);
  $("purchaseYear").innerHTML = $("summaryYear").innerHTML;
  $("purchaseYear").value = String(currentYear);
  $("purchaseMonth").innerHTML = $("dashboardMonth").innerHTML;
  $("purchaseMonth").value = String(new Date().getMonth() + 1);
  $("lossYear").innerHTML = $("summaryYear").innerHTML;
  $("lossYear").value = String(currentYear);
  $("lossMonth").innerHTML = $("dashboardMonth").innerHTML;
  $("lossMonth").value = String(new Date().getMonth() + 1);

  // Admin controls inventory editing; staff encodes orders and customers
  $("addItemBtn").classList.toggle("hidden", !isAdmin);
  $("newMovementBtn").classList.toggle("hidden", !isAdmin);

  setView("dashboard");
  loadAll();
}

function setView(view) {
  if (["users", "activity"].includes(view) && state.user?.role !== "admin") view = "inventory";
  if (view === "losses") view = "damage";
  state.view = view;
  const isPurchaseView = ["purchases-direct", "purchases-credit"].includes(view);
  const isLossView = ["damage", "returns"].includes(view);
  document.querySelectorAll(".nav-link[data-view]").forEach(b => b.classList.toggle("active", b.dataset.view === view));
  $("purchasesNavToggle").classList.toggle("active", isPurchaseView);
  $("purchasesSubnav").hidden = !isPurchaseView;
  $("purchasesNavToggle").setAttribute("aria-expanded", String(!$("purchasesSubnav").hidden));
  $("lossesNavToggle").classList.toggle("active", isLossView);
  $("lossesSubnav").hidden = !isLossView;
  $("lossesNavToggle").setAttribute("aria-expanded", String(!$("lossesSubnav").hidden));

  const isAdmin = state.user?.role === "admin";

  const viewMeta = {
    dashboard: {
      title: "Dashboard",
      eyebrow: "WORKSPACE",
      subtitle: "Current inventory, sales, purchases, and performance overview."
    },
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
    "purchases-direct": {
      title: "Direct purchase",
      eyebrow: "DIRECT PURCHASES",
      subtitle: "Review direct purchases by month using the workbook's purchase transaction columns."
    },
    "purchases-credit": {
      title: "Credit purchase",
      eyebrow: "CREDIT PURCHASES",
      subtitle: "Review credit invoices, due dates, paid status, and balances by month."
    },
    damage: {
      title: "Damage items",
      eyebrow: "DAMAGE ITEMS",
      subtitle: "Review damaged stock by month using the workbook's damage transaction columns."
    },
    returns: {
      title: "Returns items",
      eyebrow: "RETURNS ITEMS",
      subtitle: "Review customer and supplier returns by month using the workbook's return transaction columns."
    },
    monthly: {
      title: "Monthly summary",
      eyebrow: "BUSINESS PERFORMANCE",
      subtitle: "Record ending inventory by month and review the workbook-style monthly transaction summary."
    },
    orders: {
      title: "Client orders",
      eyebrow: "ORDER ENCODING",
      subtitle: "Encode and review client orders. Items ordered automatically deduct from inventory stock."
    },
    "sales-transactions": {
      title: "Sales transactions",
      eyebrow: "SALES & MONTHLY SUMMARY",
      subtitle: "Review item-level sales transactions by month. Recorded client orders are included automatically."
    },
    sales: {
      title: "Daily sales and customer",
      eyebrow: "DAILY SALES & CUSTOMERS",
      subtitle: "Review workbook-style daily sales totals and customer purchases by month."
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

  const navLink = [...document.querySelectorAll(".nav-link[data-view]")]
    .find(link => link.dataset.view === view);
  const navLabel = navLink?.textContent.trim();
  let navSection = "";
  if (navLink) {
    let currentSection = "";
    for (const element of $("sidebar").children) {
      if (element.classList.contains("nav-label")) currentSection = element.textContent.trim();
      if (element === navLink || element.contains(navLink)) {
        navSection = currentSection;
        break;
      }
    }
  }
  const titleCase = text => text.toLowerCase().replace(/\b[a-z]/g, letter => letter.toUpperCase());
  $("crumbSection").textContent = titleCase(navSection || viewMeta.eyebrow);
  $("crumbCurrent").textContent = navLabel || viewMeta.title;
  $("pageTitle").textContent = viewMeta.title;
  $("pageEyebrow").textContent = viewMeta.eyebrow;
  $("pageSubtitle").textContent = viewMeta.subtitle;

  // Toggle heading action buttons
  $("addItemBtn").classList.toggle("hidden", view !== "inventory" || !isAdmin);
  $("pageNewOrderBtn").classList.toggle("hidden", view !== "orders");
  $("pageAddCustomerBtn").classList.toggle("hidden", view !== "customers");
  $("newPurchaseBtn").classList.toggle("hidden", !isPurchaseView || !isAdmin);
  $("newLossBtn").classList.toggle("hidden", !isLossView || !isAdmin);

  // Toggle stat cards
  $("monitoringStatsGrid").classList.toggle("hidden", view !== "inventory-monitoring");
  $("salesStatsGrid").classList.toggle("hidden", view !== "sales");
  $("salesTransactionsControls").classList.toggle("hidden", view !== "sales-transactions");
  $("salesTransactionsStatsGrid").classList.toggle("hidden", view !== "sales-transactions");
  $("purchaseFilters").classList.toggle("hidden", !isPurchaseView);
  $("purchaseStatsGrid").classList.toggle("hidden", !isPurchaseView);
  $("lossFilters").classList.toggle("hidden", !isLossView);
  $("lossStatsGrid").classList.toggle("hidden", !isLossView);
  $("statsGrid").classList.toggle("hidden", view !== "inventory");
  $("dashboardStatsGrid").classList.toggle("hidden", view !== "dashboard");

  // Toggle main panels
  $("dashboardPanel").classList.toggle("hidden", view !== "dashboard");
  $("inventoryPanel").classList.toggle("hidden", view !== "inventory");
  $("inventoryMonitoringPanel").classList.toggle("hidden", view !== "inventory-monitoring");
  $("transactionsPanel").classList.toggle("hidden", view !== "transactions");
  $("purchasesPanel").classList.toggle("hidden", !isPurchaseView);
  $("damagePanel").classList.toggle("hidden", view !== "damage");
  $("returnsPanel").classList.toggle("hidden", view !== "returns");
  $("monthlyPanel").classList.toggle("hidden", view !== "monthly");
  $("ordersPanel").classList.toggle("hidden", view !== "orders");
  $("salesTransactionsPanel").classList.toggle("hidden", view !== "sales-transactions");
  $("salesPanel").classList.toggle("hidden", view !== "sales");
  $("customersPanel").classList.toggle("hidden", view !== "customers");
  $("usersPanel").classList.toggle("hidden", view !== "users");
  $("activityPanel").classList.toggle("hidden", view !== "activity");

  if (view === "dashboard" && state.items.length) loadDashboard();
  if (view === "inventory") renderItems();
  if (view === "inventory-monitoring") loadInventoryMonitoring();
  if (view === "transactions") loadTransactions();
  if (isPurchaseView) loadPurchases();
  if (isLossView) loadLosses();
  if (view === "monthly") loadMonthlySummary();
  if (view === "orders") loadOrders();
  if (view === "sales-transactions") loadSalesTransactions();
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
$("dashboardYear").addEventListener("change", loadDashboard);
$("dashboardMonth").addEventListener("change", renderDashboard);
$("salesTransactionMonth").addEventListener("change", () => resetTablePage("sales-transactions", renderSalesTransactions));
$("salesTransactionYear").addEventListener("change", () => {
  if (state.pagination["sales-transactions"]) state.pagination["sales-transactions"].page = 1;
  loadSalesTransactions();
});
$("refreshSalesTransactionsBtn").addEventListener("click", loadSalesTransactions);
$("recordSalesTransactionBtn").addEventListener("click", openOrderModal);
$("salesMonth").addEventListener("change", () => {
  if (state.pagination.sales) state.pagination.sales.page = 1;
  if (state.pagination["sales-customers"]) state.pagination["sales-customers"].page = 1;
  loadSalesSummary();
});
$("salesYear").addEventListener("change", () => {
  if (state.pagination.sales) state.pagination.sales.page = 1;
  if (state.pagination["sales-customers"]) state.pagination["sales-customers"].page = 1;
  loadSalesSummary();
});
$("dashboardItemFilter").addEventListener("change", renderDashboard);
$("purchaseMonth").addEventListener("change", () => resetTablePage("purchases", renderPurchases));
$("purchaseYear").addEventListener("change", () => resetTablePage("purchases", renderPurchases));
$("refreshPurchasesBtn").addEventListener("click", loadPurchases);
$("lossMonth").addEventListener("change", () => resetTablePage(state.view, renderLosses));
$("lossYear").addEventListener("change", () => resetTablePage(state.view, renderLosses));
$("refreshLossesBtn").addEventListener("click", loadLosses);
$("purchasesNavToggle").addEventListener("click", () => {
  const submenu = $("purchasesSubnav");
  submenu.hidden = !submenu.hidden;
  $("purchasesNavToggle").setAttribute("aria-expanded", String(!submenu.hidden));
});
$("lossesNavToggle").addEventListener("click", () => {
  const submenu = $("lossesSubnav");
  submenu.hidden = !submenu.hidden;
  $("lossesNavToggle").setAttribute("aria-expanded", String(!submenu.hidden));
});
$("monthlyPanel").addEventListener("click", event => {
  const button = event.target.closest("[data-closing-save], [data-closing-clear]");
  const row = button?.closest("[data-closing-month]");
  if (!button || !row) return;
  if (button.hasAttribute("data-closing-save")) saveMonthlyClosing(row, button);
  else clearMonthlyClosing(row, button);
});
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
  state.purchaseType = state.view === "purchases-credit" ? "credit" : "cash";
  $("purchaseType").value = state.purchaseType;
  $("purchaseType").disabled = true;
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
  $("lossType").value = state.view === "returns" ? "customer_return" : "damage";
  $("lossModalTitle").textContent = state.view === "returns" ? "Record returned item" : "Record damaged item";
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
$("addManualSaleBtn").addEventListener("click", () => {
  $("manualSaleForm").reset();
  const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const year = $("salesYear").value;
  const month = $("salesMonth").value.padStart(2, "0");
  const firstDay = `${year}-${month}-01`;
  const lastDay = new Date(Date.UTC(Number(year), Number(month), 0)).toISOString().slice(0, 10);
  $("manualSaleDate").min = firstDay;
  $("manualSaleDate").max = lastDay;
  $("manualSaleDate").value = today >= firstDay && today <= lastDay ? today : firstDay;
  $("manualSaleError").textContent = "";
  openModal("manualSaleModal");
});
$("manualSaleForm").addEventListener("submit", async event => {
  event.preventDefault();
  $("manualSaleError").textContent = "";
  const button = $("saveManualSaleBtn");
  button.disabled = true;
  try {
    await api("/api/manual-sales", {
      method: "POST",
      body: JSON.stringify({
        sale_date: $("manualSaleDate").value,
        customer_name: $("manualSaleCustomer").value,
        quantity: Number($("manualSaleQuantity").value),
        sales_amount: Number($("manualSaleAmount").value),
        cost_of_goods_sold: Number($("manualSaleCost").value),
        discount: Number($("manualSaleDiscount").value)
      })
    });
    closeModal("manualSaleModal");
    toast("Manual sale saved.");
    await loadSalesSummary();
  } catch (error) {
    if (error.status === 401) return window.location.replace("/");
    $("manualSaleError").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
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

document.querySelectorAll(".nav-link[data-view]").forEach(b => b.addEventListener("click", () => {
  setView(b.dataset.view);
  $("sidebar").classList.remove("open");
  $("menuToggle").setAttribute("aria-expanded", "false");
}));

document.querySelectorAll("[data-close]").forEach(b => b.addEventListener("click", () => closeModal(b.dataset.close)));
document.querySelectorAll(".modal-backdrop").forEach(m => m.addEventListener("click", e => {
  if (e.target === m && m.id !== "deleteModal" && m.id !== "customerDeleteModal" && m.id !== "accountDeleteModal") closeModal(m.id);
}));

document.addEventListener("click", event => {
  const sidebar = $("sidebar");
  if (window.matchMedia("(max-width: 720px)").matches
      && sidebar.classList.contains("open")
      && !event.target.closest("#sidebar, #menuToggle")) {
    sidebar.classList.remove("open");
    $("menuToggle").setAttribute("aria-expanded", "false");
  }
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
