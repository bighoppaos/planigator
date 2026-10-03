// Build #604: each trip keeps how you ended it. The nav progress (done marks,
// the route spot, and what was left of the leg being driven) is saved per
// trip, so opening another saved trip, a shared trip, or the example and then
// coming back shows that trip as it was when navigation ended. It goes back
// only when that trip's stop is Done, its stops change that leg, Calculate is
// pressed on it, or Clear trip, and none of those touch another trip.
// Not loaded by the site. Run: node tests/trip-progress-per-trip.test.mjs
//
// Loads the real plan, live-drive, nav-progress, End navigation, Done, open
// trip, shared trip, example, Calculate, move stop, and Clear trip functions
// from js/app.js (by name, into a vm sandbox) with buildPlan from js/plan.js.
// HERE routing, the DOM, and the map are stubbed. localStorage is an in-memory
// map that a "reload" (a fresh page) keeps. Fake clock at 2:31 PM ET, Fri Oct 2
// 2026. Trip A's first leg to PACTIV is 146.9 mi / 2 hr 38 min; navigation
// ends with 68.8 mi / 1 hr 14 min left. Set APP_JS to test another app.js.

process.env.TZ = "America/New_York";

import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appSource = readFileSync(process.env.APP_JS || path.join(root, "js/app.js"), "utf8");
const plan = await import(pathToFileURL(path.join(root, "js/plan.js")).href);
const hos = await import(pathToFileURL(path.join(root, "js/hos.js")).href);

const MILE = 1609.344;
const MIN = 60 * 1000;
const HOUR = 3600000;

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
  // Plan and chips
  "normalizeStop", "stopHasSavedLeg", "stopsAndLeaveForPlan", "leaveAtNow", "planClockNow", "rebuiltPlan",
  "catchUpPlan", "zonedPlanStops", "planShape", "paintPlanClocks", "tickLeaveNow", "isDriveChip", "trackLiveDrive",
  "clearLiveDrive", "liveChipState", "liveLeftLine", "paintLiveDriveChips", "chipStatLine", "chipDelayLine",
  "chipParts", "chip", "lateNote", "drivePieceIndex", "driveDelayTarget", "driveDelayAt", "delayBox", "delayLabel",
  "doneStamp", "escapeAttr", "formatMiles", "formatShort", "formatPlanSpan", "formatPlanClock", "shownZone",
  "eventZone", "originStop", "driveTowardName", "leewayDays",
  // Nav progress and the paths that change it
  "tripProgressKey", "readNavProgress", "readNavSpot", "writeNavProgress", "clearNavProgress",
  "rememberNavProgress", "retargetNavProgress", "applyNavProgress", "nextOpenStopId", "leaveNavSession",
  "endNavProgress", "endRouteNav", "readDriveProgress", "clearDriveProgress", "markStopDone",
  "rebuildPlanAfterDone", "loadTrip", "tripReadyToRecalc", "moveStop", "newTrip", "saveNavSpot", "restoreNavSpot",
  // Shared trip, example, Calculate
  "applySharedTrip", "loadExample", "shiftExampleStamps", "exampleWeeksAhead", "addLocalDays", "calculate",
  "needsStartChoice", "billableStops",
];
// Not in older pages. They run without them, so this test can show them failing.
const OPTIONAL_FUNCTIONS = [
  "liveLegProgress", "legProgressFrom", "legDrive", "readLeftLeg", "leftLegKey", "openLeftLeg", "saveLeftLeg",
  "forgetLeftLeg", "forgetOtherTripLeftLeg", "readNavRecord", "readNavProgressMap", "writeNavProgressMap",
  "clearAllNavProgress",
];
const APP_CODE = [
  constLine("LIVE_DRIVE_MS"),
  constLine("LIVE_DRIVE_M"),
  constLine("NAV_PROGRESS_KEY"),
  constLine("NAV_PROGRESS_TRIPS", true),
  constLine("EXAMPLE_STAMP_KEYS"),
  "var navAimStopId = \"\";",
  "var navProgressResume = false;",
  "var liveDrive = null;",
  "var liveDrivePaintAt = 0;",
  "var liveDrivePaintAlong = NaN;",
  ...APP_FUNCTIONS.map((name) => extract(name)),
  ...OPTIONAL_FUNCTIONS.map((name) => extract(name, true)),
].join("\n\n");

