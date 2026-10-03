// Build #626: Add and recalculate on a Detour pin while navigating drives you
// to the place you added. Right away the directions header names it, the steps,
// voice, ETA chip and magenta current leg are for the leg to it, its chip is on
// the map, Search here and Clear are gone, and the map is back in Turn zoom.
// The leg in and the leg back out run on the same road (a Walmart 1.9 miles off
// the Turnpike), and the match never lands on the way back out: the place is
// reached only on real arrival, and navigation moves on to the old next stop
// the usual way (Is Walmart done?).
// Not loaded by the site.
// Run: node tests/add-recalc.test.mjs
// Against other copies: APP_JS=/path/to/app.js node tests/add-recalc.test.mjs
//
// The real Add and recalculate (addTruckAndRecalculate, addPlaceAsNextStop),
// nav legs and matching, onNavFix, the full-screen repaint (paintLiveRoute,
// addRoutePins, paintLiveDirections), the header (paintDirectionToward), the
// route line colors (routeFeatureCollection), Search here / Clear
// (paintPlaceList) and the Done switch (confirmStopSwitch, markStopDone,
// aimNavAtStop) are loaded from js/app.js by name into a vm sandbox. HERE
// routing returns fixed roads; calculate({ silent: true }) does what render()
// does on the full-screen map (paintLiveRoute), or what the page map's rebuild
// does (a new map whose load runs onNavFix).
//
// Trip: Breezewood, PA west on the PA Turnpike to "pilotfue" near Wheeling.
// He adds the Walmart Supercenter in Somerset, PA (Turnpike exit 110, then
// 1.9 miles north on N Center Ave / PA-601).

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

function constLine(name) {
  const hit = new RegExp(`^const ${name} = [^;]+;`, "m").exec(appSource);
  if (!hit) throw new Error(`app.js has no const ${name}`);
  return hit[0].replace(/^const /, "var ");
}

const APP_CODE = [
  ...["NAV_FRESH_MS", "STOP_NAME_LIMIT", "RESUME_CONFIRM_FIXES", "RESUME_AGREE_M", "RESUME_PARKED_M", "RESUME_DRIVEN_M"].map(constLine),
  ...[
    // Add and recalculate
    "addTruckAndRecalculate", "addPlaceAsNextStop", "currentFix", "navFixFresh", "upcomingRoutedStop", "stopPoint",
    "writeRoutedLeg", "clipStopName", "navDestList", "chosenNavStop", "pointReady", "originPoint",
    // Search pins, Search here / Clear
    "clearTruckPins", "paintPlaceList", "fillPagePlaceList",
    // Nav legs and matching
    "rebuildNavLegs", "activeNavLeg", "navNearest", "navMatchSpan", "navOffRoute", "guardResumedHit", "metersBetween", "navBearing",
    "polylineMeters", "stepLengthMeters", "scaledStepLengths", "navStep", "metersLeftInStep", "navStopTitle",
    "noteArrivedStops", "stopHasSavedLeg",
    // One GPS fix, and the full-screen repaint after calculate
    "onNavFix", "paintLiveRoute", "paintLiveDirections", "routePoints", "routeProgressKey", "paintRouteLines",
    "routeFeatureCollection", "directionTowardName", "paintDirectionToward",
    "addRoutePins", "clearRoutePins", "routePins", "routePinFor", "declutterRoutePins", "hookRoutePinDeclutter",
    // Done at a stop, then on to the next one
    "confirmStopSwitch", "markStopDone", "aimNavAtStop",
  ].map(extract),
].join("\n\n");

// --- Roads (lat, lon) ---

const BREEZEWOOD = [39.999, -78.240];
const BEDFORD = [40.040, -78.500];
const TPK_EAST = [40.005, -78.950]; // Turnpike, east of Somerset
const EXIT_110 = [40.020, -79.075]; // Somerset interchange
const NCA_1 = [40.030, -79.074]; // N Center Ave (PA-601), north of the interchange
const NCA_2 = [40.040, -79.073];
const WALMART = [40.047, -79.072]; // Walmart Supercenter, Somerset, 1.9 mi off the Turnpike
const TPK_WEST = [40.100, -79.250];
const NEW_STANTON = [40.220, -79.600];
const PILOT = [40.070, -80.680]; // "pilotfue"

