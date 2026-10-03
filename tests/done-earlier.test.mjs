// Build #627: picking a stop from Stops while navigating and saying Done marks
// every not-done stop before it done, not only the stop navigation was on.
// Two Walmarts before pilotfue, navigation restarted on the first Walmart, he
// picks pilotfue: "Mark Walmart and Walmart done?", Yes marks both, and they
// stay done after a reload (saved nav progress and the saved trip).
// Not loaded by the site.
// Run: node tests/done-earlier.test.mjs
// Against other copies: APP_JS=/path/to/app.js node tests/done-earlier.test.mjs
//
// The real stop pick and Done (aimNavAtStop, confirmStopSwitch,
// declineStopSwitch, markStopDone, activeNavLeg) and the real saving and
// restoring of done marks (rememberNavProgress, keepDoneOnSavedTrip,
// applyNavProgress) are loaded from js/app.js by name into a vm sandbox, with
// the map and the page stubbed and localStorage faked.

import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appSource = readFileSync(process.env.APP_JS || path.join(root, "js/app.js"), "utf8");
const { isOriginStop } = await import(pathToFileURL(path.join(root, "js/plan.js")).href);

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
  ...["NAV_PROGRESS_KEY", "NAV_PROGRESS_TRIPS"].map(constLine),
  ...[
    // Picking a stop, Done / not done
    "aimNavAtStop", "confirmStopSwitch", "declineStopSwitch", "markStopDone", "activeNavLeg", "navDestList", "pointReady",
    "navStopTitle", "stopHasSavedLeg",
    // Saving the marks, and putting them back after a reload
    "rememberNavProgress", "keepDoneOnSavedTrip", "applyNavProgress", "retargetNavProgress", "nextOpenStopId",
    "tripProgressKey", "readNavRecord", "readNavProgressMap", "writeNavProgressMap", "readNavProgress", "writeNavProgress",
    "clearNavProgress", "readNavSpot", "readLeftLeg", "leftLegKey", "openLeftLeg",
  ].map(extract),
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
const clone = (value) => JSON.parse(JSON.stringify(value));

// Breezewood, PA west to "pilotfue" near Wheeling, with stops in between.
const START = { id: "start", name: "Breezewood", lat: 39.999, lon: -78.240, address: "Breezewood, PA", miles: "", hours: "" };
const CURRENT = { id: "here", name: "Current location", useCurrentLocation: true, lat: 40.0, lon: -78.3, address: "", miles: "", hours: "" };
const stop = (id, name, lat, lon, extra = {}) => ({ id, name, lat, lon, address: name, miles: "40", hours: "0.7", ...extra });
const WALMART_A = stop("walmart-a", "Walmart", 40.047, -79.072);
const WALMART_B = stop("walmart-b", "Walmart", 40.120, -79.550);
const SHEETZ = stop("sheetz", "Sheetz", 40.200, -79.700);
const PILOT = stop("pilotfue", "pilotfue", 40.070, -80.680);
const DONE = { done: true, switched: true, skipRoute: true };

