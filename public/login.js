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
  .then(() => window.location.replace("/dashboard.html"))
  .catch(error => {
    if (error.status !== 401) $("loginError").textContent = error.message;
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
        username: $("loginUsername").value,
        password: $("loginPassword").value
      })
    });
    window.location.replace("/dashboard.html?logged_in=1");
  } catch (error) {
    $("loginError").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
