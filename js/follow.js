import { fetchShare } from "./api.js";

const STORAGE = "planigator.web.v1";
const OFF_ROUTE_M = 250;

const satelliteStyle = {
  version: 8,
  sources: {
    satellite: {
      type: "raster",
      tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
      tileSize: 256,
      maxzoom: 19,
      attribution: "Esri, Maxar, Earthstar Geographics, and the GIS User Community",
    },
  },
  layers: [{ id: "satellite", type: "raster", source: "satellite" }],
};

const banner = document.getElementById("followBanner");
const detail = document.getElementById("followDetail");
const status = document.getElementById("followStatus");

let map = null;
let you = null;
let line = [];
let legs = [];
let following = true;
let lastFix = null;

function cleanPath(path) {
  if (!Array.isArray(path)) return [];
  return path
    .map((pair) => [Number(pair?.[0]), Number(pair?.[1])])
    .filter((pair) => Number.isFinite(pair[0]) && Number.isFinite(pair[1]));
}

function metersBetween(a, b) {
  const lat = ((a[0] + b[0]) / 2) * Math.PI / 180;
  const y = (b[0] - a[0]) * 111320;
  const x = (b[1] - a[1]) * 111320 * Math.cos(lat);
  return Math.hypot(x, y);
}

function polylineMeters(path) {
  let walked = 0;
  for (let i = 1; i < path.length; i += 1) walked += metersBetween(path[i - 1], path[i]);
  return walked;
}

function projectT(a, b, lat, lon) {
  const lat0 = ((a[0] + b[0]) / 2) * Math.PI / 180;
  const bx = (b[1] - a[1]) * 111320 * Math.cos(lat0);
  const by = (b[0] - a[0]) * 111320;
  const px = (lon - a[1]) * 111320 * Math.cos(lat0);
  const py = (lat - a[0]) * 111320;
  const len2 = bx * bx + by * by;
  if (len2 < 1) return 0;
  return Math.max(0, Math.min(1, (px * bx + py * by) / len2));
}

function nearestOnPath(lat, lon, path) {
  let bestDist = Infinity;
  let along = 0;
  let walked = 0;
  let point = path[0];
  for (let i = 1; i < path.length; i += 1) {
    const seg = metersBetween(path[i - 1], path[i]);
    const t = projectT(path[i - 1], path[i], lat, lon);
    const plat = path[i - 1][0] + (path[i][0] - path[i - 1][0]) * t;
    const plon = path[i - 1][1] + (path[i][1] - path[i - 1][1]) * t;
    const dist = metersBetween([lat, lon], [plat, plon]);
    if (dist < bestDist) {
      bestDist = dist;
      along = walked + seg * t;
      point = [plat, plon];
    }
    walked += seg;
  }
  return { dist: bestDist, along, point };
}

function stepLengthMeters(step) {
  const text = String(step?.text || "");
  const feet = text.match(/Go for\s+([0-9][0-9,]*(?:\.[0-9]+)?)\s*ft\b/i);
  if (feet) return Number(feet[1].replace(/,/g, "")) * 0.3048;
  const miles = Number(step?.miles);
  if (Number.isFinite(miles) && miles > 0) return miles * 1609.344;
  const spoken = text.match(/Go for\s+([0-9][0-9,]*(?:\.[0-9]+)?)\s*mi\b/i);
  if (spoken) return Number(spoken[1].replace(/,/g, "")) * 1609.344;
  return 0;
}

function bearing(a, b) {
  const φ1 = a[0] * Math.PI / 180;
  const φ2 = b[0] * Math.PI / 180;
  const λ = (b[1] - a[1]) * Math.PI / 180;
  const y = Math.sin(λ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(λ);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function milesLabel(meters) {
  const miles = meters / 1609.344;
  if (miles < 0.1) return `${Math.max(1, Math.round(meters * 3.28084))} ft`;
  if (miles < 10) return `${miles.toFixed(1)} mi`;
  return `${Math.round(miles)} mi`;
}

function loadLocal() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE) || "null");
    if (!saved || !Array.isArray(saved.stops)) return null;
    return saved;
  } catch {
    return null;
  }
}

