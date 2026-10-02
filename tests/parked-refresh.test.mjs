// A refresh while parked a little off the route must keep the current stop's
// leg and step. Not loaded by the site. Run: node tests/parked-refresh.test.mjs
//
// Two legs whose lines run side by side: PACTIV east on the PA Turnpike, then
// WALMARpu back west on the other carriageway. The truck pulls into a median
// service plaza near Fort Littleton, about 300 m off the eastbound line and
// about 120 m from the westbound one, parks, and refreshes. Loads the real
// functions from js/app.js (by name, into a vm sandbox) and js/nav-match.js,
// and checks what the page would show for each GPS fix (the same lines
// onNavFix runs): which leg, which direction row, miles left, no arrival.

import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appSource = readFileSync(path.join(root, "js/app.js"), "utf8");
const navMatch = await import(pathToFileURL(path.join(root, "js/nav-match.js")).href);

const MILE = 1609.344;

function extract(name, optional = false) {
  const head = new RegExp(`^(?:async\\s+)?function\\s+${name}\\s*\\(`, "m").exec(appSource);
  if (!head) {
    if (optional) return "";
    throw new Error(`app.js has no function ${name}`);
  }
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
    if (ch === "'" || ch === "\"" || ch === "`") quote = ch;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (!depth) return appSource.slice(start, i + 1);
    }
  }
  throw new Error(`Could not read function ${name}`);
}

function constLine(name, optional = false) {
  const hit = new RegExp(`^const ${name} = [^;]+;`, "m").exec(appSource);
  if (!hit) {
    if (optional) return "";
    throw new Error(`app.js has no const ${name}`);
  }
  return hit[0].replace(/^const /, "var ");
}

