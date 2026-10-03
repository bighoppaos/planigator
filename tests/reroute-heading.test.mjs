// Recalculate starts the new route the way the truck is driving, not the way
// the saved line under (or near) him runs. Not loaded by the site.
// Run: node tests/reroute-heading.test.mjs
//
// A city grid: the saved route to DOCK runs west along one street; he drives
// on a parallel street, off the route, on it, or sits at a light. Loads the
// real geolocation watch, onNavFix, Recalculate, add-a-stop and routeTruckLeg
// functions from js/app.js (by name, into a vm sandbox) with the map and DOM
// stubbed, a fake clock and fake GPS, and captures the course each HERE route
// request carries.

import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appSource = readFileSync(path.join(root, "js/app.js"), "utf8");
const navMatch = await import(pathToFileURL(path.join(root, "js/nav-match.js")).href);
const { isOriginStop } = await import(pathToFileURL(path.join(root, "js/plan.js")).href);

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
  "metersBetween", "polylineMeters", "pointAlong", "stepLengthMeters", "scaledStepLengths", "navStep", "metersLeftInStep",
  "navBearing", "pointAhead", "tripProgressKey", "readNavProgress", "readNavSpot", "writeNavProgress", "clearNavProgress",
  "readNavRecord", "readNavProgressMap", "writeNavProgressMap", "readLeftLeg", "leftLegKey", "openLeftLeg",
  "rememberNavProgress", "saveNavSpot", "rebuildNavLegs", "navNearest", "guardResumedHit",
  "activeNavLeg", "routePoints", "routeProgressKey", "onNavFix", "noteArrivedStops", "navMiles", "navStopTitle",
  "withoutGo", "maneuverText", "inDistance", "approachPhrase", "spokenApproach", "directionWithMilesLeft",
  "upcomingDirection", "navDestList", "pointReady", "formatMiles", "travelBearing",
  "fixTime", "navFixFresh", "startNavWatch", "currentFix", "upcomingRoutedStop", "applyAheadLeg", "abortRecalc",
  "recalculateFromHere", "routeTruckLeg", "addPlaceAsNextStop", "writeRoutedLeg", "stopPoint",
];
// The #606 page has none of these; it runs without them so this test can show it failing.
const OPTIONAL_FUNCTIONS = [
  "navMatchSpan", "navOffRoute", "bannerDirection", "roadCourseNear",
  "headingGap", "movingGpsHeading", "fixMotion", "trackHeading", "noteNavTrack", "travelHeading", "routeBearingUnder",
  "forwardOnRoute", "travelCourse", "askPosition", "pathStartBearing", "startsBackwards", "joinLegFrom", "routeFromHere",
  "stopHasSavedLeg", "stopUnrouted", "recalcTarget", "legsOnFrom", "passStop",
];
const APP_CONSTS = ["NAV_PROGRESS_KEY", "NAV_PROGRESS_TRIPS", "RESUME_CONFIRM_FIXES", "RESUME_AGREE_M", "STOP_ARRIVE_M", "NAV_FRESH_MS"];
const OPTIONAL_CONSTS = [
  "RESUME_PARKED_M", "RESUME_DRIVEN_M", "TRACK_KEEP_MS", "TRACK_MAX_FIXES", "TRACK_MIN_M", "TRACK_SPAN_M", "TRACK_FAR_M",
  "TRACK_TURN_M", "TRACK_FRESH_MS", "GPS_MOVING_MPS", "HEADING_KEEP_MS", "HEADING_MOVED_M", "HEADING_TRUST_MS", "ROUTE_ON_M",
  "ROUTE_AGREE_DEG", "START_CHECK_M", "START_BACKWARDS_DEG", "AHEAD_ORIGIN_M",
];
const APP_CODE = [
  ...APP_CONSTS.map((name) => constLine(name)),
  ...OPTIONAL_CONSTS.map((name) => constLine(name, true)),
  ...APP_FUNCTIONS.map((name) => extract(name)),
  ...OPTIONAL_FUNCTIONS.map((name) => extract(name, true)),
].join("\n\n");

// --- The streets, in meters east (x) and north (y) of a Chicago corner. ---

const ORIGIN = [41.88, -87.63];
const COS = Math.cos(ORIGIN[0] * Math.PI / 180);
const ll = (x, y) => [ORIGIN[0] + y / 111320, ORIGIN[1] + x / (111320 * COS)];
const xy = (lat, lon) => [(lon - ORIGIN[1]) * 111320 * COS, (lat - ORIGIN[0]) * 111320];
const MILE = 1609.344;
const EAST = 90;
const WEST = 270;