const NOW = Date.UTC(2026, 9, 2, 18, 31, 0); // 2:31 PM EDT
const clock = { now: NOW };
class FakeDate extends Date {
  constructor(...args) {
    if (args.length) super(...args);
    else super(clock.now);
  }
  static now() { return clock.now; }
}

const LEG1 = { miles: 146.9, hours: 158 / 60 };
const LEFT_MILES = 68.8;
const LEFT_HOURS = LEG1.hours * (LEFT_MILES / LEG1.miles); // 1 hr 14 min
const LEG2 = { miles: 495, hours: 9 };
const WALMART_BY = Date.UTC(2026, 9, 3, 10, 0, 0); // be there by 6:00 AM Sat
const KROGER = { miles: 80, hours: 1.5 };
const KEY_A = "id:trip-1";
const KEY_B = "id:trip-2";

const SETTINGS = {
  governed: true, governedMph: 62, leaveNow: true, leaveAt: NOW, startMinutes: 330, endMinutes: 1050,
  startAnytime: true, endAnytime: true, hoursOfEleven: 11, hoursBeforeThirty: 8, military: false,
  kilometers: false, arrival: "earliest",
};

function tripAStops() {
  return [
    { id: "here", name: "Current location", useCurrentLocation: true, lat: 39.9, lon: -75.6, miles: "", hours: "" },
    { id: "pactiv", name: "PACTIV", lat: 40, lon: -76.5, miles: String(LEG1.miles), hours: String(LEG1.hours),
      anytime: true, window: false, start: 0, end: 0, delayMinutes: 0 },
    { id: "walmart", name: "WALMART", lat: 41, lon: -84, miles: String(LEG2.miles), hours: String(LEG2.hours),
      anytime: false, window: false, start: WALMART_BY, end: WALMART_BY },
  ];
}

function tripBStops() {
  return [
    { id: "here", name: "Current location", useCurrentLocation: true, lat: 39.9, lon: -75.6, miles: "", hours: "" },
    { id: "kroger", name: "KROGER", lat: 39, lon: -77, miles: String(KROGER.miles), hours: String(KROGER.hours),
      anytime: true, window: false, start: 0, end: 0 },
  ];
}

const wholeLegsA = plan.buildPlan({
  stops: tripAStops().map((stop) => ({ ...stop, miles: Number(stop.miles) || 0, hours: Number(stop.hours) || 0 })),
  settings: { ...SETTINGS, leaveAt: NOW },
  now: NOW,
});

// Saved trips as the last Calculate left them: whole-leg plan and progress.
function savedTrips() {
  return [
    { id: "trip-1", name: "PACTIV run", stops: tripAStops(), settings: {}, plan: wholeLegsA,
      driveProgress: { stopId: "pactiv", remainFraction: 1, leftAt: NOW - HOUR } },
    { id: "trip-2", name: "KROGER run", stops: tripBStops(), settings: {} },
  ];
}

const SHARED = {
  tripName: "Shared run",
  stops: [
    { id: "here", name: "Current location", useCurrentLocation: true, lat: 39.9, lon: -75.6, miles: "", hours: "" },
    { id: "sh-1", name: "SHARED DC", lat: 38, lon: -78, miles: "60", hours: "1.2", anytime: true, window: false, start: 0, end: 0 },
  ],
};