const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const HERE = lerp(BEDFORD, TPK_EAST, 0.4); // when he presses Add and recalculate (about 33 miles before the Walmart)

// Points every `stepM` meters, like a HERE polyline.
function road(points, stepM = 150) {
  const out = [];
  for (let i = 1; i < points.length; i += 1) {
    const [a, b] = [points[i - 1], points[i]];
    const n = Math.max(1, Math.ceil(navMatch.metersBetween(a, b) / stepM));
    for (let k = i === 1 ? 0 : 1; k <= n; k += 1) out.push(lerp(a, b, k / n));
  }
  return out;
}

const meters = (pts) => {
  let sum = 0;
  for (let i = 1; i < pts.length; i += 1) sum += navMatch.metersBetween(pts[i - 1], pts[i]);
  return sum;
};
const miles = (m) => m / 1609.344;

// A HERE leg along `via`; each step runs to the next `via` point.
function hereLeg(via, texts) {
  const points = road(via);
  const directions = texts.map((text, i) => ({ text, miles: i < via.length - 1 ? miles(meters(road([via[i], via[i + 1]]))) : 0 }));
  return { miles: miles(meters(points)), hours: miles(meters(points)) / 60, points, directions };
}

function stopLeg(id, name, to, via, texts, extra = {}) {
  const leg = hereLeg(via, texts);
  return {
    id, name, lat: to[0], lon: to[1], address: name, anytime: true,
    miles: String(leg.miles), hours: String(leg.hours), path: leg.points, directions: leg.directions, ...extra,
  };
}

const PILOT_TEXTS = ["Head west on I-76 W", "Continue on I-70 W/I-76 W", "Pass exit 110", "Continue toward New Stanton", "Take exit 75 onto I-70 W", "Arrive at pilotfue"];

function tripStops({ doneBefore = false } = {}) {
  const stops = [{ id: "start", name: "Breezewood", lat: BREEZEWOOD[0], lon: BREEZEWOOD[1], address: "Breezewood, PA" }];
  if (doneBefore) {
    stops.push(stopLeg("bedford", "BEDFORD", BEDFORD, [BREEZEWOOD, BEDFORD], ["Head west", "Arrive"], { done: true, switched: true, skipRoute: true }));
    stops.push(stopLeg("pilotfue", "pilotfue", PILOT, [BEDFORD, TPK_EAST, EXIT_110, TPK_WEST, NEW_STANTON, PILOT], PILOT_TEXTS.slice(1)));
  } else {
    stops.push(stopLeg("pilotfue", "pilotfue", PILOT, [BREEZEWOOD, BEDFORD, TPK_EAST, EXIT_110, TPK_WEST, NEW_STANTON, PILOT], PILOT_TEXTS));
  }
  return stops;
}

// The search result he tapped: result 1 of Next Walmart.
const WALMART_HIT = {
  name: "Walmart Supercenter", lat: WALMART[0], lon: WALMART[1], city: "Somerset", state: "PA",
  milesAhead: 33.5, milesOff: 1.9, place: "walmart",
};
const OTHER_HIT = { name: "Walmart Supercenter", lat: 40.12, lon: -79.55, milesAhead: 61.2, milesOff: 0.6, place: "walmart" };

// HERE's two legs for "Add and recalculate": here -> Walmart, Walmart -> pilotfue.
// Into Somerset: west on the Turnpike, off at exit 110, north on N Center Ave.
// Back out: south on the same N Center Ave, back on at exit 110, west.
const INTO_TEXTS = ["Head west on I-70 W/I-76 W", "Take exit 110 toward Somerset", "Turn left onto N Center Ave (PA-601 N)", "Continue on N Center Ave", "Arrive at Walmart Supercenter"];
const ONWARD = hereLeg([WALMART, NCA_2, NCA_1, EXIT_110, TPK_WEST, NEW_STANTON, PILOT],
  ["Turn left onto N Center Ave (PA-601 S)", "Continue on N Center Ave (PA-601 S)", "Turn right onto PA Turnpike Acc toward I-70/I-76",
    "Take ramp onto I-70 W/I-76 W (Pennsylvania Tpke)", "Take exit 75 onto I-70 W", "Arrive at pilotfue"]);

