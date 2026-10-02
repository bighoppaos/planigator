// Navigation stays on the stop being driven to until the driver picks the
// next stop and presses Done. Not loaded by the site.
// Run: node tests/stop-stays.test.mjs
//
// Same roads as parked-refresh: PACTIV east on the PA Turnpike, then WALMARpu
// back west on the other carriageway, with a median service plaza between
// them. Loads the real onNavFix, Update times, stop pick and Done functions
// from js/app.js (by name, into a vm sandbox) with the map and DOM stubbed,
// and checks the current stop, the highlighted direction row, and the green
// banner text for each GPS fix.

import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appSource = readFileSync(path.join(root, "js/app.js"), "utf8");
const navMatch = await import(pathToFileURL(path.join(root, "js/nav-match.js")).href);
const { isOriginStop } = await import(pathToFileURL(path.join(root, "js/plan.js")).href);

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
    if (ch === "/" && appSource[i + 1] === "/") {
      i = appSource.indexOf("\n", i);
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
  "readLeftLeg", "leftLegKey", "openLeftLeg",
  "rememberNavProgress", "saveNavSpot", "restoreNavSpot", "rebuildNavLegs", "navNearest", "guardResumedHit",
  "activeNavLeg", "routePoints", "routeProgressKey", "onNavFix", "noteArrivedStops", "navMiles", "navStopTitle",
  "withoutGo", "maneuverText", "inDistance", "approachPhrase", "spokenApproach", "directionWithMilesLeft",
  "upcomingDirection", "updateTimesFromHere", "legStillCounts", "nextTimedStop", "stopHasSavedLeg", "markStopDone",
  "aimNavAtStop", "confirmStopSwitch", "navDestList", "pointReady", "formatMiles",
];
// Not in every build. The old page runs without them, so this test can show it failing.
const OPTIONAL_FUNCTIONS = ["navMatchSpan", "leaveSpanWhenDriven", "navOffRoute", "bannerDirection"];
const APP_CODE = [
  constLine("NAV_PROGRESS_KEY"),
  constLine("RESUME_CONFIRM_FIXES"),
  constLine("RESUME_AGREE_M"),
  constLine("RESUME_PARKED_M", true),
  constLine("RESUME_DRIVEN_M", true),
  constLine("STOP_ARRIVE_M"),
  ...APP_FUNCTIONS.map((name) => extract(name)),
  ...OPTIONAL_FUNCTIONS.map((name) => extract(name, true)),
].join("\n\n");

function fakeStorage(seed = {}) {
  const data = new Map(Object.entries(seed));
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
}

const noop = () => {};

// One page load: fresh module globals, shared localStorage. The map and the
// page are stubs; the banner, the highlighted row and the ETA chip are kept.
function page(storage) {
  const elements = {};
  const context = {
    console, Math, Number, String, JSON, Array, Object, Infinity, NaN, Date, Set, Map, RegExp, Promise,
    ...navMatch,
    isOriginStop,
    localStorage: storage,
    document: { getElementById: (id) => (elements[id] ||= { id, hidden: true, textContent: "", innerHTML: "" }) },
    window: { maplibregl: {}, clearTimeout: noop },
    elements,
    state: {
      stops: [], origin: null, tripName: "", activeTripId: "trip-1", trips: [], settings: { kilometers: false },
      plan: null, driveProgress: null, updatingTimes: false, estimating: false, error: "", notice: "",
    },
    navLine: [], navLegs: [], navAlongLock: null, navResumeGuard: null, navLeave: null, navLineKey: "",
    navTravel: null, navOn: false, navAimStopId: "", navSpotSavedAlong: null, navFix: null, navFixAt: 0,
    routeMap: {}, navYou: {}, tripFit: "full", navFollowing: false, navMapTouch: false, placeSeek: false,
    truckHits: [], navZoomHold: 0, routeFull: false, routePageStale: false, navCompass: null,
    pendingAimId: "", railMenu: "", navStopCursor: 0, navStopPicked: false, navGuideFromId: "",
    navStopAwaitNear: false, navStopAnnounce: false, followPinned: false, navReturnTimer: 0,
    banner: { title: "", sub: "" }, marked: null, chip: null, fixAt: null,
    sayNav: (title, sub) => { context.banner = { title, sub }; },
    markDirection: (stopId, index) => { context.marked = { stopId, index }; },
    setStopChip: (meters, name) => { context.chip = { meters, name }; },
    currentFix: async () => context.fixAt,
    calculate: async () => {},
    originPoint: () => null,
  };
  for (const name of [
    "placeNavDot", "aimNavDot", "startNavMotion", "resumeTurnZoom", "paintCompassRose", "queueBasemap", "refreshPlace",
    "paintRouteLines", "paintDrive", "paintSwitchOffer", "paintNavLine", "clearStopNote", "trackLiveDrive",
    "paintDirectionMiles", "openDirectionsNear", "speakNavProgress", "paintDirectionToward", "frameNextTurn",
    "frameNextStop", "persist", "render", "paintDoneStop", "rebuildPlanAfterDone", "keepDoneOnSavedTrip",
    "paintRailMenus", "speakNav", "clearDirectionPin", "clearTurnFrame", "showStopNote", "unlockMix", "beginRouteNav",
    "syncRouteChrome",
  ]) context[name] = noop;
  context.styleIsBasemap = () => true;
  context.calculateButtonLabel = () => "";
  vm.createContext(context);
  vm.runInContext(APP_CODE, context);
  return context;
}

