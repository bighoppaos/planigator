// Build #620: the map's Recalculate never drops a stop he just added. A stop
// with a location but no route yet, sitting before the next routed stop, is
// where the ahead leg goes (here -> new stop), and the leg after it (new stop
// -> next routed stop) is routed too. Only stops genuinely behind him (done,
// switched, the start, or routed stops before the target) are marked passed. A
// new stop with no address picked yet stops Recalculate with the lookup error
// Calculate already shows; nothing is routed or marked.
// Not loaded by the site. Run: node tests/recalc-new-stop.test.mjs
// Against other copies: APP_JS=/path/to/app.js node tests/recalc-new-stop.test.mjs
//
// Loads the real Recalculate, add-a-stop (card and map truck stop), nav leg and
// nav progress functions from js/app.js into a vm sandbox. GPS, HERE routing,
// Calculate and the map are stubbed. Trip: Lancaster, PA -> FRANK B FUHRER in
// Pittsburgh; he is near Lebanon, PA and adds a Pilot near Harrisburg first.

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
    // Recalculate (map)
    "recalculateFromHere", "currentFix", "askPosition", "fixTime", "navFixFresh", "rebuildNavLegs", "activeNavLeg",
    "upcomingRoutedStop", "applyAheadLeg", "routeFromHere", "abortRecalc", "stopPoint", "writeRoutedLeg",
    "noteArrivedStops", "stopHasSavedLeg", "pointReady", "rememberOrigin", "originPoint", "navDestList",
    "chosenNavStop",
    // Adding a stop: the card's Add stop above, and a truck stop from the map
    "addStopBefore", "addTruckAsNextStop",
    // Nav progress
    "persist", "clearDriveProgress", "forgetLeftLeg", "tripProgressKey", "readNavRecord", "readNavProgressMap",
    "writeNavProgressMap", "readNavProgress", "readLeftLeg", "leftLegKey", "openLeftLeg", "readNavSpot",
    "writeNavProgress", "clearNavProgress", "rememberNavProgress",
  ].map(extract),
  ...["recalcTarget", "stopUnrouted", "legsOnFrom", "passStop"].map(optional),
].join("\n\n");

const LANCASTER = { lat: 40.0379, lon: -76.3055 };
const EPHRATA = { lat: 40.1798, lon: -76.1788 };
const LEBANON = { lat: 40.3409, lon: -76.4113 };
const HERSHEY = { lat: 40.2859, lon: -76.6503 };
const PILOT = { lat: 40.2732, lon: -76.8867 }; // "pilotfue", Harrisburg area
const LOVES = { lat: 40.25, lon: -77.2 };
const PITTSBURGH = { lat: 40.4406, lon: -79.9959 }; // FRANK B FUHRER

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