// --- A small DOM and map ---

const noop = () => {};

class FakeEl {
  constructor(id = "") {
    this.id = id;
    this.className = "";
    this.textContent = "";
    this.hidden = false;
    this.style = {};
    this.dataset = {};
    this.attrs = {};
    const el = this;
    this.classList = {
      contains: (name) => el.className.split(/\s+/).includes(name),
      add: (name) => { if (!el.classList.contains(name)) el.className = `${el.className} ${name}`.trim(); },
      remove: (name) => { el.className = el.className.split(/\s+/).filter((c) => c && c !== name).join(" "); },
      toggle: (name, on = !el.classList.contains(name)) => { if (on) el.classList.add(name); else el.classList.remove(name); return on; },
    };
  }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  removeAttribute(name) { delete this.attrs[name]; }
}

class FakeMarker {
  constructor({ element }) { this.el = element; this.at = null; this.map = null; }
  setLngLat(v) { this.at = Array.isArray(v) ? { lng: v[0], lat: v[1] } : v; return this; }
  getLngLat() { return this.at; }
  addTo(map) { this.map = map; map.markers.push(this); return this; }
  remove() { if (this.map) this.map.markers = this.map.markers.filter((m) => m !== this); this.map = null; return this; }
  getElement() { return this.el; }
}

function fakeMap() {
  const sources = {};
  const map = {
    markers: [],
    handlers: {},
    sourceData: {},
    on(type, fn) { (this.handlers[type] ||= []).push(fn); return this; },
    getSource(id) {
      sources[id] ||= { setData: (data) => { map.sourceData[id] = data; } };
      return sources[id];
    },
    getLayer: () => true,
    setPaintProperty: noop,
    project: () => ({ x: 0, y: 0 }),
  };
  return map;
}

// --- The page ---