// --- The roads, in meters east (x) and north (y) of Fort Littleton, PA. ---

const ORIGIN = [40.06, -77.96];
const COS = Math.cos(ORIGIN[0] * Math.PI / 180);
const ll = (x, y) => [ORIGIN[0] + y / 111320, ORIGIN[1] + x / (111320 * COS)];
const bend = (x) => 60 * Math.sin(x / 9000);
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

function leg(pieces) {
  const pts = [];
  const directions = [];
  for (const piece of pieces) {
    const run = pts.length ? [pts[pts.length - 1], ...piece.pts] : piece.pts;
    directions.push({ text: piece.text, miles: meters(run) / MILE });
    pts.push(...piece.pts);
  }
  directions[directions.length - 1].miles = 0;
  return { pts, path: pts.map(([x, y]) => ll(x, y)), directions, miles: String(meters(pts) / MILE) };
}

const RAMP_END_X = -32000 + 2414;
const PACTIV_END = [151200, -2000];
const pactivLeg = leg([
  { text: "Head north on US-30 E.", pts: [[-32000, -800], [-32000, bend(-32000)]] },
  { text: "Take the ramp onto I-76 E (Pennsylvania Tpke).", pts: line(-32000, RAMP_END_X).slice(1) },
  { text: "Continue on I-76 E (Pennsylvania Tpke).", pts: line(RAMP_END_X, 150000).slice(1) },
  { text: "Take exit 312 toward Downingtown onto PA-100 (N Pottstown Pike).", pts: [[150300, bend(150000) - 600]] },
  { text: "Turn right onto PA-100 S.", pts: [[150300, -2000]] },
  { text: "Turn left onto Boot Rd.", pts: [[150750, -2000]] },
  { text: "Turn right onto Commerce Dr.", pts: [[151000, -2000]] },
  { text: "Turn left.", pts: [PACTIV_END] },
  { text: "Arrive at your destination on the left.", pts: [] },
]);

const walmartLeg = leg([
  { text: "Head west. Go for 0.1 mi.", pts: [PACTIV_END, [151039, -2000]] },
  { text: "Turn right onto Woodbine Rd.", pts: [[151039, bend(151039) + SPLIT_M]] },
  { text: "Take the I-76 W ramp (Pennsylvania Tpke).", pts: line(151039, 148000, SPLIT_M).slice(1) },
  { text: "Continue on I-76 W (Pennsylvania Tpke).", pts: line(148000, -60000, SPLIT_M).slice(1) },
  { text: "Take exit 161 toward WALMART.", pts: [[-60000, 1500]] },
  { text: "Arrive at WALMARpu", pts: [] },
]);

const plannedStops = ({ walmart = true } = {}) => JSON.parse(JSON.stringify([
  { id: "start", name: "Start", lat: ll(-32000, -800)[0], lon: ll(-32000, -800)[1], miles: "", hours: "" },
  { id: "pactiv", name: "PACTIV", lat: ll(...PACTIV_END)[0], lon: ll(...PACTIV_END)[1], miles: pactivLeg.miles, hours: "2.4", path: pactivLeg.path, directions: pactivLeg.directions },
  ...(walmart ? [{ id: "walmart", name: "WALMARpu", lat: ll(-60000, 1500)[0], lon: ll(-60000, 1500)[1], miles: walmartLeg.miles, hours: "3.4", path: walmartLeg.path, directions: walmartLeg.directions }] : []),
]));