const EXAMPLE = {
  name: "Example trip",
  tripName: "Example trip",
  stops: [
    { id: "ex-here", name: "Current location", useCurrentLocation: true, lat: 39.9, lon: -75.6, miles: "", hours: "" },
    { id: "ex-1", name: "EXAMPLE DC", lat: 37, lon: -79, miles: "120", hours: "2", anytime: true, window: false, start: 0, end: 0 },
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

const noop = () => {};
const LEG1_LINE = { stop: { id: "pactiv" }, start: 0, end: LEG1.miles * MILE };

// A fresh page. Pass the same `storage` to simulate a reload or a new build.
function page({ storage = memoryStorage(), activeTripId = "trip-1", stops } = {}) {
  const calls = { patch: 0, render: 0, here: 0 };
  const context = {
    console, Math, Number, String, JSON, Array, Object, Infinity, NaN, Set, Map, RegExp, Promise, Intl,
    Date: FakeDate,
    ...plan, ...hos,
    calls,
    localStorage: storage,
    document: {
      visibilityState: "visible",
      activeElement: null,
      querySelectorAll: () => [],
      getElementById: () => null,
    },
    window: { clearTimeout: noop, removeEventListener: noop },
    navigator: {},
    history: { replaceState: noop },
    location: { pathname: "/", search: "" },
    queueMicrotask: noop,
    state: {
      stops: stops || (activeTripId === "trip-2" ? tripBStops() : tripAStops()),
      settings: { ...SETTINGS },
      plan: null, estimating: false, driveProgress: null, picker: null, origin: null,
      activeTripId, unlimited: true, credits: 10, signedIn: false,
      trips: savedTrips(),
    },
    navOn: false, routeFull: false, routePageStale: false,
    // End navigation's map, voice, and direction side effects.
    followPinned: false, railMenu: "", northLock: false, compassAim: false, navAlongLock: null,
    navResumeGuard: null, navSpotSavedAlong: null, navLineKey: "line-1", navStopPicked: false, navGuideFromId: "",
    navStopAnnounce: false, navStopAwaitNear: false, navStopSpeakKey: "", directionsAutoKey: "",
    switchSpokenFor: "", pendingAimId: "", navFollowing: false, tripFit: "nextTurn", navReturnTimer: 0,
    navWatch: null, navYou: null, routeMap: null, dirBrowseTimer: 0, onNavCompass: noop,
    clearDirectionPin: noop, clearStopNote: noop, setStopChip: noop, stopNavMotion: noop, resetNavVoice: noop,
    stopMixNavVoice: noop, clearTurnFrame: noop, freezeTyping: noop, syncTripFitButton: noop, showWholeTrip: noop,
    syncRouteChrome: noop, syncTripNavLocks: noop, focusDirectionWindow: noop, paintDrive: noop,
    // The route line, for the saved spot.
    navLine: [[39.9, -75.6], [40, -76.5]], navLegs: [LEG1_LINE], navTravel: 270,
    activeNavLeg: () => LEG1_LINE, rebuildNavLegs: noop,
    // Done, open trip, shared trip, example, and Clear trip side effects.
    paintDoneStop: noop, paintDirectionToward: noop, keepDoneOnSavedTrip: noop, persist: noop,
    parkSpeedNote: noop, showTripSpeedNote: noop, blankSpeedNote: noop, clearSpeedNote: noop, settleLoadedStops: noop,
    pinEnteredClocks: noop, replanAroundDone: noop, calculateButtonLabel: () => "", markShareStopScroll: noop,
    keepSharedOnAccount: async () => {}, wantAccountTrip: false, EXAMPLE_TRIP: EXAMPLE,
    addressEditStarted: false, writingHash: false, lookupOpen: new Set(),
    defaultState: () => ({ stops: [{ id: "blank", name: "Stop 1", miles: "", hours: "" }], plan: null,
      driveProgress: null, activeTripId: null, tripName: "", origin: null }),
    zoneForStop: () => "",
    patchPlanAfterDone: () => { calls.patch += 1; },
    // Calculate: HERE routing and the GPS are stubbed (no network).
    arrivedFix: async () => null, currentFix: async () => null, noteArrivedStops: noop, creditEmptyMessage: () => "",
    activeTransportMode: () => "truck", transportModeTitle: () => "Truck", transportRouteNote: () => "",
    fillHereLegs: async () => { calls.here += 1; return null; }, rememberOrigin: noop, showStopNote: noop,
    // The real render catches the plan up.
    render: () => { calls.render += 1; context.catchUpPlan(); },
    presentAfterPlan: () => context.render(),
  };
  vm.createContext(context);
  vm.runInContext(APP_CODE, context);
  context.state.plan = context.rebuiltPlan();
  return context;
}

// The nav fix handler: the truck is `drivenMiles` into the leg to `stopId`.
function driveTo(pg, stopId, drivenMiles) {
  const stop = pg.state.stops.find((item) => item.id === stopId);
  pg.trackLiveDrive({ along: drivenMiles * MILE }, { stop, start: 0, end: Number(stop.miles) * MILE });
}

const SPOT_ALONG = (LEG1.miles - LEFT_MILES) * MILE;

// Start navigation on trip A, drive to 68.8 mi left, save the route spot, End navigation.
function driveAThenEnd(pg) {
  pg.navOn = true;
  pg.rememberNavProgress();
  driveTo(pg, "pactiv", LEG1.miles - LEFT_MILES);
  pg.saveNavSpot(SPOT_ALONG);
  pg.tickLeaveNow();
  pg.endRouteNav();
}

// Same on trip B, 30 of its 80 miles.
function driveBThenEnd(pg) {
  pg.navOn = true;
  pg.rememberNavProgress();
  driveTo(pg, "kroger", 30);
  pg.tickLeaveNow();
  pg.endRouteNav();
}

// What the page does on load: put back the nav progress, then render.
function boot(pg) {
  pg.applyNavProgress();
  pg.render();
}

const byId = (p, id) => p?.events.find((event) => event.id === id);
const drives = (p, stopId) => p.events.filter((event) => (event.kind === "lead" || event.kind === "stop") && event.stopID === stopId);
const near = (a, b, ms = MIN) => Math.abs(a - b) <= ms;
const clockText = (ms) => new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }).format(new Date(ms));
const sections = (html) => [...html.matchAll(/<div class="chip-sec( [\w-]+)?">([^<]*)<\/div>/g)]
  .map((hit) => ({ kind: (hit[1] || "").trim() || "label", text: hit[2] }));