function run(xFrom, yFrom, xTo, yTo, stepM = 100) {
  const out = [];
  const n = Math.max(1, Math.ceil(Math.hypot(xTo - xFrom, yTo - yFrom) / stepM));
  for (let k = 0; k <= n; k += 1) out.push([xFrom + (xTo - xFrom) * (k / n), yFrom + (yTo - yFrom) * (k / n)]);
  return out;
}

// The saved route to DOCK: west along the y = 0 street, 3 km to -3 km.
const DOCK_PTS = run(3000, 0, -3000, 0);
const YARD_PTS = run(-3000, 0, -3000, -3000);
const stopsJson = JSON.stringify([
  { id: "start", name: "Start", lat: ll(3000, 0)[0], lon: ll(3000, 0)[1], miles: "", hours: "" },
  { id: "dock", name: "DOCK", lat: ll(-3000, 0)[0], lon: ll(-3000, 0)[1], miles: String(6000 / MILE), hours: "0.3", path: DOCK_PTS.map(([x, y]) => ll(x, y)), directions: [{ text: "Head west on W Lake St.", miles: 6000 / MILE }, { text: "Arrive at DOCK", miles: 0 }] },
  { id: "yard", name: "YARD", lat: ll(-3000, -3000)[0], lon: ll(-3000, -3000)[1], miles: String(3000 / MILE), hours: "0.2", path: YARD_PTS.map(([x, y]) => ll(x, y)), directions: [{ text: "Head south on S Wells St.", miles: 3000 / MILE }, { text: "Arrive at YARD", miles: 0 }] },
]);

const noop = () => {};

function fakeStorage() {
  const data = new Map();
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
}

// HERE answering the request: a path that starts out the way `start` says
// (default: the course sent, as HERE does with ;course=), then to the stop.
function herePath(from, to, startBearing) {
  const [fx, fy] = xy(from.lat, from.lon);
  const [tx, ty] = xy(to.lat, to.lon);
  const pts = [[fx, fy]];
  if (typeof startBearing === "number") {
    const r = startBearing * Math.PI / 180;
    pts.push([fx + 200 * Math.sin(r), fy + 200 * Math.cos(r)]);
  }
  pts.push([tx, ty]);
  return pts.map(([x, y]) => ll(x, y));
}

