const $ = (id) => document.getElementById(id);
const state = { items: [], cart: [], user: null };
const money = (value) => new Intl.NumberFormat("en-PH", {
  style: "currency",
  currency: "PHP",
  maximumFractionDigits: 2
}).format(Number(value || 0));

function esc(value = "") {
  return String(value).replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function renderCatalog() {
  const search = $("catalogSearch").value.trim().toLowerCase();
  const items = state.items.filter(item =>
    [item.name, item.category, item.brand, item.variant].join(" ").toLowerCase().includes(search));
  $("clientCatalog").innerHTML = items.length ? items.map(item => {
    const available = Number(item.quantity);
    const defaultQuantity = Math.min(1, available);
    return `<article class="client-product-card">
      <div class="client-product-info">
        <span class="category-pill">${esc(item.category)}</span>
        <h3>${esc(item.name)}</h3>
        <p>${esc([item.brand, item.variant].filter(Boolean).join(" · ") || item.unit)}</p>
        <strong>${money(item.unit_price)} <small>/ ${esc(item.unit)}</small></strong>
        <span class="client-stock">${available.toLocaleString("en-PH")} ${esc(item.unit)} available</span>
      </div>
      <div class="client-product-actions">
        <label class="field">Quantity<input type="number" min="0.01" step="0.01" max="${available}"
            value="${defaultQuantity}" data-client-quantity="${esc(item.id)}" required></label>
        <button class="primary-button" type="button" data-add-to-cart="${esc(item.id)}">Add to order</button>
      </div>
    </article>`;
  }).join("") : `<p class="empty-cell">${state.items.length ? "No materials match your search." : "There are no materials available to order right now."}</p>`;
}

function renderCart() {
  const lines = state.cart.map(line => {
    const item = state.items.find(product => product.id === line.itemId);
    return item ? { ...line, item } : null;
  }).filter(Boolean);
  $("clientCart").innerHTML = lines.length ? lines.map(line => {
    const lineTotal = Math.round(Number(line.item.unit_price) * line.quantity * 100) / 100;
    return `<div class="client-cart-line">
      <div><strong>${esc(line.item.name)}</strong><small>${Number(line.quantity).toLocaleString("en-PH")} ${esc(line.item.unit)} · ${money(lineTotal)}</small></div>
      <button type="button" class="small-action" data-remove-cart="${esc(line.itemId)}" aria-label="Remove ${esc(line.item.name)}">Remove</button>
    </div>`;
  }).join("") : `<p class="order-lines-empty">Your order is empty.</p>`;
  const total = lines.reduce((sum, line) =>
    sum + Math.round(Number(line.item.unit_price) * line.quantity * 100) / 100, 0);
  $("clientOrderTotal").textContent = money(total);
}

async function loadCatalog() {
  try {
    state.items = await api("/api/customer/items");
    renderCatalog();
  } catch (error) {
    if (error.status === 401) return window.location.replace("/");
    $("clientCatalog").innerHTML = `<p class="empty-cell">${esc(error.message)}</p>`;
  }
}

$("catalogSearch").addEventListener("input", renderCatalog);
$("clientCatalog").addEventListener("click", event => {
  const button = event.target.closest("[data-add-to-cart]");
  if (!button) return;
  const itemId = button.dataset.addToCart;
  const item = state.items.find(product => product.id === itemId);
  const quantityInput = document.querySelector(`[data-client-quantity="${CSS.escape(itemId)}"]`);
  if (!item || !quantityInput || !quantityInput.reportValidity()) return;
  const quantity = Number(quantityInput.value);
  const existing = state.cart.find(line => line.itemId === itemId);
  if (!Number.isFinite(quantity) || quantity <= 0 || quantity + (existing?.quantity || 0) > Number(item.quantity)) {
    $("clientOrderError").textContent = `Only ${Number(item.quantity).toLocaleString("en-PH")} ${item.unit} of ${item.name} are available.`;
    return;
  }
  $("clientOrderError").textContent = "";
  if (existing) existing.quantity = Math.round((existing.quantity + quantity) * 100) / 100;
  else state.cart.push({ itemId, quantity });
  renderCart();
});
$("clientCart").addEventListener("click", event => {
  const button = event.target.closest("[data-remove-cart]");
  if (!button) return;
  state.cart = state.cart.filter(line => line.itemId !== button.dataset.removeCart);
  renderCart();
});
$("clientOrderForm").addEventListener("submit", async event => {
  event.preventDefault();
  $("clientOrderError").textContent = "";
  $("clientOrderStatus").textContent = "";
  if (!state.cart.length) {
    $("clientOrderError").textContent = "Add at least one available material to your order.";
    return;
  }
  const button = $("submitClientOrder");
  button.disabled = true;
  try {
    const order = await api("/api/customer/orders", {
      method: "POST",
      body: JSON.stringify({
        note: $("clientNote").value,
        items: state.cart.map(line => ({ item_id: line.itemId, quantity: line.quantity }))
      })
    });
    $("clientOrderStatus").textContent = `Order received. Your reference number is ${order.id.slice(0, 8)}.`;
    $("clientOrderForm").reset();
    setAccountContact(state.user);
    state.cart = [];
    renderCart();
    await loadCatalog();
  } catch (error) {
    $("clientOrderError").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

function setAccountContact(user) {
  $("clientName").value = user.display_name || "";
  $("clientEmail").value = user.email || "";
  $("clientPhone").value = user.phone_number || "";
}

async function initializeCustomerPage() {
  try {
    const { user } = await api("/api/auth/me");
    if (user.role !== "customer") return window.location.replace("/dashboard.html");
    state.user = user;
    setAccountContact(user);
    $("customerWelcome").textContent = `Signed in as ${user.display_name}`;
    const contactReady = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user.email || "")
      && /^[0-9]{11}$/.test(user.phone_number || "");
    $("submitClientOrder").disabled = !contactReady;
    if (!contactReady) {
      $("clientOrderError").textContent = "Your account needs a valid email and phone number. Ask an administrator to update your account before ordering.";
    }
    renderCart();
    await loadCatalog();
  } catch (error) {
    if (error.status === 401) return window.location.replace("/");
    $("clientCatalog").innerHTML = `<p class="empty-cell">${esc(error.message)}</p>`;
  }
}

$("customerLogout").addEventListener("click", async () => {
  const button = $("customerLogout");
  button.disabled = true;
  try {
    await api("/api/auth/logout", { method: "POST" });
    window.location.replace("/?logged_out=1");
  } catch (error) {
    $("clientOrderError").textContent = error.message;
    button.disabled = false;
  }
});

initializeCustomerPage();