function page({ aim = "pilotfue", doneBefore = false, here = HERE, travel = 280, into = null, pageMap = false } = {}) {
  const clock = { now: Date.UTC(2026, 9, 3, 16, 28, 0) };
  class FakeDate extends Date {
    constructor(...args) { if (args.length) super(...args); else super(clock.now); }
    static now() { return clock.now; }
  }
  const els = Object.fromEntries(["dirToward", "routePlaceSearch", "routePlaceClear", "routePlaceStatus"].map((id) => [id, new FakeEl(id)]));
  const log = { routed: [], chip: [], say: [], marked: [], spoken: [], navLine: [], turnFrames: 0, calculate: [], remembered: [] };
  let ids = 0;
  const map = fakeMap();
  const pg = {
    console, Math, Number, String, JSON, Array, Object, Infinity, NaN, Set, Map, RegExp, Promise, Error, Boolean,
    Date: FakeDate,
    ...plan, ...navMatch,
    clock, log, els, map,
    document: {
      activeElement: null,
      getElementById: (id) => els[id] || null,
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => new FakeEl(),
    },
    window: { maplibregl: { Marker: FakeMarker }, setTimeout: (fn) => { fn(); return 1; }, clearTimeout: noop },
    navigator: { geolocation: null },
    state: {
      stops: tripStops({ doneBefore }),
      settings: { governed: true, governedMph: 65 }, plan: { events: [] }, origin: null, driveProgress: null,
      estimating: false, error: "", notice: "", unlimited: true, credits: 10,
    },
    // Navigating, full screen, Turn zoom, a Next Walmart search on the map with result 1 chosen.
    navOn: true, navFix: here.slice(), navFixTime: clock.now - 1000, navFixAt: 0, navTravel: travel, navYou: {},
    navVoiceNow: null, navLine: [], navLegs: [], navAlongLock: null, navResumeGuard: null, navLineKey: "",
    navAimStopId: aim, navStopCursor: 0, navStopPicked: false, navGuideFromId: "", navStopAwaitNear: false,
    navStopAnnounce: false, navStopSpeakKey: "", pendingAimId: "", railMenu: "", directionsAutoKey: "",
    spokenStepKey: "", spokenMiles: new Set(),
    tripFit: "nextTurn", navFollowing: false, followPinned: false, navMapTouch: false, navZoomHold: 0, navReturnTimer: 0,
    routeMap: map, routeMapReady: true, routeFull: !pageMap, routePageStale: false,
    routePinMarkers: [], routePinsHooked: null, routePinsPlain: true, stopTargetId: "",
    truckHits: [WALMART_HIT, OTHER_HIT], truckHit: WALMART_HIT, truckMarkers: [new FakeMarker({ element: new FakeEl() })], truckMarker: null,
    placeListMode: false, placeSeek: "walmart", placeSeekFull: !pageMap, placeMapMoved: false, placeHereNote: "Walmart near here",
    // Stubs
    defaultStop: (patch = {}) => ({
      id: `new-${++ids}`, name: "", address: "", miles: "", hours: "", anytime: false, window: false,
      start: clock.now, end: clock.now, useCurrentLocation: false, ...patch,
    }),
    clockOffset: () => 0,
    travelCourse: () => ({ course: travel, travel, reliable: true }),
    routeTruckLeg: async (from, to) => {
      log.routed.push({ from: [from.lat, from.lon], to: [to.lat, to.lon] });
      const toWalmart = Math.abs(to.lat - WALMART[0]) < 1e-9 && Math.abs(to.lon - WALMART[1]) < 1e-9;
      if (toWalmart) return into || hereLeg([[from.lat, from.lon], TPK_EAST, EXIT_110, NCA_1, NCA_2, WALMART], INTO_TEXTS);
      return ONWARD;
    },
    calculate: async (opts) => {
      log.calculate.push(opts);
      if (pg.routeFull) {
        // render() on the full-screen map
        pg.routePageStale = true;
        pg.paintLiveRoute();
      } else {
        // render() on the page: a new map, whose load paints the chips and runs onNavFix
        pg.rebuildNavLegs();
        pg.addRoutePins();
        pg.onNavFix(pg.navFix[0], pg.navFix[1]);
      }
    },
    render: noop, persist: noop, syncRouteChrome: noop, syncTruckAdd: noop, calculateButtonLabel: () => "",
    creditEmptyMessage: () => "Out of credits.", clearDriveProgress: noop, clearTurnFrame: noop, clearStopNote: noop,
    showStopNote: noop, clearDirectionPin: noop, paintRailMenus: noop, beginRouteNav: noop, unlockMix: noop,
    speakNav: noop, paintDoneStop: noop, rebuildPlanAfterDone: noop, keepDoneOnSavedTrip: noop,
    rememberNavProgress: () => { log.remembered.push(pg.navAimStopId); },
    noteNavTrack: noop, saveNavSpot: noop, startNavMotion: noop, placeNavDot: noop, aimNavDot: noop,
    resumeTurnZoom: noop, paintCompassRose: noop, styleIsBasemap: () => true, queueBasemap: noop, refreshPlace: noop,
    paintDrive: noop, paintSwitchOffer: noop, trackLiveDrive: noop, bannerDirection: () => "", paintDirectionMiles: noop,
    openDirectionsNear: noop, refillDirections: noop, focusDirectionWindow: noop, frameNextStop: noop,
    navMiles: (m) => `${miles(m).toFixed(1)} mi`, ROUTE_LINE_COLOR: "#1f8a62",
    cardTitle: (index, stops) => stops[index].name,
    stopColor: () => [240, 200, 60], stopInk: () => ({ color: "#000" }), cssRGB: (rgb) => `rgb(${rgb.join(" ")})`,
    setStopChip: (m, name) => { log.chip.push({ m, name }); },
    sayNav: (...lines) => { log.say.push(lines); },
    markDirection: (stopId, index) => { log.marked.push({ stopId, index }); },
    speakNavProgress: (leg, found) => { log.spoken.push({ stopId: leg?.stop?.id, index: found?.index }); },
    paintNavLine: (along, until) => { log.navLine.push({ along, until }); },
    frameNextTurn: () => { log.turnFrames += 1; },
  };
  vm.createContext(pg);
  vm.runInContext(APP_CODE, pg);
  // Navigating along before the tap: the along-lock is where he is on the old line.
  pg.rebuildNavLegs();
  pg.navLineKey = pg.routeProgressKey(pg.routePoints());
  pg.onNavFix(here[0], here[1], clock.now);
  return pg;
}

