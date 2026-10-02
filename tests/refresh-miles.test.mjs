// Refresh during navigation must keep the same miles left as Recalculate.
// Not loaded by the site. Run: node tests/refresh-miles.test.mjs
//
// Loads the real functions from js/app.js (by name, into a vm sandbox) and the
// real js/nav-match.js, drives a long I-70 / PA Turnpike route toward PACTIV
// (Downingtown, exit 312), saves the page the way it does (localStorage JSON +
// nav progress), reloads into a fresh sandbox, resumes navigation, and compares
// the ETA chip miles, the current direction's miles, and the drive-chip miles
// before the reload, after the reload, and after a Recalculate at the same spot.

import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appSource = readFileSync(path.join(root, "js/app.js"), "utf8");
const navMatch = await import(pathToFileURL(path.join(root, "js/nav-match.js")).href);

const MILE = 1609.344;

function extract(name) {
  const head = new RegExp(`^(?:async\\s+)?function\\s+${name}\\s*\\(`, "m").exec(appSource);
  if (!head) throw new Error(`app.js has no function ${name}`);
  let i = head.index + head[0].length;
  let depth = 1;
  while (depth) {
    const ch = appSource[i++];
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
  }
  i = appSource.indexOf("{", i);
  const start = head.index;
  depth = 0;
  let quote = "";
  for (; i < appSource.length; i += 1) {
    const ch = appSource[i];
    if (quote) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === "'" || ch === "\"") quote = ch;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (!depth) return appSource.slice(start, i + 1);
    }
  }
  throw new Error(`Could not read function ${name}`);
}

function constLine(name) {
  const hit = new RegExp(`^const ${name} = [^;]+;`, "m").exec(appSource);
  if (!hit) throw new Error(`app.js has no const ${name}`);
  return hit[0].replace(/^const /, "var ");
}

const APP_FUNCTIONS = [
  "metersBetween", "polylineMeters", "stepLengthMeters", "scaledStepLengths", "navStep", "metersLeftInStep",
  "navBearing", "hasRouteLine", "copyRouteLine", "stopHasSavedLeg", "readDriveProgress", "applyStoredTrip",
  "tripProgressKey", "readNavProgress", "readNavSpot", "writeNavProgress", "clearNavProgress",
  "rememberNavProgress", "saveNavSpot", "restoreNavSpot", "rebuildNavLegs", "navNearest", "guardResumedHit",
  "navMatchSpan", "leaveSpanWhenDriven", "activeNavLeg", "routePoints", "routeProgressKey", "applyAheadLeg",
];
const APP_CODE = [
  constLine("NAV_PROGRESS_KEY"),
  constLine("RESUME_CONFIRM_FIXES"),
  constLine("RESUME_AGREE_M"),
  constLine("RESUME_PARKED_M"),
  ...APP_FUNCTIONS.map(extract),
].join("\n\n");

function fakeStorage(seed = {}) {
  const data = new Map(Object.entries(seed));
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
    dump: () => Object.fromEntries(data),
  };
}

let idCount = 0;

// One page load: fresh module globals, shared localStorage.
function page(storage) {
  const context = {
    console, Math, Number, String, JSON, Array, Object, Infinity, NaN, Date, Set, Map,
    ...navMatch,
    localStorage: storage,
    state: { stops: [], origin: null, tripName: "", activeTripId: "trip-1", trips: [], plan: null, driveProgress: null },
    navLine: [], navLegs: [], navAlongLock: null, navResumeGuard: null, navLeave: null, navLineKey: "", navTravel: null,
    navOn: false, navAimStopId: "", navSpotSavedAlong: null, navFix: null,
    navStopCursor: 0, navStopPicked: false, navGuideFromId: "", navStopAwaitNear: false, navStopAnnounce: false, navStopSpeakKey: "",
    defaultStop: (over = {}) => ({ id: `cl-${++idCount}`, name: "", address: "", miles: "", hours: "", ...over }),
    navDestList: () => [],
    clearStopNote: () => {},
    rememberOrigin: () => {},
    persist: () => {},
  };
  vm.createContext(context);
  vm.runInContext(APP_CODE, context);
  return context;
}

