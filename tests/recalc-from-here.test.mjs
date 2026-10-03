// Build #620 (was end-nav-start.test.mjs, Build #618): End navigation does not
// touch the trip start. The first stop, state.origin and the "Choose where the
// trip starts" choice stay as he set them, and no stop is marked passed. Both
// Recalculate buttons route from where he is: a fresh GPS fix, or the last nav
// fix when GPS does not answer. The map's Recalculate and the page's
// Recalculate (the Calculate button once a plan exists) both start the trip at
// a Current location stop there and mark the old start passed, keeping its
// address. Done stops stay done under the trip's progress key. "Recalculate
// from <stop>" (only new stops at the end) still routes from that stop.
// Not loaded by the site. Run: node tests/recalc-from-here.test.mjs
// Against other copies: APP_JS=/path/to/app.js node tests/recalc-from-here.test.mjs
//
// Loads the real End navigation, Start from my location, nav progress,
// Recalculate, Calculate, and open-trip functions from js/app.js into a vm
// sandbox. Geolocation, timers, HERE routing, and the map are stubbed.
// Trip: starts in Lancaster, PA; he is near Lebanon, PA.

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

// Not in every copy of the page. It runs without them, so this test can show it failing.
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
    "readDriveProgress", "persist", "rememberNavProgress",
    // Start from my location
    "locateSucceeded", "dropAddressStart", "movedEnough", "endLocateWatch", "rememberOrigin", "originPoint",
    "fixTime", "editorBusy", "pointReady", "addStop",
    // Recalculate (map) and Calculate (Step button)
    "recalculateFromHere", "currentFix", "askPosition", "arrivedFix", "navFixFresh", "rebuildNavLegs", "activeNavLeg",
    "upcomingRoutedStop", "applyAheadLeg", "routeFromHere", "abortRecalc", "stopPoint", "calculate",
    "needsStartChoice", "billableStops", "fillHereLegs", "writeRoutedLeg",
    // Opening another trip
    "loadExample", "loadTrip",
  ].map(extract),
  ...["startTripAt", "carryNavProgress", "startTripAfterNav", "refreshTripStart", "startRecalcHere", "passStop",
    "recalcTarget", "stopUnrouted", "legsOnFrom"].map(optional),
].join("\n\n");

const LANCASTER = { lat: 40.0379, lon: -76.3055 };
const LEBANON = { lat: 40.3409, lon: -76.4113 };
const FARTHER = { lat: 40.3601, lon: -76.429 }; // a newer fix up the road from Lebanon
const EPHRATA = { lat: 40.1798, lon: -76.1788 };
const PINE_GROVE = { lat: 40.5487, lon: -76.3847 };
const WILKES = { lat: 41.2459, lon: -75.8813 };
const SCRANTON = { lat: 41.4089, lon: -75.6624 };
const OTHER_START = { lat: 39.9, lon: -75.6 };