const flush = async () => { for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r)); };

async function addWalmart(pg) {
  for (const key of Object.keys(pg.log)) if (Array.isArray(pg.log[key])) pg.log[key].length = 0;
  pg.log.turnFrames = 0;
  pg.truckHit = WALMART_HIT;
  pg.addTruckAndRecalculate();
  await flush();
  return pg.state.stops.find((stop) => Math.abs(Number(stop.lat) - WALMART[0]) < 1e-9 && Math.abs(Number(stop.lon) - WALMART[1]) < 1e-9);
}

function drive(pg, point) {
  pg.clock.now += 20000;
  pg.onNavFix(point[0], point[1], pg.clock.now);
}

const last = (list) => list[list.length - 1];
const legOf = (pg, id) => pg.navLegs.find((leg) => leg.stop.id === id);
const header = (pg) => pg.els.dirToward.textContent;
const currentLegs = (pg) => (pg.map.sourceData.route?.features || []).filter((f) => f.properties.current === 1);
const pathOf = (stop) => (stop?.path || []).map(([lat, lon]) => [lon, lat]);
const sameLine = (a, b) => a.length === b.length && a.every((p, i) => p[0] === b[i][0] && p[1] === b[i][1]);
const near = (a, b, m = 1) => a && b && navMatch.metersBetween(a, b) <= m;
const mi = (m) => `${miles(m).toFixed(2)} mi`;

let failures = 0;
function expect(label, ok, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`);
}

// Everything that must hold the moment Add and recalculate finishes.
function expectHeadingToPlace(pg, walmart, label, { leftM } = {}) {
  const leg = legOf(pg, walmart?.id);
  const chip = last(pg.log.chip);
  expect(`${label}: the directions header names the Walmart`, header(pg) === "(Walmart)", JSON.stringify(header(pg)));
  expect(`${label}: navigation drives to it (active leg, stop button)`,
    pg.activeNavLeg()?.stop?.id === walmart?.id && pg.chosenNavStop()?.stop?.id === walmart?.id,
    `${pg.activeNavLeg()?.stop?.name} / ${pg.chosenNavStop()?.stop?.name}`);
  expect(`${label}: the ETA chip is for the leg to the Walmart`, chip?.name === "Walmart" && chip.m >= 0
    && (leftM == null || Math.abs(chip.m - leftM) <= Math.max(150, 0.02 * leftM)),
    chip ? `${chip.name}, ${mi(chip.m)}${leftM != null ? ` (want ${mi(leftM)})` : ""}` : "no chip");
  const marked = last(pg.log.marked);
  expect(`${label}: the current step is on the leg to the Walmart`, marked?.stopId === walmart?.id,
    marked ? `${marked.stopId} #${marked.index + 1}` : "no step marked");
  const spoken = last(pg.log.spoken);
  expect(`${label}: the voice guidance is for the leg to the Walmart`, spoken?.stopId === walmart?.id, JSON.stringify(spoken));
  const current = currentLegs(pg);
  expect(`${label}: the magenta current leg is the leg to the Walmart, and only that one`,
    current.length === 1 && sameLine(current[0].geometry.coordinates, pathOf(walmart)),
    `${current.length} current leg(s)`);
  const line = last(pg.log.navLine);
  expect(`${label}: the live magenta line ends at the Walmart, not at pilotfue`, leg && line && Math.abs(line.until - leg.end) < 1,
    line && leg ? `until ${mi(line.until)}, Walmart leg ends at ${mi(leg.end)}` : "none");
  expect(`${label}: the Walmart is not done or passed`, walmart && !walmart.done && !walmart.skipRoute);
}

