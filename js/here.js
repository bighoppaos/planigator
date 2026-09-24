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
  course,
  routingMode,
  now = Date.now(),
}) {
  const profile = TRUCK_PROFILE;
  let origin = `${from.lat.toFixed(6)},${from.lon.toFixed(6)}`;
  if (typeof course === "number" && Number.isFinite(course) && course >= 0 && course <= 360) {
    origin += `;course=${Math.round(course % 360)};minCourseDistance=400`;
  }
  const items = [
    pair("transportMode", "truck"),
    pair("origin", origin),
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
  if (routingMode === "short" || routingMode === "fast") items.push(pair("routingMode", routingMode));
  return `https://router.hereapi.com/v8/routes?${items.join("&")}`;
}