function page() {
  const elements = {};
  const clock = { now: 1_780_000_000_000 };
  class FakeDate extends Date {
    static now() { return clock.now; }
  }
  const geo = {
    watcher: null,
    asked: [],
    current: null,
    watchPosition(ok) { geo.watcher = ok; return 1; },
    clearWatch: noop,
    getCurrentPosition(ok, fail, options) {
      geo.asked.push(options);
      const spot = geo.current;
      Promise.resolve().then(() => (spot ? ok(position(spot)) : fail({ code: 3 })));
    },
  };
  function position({ x, y, heading = null, speed = null, accuracy = 5 }) {
    const [latitude, longitude] = ll(x, y);
    return { coords: { latitude, longitude, heading, speed, accuracy }, timestamp: clock.now };
  }
  const calls = [];
  const context = {
    console, Math, Number, String, JSON, Array, Object, Infinity, NaN, Set, Map, RegExp, Promise, Error,
    Date: FakeDate,
    ...navMatch,
    isOriginStop,
    localStorage: fakeStorage(),
    navigator: { geolocation: geo },
    document: { getElementById: (id) => (elements[id] ||= { id, hidden: true, textContent: "", innerHTML: "" }) },
    window: { maplibregl: {}, clearTimeout: noop },
    performance: { now: () => clock.now },
    elements, clock, geo, calls, position,
    state: {
      stops: [], origin: null, tripName: "", activeTripId: "trip-1", trips: [], settings: { kilometers: false, routeMode: "fast", governed: true },
      plan: null, driveProgress: null, updatingTimes: false, estimating: false, error: "", notice: "", unlimited: true, credits: 50,
    },
    navLine: [], navLegs: [], navAlongLock: null, navResumeGuard: null, navLeave: null, navLineKey: "",
    navTravel: null, navOn: false, navAimStopId: "", navSpotSavedAlong: null, navFix: null, navFixAt: 0, navFixTime: 0,
    navWatch: null, navTrack: [], navHeadingGood: null,
    routeMap: {}, navYou: {}, tripFit: "full", navFollowing: false, navMapTouch: false, placeSeek: false,
    truckHits: [], navZoomHold: 0, routeFull: false, routePageStale: false, navCompass: null,
    pendingAimId: "", railMenu: "", navStopCursor: 0, navStopPicked: false, navGuideFromId: "",
    navStopAwaitNear: false, navStopAnnounce: false, followPinned: false, navReturnTimer: 0, navVoiceNow: null,
    directionsAutoKey: "", spokenStepKey: "", spokenMiles: new Set(), navStopSpeakKey: "",
    banner: { title: "", sub: "" },
    sayNav: (title, sub) => { context.banner = { title, sub }; },
    markDirection: noop,
    setStopChip: noop,
    calculate: async () => {},
    originPoint: () => (context.state.origin ? { lat: context.state.origin.lat, lon: context.state.origin.lon } : null),
    styleIsBasemap: () => true,
    calculateButtonLabel: () => "",
    creditEmptyMessage: () => "No credits.",
    transportRouteNote: () => "HERE truck route.",
    transportModeTitle: () => "Truck",
    activeTransportMode: () => "truck",
    leaveAtNow: () => clock.now,
    mph: () => 65,
    clipStopName: (name) => String(name),
    clockOffset: (offset) => offset,
    defaultStop: (overrides = {}) => ({ id: `new-${calls.length}-${Math.random()}`, name: "", address: "", miles: "", hours: "", useCurrentLocation: false, ...overrides }),
    // The network: what each HERE route request carried.
    respond: null,
    truckRoute: async (from, to, options) => {
      calls.push({ from, to, course: options.course, avoidUTurns: options.avoidUTurns });
      const start = context.respond ? context.respond(calls.length, from, to, options) : options.course;
      return { miles: 4, hours: 0.2, points: herePath(from, to, start), directions: [{ text: "Head out. Go for 0.1 mi.", miles: 0.1 }, { text: "Arrive.", miles: 0 }], credits: 49 };
    },
  };
  for (const name of [
    "placeNavDot", "aimNavDot", "startNavMotion", "resumeTurnZoom", "paintCompassRose", "queueBasemap", "refreshPlace",
    "paintRouteLines", "paintDrive", "paintSwitchOffer", "paintNavLine", "clearStopNote", "trackLiveDrive",
    "paintDirectionMiles", "openDirectionsNear", "speakNavProgress", "paintDirectionToward", "frameNextTurn",
    "frameNextStop", "persist", "render", "clearDirectionPin", "clearTurnFrame", "showStopNote", "syncRouteChrome",
    "rememberOrigin", "clearDriveProgress", "paintLiveRoute", "refillDirections", "paintLiveDirections", "syncTruckAdd",
  ]) context[name] = noop;
  vm.createContext(context);
  vm.runInContext(APP_CODE, context);
  context.state.stops = JSON.parse(stopsJson);
  context.navOn = true;
  context.navAimStopId = "dock";
  context.rebuildNavLegs();
  context.navLineKey = context.routeProgressKey(context.routePoints());
  context.startNavWatch();
  return context;
}

// One GPS fix from the watch, `dt` ms after the last.
function gps(pg, x, y, extra = {}, dt = 1000) {
  pg.clock.now += dt;
  pg.geo.watcher(pg.position({ x, y, ...extra }));
}

// Fixes every `every` meters from a to b, at 10 m/s.
function drive(pg, [ax, ay], [bx, by], every = 10, extra = {}) {
  const n = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / every));
  for (let k = 1; k <= n; k += 1) gps(pg, ax + (bx - ax) * (k / n), ay + (by - ay) * (k / n), extra, every * 100);
}

let seed = 7;
const jitter = (m) => {
  seed = (seed * 16807) % 2147483647;
  return ((seed / 2147483647) * 2 - 1) * m;
};

function gap(a, b) {
  const d = Math.abs((((a - b) % 360) + 360) % 360);
  return d > 180 ? 360 - d : d;
}

const courseText = (c) => (typeof c === "number" ? `${Math.round(c)}°` : "no course");
const near = (c, want, tol = 20) => typeof c === "number" && gap(c, want) <= tol;

