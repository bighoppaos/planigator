// The page map chip shows the drive time to the stop being driven to, and the
// line said on the first tap after a refresh has the miles from where he is.
// Not loaded by the site. Run: node tests/tap-live-miles.test.mjs
//
// Loads the real onNavFix, ETA chip, page chip, and voice functions from
// js/app.js (by name, into a vm sandbox) with the map stubbed and a fake clock.
// Drives east toward PACTIV (exit 312 at 15 mi, PACTIV at 20 mi), then on to
// WALMART (40 mi), refreshes, keeps driving, and taps.

import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appSource = readFileSync(path.join(root, "js/app.js"), "utf8");
const navMatch = await import(pathToFileURL(path.join(root, "js/nav-match.js")).href);
const { isOriginStop } = await import(pathToFileURL(path.join(root, "js/plan.js")).href);
const { hoursLabel } = await import(pathToFileURL(path.join(root, "js/hos.js")).href);

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
  "rememberNavProgress", "saveNavSpot", "restoreNavSpot", "rebuildNavLegs", "navNearest", "guardResumedHit",
  "navMatchSpan", "navOffRoute", "activeNavLeg", "routePoints", "routeProgressKey", "onNavFix", "noteArrivedStops",
  "navMiles", "navStopTitle", "pointReady", "withoutGo", "maneuverText", "inDistance", "approachPhrase",
  "spokenApproach", "directionWithMilesLeft", "upcomingDirection", "bannerDirection", "speakNavProgress", "speakNav",
  "navVoiceLocked", "onVoiceGesture", "playChosenVoice", "spokenAloud", "setStopChip", "paintStopChip",
  "hoursForMeters", "paintDrive", "driveLeftText",
];
// Not in the old page. It runs without them, so this test can show it failing.
const OPTIONAL_FUNCTIONS = ["fixTime", "navFixFresh", "stopDriveText", "nextStopMeters"];
const APP_CODE = [
  constLine("NAV_PROGRESS_KEY"),
  constLine("RESUME_CONFIRM_FIXES"),
  constLine("RESUME_AGREE_M"),
  constLine("RESUME_PARKED_M"),
  constLine("RESUME_DRIVEN_M"),
  constLine("STOP_ARRIVE_M"),
  constLine("STATE_NAMES"),
  constLine("PAGE_VOICE"),
  constLine("NAV_FRESH_MS", true),
  ...APP_FUNCTIONS.map((name) => extract(name)),
  ...OPTIONAL_FUNCTIONS.map((name) => extract(name, true)),
].join("\n\n");

function fakeStorage() {
  const data = new Map();
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
}

const noop = () => {};
const clock = { now: Date.UTC(2026, 9, 2, 18, 0, 0) };
class FakeDate extends Date {
  static now() { return clock.now; }
}

// --- A straight road east. PACTIV at 20 mi, WALMART at 40 mi. ---

const COS = Math.cos(40 * Math.PI / 180);
const at = (miles) => [40, -80 + (miles * MILE) / (111320 * COS)];
const roadTo = (from, to) => {
  const out = [];
  for (let m = from * MILE; m <= to * MILE + 1; m += 150) out.push(at(m / MILE));
  return out;
};
const PLAN = { miles: 40, driveHours: 5.6 };
const plannedStops = () => [
  { id: "start", name: "Start", lat: 40, lon: -80, miles: "", hours: "" },
  { id: "pactiv", name: "PACTIV", lat: at(20)[0], lon: at(20)[1], miles: "20", hours: "2.8", path: roadTo(0, 20),
    directions: [
      { text: "Head east on I-76 E", miles: 15 },
      { text: "Take exit 312 toward Downingtown", miles: 5 },
      { text: "Arrive at PACTIV", miles: 0 },
    ] },
  { id: "walmart", name: "WALMART", lat: at(40)[0], lon: at(40)[1], miles: "20", hours: "2.8", path: roadTo(20, 40),
    directions: [
      { text: "Continue east", miles: 20 },
      { text: "Arrive at WALMART", miles: 0 },
    ] },
];
const EXIT_MI = 15;