// One page load: fresh module globals, shared localStorage. Navigating, held
// on `aim` (the stop navigation was restarted on).
function page(storage, { stops, trips, aim = "", navOn = true }) {
  const els = {};
  const log = { spoken: [], painted: [], rebuilds: 0, persists: 0 };
  const pg = {
    console, Math, Number, String, JSON, Array, Object, Infinity, NaN, Date, Set, Map, RegExp, Promise, Error, Boolean,
    isOriginStop,
    localStorage: storage,
    log, els,
    document: { getElementById: (id) => (els[id] ||= { id, hidden: true, textContent: "" }), querySelector: () => null },
    window: { clearTimeout: noop, setTimeout: noop },
    state: {
      stops, trips: trips || [{ id: "trip-1", name: "PA run", stops: clone(stops) }], activeTripId: "trip-1",
      origin: { lat: 40.0, lon: -78.3 }, plan: null, driveProgress: null, settings: {}, estimating: false,
    },
    navOn, navFix: null, navLegs: [], navAimStopId: aim, navStopCursor: 0, navStopPicked: false, navGuideFromId: "",
    navStopAwaitNear: false, navStopAnnounce: false, pendingAimId: "", railMenu: "", followPinned: false,
    tripFit: "nextTurn", navFollowing: false, navZoomHold: 0, navReturnTimer: 0, navProgressResume: false,
    tripsSynced: false, liveDrive: null,
    speakNav: (text) => { log.spoken.push(text); },
    paintDoneStop: (id) => { log.painted.push(id); },
    rebuildPlanAfterDone: () => { log.rebuilds += 1; },
    persist: () => { log.persists += 1; },
    savedTripForEditor: () => null,
  };
  for (const name of [
    "paintRailMenus", "paintDirectionToward", "clearDirectionPin", "clearTurnFrame", "showStopNote", "syncRouteChrome",
    "unlockMix", "beginRouteNav", "onNavFix", "paintDrive", "writeTripCache", "uploadPendingTrips",
  ]) pg[name] = noop;
  vm.createContext(pg);
  vm.runInContext(APP_CODE, pg);
  // The nav legs: one per routed stop, on the same stop objects as the trip.
  pg.navLegs = pg.state.stops
    .filter((item, index) => !isOriginStop(pg.state.stops, index) && !item.useCurrentLocation)
    .map((item, index) => ({ stop: item, start: index * 64000, end: (index + 1) * 64000 }));
  if (navOn) pg.rememberNavProgress();
  return pg;
}

const byId = (pg, id) => pg.state.stops.find((item) => item.id === id);
const prompt = (pg) => (pg.els.routeSwitchRow?.hidden === false ? pg.els.routeSwitch?.textContent || "" : "");
const doneIds = (stops) => stops.filter((item) => item.done).map((item) => item.id);
const show = (pg) => `prompt ${JSON.stringify(prompt(pg))}, pending "${pg.pendingAimId}", done [${doneIds(pg.state.stops)}], aim "${pg.navAimStopId}"`;