const stored = (storage) => {
  const raw = JSON.parse(storage.getItem("planigator.web.navprogress") || "null");
  return raw && typeof raw === "object" && typeof raw.tripKey !== "string" ? raw : {};
};
const entry = (storage, key) => stored(storage)[key] || null;

let failures = 0;
function expect(label, ok, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`);
}

// Trip A's top card keeps what is left: starts now, ends after the time left,
// left row only, and the rest of the plan follows.
function expectLeftA(pg, label) {
  const p = pg.state.plan;
  const leg = byId(p, "pactiv");
  expect(`${label}: PACTIV card starts now`, leg && near(leg.start, clock.now), leg ? clockText(leg.start) : "no PACTIV card");
  expect(`${label}: PACTIV card ends after only the time left`, leg && near(leg.end, clock.now + LEFT_HOURS * HOUR),
    leg && `${clockText(leg.end)}, the whole leg would end ${clockText(clock.now + LEG1.hours * HOUR)}`);
  const rows = leg ? sections(pg.chip(leg)) : [];
  expect(`${label}: left row with the time and miles left`,
    rows.find((row) => row.kind === "chip-left")?.text === "1 hr 14 min · 68.8 miles left", JSON.stringify(rows));
  expect(`${label}: no full-leg row`, !rows.some((row) => row.kind === "chip-mid")
    && !rows.some((row) => /2 hr 38 min|146\.9 miles/.test(row.text)), JSON.stringify(rows));
  const next = drives(p, "walmart")[0];
  expect(`${label}: next drive starts when PACTIV ends`, next && leg && near(next.start, leg.end), next && clockText(next.start));
  expect(`${label}: 11-hour clock counts only the drive left`, Math.abs(p.driveHours - (LEFT_HOURS + LEG2.hours)) < 0.01,
    hos.hoursLabel(p.driveHours));
}

function expectWholeA(pg, label) {
  const leg = byId(pg.state.plan, "pactiv");
  expect(`${label}: PACTIV card is the whole leg`, leg && near(leg.end, clock.now + LEG1.hours * HOUR), leg && clockText(leg.end));
  const rows = leg ? sections(pg.chip(leg)) : [];
  expect(`${label}: normal row, no left row`, rows.find((row) => row.kind === "chip-mid")?.text === "2 hr 38 min · 146.9 miles"
    && !rows.some((row) => row.kind === "chip-left"), JSON.stringify(rows));
}

function expectWholeB(pg, label) {
  const leg = byId(pg.state.plan, "kroger");
  expect(`${label}: trip B's KROGER card is its whole leg from now`, leg && near(leg.start, clock.now)
    && near(leg.end, clock.now + KROGER.hours * HOUR), leg ? `${clockText(leg.start)} – ${clockText(leg.end)}` : "no KROGER card");
  const rows = leg ? sections(pg.chip(leg)) : [];
  expect(`${label}: trip B has no left row`, !rows.some((row) => row.kind === "chip-left"), JSON.stringify(rows));
  expect(`${label}: no PACTIV card on trip B`, !byId(pg.state.plan, "pactiv"));
}