let failures = 0;
function expect(label, ok, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`);
}

async function recalc(pg) {
  pg.calls.length = 0;
  await pg.recalculateFromHere();
  return pg.calls;
}

console.log("\nCity: on a parallel street 120 m north of the saved route, driving east; the route runs west");
{
  const pg = page();
  drive(pg, [-1000, 120], [-600, 120]);
  const calls = await recalc(pg);
  expect("one route request", calls.length === 1, `${calls.length} requests; ${pg.state.error}`);
  expect("course is east (his track), not the route's west", near(calls[0]?.course, EAST), courseText(calls[0]?.course));
  expect("U-turns avoided", calls[0]?.avoidUTurns === true);
}

console.log("\nCity: on a cross street 40 m from the route, driving east across it");
{
  const pg = page();
  drive(pg, [-200, 40], [100, 40]);
  const calls = await recalc(pg);
  expect("course is east, not the route's west", near(calls[0]?.course, EAST), courseText(calls[0]?.course));
}

console.log("\nOff the route, driving away from it east-southeast (the route runs west)");
{
  const pg = page();
  drive(pg, [0, -300], [300, -420]);
  const calls = await recalc(pg);
  const want = (Math.atan2(300, -120) * 180 / Math.PI + 360) % 360;
  expect("course is his travel (~112°)", near(calls[0]?.course, want), courseText(calls[0]?.course));
}

console.log("\nOn the route, going with it (west)");
{
  const pg = page();
  drive(pg, [1000, 4], [600, 4]);
  const calls = await recalc(pg);
  expect("course is the route's bearing (west)", near(calls[0]?.course, WEST, 5), courseText(calls[0]?.course));
  expect("one route request", calls.length === 1, `${calls.length}`);
}

console.log("\nStopped at a light 3 minutes after driving east 300 m off the route, GPS jittering");
{
  const pg = page();
  drive(pg, [-900, 150], [-600, 150]);
  for (let k = 0; k < 40; k += 1) gps(pg, -600 + jitter(4), 150 + jitter(4), {}, 4500);
  const calls = await recalc(pg);
  expect("course is the last good heading (east), not jitter or the route's west", near(calls[0]?.course, EAST), courseText(calls[0]?.course));
}

console.log("\nJust opened, sitting still off the route, GPS jittering, no good heading ever");
{
  const pg = page();
  for (let k = 0; k < 12; k += 1) gps(pg, -600 + jitter(4), 150 + jitter(4));
  const calls = await recalc(pg);
  expect("no course sent", calls.length === 1 && calls[0].course === undefined, `${calls.length} requests, ${courseText(calls[0]?.course)}`);
}

console.log("\nDrove east, turned around on the parallel street, now heading west");
{
  const pg = page();
  drive(pg, [-1000, 120], [-600, 120]);
  drive(pg, [-600, 120], [-625, 120]);
  const early = await recalc(pg);
  expect("25 m after the turnaround: not the old east heading", !near(early[0]?.course, EAST, 60), courseText(early[0]?.course));
  drive(pg, [-625, 120], [-700, 120]);
  const later = await recalc(pg);
  expect("100 m after the turnaround: west", near(later[0]?.course, WEST), courseText(later[0]?.course));
}

console.log("\nFirst fix only, moving: GPS heading east at 9 m/s, no track yet");
{
  const pg = page();
  gps(pg, -600, 150, { heading: 92, speed: 9 });
  const calls = await recalc(pg);
  expect("course is the moving GPS heading", near(calls[0]?.course, 92, 3), courseText(calls[0]?.course));
}

console.log("\nCreeping at 1 m/s with a GPS heading north: not trusted");
{
  const pg = page();
  gps(pg, -600, 150, { heading: 0, speed: 1 });
  const calls = await recalc(pg);
  expect("no course sent", calls[0]?.course === undefined, courseText(calls[0]?.course));
}

console.log("\nPhone compass facing north while he drives east on the parallel street");
{
  const pg = page();
  pg.navCompass = 0;
  drive(pg, [-1000, 120], [-600, 120]);
  const calls = await recalc(pg);
  expect("Recalculate: course is east, not the compass", near(calls[0]?.course, EAST), courseText(calls[0]?.course));

  const add = page();
  add.navCompass = 0;
  drive(add, [-1000, 120], [-600, 120]);
  const [hx, hy] = [-400, 500];
  await add.addPlaceAsNextStop({ name: "Fuel", lat: ll(hx, hy)[0], lon: ll(hx, hy)[1], label: "Fuel, Chicago" });
  expect("add a stop: course into it is east, not the compass", near(add.calls[0]?.course, EAST), `${add.calls.length} requests, first ${courseText(add.calls[0]?.course)}; ${add.state.error}`);
}

console.log("\nLast fix is a minute old; Recalculate asks for a fresh one");
{
  const pg = page();
  drive(pg, [-1000, 120], [-600, 120]);
  pg.clock.now += 60000;
  pg.geo.current = { x: -300, y: 120, accuracy: 5 };
  const calls = await recalc(pg);
  const asked = pg.geo.asked[0];
  expect("a fresh position was requested (maximumAge <= 2 s)", pg.geo.asked.length === 1 && asked.maximumAge <= 2000 && asked.timeout > 0, JSON.stringify(pg.geo.asked));
  const [fx] = calls[0] ? xy(calls[0].from.lat, calls[0].from.lon) : [NaN];
  expect("the route starts from the fresh position", Math.abs(fx - -300) < 2, `from x ${Math.round(fx)}`);
  expect("course is still east", near(calls[0]?.course, EAST), courseText(calls[0]?.course));

  const failing = page();
  drive(failing, [-1000, 120], [-600, 120]);
  failing.clock.now += 60000;
  failing.geo.current = null;
  const fallback = await recalc(failing);
  const [lx] = fallback[0] ? xy(fallback[0].from.lat, fallback[0].from.lon) : [NaN];
  expect("fresh position fails: falls back to the last fix", failing.geo.asked.length === 1 && Math.abs(lx - -600) < 2, `from x ${Math.round(lx)}`);
}

console.log("\nHERE starts the route backwards (west) while he drives east");
{
  const pg = page();
  drive(pg, [-1000, 120], [-600, 120]);
  pg.respond = (n) => (n === 1 ? WEST : EAST);
  const calls = await recalc(pg);
  expect("exactly one retry (two requests)", calls.length === 2, `${calls.length} requests`);
  const [rx, ry] = calls[1] ? xy(calls[1].from.lat, calls[1].from.lon) : [NaN, NaN];
  expect("retry starts ~150 m ahead along his heading", Math.abs(rx - -450) < 10 && Math.abs(ry - 120) < 10, `retry from (${Math.round(rx)}, ${Math.round(ry)})`);
  expect("retry carries the same course", calls[1] && calls[1].course === calls[0].course, `${courseText(calls[0]?.course)} / ${courseText(calls[1]?.course)}`);
  const dock = pg.state.stops.find((stop) => stop.id === "dock");
  const [sx, sy] = dock?.path?.[0] ? xy(dock.path[0][0], dock.path[0][1]) : [NaN, NaN];
  const [nx] = dock?.path?.[1] ? xy(dock.path[1][0], dock.path[1][1]) : [NaN];
  expect("the new line starts where he is, then joins the retry's start", Math.hypot(sx - -600, sy - 120) < 2 && Math.abs(nx - -450) < 10, `(${Math.round(sx)}, ${Math.round(sy)}) then x ${Math.round(nx)}`);
  expect("miles include the 150 m gap", Math.abs(Number(dock?.miles) - (4 + 150 / MILE)) < 0.06, dock?.miles);

  const both = page();
  drive(both, [-1000, 120], [-600, 120]);
  both.respond = () => WEST;
  const twice = await recalc(both);
  const kept = both.state.stops.find((stop) => stop.id === "dock");
  const [kx, ky] = kept?.path?.[0] ? xy(kept.path[0][0], kept.path[0][1]) : [NaN, NaN];
  const [k1] = kept?.path?.[1] ? xy(kept.path[1][0], kept.path[1][1]) : [NaN];
  expect("retry also backwards: two requests, the first route kept", twice.length === 2 && Math.hypot(kx - -600, ky - 120) < 2 && k1 < -700, `${twice.length} requests, second point x ${Math.round(k1)}`);

  const fine = page();
  drive(fine, [-1000, 120], [-600, 120]);
  const once = await recalc(fine);
  expect("normal case: exactly one request", once.length === 1, `${once.length} requests`);

  const unsure = page();
  for (let k = 0; k < 12; k += 1) gps(unsure, -600 + jitter(4), 150 + jitter(4));
  unsure.respond = () => WEST;
  const noRetry = await recalc(unsure);
  expect("no reliable heading: no retry", noRetry.length === 1, `${noRetry.length} requests`);
}

console.log("\nRecalculating never switches the stop");
{
  const pg = page();
  drive(pg, [-1000, 120], [-600, 120]);
  const before = pg.activeNavLeg()?.stop?.id;
  await recalc(pg);
  pg.rebuildNavLegs();
  const after = pg.activeNavLeg()?.stop?.id;
  const done = pg.state.stops.filter((stop) => stop.done).map((stop) => stop.id);
  expect("still aimed at DOCK, nothing marked done", before === "dock" && after === "dock" && pg.navAimStopId === "dock" && !done.length, `before ${before}, after ${after}, aim ${pg.navAimStopId}, done [${done}]`);
  const yard = pg.state.stops.find((stop) => stop.id === "yard");
  expect("YARD keeps its saved leg", yard && !yard.skipRoute && Array.isArray(yard.path) && yard.path.length === YARD_PTS.length);
}

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
