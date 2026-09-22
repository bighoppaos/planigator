const API_BASE = location.hostname === "planigator.help" || location.hostname === "www.planigator.help"
  ? ""
  : "https://planigator.bighoppaos.workers.dev";
const SESSION_KEY = "planigator.web.session";
const AUTH_KEY = "planigator.web.auth";
const DEVICE_KEY = "planigator.web.device";

function deviceId() {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

let lastPulse = 0;

export function removeSavedCard() {
  return api("/v1/delete-card", { method: "POST", body: "{}" });
}

export function clearCardWelcome() {
  return api("/v1/card-seen", { method: "POST", body: "{}" }).catch(() => {});
}

export function pulseActivity() {
  const now = Date.now();
  if (now - lastPulse < 60_000) return Promise.resolve();
  lastPulse = now;
  return api("/v1/active", { method: "POST", body: "{}" }).catch(() => {});
}

export function clearSession() {
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(AUTH_KEY);
}

export const STARTER_CREDITS = 12;

export async function api(path, options = {}) {
  const headers = { Accept: "application/json", ...(options.headers || {}) };
  if (options.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  const session = localStorage.getItem(SESSION_KEY);
  if (session) headers.Authorization = `Bearer ${session}`;
  const nonce = localStorage.getItem(AUTH_KEY);
  if (nonce) headers["X-Planigator-Auth"] = nonce;
  headers["X-Planigator-Device"] = deviceId();
  const response = await fetch(`${API_BASE}${path}`, { ...options, headers });
  let data = {};
  try {
    data = await response.json();
  } catch {
    data = {};
  }
  if (data.session) localStorage.setItem(SESSION_KEY, data.session);
  if (data.loginNonce) localStorage.setItem(AUTH_KEY, data.loginNonce);
  if (data.signedIn === false) localStorage.removeItem(AUTH_KEY);
  if (!response.ok) {
    const error = new Error(data.error || "Could not reach Planigator credits.");
    error.status = response.status;
    error.credits = data.credits;
    throw error;
  }
  return data;
}

export function creditsMe() {
  return api("/v1/me");
}

export function fetchCalls() {
  return api("/v1/calls");
}

export function geocodeAddress(query) {
  return api("/v1/geocode", { method: "POST", body: JSON.stringify({ q: query }) });
}

export function suggestAddresses(query) {
  return api("/v1/suggest", { method: "POST", body: JSON.stringify({ q: query }) });
}

export function truckRoute(from, to, options = {}) {
  return api("/v1/route", {
    method: "POST",
    body: JSON.stringify({
      from,
      to,
      speedCapMph: options.speedCapMph,
      departAt: options.departAt,
    }),
  });
}

export function startCheckout() {
  return api("/v1/checkout", { method: "POST", body: "{}" });
}

export function startCardSetup() {
  return api("/v1/setup-card", { method: "POST", body: "{}" });
}

export function loginWith(provider, idToken) {
  return api("/v1/login", { method: "POST", body: JSON.stringify({ provider, idToken }) });
}

export async function logoutRemote() {
  const session = localStorage.getItem(SESSION_KEY);
  if (!session) return;
  const headers = { Authorization: `Bearer ${session}` };
  const nonce = localStorage.getItem(AUTH_KEY);
  if (nonce) headers["X-Planigator-Auth"] = nonce;
  try {
    await fetch(`${API_BASE}/v1/logout`, { method: "POST", headers });
  } catch {
    // Still sign out this browser if the request fails.
  }
}

export function fetchTrips() {
  return api("/v1/trips");
}

export function putTrips(trips) {
  return api("/v1/trips", { method: "PUT", body: JSON.stringify({ trips }) });
}