// --- a. The report: aimed at pilotfue, Add and recalculate on the Somerset Walmart ---
console.log("a. Navigating to pilotfue (stop picked, or the page reloaded mid-drive), Add and recalculate on the Walmart 33.5 mi ahead");
{
  const pg = page();
  expect("set-up: before the tap, navigation heads to pilotfue", header(pg) === "(pilotfue)" && last(pg.log.chip)?.name === "pilotfue",
    `${header(pg)} / ${last(pg.log.chip)?.name}`);
  const walmart = await addWalmart(pg);
  const pilot = pg.state.stops.find((stop) => stop.id === "pilotfue");
  expect("the Walmart is inserted as the next stop, right before pilotfue",
    walmart && pg.state.stops.indexOf(walmart) === pg.state.stops.indexOf(pilot) - 1 && walmart.name === "Walmart",
    pg.state.stops.map((stop) => stop.name).join(" → "));
  expect("both legs are routed: here → Walmart, Walmart → pilotfue", pg.log.routed.length === 2
    && near(pg.log.routed[0].from, HERE) && near(pg.log.routed[0].to, WALMART)
    && near(pg.log.routed[1].from, WALMART) && near(pg.log.routed[1].to, PILOT), JSON.stringify(pg.log.routed));
  expect("…and written: the Walmart's leg starts here, pilotfue's starts at the Walmart",
    near(walmart?.path?.[0], HERE) && near(walmart?.path?.at(-1), WALMART) && near(pilot.path[0], WALMART));
  expect("the plan is rebuilt quietly", pg.log.calculate.length === 1 && pg.log.calculate[0]?.silent === true, JSON.stringify(pg.log.calculate));
  expectHeadingToPlace(pg, walmart, "right after the tap", { leftM: meters(walmart?.path || []) });
  expect("navigation is not 'Not on the route yet'", !pg.log.say.some((lines) => /Not on the route/.test(lines[0])),
    JSON.stringify(pg.log.say.map((lines) => lines[0])));
  expect("the aim saved for a reload is the Walmart", pg.navAimStopId === walmart?.id && last(pg.log.remembered) === walmart?.id,
    `${pg.navAimStopId} / saved ${last(pg.log.remembered)}`);
  const pin = pg.routePinMarkers.find((marker) => marker.getElement().dataset.stopId === walmart?.id);
  expect("the Walmart chip is on the map right away", pin && pin.getElement().textContent === "Walmart"
    && near([pin.getLngLat().lat, pin.getLngLat().lng], WALMART), pg.routePinMarkers.map((m) => m.getElement().textContent).join(", "));
  expect("the search pins are gone", pg.truckHits.length === 0 && pg.truckHit === null && pg.truckMarkers.length === 0,
    `${pg.truckHits.length} result(s), ${pg.truckMarkers.length} pin(s)`);
  expect("Search here is gone", pg.els.routePlaceSearch.hidden === true && !pg.placeSeek, `hidden ${pg.els.routePlaceSearch.hidden}, placeSeek "${pg.placeSeek}"`);
  expect("Clear is gone", pg.els.routePlaceClear.hidden === true, `hidden ${pg.els.routePlaceClear.hidden}`);
  expect("the 'near here' note is gone", pg.els.routePlaceStatus.hidden === true && !pg.placeHereNote, JSON.stringify(pg.placeHereNote));
  expect("the map is back in Turn zoom, framing the next turn", pg.tripFit === "nextTurn" && pg.log.turnFrames > 0,
    `${pg.tripFit}, ${pg.log.turnFrames} frame(s)`);

  // --- b. Driving in: off at exit 110 and north on N Center Ave, the road the way back out uses too ---
  console.log("\nb. Driving to the Walmart on the road the way back out also uses");
  const leg = legOf(pg, walmart?.id);
  const order = [TPK_EAST, EXIT_110, NCA_1, NCA_2, WALMART];
  const fixes = [
    ["on the Turnpike, east of Somerset", TPK_EAST],
    ["at exit 110", EXIT_110],
    ["northbound on N Center Ave, past the Turnpike access", NCA_1],
    ["northbound on N Center Ave, 0.5 mi before the Walmart", NCA_2],
  ];
  for (const [where, point] of fixes) {
    drive(pg, point);
    expectHeadingToPlace(pg, walmart, where, { leftM: meters(road(order.slice(order.indexOf(point)))) });
    expect(`${where}: matched on the way in, not on the way back out`,
      leg && pg.navAlongLock != null && pg.navAlongLock >= leg.start - 1 && pg.navAlongLock <= leg.end + 1,
      leg ? `along ${mi(pg.navAlongLock ?? NaN)}, Walmart leg ${mi(leg.start)}..${mi(leg.end)}` : "no leg");
  }

  // --- c. At the Walmart, then on to pilotfue the usual way ---
  console.log("\nc. At the Walmart, then Is Walmart done? moves on to pilotfue");
  drive(pg, WALMART);
  const atChip = last(pg.log.chip);
  expect("at the Walmart: the ETA chip says you are at the Walmart", atChip?.name === "Walmart" && atChip.m < 30,
    atChip ? `${atChip.name}, ${atChip.m.toFixed(0)} m` : "none");
  expect("…navigation stays on the Walmart until you say it is done", header(pg) === "(Walmart)" && !walmart?.done, header(pg));
  pg.pendingAimId = "pilotfue";
  pg.confirmStopSwitch();
  expect("Is Walmart done? Yes: the Walmart is done", walmart?.done === true && walmart.switched === true);
  drive(pg, NCA_1);
  drive(pg, lerp(NCA_1, EXIT_110, 0.5));
  const onward = legOf(pg, "pilotfue");
  const chip = last(pg.log.chip);
  expect("…heading back south on N Center Ave: navigation is on pilotfue", header(pg) === "(pilotfue)"
    && pg.activeNavLeg()?.stop?.id === "pilotfue" && chip?.name === "pilotfue", `${header(pg)} / ${chip?.name}`);
  expect("…matched on the way back out", onward && pg.navAlongLock >= onward.start && pg.navAlongLock <= onward.end,
    onward ? `along ${mi(pg.navAlongLock)}, pilotfue leg ${mi(onward.start)}..${mi(onward.end)}` : "");
  const current = currentLegs(pg);
  expect("…and the magenta current leg is pilotfue's", current.length === 1 && sameLine(current[0].geometry.coordinates, pathOf(onward?.stop)));
}