// One page load: fresh module globals, shared localStorage and clock.
// voice is "phone" (the phone voice) or "us" (a page voice that loads first).
function page(storage, voice = "phone") {
  const elements = {};
  const heard = [];
  let voiceReady = null;
  const context = {
    console, Math, Number, String, JSON, Array, Object, Infinity, NaN, Set, Map, RegExp, Promise,
    Date: FakeDate,
    ...navMatch,
    isOriginStop, hoursLabel,
    localStorage: storage,
    document: { getElementById: (id) => (elements[id] ||= { id, hidden: true, textContent: "" }) },
    window: { maplibregl: {}, clearTimeout: noop, clearInterval: noop },
    elements, heard,
    state: { stops: plannedStops(), activeTripId: "trip-1", settings: {}, plan: { ...PLAN } },
    navLine: [], navLegs: [], navAlongLock: null, navResumeGuard: null, navLineKey: "", navTravel: null,
    navOn: false, navProgressResume: false, navAimStopId: "", navSpotSavedAlong: null, navFix: null, navFixAt: 0,
    navFixTime: 0, routeMap: {}, navYou: {}, tripFit: "full", navFollowing: false, navMapTouch: false,
    placeSeek: "", truckHits: [], navZoomHold: 0, routeFull: false, navStopNoteText: "",
    stopChipLines: [], stopChipIndex: 0, stopChipTimer: 0, driveAlong: null, driveStopMeters: null,
    voiceGestureSeen: false, navVoiceMissed: false, navVoiceIntroPending: false, navVoiceHere: null,
    spokenStepKey: "", spokenTurnKey: "", spokenMiles: new Set(), mixCtx: null,
    speakGen: 0, speakChain: Promise.resolve(),
    banner: { title: "", sub: "" },
    sayNav: (title, sub) => { context.banner = { title, sub }; },
    navVoiceId: () => voice,
    mph: () => 50,
    etaLabel: () => "ETA 8:48 PM",
    speakPhone: (said) => { heard.push({ said, truckMi: context.truckMi }); return Promise.resolve(); },
    // The page voice is still loading after the refresh until the test says so.
    warmPageVoices: () => voiceReady || (voiceReady = new Promise((resolve) => { context.voiceLoaded = resolve; })),
    pageSpeech: async (said) => ({ samples: said, rate: 22050 }),
    playSamples: async (said) => { heard.push({ said, truckMi: context.truckMi }); },
    truckMi: 0,
  };
  context.unlockMix = () => { context.mixCtx = { state: "running" }; };
  for (const name of [
    "placeNavDot", "aimNavDot", "startNavMotion", "resumeTurnZoom", "paintCompassRose", "queueBasemap", "refreshPlace",
    "paintRouteLines", "paintSwitchOffer", "paintNavLine", "clearStopNote", "trackLiveDrive", "paintDirectionMiles",
    "openDirectionsNear", "paintDirectionToward", "frameNextTurn", "frameNextStop", "persist", "markDirection",
    "paintVoiceHint", "disarmVoiceGesture", "warmPhoneVoice", "stopNavUtterance", "showStopNote", "clearDirectionPin",
  ]) context[name] = noop;
  context.styleIsBasemap = () => true;
  vm.createContext(context);
  vm.runInContext(APP_CODE, context);
  return context;
}

function startLive(storage, voice) {
  const pg = page(storage, voice);
  pg.navOn = true;
  pg.navAimStopId = "pactiv";
  pg.voiceGestureSeen = true;
  pg.rememberNavProgress();
  pg.rebuildNavLegs();
  pg.navLineKey = pg.routeProgressKey(pg.routePoints());
  return pg;
}

// A refresh: new page, same storage, navigation resumes with the voice locked.
function reload(storage, voice) {
  const pg = page(storage, voice);
  pg.navAimStopId = pg.readNavProgress()?.aimId || "";
  pg.navOn = true;
  pg.navLineKey = pg.routeProgressKey(pg.routePoints());
  pg.restoreNavSpot();
  return pg;
}

// 60 mph: one mile a minute. A GPS fix taken now at `miles` along the road.
const SECONDS_PER_MILE = 60;
function gps(pg, miles, takenAt = clock.now) {
  pg.truckMi = miles;
  const [lat, lon] = at(miles);
  pg.onNavFix(lat + 0.0001, lon, takenAt);
}

function drive(pg, from, to, every = 0.02) {
  for (let m = from; m <= to + 1e-9; m += every) {
    const miles = Math.round(m * 1000) / 1000;
    clock.now += every * SECONDS_PER_MILE * 1000;
    gps(pg, miles);
  }
}

const flush = async () => {
  for (let k = 0; k < 10; k += 1) await Promise.resolve();
};

// "In 6 miles, ..." -> 6
function spokenMiles(text) {
  const hit = /^In ([0-9.]+) miles?,/i.exec(text || "");
  return hit ? Number(hit[1]) : NaN;
}
const tenth = (miles) => Math.round(miles * 10) / 10;
const toExit = (truckMi) => tenth(EXIT_MI - truckMi);