const PACTIV_LAST_ROW = pactivLeg.directions.length - 1;
const PLAZA_LEG_M = meters([[-32000, -800], [-32000, bend(-32000)], ...line(-32000, 0).slice(1)]);
const PLAZA_LEFT_MI = (Number(pactivLeg.miles) * MILE - PLAZA_LEG_M) / MILE;
const WALMART_TEXTS = walmartLeg.directions.slice(1).map((step) => step.text.replace(/\.$/, ""));

// --- One GPS fix through the real onNavFix, and what the page then shows. ---

function fix(pg, x, y) {
  const [lat, lon] = ll(x, y);
  pg.marked = null;
  pg.onNavFix(lat, lon);
  return read(pg, x, y);
}

function read(pg, x, y) {
  return {
    stopId: pg.activeNavLeg()?.stop?.id || "",
    row: pg.marked,
    title: pg.banner.title,
    sub: pg.banner.sub,
    fromPactivM: Math.hypot(x - PACTIV_END[0], y - PACTIV_END[1]),
  };
}

// Fixes every `every` meters along a polyline, `side` meters to its north.
function walk(pg, pts, every = 150, side = 8) {
  const out = [];
  for (let i = 1; i < pts.length; i += 1) {
    const [ax, ay] = pts[i - 1];
    const [bx, by] = pts[i];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / every));
    for (let k = 1; k <= n; k += 1) out.push(fix(pg, ax + (bx - ax) * (k / n), ay + (by - ay) * (k / n) + side));
  }
  return out;
}

let seed = 11;
const jitter = (m) => {
  seed = (seed * 16807) % 2147483647;
  return ((seed / 2147483647) * 2 - 1) * m;
};

function parkAt(pg, [x, y], fixes = 8, spread = 6) {
  const out = [];
  for (let k = 0; k < fixes; k += 1) out.push(fix(pg, x + jitter(spread), y + jitter(spread)));
  return out;
}

function intoPlaza(pg) {
  const out = [];
  for (let k = 1; k <= 16; k += 1) {
    const t = k / 16;
    const x = PLAZA.x - 600 * (1 - t);
    out.push(fix(pg, x, bend(x) + 12 + (PLAZA.y - bend(0) - 12) * t));
  }
  return [...out, ...parkAt(pg, [PLAZA.x, PLAZA.y], 8, 12)];
}

function startLive(storage, { aim = "pactiv", walmart = true } = {}) {
  const pg = page(storage);
  pg.state.stops = plannedStops({ walmart });
  pg.navOn = true;
  pg.navAimStopId = aim;
  pg.rememberNavProgress();
  pg.rebuildNavLegs();
  pg.navLineKey = pg.routeProgressKey(pg.routePoints());
  return pg;
}

// A refresh: new page, same localStorage and trip, resume navigation.
function reload(storage, stops) {
  const pg = page(storage);
  pg.state.stops = JSON.parse(JSON.stringify(stops));
  pg.navAimStopId = pg.readNavProgress()?.aimId || "";
  pg.navOn = true;
  pg.navLineKey = pg.routeProgressKey(pg.routePoints());
  pg.restoreNavSpot();
  return pg;
}

// Up the turnpike to exit 312 and on to PACTIV.
const TO_PACTIV = [[140000, bend(140000)], ...pactivLeg.pts.filter(([x]) => x > 140000)];
const AWAY_ON_WALMART = walmartLeg.pts.filter(([x]) => x >= 146000);

let failures = 0;

