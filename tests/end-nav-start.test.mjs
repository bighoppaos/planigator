// Build #618: End navigation starts the trip where he is. The trip start
// becomes "Current location" at the last nav fix right away (no prompt), then a
// newer fix if the page may already read the location. A miss or a denial
// leaves the nav-fix start and shows no error. Recalculate (the map's
// Recalculate and the "Recalculate" Calculate button) routes from where he is,
// never the stored start. Done stops and the saved left leg stay. Opening an
// example or a shared trip does not give that trip the old nav fix.
// Not loaded by the site. Run: node tests/end-nav-start.test.mjs
// Against other copies: APP_JS=/path/to/app.js node tests/end-nav-start.test.mjs
//
// Loads the real End navigation, Start from my location, nav progress,
// Recalculate, Calculate, and open-trip functions from js/app.js into a vm
// sandbox. Geolocation, timers, HERE routing, and the map are stubbed; the
// geolocation stub hands back fixes only when the test delivers them.
// Trip: starts at an address in Lancaster, PA; navigation ends near Lebanon, PA.

process.env.TZ = "America/New_York";

import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appSource = readFileSync(process.env.APP_JS || path.join(root, "js/app.js"), "utf8");
const plan = await import(pathToFileURL(path.join(root, "js/plan.js")).href);
const navMatch = await import(pathToFileURL(path.join(root, "js/nav-match.js")).href);

function find(name) {
  return new RegExp(`^(?:async\\s+)?function\\s+${name}\\s*\\(`, "m").exec(appSource);
}

// From `from` (an opening bracket), the index just past its matching close.
function skipBalanced(source, from, opens = "{([", closes = "})]") {
  let depth = 0;
  for (let i = from; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "/" && source[i + 1] === "/") {
      i = source.indexOf("\n", i);
      continue;
    }
    if (ch === "'" || ch === "\"") {
      for (i += 1; source[i] !== ch; i += 1) if (source[i] === "\\") i += 1;
      continue;
    }
    if (ch === "`") {
      for (i += 1; source[i] !== "`"; i += 1) {
        if (source[i] === "\\") i += 1;
        else if (source[i] === "$" && source[i + 1] === "{") i = skipBalanced(source, i + 1, "{", "}") - 1;
      }
      continue;
    }
    if (opens.includes(ch)) depth += 1;
    else if (closes.includes(ch)) {
      depth -= 1;
      if (!depth) return i + 1;
    }
  }
  throw new Error("Unbalanced source");
}

function extract(name) {
  const head = find(name);
  if (!head) throw new Error(`app.js has no function ${name}`);
  const params = skipBalanced(appSource, head.index + head[0].length - 1, "(", ")");
  return appSource.slice(head.index, skipBalanced(appSource, appSource.indexOf("{", params), "{", "}"));
}

// Not in the old page. It runs without them, so this test can show it failing.
const optional = (name) => (find(name) ? extract(name) : "");

function constLine(name) {
  const hit = new RegExp(`^const ${name} = [^;]+;`, "m").exec(appSource);
  if (!hit) throw new Error(`app.js has no const ${name}`);
  return hit[0].replace(/^const /, "var ");
}

const APP_CODE = [
  ...["STORAGE", "NAV_PROGRESS_KEY", "NAV_PROGRESS_TRIPS", "NAV_FRESH_MS"].map(constLine),
  ...[
    // End navigation and nav progress
    "endRouteNav", "saveLeftLeg", "leaveNavSession", "endNavProgress", "retargetNavProgress", "tripProgressKey",
    "readNavRecord", "readNavProgressMap", "writeNavProgressMap", "readNavProgress", "readLeftLeg", "leftLegKey",
    "openLeftLeg", "forgetLeftLeg", "readNavSpot", "writeNavProgress", "clearNavProgress", "clearDriveProgress",
    "readDriveProgress", "persist",
    // Start from my location
    "locateSucceeded", "dropAddressStart", "movedEnough", "endLocateWatch", "rememberOrigin", "originPoint",
    "fixTime", "editorBusy", "pointReady", "addStop",
    // Recalculate (map) and Calculate (Step button)
    "recalculateFromHere", "currentFix", "askPosition", "navFixFresh", "rebuildNavLegs", "activeNavLeg",
    "upcomingRoutedStop", "applyAheadLeg", "routeFromHere", "abortRecalc", "stopPoint", "calculate",
    "needsStartChoice", "billableStops", "fillHereLegs", "writeRoutedLeg",
    // Opening another trip
    "loadExample", "loadTrip",
  ].map(extract),
  ...["startTripAt", "carryNavProgress", "startTripAfterNav", "refreshTripStart"].map(optional),
].join("\n\n");

