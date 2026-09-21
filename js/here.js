/** HERE truck routing. Same 53-ft dry van as TruckProfile in TruckerRouting.swift. */

export const TRUCK_PROFILE = {
  heightInches: 13 * 12 + 6,
  widthInches: 102,
  overallLengthFeet: 73,
  trailerLengthFeet: 53,
  grossWeightPounds: 80_000,
  axleCount: 5,
  trailerCount: 1,
  kpraLengthFeet: 41,
  summary: "53-ft trailer, 80,000 lb, 13 ft 6 in high, 102 in wide, 5 axles",
};

export function kg(pounds) {
  return Math.round(pounds * 0.45359237);
}

export function cmFromInches(inches) {
  return Math.round(inches * 2.54);
}

export function cmFromFeet(feet) {
  return Math.round(feet * 30.48);
}

export function hereDeparture(ms, now = Date.now()) {
  if (ms == null) return "any";
  return new Date(Math.max(ms, now)).toISOString();
}

function pair(key, value) {
  return `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`;
}

export function truckRouteUrl({
  from,
  to,
  apiKey,
  speedCapMph,
  departAt,
  now = Date.now(),
}) {
  const profile = TRUCK_PROFILE;
  const items = [
    pair("transportMode", "truck"),
    pair("origin", `${from.lat.toFixed(6)},${from.lon.toFixed(6)}`),
    pair("destination", `${to.lat.toFixed(6)},${to.lon.toFixed(6)}`),
    pair("return", "summary"),
    pair("departureTime", hereDeparture(departAt, now)),
    pair("units", "imperial"),
    pair("apiKey", apiKey),
    pair("avoid[features]", "dirtRoad,uTurns"),
    pair("vehicle[grossWeight]", kg(profile.grossWeightPounds)),
    pair("vehicle[currentWeight]", kg(profile.grossWeightPounds)),
    pair("vehicle[height]", cmFromInches(profile.heightInches)),
    pair("vehicle[width]", cmFromInches(profile.widthInches)),
    pair("vehicle[length]", cmFromFeet(profile.overallLengthFeet)),
    pair("vehicle[trailerLength]", cmFromFeet(profile.trailerLengthFeet)),
    pair("vehicle[kpraLength]", cmFromFeet(profile.kpraLengthFeet)),
    pair("vehicle[trailerCount]", profile.trailerCount),
    pair("vehicle[axleCount]", profile.axleCount),
    pair("vehicle[trailerAxleCount]", 2),
    pair("vehicle[weightPerAxleGroup]", "single:5443,tandem:15422"),
  ];
  const cap = Number(speedCapMph);
  if (cap > 1) {
    items.push(pair("vehicle[speedCap]", Math.min(70, Math.max(1, cap * 0.44704)).toFixed(2)));
  }
  return `https://router.hereapi.com/v8/routes?${items.join("&")}`;
}

export async function geocodeAddress(query, apiKey) {
  const url = `https://geocode.search.hereapi.com/v1/geocode?${[
    pair("q", query),
    pair("limit", 1),
    pair("lang", "en-US"),
    pair("apiKey", apiKey),
  ].join("&")}`;
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (response.status === 401 || response.status === 403) {
    throw new Error("HERE did not accept the website API key.");
  }
  if (!response.ok) throw new Error("Address lookup failed.");
  const data = await response.json();
  const hit = data.items?.[0];
  const lat = hit?.position?.lat;
  const lon = hit?.position?.lng;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error(`Could not find “${query}”.`);
  }
  return {
    lat,
    lon,
    label: hit.address?.label || hit.title || query,
  };
}

export async function truckRoute(from, to, apiKey, options = {}) {
  const url = truckRouteUrl({ from, to, apiKey, ...options });
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (response.status === 401 || response.status === 403) {
    throw new Error("HERE did not accept the website API key.");
  }
  if (!response.ok) {
    let detail = `HERE truck routing failed (HTTP ${response.status}).`;
    try {
      const body = await response.json();
      const parts = [body.title, body.cause, body.action].filter(Boolean);
      if (parts.length) detail = parts.join(" ");
    } catch {
      // keep status text
    }
    throw new Error(detail);
  }
  const data = await response.json();
  const sections = data.routes?.[0]?.sections || [];
  if (!sections.length) throw new Error("No truck-legal path between those stops.");
  const meters = sections.reduce((sum, section) => sum + (section.summary?.length || 0), 0);
  const seconds = sections.reduce((sum, section) => sum + (section.summary?.duration || 0), 0);
  return {
    miles: meters / 1609.344,
    hours: seconds / 3600,
  };
}
