const API_BASE = "https://planigator.bighoppaos.workers.dev";
const SESSION_KEY = "planigator.web.session";

export const STARTER_CREDITS = 12;

export async function api(path, options = {}) {
  const headers = { Accept: "application/json", ...(options.headers || {}) };
  if (options.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  const session = localStorage.getItem(SESSION_KEY);
  if (session) headers.Authorization = `Bearer ${session}`;
  const response = await fetch(`${API_BASE}${path}`, { ...options, headers });
  let data = {};
  try {
    data = await response.json();
  } catch {
    data = {};
  }
  if (data.session) localStorage.setItem(SESSION_KEY, data.session);
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

export function geocodeAddress(query) {
  return api("/v1/geocode", { method: "POST", body: JSON.stringify({ q: query }) });
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