let failures = 0;
function expect(label, ok, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`);
}

// --- a. The report ---
console.log("a. Trip start, Walmart, Walmart, pilotfue; navigation restarted on the first Walmart; he picks pilotfue");
{
  const storage = fakeStorage();
  const original = [START, WALMART_A, WALMART_B, PILOT];
  const pg = page(storage, { stops: clone(original), aim: "walmart-a" });
  expect("set-up: navigation is on the first Walmart", pg.activeNavLeg()?.stop?.id === "walmart-a", pg.activeNavLeg()?.stop?.id);
  pg.aimNavAtStop("pilotfue");
  expect("picking pilotfue asks \"Mark Walmart and Walmart done?\"",
    prompt(pg) === "Mark Walmart and Walmart done?" && pg.pendingAimId === "pilotfue", show(pg));
  expect("…and says it", pg.log.spoken.at(-1) === "Mark Walmart and Walmart done?", JSON.stringify(pg.log.spoken));
  expect("…nothing is marked yet and navigation is still on the first Walmart",
    doneIds(pg.state.stops).length === 0 && pg.activeNavLeg()?.stop?.id === "walmart-a", show(pg));

  pg.confirmStopSwitch();
  const a = byId(pg, "walmart-a");
  const b = byId(pg, "walmart-b");
  expect("Done: both Walmarts are done", a.done === true && b.done === true, show(pg));
  expect("…both switched and off the route, like a single Done",
    a.switched === true && a.skipRoute === true && b.switched === true && b.skipRoute === true, JSON.stringify([a, b], ["id", "done", "switched", "skipRoute"]));
  expect("…both done cards are painted", pg.log.painted.includes("walmart-a") && pg.log.painted.includes("walmart-b"), JSON.stringify(pg.log.painted));
  expect("…pilotfue is not done", !byId(pg, "pilotfue").done && !byId(pg, "pilotfue").skipRoute, show(pg));
  expect("…the trip start is not marked", !byId(pg, "start").done && !byId(pg, "start").switched, show(pg));
  expect("…navigation is aimed at pilotfue", pg.navAimStopId === "pilotfue" && pg.activeNavLeg()?.stop?.id === "pilotfue" && pg.navStopPicked === true, show(pg));
  expect("…the prompt is gone", pg.els.routeSwitchRow.hidden === true && pg.pendingAimId === "", show(pg));
  expect("…the time chip moves on to pilotfue", pg.state.driveProgress?.stopId === "pilotfue", JSON.stringify(pg.state.driveProgress));
  expect("…the plan is rebuilt once", pg.log.rebuilds === 1, `${pg.log.rebuilds} rebuild(s)`);

  const saved = pg.readNavProgress();
  expect("saved nav progress has both Walmarts done and aims at pilotfue",
    saved && saved.doneIds.includes("walmart-a") && saved.doneIds.includes("walmart-b") && !saved.doneIds.includes("pilotfue")
    && saved.aimId === "pilotfue", JSON.stringify(saved));
  const trip = pg.state.trips[0];
  const savedA = trip.stops.find((item) => item.id === "walmart-a");
  const savedB = trip.stops.find((item) => item.id === "walmart-b");
  expect("the saved trip has both Walmarts done", savedA?.done && savedA.switched && savedA.skipRoute && savedB?.done && savedB.switched && savedB.skipRoute
    && !trip.stops.find((item) => item.id === "pilotfue").done && trip.pendingUpload === true, JSON.stringify(trip.stops, ["id", "done"]));

  // A reload: new page, same storage, the trip's stops as they were before Done.
  const after = page(storage, { stops: clone(original), trips: clone(pg.state.trips), navOn: false });
  after.applyNavProgress();
  expect("after a reload: both Walmarts are still done, pilotfue is not",
    byId(after, "walmart-a").done && byId(after, "walmart-b").done && !byId(after, "pilotfue").done && !byId(after, "start").done,
    `done [${doneIds(after.state.stops)}]`);
  expect("after a reload: navigation aims at pilotfue", after.navAimStopId === "pilotfue", after.navAimStopId);
  const reopened = after.state.trips[0].stops;
  expect("after a reload: the saved trip still has both Walmarts done", doneIds(reopened).join(",") === "walmart-a,walmart-b", `done [${doneIds(reopened)}]`);
}

// --- b. One stop before the one he picks: unchanged ---
console.log("\nb. One not-done stop before pilotfue");
{
  const pg = page(fakeStorage(), { stops: clone([START, WALMART_A, PILOT]), aim: "walmart-a" });
  pg.aimNavAtStop("pilotfue");
  expect("asks \"Is Walmart done?\"", prompt(pg) === "Is Walmart done?" && pg.log.spoken.at(-1) === "Is Walmart done?", show(pg));
  pg.confirmStopSwitch();
  expect("Done: the Walmart is done and navigation is on pilotfue",
    byId(pg, "walmart-a").done && byId(pg, "walmart-a").switched && !byId(pg, "pilotfue").done && pg.navAimStopId === "pilotfue", show(pg));
}

// --- c. Three or more ---
console.log("\nc. Three not-done stops before pilotfue");
{
  const pg = page(fakeStorage(), { stops: clone([START, WALMART_A, WALMART_B, SHEETZ, PILOT]), aim: "walmart-a" });
  pg.aimNavAtStop("pilotfue");
  expect("asks \"Mark 3 earlier stops done?\"", prompt(pg) === "Mark 3 earlier stops done?" && pg.log.spoken.at(-1) === "Mark 3 earlier stops done?", show(pg));
  pg.confirmStopSwitch();
  expect("Done: all three are done, pilotfue is not", doneIds(pg.state.stops).join(",") === "walmart-a,walmart-b,sheetz"
    && pg.navAimStopId === "pilotfue", show(pg));
  expect("…and all three are saved done", ["walmart-a", "walmart-b", "sheetz"].every((id) => pg.readNavProgress()?.doneIds.includes(id)),
    JSON.stringify(pg.readNavProgress()?.doneIds));
}

// --- d. Not done ---
console.log("\nd. He answers not done");
{
  const pg = page(fakeStorage(), { stops: clone([START, WALMART_A, WALMART_B, PILOT]), aim: "walmart-a" });
  pg.aimNavAtStop("pilotfue");
  pg.declineStopSwitch();
  expect("nothing is marked, the prompt is gone, navigation stays on the first Walmart",
    doneIds(pg.state.stops).length === 0 && pg.els.routeSwitchRow.hidden === true && pg.pendingAimId === ""
    && pg.navAimStopId === "walmart-a" && pg.activeNavLeg()?.stop?.id === "walmart-a", show(pg));
  expect("…and nothing is saved done", (pg.readNavProgress()?.doneIds || []).length === 0, JSON.stringify(pg.readNavProgress()));
}

// --- e. He picks the stop navigation is already on ---
console.log("\ne. Navigation is on pilotfue, an earlier Walmart is not done, he picks pilotfue");
{
  const pg = page(fakeStorage(), { stops: clone([START, WALMART_A, { ...WALMART_B, ...DONE }, PILOT]), aim: "pilotfue" });
  pg.aimNavAtStop("pilotfue");
  expect("still asks \"Is Walmart done?\"", prompt(pg) === "Is Walmart done?" && pg.pendingAimId === "pilotfue", show(pg));
  pg.confirmStopSwitch();
  expect("Done: that Walmart is done, pilotfue is not, navigation on pilotfue",
    byId(pg, "walmart-a").done && byId(pg, "walmart-a").switched && !byId(pg, "pilotfue").done && pg.navAimStopId === "pilotfue", show(pg));
}

// --- f. Nothing before it left to mark ---
console.log("\nf. Every stop before pilotfue is done");
{
  const pg = page(fakeStorage(), { stops: clone([START, { ...WALMART_A, ...DONE }, { ...WALMART_B, ...DONE }, PILOT]), aim: "pilotfue" });
  pg.aimNavAtStop("pilotfue");
  expect("no prompt; it heads to pilotfue as before", prompt(pg) === "" && pg.pendingAimId === "" && pg.navStopPicked === true
    && pg.navAimStopId === "pilotfue" && pg.log.spoken.length === 0, show(pg));
  expect("…nothing new is marked", doneIds(pg.state.stops).join(",") === "walmart-a,walmart-b" && pg.log.painted.length === 0, show(pg));
}

// --- g. Picking backward: the stop navigation is on comes after the one he picks ---
console.log("\ng. Navigation is on Sheetz, he picks the Walmart before it");
{
  const pg = page(fakeStorage(), { stops: clone([START, { ...WALMART_A, ...DONE }, WALMART_B, SHEETZ, PILOT]), aim: "sheetz" });
  pg.aimNavAtStop("walmart-b");
  expect("asks \"Is Sheetz done?\" as before", prompt(pg) === "Is Sheetz done?", show(pg));
  pg.confirmStopSwitch();
  expect("Done: Sheetz is done, the Walmart he picked is not, navigation on it",
    byId(pg, "sheetz").done && !byId(pg, "walmart-b").done && !byId(pg, "pilotfue").done && pg.navAimStopId === "walmart-b", show(pg));
}

// --- h. A Current location start ---
console.log("\nh. Current location start, Walmart, Walmart, pilotfue; navigation on the first Walmart; he picks pilotfue");
{
  const pg = page(fakeStorage(), { stops: clone([CURRENT, WALMART_A, WALMART_B, PILOT]), aim: "walmart-a" });
  pg.aimNavAtStop("pilotfue");
  expect("asks \"Mark Walmart and Walmart done?\" (not about Current location)", prompt(pg) === "Mark Walmart and Walmart done?", show(pg));
  pg.confirmStopSwitch();
  expect("Done: both Walmarts are done, Current location is never marked",
    doneIds(pg.state.stops).join(",") === "walmart-a,walmart-b" && !byId(pg, "here").done && !byId(pg, "here").switched && !byId(pg, "here").skipRoute, show(pg));
}

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
