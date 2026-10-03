// Build #603: what is left of the leg being driven is saved with the trip's
// nav progress, so after End navigation, a refresh, or a new build the Plan
// still starts that leg now with only the drive time left. It goes back only
// when that stop is Done, that leg changes, or Clear trip (Build #604: not when
// another trip opens).
// Not loaded by the site. Run: node tests/plan-left-persist.test.mjs
//
// Loads the real plan, live-drive, nav-progress, End navigation, Done, open
// trip, move stop, and Clear trip functions from js/app.js (by name, into a vm
// sandbox) with buildPlan from js/plan.js. The DOM and map are stubbed, and
// localStorage is an in-memory map that a "reload" (a fresh page) keeps. Fake
// clock at 2:31 PM ET, Fri Oct 2 2026. First leg to PACTIV is 146.9 mi / 2 hr
// 38 min; the truck ends navigation with 68.8 mi / 1 hr 14 min left.

process.env.TZ = "America/New_York";

import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appSource = readFileSync(path.join(root, "js/app.js"), "utf8");
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

function constLine(name) {
  const hit = new RegExp(`^const ${name} = [^;]+;`, "m").exec(appSource);
  if (!hit) throw new Error(`app.js has no const ${name}`);
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
  // Nav progress (Build #594) and the paths that change it
  "tripProgressKey", "readNavProgress", "readNavSpot", "writeNavProgress", "clearNavProgress", "readNavRecord", "readNavProgressMap",
  "writeNavProgressMap",
  "rememberNavProgress", "retargetNavProgress", "applyNavProgress", "nextOpenStopId", "leaveNavSession",
  "endNavProgress", "endRouteNav", "readDriveProgress", "clearDriveProgress", "markStopDone",
  "rebuildPlanAfterDone", "loadTrip", "tripReadyToRecalc", "moveStop", "newTrip",
];
// Not in the old page. It runs without them, so this test can show it failing.
const OPTIONAL_FUNCTIONS = [
  "liveLegProgress", "legProgressFrom", "legDrive", "readLeftLeg", "leftLegKey", "openLeftLeg", "saveLeftLeg",
  "forgetLeftLeg", "forgetOtherTripLeftLeg",
];
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

const SETTINGS = {
  governed: true, governedMph: 62, leaveNow: true, leaveAt: NOW, startMinutes: 330, endMinutes: 1050,
  startAnytime: true, endAnytime: true, hoursOfEleven: 11, hoursBeforeThirty: 8, military: false,
  kilometers: false, arrival: "earliest",
};

function plannedStops({ delayMinutes = 0 } = {}) {
  return [
    { id: "here", name: "Current location", useCurrentLocation: true, lat: 39.9, lon: -75.6, miles: "", hours: "" },
    { id: "pactiv", name: "PACTIV", lat: 40, lon: -76.5, miles: String(LEG1.miles), hours: String(LEG1.hours),
      anytime: true, window: false, start: 0, end: 0, delayMinutes },
    { id: "walmart", name: "WALMART", lat: 41, lon: -84, miles: String(LEG2.miles), hours: String(LEG2.hours),
      anytime: false, window: false, start: WALMART_BY, end: WALMART_BY },
  ];
}

