// During navigation taps are quiet. Every tap still unlocks the voice, the tap
// that turns a held voice back on says the current direction once, and a tap on
// the directions says it again every time. Old lines never pile up and play
// late when he comes back to the app.
// Not loaded by the site. Run: node tests/voice-tap-reliable.test.mjs
// Against another copy of app.js: APP_JS=/path/to/app.js node tests/voice-tap-reliable.test.mjs
//
// Loads the real onNavFix, callout, tap, and voice functions from js/app.js (by
// name, into a vm sandbox). The phone voice is a fake speechSynthesis that can
// pause, hold lines while iOS keeps the page quiet, refuse lines, send no
// events for a silent line, and lose onend. The page voices play through a fake
// AudioContext that can be suspended or "interrupted". Taps go through the
// document listeners the page arms, on fake elements that answer closest().

import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appSource = readFileSync(process.env.APP_JS || path.join(root, "js/app.js"), "utf8");
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
  "navBearing", "tripProgressKey", "readNavProgress", "readNavSpot", "writeNavProgress", "clearNavProgress", "readNavRecord", "readNavProgressMap",
  "writeNavProgressMap",
  "readLeftLeg", "leftLegKey", "openLeftLeg",
  "rememberNavProgress", "saveNavSpot", "restoreNavSpot", "rebuildNavLegs", "navNearest", "guardResumedHit",
  "navMatchSpan", "navOffRoute", "activeNavLeg", "routePoints", "routeProgressKey", "onNavFix", "noteArrivedStops",
  "navMiles", "navStopTitle", "pointReady", "withoutGo", "maneuverText", "inDistance", "approachPhrase",
  "spokenApproach", "directionWithMilesLeft", "upcomingDirection", "bannerDirection", "speakNavProgress", "speakNav",
  "setStopChip", "paintStopChip", "hoursForMeters", "paintDrive", "driveLeftText", "fixTime", "navFixFresh",
  "stopDriveText", "nextStopMeters", "pageDriveText", "spokenAloud",
  // The voice itself.
  "preferMix", "unlockMix", "stopNavUtterance", "playSamples", "speakPhone", "playChosenVoice", "navVoiceLocked",
  "warmPhoneVoice", "onVoiceGesture", "armVoiceGesture", "rewarmNavVoice", "paintVoiceHint", "unlockNavVoice",
];
// Not in the #605 page. It runs without them, so this test can show it failing.
const OPTIONAL_FUNCTIONS = [
  "readyMix", "speechWatchMs", "clearStuckSpeech", "tapMoved", "currentNavStep", "currentStepLine", "sayTapLine",
  "relockNavVoice", "hushNavVoice", "checkPhoneVoice", "stepLine", "holdStepLine", "disarmVoiceGesture",
  "repeatTap", "phoneVoiceHeld",
];
const APP_CODE = [
  constLine("NAV_PROGRESS_KEY"),
  constLine("NAV_PROGRESS_TRIPS"),
  constLine("RESUME_CONFIRM_FIXES"),
  constLine("RESUME_AGREE_M"),
  constLine("RESUME_PARKED_M"),
  constLine("RESUME_DRIVEN_M"),
  constLine("STOP_ARRIVE_M"),
  constLine("STATE_NAMES"),
  constLine("PAGE_VOICE"),
  constLine("NAV_FRESH_MS"),
  constLine("VOICE_GESTURES"),
  constLine("VOICE_TAP_MS", true),
  constLine("VOICE_OWN_LINE", true),
  constLine("VOICE_REPEAT", true),
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
const flush = async () => {
  for (let k = 0; k < 30; k += 1) await Promise.resolve();
};

// --- One clock and timer queue for the whole run. ---

const clock = { now: Date.UTC(2026, 9, 2, 18, 0, 0) };
class FakeDate extends Date {
  static now() { return clock.now; }
}
let timers = new Map();
let timerId = 0;
const setTimer = (fn, ms = 0) => {
  timerId += 1;
  timers.set(timerId, { at: clock.now + Math.max(0, Number(ms) || 0), fn });
  return timerId;
};
const clearTimer = (id) => { timers.delete(id); };
async function advance(ms) {
  const end = clock.now + ms;
  for (;;) {
    await flush();
    let next = null;
    for (const [id, t] of timers) if (t.at <= end && (!next || t.at < next[1].at)) next = [id, t];
    if (!next) break;
    timers.delete(next[0]);
    clock.now = Math.max(clock.now, next[1].at);
    next[1].fn();
    await flush();
  }
  clock.now = end;
  await flush();
}

// iOS only lets audio start inside a tap.
const gesture = { active: false };

// --- The phone voice. ---

class FakeUtterance {
  constructor(text) { this.text = String(text); }
}

class FakeSynth {
  constructor(heard) {
    this.heard = heard;
    this.queue = [];
    this.current = null;
    this.paused = false;
    // iOS stuck on a line: resume() does nothing while that line is queued.
    this.resumeBroken = false;
    // iOS holding the voice (page hidden, or quiet until a tap).
    this.held = false;
    // The next lines start but never send onend.
    this.hangNext = 0;
    // iOS refusing speech outside a tap: real lines fail with "not-allowed".
    this.refuse = false;
    // iOS sending no events at all for a silent line, even when the voice works.
    this.silentNoEvents = false;
    this.cancels = 0;
  }
  get speaking() { return Boolean(this.current); }
  get pending() { return this.queue.length > 0; }
  speak(utter) {
    if (gesture.active) {
      this.held = false;
      this.refuse = false;
    }
    if (this.refuse && utter.text.trim()) {
      utter.onerror?.({ error: "not-allowed" });
      return;
    }
    this.queue.push(utter);
    this.pump();
  }
  pump() {
    if (this.current || this.paused || this.held) return;
    const utter = this.queue.shift();
    if (!utter) return;
    if (this.silentNoEvents && !utter.text.trim()) {
      this.pump();
      return;
    }
    this.current = utter;
    if (utter.text.trim()) this.heard.push(utter.text);
    utter.onstart?.();
    if (this.hangNext > 0) {
      this.hangNext -= 1;
      return;
    }
    utter.timer = setTimer(() => {
      if (this.current !== utter) return;
      this.current = null;
      utter.onend?.();
      this.pump();
    }, 1500);
  }
  cancel() {
    this.cancels += 1;
    const gone = [this.current, ...this.queue].filter(Boolean);
    if (this.current) clearTimer(this.current.timer);
    this.current = null;
    this.queue = [];
    for (const utter of gone) utter.onerror?.({ error: "canceled" });
  }
  resume() {
    if (this.resumeBroken && this.queue.length) return;
    this.paused = false;
    this.pump();
  }
}

// --- The page voices' mixer. ---

class FakeAudioContext {
  constructor(heard) {
    this.heard = heard;
    this.state = "suspended";
    this.onstatechange = null;
    this.held = [];
    this.hangNext = 0;
    this.destination = {};
  }
  setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.onstatechange?.();
    if (state === "running") {
      const held = this.held;
      this.held = [];
      for (const source of held) this.play(source);
    }
  }
  resume() {
    if (this.state !== "closed" && gesture.active) this.setState("running");
    return Promise.resolve();
  }
  close() { this.setState("closed"); }
  // A call or another app's audio.
  interrupt() { this.setState("interrupted"); }
  createBuffer(channels, length, rate) {
    const buffer = { length, rate, said: "" };
    buffer.getChannelData = () => ({ set: (samples) => { buffer.said = samples.said || ""; } });
    return buffer;
  }
  createBufferSource() {
    const ctx = this;
    return {
      connect: noop,
      start() {
        if (ctx.state === "running") ctx.play(this);
        else ctx.held.push(this);
      },
      stop() {
        this.stopped = true;
        ctx.held = ctx.held.filter((source) => source !== this);
        clearTimer(this.timer);
      },
    };
  }
  play(source) {
    if (source.stopped) return;
    if (source.buffer?.said) this.heard.push(source.buffer.said);
    if (source.buffer?.said && this.hangNext > 0) {
      this.hangNext -= 1;
      return;
    }
    source.timer = setTimer(() => source.onended?.(), (source.buffer.length / source.buffer.rate) * 1000);
  }
}