const LANCASTER = { lat: 40.0379, lon: -76.3055 };
const LEBANON = { lat: 40.3409, lon: -76.4113 };
const FARTHER = { lat: 40.3601, lon: -76.429 }; // a newer fix up the road from Lebanon
const EPHRATA = { lat: 40.1798, lon: -76.1788 };
const PINE_GROVE = { lat: 40.5487, lon: -76.3847 };
const WILKES = { lat: 41.2459, lon: -75.8813 };
const PILOT = { lat: 40.37, lon: -76.42 };
const OTHER_START = { lat: 39.9, lon: -75.6 };

const NOW = Date.UTC(2026, 9, 3, 14, 12, 0); // 10:12 AM EDT
const clock = { now: NOW };
class FakeDate extends Date {
  constructor(...args) {
    if (args.length) super(...args);
    else super(clock.now);
  }
  static now() { return clock.now; }
}

const pair = (p) => [p.lat, p.lon];

// The trip he drove. `start`: "address" (Start from an address in Lancaster),
// or "pickup" (no Start card; the first stop, in Lancaster, is where it starts).
function tripStops({ start = "address", done = true } = {}) {
  const stops = [];
  if (start === "address") {
    stops.push({ id: "start", name: "Start", address: "Lancaster, PA", ...LANCASTER, anytime: true, miles: "", hours: "" });
  } else {
    stops.push({ id: "shipper", name: "SHIPPER", address: "Lancaster, PA", ...LANCASTER, anytime: true, miles: "", hours: "" });
  }
  const from = pair(LANCASTER);
  if (done) {
    stops.push({ id: "ephrata", name: "EPHRATA", ...EPHRATA, miles: "12", hours: "0.3", path: [from, pair(EPHRATA)],
      directions: [], done: true, switched: true, skipRoute: true });
  }
  stops.push({ id: "pinegrove", name: "PINE GROVE", ...PINE_GROVE, miles: "45", hours: "1",
    path: [done ? pair(EPHRATA) : from, pair(LEBANON), pair(PINE_GROVE)], directions: [] });
  stops.push({ id: "wilkes", name: "WILKES-BARRE", ...WILKES, miles: "70", hours: "1.4",
    path: [pair(PINE_GROVE), pair(WILKES)], directions: [] });
  return stops;
}

const EXAMPLE = {
  name: "Example trip",
  stops: [
    { id: "ex-here", name: "Current location", useCurrentLocation: true, ...OTHER_START, miles: "", hours: "" },
    { id: "ex-1", name: "EXAMPLE DC", lat: 37, lon: -79, miles: "120", hours: "2", path: [pair(OTHER_START), [37, -79]] },
  ],
};

const OTHER_TRIP = {
  id: "trip-2",
  name: "KROGER run",
  origin: { ...OTHER_START },
  stops: [
    { id: "k-here", name: "Current location", useCurrentLocation: true, ...OTHER_START, miles: "", hours: "" },
    { id: "kroger", name: "KROGER", lat: 39, lon: -77, miles: "80", hours: "1.5", path: [pair(OTHER_START), [39, -77]] },
  ],
};

function memoryStorage() {
  const items = new Map();
  return {
    items,
    getItem: (key) => (items.has(key) ? items.get(key) : null),
    setItem: (key, value) => { items.set(key, String(value)); },
    removeItem: (key) => { items.delete(key); },
  };
}

// Geolocation that answers only when the test delivers a fix or an error.
function fakeGeo(pg) {
  const geo = {
    watches: [],
    asks: [],
    cleared: [],
    nextId: 100,
    answer: null, // for getCurrentPosition: null = fail, or { lat, lon }
    watchPosition(ok, fail, options) {
      const id = geo.nextId++;
      geo.watches.push({ id, ok, fail, options, navOnAtCall: pg.navOn });
      return id;
    },
    clearWatch(id) { geo.cleared.push(id); },
    getCurrentPosition(ok, fail, options) {
      geo.asks.push(options);
      if (geo.answer) ok(position(geo.answer));
      else fail({ code: 2 });
    },
  };
  return geo;
}