function buildLegs(stops) {
  const next = [];
  let cursor = 0;
  const full = [];
  for (const stop of stops) {
    const path = cleanPath(stop.path);
    if (path.length < 2) continue;
    if (full.length && path[0][0] === full[full.length - 1][0] && path[0][1] === full[full.length - 1][1]) {
      full.push(...path.slice(1));
    } else {
      full.push(...path);
    }
    const meters = polylineMeters(path);
    next.push({ stop, path, start: cursor, end: cursor + meters });
    cursor += meters;
  }
  return { line: full, legs: next };
}

function stopTitle(stop) {
  const name = String(stop?.name || "").trim();
  if (name) return name;
  return stop?.useCurrentLocation ? "Current location" : "Stop";
}

function say(title, sub, note) {
  banner.textContent = title;
  detail.textContent = sub;
  status.textContent = note || "";
}

function stepFor(leg, alongInLeg) {
  const steps = Array.isArray(leg.stop.directions) ? leg.stop.directions : [];
  if (!steps.length) return null;
  const lengths = steps.map(stepLengthMeters);
  const sum = lengths.reduce((total, length) => total + length, 0);
  const total = polylineMeters(leg.path);
  const scale = sum > 1 ? total / sum : 1;
  let cursor = 0;
  for (let i = 0; i < steps.length; i += 1) {
    const len = lengths[i] * scale;
    if (alongInLeg <= cursor + Math.max(len, 1) || i === steps.length - 1) return steps[i];
    cursor += len;
  }
  return steps[0];
}

function remainingLine(fromAlong) {
  if (line.length < 2) return [];
  let walked = 0;
  const coords = [];
  const push = (pair) => {
    const prev = coords[coords.length - 1];
    if (prev && prev[0] === pair[1] && prev[1] === pair[0]) return;
    coords.push([pair[1], pair[0]]);
  };
  for (let i = 1; i < line.length; i += 1) {
    const seg = metersBetween(line[i - 1], line[i]);
    if (walked + seg >= fromAlong) {
      const t = seg > 0 ? Math.min(1, Math.max(0, (fromAlong - walked) / seg)) : 1;
      const lat = line[i - 1][0] + (line[i][0] - line[i - 1][0]) * t;
      const lon = line[i - 1][1] + (line[i][1] - line[i - 1][1]) * t;
      push([lat, lon]);
      for (let j = i; j < line.length; j += 1) push(line[j]);
      break;
    }
    walked += seg;
  }
  return coords;
}

function drawRemaining(along) {
  const source = map?.getSource("left");
  if (!source) return;
  const coordinates = remainingLine(along);
  source.setData({
    type: "Feature",
    geometry: { type: "LineString", coordinates: coordinates.length >= 2 ? coordinates : [] },
  });
}

function onFix(lat, lon) {
  const maplibre = window.maplibregl;
  if (!map || !maplibre) return;
  if (!you) {
    const dot = document.createElement("span");
    dot.className = "follow-you";
    you = new maplibre.Marker({ element: dot, anchor: "center" }).setLngLat([lon, lat]).addTo(map);
  } else {
    you.setLngLat([lon, lat]);
  }
  let travel = null;
  if (lastFix && metersBetween(lastFix, [lat, lon]) > 8) travel = bearing(lastFix, [lat, lon]);
  lastFix = [lat, lon];

  if (line.length < 2) {
    say("No road line on this trip", "Calculate it on the plan page, then open Follow again.", "");
    if (following) map.easeTo({ center: [lon, lat], zoom: 16, duration: 700 });
    return;
  }

  const hit = nearestOnPath(lat, lon, line);
  const off = hit.dist > OFF_ROUTE_M;
  const leg = legs.find((item) => hit.along >= item.start && hit.along <= item.end) || legs[legs.length - 1];
  const alongInLeg = leg ? hit.along - leg.start : 0;
  const step = !off && leg ? stepFor(leg, alongInLeg) : null;
  const leftOnLeg = leg ? Math.max(0, leg.end - hit.along) : 0;
  const leftOnTrip = Math.max(0, polylineMeters(line) - hit.along);
  const drop = legs.length ? stopTitle(legs[legs.length - 1].stop) : "the drop";
  const toward = leg ? stopTitle(leg.stop) : drop;
  if (off) {
    say("Not on the route yet", `The trip ends at ${drop}.`, `${milesLabel(hit.dist)} from the line`);
    drawRemaining(0);
  } else {
    const text = String(step?.text || "").trim() || `Continue to ${toward}`;
    say(text, `${milesLabel(leftOnLeg)} to ${toward}`, `${milesLabel(leftOnTrip)} left in the trip`);
    drawRemaining(hit.along);
  }
  if (following) {
    const camera = { center: [lon, lat], zoom: Math.max(map.getZoom(), 15), duration: 700 };
    if (travel != null) camera.bearing = travel;
    map.easeTo(camera);
  }
}