// Another saved trip with different stops.
const OTHER_TRIP = {
  id: "trip-2",
  name: "Other trip",
  stops: [
    { id: "here", name: "Current location", useCurrentLocation: true, lat: 39.9, lon: -75.6, miles: "", hours: "" },
    { id: "kroger", name: "KROGER", lat: 39, lon: -77, miles: "80", hours: "1.5", anytime: true, window: false, start: 0, end: 0 },
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

// A fresh page. Pass the same `storage` to simulate a reload or a new build.
function page({ storage = memoryStorage(), delayMinutes = 0, settings = {}, activeTripId = "trip-1", stops } = {}) {
  const calls = { patch: 0, render: 0 };
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
      stops: stops || plannedStops({ delayMinutes }),
      settings: { ...SETTINGS, ...settings },
      plan: null, estimating: false, driveProgress: null, picker: null, origin: null,
      activeTripId,
      trips: [
        { id: "trip-1", name: "PACTIV run", stops: plannedStops({ delayMinutes }), settings: {} },
        OTHER_TRIP,
      ],
    },
    navOn: false, routeFull: false, routePageStale: false,
    // End navigation's map, voice, and direction side effects.
    followPinned: false, railMenu: "", northLock: false, compassAim: false, navAlongLock: null,
    navResumeGuard: null, navSpotSavedAlong: null, navLineKey: "", navStopPicked: false, navGuideFromId: "",
    navStopAnnounce: false, navStopAwaitNear: false, navStopSpeakKey: "", directionsAutoKey: "",
    switchSpokenFor: "", pendingAimId: "", navFollowing: false, tripFit: "nextTurn", navReturnTimer: 0,
    navWatch: null, navYou: null, routeMap: null, dirBrowseTimer: 0, onNavCompass: noop,
    clearDirectionPin: noop, clearStopNote: noop, setStopChip: noop, stopNavMotion: noop, resetNavVoice: noop,
    stopMixNavVoice: noop, clearTurnFrame: noop, freezeTyping: noop, syncTripFitButton: noop, showWholeTrip: noop,
    syncRouteChrome: noop, syncTripNavLocks: noop, focusDirectionWindow: noop, paintDrive: noop,
    // Done, open trip, and Clear trip side effects.
    paintDoneStop: noop, paintDirectionToward: noop, keepDoneOnSavedTrip: noop, persist: noop,
    parkSpeedNote: noop, showTripSpeedNote: noop, blankSpeedNote: noop, settleLoadedStops: noop,
    pinEnteredClocks: noop, replanAroundDone: noop, calculateButtonLabel: () => "",
    addressEditStarted: false, writingHash: false, lookupOpen: new Set(),
    defaultState: () => ({ stops: [{ id: "blank", name: "Stop 1", miles: "", hours: "" }], plan: null,
      driveProgress: null, activeTripId: null, tripName: "", origin: null }),
    zoneForStop: () => "",
    patchPlanAfterDone: () => { calls.patch += 1; },
    render: () => { calls.render += 1; },
  };
  context.calculate = () => { context.state.plan = context.rebuiltPlan(); };
  vm.createContext(context);
  vm.runInContext(APP_CODE, context);
  context.state.plan = context.rebuiltPlan();
  return context;
}

// The nav fix handler: the truck is `drivenMiles` into the 146.9 mi leg to PACTIV.
function driveTo(pg, drivenMiles) {
  const stop = pg.state.stops.find((item) => item.id === "pactiv");
  pg.trackLiveDrive({ along: drivenMiles * MILE }, { stop, start: 0, end: LEG1.miles * MILE });
}

// Start navigation (its first step writes the nav progress), drive, End navigation.
function driveThenEnd(pg, leftMiles = LEFT_MILES) {
  pg.navOn = true;
  pg.rememberNavProgress();
  driveTo(pg, LEG1.miles - leftMiles);
  pg.tickLeaveNow();
  pg.endRouteNav();
}

// What the page does on load: put back the nav progress, then render (which
// catches the plan up).
function boot(pg, stalePlan) {
  if (stalePlan) pg.state.plan = stalePlan;
  pg.applyNavProgress();
  pg.catchUpPlan();
}

const byId = (p, id) => p.events.find((event) => event.id === id);
const drives = (p, stopId) => p.events.filter((event) => (event.kind === "lead" || event.kind === "stop") && event.stopID === stopId);
const near = (a, b, ms = MIN) => Math.abs(a - b) <= ms;
const clockText = (ms) => new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }).format(new Date(ms));
const sections = (html) => [...html.matchAll(/<div class="chip-sec( [\w-]+)?">([^<]*)<\/div>/g)]
  .map((hit) => ({ kind: (hit[1] || "").trim() || "label", text: hit[2] }));
// Build #604 keeps one record per trip: { [tripKey]: record }.
const savedRecord = (storage, tripKey = "id:trip-1") => JSON.parse(storage.getItem("planigator.web.navprogress") || "null")?.[tripKey] || null;
const savedLeft = (storage) => savedRecord(storage)?.leftLeg || null;