function position(point, at = clock.now) {
  return { coords: { latitude: point.lat, longitude: point.lon, heading: null, speed: null, accuracy: 10 }, timestamp: at };
}

const noop = () => {};

function page({ start = "address", done = true, activeTripId = null, permission = "granted", storage = memoryStorage() } = {}) {
  const calls = { render: 0, routed: [], calculate: [], timers: [] };
  let newIds = 0;
  const pg = {
    console, Math, Number, String, JSON, Array, Object, Infinity, NaN, Set, Map, RegExp, Promise, Intl,
    Date: FakeDate,
    ...plan, ...navMatch,
    calls,
    localStorage: storage,
    document: { activeElement: null, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
    state: {
      stops: tripStops({ start, done }),
      settings: { governed: true, governedMph: 65, routeMode: "fast" },
      plan: { events: [] }, origin: null, driveProgress: null, activeTripId, tripName: "", trips: [OTHER_TRIP],
      estimating: false, error: "", notice: "", locating: false, locationError: "", locationNotice: "",
      unlimited: true, credits: 10, signedIn: false,
    },
    navOn: false, navFix: null, navFixTime: 0, navTravel: null, navLine: [], navLegs: [],
    navAimStopId: "", navProgressResume: false, liveDrive: null,
    locateAttempt: 0, locateWatchId: null, locateWatchTimer: null, locateAnswerTimer: null,
    routeMap: null, routeMapReady: false, routeFull: false, routePageStale: false,
    // End navigation's map, voice, and direction side effects.
    followPinned: false, railMenu: "", northLock: false, compassAim: false, navAlongLock: null,
    navResumeGuard: null, navSpotSavedAlong: null, navLineKey: "", navStopPicked: false, navGuideFromId: "",
    navStopAnnounce: false, navStopAwaitNear: false, navStopSpeakKey: "", directionsAutoKey: "",
    switchSpokenFor: "", pendingAimId: "", navFollowing: false, tripFit: "nextTurn", navReturnTimer: 0,
    navWatch: null, navYou: null, dirBrowseTimer: 0, onNavCompass: noop, navStopCursor: 0,
    spokenStepKey: "", spokenMiles: new Set(), addressEditStarted: false, wantAccountTrip: false,
    clearDirectionPin: noop, clearStopNote: noop, setStopChip: noop, clearLiveDrive: noop,
    stopNavMotion: () => { pg.navTravel = null; },
    resetNavVoice: noop, stopMixNavVoice: noop, clearTurnFrame: noop, freezeTyping: noop, syncTripFitButton: noop,
    showWholeTrip: noop, syncRouteChrome: noop, syncTripNavLocks: noop, focusDirectionWindow: noop,
    keepDoneOnSavedTrip: noop, addRoutePins: noop, showStopNote: noop,
    settingsForSave: () => pg.state.settings,
    slimPlan: (p) => p,
    render: () => { calls.render += 1; },
    defaultStop: (patch = {}) => ({
      id: `new-${++newIds}`, name: "", address: "", miles: "", hours: "", anytime: false, window: false,
      start: clock.now, end: clock.now, useCurrentLocation: false, ...patch,
    }),
    clockOffset: () => 0,
    // Recalculate / Calculate: no network, no map.
    noteNavTrack: noop, noteArrivedStops: noop, navStopTitle: (stop) => stop?.name || "Stop",
    travelCourse: () => ({ course: undefined, travel: undefined, reliable: false, source: "none" }),
    startsBackwards: () => false,
    routeTruckLeg: async (from, to) => {
      calls.routed.push({ from: { lat: from.lat, lon: from.lon }, to: { lat: to.lat, lon: to.lon } });
      return { miles: 10, hours: 0.2, points: [[from.lat, from.lon], [to.lat, to.lon]], directions: [] };
    },
    navDestList: () => [],
    transportRouteNote: () => "Truck route.", transportModeTitle: () => "Truck", activeTransportMode: () => "truck",
    creditEmptyMessage: () => "", calculateButtonLabel: () => "", clearSpeedNote: noop, paintLiveRoute: noop,
    refillDirections: noop, paintLiveDirections: noop, leaveAtNow: () => clock.now, mph: () => 65,
    stopHasSavedLeg: (stop) => (Number(stop?.miles) || 0) > 0.05,
    stopsAndLeaveForPlan: () => ({ stops: [], leaveAt: clock.now }), zonedPlanStops: (s) => s,
    planClockNow: () => clock.now, buildPlan: () => ({ events: [] }), presentAfterPlan: noop,
    keepSharedOnAccount: async () => {}, saveTrip: noop,
    arrivedFix: async () => null,
    // Opening another trip.
    EXAMPLE_TRIP: EXAMPLE, parkSpeedNote: noop, showTripSpeedNote: noop, blankSpeedNote: noop,
    shiftExampleStamps: (trip) => trip, exampleWeeksAhead: () => 0, settleLoadedStops: noop, pinEnteredClocks: noop,
    applyNavProgress: noop, tripReadyToRecalc: () => false, replanAroundDone: noop,
  };
  pg.navigator = {
    geolocation: null,
    permissions: { query: async () => ({ state: permission }) },
  };
  pg.geo = fakeGeo(pg);
  pg.navigator.geolocation = pg.geo;
  const setTimeout = (fn, ms) => { calls.timers.push({ fn, ms, live: true }); return calls.timers.length; };
  const clearTimeout = (id) => { if (calls.timers[id - 1]) calls.timers[id - 1].live = false; };
  pg.setTimeout = setTimeout;
  pg.clearTimeout = clearTimeout;
  pg.window = { isSecureContext: true, setTimeout, clearTimeout, removeEventListener: noop };
  pg.calculateStub = (opts) => { calls.calculate.push({ opts, origin: pg.state.origin && { ...pg.state.origin }, first: { ...pg.state.stops[0] } }); };
  vm.createContext(pg);
  vm.runInContext(APP_CODE, pg);
  pg.realCalculate = pg.calculate;
  pg.calculate = pg.calculateStub;
  return pg;
}

// Navigation on, the truck tracked up to Lebanon on the Pine Grove leg, the
// trip's progress saved as navigation saves it (done stops, the left leg).
function navigateToLebanon(pg) {
  pg.navOn = true;
  pg.navWatch = 7;
  pg.navFix = pair(LEBANON);
  pg.navFixTime = clock.now - 3000;
  pg.navTravel = 340;
  pg.navAimStopId = "pinegrove";
  const stop = pg.state.stops.find((item) => item.id === "pinegrove");
  pg.state.driveProgress = { stopId: "pinegrove", remainFraction: 20 / 45, leftAt: clock.now, remainMiles: 20, remainHours: 0.45 };
  pg.writeNavProgress({
    tripKey: pg.tripProgressKey(),
    doneIds: pg.state.stops.filter((item) => item.done).map((item) => item.id),
    aimId: "pinegrove",
    nav: true,
    spot: { along: 30000, lineKey: "k", stopId: "pinegrove", legAlong: 20000, bearing: 340 },
    leftLeg: { stopId: "pinegrove", legKey: pg.leftLegKey(stop), remainMiles: 20, remainHours: 0.45, fullMiles: 45, at: clock.now },
  });
}

const near = (a, b) => a && b && Math.abs(Number(a.lat) - b.lat) < 1e-6 && Math.abs(Number(a.lon) - b.lon) < 1e-6;
const where = (p) => (p ? `${Number(p.lat).toFixed(4)}, ${Number(p.lon).toFixed(4)}` : String(p));
const saved = (pg) => JSON.parse(pg.localStorage.getItem("planigator.web.v1") || "null");
const progressMap = (pg) => JSON.parse(pg.localStorage.getItem("planigator.web.navprogress") || "null") || {};
const flush = () => new Promise((resolve) => setImmediate(resolve));
const lastWatch = (pg) => pg.geo.watches[pg.geo.watches.length - 1];

let failures = 0;
function expect(label, ok, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`);
}

// --- a. Right after End navigation ---
console.log("a. End navigation near Lebanon: the trip starts there, right away");
{
  const pg = page();
  navigateToLebanon(pg);
  pg.endRouteNav();
  const first = pg.state.stops[0];
  expect("navigation is off", pg.navOn === false);
  expect("the first stop is the Current location start", first?.useCurrentLocation === true, first?.name);
  expect("state.origin is the Lebanon nav fix", near(pg.state.origin, LEBANON), where(pg.state.origin));
  expect("originPoint() is the Lebanon nav fix", near(pg.originPoint(), LEBANON), where(pg.originPoint()));
  expect("the Current location stop carries the Lebanon point", near(first, LEBANON), where(first));
  expect("the Lancaster Start card is gone (as Start from my location drops it)", !pg.state.stops.some((stop) => stop.id === "start"));
  expect("Pine Grove and Wilkes-Barre are still stops to drive to (not passed)",
    ["pinegrove", "wilkes"].every((id) => !pg.state.stops.find((stop) => stop.id === id)?.skipRoute));
  expect("no location prompt: nothing asked getCurrentPosition", pg.geo.asks.length === 0, `${pg.geo.asks.length} ask(s)`);
  const stored = saved(pg);
  expect("persisted: stored origin and first stop are the Lebanon start",
    near(stored?.origin, LEBANON) && stored?.stops?.[0]?.useCurrentLocation === true, where(stored?.origin));
  expect("no location error", pg.state.locationError === "", pg.state.locationError);
}
{
  const pg = page({ done: false });
  navigateToLebanon(pg);
  pg.endRouteNav();
  const next = pg.state.stops[1];
  expect("Start card dropped: the stop that followed it is not marked passed", next?.id === "pinegrove" && !next.skipRoute
    && next.miles === "45" && next.path?.length === 3, JSON.stringify({ id: next?.id, skipRoute: next?.skipRoute, miles: next?.miles }));
}
{
  const pg = page({ start: "pickup", done: false });
  navigateToLebanon(pg);
  pg.endRouteNav();
  const shipper = pg.state.stops.find((stop) => stop.id === "shipper");
  expect("trip that starts at its first stop (a Lancaster pickup): starts at Lebanon now",
    pg.state.stops[0]?.useCurrentLocation === true && near(pg.originPoint(), LEBANON), where(pg.originPoint()));
  expect("…and that pickup is behind him, not a stop to drive back to", shipper?.skipRoute === true && !shipper.done,
    JSON.stringify({ skipRoute: shipper?.skipRoute, done: shipper?.done }));
  expect("…and Pine Grove is still the stop ahead", pg.upcomingRoutedStop()?.id === "pinegrove", pg.upcomingRoutedStop()?.id);
}

// --- b. Then a newer fix, only if the location is already allowed ---
console.log("\nb. A newer fix replaces it; a miss or a denial leaves it");
{
  const pg = page();
  navigateToLebanon(pg);
  pg.endRouteNav();
  const watch = lastWatch(pg);
  expect("one quiet location watch starts after navigation is off", pg.geo.watches.length === 1 && watch?.navOnAtCall === false,
    `${pg.geo.watches.length} watch(es), navOn at call ${watch?.navOnAtCall}`);
  expect("…asking for a new fix, not a cached one", watch?.options?.maximumAge === 0, JSON.stringify(watch?.options));
  expect("…with no Updating location… progress or Waiting for permission", pg.state.locating === false && !/Updating|Asking/.test(pg.state.locationNotice),
    pg.state.locationNotice);
  watch?.ok(position(LANCASTER, NOW - 60000));
  expect("a cached fix older than the last nav fix is ignored", near(pg.state.origin, LEBANON), where(pg.state.origin));
  const firstId = pg.state.stops[0]?.id;
  const renders = pg.calls.render;
  watch?.ok(position(FARTHER));
  expect("a newer fix moves the start to it", near(pg.state.origin, FARTHER) && near(pg.originPoint(), FARTHER), where(pg.state.origin));
  expect("…same Current location start, not another one", pg.state.stops[0]?.id === firstId
    && pg.state.stops.filter((stop) => stop.useCurrentLocation).length === 1);
  expect("…persisted and drawn", near(saved(pg)?.origin, FARTHER) && pg.calls.render > renders, where(saved(pg)?.origin));
  expect("…and the watch is cleared", pg.geo.cleared.includes(watch?.id));
  expect("no location error", pg.state.locationError === "");
}
{
  const pg = page();
  navigateToLebanon(pg);
  pg.endRouteNav();
  lastWatch(pg)?.fail({ code: 1 });
  expect("location denied: the start stays at the Lebanon nav fix", near(pg.state.origin, LEBANON) && pg.state.stops[0]?.useCurrentLocation,
    where(pg.state.origin));
  expect("…and no error is shown", pg.state.locationError === "" && pg.state.error === "", `${pg.state.locationError}|${pg.state.error}`);
}
{
  const pg = page();
  navigateToLebanon(pg);
  pg.endRouteNav();
  const timer = pg.calls.timers.find((t) => t.live && t.ms >= 10000);
  timer?.fn();
  expect("no new fix before the watch gives up: the start stays at the Lebanon nav fix",
    timer && near(pg.state.origin, LEBANON) && pg.state.locationError === "", where(pg.state.origin));
}
{
  const pg = page({ permission: "prompt" });
  navigateToLebanon(pg);
  pg.navFix = null;
  pg.endRouteNav();
  await flush();
  expect("no nav fix and location not yet allowed: no watch, no prompt, start unchanged",
    pg.geo.watches.length === 0 && pg.geo.asks.length === 0 && pg.state.stops[0]?.id === "start", `${pg.geo.watches.length} watch(es)`);
}
{
  const pg = page({ permission: "granted" });
  navigateToLebanon(pg);
  pg.navFix = null;
  pg.endRouteNav();
  expect("no nav fix: nothing changes before a fix", pg.state.stops[0]?.id === "start");
  await flush();
  lastWatch(pg)?.ok(position(FARTHER));
  expect("no nav fix, location already allowed: the start becomes the new fix",
    pg.state.stops[0]?.useCurrentLocation === true && near(pg.originPoint(), FARTHER), where(pg.originPoint()));
}

// --- c. Add a stop, then Recalculate with navigation off ---
console.log("\nc. Add a stop, then Recalculate (navigation off)");
function endThenAddPilot(pg) {
  navigateToLebanon(pg);
  pg.endRouteNav();
  lastWatch(pg)?.fail({ code: 1 });
  clock.now = NOW + 10 * 60000;
  pg.addStop(pg.state.stops[0].id);
  const pilot = pg.state.stops[1];
  Object.assign(pilot, { name: "PILOT", address: "Pilot, Lebanon PA", ...PILOT });
  return pilot;
}
{
  // The map's Recalculate: GPS does not answer, so the last nav fix is where he is.
  const pg = page();
  const pilot = endThenAddPilot(pg);
  pilot.miles = "3";
  pilot.hours = "0.1";
  pilot.path = [pair(LEBANON), pair(PILOT)];
  await pg.recalculateFromHere();
  const from = pg.calls.routed[0]?.from;
  expect("Recalculate (map): the route request starts at Lebanon, not Lancaster", near(from, LEBANON) && !near(from, LANCASTER), where(from));
  expect("…the trip start is Lebanon when the plan is rebuilt", near(pg.calls.calculate[0]?.origin, LEBANON)
    && pg.calls.calculate[0]?.first?.useCurrentLocation === true, where(pg.calls.calculate[0]?.origin));
  clock.now = NOW;
}
{
  // The Step's Calculate button (it says Recalculate once there is a plan): a fresh GPS fix up the road.
  const pg = page();
  endThenAddPilot(pg);
  pg.arrivedFix = async () => ({ ...FARTHER });
  pg.calls.routed.length = 0;
  await pg.realCalculate();
  const from = pg.calls.routed[0]?.from;
  expect("Recalculate (Calculate button), fresh GPS: the route starts where he is now, not Lancaster",
    near(from, FARTHER) && !near(from, LANCASTER), where(from));
  expect("…the first leg goes to the stop he added", near(pg.calls.routed[0]?.to, PILOT), where(pg.calls.routed[0]?.to));
  expect("…the trip start and the Plan's Now pin are where he is", near(pg.originPoint(), FARTHER)
    && pg.state.stops[0]?.useCurrentLocation === true, where(pg.originPoint()));
  expect("…no route request starts at Lancaster", !pg.calls.routed.some((leg) => near(leg.from, LANCASTER)),
    pg.calls.routed.map((leg) => where(leg.from)).join(" | "));
  clock.now = NOW;
}
{
  const pg = page();
  endThenAddPilot(pg);
  pg.arrivedFix = async () => null;
  pg.calls.routed.length = 0;
  await pg.realCalculate();
  const from = pg.calls.routed[0]?.from;
  expect("Recalculate (Calculate button), GPS does not answer: it starts at the Lebanon nav fix", near(from, LEBANON), where(from));
  clock.now = NOW;
}
{
  const pg = page({ start: "pickup", done: false });
  navigateToLebanon(pg);
  pg.endRouteNav();
  lastWatch(pg)?.fail({ code: 1 });
  pg.calls.routed.length = 0;
  await pg.realCalculate();
  expect("Lancaster-pickup trip, Recalculate: Lebanon to Pine Grove, nothing routed back to Lancaster",
    near(pg.calls.routed[0]?.from, LEBANON) && near(pg.calls.routed[0]?.to, PINE_GROVE)
      && !pg.calls.routed.some((leg) => near(leg.to, LANCASTER) || near(leg.from, LANCASTER)),
    pg.calls.routed.map((leg) => `${where(leg.from)} → ${where(leg.to)}`).join(" | "));
}

// --- d. Saved progress is unchanged by End navigation ---
console.log("\nd. Done stops and the saved left leg stay");
for (const [label, activeTripId, done] of [["unsaved trip (keyed by its stops), one stop done", null, true], ["saved trip, leg right after the start", "trip-1", false]]) {
  const pg = page({ activeTripId, done });
  navigateToLebanon(pg);
  const progressBefore = { ...pg.state.driveProgress };
  pg.endRouteNav();
  lastWatch(pg)?.ok(position(FARTHER));
  const record = pg.readNavProgress();
  const doneNow = pg.state.stops.filter((stop) => stop.done).map((stop) => stop.id);
  expect(`${label}: the trip's progress is found under its key now`, record?.tripKey === pg.tripProgressKey(),
    `${record?.tripKey} vs ${pg.tripProgressKey()} (stored: ${Object.keys(progressMap(pg)).join(", ")})`);
  expect(`${label}: done stops unchanged`, JSON.stringify(record?.doneIds || []) === JSON.stringify(done ? ["ephrata"] : [])
    && JSON.stringify(doneNow) === JSON.stringify(done ? ["ephrata"] : []), `${JSON.stringify(record?.doneIds)} / ${JSON.stringify(doneNow)}`);
  if (done) {
    const ephrata = pg.state.stops.find((stop) => stop.id === "ephrata");
    expect(`${label}: the done stop keeps its marks`, ephrata?.done && ephrata.switched && ephrata.skipRoute);
  }
  const left = pg.openLeftLeg();
  expect(`${label}: the saved left leg is still open for Pine Grove, 20 mi / 0.45 h left`,
    left?.stopId === "pinegrove" && left.remainMiles === 20 && left.remainHours === 0.45 && left.fullMiles === 45, JSON.stringify(left));
  expect(`${label}: navigation resume is off, as End navigation leaves it`, record?.nav === false && record?.aimId === "",
    JSON.stringify({ nav: record?.nav, aimId: record?.aimId }));
  expect(`${label}: drive progress unchanged`, JSON.stringify(pg.state.driveProgress) === JSON.stringify(progressBefore),
    JSON.stringify(pg.state.driveProgress));
  expect(`${label}: no progress is left behind under an old key`, Object.keys(progressMap(pg)).length === 1,
    Object.keys(progressMap(pg)).join(", "));
}