function mount(trip) {
  const maplibre = window.maplibregl;
  const built = buildLegs(trip.stops || []);
  line = built.line;
  legs = built.legs;
  const drop = (trip.stops || []).filter((stop) => !stop.useCurrentLocation).slice(-1)[0];
  say("Finding you…", drop ? `Toward ${stopTitle(drop)}` : "Allow location to follow this trip.", "");
  map = new maplibre.Map({
    container: "followMap",
    style: satelliteStyle,
    attributionControl: false,
  });
  map.addControl(new maplibre.AttributionControl({ compact: true }), "bottom-right");
  map.on("load", () => {
    const coordinates = line.map(([lat, lon]) => [lon, lat]);
    if (coordinates.length >= 2) {
      map.addSource("route", {
        type: "geojson",
        data: { type: "Feature", geometry: { type: "LineString", coordinates } },
      });
      map.addLayer({
        id: "route",
        type: "line",
        source: "route",
        paint: { "line-color": "#ffffff", "line-width": 8, "line-opacity": 0.45 },
      });
      map.addSource("left", {
        type: "geojson",
        data: { type: "Feature", geometry: { type: "LineString", coordinates } },
      });
      map.addLayer({
        id: "left",
        type: "line",
        source: "left",
        paint: { "line-color": "#3dcaa0", "line-width": 6 },
      });
      const bounds = coordinates.reduce(
        (box, coord) => box.extend(coord),
        new maplibre.LngLatBounds(coordinates[0], coordinates[0]),
      );
      map.fitBounds(bounds, { padding: 80, maxZoom: 12, animate: false });
    }
  });
  if (!navigator.geolocation) {
    say("This browser can't share location", "Follow needs location to move you along the trip.", "");
    return;
  }
  navigator.geolocation.watchPosition(
    (pos) => onFix(pos.coords.latitude, pos.coords.longitude),
    () => say("Allow location", "Planigator needs location to show you moving on this trip.", ""),
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 },
  );
}

document.getElementById("followOverview")?.addEventListener("click", () => {
  following = false;
  if (!map || line.length < 2) return;
  const coordinates = line.map(([lat, lon]) => [lon, lat]);
  const bounds = coordinates.reduce(
    (box, coord) => box.extend(coord),
    new window.maplibregl.LngLatBounds(coordinates[0], coordinates[0]),
  );
  map.fitBounds(bounds, { padding: 80, maxZoom: 12, duration: 600 });
});

document.getElementById("followLock")?.addEventListener("click", () => {
  following = true;
  if (lastFix) onFix(lastFix[0], lastFix[1]);
});

const code = new URLSearchParams(location.search).get("s");
if (code) {
  fetchShare(code).then(mount).catch(() => {
    say("That trip link was not found", "Open a Planigator share link, or calculate a trip in this browser first.", "");
  });
} else {
  const local = loadLocal();
  if (!local) say("No trip in this browser", "Calculate a trip on the plan page, then open Follow again.", "");
  else mount(local);
}