// --- A long road: Dayton -> Columbus -> I-70 E -> PA Turnpike -> Downingtown. ---

function densify(points, stepM = 150) {
  const out = [points[0]];
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    const n = Math.max(1, Math.ceil(navMatch.metersBetween(a, b) / stepM));
    for (let k = 1; k <= n; k += 1) {
      const t = k / n;
      // A gentle bend so the road is not a ruler line.
      const bend = Math.sin(t * Math.PI) * 0.01 * Math.sin(i * 1.7);
      out.push([a[0] + (b[0] - a[0]) * t + bend, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

const PLACES = {
  dayton: [39.7589, -84.1916],
  columbus: [39.9612, -82.9988],
  zanesville: [39.9403, -82.0132],
  cambridge: [40.0312, -81.5885],
  wheeling: [40.0640, -80.7209],
  westAlexander: [40.1037, -80.5098],
  washington: [40.1740, -80.2462],
  newStanton: [40.2195, -79.6098],
  somerset: [40.0084, -79.0781],
  bedford: [40.0187, -78.5039],
  breezewood: [39.9987, -78.2425],
  carlisle: [40.2015, -77.1889],
  harrisburg: [40.2204, -76.7997],
  reading: [40.1879, -76.1785],
  exit312: [40.0590, -75.7280],
  pactiv: [40.0410, -75.7050],
};

const WAY = ["columbus", "zanesville", "cambridge", "wheeling", "westAlexander", "washington", "newStanton",
  "somerset", "bedford", "breezewood", "carlisle", "harrisburg", "reading", "exit312", "pactiv"];
const road = densify(WAY.map((key) => PLACES[key]));
const roadAlong = [0];
for (let i = 1; i < road.length; i += 1) roadAlong.push(roadAlong[i - 1] + navMatch.metersBetween(road[i - 1], road[i]));
const roadLength = roadAlong[roadAlong.length - 1];
const placeAlong = (key) => navMatch.nearestOnPath(PLACES[key][0], PLACES[key][1], road).along;

function pointAt(along) {
  const m = Math.max(0, Math.min(roadLength, along));
  let i = 1;
  while (i < roadAlong.length - 1 && roadAlong[i] < m) i += 1;
  const seg = roadAlong[i] - roadAlong[i - 1];
  const t = seg > 0 ? (m - roadAlong[i - 1]) / seg : 0;
  return [road[i - 1][0] + (road[i][0] - road[i - 1][0]) * t, road[i - 1][1] + (road[i][1] - road[i - 1][1]) * t];
}

function slice(from, to) {
  const pts = [pointAt(from)];
  for (let i = 0; i < road.length; i += 1) if (roadAlong[i] > from && roadAlong[i] < to) pts.push(road[i]);
  pts.push(pointAt(to));
  return pts;
}

const MANEUVERS = [
  { key: "newStanton", text: "Take the I-76 E ramp (Pennsylvania Tpke)" },
  { key: "harrisburg", text: "Continue on I-76 E (Pennsylvania Tpke)" },
  { key: "exit312", text: "Take exit 312 toward Downingtown onto PA-100 (N Pottstown Pike)" },
  { key: "pactiv", text: "Arrive at PACTIV" },
].map((item) => ({ ...item, along: placeAlong(item.key) }));

// What HERE hands back for a leg on this road: points, miles, and steps whose
// text names the maneuver at the end of each step.
function routedLeg(from, to) {
  const points = slice(from, to);
  const meters = lineMeters(points);
  const directions = [];
  let at = from;
  for (const item of MANEUVERS) {
    if (item.along <= from + 50 || item.along > to + 1) continue;
    directions.push({ text: item.text, miles: (Math.min(item.along, to) - at) / MILE });
    at = Math.min(item.along, to);
  }
  return { points, miles: meters / MILE, hours: meters / MILE / 62, directions };
}

function lineMeters(points) {
  let sum = 0;
  for (let i = 1; i < points.length; i += 1) sum += navMatch.metersBetween(points[i - 1], points[i]);
  return sum;
}

// A GPS fix a little to the side of the road, like a phone gives.
function fixAt(along) {
  const [lat, lon] = pointAt(along);
  return [lat + 0.00012, lon];
}

// --- What the page shows for a fix (the same lines onNavFix runs). ---

function readout(pg, along) {
  const [lat, lon] = fixAt(along);
  if (pg.navFix && pg.metersBetween(pg.navFix, [lat, lon]) > 8) pg.navTravel = pg.navBearing(pg.navFix, [lat, lon]);
  pg.navFix = [lat, lon];
  pg.rebuildNavLegs();
  const hit = pg.navNearest(lat, lon, pg.navLine);
  const leg = pg.activeNavLeg(hit);
  const gap = Math.max(0, leg.start - hit.along);
  const alongInLeg = Math.max(0, hit.along - leg.start);
  const found = pg.navStep(leg, alongInLeg);
  const leftInStep = pg.metersLeftInStep(leg, alongInLeg, found.index) + gap;
  const leftOnLeg = Math.max(0, leg.end - hit.along);
  const span = Math.max(1, leg.end - leg.start);
  const fraction = Math.min(1, Math.max(0, (hit.along - leg.start) / span));
  const legMiles = Number(leg.stop.miles) > 0.05 ? Number(leg.stop.miles) : span / MILE;
  return {
    chipMiles: leftOnLeg / MILE,
    step: found.step.text,
    stepMiles: leftInStep / MILE,
    driveChipMiles: legMiles * (1 - fraction),
    dist: hit.dist,
  };
}

function drive(pg, from, to, every = 400) {
  for (let m = from; m <= to; m += every) readout(pg, m);
  return readout(pg, to);
}

// The page's Recalculate: a new HERE leg from here to the stop, written by applyAheadLeg.
function recalculate(pg, along) {
  const [lat, lon] = fixAt(along);
  const leg = routedLeg(along, placeAlong("pactiv"));
  pg.applyAheadLeg({ lat, lon }, "pactiv", leg);
  pg.navAlongLock = null;
  pg.rebuildNavLegs();
  pg.navLineKey = pg.routeProgressKey(pg.routePoints());
}

function savedPage(pg) {
  return JSON.stringify({ stops: pg.state.stops, origin: pg.state.origin, activeTripId: pg.state.activeTripId, trips: [], tripName: "" });
}

// A refresh: new page, same localStorage, the signed-in account copy fills
// any road line it still has (fillTripGeometry while navigating), then resume.
function reload(storage, saved, account) {
  const pg = page(storage);
  pg.applyStoredTrip(pg.state, JSON.parse(saved));
  if (account) pg.state.stops = pg.copyRouteLine(pg.state.stops, account);
  const progress = pg.readNavProgress();
  pg.navAimStopId = progress?.aimId || "";
  pg.navOn = true;
  pg.navLineKey = pg.routeProgressKey(pg.routePoints());
  pg.restoreNavSpot();
  return pg;
}

function truthAt(storage, saved, along) {
  const pg = reload(fakeStorage(storage.dump()), saved, null);
  drive(pg, along - 1000, along, 100);
  recalculate(pg, along);
  return readout(pg, along);
}

// --- The trip. ---

const columbusAlong = placeAlong("columbus");
const daytonLeg = densify([PLACES.dayton, PLACES.columbus]);
const plannedStops = () => [
  { id: "start", name: "Start", lat: PLACES.dayton[0], lon: PLACES.dayton[1], miles: "", hours: "" },
  { id: "pickup", name: "Columbus pickup", lat: PLACES.columbus[0], lon: PLACES.columbus[1], miles: String(lineMeters(daytonLeg) / MILE), hours: "1.2", path: daytonLeg, directions: [{ text: "Arrive at Columbus pickup", miles: lineMeters(daytonLeg) / MILE }] },
  (() => {
    const leg = routedLeg(columbusAlong, placeAlong("pactiv"));
    return { id: "pactiv", name: "PACTIV", lat: PLACES.pactiv[0], lon: PLACES.pactiv[1], miles: String(leg.miles), hours: String(leg.hours), path: leg.points, directions: leg.directions };
  })(),
  (() => {
    // The next stop runs back west on the same turnpike.
    const back = slice(placeAlong("harrisburg"), placeAlong("pactiv")).reverse();
    return { id: "harrisburg", name: "Harrisburg", lat: PLACES.harrisburg[0], lon: PLACES.harrisburg[1], miles: String(lineMeters(back) / MILE), hours: "1.6", path: back, directions: [{ text: "Arrive at Harrisburg", miles: lineMeters(back) / MILE }] };
  })(),
];

let failures = 0;

function check(label, a, b, tol = 1) {
  const ok = Math.abs(a - b) <= tol;
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${a.toFixed(1)} vs ${b.toFixed(1)} mi (off ${(a - b).toFixed(1)})`);
}

function refreshCase(title, pg, storage, along, account) {
  console.log(`\n${title}`);
  const before = readout(pg, along);
  const saved = savedPage(pg);
  const after = reload(fakeStorage(storage.dump()), saved, account);
  // He keeps driving through the refresh: a few fixes on the way to the check.
  const back = drive(after, along - 1000, along, 100);
  const stale = after.state.stops.filter((stop) => stop.skipRoute && !after.stopHasSavedLeg(stop) && Array.isArray(stop.path) && stop.path.length > 1);
  if (stale.length) {
    failures += 1;
    console.log(`FAIL after refresh a stop Recalculate routed past has its old road line back: ${stale.map((stop) => stop.name).join(", ")}`);
  }
  const truth = truthAt(storage, saved, along);
  if (back.dist > 250) {
    failures += 1;
    console.log(`FAIL after refresh the page says "Not on the route yet" (${back.dist.toFixed(0)} m from the matched point)`);
  }
  console.log(`     before: chip ${before.chipMiles.toFixed(1)} mi, "${before.step}" in ${before.stepMiles.toFixed(1)} mi`);
  console.log(`     after:  chip ${back.chipMiles.toFixed(1)} mi, "${back.step}" in ${back.stepMiles.toFixed(1)} mi`);
  console.log(`     recalc: chip ${truth.chipMiles.toFixed(1)} mi, "${truth.step}" in ${truth.stepMiles.toFixed(1)} mi`);
  check("ETA chip miles, after refresh vs before", back.chipMiles, before.chipMiles);
  check("ETA chip miles, after refresh vs Recalculate", back.chipMiles, truth.chipMiles);
  check("current direction miles, after refresh vs Recalculate", back.stepMiles, truth.stepMiles);
  check("drive chip miles left, after refresh vs Recalculate", back.driveChipMiles, truth.driveChipMiles);
  if (back.step !== truth.step) {
    failures += 1;
    console.log(`FAIL current direction differs: "${back.step}" vs "${truth.step}"`);
  }
}

const storage = fakeStorage();
const live = page(storage);
live.state.stops = plannedStops();
// The account copy of the trip as planned, before any Recalculate.
const accountCopy = JSON.parse(JSON.stringify(live.state.stops));
live.state.stops[1].done = true;
live.state.stops[1].skipRoute = true;
live.navOn = true;
live.navAimStopId = "pactiv";
live.rememberNavProgress();
live.rebuildNavLegs();
live.navLineKey = live.routeProgressKey(live.routePoints());

const zanesville = placeAlong("zanesville");
const westAlexander = placeAlong("westAlexander");
const somerset = placeAlong("somerset");

drive(live, columbusAlong + 500, zanesville + 4 * MILE);
recalculate(live, zanesville + 4 * MILE);
console.log(`Route: ${(roadLength / MILE).toFixed(0)} mi of road from Columbus to PACTIV. Recalculated near Zanesville.`);

drive(live, zanesville + 4 * MILE, westAlexander);
refreshCase("Refresh at West Alexander (no account fill)", live, storage, westAlexander, null);
refreshCase("Refresh at West Alexander (account copy fills passed stops)", live, storage, westAlexander, accountCopy);

recalculate(live, westAlexander);
console.log("\nRecalculated at West Alexander.");
drive(live, westAlexander, somerset);
refreshCase("Refresh near Somerset on I-76 E (no account fill)", live, storage, somerset, null);
refreshCase("Refresh near Somerset on I-76 E (account copy fills passed stops)", live, storage, somerset, accountCopy);

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