// --- e. Opening another trip does not take the old nav fix ---
console.log("\ne. Another trip keeps its own start");
{
  const pg = page();
  navigateToLebanon(pg);
  pg.loadExample();
  await flush();
  expect("Example opened while navigating: navigation is off", pg.navOn === false);
  expect("…the example starts where it starts, not at Lebanon", near(pg.originPoint(), OTHER_START)
    && pg.state.stops[0]?.id === "ex-here", where(pg.originPoint()));
  expect("…no location watch was started for it", pg.geo.watches.length === 0, `${pg.geo.watches.length}`);
}
{
  const pg = page();
  navigateToLebanon(pg);
  pg.endRouteNav();
  const watch = lastWatch(pg);
  pg.loadTrip("trip-2");
  watch?.ok(position(FARTHER));
  expect("End navigation, then open another saved trip before the new fix lands: that trip keeps its start",
    near(pg.originPoint(), OTHER_START) && pg.state.stops[0]?.id === "k-here", where(pg.originPoint()));
}
{
  const src = extract("applySharedTrip");
  expect("a shared trip that replaces this one ends navigation without moving the start",
    /endRouteNav\(\{[^}]*startHere: false[^}]*\}\)/.test(src), (/endRouteNav\([^)]*\)/.exec(src) || [""])[0]);
}

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