// --- A straight road east. Exit 312 at 15 mi, PACTIV at 20 mi, WALMART at 40 mi. ---

const COS = Math.cos(40 * Math.PI / 180);
const at = (miles) => [40, -80 + (miles * MILE) / (111320 * COS)];
const roadTo = (from, to) => {
  const out = [];
  for (let m = from * MILE; m <= to * MILE + 1; m += 150) out.push(at(m / MILE));
  return out;
};
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

// --- Fake page elements. closest() takes "#id", ".class", "[attr]", "tag",
// or "tag.class[attr]" pieces, comma separated, like the selectors app.js uses. ---

function matches(node, selector) {
  const parts = selector.trim().match(/^([a-z]+)?((?:[#.][\w-]+|\[[\w-]+\])*)$/i);
  if (!parts) return false;
  if (parts[1] && parts[1].toLowerCase() !== node.tag) return false;
  for (const piece of parts[2].match(/[#.][\w-]+|\[[\w-]+\]/g) || []) {
    if (piece[0] === "#" && node.id !== piece.slice(1)) return false;
    if (piece[0] === "." && !node.cls.includes(piece.slice(1))) return false;
    if (piece[0] === "[" && !node.attrs.includes(piece.slice(1, -1))) return false;
  }
  return true;
}
function node(tag, { id = "", cls = [], attrs = [] } = {}, parent = null) {
  const self = {
    tag, id, cls, attrs, parent,
    closest(selector) {
      const list = String(selector).split(",");
      for (let at = self; at; at = at.parent) if (list.some((one) => matches(at, one))) return at;
      return null;
    },
  };
  return self;
}
const body = node("body");
const stage = node("div", { id: "routeStage" }, body);
const mapTarget = node("canvas", { cls: ["maplibregl-canvas"] }, node("div", { id: "routeMap" }, stage));
const dirBox = node("details", { id: "routeDirections", cls: ["directions"] }, body);
const dirSummary = node("summary", {}, dirBox);
const dirLabel = node("span", { cls: ["dir-label"] }, dirSummary);
const dirList = node("ol", {}, node("div", { cls: ["dir-scroll"] }, dirBox));
const stepRow = () => node("button", { cls: ["dir-step"], attrs: ["data-dir-stop", "data-dir-index"] }, node("li", {}, dirList));
const dirPrevStep = stepRow();
const dirStep = stepRow();
const dirStepText = node("span", { cls: ["dir-link"] }, dirStep);
const dirLeg = node("li", { cls: ["dir-leg"] }, dirList);
const navTitle = node("p", { id: "routeNavTitle" }, body);
const voiceHint = node("button", { id: "routeVoiceHint", cls: ["route-voice-hint"] }, stage);
const button = (id, inner = "span") => node(inner, {}, node("button", { id }, stage));
const quietButtons = {
  "Trip zoom": button("routeWhole"),
  Detour: button("routeDetour"),
  "Detour menu item": node("button", { attrs: ["data-detour"] }, node("div", { id: "railDetourMenu" }, stage)),
  Compass: node("span", { cls: ["compass-n"] }, node("button", { id: "routeCompass" }, stage)),
  Stop: button("routeStops"),
  "Zoom in": button("routeZoomIn"),
  "Full screen": button("routeFull"),
  Recalculate: button("routeRecalc"),
  "ETA chip": node("div", { cls: ["chip-sec"] }, node("div", { cls: ["chip"], attrs: ["data-chip"] }, body)),
  "Stop miles line": node("p", { id: "routeStopMiles" }, stage),
  "End navigation": node("button", { id: "endNav" }, stage),
};

// One page load with navigation started by a tap on Start.
// voice is "phone" (speechSynthesis) or "us" (a page voice).
async function startNav(voice) {
  timers = new Map();
  const heard = [];
  const elements = {};
  const listeners = new Map();
  const synth = new FakeSynth(heard);
  const doc = {
    visibilityState: "visible",
    getElementById: (id) => (elements[id] ||= { id, hidden: true, textContent: "" }),
    addEventListener: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener: (type, fn) => { listeners.get(type)?.delete(fn); },
  };
  const context = {
    console, Math, Number, String, JSON, Array, Object, Infinity, NaN, Set, Map, RegExp, Promise, Float32Array,
    Date: FakeDate,
    ...navMatch,
    isOriginStop, hoursLabel,
    localStorage: fakeStorage(),
    document: doc,
    navigator: {},
    SpeechSynthesisUtterance: FakeUtterance,
    window: {
      maplibregl: {}, clearInterval: noop, setTimeout: setTimer, clearTimeout: clearTimer,
      speechSynthesis: synth,
      AudioContext: class extends FakeAudioContext { constructor() { super(heard); } },
    },
    elements, heard, synth, listeners,
    state: { stops: plannedStops(), activeTripId: "trip-1", settings: { navVoice: voice }, plan: { miles: 40, driveHours: 5.6 } },
    navLine: [], navLegs: [], navAlongLock: null, navResumeGuard: null, navLineKey: "", navTravel: null,
    navOn: false, navProgressResume: false, navAimStopId: "", navSpotSavedAlong: null, navFix: null, navFixAt: 0,
    navFixTime: 0, routeMap: {}, navYou: {}, tripFit: "full", navFollowing: false, navMapTouch: false,
    placeSeek: "", truckHits: [], navZoomHold: 0, routeFull: false, navStopNoteText: "",
    stopChipLines: [], stopChipIndex: 0, stopChipTimer: 0, driveAlong: null, driveStopMeters: null,
    voiceGestureSeen: false, navVoiceMissed: false, navVoiceIntroPending: false, navVoiceHere: null,
    navVoiceNow: null, voiceTapAt: 0, voicePress: null,
    spokenStepKey: "", spokenTurnKey: "", spokenMiles: new Set(),
    mixCtx: null, navVoiceNode: null, phoneUtter: null, phoneProbe: null, phoneHeardAt: 0, settleSpeech: null,
    speakGen: 0, speakChain: Promise.resolve(),
    sayNav: (title) => { elements.routeNavTitle = { textContent: title }; },
    navVoiceId: () => voice,
    mph: () => 50,
    etaLabel: () => "ETA 8:48 PM",
    warmPageVoices: () => Promise.resolve(),
    pageSpeech: async (said) => ({ samples: Object.assign(new Float32Array(4), { said }), rate: 2 }),
  };
  for (const name of [
    "placeNavDot", "aimNavDot", "startNavMotion", "resumeTurnZoom", "paintCompassRose", "queueBasemap", "refreshPlace",
    "paintRouteLines", "paintSwitchOffer", "paintNavLine", "clearStopNote", "trackLiveDrive", "paintDirectionMiles",
    "openDirectionsNear", "paintDirectionToward", "frameNextTurn", "frameNextStop", "persist", "markDirection",
    "showStopNote", "clearDirectionPin",
  ]) context[name] = noop;
  context.styleIsBasemap = () => true;
  vm.createContext(context);
  vm.runInContext(APP_CODE, context);
  const pg = context;
  // What initPlanner does once.
  pg.armVoiceGesture();
  // Start navigation: the Start button's click.
  pg.navOn = true;
  pg.navAimStopId = "pactiv";
  pg.rememberNavProgress();
  pg.rebuildNavLegs();
  pg.navLineKey = pg.routeProgressKey(pg.routePoints());
  gesture.active = true;
  pg.unlockNavVoice();
  gesture.active = false;
  await advance(3000);
  return pg;
}

function dispatch(pg, type, event) {
  for (const fn of [...(pg.listeners.get(type) || [])]) fn({ type, ...event });
}

// A finger tap: pointerdown, touchend, click. `control` runs as the button's
// own click handler, after the document capture listener.
async function tap(pg, target = mapTarget, control = null) {
  gesture.active = true;
  dispatch(pg, "pointerdown", { pointerType: "touch", clientX: 120, clientY: 300, target });
  dispatch(pg, "touchend", { changedTouches: [{ clientX: 121, clientY: 301 }], touches: [], target });
  dispatch(pg, "click", { target });
  control?.();
  gesture.active = false;
  await flush();
}

// The page's visibilitychange handler.
function visibility(pg, state) {
  pg.document.visibilityState = state;
  if (state !== "visible") pg.hushNavVoice?.();
  else pg.rewarmNavVoice();
}

// 60 mph: one mile a minute. A GPS fix taken now at `miles` along the road.
function gps(pg, miles, takenAt = clock.now) {
  const [lat, lon] = at(miles);
  pg.onNavFix(lat + 0.0001, lon, takenAt);
}

async function drive(pg, from, to, every = 0.05) {
  for (let m = from; m <= to + 1e-9; m += every) {
    await advance(every * 60 * 1000);
    gps(pg, Math.round(m * 1000) / 1000);
  }
}

const tenth = (miles) => Math.round(miles * 10) / 10;
const exitLine = (truckMi) => {
  const left = tenth(EXIT_MI - truckMi);
  const miles = Number.isInteger(left) ? `${left} ${left === 1 ? "mile" : "miles"}` : `${left.toFixed(1)} miles`;
  return `In ${miles}, Take exit 312 toward Downingtown`;
};
// spokenAloud turns nothing in this line into other words.
const since = (pg, mark) => pg.heard.slice(mark);

let failures = 0;
function expect(label, ok, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`);
}
const show = (value) => JSON.stringify(value);

// Stopped at `miles`: the GPS still sends a fix every second.
async function parked(pg, miles, ms = 2000) {
  for (let s = 0; s < ms / 1000; s += 1) {
    await advance(1000);
    gps(pg, miles);
  }
}

for (const voice of ["phone", "us"]) {
  console.log(`\nTaps on the map and the page are quiet (${voice} voice)`);
  const pg = await startNav(voice);
  await drive(pg, 0.2, 5);
  await advance(3000);
  const heardSteps = pg.heard.filter((text) => /Take exit 312/.test(text));
  expect("GPS fixes alone said the step once", heardSteps.length === 1, show(heardSteps));
  expect("the voice is not locked", pg.navVoiceLocked() === false);
  const results = [];
  for (const target of [mapTarget, mapTarget, body, mapTarget]) {
    const mark = pg.heard.length;
    await tap(pg, target);
    await parked(pg, 5);
    results.push(since(pg, mark));
  }
  expect("no tap on the map or page says anything", results.every((lines) => lines.length === 0), show(results));
  expect("no Tap to turn on voice", pg.elements.routeVoiceHint?.hidden !== false);
  const mark = pg.heard.length;
  await drive(pg, 5.05, 10.05);
  await advance(3000);
  expect("the next GPS callout (5 miles) still speaks", show(since(pg, mark)) === show([exitLine(10)]), show(since(pg, mark)));
  expect("the stop he is driving to did not change", pg.navAimStopId === "pactiv" && pg.state.stops.every((stop) => !stop.done),
    `${pg.navAimStopId}`);
}

for (const voice of ["phone", "us"]) {
  console.log(`\nA tap on the map does not cut off a line that is playing (${voice} voice)`);
  const pg = await startNav(voice);
  await drive(pg, 0.2, 5);
  await advance(3000);
  pg.speakNav("In 5 miles, Take exit 312 toward Downingtown");
  await flush();
  const cancels = pg.synth.cancels;
  const playing = voice === "phone" ? pg.synth.current : pg.navVoiceNode;
  expect("a line is playing", Boolean(playing));
  const mark = pg.heard.length;
  await advance(200);
  await tap(pg, mapTarget);
  await advance(200);
  const still = voice === "phone" ? pg.synth.current : pg.navVoiceNode;
  expect("the same line is still playing after the tap", Boolean(playing) && still === playing && !playing.stopped);
  expect("the tap cancelled nothing", pg.synth.cancels === cancels, `${pg.synth.cancels - cancels} cancel(s)`);
  await advance(3000);
  expect("nothing else was said", since(pg, mark).length === 0, show(since(pg, mark)));
}

for (const voice of ["phone", "us"]) {
  console.log(`\nTaps on buttons are quiet (${voice} voice)`);
  const pg = await startNav(voice);
  await drive(pg, 0.2, 5);
  await advance(3000);
  const spoke = [];
  for (const [label, target] of Object.entries(quietButtons)) {
    const mark = pg.heard.length;
    await tap(pg, target);
    await parked(pg, 5, 1000);
    if (since(pg, mark).length) spoke.push(`${label}: ${show(since(pg, mark))}`);
  }
  expect("trip zoom, Detour, compass, Stop, zoom, full screen, Recalculate, chips, End say nothing",
    spoke.length === 0, spoke.join("; "));
  const mark = pg.heard.length;
  await tap(pg, dirLabel);
  await parked(pg, 5);
  expect("opening or closing the directions box (its summary) says nothing", since(pg, mark).length === 0, show(since(pg, mark)));
}

for (const voice of ["phone", "us"]) {
  console.log(`\nA tap on the directions says the current direction, every time (${voice} voice)`);
  const pg = await startNav(voice);
  await drive(pg, 0.2, 5);
  await advance(3000);
  const results = [];
  for (const target of [dirStep, dirStepText, dirPrevStep, navTitle, dirLeg, dirStep]) {
    const mark = pg.heard.length;
    await tap(pg, target);
    await parked(pg, 5);
    results.push(since(pg, mark));
  }
  const want = exitLine(5);
  expect("each tap on a step row, the title, or the box says it once",
    results.every((lines) => lines.length === 1 && lines[0] === want), show(results));
  await drive(pg, 5.05, 5.5);
  await advance(3000);
  let mark = pg.heard.length;
  await tap(pg, dirStep);
  await parked(pg, 5.5);
  expect("with the miles from where he is now", show(since(pg, mark)) === show([exitLine(5.5)]), show(since(pg, mark)));
  mark = pg.heard.length;
  await tap(pg, dirStep);
  await advance(200);
  await tap(pg, dirStep);
  await parked(pg, 5.5);
  expect("two taps inside the one-tap window say it once", since(pg, mark).length === 1, show(since(pg, mark)));
  mark = pg.heard.length;
  await drive(pg, 5.55, 5.9);
  await advance(3000);
  expect("GPS fixes after the taps do not repeat it", since(pg, mark).length === 0, show(since(pg, mark)));
}

console.log("\nTap the directions when the newest fix is a minute old");
{
  const pg = await startNav("phone");
  await drive(pg, 0.2, 5);
  await advance(60000);
  const mark = pg.heard.length;
  await tap(pg, dirStep);
  expect("still says the current step, from the latest fix", show(since(pg, mark)) === show([exitLine(5)]), show(since(pg, mark)));
  const after = pg.heard.length;
  gps(pg, 6);
  await advance(2000);
  expect("the next fresh fix gives the live miles once", show(since(pg, after)) === show([exitLine(6)]), show(since(pg, after)));
}

console.log("\nPhone voice stuck paused with an old line queued");
{
  const pg = await startNav("phone");
  await drive(pg, 0.2, 5);
  await advance(3000);
  pg.synth.paused = true;
  pg.synth.resumeBroken = true;
  pg.synth.speak(new FakeUtterance("In 12 miles, Take exit 312 toward Downingtown"));
  const mark = pg.heard.length;
  await tap(pg, dirStep);
  expect("a tap on the directions says the fresh line", show(since(pg, mark)) === show([exitLine(5)]), show(since(pg, mark)));
  // Back from wherever iOS was stuck: the synth runs again.
  pg.synth.resumeBroken = false;
  pg.synth.resume();
  await advance(5000);
  expect("the old queued line never plays", !pg.heard.some((text) => /12 miles/.test(text)), show(since(pg, mark)));
}

console.log("\nA line that never sends onend");
{
  const pg = await startNav("phone");
  await drive(pg, 0.2, 5);
  await advance(3000);
  pg.synth.hangNext = 1;
  gesture.active = true;
  pg.unlockNavVoice();
  gesture.active = false;
  pg.speakNav("In 5 miles, Take exit 312 toward Downingtown");
  await advance(12000);
  expect("the next line is not stuck behind it", pg.heard.slice(-1)[0] === "In 5 miles, Take exit 312 toward Downingtown", show(pg.heard.slice(-2)));
  expect("Navigation on. no longer holds later lines back", pg.navVoiceIntroPending === false);
}
{
  const pg = await startNav("us");
  await drive(pg, 0.2, 5);
  await advance(3000);
  pg.mixCtx.hangNext = 1;
  gesture.active = true;
  pg.unlockNavVoice();
  gesture.active = false;
  pg.speakNav("In 5 miles, Take exit 312 toward Downingtown");
  await advance(12000);
  expect("a page voice clip that never ends does not block the next line", pg.heard.slice(-1)[0] === "In 5 miles, Take exit 312 toward Downingtown", show(pg.heard.slice(-2)));
}

for (const quiet of [false, true]) {
  console.log(`\nLeave the app, drive on, come back${quiet ? " (iPhone keeps the voice quiet until a tap)" : ""} (phone voice)`);
  const pg = await startNav("phone");
  await drive(pg, 0.2, 9.8);
  await advance(3000);
  const mark = pg.heard.length;
  visibility(pg, "hidden");
  pg.synth.held = true;
  // GPS keeps coming for a while. The 5-mile mark comes due at 10 mi.
  await drive(pg, 9.85, 10.4);
  pg.synth.held = quiet;
  pg.synth.pump();
  visibility(pg, "visible");
  await advance(3000);
  expect("nothing queued while away plays on return", since(pg, mark).length === 0, show(since(pg, mark)));
  expect("the silent check on return does not lock the voice", pg.navVoiceLocked() === false);
  expect("no Tap to turn on voice on return", pg.elements.routeVoiceHint?.hidden !== false);
  if (quiet) {
    // The 4-mile mark comes due at 11 mi. iOS holds it: it never starts.
    await drive(pg, 10.45, 11.1);
    await parked(pg, 11.1, 20000);
    expect("nothing heard while iOS holds the voice", since(pg, mark).length === 0, show(since(pg, mark)));
    expect("a real line that never started locks the voice", pg.navVoiceLocked() === true);
    expect("Tap to turn on voice shows", pg.elements.routeVoiceHint?.hidden === false);
    let tapMark = pg.heard.length;
    await tap(pg, mapTarget);
    await parked(pg, 11.1);
    expect("the tap that turns the voice back on says the current direction once",
      show(since(pg, tapMark)) === show([exitLine(11.1)]), show(since(pg, tapMark)));
    expect("the note is gone", pg.elements.routeVoiceHint?.hidden !== false);
    tapMark = pg.heard.length;
    await tap(pg, mapTarget);
    await parked(pg, 11.1);
    expect("the next tap is quiet again", since(pg, tapMark).length === 0, show(since(pg, tapMark)));
  } else {
    const tapMark = pg.heard.length;
    await tap(pg, mapTarget);
    await parked(pg, 10.4);
    expect("a tap on the map is quiet", since(pg, tapMark).length === 0, show(since(pg, tapMark)));
    await drive(pg, 10.45, 11.05);
    await advance(3000);
    expect("the next GPS callout speaks", show(since(pg, tapMark)) === show([exitLine(11)]), show(since(pg, tapMark)));
  }
}

console.log("\nThe silent check on return gets no events at all, but the voice works (phone voice)");
{
  const pg = await startNav("phone");
  await drive(pg, 0.2, 9.8);
  await advance(3000);
  pg.synth.silentNoEvents = true;
  visibility(pg, "hidden");
  await drive(pg, 9.85, 10.4);
  visibility(pg, "visible");
  await advance(3000);
  expect("the voice is not relocked", pg.navVoiceLocked() === false && pg.voiceGestureSeen === true);
  expect("Tap to turn on voice stays hidden", pg.elements.routeVoiceHint?.hidden !== false);
  const mark = pg.heard.length;
  await drive(pg, 10.45, 11.05);
  await advance(3000);
  expect("the next GPS callout speaks without a tap", show(since(pg, mark)) === show([exitLine(11)]), show(since(pg, mark)));
}

console.log("\niOS refuses a real line (not-allowed) while the page shows (phone voice)");
{
  const pg = await startNav("phone");
  await drive(pg, 0.2, 9.8);
  await advance(3000);
  pg.synth.refuse = true;
  const mark = pg.heard.length;
  await drive(pg, 9.85, 10.2);
  await advance(1000);
  expect("the refused line locks the voice", pg.navVoiceLocked() === true);
  expect("Tap to turn on voice shows", pg.elements.routeVoiceHint?.hidden === false);
  await tap(pg, voiceHint);
  await parked(pg, 10.2);
  expect("tapping the note says the current direction once", show(since(pg, mark)) === show([exitLine(10.2)]), show(since(pg, mark)));
  expect("the note is gone", pg.elements.routeVoiceHint?.hidden !== false);
  const again = pg.heard.length;
  await tap(pg, mapTarget);
  await parked(pg, 10.2);
  expect("the next tap is quiet", since(pg, again).length === 0, show(since(pg, again)));
}

console.log("\nLeave the app with a page voice; the mixer is suspended when he comes back");
{
  const pg = await startNav("us");
  await drive(pg, 0.2, 5);
  await advance(3000);
  visibility(pg, "hidden");
  pg.mixCtx.setState("suspended");
  visibility(pg, "visible");
  await advance(1000);
  expect("Tap to turn on voice shows", pg.elements.routeVoiceHint?.hidden === false);
  let mark = pg.heard.length;
  await tap(pg, mapTarget);
  await parked(pg, 5);
  expect("the tap that turns the voice back on says the current direction once", show(since(pg, mark)) === show([exitLine(5)]), show(since(pg, mark)));
  mark = pg.heard.length;
  await tap(pg, mapTarget);
  await parked(pg, 5);
  expect("the next tap is quiet", since(pg, mark).length === 0, show(since(pg, mark)));
}

console.log("\nA call interrupts the page voice's mixer");
{
  const pg = await startNav("us");
  await drive(pg, 0.2, 9.8);
  await advance(3000);
  pg.mixCtx.interrupt();
  expect("the voice counts as locked", pg.navVoiceLocked() === true);
  expect("Tap to turn on voice shows", pg.elements.routeVoiceHint?.hidden === false);
  let mark = pg.heard.length;
  await drive(pg, 9.85, 10.4);
  await tap(pg, quietButtons["Trip zoom"]);
  await advance(3000);
  expect("the tap resumes the mixer", pg.mixCtx.state === "running", pg.mixCtx.state);
  expect("the tap says the current direction once, and the 5-mile mark missed during the call does not play late",
    show(since(pg, mark)) === show([exitLine(10.4)]), show(since(pg, mark)));
  expect("the note is gone", pg.elements.routeVoiceHint?.hidden !== false);
  mark = pg.heard.length;
  await tap(pg, quietButtons["Trip zoom"]);
  await advance(2000);
  expect("the next tap is quiet", since(pg, mark).length === 0, show(since(pg, mark)));
}

console.log("\nTap on a control that says its own line");
{
  const pg = await startNav("phone");
  await drive(pg, 0.2, 5);
  await advance(3000);
  const voiceNext = node("button", { id: "voiceNext" }, body);
  const mark = pg.heard.length;
  await tap(pg, voiceNext, () => pg.playChosenVoice("This is Phone."));
  expect("one line for the tap: the control's", show(since(pg, mark)) === show(["This is Phone."]), show(since(pg, mark)));
}

console.log("\nDrag the map, scroll the directions");
{
  const pg = await startNav("phone");
  await drive(pg, 0.2, 5);
  await advance(3000);
  const mark = pg.heard.length;
  gesture.active = true;
  dispatch(pg, "pointerdown", { pointerType: "touch", clientX: 100, clientY: 300, target: dirStep });
  dispatch(pg, "touchend", { changedTouches: [{ clientX: 102, clientY: 180 }], touches: [], target: dirStep });
  gesture.active = false;
  await flush();
  expect("scrolling the directions is not a tap", since(pg, mark).length === 0, show(since(pg, mark)));
  await advance(1000);
  gesture.active = true;
  dispatch(pg, "pointerdown", { pointerType: "touch", isPrimary: true, clientX: 100, clientY: 300, target: dirBox });
  dispatch(pg, "pointerdown", { pointerType: "touch", isPrimary: false, clientX: 200, clientY: 300, target: dirBox });
  dispatch(pg, "touchend", { changedTouches: [{ clientX: 90, clientY: 300 }], touches: [{}], target: dirBox });
  dispatch(pg, "touchend", { changedTouches: [{ clientX: 210, clientY: 300 }], touches: [], target: dirBox });
  gesture.active = false;
  await flush();
  expect("a pinch is not a tap", since(pg, mark).length === 0, show(since(pg, mark)));
  await advance(1000);
  await tap(pg, dirStep);
  expect("the next real tap on the directions still speaks", show(since(pg, mark)) === show([exitLine(5)]), show(since(pg, mark)));
}

console.log("\nDrag the map while the voice is held (page voice)");
{
  const pg = await startNav("us");
  await drive(pg, 0.2, 5);
  await advance(3000);
  pg.mixCtx.interrupt();
  const mark = pg.heard.length;
  gesture.active = true;
  dispatch(pg, "pointerdown", { pointerType: "touch", clientX: 100, clientY: 300, target: mapTarget });
  dispatch(pg, "touchend", { changedTouches: [{ clientX: 220, clientY: 180 }], touches: [], target: mapTarget });
  gesture.active = false;
  await parked(pg, 5);
  expect("the drag says nothing", since(pg, mark).length === 0, show(since(pg, mark)));
}

console.log("\nNavigation off");
{
  const pg = await startNav("phone");
  await drive(pg, 0.2, 5);
  await advance(3000);
  pg.navOn = false;
  const mark = pg.heard.length;
  await tap(pg);
  await advance(2000);
  expect("a tap says nothing", since(pg, mark).length === 0, show(since(pg, mark)));
}

console.log("\nThe page wires leaving and coming back");
{
  const start = appSource.indexOf("document.addEventListener(\"visibilitychange\"");
  const handler = start >= 0 ? appSource.slice(start, appSource.indexOf("});", start)) : "";
  expect("hidden drops queued lines", /hushNavVoice\(\)/.test(handler), handler.trim().split("\n")[1] || "");
  expect("visible checks the voice again", /rewarmNavVoice\(\)/.test(handler));
  const shown = appSource.indexOf("window.addEventListener(\"pageshow\"");
  expect("pageshow checks the voice again", shown >= 0 && /rewarmNavVoice\(\)/.test(appSource.slice(shown, appSource.indexOf("});", shown))));
}

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