function expect(label, ok, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`);
}

function show(r) {
  if (!r) return "-";
  const row = r.row ? `${r.row.stopId} row ${r.row.index + 1}` : "no row";
  return `current ${r.stopId}, ${row}, banner "${r.title}" / "${r.sub}", ${(r.fromPactivM / MILE).toFixed(1)} mi from PACTIV`;
}

const hasFeet = (r) => /\b(?:foot|feet)\b/i.test(r.title);
const showsWalmartStep = (r) => r.row?.stopId === "walmart" || WALMART_TEXTS.some((text) => r.title.includes(text));
// "Turn left." into PACTIV, or its arrival row.
const atPactivRow = (r) => r.row?.stopId === "pactiv" && r.row.index >= PACTIV_LAST_ROW - 1;
// Parked at PACTIV the banner is what the highlighted row shows: the arrival
// on the "Turn left." row, or the next move once on the arrival row.
const parkedBanner = (r, next) => (r.row?.index === PACTIV_LAST_ROW && next ? next : "Arrive at your destination on the left.");

for (const aim of ["pactiv", ""]) {
  console.log(`\nParked in the median plaza, then driving west on the WALMARpu line, no Done (${aim ? "PACTIV picked" : "no stop picked"})`);
  const storage = fakeStorage();
  const live = startLive(storage, { aim });
  walk(live, line(-31000, -600, 4, 300));
  const reads = [...intoPlaza(live), ...walk(live, line(0, -3000, SPLIT_M - 10, 60), 60, 0)];
  const bad = reads.find((r) => r.stopId !== "pactiv" || showsWalmartStep(r) || atPactivRow(r) || /arrive|head west/i.test(r.title));
  expect("every fix: still PACTIV, no WALMARpu step, no PACTIV arrival 95 mi out", !bad, show(bad || reads[reads.length - 1]));
  const end = reads[reads.length - 1];
  expect("3 km west on the other carriageway: \"Not on the route yet\", 0.3 mi from the line", end.title === "Not on the route yet" && end.sub === "0.3 mi from the line", show(end));
}

console.log("\nRefresh in the plaza, then drive west on the WALMARpu line, no Done");
{
  const storage = fakeStorage();
  const live = startLive(storage);
  walk(live, line(-31000, -300, 4, 300));
  const after = reload(storage, live.state.stops);
  const reads = [...parkAt(after, [PLAZA.x, PLAZA.y], 6, 12), ...walk(after, line(0, -3000, SPLIT_M - 10, 60), 60, 0)];
  const bad = reads.find((r) => r.stopId !== "pactiv" || showsWalmartStep(r) || atPactivRow(r) || /arrive|head west/i.test(r.title));
  expect("every fix: still PACTIV, no WALMARpu step, no PACTIV arrival", !bad, show(bad || reads[reads.length - 1]));
  expect("3 km west: \"Not on the route yet\"", reads[reads.length - 1].title === "Not on the route yet", show(reads[reads.length - 1]));
}

console.log("\nArrive at PACTIV, park, refresh, drive off on the WALMARpu line, then pick WALMARpu and press Done");
{
  const storage = fakeStorage();
  const live = startLive(storage);
  const approach = walk(live, TO_PACTIV, 40, 4);
  const near = approach.filter((r) => r.fromPactivM < 0.1 * MILE);
  expect("arriving: the banner says the arrival with no distance", near.some((r) => r.title === "Arrive at your destination on the left."), show(near[near.length - 1]));
  expect("arriving: never \"foot\" or \"feet\" in the banner", !approach.some(hasFeet), show(approach.find(hasFeet)));
  const parked = [...parkAt(live, PACTIV_END, 10, 5), fix(live, PACTIV_END[0], PACTIV_END[1])];
  const badPark = parked.find((r) => r.stopId !== "pactiv" || !atPactivRow(r) || r.title !== parkedBanner(r, "Head west"));
  expect("parked at PACTIV: still PACTIV, the highlighted row's move, no feet", !badPark, show(badPark || parked[parked.length - 1]));

  const after = reload(storage, live.state.stops);
  const parkedAfter = [...parkAt(after, PACTIV_END, 10, 5), fix(after, PACTIV_END[0], PACTIV_END[1])];
  const badAfter = parkedAfter.find((r) => r.stopId !== "pactiv" || !atPactivRow(r) || r.title !== parkedBanner(r, "Head west"));
  expect("after refresh at PACTIV: still PACTIV, the highlighted row's move, no feet", !badAfter, show(badAfter || parkedAfter[parkedAfter.length - 1]));

  const away = walk(after, AWAY_ON_WALMART, 60, 0);
  const strayed = away.find((r) => r.stopId !== "pactiv" || r.row?.stopId === "walmart");
  expect("driving off on the WALMARpu line without Done: still PACTIV", !strayed, show(strayed || away[away.length - 1]));
  const far = away.filter((r) => r.fromPactivM > MILE);
  const farBad = far.find((r) => r.title !== "Not on the route yet");
  expect("over a mile from PACTIV on the WALMARpu line: \"Not on the route yet\"", far.length && !farBad, show(farBad || far[far.length - 1]));

  after.aimNavAtStop("walmart");
  expect("picking WALMARpu asks \"Is PACTIV done?\"", after.pendingAimId === "walmart" && after.elements.routeSwitch?.textContent === "Is PACTIV done?", `pending "${after.pendingAimId}"`);
  const [hx, hy] = AWAY_ON_WALMART[AWAY_ON_WALMART.length - 1];
  const waiting = [fix(after, hx, hy), fix(after, hx - 5, hy)];
  expect("picked but not Done yet: still PACTIV", waiting.every((r) => r.stopId === "pactiv"), show(waiting[waiting.length - 1]));

  after.confirmStopSwitch();
  const done = read(after, hx, hy);
  const pactivDone = after.state.stops.find((stop) => stop.id === "pactiv").done === true;
  expect("Done: PACTIV is done and WALMARpu is the current stop", pactivDone && done.stopId === "walmart" && done.row?.stopId === "walmart", show(done));
  const moved = walk(after, line(146000, 140000, SPLIT_M, 200), 200, 0);
  expect("after Done: guided on the WALMARpu leg", moved.every((r) => r.stopId === "walmart" && r.row?.stopId === "walmart"), show(moved[moved.length - 1]));

  const again = reload(storage, after.state.stops);
  const resumed = walk(again, line(140000, 139000, SPLIT_M, 200), 200, 0);
  expect("refresh after Done: still WALMARpu", resumed.every((r) => r.stopId === "walmart" && r.row?.stopId === "walmart"), show(resumed[resumed.length - 1]));
}

console.log("\nUpdate times while parked in the median plaza");
{
  const storage = fakeStorage();
  const live = startLive(storage);
  walk(live, line(-31000, -600, 4, 300));
  intoPlaza(live);
  await live.updateTimesFromHere();
  const progress = live.state.driveProgress;
  expect("navigating: times are for PACTIV, with the miles left from the plaza", progress?.stopId === "pactiv" && Math.abs(progress.remainMiles - PLAZA_LEFT_MI) < 1, `${JSON.stringify(progress)}; ${live.state.notice || live.state.error}`);
  expect("navigating: still PACTIV after Update times", fix(live, PLAZA.x, PLAZA.y).stopId === "pactiv");

  const planner = page(fakeStorage());
  planner.state.stops = plannedStops();
  planner.fixAt = { lat: ll(PLAZA.x, PLAZA.y)[0], lon: ll(PLAZA.x, PLAZA.y)[1] };
  await planner.updateTimesFromHere();
  const planned = planner.state.driveProgress;
  expect("not navigating: times are for PACTIV, with the miles left from the plaza", planned?.stopId === "pactiv" && Math.abs(planned.remainMiles - PLAZA_LEFT_MI) < 1, `${JSON.stringify(planned)}; ${planner.state.notice || planner.state.error}`);
}

console.log("\nUpdate times while parked at PACTIV");
{
  const storage = fakeStorage();
  const live = startLive(storage);
  walk(live, TO_PACTIV, 150, 4);
  parkAt(live, PACTIV_END, 6, 5);
  await live.updateTimesFromHere();
  const pactiv = live.state.stops.find((stop) => stop.id === "pactiv");
  expect("PACTIV is not marked done", !pactiv.done, `done ${pactiv.done}; ${live.state.notice || live.state.error}`);
  const r = fix(live, PACTIV_END[0], PACTIV_END[1]);
  expect("still PACTIV after Update times", r.stopId === "pactiv" && r.row?.stopId === "pactiv", show(r));
  const after = reload(storage, live.state.stops);
  const back = parkAt(after, PACTIV_END, 4, 5);
  expect("still PACTIV after a refresh", back.every((x) => x.stopId === "pactiv"), show(back[back.length - 1]));
}

console.log("\nPACTIV is the last stop: arrive and park");
{
  const storage = fakeStorage();
  const live = startLive(storage, { walmart: false });
  const approach = walk(live, TO_PACTIV, 40, 4);
  const parked = [...parkAt(live, PACTIV_END, 10, 5), fix(live, PACTIV_END[0], PACTIV_END[1])];
  const reads = [...approach, ...parked];
  expect("never \"foot\" or \"feet\" in the banner", !reads.some(hasFeet), show(reads.find(hasFeet)));
  const bad = parked.find((r) => !atPactivRow(r) || r.title !== parkedBanner(r, ""));
  expect("parked: the banner is the arrival, no distance", !bad, show(bad || parked[parked.length - 1]));
}

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
