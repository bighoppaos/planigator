// Changing a Possible delay time on a drive card sets every LATER drive card's
// delay in that trip back to 0. Earlier cards keep theirs. Cards run in
// state.stops order: each stop's drive pieces, then that stop's finish card.
// Not loaded by the site. Run: node tests/delay-reset-later.test.mjs
// Against another copy: APP_JS=/path/app.js node tests/delay-reset-later.test.mjs
//
// Loads the real changeDelay, driveDelayAt, persist and settingsForSave from
// js/app.js (by name, into a vm sandbox) with the DOM and localStorage stubbed,
// and isOriginStop from js/plan.js.

import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appSource = readFileSync(process.env.APP_JS || path.join(root, "js/app.js"), "utf8");
const plan = await import(pathToFileURL(path.join(root, "js/plan.js")).href);

function find(name) {
  return new RegExp(`^(?:async\\s+)?function\\s+${name}\\s*\\(`, "m").exec(appSource);
}

function extract(name) {
  const head = find(name);
  if (!head) throw new Error(`app.js has no function ${name}`);
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

// Not in the old pages. They run without them, so this test can show them failing.
const optional = (name) => (find(name) ? extract(name) : "");

const APP_CODE = [
  ...["changeDelay", "driveDelayAt", "persist", "settingsForSave"].map(extract),
  ...["delaySum", "clearLaterDelays"].map(optional),
].join("\n\n");

const STORAGE = "planigator-test";
const MAX = 24 * 60;

// Origin, stop 1 (one drive), stop 2 (two drive pieces), stop 3 (one drive) + finish.
function trip({ midFinish = 0 } = {}) {
  return [
    { id: "here", name: "Current location", useCurrentLocation: true },
    { id: "s1", name: "One", driveDelays: [30], delayMinutes: 30 },
    { id: "s2", name: "Two", driveDelays: [45, 60], delayMinutes: 105, ...(midFinish ? { finishDelayMinutes: midFinish } : {}) },
    { id: "s3", name: "Three", driveDelays: [15], delayMinutes: 15, finishDelayMinutes: 90 },
  ];
}

function page(stops = trip()) {
  const store = new Map();
  const counts = { persist: 0, calculate: 0, render: 0 };
  const sandbox = {
    console,
    Math,
    Number,
    JSON,
    Array,
    Promise,
    STORAGE,
    isOriginStop: plan.isOriginStop,
    normalizeTransportMode: (mode) => mode || "truck",
    slimPlan: (p) => p,
    localStorage: {
      setItem(key, value) { store.set(key, String(value)); },
      getItem(key) { return store.has(key) ? store.get(key) : null; },
    },
    document: { activeElement: null, body: {} },
    window: { scrollX: 0, scrollY: 0, scrollTo() {} },
    requestAnimationFrame() {},
    render() { counts.render += 1; },
    calculate() { counts.calculate += 1; return Promise.resolve(); },
    navOn: false,
    state: {
      estimating: false,
      settings: {},
      stops,
      tripName: "Test",
      activeTripId: null,
      trips: [],
      origin: null,
      plan: { events: [] },
      driveProgress: null,
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(APP_CODE, sandbox);
  // Counts the real persist, which writes localStorage.
  const realPersist = sandbox.persist;
  sandbox.persist = () => { counts.persist += 1; realPersist(); };
  return { sb: sandbox, stops, store, counts };
}

// Every drive card in trip order: [label, minutes].
function cards(stops) {
  const out = [];
  stops.forEach((stop, index) => {
    if (plan.isOriginStop(stops, index)) return;
    const list = Array.isArray(stop.driveDelays) ? stop.driveDelays : [stop.delayMinutes || 0];
    list.forEach((mins, k) => out.push([`${stop.id}#${k}`, Math.round(Number(mins) || 0)]));
    if (stop.finishDelayMinutes != null) out.push([`${stop.id}:finish`, Math.round(Number(stop.finishDelayMinutes) || 0)]);
  });
  return out;
}
const show = (stops) => cards(stops).map(([label, mins]) => `${label}=${mins}`).join(" ");
const sum = (list) => (list || []).reduce((total, mins) => total + Math.max(0, Math.round(Number(mins) || 0)), 0);

let failures = 0;
function expect(label, ok, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`);
}

function sumsHold(tag, stops) {
  const bad = stops.filter((stop, index) => !plan.isOriginStop(stops, index) && Array.isArray(stop.driveDelays)
    && Math.round(Number(stop.delayMinutes) || 0) !== sum(stop.driveDelays));
  expect(`${tag} e. delayMinutes = sum(driveDelays) on every stop`, bad.length === 0,
    bad.map((stop) => `${stop.id} ${stop.delayMinutes} vs ${sum(stop.driveDelays)}`).join(", "));
}

function savedHolds(tag, store, want) {
  const saved = JSON.parse(store.get(STORAGE) || "null");
  expect(`${tag} f. persisted stops have the reset values`, Boolean(saved) && show(saved.stops) === want,
    saved ? show(saved.stops) : "nothing written");
}

// a. + on stop 2 piece 0.
{
  const { sb, stops, store, counts } = page();
  sb.changeDelay("s2", 0, 15, false);
  const want = "s1#0=30 s2#0=60 s2#1=0 s3#0=0 s3:finish=0";
  expect("a. + on stop 2 piece 0: 60, later cards 0, stop 1 kept", show(stops) === want, show(stops));
  expect("a. persist once, calculate once", counts.persist === 1 && counts.calculate === 1,
    `persist ${counts.persist}, calculate ${counts.calculate}`);
  sumsHold("a.", stops);
  savedHolds("a.", store, want);
}

// b. − on stop 1.
{
  const { sb, stops, store } = page();
  sb.changeDelay("s1", 0, -15, false);
  const want = "s1#0=15 s2#0=0 s2#1=0 s3#0=0 s3:finish=0";
  expect("b. − on stop 1: 15, every later card 0", show(stops) === want, show(stops));
  expect("b. stop 2 legacy delayMinutes is 0", stops[2].delayMinutes === 0, String(stops[2].delayMinutes));
  sumsHold("b.", stops);
  savedHolds("b.", store, want);
}

// a2. + on stop 2 piece 1 keeps stop 2 piece 0 (an earlier piece of the same stop).
{
  const { sb, stops, store } = page();
  sb.changeDelay("s2", 1, 15, false);
  const want = "s1#0=30 s2#0=45 s2#1=75 s3#0=0 s3:finish=0";
  expect("a2. + on stop 2 piece 1: piece 0 kept, later 0", show(stops) === want, show(stops));
  sumsHold("a2.", stops);
  savedHolds("a2.", store, want);
}

// c. + on the finish card.
{
  const { sb, stops, store, counts } = page();
  sb.changeDelay("s3", 0, 15, true);
  const want = "s1#0=30 s2#0=45 s2#1=60 s3#0=15 s3:finish=105";
  expect("c. + on finish: only finish changes", show(stops) === want, show(stops));
  expect("c. persist once, calculate once", counts.persist === 1 && counts.calculate === 1,
    `persist ${counts.persist}, calculate ${counts.calculate}`);
  sumsHold("c.", stops);
  savedHolds("c.", store, want);
}

// d. Presses that change nothing reset nothing.
{
  const stops = trip();
  stops[1].driveDelays = [0];
  stops[1].delayMinutes = 0;
  const { sb, store, counts } = page(stops);
  const before = show(stops);
  sb.changeDelay("s1", 0, -15, false);
  expect("d. − at 0 resets nothing", show(stops) === before, show(stops));
  stops[2].driveDelays = [MAX, 60];
  stops[2].delayMinutes = MAX + 60;
  const atMax = show(stops);
  sb.changeDelay("s2", 0, 15, false);
  expect("d. + at 24 h resets nothing", show(stops) === atMax, show(stops));
  stops[3].finishDelayMinutes = MAX;
  const finishMax = show(stops);
  sb.changeDelay("s3", 0, 15, true);
  expect("d. + at 24 h on finish resets nothing", show(stops) === finishMax, show(stops));
  expect("d. no persist / calculate on a no-op press", counts.persist === 0 && counts.calculate === 0 && !store.size,
    `persist ${counts.persist}, calculate ${counts.calculate}`);
}

// g. A finish card mid-trip (stop 2) sits after stop 2's drives and before stop 3's.
{
  const { sb, stops, store } = page(trip({ midFinish: 20 }));
  sb.changeDelay("s2", 1, -15, false);
  expect("g. − on stop 2 piece 1 clears stop 2's own finish and later",
    show(stops) === "s1#0=30 s2#0=45 s2#1=45 s2:finish=0 s3#0=0 s3:finish=0", show(stops));
  savedHolds("g.", store, "s1#0=30 s2#0=45 s2#1=45 s2:finish=0 s3#0=0 s3:finish=0");
  const mid = page(trip({ midFinish: 20 }));
  mid.sb.changeDelay("s2", 0, 15, true);
  expect("g. + on stop 2's finish keeps stop 2's drives, clears stop 3",
    show(mid.stops) === "s1#0=30 s2#0=45 s2#1=60 s2:finish=35 s3#0=0 s3:finish=0", show(mid.stops));
  sumsHold("g.", mid.stops);
}

// h. Legacy stop (delayMinutes only, no driveDelays) after the changed card goes to 0.
{
  const stops = trip();
  delete stops[3].driveDelays;
  stops[3].delayMinutes = 40;
  const { sb } = page(stops);
  sb.changeDelay("s1", 0, 15, false);
  expect("h. later legacy delayMinutes -> 0", stops[3].delayMinutes === 0 && stops[3].finishDelayMinutes === 0,
    `delayMinutes ${stops[3].delayMinutes}, finish ${stops[3].finishDelayMinutes}`);
  expect("h. stop 1 legacy piece 0 changed", stops[1].driveDelays[0] === 45, String(stops[1].driveDelays[0]));
}

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