// Reopened as ended: not navigating, no stop aimed, marked, or moved on.
function expectNotSwitched(pg, label) {
  expect(`${label}: navigation did not start`, pg.navOn === false && pg.navProgressResume === false);
  expect(`${label}: no stop aimed, marked done, or moved on`, pg.navAimStopId === ""
    && !pg.state.stops.some((stop) => stop.done || stop.skipRoute)
    && pg.state.stops.map((stop) => stop.id).join(",") === "here,pactiv,walmart",
  `aim="${pg.navAimStopId}"`);
}

function expectSpotA(storage, label) {
  const spot = entry(storage, KEY_A)?.spot;
  expect(`${label}: trip A's route spot is still saved for trip A`, spot && Math.abs(spot.along - SPOT_ALONG) < 1
    && spot.stopId === "pactiv", JSON.stringify(spot));
}

console.log("Trip A: End navigation, open trip B, open trip A again");
{
  const storage = memoryStorage();
  const pg = page({ storage });
  driveAThenEnd(pg);
  expectLeftA(pg, "after End navigation");
  expectSpotA(storage, "after End navigation");

  clock.now = NOW + 5 * MIN;
  pg.loadTrip("trip-2");
  expectWholeB(pg, "trip B open");
  expect("trip A's saved left leg is kept while trip B is open", entry(storage, KEY_A)?.leftLeg?.stopId === "pactiv",
    JSON.stringify(entry(storage, KEY_A)));
  expect("trip B has no saved progress of its own", entry(storage, KEY_B) === null, JSON.stringify(entry(storage, KEY_B)));

  clock.now = NOW + 10 * MIN;
  pg.loadTrip("trip-1");
  expectLeftA(pg, "trip A again");
  expectNotSwitched(pg, "trip A again");
  expectSpotA(storage, "trip A again");
  expect("trip A was not shown as of its last Calculate", (() => {
    const leg = byId(pg.state.plan, "pactiv");
    const stale = byId(wholeLegsA, "pactiv");
    return leg && stale && !near(leg.end, stale.end) && !near(leg.end, clock.now + LEG1.hours * HOUR);
  })());
  clock.now = NOW;
}

console.log("\nTrip B is its own: navigating it and ending does not erase trip A");
{
  const storage = memoryStorage();
  const pg = page({ storage });
  driveAThenEnd(pg);
  pg.loadTrip("trip-2");
  driveBThenEnd(pg);
  const b = byId(pg.state.plan, "kroger");
  expect("trip B shows its own left (50 of 80 miles)", b && near(b.end, clock.now + KROGER.hours * (50 / 80) * HOUR),
    b && clockText(b.end));
  expect("both trips have their own entry", entry(storage, KEY_A)?.leftLeg?.stopId === "pactiv"
    && entry(storage, KEY_B)?.leftLeg?.stopId === "kroger", Object.keys(stored(storage)).join(","));
  pg.loadTrip("trip-1");
  expectLeftA(pg, "trip A after trip B was driven");
  pg.loadTrip("trip-2");
  expect("trip B still has its own left, not trip A's", (() => {
    const leg = byId(pg.state.plan, "kroger");
    return leg && near(leg.end, clock.now + KROGER.hours * (50 / 80) * HOUR) && !byId(pg.state.plan, "pactiv");
  })());
}

console.log("\nReload in between (trip B open on the reloaded page)");
{
  const storage = memoryStorage();
  const pg = page({ storage });
  driveAThenEnd(pg);
  pg.loadTrip("trip-2");
  clock.now = NOW + 20 * MIN;
  const again = page({ storage, activeTripId: "trip-2" });
  boot(again);
  expectWholeB(again, "reloaded on trip B");
  again.loadTrip("trip-1");
  expectLeftA(again, "trip A after reload");
  expectNotSwitched(again, "trip A after reload");
  expectSpotA(storage, "trip A after reload");

  const twice = page({ storage, activeTripId: "trip-1" });
  boot(twice);
  expectLeftA(twice, "reloaded on trip A");
  clock.now = NOW;
}