let failures = 0;
function expect(label, ok, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`);
}

// The time on the full-screen ETA chip: "ETA 8:48 PM · 14 mi · 1 hr 58 min".
const etaChipTime = (pg) => String(pg.elements.routeStopMiles?.textContent || "").split(" · ")[2] || "";
const pageChip = (pg) => (pg.elements.routeDrive?.hidden ? "" : String(pg.elements.routeDrive?.textContent || ""));

console.log("Page map chip while driving to PACTIV");
{
  const storage = fakeStorage();
  const pg = startLive(storage);
  const seen = [];
  for (const miles of [1, 5, 9.5, 14]) {
    drive(pg, miles - 0.1, miles);
    seen.push({ miles, chip: pageChip(pg), eta: etaChipTime(pg) });
  }
  // The road line ends up to 150 m short of 20 mi, so allow a minute.
  const want = (miles) => PLAN.driveHours * ((20 - miles) / PLAN.miles) * 60;
  const minutes = (chip) => {
    const hit = /^(?:(\d+) hr)? ?(?:(\d+) min)? left$/.exec(chip);
    return hit ? Number(hit[1] || 0) * 60 + Number(hit[2] || 0) : NaN;
  };
  const near = (chip, miles) => Math.abs(minutes(chip) - want(miles)) <= 1;
  const bad = seen.find((r) => !near(r.chip, r.miles));
  expect("shows only the drive time to PACTIV, live as he drives", !bad, JSON.stringify(bad || seen.map((r) => r.chip)));
  const noMiles = seen.every((r) => !/\bmi\b|ETA|\d:\d\d/.test(r.chip));
  expect("no miles and no arrival time on the chip", noMiles, JSON.stringify(seen.map((r) => r.chip)));
  const agree = seen.every((r) => r.eta && r.chip === `${r.eta} left`);
  expect("same hours as the full-screen ETA chip's time left", agree, JSON.stringify(seen.map((r) => `${r.chip} | ${r.eta}`)));
  const wholeTrip = `${hoursLabel(PLAN.driveHours * ((40 - 14) / PLAN.miles))} left`;
  expect("not the whole trip time", seen[seen.length - 1].chip !== wholeTrip, `whole trip would be "${wholeTrip}"`);

  pg.routeFull = true;
  pg.paintDrive();
  expect("full screen keeps the whole trip time", pageChip(pg) === wholeTrip, `"${pageChip(pg)}"`);
  pg.routeFull = false;
  pg.paintDrive();

  const after = reload(storage);
  drive(after, 14.2, 14.5);
  expect("right after a refresh: still the time to PACTIV", near(pageChip(after), 14.5) && pageChip(after) === `${etaChipTime(after)} left`, `"${pageChip(after)}" vs ETA chip "${etaChipTime(after)}"`);
}

console.log("\nRefresh, keep driving with the screen on, then tap");
{
  const storage = fakeStorage();
  const live = startLive(storage);
  drive(live, 0.2, 5);
  const pg = reload(storage);
  drive(pg, 5.05, 9);
  expect("banner miles are live after the refresh", spokenMiles(pg.banner.title) === toExit(9), `"${pg.banner.title}" at ${toExit(9)} mi to the exit`);
  expect("nothing said while the voice is locked", pg.heard.length === 0, JSON.stringify(pg.heard));
  pg.onVoiceGesture({ type: "touchend" });
  drive(pg, 9.02, 9.02);
  await flush();
  const first = pg.heard[0];
  expect("the tap says the miles from where he is", first && spokenMiles(first.said) === toExit(first.truckMi), JSON.stringify(first));
}

console.log("\nRefresh, the screen goes dark, drive 3.5 miles, wake it and tap (iPhone hands back its cached fix first)");
{
  const storage = fakeStorage();
  const live = startLive(storage);
  drive(live, 0.2, 5);
  const pg = reload(storage);
  drive(pg, 5.02, 5.48);
  // The last fix before the screen went dark. Safari keeps it.
  const cachedAt = clock.now + 1000;
  clock.now += 3.5 * SECONDS_PER_MILE * 1000;
  pg.onVoiceGesture({ type: "touchend" });
  gps(pg, 5.5, cachedAt);
  pg.truckMi = 9;
  await flush();
  drive(pg, 9, 9.04);
  await flush();
  const first = pg.heard[0];
  expect("the first line after the tap has the live miles, not the cached spot's", first && spokenMiles(first.said) === toExit(first.truckMi), JSON.stringify(first));
  expect("banner shows the live miles", spokenMiles(pg.banner.title) === toExit(9.04), `"${pg.banner.title}"`);
  gps(pg, 6, clock.now - 120000);
  expect("a late cached fix does not pull the banner back", spokenMiles(pg.banner.title) === toExit(9.04), `"${pg.banner.title}"`);
}

console.log("\nRefresh, tap, and the page voice is still loading while he drives on");
{
  const storage = fakeStorage();
  const live = startLive(storage, "us");
  drive(live, 0.2, 5);
  const pg = reload(storage, "us");
  drive(pg, 5.05, 9);
  pg.onVoiceGesture({ type: "touchend" });
  drive(pg, 9.02, 9.02);
  await flush();
  drive(pg, 9.04, 9.6);
  pg.voiceLoaded();
  await flush();
  const first = pg.heard[0];
  expect("the line has the miles from when it is spoken", first && spokenMiles(first.said) === toExit(first.truckMi), JSON.stringify(first));
}

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