const APP_FUNCTIONS = [
  "metersBetween", "polylineMeters", "stepLengthMeters", "scaledStepLengths", "navStep", "metersLeftInStep",
  "navBearing", "tripProgressKey", "readNavProgress", "readNavSpot", "writeNavProgress", "clearNavProgress",
  "rememberNavProgress", "saveNavSpot", "restoreNavSpot", "rebuildNavLegs", "navNearest", "guardResumedHit",
  "activeNavLeg", "routePoints", "routeProgressKey",
];
// Not in every build. The old page runs without them, so this test can show it failing.
const OPTIONAL_FUNCTIONS = ["navMatchSpan", "leaveSpanWhenDriven", "navOffRoute"];
const APP_CODE = [
  constLine("NAV_PROGRESS_KEY"),
  constLine("RESUME_CONFIRM_FIXES"),
  constLine("RESUME_AGREE_M"),
  constLine("RESUME_PARKED_M", true),
  constLine("RESUME_DRIVEN_M", true),
  ...APP_FUNCTIONS.map((name) => extract(name)),
  ...OPTIONAL_FUNCTIONS.map((name) => extract(name, true)),
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

// One page load: fresh module globals, shared localStorage.
function page(storage) {
  const context = {
    console, Math, Number, String, JSON, Array, Object, Infinity, NaN, Date, Set, Map,
    ...navMatch,
    localStorage: storage,
    state: { stops: [], origin: null, tripName: "", activeTripId: "trip-1", trips: [] },
    navLine: [], navLegs: [], navAlongLock: null, navResumeGuard: null, navLeave: null, navLineKey: "",
    navTravel: null, navOn: false, navAimStopId: "", navSpotSavedAlong: null, navFix: null,
    originPoint: () => null,
  };
  vm.createContext(context);
  vm.runInContext(APP_CODE, context);
  return context;
}

// --- The roads, in meters east (x) and north (y) of Fort Littleton, PA. ---

const ORIGIN = [40.06, -77.96];
const COS = Math.cos(ORIGIN[0] * Math.PI / 180);
const ll = (x, y) => [ORIGIN[0] + y / 111320, ORIGIN[1] + x / (111320 * COS)];
// The turnpike's gentle bends. Eastbound runs on this line.
const bend = (x) => 60 * Math.sin(x / 9000);
// The westbound carriageway, on the far side of the median plaza.
const SPLIT_M = 420;
const PLAZA = { x: 0, y: bend(0) + 300 };

function line(xFrom, xTo, yOff = 0, stepM = 200) {
  const out = [];
  const n = Math.ceil(Math.abs(xTo - xFrom) / stepM);
  for (let k = 0; k <= n; k += 1) {
    const x = xFrom + (xTo - xFrom) * (k / n);
    out.push([x, bend(x) + yOff]);
  }
  return out;
}

const meters = (pts) => {
  let sum = 0;
  for (let i = 1; i < pts.length; i += 1) sum += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return sum;
};

// A leg from pieces of road, one direction row per piece. Each row's miles
// are the real length of its piece, so the rows line up with the line.
function leg(pieces) {
  const pts = [];
  const directions = [];
  for (const piece of pieces) {
    const run = pts.length ? [pts[pts.length - 1], ...piece.pts] : piece.pts;
    directions.push({ text: piece.text, miles: meters(run) / MILE });
    pts.push(...piece.pts);
  }
  const pathLL = pts.map(([x, y]) => ll(x, y));
  return { path: pathLL, directions, miles: String(meters(pts) / MILE) };
}

const RAMP_END_X = -32000 + 2414;
const pactivLeg = leg([
  { text: "Head north on US-30 E.", pts: [[-32000, -800], [-32000, bend(-32000)]] },
  { text: "Take the ramp onto I-76 E (Pennsylvania Tpke).", pts: line(-32000, RAMP_END_X).slice(1) },
  { text: "Continue on I-76 E (Pennsylvania Tpke).", pts: line(RAMP_END_X, 150000).slice(1) },
  { text: "Take exit 312 toward Downingtown onto PA-100 (N Pottstown Pike).", pts: [[150300, bend(150000) - 600]] },
  { text: "Turn right onto PA-100 S.", pts: [[150300, -2000]] },
  { text: "Turn left onto Boot Rd.", pts: [[150750, -2000]] },
  { text: "Turn right onto Commerce Dr.", pts: [[151000, -2000]] },
  { text: "Turn left.", pts: [[151200, -2000]] },
  { text: "Arrive at your destination on the left.", pts: [] },
]);
pactivLeg.directions[pactivLeg.directions.length - 1].miles = 0;

const walmartLeg = leg([
  { text: "Head west. Go for 0.1 mi.", pts: [[151200, -2000], [151039, -2000]] },
  { text: "Turn right onto Woodbine Rd.", pts: [[151039, bend(151039) + SPLIT_M]] },
  { text: "Take the I-76 W ramp (Pennsylvania Tpke).", pts: line(151039, 148000, SPLIT_M).slice(1) },
  { text: "Continue on I-76 W (Pennsylvania Tpke).", pts: line(148000, -60000, SPLIT_M).slice(1) },
  { text: "Take exit 161 toward WALMART.", pts: [[-60000, 1500]] },
  { text: "Arrive at WALMARpu", pts: [] },
]);
walmartLeg.directions[walmartLeg.directions.length - 1].miles = 0;

const plannedStops = () => JSON.parse(JSON.stringify([
  { id: "start", name: "Start", lat: ll(-32000, -800)[0], lon: ll(-32000, -800)[1], miles: "", hours: "" },
  { id: "pactiv", name: "PACTIV", lat: ll(151200, -2000)[0], lon: ll(151200, -2000)[1], miles: pactivLeg.miles, hours: "2.4", path: pactivLeg.path, directions: pactivLeg.directions },
  { id: "walmart", name: "WALMARpu", lat: ll(-60000, 1500)[0], lon: ll(-60000, 1500)[1], miles: walmartLeg.miles, hours: "3.4", path: walmartLeg.path, directions: walmartLeg.directions },
]));

const CONTINUE_ROW = 2;
const PACTIV_LAST_ROW = pactivLeg.directions.length - 1;
// PACTIV-leg meters at the plaza: the turnpike start, then along the bends to x = 0.
const PLAZA_LEG_M = meters([[-32000, -800], [-32000, bend(-32000)], ...line(-32000, 0).slice(1)]);
const PACTIV_LEG_M = Number(pactivLeg.miles) * MILE;
const PLAZA_LEFT_MI = (PACTIV_LEG_M - PLAZA_LEG_M) / MILE;

// --- What the page shows for a fix (the same lines onNavFix runs). ---

function readout(pg, x, y) {
  const [lat, lon] = ll(x, y);
  if (pg.navFix && pg.metersBetween(pg.navFix, [lat, lon]) > 8) pg.navTravel = pg.navBearing(pg.navFix, [lat, lon]);
  pg.navFix = [lat, lon];
  pg.rebuildNavLegs();
  // noteArrivedStops matches the same fix just before onNavFix does.
  pg.navNearest(lat, lon, pg.navLine);
  const hit = pg.navNearest(lat, lon, pg.navLine);
  const off = typeof pg.navOffRoute === "function" ? pg.navOffRoute(hit) : hit.dist > 250;
  const raw = pg.navLegs.find((item) => hit.along >= item.start && hit.along <= item.end) || pg.navLegs[pg.navLegs.length - 1];
  const legNow = pg.activeNavLeg(hit);
  const found = legNow && (!off || raw?.stop?.done) ? pg.navStep(legNow, Math.max(0, hit.along - legNow.start)) : null;
  const span = typeof pg.navMatchSpan === "function" ? pg.navMatchSpan() : null;
  return {
    stopId: legNow?.stop?.id || "",
    onLeg: raw?.stop?.id || "",
    row: found ? found.index : null,
    step: found ? found.step.text : "Not on the route yet",
    leftMiles: legNow ? Math.max(0, legNow.end - hit.along) / MILE : 0,
    dist: hit.dist,
    // "N mi from the line" under "Not on the route yet".
    away: Math.min(hit.dist, pg.nearestOnPath(lat, lon, pg.navLine, span).dist),
  };
}

let seed = 7;
const jitter = (m) => {
  seed = (seed * 16807) % 2147483647;
  return ((seed / 2147483647) * 2 - 1) * m;
};

function driveEast(pg, xFrom, xTo, every = 150) {
  let last = null;
  for (let x = xFrom; x <= xTo; x += every) last = readout(pg, x, bend(x) + 12);
  return last;
}

// Off the eastbound lanes into the plaza, slowly, then parked.
function pullIntoPlaza(pg) {
  const out = [];
  for (let k = 1; k <= 16; k += 1) {
    const t = k / 16;
    out.push(readout(pg, PLAZA.x - 600 * (1 - t), bend(PLAZA.x - 600 * (1 - t)) + 12 + (PLAZA.y - bend(0) - 12) * t));
  }
  return out;
}

function parked(pg, fixes = 8) {
  const out = [];
  for (let k = 0; k < fixes; k += 1) out.push(readout(pg, PLAZA.x + jitter(12), PLAZA.y + jitter(12)));
  return out;
}

function startLive(storage) {
  const pg = page(storage);
  pg.state.stops = plannedStops();
  pg.navOn = true;
  pg.navAimStopId = "pactiv";
  pg.rememberNavProgress();
  pg.rebuildNavLegs();
  pg.navLineKey = pg.routeProgressKey(pg.routePoints());
  return pg;
}

// A refresh: new page, same localStorage and trip, resume navigation.
function reload(storage, stops) {
  const pg = page(storage);
  pg.state.stops = JSON.parse(JSON.stringify(stops));
  const progress = pg.readNavProgress();
  pg.navAimStopId = progress?.aimId || "";
  pg.navOn = true;
  pg.navLineKey = pg.routeProgressKey(pg.routePoints());
  pg.restoreNavSpot();
  return pg;
}

let failures = 0;

function expect(label, ok, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`);
}

function show(r) {
  return `${r.stopId} leg, row ${r.row == null ? "-" : r.row + 1} "${r.step}", ${r.leftMiles.toFixed(1)} mi left, matched on ${r.onLeg} leg ${r.dist.toFixed(0)} m away`;
}

// Parked mid-step 3 of the PACTIV leg: same leg, same row, same miles, no arrival.
function expectStillMidStep(label, reads, { allowOffRoute = false } = {}) {
  const bad = reads.find((r) => (
    r.stopId !== "pactiv"
    || r.onLeg !== "pactiv"
    || r.row === PACTIV_LAST_ROW
    || Math.abs(r.leftMiles - PLAZA_LEFT_MI) > 1
    || (allowOffRoute ? (r.row != null && r.row !== CONTINUE_ROW) : r.row !== CONTINUE_ROW)
  ));
  expect(label, !bad, show(bad || reads[reads.length - 1]));
}

console.log(`PACTIV leg ${(PACTIV_LEG_M / MILE).toFixed(1)} mi. Plaza ${PLAZA_LEFT_MI.toFixed(1)} mi before PACTIV, 300 m off the eastbound line, ${(SPLIT_M - 300)} m from the westbound WALMARpu line.`);

console.log("\nDrive east, pull into the median plaza, park, refresh");
{
  const storage = fakeStorage();
  const live = startLive(storage);
  const onRoad = driveEast(live, -31000, -600);
  expect("on the turnpike before the plaza: row 3 of PACTIV", onRoad.stopId === "pactiv" && onRoad.row === CONTINUE_ROW, show(onRoad));
  const entering = pullIntoPlaza(live);
  const sitting = parked(live);
  const noArrive = [...entering, ...sitting].find((r) => r.onLeg !== "pactiv" || r.row === PACTIV_LAST_ROW || r.leftMiles < 1);
  expect("pulling in and parked (no refresh): never on the WALMARpu line, never arrived", !noArrive, show(noArrive || sitting[sitting.length - 1]));
  const after = reload(storage, live.state.stops);
  expectStillMidStep("after refresh, parked: PACTIV row 3, miles left unchanged, no arrival", parked(after));
}

console.log("\nSaved spot on the eastbound line, first fixes after the refresh are in the plaza");
{
  const storage = fakeStorage();
  const live = startLive(storage);
  driveEast(live, -31000, -300);
  const after = reload(storage, live.state.stops);
  expectStillMidStep("after refresh, parked: PACTIV row 3, miles left unchanged, no arrival", parked(after, 10));
}

console.log("\nNo saved spot on this phone, refresh while parked in the plaza");
{
  const storage = fakeStorage();
  const live = startLive(storage);
  driveEast(live, -31000, -300);
  const progress = live.readNavProgress();
  live.writeNavProgress({ ...progress, spot: null });
  const after = reload(storage, live.state.stops);
  expectStillMidStep("after refresh, parked: still the PACTIV leg at the plaza, no arrival", parked(after), { allowOffRoute: true });
}

console.log("\nAfter the parked refresh he drives west on the WALMARpu line without pressing Done");
{
  const storage = fakeStorage();
  const live = startLive(storage);
  driveEast(live, -31000, -300);
  const after = reload(storage, live.state.stops);
  parked(after, 4);
  const reads = [];
  // Out of the plaza onto the westbound lanes, then west.
  for (let x = 0; x >= -2500; x -= 60) reads.push(readout(after, x, bend(x) + SPLIT_M - 10));
  const strayed = reads.find((r) => r.stopId !== "pactiv" || r.onLeg !== "pactiv" || r.row === PACTIV_LAST_ROW);
  expect("every fix: still PACTIV, matched only on the PACTIV line, never its arrival", !strayed, show(strayed || reads[reads.length - 1]));
  const end = reads[reads.length - 1];
  expect("after 2.5 km on the other carriageway: \"Not on the route yet\", the right distance from the PACTIV line", end.row == null && Math.abs(end.away - (SPLIT_M - 10)) < 60, `${show(end)}, shows ${end.away.toFixed(0)} m from the line`);
}

console.log("\nNo refresh: drive the whole PACTIV leg on the turnpike");
{
  const storage = fakeStorage();
  const live = startLive(storage);
  const mid = driveEast(live, -31000, 60000, 300);
  expect("mid-turnpike: PACTIV row 3", mid.stopId === "pactiv" && mid.row === CONTINUE_ROW, show(mid));
  const end = driveEast(live, 60000, 150000, 300);
  expect("at exit 312: still PACTIV, not arrived", end.stopId === "pactiv" && end.onLeg === "pactiv" && end.row >= CONTINUE_ROW && end.row < PACTIV_LAST_ROW && end.leftMiles > 1, show(end));
}

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