// --- d. No stop picked (navigation on the first open stop) ---
console.log("\nd. No stop picked: navigation was on the first open stop");
{
  const pg = page({ aim: "" });
  const walmart = await addWalmart(pg);
  expectHeadingToPlace(pg, walmart, "no stop picked", { leftM: meters(walmart?.path || []) });
  expect("no stop picked: Search here and Clear are gone", pg.els.routePlaceSearch.hidden && pg.els.routePlaceClear.hidden);
}

// --- e. The Walmart is just behind him ---
console.log("\ne. The Walmart is behind him: the leg to it turns around and comes back past him");
{
  const here = lerp(EXIT_110, TPK_WEST, 0.12); // 2 miles past exit 110
  const turn = lerp(EXIT_110, TPK_WEST, 0.55); // the next place to turn around
  const back = (p) => [p[0] - 0.0003, p[1]]; // the eastbound carriageway, about 33 m away
  const into = hereLeg([here, turn, back(turn), back(here), back(EXIT_110), NCA_1, NCA_2, WALMART],
    ["Head west on I-70 W/I-76 W", "Make a U-turn", "Head east on I-70 E/I-76 E", "Continue east", "Take exit 110 toward Somerset",
      "Continue on N Center Ave", "Continue", "Arrive at Walmart Supercenter"]);
  for (const pageMap of [false, true]) {
    const where = pageMap ? "page map" : "full screen";
    const pg = page({ here, into, doneBefore: true, pageMap });
    const walmart = await addWalmart(pg);
    expectHeadingToPlace(pg, walmart, `behind him (${where})`, { leftM: meters(into.points) });
    const leg = legOf(pg, walmart?.id);
    expect(`behind him (${where}): matched at the start of the leg, not on the pass coming back by him`,
      leg && pg.navAlongLock != null && pg.navAlongLock - leg.start < 200, leg ? `${mi((pg.navAlongLock ?? NaN) - leg.start)} into the leg` : "");
  }
}

// --- f. Pressed at the exit for it ---
console.log("\nf. Pressed at exit 110, the Walmart 1.9 mi up N Center Ave");
{
  const into = hereLeg([EXIT_110, NCA_1, NCA_2, WALMART], ["Turn left onto N Center Ave (PA-601 N)", "Continue", "Continue", "Arrive at Walmart Supercenter"]);
  const pg = page({ here: EXIT_110, into });
  const walmart = await addWalmart(pg);
  expectHeadingToPlace(pg, walmart, "at exit 110", { leftM: meters(into.points) });
}

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
