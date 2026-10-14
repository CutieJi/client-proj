const $ = (id) => document.getElementById(id);

const query = new URLSearchParams(window.location.search);
const successMessage = query.has("logged_out")
  ? "Logged out successfully."
  : query.has("password_changed")
    ? "Password changed. Please sign in again."
    : "";
if (successMessage) {
  $("loginToast").textContent = successMessage;
  $("loginToast").classList.add("show");
  window.history.replaceState({}, "", "/");
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}

api("/api/auth/me")
  .then(({ user }) => window.location.replace(user.role === "customer" ? "/customer.html" : "/dashboard.html"))
  .catch(error => {
    if (error.status !== 401) $("loginError").textContent = error.message;
  });

let registrationMode = false;
$("registerPhoneNumber").addEventListener("input", event => {
  event.target.value = event.target.value.replace(/\D/g, "").slice(0, 11);
});
$("registerPassword").addEventListener("input", () => {
  $("registerConfirmPassword").setCustomValidity("");
});
$("registerConfirmPassword").addEventListener("input", () => {
  const matches = $("registerConfirmPassword").value === $("registerPassword").value;
  $("registerConfirmPassword").setCustomValidity(matches ? "" : "Passwords do not match.");
});
$("authToggle").addEventListener("click", () => {
  registrationMode = !registrationMode;
  $("loginForm").classList.toggle("hidden", registrationMode);
  $("registerForm").classList.toggle("hidden", !registrationMode);
  $("authTitle").textContent = registrationMode ? "Create customer account" : "Sign in";
  document.querySelector(".login-card").classList.toggle("registering", registrationMode);
  $("authSubtitle").textContent = registrationMode
    ? "Create an account to order materials."
    : "Sign in to order materials or access the staff workspace.";
  $("authToggle").textContent = registrationMode ? "Already have an account? Sign in" : "New customer? Create an account";
  $("loginError").textContent = "";
  $("registerError").textContent = "";
});

$("loginForm").addEventListener("submit", async event => {
  event.preventDefault();
  $("loginError").textContent = "";
  const button = $("loginButton");
  button.disabled = true;
  try {
    await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        identifier: $("loginUsername").value,
        password: $("loginPassword").value
      })
    });
    const { user } = await api("/api/auth/me");
    window.location.replace(user.role === "customer" ? "/customer.html" : "/dashboard.html?logged_in=1");
  } catch (error) {
    $("loginError").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

$("registerForm").addEventListener("submit", async event => {
  event.preventDefault();
  $("registerError").textContent = "";
  if ($("registerPassword").value !== $("registerConfirmPassword").value) {
    $("registerConfirmPassword").setCustomValidity("Passwords do not match.");
    $("registerConfirmPassword").reportValidity();
    return;
  }
  const button = $("registerButton");
  button.disabled = true;
  try {
    await api("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({
        display_name: $("registerDisplayName").value,
        username: $("registerUsername").value,
        email: $("registerEmail").value,
        phone_number: $("registerPhoneNumber").value,
        password: $("registerPassword").value,
        confirm_password: $("registerConfirmPassword").value
      })
    });
    window.location.replace("/customer.html");
  } catch (error) {
    $("registerError").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
