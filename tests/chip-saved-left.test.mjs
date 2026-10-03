// Build #605: with navigation off, the small time chip at the bottom of the map
// on the page (#routeDrive) shows the time left saved for this trip's leg (the
// Plan's drive you were on, without delays) instead of that stop's whole drive.
// It goes back to the whole drive when that stop is Done, the leg changes,
// Calculate, or Clear trip, and each trip shows its own. While navigating it
// still follows the live position, and full screen is unchanged.
// Not loaded by the site. Run: node tests/chip-saved-left.test.mjs
//
// Loads the real chip, plan, live-drive, nav-progress, End navigation, Done,
// open trip, Calculate, move stop, and Clear trip functions from js/app.js (by
// name, into a vm sandbox) with buildPlan from js/plan.js. #routeDrive is a
// stub element; HERE routing and the map are stubbed; the road line is each
// stop's saved miles. localStorage is an in-memory map that a "reload" keeps.
// Fake clock at 2:31 PM ET, Fri Oct 2 2026. Trip A's first leg to PACTIV is
// 146.9 mi / 2 hr 38 min; navigation ends with 68.8 mi / 1 hr 14 min left.
// Set APP_JS to test another app.js.

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
  // The map chips
  "paintDrive", "stopDriveText", "nextStopMeters", "hoursForMeters", "driveLeftText", "setStopChip", "etaLabel",
  "navMiles", "formatClockMinutes", "pad", "mph", "polylineMeters", "metersBetween",
  // Plan and chips
  "normalizeStop", "stopHasSavedLeg", "stopsAndLeaveForPlan", "leaveAtNow", "planClockNow", "rebuiltPlan",
  "catchUpPlan", "zonedPlanStops", "planShape", "paintPlanClocks", "tickLeaveNow", "isDriveChip", "trackLiveDrive",
  "clearLiveDrive", "liveChipState", "liveLeftLine", "paintLiveDriveChips", "chipStatLine", "chipDelayLine",
  "chipParts", "chip", "lateNote", "drivePieceIndex", "driveDelayTarget", "driveDelayAt", "delayBox", "delayLabel",
  "doneStamp", "escapeAttr", "formatMiles", "formatShort", "formatPlanSpan", "formatPlanClock", "shownZone",
  "eventZone", "originStop", "driveTowardName", "leewayDays",
  // Nav progress and the paths that change it
  "tripProgressKey", "readNavProgress", "readNavSpot", "writeNavProgress", "clearNavProgress", "readNavRecord",
  "readNavProgressMap", "writeNavProgressMap", "clearAllNavProgress",
  "rememberNavProgress", "retargetNavProgress", "applyNavProgress", "nextOpenStopId", "leaveNavSession",
  "endNavProgress", "endRouteNav", "readDriveProgress", "clearDriveProgress", "markStopDone",
  "rebuildPlanAfterDone", "loadTrip", "tripReadyToRecalc", "moveStop", "newTrip", "saveNavSpot",
  "liveLegProgress", "legProgressFrom", "legDrive", "readLeftLeg", "leftLegKey", "openLeftLeg", "saveLeftLeg",
  "forgetLeftLeg",
  // Calculate
  "calculate", "needsStartChoice", "billableStops",
];
// Not in older pages. They run without them, so this test can show them failing.
const OPTIONAL_FUNCTIONS = ["pageDriveText", "forgetOtherTripLeftLeg"];
const APP_CODE = [
  constLine("LIVE_DRIVE_MS"),
  constLine("LIVE_DRIVE_M"),
  constLine("NAV_PROGRESS_KEY"),
  constLine("NAV_PROGRESS_TRIPS"),
  "var navAimStopId = \"\";",
  "var navProgressResume = false;",
  "var liveDrive = null;",
  "var liveDrivePaintAt = 0;",
  "var liveDrivePaintAlong = NaN;",
  "var driveAlong = null;",
  "var driveStopMeters = null;",
  "var stopChipLines = [];",
  "var stopChipIndex = 0;",
  "var stopChipTimer = 0;",
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
const LEG2 = { miles: 495, hours: 9 };
const WALMART_BY = Date.UTC(2026, 9, 3, 10, 0, 0); // be there by 6:00 AM Sat
const KROGER = { miles: 80, hours: 1.5 };

const SETTINGS = {
  governed: true, governedMph: 62, leaveNow: true, leaveAt: NOW, startMinutes: 330, endMinutes: 1050,
  startAnytime: true, endAnytime: true, hoursOfEleven: 11, hoursBeforeThirty: 8, military: false,
  kilometers: false, arrival: "earliest",
};

function tripAStops({ delayMinutes = 0 } = {}) {
  return [
    { id: "here", name: "Current location", useCurrentLocation: true, lat: 39.9, lon: -75.6, miles: "", hours: "" },
    { id: "pactiv", name: "PACTIV", lat: 40, lon: -76.5, miles: String(LEG1.miles), hours: String(LEG1.hours),
      anytime: true, window: false, start: 0, end: 0, delayMinutes },
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

function savedTrips() {
  return [
    { id: "trip-1", name: "PACTIV run", stops: tripAStops(), settings: {} },
    { id: "trip-2", name: "KROGER run", stops: tripBStops(), settings: {} },
  ];
}

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

// The road line: each routed stop's leg is its saved miles, one after another.
function buildNavLine(stops) {
  const legs = [];
  let at = 0;
  for (const stop of stops || []) {
    const miles = Number(stop?.miles) || 0;
    if (!stop || stop.useCurrentLocation || !(miles > 0)) continue;
    legs.push({ stop, path: [], start: at, end: at + miles * MILE });
    at += miles * MILE;
  }
  return { line: [], legs };
}

// A fresh page. Pass the same `storage` to simulate a reload or a new build.
function page({ storage = memoryStorage(), activeTripId = "trip-1", stops, delayMinutes = 0 } = {}) {
  const calls = { render: 0, here: 0 };
  const elements = {};
  const context = {
    console, Math, Number, String, JSON, Array, Object, Infinity, NaN, Set, Map, RegExp, Promise, Intl,
    Date: FakeDate,
    ...plan, ...hos,
    calls, elements, buildNavLine,
    localStorage: storage,
    document: {
      visibilityState: "visible",
      activeElement: null,
      querySelectorAll: () => [],
      getElementById: (id) => (id === "routeDrive" ? (elements[id] ||= { id, hidden: true, textContent: "" }) : null),
    },
    window: { clearTimeout: noop, clearInterval: noop, removeEventListener: noop },
    navigator: {},
    history: { replaceState: noop },
    location: { pathname: "/", search: "" },
    queueMicrotask: noop,
    state: {
      stops: stops || (activeTripId === "trip-2" ? tripBStops() : tripAStops({ delayMinutes })),
      settings: { ...SETTINGS },
      plan: null, estimating: false, driveProgress: null, picker: null, origin: null,
      activeTripId, unlimited: true, credits: 10, signedIn: false,
      trips: savedTrips(),
    },
    navOn: false, routeFull: false, routePageStale: false, navLine: [], navFix: null,
    // End navigation's map, voice, and direction side effects.
    followPinned: false, railMenu: "", northLock: false, compassAim: false, navAlongLock: null,
    navResumeGuard: null, navSpotSavedAlong: null, navLineKey: "line-1", navStopPicked: false, navGuideFromId: "",
    navStopAnnounce: false, navStopAwaitNear: false, navStopSpeakKey: "", directionsAutoKey: "",
    switchSpokenFor: "", pendingAimId: "", navFollowing: false, tripFit: "nextTurn", navReturnTimer: 0,
    navWatch: null, navYou: null, routeMap: null, dirBrowseTimer: 0, onNavCompass: noop,
    clearDirectionPin: noop, clearStopNote: noop, paintStopChip: noop, stopNavMotion: noop, resetNavVoice: noop,
    stopMixNavVoice: noop, clearTurnFrame: noop, freezeTyping: noop, syncTripFitButton: noop, showWholeTrip: noop,
    syncTripNavLocks: noop, focusDirectionWindow: noop,
    // The real syncRouteChrome repaints the chip.
    syncRouteChrome: () => context.paintDrive(),
    navLegs: [], navTravel: 270, activeNavLeg: () => null, rebuildNavLegs: noop,
    // Done, open trip, and Clear trip side effects.
    paintDoneStop: noop, paintDirectionToward: noop, keepDoneOnSavedTrip: noop, persist: noop,
    parkSpeedNote: noop, showTripSpeedNote: noop, blankSpeedNote: noop, clearSpeedNote: noop, settleLoadedStops: noop,
    pinEnteredClocks: noop, replanAroundDone: noop, calculateButtonLabel: () => "", patchPlanAfterDone: noop,
    addressEditStarted: false, writingHash: false, lookupOpen: new Set(), wantAccountTrip: false,
    defaultState: () => ({ stops: [{ id: "blank", name: "Stop 1", miles: "", hours: "" }], plan: null,
      driveProgress: null, activeTripId: null, tripName: "", origin: null }),
    zoneForStop: () => "",
    // Calculate: HERE routing and the GPS are stubbed (no network).
    arrivedFix: async () => null, currentFix: async () => null, noteArrivedStops: noop, creditEmptyMessage: () => "",
    activeTransportMode: () => "truck", transportModeTitle: () => "Truck", transportRouteNote: () => "",
    fillHereLegs: async () => { calls.here += 1; return null; }, rememberOrigin: noop, showStopNote: noop,
    // The real render catches the plan up and bind() repaints the chip.
    render: () => { calls.render += 1; context.catchUpPlan(); context.paintDrive(null); },
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

// Start navigation, drive with the chip following, End navigation.
function driveThenEnd(pg, stopId, leftMiles) {
  const stop = pg.state.stops.find((item) => item.id === stopId);
  pg.navOn = true;
  pg.rememberNavProgress();
  driveTo(pg, stopId, Number(stop.miles) - leftMiles);
  pg.setStopChip(leftMiles * MILE, stop.name);
  pg.tickLeaveNow();
  pg.endRouteNav();
}

function boot(pg) {
  pg.applyNavProgress();
  pg.render();
}

const chipText = (pg) => (pg.elements.routeDrive && !pg.elements.routeDrive.hidden ? pg.elements.routeDrive.textContent : "");
// The #604 page chip: the whole drive to the first open stop, at the trip's average pace.
const wholeText = (pg, miles) => {
  const p = pg.state.plan;
  const hours = p.miles > 0 && p.driveHours > 0 ? p.driveHours * (miles / p.miles) : miles / 62;
  return `${hos.hoursLabel(hours)} left`;
};
const byId = (p, id) => p?.events.find((event) => event.id === id);
const drives = (p, stopId) => (p?.events || []).filter((event) => (event.kind === "lead" || event.kind === "stop") && event.stopID === stopId);
const sections = (html) => [...html.matchAll(/<div class="chip-sec( [\w-]+)?">([^<]*)<\/div>/g)]
  .map((hit) => ({ kind: (hit[1] || "").trim() || "label", text: hit[2] }));
const leftRow = (pg, id) => {
  const leg = byId(pg.state.plan, id);
  return leg ? sections(pg.chip(leg)).find((row) => row.kind === "chip-left")?.text || "" : "";
};
const stale = (pg) => {
  pg.elements.routeDrive ||= { id: "routeDrive", hidden: true, textContent: "" };
  pg.elements.routeDrive.hidden = false;
  pg.elements.routeDrive.textContent = "stale";
};

let failures = 0;
function expect(label, ok, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`);
}

const SAVED_A = "1 hr 14 min left";

console.log("No saved value: the page chip is the whole drive to the stop (unchanged)");
{
  const pg = page();
  boot(pg);
  expect("whole drive to PACTIV", chipText(pg) === wholeText(pg, LEG1.miles), `"${chipText(pg)}"`);
  expect("not the saved left", chipText(pg) !== SAVED_A);
}

console.log("\nTrip A: drive to 68.8 of 146.9 mi left, End navigation");
{
  const storage = memoryStorage();
  const pg = page({ storage });
  driveThenEnd(pg, "pactiv", LEFT_MILES);
  expect("navigation is off", pg.navOn === false);
  const row = leftRow(pg, "pactiv");
  expect("Plan top card's left row", row === "1 hr 14 min · 68.8 miles left", `"${row}"`);
  expect("page chip says 1 hr 14 min left", chipText(pg) === SAVED_A, `"${chipText(pg)}"`);
  expect("not the whole drive", chipText(pg) !== wholeText(pg, LEG1.miles) && !/2 hr 3\d min/.test(chipText(pg)),
    `"${chipText(pg)}"`);
  expect("same hours as the top card's left row", row.split(" · ")[0] === chipText(pg).replace(/ left$/, ""),
    `chip "${chipText(pg)}", row "${row}"`);
  expect("no miles in the chip", !/mile|mi\b/.test(chipText(pg)), `"${chipText(pg)}"`);
  const saved = pg.openLeftLeg();
  const pieces = drives(pg.state.plan, "pactiv");
  const planned = pieces.reduce((sum, event) => sum + (Number(event.tripHours) || 0), 0);
  expect("the Plan scheduled PACTIV from the saved hours", saved && Math.abs(planned - saved.remainHours) < 1e-9,
    `plan ${planned} h, saved ${saved?.remainHours} h, ${pieces.length} card(s)`);

  console.log("\nReload with navigation off");
  clock.now = NOW + 20 * MIN;
  const again = page({ storage });
  boot(again);
  expect("page chip still says 1 hr 14 min left", chipText(again) === SAVED_A, `"${chipText(again)}"`);
  expect("left row still matches", leftRow(again, "pactiv").startsWith("1 hr 14 min · "), `"${leftRow(again, "pactiv")}"`);
  clock.now = NOW;
}

console.log("\nA 1 hr delay on the PACTIV card");
{
  const pg = page({ delayMinutes: 60 });
  driveThenEnd(pg, "pactiv", LEFT_MILES);
  const rows = sections(pg.chip(byId(pg.state.plan, "pactiv")));
  expect("the card has its delay", rows.some((row) => row.kind === "chip-delay"), JSON.stringify(rows));
  expect("chip has no delay in it", chipText(pg) === SAVED_A, `"${chipText(pg)}"`);
}

console.log("\nOpen trip B, then trip A again");
{
  const storage = memoryStorage();
  const pg = page({ storage });
  driveThenEnd(pg, "pactiv", LEFT_MILES);
  stale(pg);
  pg.loadTrip("trip-2");
  expect("trip B: its whole drive to KROGER", chipText(pg) === wholeText(pg, KROGER.miles) && chipText(pg) === "1 hr 30 min left",
    `"${chipText(pg)}"`);
  stale(pg);
  pg.loadTrip("trip-1");
  expect("trip A again: its saved left", chipText(pg) === SAVED_A, `"${chipText(pg)}"`);

  pg.loadTrip("trip-2");
  driveThenEnd(pg, "kroger", 50);
  expect("trip B after it is driven: its own saved left", chipText(pg) === `${hos.hoursLabel(KROGER.hours * (50 / 80))} left`
    && leftRow(pg, "kroger").startsWith(chipText(pg).replace(/ left$/, " · ")), `"${chipText(pg)}" row "${leftRow(pg, "kroger")}"`);
  pg.loadTrip("trip-1");
  expect("trip A: still its own, not trip B's", chipText(pg) === SAVED_A, `"${chipText(pg)}"`);
  pg.loadTrip("trip-2");
  expect("trip B: still its own", chipText(pg) === "56 min left", `"${chipText(pg)}"`);
}

console.log("\nPACTIV Done");
{
  const pg = page();
  driveThenEnd(pg, "pactiv", LEFT_MILES);
  stale(pg);
  pg.markStopDone(pg.state.stops.find((stop) => stop.id === "pactiv"), { switched: true });
  expect("chip is WALMART's whole drive", chipText(pg) === wholeText(pg, LEG2.miles), `"${chipText(pg)}"`);
  expect("no stop aimed or moved on by the chip", pg.navAimStopId === ""
    && pg.state.stops.filter((stop) => stop.done).map((stop) => stop.id).join(",") === "pactiv");
}

console.log("\nThe leg changes, Calculate, Clear trip");
{
  const storage = memoryStorage();
  driveThenEnd(page({ storage }), "pactiv", LEFT_MILES);
  const rerouted = tripAStops();
  rerouted[1].miles = "150.2";
  rerouted[1].hours = String(162 / 60);
  const edited = page({ storage, stops: rerouted });
  boot(edited);
  expect("edited leg: whole new drive", chipText(edited) === wholeText(edited, 150.2) && chipText(edited) !== SAVED_A,
    `"${chipText(edited)}"`);

  const moved = page({ storage });
  boot(moved);
  expect("unchanged leg still shows the saved left", chipText(moved) === SAVED_A, `"${chipText(moved)}"`);
  stale(moved);
  moved.moveStop("pactiv", 1);
  expect("stop moved: whole drive to the first open stop", chipText(moved) === wholeText(moved, LEG2.miles), `"${chipText(moved)}"`);

  const calc = page({ storage: memoryStorage() });
  driveThenEnd(calc, "pactiv", LEFT_MILES);
  expect("before Calculate: saved left", chipText(calc) === SAVED_A, `"${chipText(calc)}"`);
  stale(calc);
  await calc.calculate();
  expect("after Calculate: whole drive", chipText(calc) === wholeText(calc, LEG1.miles) && chipText(calc) !== SAVED_A,
    `"${chipText(calc)}"`);

  const cleared = memoryStorage();
  const clear = page({ storage: cleared });
  driveThenEnd(clear, "pactiv", LEFT_MILES);
  stale(clear);
  clear.newTrip();
  expect("Clear trip: not the saved left", chipText(clear) !== SAVED_A && chipText(clear) !== "stale", `"${chipText(clear)}"`);
  const again = page({ storage: cleared });
  boot(again);
  expect("trip A entered again: whole drive", chipText(again) === wholeText(again, LEG1.miles), `"${chipText(again)}"`);
}

console.log("\nWhile navigating the chip follows the live position");
{
  const pg = page();
  driveThenEnd(pg, "pactiv", LEFT_MILES);
  pg.navOn = true;
  pg.rememberNavProgress();
  driveTo(pg, "pactiv", LEG1.miles - 50);
  pg.setStopChip(50 * MILE, "PACTIV");
  expect("live: 50 mi to PACTIV at the trip pace", chipText(pg) === `${hos.hoursLabel(pg.hoursForMeters(50 * MILE))} left`
    && chipText(pg) !== SAVED_A, `"${chipText(pg)}"`);
  pg.setStopChip(0, "PACTIV");
  expect("live: at the stop", chipText(pg) === "0 min left", `"${chipText(pg)}"`);
  pg.setStopChip(-1, "");
  expect("live: no stop, same as before (not the saved left)", chipText(pg) === pg.stopDriveText(pg.nextStopMeters())
    && chipText(pg) !== SAVED_A, `"${chipText(pg)}"`);
  pg.navOn = false;
}

console.log("\nFull screen is unchanged");
{
  const pg = page();
  driveThenEnd(pg, "pactiv", LEFT_MILES);
  pg.routeFull = true;
  pg.paintDrive(null);
  expect("full screen shows the whole trip left", chipText(pg) === pg.driveLeftText(null) && chipText(pg) !== SAVED_A,
    `"${chipText(pg)}"`);
  pg.routeFull = false;
  pg.paintDrive(null);
  expect("back on the page: saved left", chipText(pg) === SAVED_A, `"${chipText(pg)}"`);
}

console.log("\nA long leg split by a 30-minute break");
{
  const long = [
    { id: "here", name: "Current location", useCurrentLocation: true, lat: 39.9, lon: -75.6, miles: "", hours: "" },
    { id: "far", name: "FAR DC", lat: 41, lon: -90, miles: "600", hours: "11", anytime: true, window: false, start: 0, end: 0 },
  ];
  const pg = page({ stops: long });
  driveThenEnd(pg, "far", 550);
  const pieces = drives(pg.state.plan, "far");
  const total = pieces.reduce((sum, event) => sum + (Number(event.tripHours) || 0), 0);
  expect("the Plan splits FAR DC's drive", pieces.length >= 2, `${pieces.length} card(s)`);
  expect("chip is the total left to FAR DC", chipText(pg) === `${hos.hoursLabel(total)} left`, `"${chipText(pg)}", cards ${pieces.map((event) => hos.hoursLabel(event.tripHours)).join(" + ")}`);
}

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
