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
  if (!window.confirm("Are you sure you want to place this order?")) return;
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
    showCustomerOrderReceipt(order);
    $("clientOrderStatus").textContent = `Order received. Reference number: ${order.reference_number}.`;
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

function showCustomerOrderReceipt(order) {
  const items = order.client_order_items || [];
  $("customerReceiptContent").innerHTML = `
    <div class="receipt-brand">MATERIALS INVENTORY</div>
    <h3>ORDER RECEIPT</h3>
    <p class="receipt-reference"><span>Reference number</span><strong>${esc(order.reference_number)}</strong></p>
    <div class="receipt-meta">
      <span>Date</span><strong>${esc(new Date(order.created_at).toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" }))}</strong>
      <span>Customer</span><strong>${esc(order.client_name)}</strong>
      <span>Email</span><strong>${esc(order.client_email)}</strong>
      <span>Phone</span><strong>${esc(order.client_phone)}</strong>
    </div>
    <div class="receipt-items">${items.map(item => `<div class="receipt-item">
      <span>${esc(item.item_name)}<small>${Number(item.quantity).toLocaleString("en-PH")} ${esc(item.unit)} × ${money(item.unit_price)}</small></span>
      <strong>${money(item.line_total)}</strong>
    </div>`).join("")}</div>
    ${order.note ? `<p class="receipt-note"><span>Note</span>${esc(order.note)}</p>` : ""}
    <div class="receipt-total"><span>Total</span><strong>${money(order.total)}</strong></div>
    <p class="receipt-disclaimer">Order receipt for your records. This is not a tax invoice.</p>`;
  $("customerReceiptModal").classList.remove("hidden");
}

function setAccountContact(user) {
  $("clientName").value = user.display_name || "";
  $("clientEmail").value = user.email || "";
  $("clientPhone").value = user.phone_number || "";
}

function closeCustomerProfileMenu() {
  $("customerProfileDropdown").classList.add("hidden");
  $("customerProfileTrigger").setAttribute("aria-expanded", "false");
}

async function initializeCustomerPage() {
  try {
    const { user } = await api("/api/auth/me");
    if (user.role !== "customer") return window.location.replace("/dashboard.html");
    state.user = user;
    setAccountContact(user);
    $("customerWelcome").textContent = `Signed in as ${user.display_name}`;
    const initials = user.display_name.trim().split(/\s+/).filter(Boolean).slice(0, 2)
      .map(part => part[0]).join("");
    $("customerProfileAvatar").textContent = initials.toUpperCase() || user.username.slice(0, 2).toUpperCase();
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

$("customerProfileTrigger").addEventListener("click", () => {
  const isOpen = !$("customerProfileDropdown").classList.contains("hidden");
  $("customerProfileDropdown").classList.toggle("hidden", isOpen);
  $("customerProfileTrigger").setAttribute("aria-expanded", String(!isOpen));
});
$("customerEditProfileBtn").addEventListener("click", () => {
  closeCustomerProfileMenu();
  $("customerProfileForm").reset();
  $("customerUsername").value = state.user.username;
  $("customerProfileEmail").value = state.user.email;
  $("customerProfilePhone").value = state.user.phone_number;
  $("customerDisplayName").value = state.user.display_name;
  $("customerProfileError").textContent = "";
  $("customerProfileModal").classList.remove("hidden");
});
$("customerProfilePhone").addEventListener("input", event => {
  event.target.value = event.target.value.replace(/\D/g, "").slice(0, 11);
});
$("customerProfileForm").addEventListener("submit", async event => {
  event.preventDefault();
  $("customerProfileError").textContent = "";
  const button = $("saveCustomerProfileBtn");
  button.disabled = true;
  try {
    const result = await api("/api/auth/profile", {
      method: "PATCH",
      body: JSON.stringify({
        username: $("customerUsername").value,
        email: $("customerProfileEmail").value,
        phone_number: $("customerProfilePhone").value,
        display_name: $("customerDisplayName").value
      })
    });
    state.user = result.user;
    $("customerWelcome").textContent = `Signed in as ${result.user.display_name}`;
    const initials = result.user.display_name.trim().split(/\s+/).filter(Boolean).slice(0, 2)
      .map(part => part[0]).join("");
    $("customerProfileAvatar").textContent = initials.toUpperCase() || result.user.username.slice(0, 2).toUpperCase();
    setAccountContact(result.user);
    $("customerProfileModal").classList.add("hidden");
    $("clientOrderStatus").textContent = "Your profile has been updated.";
  } catch (error) {
    if (error.status === 401) return window.location.replace("/");
    $("customerProfileError").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
$("customerChangePasswordBtn").addEventListener("click", () => {
  closeCustomerProfileMenu();
  $("customerPasswordForm").reset();
  $("customerPasswordError").textContent = "";
  $("customerPasswordModal").classList.remove("hidden");
});
$("customerPasswordForm").addEventListener("submit", async event => {
  event.preventDefault();
  $("customerPasswordError").textContent = "";
  if ($("customerNewPassword").value !== $("customerConfirmPassword").value) {
    $("customerPasswordError").textContent = "New passwords do not match.";
    return;
  }
  const button = $("saveCustomerPasswordBtn");
  button.disabled = true;
  try {
    await api("/api/auth/change-password", {
      method: "POST",
      body: JSON.stringify({
        current_password: $("customerCurrentPassword").value,
        new_password: $("customerNewPassword").value
      })
    });
    window.location.replace("/?password_changed=1");
  } catch (error) {
    if (error.status === 401) return window.location.replace("/");
    $("customerPasswordError").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
$("customerLogout").addEventListener("click", () => {
  closeCustomerProfileMenu();
  $("customerLogoutModal").classList.remove("hidden");
});
$("confirmCustomerLogoutBtn").addEventListener("click", async () => {
  const button = $("confirmCustomerLogoutBtn");
  button.disabled = true;
  try {
    await api("/api/auth/logout", { method: "POST" });
    window.location.replace("/?logged_out=1");
  } catch (error) {
    $("clientOrderError").textContent = error.message;
    button.disabled = false;
  }
});
$("customerPrintReceiptBtn").addEventListener("click", () => {
  $("customerReceiptModal").classList.add("receipt-print-target");
  document.body.classList.add("receipt-printing");
  window.print();
  window.setTimeout(() => {
    document.body.classList.remove("receipt-printing");
    $("customerReceiptModal").classList.remove("receipt-print-target");
  }, 1000);
});

document.querySelectorAll("[data-close]").forEach(button => {
  button.addEventListener("click", () => $(button.dataset.close).classList.add("hidden"));
});
document.querySelectorAll(".modal-backdrop").forEach(modal => {
  modal.addEventListener("click", event => {
    if (event.target === modal && modal.id !== "customerLogoutModal") modal.classList.add("hidden");
  });
});
document.addEventListener("click", event => {
  if (!event.target.closest("#customerProfileMenu")) closeCustomerProfileMenu();
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape") {
    closeCustomerProfileMenu();
    document.querySelectorAll(".modal-backdrop").forEach(modal => modal.classList.add("hidden"));
  }
});

initializeCustomerPage();