const NOW = Date.UTC(2026, 9, 3, 14, 40, 0); // 10:40 AM EDT
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
// "current" (Start from my location, taken in Lancaster), or "pickup" (no
// Start card; the first stop, in Lancaster, is where it starts).
function tripStops({ start = "address", done = true } = {}) {
  const stops = [];
  if (start === "address") {
    stops.push({ id: "start", name: "Start", address: "Lancaster, PA", ...LANCASTER, anytime: true, miles: "", hours: "" });
  } else if (start === "current") {
    stops.push({ id: "here", name: "Current location", useCurrentLocation: true, ...LANCASTER, address: "", miles: "", hours: "" });
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

// Geolocation: getCurrentPosition answers with `answer` (or fails); watches are recorded.
function fakeGeo(pg) {
  const geo = {
    watches: [],
    asks: [],
    answer: null,
    watchPosition(ok, fail, options) {
      geo.watches.push({ ok, fail, options, navOnAtCall: pg.navOn });
      return geo.watches.length;
    },
    clearWatch: () => {},
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
      plan: { events: [] }, origin: start === "current" ? { ...LANCASTER } : null, driveProgress: null, activeTripId,
      tripName: "", trips: [OTHER_TRIP],
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

// End navigation near Lebanon, then a few minutes later (the nav fix is no longer fresh).
function endedAtLebanon(pg, gps = LEBANON) {
  navigateToLebanon(pg);
  pg.endRouteNav();
  clock.now = NOW + 10 * 60000;
  pg.geo.answer = gps ? { ...gps } : null;
}

// Planned, never navigated; he is near Lebanon now.
function plannedAtLebanon(pg, gps = LEBANON) {
  pg.geo.answer = gps ? { ...gps } : null;
}

const near = (a, b) => a && b && Math.abs(Number(a.lat) - b.lat) < 1e-6 && Math.abs(Number(a.lon) - b.lon) < 1e-6;
const where = (p) => (p ? `${Number(p.lat).toFixed(4)}, ${Number(p.lon).toFixed(4)}` : String(p));
const legText = (pg) => pg.calls.routed.map((leg) => `${where(leg.from)} → ${where(leg.to)}`).join(" | ") || "none";
const saved = (pg) => JSON.parse(pg.localStorage.getItem("planigator.web.v1") || "null");
const progressMap = (pg) => JSON.parse(pg.localStorage.getItem("planigator.web.navprogress") || "null") || {};
const flush = () => new Promise((resolve) => setImmediate(resolve));
const byId = (pg, id) => pg.state.stops.find((stop) => stop.id === id);
const stepStart = (pg) => (pg.state.stops[0]?.useCurrentLocation ? "my location"
  : (pg.state.stops[0]?.name || "").trim().toLowerCase() === "start" ? "address" : "none");

let failures = 0;
function expect(label, ok, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`);
}

// --- a. End navigation leaves the start alone ---
console.log("a. End navigation near Lebanon: the trip start does not change");
for (const start of ["address", "current", "pickup"]) {
  const pg = page({ start, done: start !== "pickup" });
  const firstBefore = JSON.stringify(pg.state.stops[0]);
  const originBefore = JSON.stringify(pg.state.origin);
  const idsBefore = pg.state.stops.map((stop) => stop.id).join(",");
  const stepBefore = stepStart(pg);
  navigateToLebanon(pg);
  pg.endRouteNav();
  await flush();
  const label = { address: "address start (Lancaster)", current: "Current location start (taken in Lancaster)", pickup: "trip that starts at its Lancaster pickup" }[start];
  expect(`${label}: navigation is off`, pg.navOn === false);
  expect(`${label}: the first stop is unchanged`, JSON.stringify(pg.state.stops[0]) === firstBefore, pg.state.stops[0]?.name);
  expect(`${label}: state.origin is unchanged`, JSON.stringify(pg.state.origin) === originBefore, JSON.stringify(pg.state.origin));
  expect(`${label}: the stops are the same stops`, pg.state.stops.map((stop) => stop.id).join(",") === idsBefore,
    pg.state.stops.map((stop) => stop.id).join(","));
  expect(`${label}: "Choose where the trip starts" still shows ${stepBefore}`, stepStart(pg) === stepBefore, stepStart(pg));
  expect(`${label}: the first stop is not marked passed`, !pg.state.stops[0]?.skipRoute && !pg.state.stops[0]?.done);
  expect(`${label}: the stops ahead are not marked passed`, ["pinegrove", "wilkes"].every((id) => !byId(pg, id)?.skipRoute));
  expect(`${label}: no location watch and no location prompt`, pg.geo.watches.length === 0 && pg.geo.asks.length === 0,
    `${pg.geo.watches.length} watch(es), ${pg.geo.asks.length} ask(s)`);
  if (start === "address") {
    const stored = saved(pg);
    expect(`${label}: nothing stored moves the start`, !stored || (stored.stops?.[0]?.id === "start" && stored.origin == null),
      JSON.stringify({ first: stored?.stops?.[0]?.id, origin: stored?.origin }));
  }
}

// --- b. Saved progress is unchanged by End navigation ---
console.log("\nb. Done stops and the saved left leg stay");
for (const [label, activeTripId, done] of [["unsaved trip (keyed by its stops), one stop done", null, true], ["saved trip, leg right after the start", "trip-1", false]]) {
  const pg = page({ activeTripId, done });
  navigateToLebanon(pg);
  const keyBefore = pg.tripProgressKey();
  const progressBefore = { ...pg.state.driveProgress };
  pg.endRouteNav();
  const record = pg.readNavProgress();
  const doneNow = pg.state.stops.filter((stop) => stop.done).map((stop) => stop.id);
  expect(`${label}: the trip's progress key is the same`, pg.tripProgressKey() === keyBefore && record?.tripKey === keyBefore,
    `${record?.tripKey} vs ${keyBefore}`);
  expect(`${label}: done stops unchanged`, JSON.stringify(record?.doneIds || []) === JSON.stringify(done ? ["ephrata"] : [])
    && JSON.stringify(doneNow) === JSON.stringify(done ? ["ephrata"] : []), `${JSON.stringify(record?.doneIds)} / ${JSON.stringify(doneNow)}`);
  const left = pg.openLeftLeg();
  expect(`${label}: the saved left leg is still open for Pine Grove, 20 mi / 0.45 h left`,
    left?.stopId === "pinegrove" && left.remainMiles === 20 && left.remainHours === 0.45 && left.fullMiles === 45, JSON.stringify(left));
  expect(`${label}: navigation resume is off, as End navigation leaves it`, record?.nav === false && record?.aimId === "",
    JSON.stringify({ nav: record?.nav, aimId: record?.aimId }));
  expect(`${label}: drive progress unchanged`, JSON.stringify(pg.state.driveProgress) === JSON.stringify(progressBefore),
    JSON.stringify(pg.state.driveProgress));
  expect(`${label}: one progress record`, Object.keys(progressMap(pg)).length === 1, Object.keys(progressMap(pg)).join(", "));
}

// --- c. The page's Recalculate routes from where he is ---
console.log("\nc. The page's Recalculate (Calculate once a plan exists) starts where he is");
for (const start of ["address", "current"]) {
  for (const [how, setUp] of [["planned, never navigated", plannedAtLebanon], ["after End navigation", endedAtLebanon]]) {
    const pg = page({ start, done: false });
    setUp(pg);
    const hereId = pg.state.stops[0]?.useCurrentLocation ? pg.state.stops[0].id : null;
    await pg.realCalculate();
    const label = `${start === "address" ? "address start (Lancaster)" : "Current location start"}, ${how}`;
    const legs = pg.calls.routed;
    expect(`${label}: the first route request starts at Lebanon (fresh GPS)`, near(legs[0]?.from, LEBANON), legText(pg));
    expect(`${label}: …and goes to the first stop ahead (Pine Grove), then Wilkes-Barre`,
      near(legs[0]?.to, PINE_GROVE) && near(legs[1]?.from, PINE_GROVE) && near(legs[1]?.to, WILKES) && legs.length === 2, legText(pg));
    expect(`${label}: nothing is routed from or to Lancaster`, !legs.some((leg) => near(leg.from, LANCASTER) || near(leg.to, LANCASTER)), legText(pg));
    expect(`${label}: the trip start (and the Plan's Now pin) is a Current location stop at Lebanon`,
      pg.state.stops[0]?.useCurrentLocation === true && near(pg.originPoint(), LEBANON) && near(pg.state.stops[0], LEBANON),
      where(pg.originPoint()));
    if (start === "address") {
      const card = byId(pg, "start");
      expect(`${label}: the Lancaster Start card keeps its address and is marked passed`,
        card?.address === "Lancaster, PA" && near(card, LANCASTER) && card.skipRoute === true,
        JSON.stringify({ address: card?.address, skipRoute: card?.skipRoute }));
    } else {
      expect(`${label}: the same Current location stop, moved`, pg.state.stops[0]?.id === hereId
        && pg.state.stops.filter((stop) => stop.useCurrentLocation).length === 1, pg.state.stops[0]?.id);
    }
    expect(`${label}: no error`, pg.state.error === "", pg.state.error);
    clock.now = NOW;
  }
}
{
  const pg = page({ done: false });
  endedAtLebanon(pg, null);
  await pg.realCalculate();
  expect("page Recalculate, GPS does not answer: it starts at the last nav fix (Lebanon)", near(pg.calls.routed[0]?.from, LEBANON)
    && near(pg.originPoint(), LEBANON), legText(pg));
  clock.now = NOW;
}
{
  const pg = page({ done: false });
  plannedAtLebanon(pg, FARTHER);
  await pg.realCalculate();
  expect("page Recalculate uses the fix it just got", near(pg.calls.routed[0]?.from, FARTHER), legText(pg));
}
{
  const pg = page({ start: "pickup", done: false });
  endedAtLebanon(pg);
  await pg.realCalculate();
  expect("Lancaster-pickup trip, page Recalculate: Lebanon to Pine Grove, nothing routed back to Lancaster",
    near(pg.calls.routed[0]?.from, LEBANON) && near(pg.calls.routed[0]?.to, PINE_GROVE)
      && !pg.calls.routed.some((leg) => near(leg.to, LANCASTER) || near(leg.from, LANCASTER)), legText(pg));
  clock.now = NOW;
}
{
  // A stop added at the end: the button says "Recalculate from WILKES-BARRE" and routes only that new leg.
  const pg = page({ done: false });
  plannedAtLebanon(pg);
  pg.state.stops.push({ id: "scranton", name: "SCRANTON", ...SCRANTON, miles: "", hours: "" });
  await pg.realCalculate();
  expect("only a new stop at the end (\"Recalculate from WILKES-BARRE\"): one leg, from Wilkes-Barre, start untouched",
    pg.calls.routed.length === 1 && near(pg.calls.routed[0].from, WILKES) && near(pg.calls.routed[0].to, SCRANTON)
      && pg.state.stops[0]?.id === "start", legText(pg));
}
{
  const pg = page({ done: false });
  pg.state.plan = null;
  plannedAtLebanon(pg);
  await pg.realCalculate();
  expect("first Calculate (no plan yet): routes from the start he chose (Lancaster)", near(pg.calls.routed[0]?.from, LANCASTER)
    && pg.state.stops[0]?.id === "start", legText(pg));
}

// --- d. The map's Recalculate routes from where he is ---
console.log("\nd. The map's Recalculate starts where he is");
for (const start of ["address", "current"]) {
  for (const gps of [LEBANON, null]) {
    const pg = page({ start, done: false });
    endedAtLebanon(pg, gps);
    await pg.recalculateFromHere();
    const label = `${start === "address" ? "address start" : "Current location start"}, ${gps ? "fresh GPS" : "GPS does not answer (last nav fix)"}`;
    expect(`${label}: the route request starts at Lebanon, not Lancaster`, near(pg.calls.routed[0]?.from, LEBANON)
      && near(pg.calls.routed[0]?.to, PINE_GROVE), legText(pg));
    expect(`${label}: the trip start is Lebanon when the plan is rebuilt`, near(pg.calls.calculate[0]?.origin, LEBANON)
      && pg.calls.calculate[0]?.first?.useCurrentLocation === true, where(pg.calls.calculate[0]?.origin));
    if (start === "address") {
      const card = byId(pg, "start");
      expect(`${label}: the Lancaster Start card keeps its address and is marked passed`,
        card?.address === "Lancaster, PA" && card.skipRoute === true, JSON.stringify({ skipRoute: card?.skipRoute }));
    }
    clock.now = NOW;
  }
}

// --- e. Recalculate keeps the trip's done stops under its progress key ---
console.log("\ne. Done stops stay with the trip after a page Recalculate");
for (const [label, activeTripId] of [["unsaved trip (keyed by its stops)", null], ["saved trip", "trip-1"]]) {
  const pg = page({ activeTripId, done: true });
  endedAtLebanon(pg);
  await pg.realCalculate();
  const record = pg.readNavProgress();
  expect(`${label}: the progress record is under the trip's key now`, record?.tripKey === pg.tripProgressKey(),
    `${record?.tripKey} vs ${pg.tripProgressKey()}`);
  expect(`${label}: EPHRATA is still done, there and on the stop`, JSON.stringify(record?.doneIds) === JSON.stringify(["ephrata"])
    && byId(pg, "ephrata")?.done === true, JSON.stringify(record?.doneIds));
  expect(`${label}: no progress is left behind under an old key`, Object.keys(progressMap(pg)).length === 1,
    Object.keys(progressMap(pg)).join(", "));
  clock.now = NOW;
}

// --- f. Opening another trip ---
console.log("\nf. Another trip keeps its own start");
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
  pg.loadTrip("trip-2");
  expect("End navigation, then open another saved trip: that trip keeps its start",
    near(pg.originPoint(), OTHER_START) && pg.state.stops[0]?.id === "k-here", where(pg.originPoint()));
}
for (const name of ["applySharedTrip", "loadExample"]) {
  const call = (/endRouteNav\([^)]*\)/.exec(extract(name)) || [""])[0];
  expect(`${name} ends navigation with plain endRouteNav({ paint: false })`, call === "endRouteNav({ paint: false })", call);
}

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