console.log("\nA shared trip in between");
{
  const storage = memoryStorage();
  const pg = page({ storage });
  driveAThenEnd(pg);
  pg.applySharedTrip(JSON.parse(JSON.stringify(SHARED)));
  const shared = byId(pg.state.plan, "sh-1");
  expect("shared trip shows its whole leg", shared && near(shared.end, clock.now + 1.2 * HOUR) && !byId(pg.state.plan, "pactiv"),
    shared && clockText(shared.end));
  expect("trip A's entry is kept", entry(storage, KEY_A)?.leftLeg?.stopId === "pactiv");
  pg.loadTrip("trip-1");
  expectLeftA(pg, "trip A after a shared trip");
  expectNotSwitched(pg, "trip A after a shared trip");
}

console.log("\nThe example in between");
{
  const storage = memoryStorage();
  const pg = page({ storage });
  driveAThenEnd(pg);
  pg.loadExample();
  const ex = byId(pg.state.plan, "ex-1");
  expect("example shows its whole leg", ex && near(ex.end, clock.now + 2 * HOUR) && !byId(pg.state.plan, "pactiv"),
    ex && clockText(ex.end));
  expect("trip A's entry is kept", entry(storage, KEY_A)?.leftLeg?.stopId === "pactiv");
  pg.loadTrip("trip-1");
  expectLeftA(pg, "trip A after the example");
  expectNotSwitched(pg, "trip A after the example");
}

// Trip A and trip B both driven and ended, trip A open again.
function bothDriven() {
  const storage = memoryStorage();
  const pg = page({ storage });
  driveAThenEnd(pg);
  pg.loadTrip("trip-2");
  driveBThenEnd(pg);
  pg.loadTrip("trip-1");
  const b = JSON.stringify(entry(storage, KEY_B));
  return { storage, pg, b };
}

function expectBAlone(storage, b, label) {
  expect(`${label}: trip B's entry is untouched`, entry(storage, KEY_B) !== null
    && JSON.stringify(entry(storage, KEY_B)) === b, JSON.stringify(entry(storage, KEY_B)));
}

console.log("\nTrip A's PACTIV marked Done");
{
  const { storage, pg, b } = bothDriven();
  pg.markStopDone(pg.state.stops.find((stop) => stop.id === "pactiv"), { switched: true });
  const p = pg.state.plan;
  const next = drives(p, "walmart");
  const hours = next.reduce((sum, event) => sum + (Number(event.tripHours) || 0), 0);
  expect("no PACTIV card; WALMART is its whole leg from now", !byId(p, "pactiv") && next[0] && near(next[0].start, clock.now)
    && Math.abs(hours - LEG2.hours) < 0.01, next[0] && `${clockText(next[0].start)}, ${hos.hoursLabel(hours)}`);
  expect("trip A's saved left leg and spot are gone", !entry(storage, KEY_A)?.leftLeg && !entry(storage, KEY_A)?.spot,
    JSON.stringify(entry(storage, KEY_A)));
  expectBAlone(storage, b, "Done on trip A");
}

console.log("\nTrip A's stops edited so the leg differs");
{
  const { storage, b } = bothDriven();
  const rerouted = tripAStops();
  rerouted[1].miles = "150.2";
  rerouted[1].hours = String(162 / 60);
  const pg = page({ storage, stops: rerouted });
  boot(pg);
  const leg = byId(pg.state.plan, "pactiv");
  expect("a new route for that leg: whole new leg, no left row", leg && near(leg.end, clock.now + (162 / 60) * HOUR)
    && !sections(pg.chip(leg)).some((row) => row.kind === "chip-left"), leg && clockText(leg.end));

  const same = page({ storage });
  boot(same);
  expectLeftA(same, "unchanged leg still keeps it");
  same.moveStop("pactiv", 1);
  expect("moving the stop drops trip A's saved left leg", !entry(storage, KEY_A)?.leftLeg, JSON.stringify(entry(storage, KEY_A)));
  expectBAlone(storage, b, "stop moved on trip A");
}