// Lancaster address start -> EPHRATA (done, switched on the drive) -> FRANK.
// `hershey`: a routed stop between them that he chose to skip (aim at FRANK).
function tripStops({ hershey = false } = {}) {
  const stops = [
    { id: "start", name: "Start", address: "Lancaster, PA", ...LANCASTER, anytime: true, miles: "", hours: "" },
    { id: "ephrata", name: "EPHRATA", ...EPHRATA, miles: "12", hours: "0.3", path: [pair(LANCASTER), pair(EPHRATA)],
      directions: [{ text: "Go" }], done: true, switched: true },
  ];
  if (hershey) {
    stops.push({ id: "hershey", name: "HERSHEY", ...HERSHEY, miles: "30", hours: "0.6",
      path: [pair(EPHRATA), pair(LEBANON), pair(HERSHEY)], directions: [] });
  }
  stops.push({ id: "frank", name: "FRANK B FUHRER", address: "Pittsburgh, PA", ...PITTSBURGH, miles: "250", hours: "4.5",
    path: [hershey ? pair(HERSHEY) : pair(EPHRATA), pair(LEBANON), pair(PILOT), pair(PITTSBURGH)], directions: [] });
  return stops;
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

function page({ hershey = false, activeTripId = null, credits = 10, unlimited = true } = {}) {
  const calls = { routed: [], calculate: [], render: 0 };
  let newIds = 0;
  const pg = {
    console, Math, Number, String, JSON, Array, Object, Infinity, NaN, Set, Map, RegExp, Promise, Intl,
    Date: FakeDate,
    ...plan, ...navMatch,
    calls,
    localStorage: memoryStorage(),
    document: { activeElement: null, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
    state: {
      stops: tripStops({ hershey }),
      settings: { governed: true, governedMph: 65, routeMode: "fast" },
      plan: { events: [] }, origin: null, driveProgress: null, activeTripId, tripName: "", trips: [],
      estimating: false, error: "", notice: "", unlimited, credits, signedIn: false,
    },
    navOn: false, navFix: null, navFixTime: 0, navTravel: null, navLine: [], navLegs: [],
    navAimStopId: "", navStopCursor: 0, navStopPicked: false, navGuideFromId: "", navStopAwaitNear: false,
    navStopAnnounce: false, navStopSpeakKey: "", directionsAutoKey: "", spokenStepKey: "", spokenMiles: new Set(),
    routeMap: null, routeFull: false, truckHit: null,
    settingsForSave: () => pg.state.settings,
    slimPlan: (p) => p,
    render: () => { calls.render += 1; },
    defaultStop: (patch = {}) => ({
      id: `new-${++newIds}`, name: "", address: "", miles: "", hours: "", anytime: false, window: false,
      start: clock.now, end: clock.now, useCurrentLocation: false, ...patch,
    }),
    clockOffset: () => 0,
    navNearest: (lat, lon, line) => navMatch.nearestOnPath(lat, lon, line),
    noteNavTrack: noop, navStopTitle: (stop) => stop?.name || "Stop",
    travelCourse: () => ({ course: undefined, travel: undefined, reliable: false, source: "none" }),
    startsBackwards: () => false,
    routeTruckLeg: async (from, to) => {
      calls.routed.push({ from: { lat: from.lat, lon: from.lon }, to: { lat: to.lat, lon: to.lon } });
      return { miles: 10, hours: 0.2, points: [[from.lat, from.lon], [to.lat, to.lon]], directions: [] };
    },
    transportRouteNote: () => "Truck route.", transportModeTitle: () => "Truck",
    creditEmptyMessage: () => "Out of credits.", calculateButtonLabel: () => "",
    clearDirectionPin: noop, clearStopNote: noop, showStopNote: noop, syncRouteChrome: noop,
    paintLiveRoute: noop, refillDirections: noop, paintLiveDirections: noop,
    forgetTruckChoice: () => { pg.truckHit = null; }, paintStopButton: noop, syncTruckAdd: noop,
  };
  pg.navigator = { geolocation: null };
  pg.geo = {
    answer: null,
    getCurrentPosition(ok, fail) {
      if (pg.geo.answer) ok({ coords: { latitude: pg.geo.answer.lat, longitude: pg.geo.answer.lon, heading: null, speed: null, accuracy: 10 }, timestamp: clock.now });
      else fail({ code: 2 });
    },
  };
  pg.navigator.geolocation = pg.geo;
  pg.window = { setTimeout: (fn) => fn(), clearTimeout: noop };
  vm.createContext(pg);
  vm.runInContext(APP_CODE, pg);
  pg.calculate = async (opts) => { calls.calculate.push(opts); };
  return pg;
}

// Navigation was ended near Lebanon; his phone's GPS says Lebanon.
function parkedAtLebanon(pg) {
  pg.navOn = false;
  pg.navFix = pair(LEBANON);
  pg.navFixTime = clock.now - 10 * 60000;
  pg.geo.answer = { ...LEBANON };
}

// Navigation on, aimed at FRANK, the last fix (fresh) near Lebanon.
function navigatingAtLebanon(pg) {
  pg.navOn = true;
  pg.navFix = pair(LEBANON);
  pg.navFixTime = clock.now - 1000;
  pg.navAimStopId = "frank";
  pg.geo.answer = null;
}

// The stop card's "add a stop above FRANK", then the address he picked.
// `wipe`: picking the address clears FRANK's saved miles and the plan, as updateStop does.
function addPilotCard(pg, { wipe = true, located = true } = {}) {
  const ids = new Set(pg.state.stops.map((stop) => stop.id));
  pg.addStopBefore("frank");
  const pilot = pg.state.stops.find((stop) => !ids.has(stop.id));
  if (!pilot) throw new Error("addStopBefore did not add a stop");
  Object.assign(pilot, { name: "pilotfue", address: "Pilot Travel Center, Harrisburg PA", ...(located ? PILOT : {}) });
  if (wipe) {
    const frank = pg.state.stops.find((stop) => stop.id === "frank");
    frank.miles = "";
    frank.hours = "";
    pg.state.plan = null;
  }
  return pilot;
}

// A Pilot picked on the map while navigating: "Added as the next stop. Recalculate to put it on the route."
function addPilotFromMap(pg) {
  pg.truckHit = { name: "pilotfue", label: "Pilot Travel Center, Harrisburg PA", ...PILOT };
  pg.addTruckAsNextStop();
  return pg.state.stops.find((stop) => stop.name === "pilotfue");
}

const near = (a, b) => a && b && Math.abs(Number(a.lat) - b.lat) < 1e-6 && Math.abs(Number(a.lon) - b.lon) < 1e-6;
const nearPair = (p, b) => Array.isArray(p) && near({ lat: p[0], lon: p[1] }, b);
const where = (p) => (p ? `${Number(p.lat).toFixed(4)}, ${Number(p.lon).toFixed(4)}` : String(p));
const legText = (pg) => pg.calls.routed.map((leg) => `${where(leg.from)} → ${where(leg.to)}`).join(" | ") || "none";
const byId = (pg, id) => pg.state.stops.find((stop) => stop.id === id);

let failures = 0;
function expect(label, ok, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`);
}

// What a Recalculate that routed through the Pilot must leave.
function expectThroughPilot(pg, pilot, label) {
  const frank = byId(pg, "frank");
  const legs = pg.calls.routed;
  expect(`${label}: no error`, pg.state.error === "", pg.state.error);
  expect(`${label}: pilotfue is not marked passed`, pilot && !pilot.skipRoute && !pilot.done,
    JSON.stringify({ skipRoute: pilot?.skipRoute, done: pilot?.done }));
  expect(`${label}: pilotfue is still a stop on the trip`, pg.state.stops.includes(pilot));
  expect(`${label}: the ahead leg is Lebanon → pilotfue`, near(legs[0]?.from, LEBANON) && near(legs[0]?.to, PILOT), legText(pg));
  expect(`${label}: …and it is pilotfue's leg (path starts at Lebanon, ends at the Pilot)`,
    nearPair(pilot?.path?.[0], LEBANON) && nearPair(pilot?.path?.[pilot.path.length - 1], PILOT) && pilot?.miles === "10",
    JSON.stringify({ path: pilot?.path, miles: pilot?.miles }));
  expect(`${label}: pilotfue → FRANK is routed`, near(legs[1]?.from, PILOT) && near(legs[1]?.to, PITTSBURGH), legText(pg));
  expect(`${label}: …and written to FRANK (path starts at the Pilot, new miles)`,
    nearPair(frank?.path?.[0], PILOT) && nearPair(frank?.path?.[frank.path.length - 1], PITTSBURGH) && frank?.miles === "10",
    JSON.stringify({ path: frank?.path, miles: frank?.miles }));
  expect(`${label}: two HERE requests, nothing else`, legs.length === 2, legText(pg));
  expect(`${label}: FRANK is not marked passed`, frank && !frank.skipRoute && !frank.done);
  const line = pg.buildNavLine(pg.state.stops).legs.map((leg) => leg.stop.id);
  expect(`${label}: the route line goes Lebanon → pilotfue → FRANK`, JSON.stringify(line) === JSON.stringify([pilot?.id, "frank"]),
    JSON.stringify(line));
  expect(`${label}: the trip starts at Lebanon (Current location)`, pg.state.stops[0]?.useCurrentLocation === true
    && near(pg.state.origin, LEBANON), where(pg.state.origin));
  expect(`${label}: the plan is rebuilt quietly on the map`, pg.calls.calculate.length === 1
    && pg.calls.calculate[0]?.silent === true && pg.calls.calculate[0]?.keepScreen === true, JSON.stringify(pg.calls.calculate));
}

// --- a. The scenario: End navigation near Lebanon, add pilotfue before FRANK, Recalculate ---
console.log("a. Added pilotfue before FRANK, then the map's Recalculate (navigation off)");
for (const wipe of [true, false]) {
  const pg = page();
  parkedAtLebanon(pg);
  const pilot = addPilotCard(pg, { wipe });
  await pg.recalculateFromHere();
  expectThroughPilot(pg, pilot, wipe ? "address picked (FRANK's miles cleared)" : "FRANK's old miles kept");
}
{
  const pg = page();
  parkedAtLebanon(pg);
  const pilot = addPilotCard(pg);
  pg.addStopBefore("frank");
  const loves = pg.state.stops[pg.state.stops.findIndex((stop) => stop.id === "frank") - 1];
  Object.assign(loves, { name: "LOVES", ...LOVES });
  await pg.recalculateFromHere();
  const legs = pg.calls.routed;
  expect("two stops added before FRANK: Lebanon → pilotfue → LOVES → FRANK, each leg routed once",
    legs.length === 3 && near(legs[0].to, PILOT) && near(legs[1].from, PILOT) && near(legs[1].to, LOVES)
      && near(legs[2].from, LOVES) && near(legs[2].to, PITTSBURGH), legText(pg));
  expect("…neither is marked passed", !pilot.skipRoute && !loves.skipRoute);
}
{
  const pg = page({ unlimited: false, credits: 1 });
  parkedAtLebanon(pg);
  const pilot = addPilotCard(pg);
  await pg.recalculateFromHere();
  expect("1 credit left, 2 legs needed: nothing is routed and nothing is marked passed",
    pg.calls.routed.length === 0 && !pilot.skipRoute && /credit/i.test(pg.state.error), `${legText(pg)} / ${pg.state.error}`);
}

// --- b. Stops really behind him are still passed ---
console.log("\nb. Routed stops behind him are marked passed, as before");
{
  const pg = page();
  parkedAtLebanon(pg);
  addPilotCard(pg);
  await pg.recalculateFromHere();
  const ephrata = byId(pg, "ephrata");
  const start = byId(pg, "start");
  expect("the done EPHRATA stop is marked passed and its old leg cleared", ephrata?.skipRoute === true && ephrata.done
    && ephrata.path.length === 0 && ephrata.miles === "", JSON.stringify({ skipRoute: ephrata?.skipRoute, path: ephrata?.path }));
  expect("the Lancaster start is behind him (passed), and keeps its address", start?.skipRoute === true
    && start.address === "Lancaster, PA", JSON.stringify({ skipRoute: start?.skipRoute, address: start?.address }));
}
{
  const pg = page({ hershey: true });
  navigatingAtLebanon(pg);
  const pilot = addPilotFromMap(pg);
  expect("map truck stop while aimed at FRANK: it is inserted right before FRANK", pg.state.stops.indexOf(pilot) === pg.state.stops.findIndex((s) => s.id === "frank") - 1);
  await pg.recalculateFromHere();
  const hershey = byId(pg, "hershey");
  expect("a routed stop he skipped (HERSHEY, aimed past) is still marked passed", hershey?.skipRoute === true && hershey.path.length === 0,
    JSON.stringify({ skipRoute: hershey?.skipRoute }));
  expect("…and pilotfue is not", !pilot?.skipRoute && near(pg.calls.routed[0]?.to, PILOT), legText(pg));
}

// --- c. Navigation on ---
console.log("\nc. Navigation on");
{
  const pg = page();
  navigatingAtLebanon(pg);
  const pilot = addPilotFromMap(pg);
  await pg.recalculateFromHere();
  expectThroughPilot(pg, pilot, "nav on, Pilot added from the map");
  // paintLiveRoute rebuilds the nav legs on the page; it is stubbed here.
  expect("nav on: navigation now heads to pilotfue", pg.navAimStopId === pilot?.id && pg.upcomingRoutedStop()?.id === pilot?.id,
    `${pg.navAimStopId} / ${pg.upcomingRoutedStop()?.id}`);
  expect("nav on: the stop picker shows pilotfue", pg.chosenNavStop()?.stop?.id === pilot?.id, pg.chosenNavStop()?.stop?.name);
}
{
  const pg = page();
  parkedAtLebanon(pg);
  const pilot = addPilotCard(pg);
  pg.navOn = true;
  pg.navFixTime = clock.now - 1000;
  pg.navAimStopId = "frank";
  pg.geo.answer = null;
  await pg.recalculateFromHere();
  expectThroughPilot(pg, pilot, "added with nav off, then navigation started");
}

// --- d. A new stop with no address picked ---
console.log("\nd. A new stop with no address picked yet");
for (const navOn of [false, true]) {
  const pg = page();
  parkedAtLebanon(pg);
  // Stop cards are locked while navigating: added first, then navigation started.
  const pilot = addPilotCard(pg, { located: false, wipe: false });
  if (navOn) navigatingAtLebanon(pg);
  expect(`${navOn ? "nav on" : "nav off"}: the new stop has no location`, pilot?.name === "pilotfue" && !pg.pointReady(pilot));
  const before = JSON.stringify(pg.state.stops);
  await pg.recalculateFromHere();
  const label = navOn ? "nav on" : "nav off";
  expect(`${label}: it is not dropped (still a stop, not passed)`, pg.state.stops.includes(pilot) && !pilot.skipRoute,
    JSON.stringify({ skipRoute: pilot.skipRoute }));
  expect(`${label}: Recalculate stops with the lookup message, naming that stop`,
    /Press lookup address on pilotfue/.test(pg.state.error), pg.state.error);
  expect(`${label}: nothing is routed, nothing else changes`, pg.calls.routed.length === 0 && pg.calls.calculate.length === 0
    && JSON.stringify(pg.state.stops) === before && pg.state.estimating === false, legText(pg));
}

// --- e. No new stop: exactly as before ---
console.log("\ne. No new stop: same target, same passed stops as Build #619");
{
  const pg = page();
  parkedAtLebanon(pg);
  await pg.recalculateFromHere();
  const passed = pg.state.stops.filter((stop) => stop.skipRoute).map((stop) => stop.id);
  expect("one request, Lebanon → FRANK", pg.calls.routed.length === 1 && near(pg.calls.routed[0].from, LEBANON)
    && near(pg.calls.routed[0].to, PITTSBURGH), legText(pg));
  expect("passed: the start and EPHRATA", JSON.stringify(passed) === JSON.stringify(["start", "ephrata"]), JSON.stringify(passed));
  expect("FRANK has the new leg from Lebanon", nearPair(byId(pg, "frank").path[0], LEBANON));
  expect("the trip starts at Lebanon (Current location)", pg.state.stops[0]?.useCurrentLocation && near(pg.state.origin, LEBANON));
}
{
  const pg = page({ hershey: true });
  navigatingAtLebanon(pg);
  await pg.recalculateFromHere();
  const passed = pg.state.stops.filter((stop) => stop.skipRoute).map((stop) => stop.id);
  expect("nav on, aimed at FRANK past HERSHEY: one request, Lebanon → FRANK", pg.calls.routed.length === 1
    && near(pg.calls.routed[0].to, PITTSBURGH), legText(pg));
  expect("…passed: the start, EPHRATA, HERSHEY", JSON.stringify(passed) === JSON.stringify(["start", "ephrata", "hershey"]), JSON.stringify(passed));
  expect("…aim unchanged", pg.navAimStopId === "frank", pg.navAimStopId);
}
{
  const pg = page({ hershey: true });
  parkedAtLebanon(pg);
  await pg.recalculateFromHere();
  const passed = pg.state.stops.filter((stop) => stop.skipRoute).map((stop) => stop.id);
  expect("nav off, HERSHEY next: one request, Lebanon → HERSHEY; FRANK keeps its leg", pg.calls.routed.length === 1
    && near(pg.calls.routed[0].to, HERSHEY) && byId(pg, "frank").miles === "250", legText(pg));
  expect("…passed: the start and EPHRATA", JSON.stringify(passed) === JSON.stringify(["start", "ephrata"]), JSON.stringify(passed));
}

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