let failures = 0;
function expect(label, ok, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`);
}

const wholeLegs = plan.buildPlan({
  stops: plannedStops().map((stop) => ({ ...stop, miles: Number(stop.miles) || 0, hours: Number(stop.hours) || 0 })),
  settings: { ...SETTINGS, leaveAt: NOW },
  now: NOW,
});

// The top card keeps what is left: starts at `from`, ends after the time left
// (plus `delayHours`), left row only, and the rest of the plan follows.
function expectLeftLeg(pg, label, { from = clock.now, delayHours = 0 } = {}) {
  const p = pg.state.plan;
  const leg = byId(p, "pactiv");
  expect(`${label}: PACTIV card starts now`, leg && near(leg.start, from), leg && clockText(leg.start));
  expect(`${label}: PACTIV card ends after only the time left${delayHours ? " plus the delay" : ""}`,
    leg && near(leg.end, from + (LEFT_HOURS + delayHours) * HOUR),
    leg && `${clockText(leg.end)}, the whole leg would end ${clockText(from + (LEG1.hours + delayHours) * HOUR)}`);
  const rows = leg ? sections(pg.chip(leg)) : [];
  expect(`${label}: left row with the time and miles left, no delay in it`,
    rows.find((row) => row.kind === "chip-left")?.text === "1 hr 14 min · 68.8 miles left", JSON.stringify(rows));
  expect(`${label}: no full-leg row`, !rows.some((row) => row.kind === "chip-mid")
    && !rows.some((row) => /2 hr 38 min|146\.9 miles/.test(row.text)), JSON.stringify(rows));
  const next = drives(p, "walmart")[0];
  expect(`${label}: next drive starts when PACTIV ends`, next && leg && near(next.start, leg.end), next && clockText(next.start));
  if (!delayHours) {
    expect(`${label}: 11-hour clock counts only the drive left`, Math.abs(p.driveHours - (LEFT_HOURS + LEG2.hours)) < 0.01,
      hos.hoursLabel(p.driveHours));
    expect(`${label}: arrive-by follows`, near(p.arriveAt, from + (LEFT_HOURS + LEG2.hours + 0.5) * HOUR),
      `${clockText(p.arriveAt)} (whole legs ${clockText(wholeLegs.arriveAt)})`);
    expect(`${label}: WALMART be-there-by is made`, !p.late, `late=${p.late}`);
  }
}

// The plan is the whole saved legs from now, as with no drive under way.
function expectWholeLegs(pg, label) {
  const leg = byId(pg.state.plan, "pactiv");
  expect(`${label}: PACTIV card is the whole leg`, leg && near(leg.end, clock.now + LEG1.hours * HOUR), leg && clockText(leg.end));
  const rows = leg ? sections(pg.chip(leg)) : [];
  expect(`${label}: normal row, no left row`, rows.find((row) => row.kind === "chip-mid")?.text === "2 hr 38 min · 146.9 miles"
    && !rows.some((row) => row.kind === "chip-left"), JSON.stringify(rows));
}

console.log("End navigation with 68.8 miles left");
{
  const storage = memoryStorage();
  const pg = page({ storage });
  driveThenEnd(pg);
  expect("navigation is off", pg.navOn === false);
  expectLeftLeg(pg, "after End navigation");
  const saved = savedLeft(storage);
  expect("saved for this trip and leg", saved?.stopId === "pactiv" && Math.abs(saved.remainMiles - LEFT_MILES) < 0.01
    && Math.abs(saved.remainHours - LEFT_HOURS) < 0.001 && Math.abs(saved.fullMiles - LEG1.miles) < 0.01
    && savedRecord(storage).tripKey === "id:trip-1", JSON.stringify(saved));
  expect("nav resume is off and no spot is kept", (() => {
    const raw = savedRecord(storage);
    return raw && raw.nav === false && raw.spot === null && raw.aimId === "";
  })());

  clock.now = NOW + 3 * HOUR;
  pg.tickLeaveNow();
  expectLeftLeg(pg, "three hours later, still off");
  const leg = byId(pg.state.plan, "pactiv");
  expect("it does not move on to WALMART by itself", leg && !pg.state.stops.find((s) => s.id === "pactiv").done
    && pg.navAimStopId === "", leg ? "PACTIV still first" : "no PACTIV card");
  clock.now = NOW;
}

console.log("\nA 1 hr delay on the PACTIV card, after End navigation");
{
  const pg = page({ delayMinutes: 60 });
  driveThenEnd(pg);
  expectLeftLeg(pg, "with delay", { delayHours: 1 });
  const rows = sections(pg.chip(byId(pg.state.plan, "pactiv")));
  expect("delay row stays", rows.some((row) => row.kind === "chip-delay"), JSON.stringify(rows));
  expect("the delay counts toward the 11", pg.state.plan.restCount === 1, `${pg.state.plan.restCount} rest(s)`);
}

console.log("\nReload with navigation off (same storage, fresh page)");
{
  const storage = memoryStorage();
  driveThenEnd(page({ storage }));
  clock.now = NOW + 20 * MIN;
  const again = page({ storage });
  boot(again, wholeLegs);
  expectLeftLeg(again, "after reload");
  expect("reload does not aim a stop, mark one done, or set a drive progress", again.navAimStopId === ""
    && !again.state.stops.some((stop) => stop.done) && again.state.driveProgress === null && again.navProgressResume === false,
    `aim="${again.navAimStopId}" progress=${JSON.stringify(again.state.driveProgress)}`);

  const twice = page({ storage });
  boot(twice);
  expectLeftLeg(twice, "after a second reload (new build)");
  clock.now = NOW;
}

console.log("\nReload with Leave at set (not Leave now)");
{
  const storage = memoryStorage();
  driveThenEnd(page({ storage, settings: { leaveNow: false, leaveAt: NOW - 90 * MIN } }));
  clock.now = NOW + 10 * MIN;
  const again = page({ storage, settings: { leaveNow: false, leaveAt: NOW - 90 * MIN } });
  const stale = again.state.plan;
  again.state.plan = { ...stale };
  boot(again);
  const leg = byId(again.state.plan, "pactiv");
  expect("the leg under way starts now and ends after the time left", leg && near(leg.start, clock.now)
    && near(leg.end, clock.now + LEFT_HOURS * HOUR), leg && `${clockText(leg.start)} – ${clockText(leg.end)}`);
  clock.now = NOW;
}

console.log("\nWhile navigating, the saved value follows the live position");
{
  const storage = memoryStorage();
  const pg = page({ storage });
  pg.navOn = true;
  pg.rememberNavProgress();
  driveTo(pg, LEG1.miles - LEFT_MILES);
  expect("saved on the first fix of the leg", Math.abs((savedLeft(storage)?.remainMiles || 0) - LEFT_MILES) < 0.01,
    JSON.stringify(savedLeft(storage)));
  clock.now += 10 * MIN;
  driveTo(pg, LEG1.miles - 60);
  expect("kept fresh as he drives", Math.abs((savedLeft(storage)?.remainMiles || 0) - 60) < 0.01, JSON.stringify(savedLeft(storage)));
  pg.tickLeaveNow();
  const leg = byId(pg.state.plan, "pactiv");
  expect("plan uses the live position", leg && near(leg.end, clock.now + LEG1.hours * (60 / LEG1.miles) * HOUR), leg && clockText(leg.end));
  pg.endRouteNav();
  const ended = byId(pg.state.plan, "pactiv");
  expect("End navigation keeps the last position", ended && near(ended.end, clock.now + LEG1.hours * (60 / LEG1.miles) * HOUR)
    && Math.abs(savedLeft(storage).remainMiles - 60) < 0.01, ended && clockText(ended.end));
  clock.now = NOW;
}

console.log("\nPACTIV marked Done");
{
  const storage = memoryStorage();
  const pg = page({ storage });
  driveThenEnd(pg);
  pg.markStopDone(pg.state.stops.find((stop) => stop.id === "pactiv"), { switched: true });
  const p = pg.state.plan;
  expect("no PACTIV card", !byId(p, "pactiv"));
  const next = drives(p, "walmart");
  const hours = next.reduce((sum, event) => sum + (Number(event.tripHours) || 0), 0);
  expect("WALMART is its whole leg from now", next[0] && near(next[0].start, NOW) && Math.abs(hours - LEG2.hours) < 0.01,
    next[0] && `${clockText(next[0].start)}, ${hos.hoursLabel(hours)}`);
  const rows = next[0] ? sections(pg.chip(next[0])) : [];
  expect("WALMART has its normal row, no left row", rows.some((row) => row.kind === "chip-mid")
    && !rows.some((row) => row.kind === "chip-left"), JSON.stringify(rows));
  expect("saved left leg is gone", savedLeft(storage) === null, JSON.stringify(savedLeft(storage)));
  const again = page({ storage, stops: pg.state.stops.map((stop) => ({ ...stop })) });
  boot(again);
  expect("and stays gone after reload", !byId(again.state.plan, "pactiv") && savedLeft(storage) === null);
}

console.log("\nAnother trip");
{
  const storage = memoryStorage();
  driveThenEnd(page({ storage }));
  const other = page({ storage, activeTripId: "trip-9" });
  boot(other);
  expectWholeLegs(other, "same stops, different trip key");

  // Build #604: each trip keeps its own, so opening another trip keeps it.
  const pg = page({ storage });
  boot(pg);
  pg.loadTrip("trip-2");
  expect("opening another trip keeps the saved left leg", savedLeft(storage) !== null, JSON.stringify(savedLeft(storage)));
  pg.loadTrip("trip-1");
  expectLeftLeg(pg, "back on the first trip");
}

console.log("\nThe leg changes on the same trip");
{
  const storage = memoryStorage();
  driveThenEnd(page({ storage }));
  const rerouted = plannedStops();
  rerouted[1].miles = "150.2";
  rerouted[1].hours = String(162 / 60);
  const pg = page({ storage, stops: rerouted });
  boot(pg);
  const leg = byId(pg.state.plan, "pactiv");
  expect("a new route for that leg: whole new leg", leg && near(leg.end, NOW + (162 / 60) * HOUR), leg && clockText(leg.end));
  expect("no left row on it", leg && !sections(pg.chip(leg)).some((row) => row.kind === "chip-left"));

  const moved = plannedStops();
  moved[1].lat = 40.2;
  const pin = page({ storage, stops: moved });
  boot(pin);
  expectWholeLegs(pin, "PACTIV moved to a new pin");

  const before = plannedStops();
  before.splice(1, 0, { id: "fuel", name: "Fuel", lat: 39.95, lon: -76, miles: "20", hours: "0.4", anytime: true, window: false, start: 0, end: 0 });
  const ins = page({ storage, stops: before, activeTripId: "trip-1" });
  boot(ins);
  const pactiv = byId(ins.state.plan, "pactiv");
  expect("a stop put in before PACTIV: whole PACTIV leg", pactiv && !sections(ins.chip(pactiv)).some((row) => row.kind === "chip-left"));

  const same = page({ storage });
  boot(same);
  expectLeftLeg(same, "unchanged leg still keeps it");
  same.moveStop("pactiv", 1);
  expect("moving the stop drops the saved left leg", savedLeft(storage) === null, JSON.stringify(savedLeft(storage)));
}

console.log("\nClear trip");
{
  const storage = memoryStorage();
  const pg = page({ storage });
  driveThenEnd(pg);
  pg.newTrip();
  expect("Clear trip drops the saved left leg", savedLeft(storage) === null, JSON.stringify(savedLeft(storage)));
  const again = page({ storage });
  boot(again);
  expectWholeLegs(again, "same trip entered again");
}

console.log("\nNever used: no saved left leg");
{
  const pg = page();
  boot(pg);
  expect("plan is the whole legs", JSON.stringify(pg.state.plan.events) === JSON.stringify(wholeLegs.events));
}

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