console.log("\nCalculate pressed on trip A");
{
  const { storage, pg, b } = bothDriven();
  await pg.calculate();
  expect("HERE routing is stubbed and was asked once", pg.calls.here === 1, `${pg.calls.here} call(s)`);
  expect("trip A's saved left leg is gone", !entry(storage, KEY_A)?.leftLeg, JSON.stringify(entry(storage, KEY_A)));
  expectWholeA(pg, "after Calculate");
  expectBAlone(storage, b, "Calculate on trip A");

  const silent = bothDriven();
  await silent.pg.calculate({ silent: true, skipHash: true });
  expectLeftA(silent.pg, "a silent catch-up calculate keeps it");
}

console.log("\nClear trip on trip A");
{
  const { storage, pg, b } = bothDriven();
  pg.newTrip();
  expect("trip A's saved left leg is gone", !entry(storage, KEY_A)?.leftLeg, JSON.stringify(entry(storage, KEY_A)));
  expectBAlone(storage, b, "Clear trip on trip A");
  const again = page({ storage });
  boot(again);
  expectWholeA(again, "trip A entered again");
}

console.log("\nStart navigation again: the saved spot is still guarded");
{
  const storage = memoryStorage();
  const pg = page({ storage });
  driveAThenEnd(pg);
  pg.loadTrip("trip-2");
  pg.loadTrip("trip-1");
  pg.navOn = true;
  pg.rememberNavProgress();
  pg.navAlongLock = null;
  pg.activeNavLeg = () => ({ stop: { id: "walmart" }, start: LEG1.miles * MILE, end: (LEG1.miles + LEG2.miles) * MILE });
  expect("a spot on another leg does not lock the along", pg.restoreNavSpot() === false && pg.navAlongLock === null,
    `lock=${pg.navAlongLock}`);
  pg.activeNavLeg = () => LEG1_LINE;
  expect("on that leg it resumes there", pg.restoreNavSpot() === true && Math.abs(pg.navAlongLock - SPOT_ALONG) < 1,
    `lock=${pg.navAlongLock}`);
}

console.log("\nOnly the most recently saved trips are kept");
{
  const storage = memoryStorage();
  const pg = page({ storage });
  const cap = pg.NAV_PROGRESS_TRIPS;
  expect("the cap is about 20 trips", cap === 20, String(cap));
  for (let i = 0; i < 25; i += 1) {
    clock.now = NOW + i * MIN;
    pg.writeNavProgress({ tripKey: `id:t${i}`, doneIds: ["x"], aimId: "", nav: false, spot: null, leftLeg: null });
  }
  const keys = Object.keys(stored(storage));
  expect("20 trips kept", keys.length === 20, String(keys.length));
  expect("the 5 oldest are dropped", [0, 1, 2, 3, 4].every((i) => !keys.includes(`id:t${i}`)), keys.join(","));
  expect("the newest 20 are kept", Array.from({ length: 20 }, (_, i) => `id:t${i + 5}`).every((key) => keys.includes(key)));
  clock.now = NOW;
}

console.log("\nOld single-trip record (Build #603) in localStorage");
{
  const storage = memoryStorage();
  const old = page({ storage });
  const stop = old.state.stops.find((item) => item.id === "pactiv");
  storage.setItem("planigator.web.navprogress", JSON.stringify({
    tripKey: KEY_A, doneIds: [], aimId: "", nav: false, spot: null,
    leftLeg: { stopId: "pactiv", legKey: old.leftLegKey(stop), remainMiles: LEFT_MILES, remainHours: LEFT_HOURS,
      fullMiles: LEG1.miles, at: NOW - 5 * MIN },
  }));
  const pg = page({ storage });
  boot(pg);
  expectLeftA(pg, "read from the old record");
  pg.loadTrip("trip-2");
  driveBThenEnd(pg);
  expect("saving trip B moves to one entry per trip and keeps trip A", entry(storage, KEY_A)?.leftLeg?.stopId === "pactiv"
    && entry(storage, KEY_B)?.leftLeg?.stopId === "kroger", storage.getItem("planigator.web.navprogress"));
  pg.loadTrip("trip-1");
  expectLeftA(pg, "trip A after the move");
}

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
