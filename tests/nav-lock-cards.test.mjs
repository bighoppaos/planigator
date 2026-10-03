// While navigating, every stop card control (Paste, arrows, minus, search/choose
// from map, Look up, suggestions, Anytime/Window/Military, the time pickers,
// Add a stop before/after) and the Plan's Possible delay time − and + are
// disabled, aria-disabled, and dimmed. They come back after End navigation,
// except ones that were disabled for their own reason (− at 0 min, + at 24 hr).
// Not loaded by the site. Run: node tests/nav-lock-cards.test.mjs
// Against other copies: APP_JS=/path/to/app.js CSS_FILE=/path/to/styles.css node tests/nav-lock-cards.test.mjs
//
// Renders real stopCard / delayBox markup from js/app.js (by name, into a vm
// sandbox), parses it into a small fake DOM, and runs the real lock routine on
// it. Runs the real edit functions with navOn on. Reads the rules in styles.css.

import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appSource = readFileSync(process.env.APP_JS || path.join(root, "js/app.js"), "utf8");
const cssSource = readFileSync(process.env.CSS_FILE || path.join(root, "styles.css"), "utf8");
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

let failures = 0;
function expect(label, ok, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`);
}

// --- A small DOM: enough HTML parsing and selectors for the lock routine ---

const VOID = new Set(["input", "img", "br", "meta", "link", "hr", "source", "wbr"]);
const camelToData = (key) => `data-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;

class El {
  constructor(tag, attrs = new Map(), parent = null) {
    this.tagName = tag.toLowerCase();
    this.attrs = attrs;
    this.parent = parent;
    this.children = [];
    const el = this;
    this.dataset = new Proxy({}, {
      get: (_, key) => (typeof key === "string" ? el.attrs.get(camelToData(key)) : undefined),
      set: (_, key, value) => { el.attrs.set(camelToData(key), String(value)); return true; },
      deleteProperty: (_, key) => { el.attrs.delete(camelToData(key)); return true; },
      has: (_, key) => el.attrs.has(camelToData(key)),
    });
    this.classList = {
      contains: (name) => el.classes().includes(name),
      add: (name) => { if (!el.classes().includes(name)) el.attrs.set("class", [...el.classes(), name].join(" ")); },
      remove: (name) => el.attrs.set("class", el.classes().filter((c) => c !== name).join(" ")),
      toggle: (name, on = !el.classes().includes(name)) => { if (on) el.classList.add(name); else el.classList.remove(name); return on; },
    };
  }
  classes() { return (this.attrs.get("class") || "").split(/\s+/).filter(Boolean); }
  get id() { return this.attrs.get("id") || ""; }
  get disabled() { return this.attrs.has("disabled"); }
  set disabled(on) { if (on) this.attrs.set("disabled", ""); else this.attrs.delete("disabled"); }
  get inert() { return this.attrs.has("inert"); }
  set inert(on) { if (on) this.attrs.set("inert", ""); else this.attrs.delete("inert"); }
  getAttribute(key) { return this.attrs.has(key) ? this.attrs.get(key) : null; }
  setAttribute(key, value) { this.attrs.set(key, String(value)); }
  removeAttribute(key) { this.attrs.delete(key); }
  hasAttribute(key) { return this.attrs.has(key); }
  *walk() {
    for (const child of this.children) {
      yield child;
      yield* child.walk();
    }
  }
  matches(selector) { return parseSelector(selector).some((chain) => matchChain(this, chain)); }
  closest(selector) {
    for (let node = this; node; node = node.parent) if (node.matches(selector)) return node;
    return null;
  }
  querySelectorAll(selector) {
    const chains = parseSelector(selector);
    return [...this.walk()].filter((el) => chains.some((chain) => matchChain(el, chain)));
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function parseHtml(html) {
  const doc = new El("#document");
  let node = doc;
  const re = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:[^>"]|"[^"]*")*)>|[^<]+/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[1]) {
      const tag = m[1].toLowerCase();
      for (let up = node; up && up !== doc; up = up.parent) {
        if (up.tagName === tag) { node = up.parent; break; }
      }
    } else if (m[2]) {
      const attrs = new Map();
      const body = m[3] || "";
      const attrRe = /([^\s=/"]+)(?:\s*=\s*"([^"]*)")?/g;
      let a;
      while ((a = attrRe.exec(body))) attrs.set(a[1].toLowerCase(), a[2] ?? "");
      const el = new El(m[2], attrs, node);
      node.children.push(el);
      if (!VOID.has(el.tagName) && !/\/\s*$/.test(body)) node = el;
    }
  }
  return doc;
}

function parseCompound(text) {
  const out = { tag: "", ids: [], classes: [], attrs: [], disabled: false };
  const re = /^([a-zA-Z][\w-]*|\*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\]|:disabled/g;
  let m;
  while ((m = re.exec(text))) {
    if (m[0] === ":disabled") out.disabled = true;
    else if (m[1]) out.tag = m[1] === "*" ? "" : m[1].toLowerCase();
    else if (m[2]) out.ids.push(m[2]);
    else if (m[3]) out.classes.push(m[3]);
    else if (m[4]) out.attrs.push([m[4].toLowerCase(), m[5]]);
  }
  return out;
}

function parseSelector(selector) {
  return selector.split(",").map((part) => part.trim().split(/\s+/).map(parseCompound));
}

function matchCompound(el, c) {
  if (!(el instanceof El) || el.tagName === "#document") return false;
  if (c.tag && el.tagName !== c.tag) return false;
  if (c.ids.some((id) => el.id !== id)) return false;
  if (c.classes.some((name) => !el.classes().includes(name))) return false;
  if (c.attrs.some(([key, value]) => !el.attrs.has(key) || (value !== undefined && el.attrs.get(key) !== value))) return false;
  if (c.disabled && !el.disabled) return false;
  return true;
}

function matchChain(el, chain) {
  if (!matchCompound(el, chain[chain.length - 1])) return false;
  let k = chain.length - 2;
  for (let up = el.parent; up && k >= 0; up = up.parent) if (matchCompound(up, chain[k])) k -= 1;
  return k < 0;
}

// --- The page: real stop cards, real delay boxes, and the map buttons ---

const RENDER_CODE = [
  ...["escapeAttr", "stopCard", "delayBox", "delayLabel", "driveDelayAt", "whenRow", "whenBox", "stopCanRemove",
    "pointReady", "lookupMapPreview", "clearTripButton", "tripNameRow", "syncTripNavLocks"].map(extract),
  optional("syncStopCardNavLock"),
  optional("navLockControls"),
].join("\n\n");

const HOUR = 3600 * 1000;
const T0 = Date.UTC(2026, 9, 3, 14, 0);

function trip() {
  return [
    { id: "here", name: "Current location", useCurrentLocation: true },
    // SWFT: first card, so it has Add a stop before. Window, a suggestion, a pin. Delay 0 min (− starts disabled).
    {
      id: "s1", name: "SWFT", address: "100 Swift Rd", lat: 35.1, lon: -90.1, window: true, start: T0, end: T0 + 2 * HOUR,
      suggestions: [{ label: "100 Swift Rd, Memphis, TN", lat: 35.1, lon: -90.1 }], driveDelays: [0],
    },
    // FRANK: Be there by, typed address, 30 min delay.
    { id: "s2", name: "FRANK", address: "9 Frank St", start: T0 + 8 * HOUR, end: T0 + 8 * HOUR, driveDelays: [30] },
    // LAST: delay at 24 hr (+ starts disabled).
    { id: "s3", name: "LAST", address: "1 End Way", lat: 36, lon: -86, start: T0 + 20 * HOUR, end: T0 + 20 * HOUR, driveDelays: [24 * 60] },
  ];
}

function renderer(stops, navOn) {
  const ctx = {
    console, Math, Number, String, JSON, Array, Object, Set, Map, Date,
    navOn,
    state: {
      stops,
      settings: { military: false },
      plan: { events: [] },
      confirmRemoveId: null,
      looking: "",
      signedIn: true,
      lookupStopId: "",
      lookupMessage: "",
      lookupOk: false,
      tripName: "",
      saveNote: "",
    },
    addressEditStarted: true,
    lookupOpen: new Set(stops.map((stop) => stop.id)),
    usingDismissed: new Set(stops.map((stop) => stop.id)),
    isOriginStop: plan.isOriginStop,
    destinations: () => stops.filter((stop) => !stop.useCurrentLocation),
    stopColor: () => [40, 90, 160],
    stopInk: () => ({ color: "#fff" }),
    cssRGB: (rgb) => `rgb(${rgb.join(",")})`,
    cardTitle: (index) => stops[index]?.name || `Stop ${index}`,
    eventsAround: (id) => ({ now: [], before: [], self: { id, stopID: id }, following: [] }),
    chip: (event) => {
      const stop = stops.find((item) => item.id === event.stopID);
      return `<div class="chip-row"><div class="chip drive"></div>${ctx.delayBox(stop, 0)}</div>`;
    },
    donePlanChip: () => "",
    doneStamp: () => "",
    hereLeg: () => "",
    lookupPins: (stop) => (stop.id === "s1" ? [{ lat: 35.1, lon: -90.1, label: "A" }] : []),
    formatUserShort: (ms) => new Date(ms).toISOString(),
    enteredOffset: () => 0,
    document: null,
  };
  vm.createContext(ctx);
  vm.runInContext(RENDER_CODE, ctx);
  // Same pieces as render(): the stops step (cards + Clear/Save) and the Plan with its delay boxes.
  const page = () => {
    const cards = stops.map((stop, index) => (stop.useCurrentLocation ? "" : ctx.stopCard(stop, index, true))).join("");
    const planChips = stops.filter((stop) => !stop.useCurrentLocation).map((stop) => ctx.chip({ stopID: stop.id })).join("");
    return `<main>
      <section class="stops step"><h2>Step 3. Add each stop</h2>${ctx.clearTripButton()}${cards}${ctx.tripNameRow()}</section>
      <section class="step" id="planStep"><h2>Step 4. The plan</h2>${planChips}</section>
      <div class="route-stage" id="routeStage">
        <button type="button" id="routeStops" aria-label="Stops">Stops</button>
        <div id="railStopsMenu"><button type="button" data-aim-stop="s2">FRANK</button><button type="button" data-aim-stop="s3">LAST</button></div>
        <button type="button" id="routeDetour">Detours</button>
        <button type="button" id="routeSwitch">Yes, done</button>
        <button type="button" id="routeSwitchNo">No</button>
        <button type="button" id="routeFollow">Follow me</button>
        <button type="button" id="routeWhole">Turn zoom</button>
        <button type="button" id="routeExit">Exit full</button>
        <button type="button" id="voicePrev">‹</button><button type="button" id="voiceNext">›</button>
        <button type="button" id="endNav">End navigation</button>
        <button type="button" data-dir-stop="s2" data-dir-index="0">Turn right</button>
      </div>
    </main>`;
  };
  const render = () => {
    ctx.document = parseHtml(page());
    chrome();
    return ctx.document;
  };
  // render() ends in bind(), and bind() runs syncRouteChrome(), which runs these two.
  const chrome = () => {
    ctx.syncTripNavLocks();
    if (typeof ctx.syncStopCardNavLock === "function") ctx.syncStopCardNavLock();
  };
  return { ctx, render, chrome };
}

const CARD_CONTROLS = [
  ["↑ (data-act=up)", ".stop-card [data-act=up]"],
  ["↓ (data-act=down)", ".stop-card [data-act=down]"],
  ["− remove (data-act=remove)", ".stop-card [data-act=remove]"],
  ["Paste", ".stop-card [data-act=paste]"],
  ["search/choose from map", ".stop-card [data-act=map]"],
  ["Look up this address", ".stop-card [data-act=lookup]"],
  ["suggestion", ".stop-card [data-suggest]"],
  ["Open map (lookup preview)", ".stop-card [data-open-map]"],
  ["Anytime chip", ".stop-card [data-toggle-field=anytime]"],
  ["Window chip", ".stop-card [data-toggle-field=window]"],
  ["Military chip", ".stop-card [data-toggle-field=military]"],
  ["Opens/Closes/Be there by picker", ".stop-card [data-stop-when]"],
  ["Add a stop after", "[data-after]"],
  ["Add a stop before", "[data-before]"],
  ["Plan / card delay − and +", "[data-delay]"],
];

const NAV_KEEP = ["#routeStops", "[data-aim-stop]", "#routeDetour", "#routeSwitch", "#routeSwitchNo", "#routeFollow",
  "#routeWhole", "#routeExit", "#voicePrev", "#voiceNext", "#endNav", "[data-dir-stop]"];

const describe = (el) => `<${el.tagName} ${[...el.attrs].map(([k, v]) => `${k}="${v}"`).join(" ")}>`;
const allControls = (doc) => CARD_CONTROLS.flatMap(([, sel]) => doc.querySelectorAll(sel));
const disabledKey = (doc) => [...doc.walk()].filter((el) => el.tagName === "button")
  .map((el, i) => `${i}:${el.disabled ? 1 : 0}:${el.getAttribute("aria-disabled") ?? "-"}`).join(",");

// --- a. Locked while navigating, and again after a re-render ---
console.log("a. Locked while navigating");
const live = renderer(trip(), true);
for (const pass of ["first render", "after a re-render"]) {
  const doc = live.render();
  for (const [label, sel] of CARD_CONTROLS) {
    const found = doc.querySelectorAll(sel);
    const open = found.filter((el) => !el.disabled || el.getAttribute("aria-disabled") !== "true");
    expect(`${pass}: ${label} (${found.length}) disabled + aria-disabled="true"`, found.length > 0 && open.length === 0,
      found.length ? open.map(describe).join(" | ") : "none rendered");
  }
  const cardButtons = doc.querySelectorAll(".stop-card button");
  const loose = cardButtons.filter((el) => !el.disabled);
  expect(`${pass}: every button inside every stop card is disabled (${cardButtons.length})`, cardButtons.length > 0 && loose.length === 0, loose.map(describe).join(" | "));
  expect(`${pass}: the stops step has class nav-locked`, doc.querySelector("section.stops")?.classList.contains("nav-locked"));
  const boxes = doc.querySelectorAll(".delay-box");
  expect(`${pass}: every .delay-box (${boxes.length}) has class nav-locked`, boxes.length >= 6 && boxes.every((box) => box.classList.contains("nav-locked")));
  const planDelays = doc.querySelectorAll("#planStep [data-delay]");
  expect(`${pass}: the Plan's own delay buttons (${planDelays.length}) are disabled`, planDelays.length >= 6 && planDelays.every((el) => el.disabled));
}
{
  const lockSrc = optional("syncStopCardNavLock");
  const chromeSrc = extract("syncRouteChrome");
  const bindSrc = extract("bind");
  const patchSrc = extract("patchPlanAfterDone");
  expect("syncRouteChrome runs the lock (bind() runs syncRouteChrome on every render)", Boolean(lockSrc) && /syncStopCardNavLock\(\)/.test(chromeSrc) && /syncRouteChrome\(\)/.test(bindSrc));
  expect("patchPlanAfterDone (new Plan chips mid-drive) runs the lock again", /syncStopCardNavLock\(\)/.test(patchSrc));
  expect("beginRouteNav and endRouteNav both run syncRouteChrome", /syncRouteChrome\(\)/.test(extract("beginRouteNav")) && /syncRouteChrome\(\)/.test(extract("endRouteNav")));
}

// --- b. Unlocked after navigation ends ---
console.log("\nb. Unlocked after End navigation");
{
  const { ctx, render, chrome } = renderer(trip(), true);
  const doc = render();
  // A stop marked done mid-drive: paintDoneStop disables and inerts that card's buttons.
  const doneButton = doc.querySelector('[data-stop="s2"] [data-act=paste]');
  doneButton.disabled = true;
  doneButton.inert = true;
  // endRouteNav: navOn = false, then syncRouteChrome() on the same page (no re-render).
  ctx.navOn = false;
  chrome();
  const fresh = renderer(trip(), false).render();
  // Ignore the done-mid-drive card when comparing with a fresh page.
  doneButton.disabled = false;
  doneButton.inert = false;
  expect("every button is back to exactly how a page with navigation off draws it", disabledKey(doc) === disabledKey(fresh));
  doneButton.disabled = true;
  doneButton.inert = true;
  const minus = doc.querySelector('[data-delay="s1"][data-delay-by="-15"]');
  const plus = doc.querySelector('[data-delay="s3"][data-delay-by="15"]');
  const upFirst = doc.querySelector('[data-stop="s1"] [data-act=up]');
  expect("delay − at 0 min stays disabled", minus?.disabled === true);
  expect("delay + at 24 hr stays disabled", plus?.disabled === true);
  expect("the first stop's ↑ stays disabled", upFirst?.disabled === true);
  const live2 = ["[data-act=paste]", "[data-act=map]", "[data-toggle-field=anytime]", "[data-after]", "[data-before]", '[data-delay="s2"]']
    .flatMap((sel) => doc.querySelectorAll(sel)).filter((el) => el !== doneButton);
  expect(`Paste, map, chips, Add a stop, and a mid delay are enabled again (${live2.length})`, live2.length > 0 && live2.every((el) => !el.disabled), live2.filter((el) => el.disabled).map(describe).join(" | "));
  const aria = [...doc.walk()].filter((el) => el.hasAttribute("aria-disabled"));
  expect("no aria-disabled is left behind", aria.length === 0, aria.map(describe).join(" | "));
  const tags = [...doc.walk()].filter((el) => el.hasAttribute("data-nav-lock") || el.hasAttribute("data-nav-aria"));
  expect("no lock markers are left behind", tags.length === 0, tags.map(describe).join(" | "));
  expect("nav-locked is off the stops step and every delay box",
    !doc.querySelector("section.stops")?.classList.contains("nav-locked") && doc.querySelectorAll(".delay-box").every((box) => !box.classList.contains("nav-locked")));
  expect("a stop marked done mid-drive keeps its disabled buttons", doneButton.disabled === true);
  expect("app.js has syncStopCardNavLock", Boolean(optional("syncStopCardNavLock")));
}

// --- c. Edits do nothing while navigating ---
console.log("\nc. Edits refused while navigating");

const EDIT_FUNCTIONS = ["changeDelay", "addStop", "addStopBefore", "removeStop", "moveStop", "pasteAddress", "applyStopPaste",
  "chooseSuggestion", "lookupAddress", "openChooseMap", "applyMapHit", "useChosenSpot", "writeStopWhen"];
const EDIT_CODE = [
  ...EDIT_FUNCTIONS.map(extract),
  ...["stopCanRemove", "pointReady", "driveDelayAt"].map(extract),
  ...["delaySum", "clearLaterDelays"].map(optional),
].join("\n\n");

function editor(navOn) {
  const stops = trip();
  const counts = { persist: 0, render: 0, calculate: 0, updateStop: 0, lookups: 0, clipboard: 0, fix: 0 };
  const ctx = {
    console, Math, Number, String, JSON, Array, Object, Set, Map, Date, Promise,
    navOn,
    state: {
      estimating: false, stops, settings: { military: false }, plan: { events: [] }, openLookupStopId: "s2",
      signedIn: true, unlimited: true, credits: 10, picker: "stopTime", pickerTarget: { id: "s2", field: "start" },
    },
    chooseMap: false, mapSpot: { lat: 1, lon: 2 }, mapChosenHit: null, mapQuery: "", mapSearchHits: [], mapSearchNote: "",
    mapSearching: false, chooseHere: null, mapPickMarker: null,
    isOriginStop: plan.isOriginStop,
    defaultStop: () => ({ id: `new${stops.length}`, name: "", address: "", start: T0, end: T0 }),
    clockOffset: (value) => value || 0,
    clearDriveProgress() {},
    stopHasSavedLeg: () => false,
    persist() { counts.persist += 1; },
    render() { counts.render += 1; },
    calculate() { counts.calculate += 1; return Promise.resolve(); },
    updateStop(id, patch) { counts.updateStop += 1; Object.assign(stops.find((s) => s.id === id) || {}, patch); },
    positionForArrival: () => Promise.resolve(null),
    arrivedAtRemovedStop: () => false,
    refreshAfterStopRemoved() {},
    navStopTitle: (stop) => stop?.name || "",
    setLookupMessage() {},
    clearLookupMessage() {},
    clearUsingNote() {},
    parseStopPaste: () => ({ address: "77 Pasted Ave", anytime: true, hadWhen: false }),
    placeholderStopName: () => false,
    clipStopName: (name) => name,
    pastedInstant: () => ({ ms: T0, offset: 0 }),
    pasteNote: () => "",
    suggestAddresses: () => { counts.lookups += 1; return Promise.resolve({ items: [] }); },
    currentFix: () => { counts.fix += 1; return Promise.resolve(null); },
    spotAddress: () => Promise.resolve({ label: "Spot" }),
    pinLabel: (text) => text,
    lookupOpen: new Set(),
    pickerStop: () => stops.find((s) => s.id === "s2"),
    enteredOffset: () => 0,
    navigator: { clipboard: { readText: () => { counts.clipboard += 1; return Promise.resolve("77 Pasted Ave"); } } },
    document: { activeElement: null, body: {}, querySelector: () => null },
    window: { scrollX: 0, scrollY: 0, scrollTo() {} },
    requestAnimationFrame() {},
  };
  vm.createContext(ctx);
  vm.runInContext(EDIT_CODE, ctx);
  return { ctx, stops, counts };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const EDITS = [
  ["changeDelay + on FRANK", (c) => c.changeDelay("s2", 0, 15)],
  ["changeDelay − on FRANK", (c) => c.changeDelay("s2", 0, -15)],
  ["Add a stop after SWFT", (c) => c.addStop("s1")],
  ["Add a stop before SWFT", (c) => c.addStopBefore("s1")],
  ["remove FRANK", (c) => c.removeStop("s2")],
  ["move FRANK up", (c) => c.moveStop("s2", -1)],
  ["move FRANK down", (c) => c.moveStop("s2", 1)],
  ["Paste on FRANK", (c) => c.pasteAddress("s2")],
  ["paste text into FRANK", (c) => c.applyStopPaste("s2", "77 Pasted Ave")],
  ["choose SWFT's suggestion", (c) => c.chooseSuggestion("s1", 0)],
  ["Look up FRANK", (c) => c.lookupAddress("s2")],
  ["search/choose from map on FRANK", (c) => c.openChooseMap("s2")],
  ["tap a map search pin", (c) => c.applyMapHit({ lat: 1, lon: 2, label: "Pin" })],
  ["Use this spot", (c) => c.useChosenSpot()],
  ["Opens/Closes picker Done", (c) => c.writeStopWhen(T0 + 99 * HOUR)],
];

for (const [label, run] of EDITS) {
  const { ctx, counts } = editor(true);
  const before = JSON.stringify(ctx.state.stops);
  let error = "";
  try {
    await run(ctx);
    await settle();
  } catch (err) {
    error = String(err?.message || err);
  }
  const changed = JSON.stringify(ctx.state.stops) !== before;
  const side = counts.persist + counts.calculate + counts.updateStop + counts.lookups + counts.clipboard + counts.fix;
  expect(`navOn: ${label} changes nothing (no edit, no persist, no recalc)`, !error && !changed && side === 0,
    error || `stops changed: ${changed}, ${JSON.stringify(counts)}`);
}
for (const [label, run] of EDITS.slice(0, 7)) {
  const { ctx } = editor(false);
  const before = JSON.stringify(ctx.state.stops);
  let error = "";
  try {
    await run(ctx);
    await settle();
  } catch (err) {
    error = String(err?.message || err);
  }
  expect(`navigation off: ${label} still edits`, !error && JSON.stringify(ctx.state.stops) !== before, error);
}
{
  const bindSrc = extract("bind");
  const guarded = (marker) => {
    const at = bindSrc.indexOf(marker);
    if (at < 0) return false;
    const body = bindSrc.slice(at, at + 400);
    return /addEventListener\("click", \(\) => \{\s*if \(navOn\) return;/.test(body);
  };
  expect("the − remove click handler refuses while navOn (no Remove arming)", guarded('card.querySelector("[data-act=remove]")'));
  expect("the Opens/Closes picker click handler refuses while navOn", guarded('card.querySelectorAll("[data-stop-when]")'));
  expect("the Anytime/Window/Military click handler refuses while navOn", guarded('card.querySelectorAll("[data-toggle-field]")'));
  expect("the Open map click handler refuses while navOn", guarded('document.querySelectorAll("[data-open-map]")'));
}

// --- d. CSS ---
console.log("\nd. CSS");

function parseCss(source) {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [];
  const walk = (body, media) => {
    let i = 0;
    while (i < body.length) {
      const open = body.indexOf("{", i);
      if (open < 0) break;
      const head = body.slice(i, open).trim();
      let depth = 1;
      let j = open + 1;
      while (j < body.length && depth) {
        if (body[j] === "{") depth += 1;
        else if (body[j] === "}") depth -= 1;
        j += 1;
      }
      const inner = body.slice(open + 1, j - 1);
      if (head.startsWith("@")) {
        if (/^@(media|supports|layer|container)/.test(head)) walk(inner, `${media}${head.replace(/\s+/g, " ")} `);
      } else {
        const decls = new Map();
        for (const part of inner.split(";")) {
          const colon = part.indexOf(":");
          if (colon < 0) continue;
          decls.set(part.slice(0, colon).trim().toLowerCase(), part.slice(colon + 1).trim().replace(/\s+/g, " "));
        }
        for (const selector of head.split(",").map((s) => s.trim().replace(/\s+/g, " ")).filter(Boolean)) {
          rules.push({ media: media.trim(), selector, decls });
        }
      }
      i = j;
    }
  };
  walk(text, "");
  return rules;
}

function specificity(selector) {
  const s = selector.replace(/::?[\w-]+\([^)]*\)/g, (m) => (m.startsWith(":not(") ? m.slice(5, -1) : ""));
  const ids = (s.match(/#[\w-]+/g) || []).length;
  const classes = (s.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g) || []).length;
  const tags = (s.replace(/#[\w-]+|\.[\w-]+|\[[^\]]+\]|:[\w-]+/g, " ").match(/(^|[\s>+~])[a-zA-Z][\w-]*/g) || []).length;
  return ids * 10000 + classes * 100 + tags;
}

const rules = parseCss(cssSource);
const opacityOf = (rule) => Number.parseFloat(rule?.decls.get("opacity"));
const lockRule = (pattern) => rules.filter((r) => !r.media && /\.nav-locked\b/.test(r.selector) && pattern.test(r.selector)
  && opacityOf(r) <= 0.45 && r.decls.get("cursor") === "not-allowed");

const TARGETS = [
  ["a locked stop card button", /\.stop-card button:disabled$/, /^(button(:disabled)?|\.stop-card .*button.*|.*\.(flag-box|ghost|suggest|lookup)\b.*)$/],
  ["a locked stop card select", /\.stop-card select:disabled$/, /^(select(:disabled)?)$/],
  ["a locked Add a stop after", /button\[data-after\](:disabled)?$/, /^(button(:disabled)?|.*\.flag-box\b.*)$/],
  ["a locked Add a stop before", /button\[data-before\](:disabled)?$/, /^(button(:disabled)?|.*\.flag-box\b.*)$/],
  ["a locked delay − / + button", /\.delay-box\.nav-locked button$/, /^(button(:disabled)?|.*\.delay-(box|controls)\b.*button.*)$/],
  ["a locked delay − at 0 (already disabled)", /\.delay-box\.nav-locked button(:disabled)?$/, /^(button:disabled|.*\.delay-(box|controls)\b.*button.*)$/],
  ["the locked delay value (.delay-read)", /\.delay-box\.nav-locked \.delay-read$/, /^(.*\.delay-read)$/],
];
for (const [label, pattern, rivalPattern] of TARGETS) {
  const mine = lockRule(pattern);
  const best = Math.max(-1, ...mine.map((r) => specificity(r.selector)));
  expect(`${label}: opacity <= 0.45 and cursor: not-allowed`, mine.length > 0, mine.map((r) => r.selector).join(", ") || "no rule");
  const rivals = rules.filter((r) => !/\.nav-locked\b/.test(r.selector) && rivalPattern.test(r.selector)
    && !/prefers-reduced-motion/.test(r.media)
    && ((r.decls.has("opacity") && !(opacityOf(r) <= 0.45)) || (r.decls.has("cursor") && r.decls.get("cursor") !== "not-allowed")
      || /!important/.test([...r.decls.values()].join(";")))
    && specificity(r.selector) >= best);
  expect(`${label}: no other rule overrides it`, mine.length > 0 && rivals.length === 0,
    rivals.map((r) => `${r.media} ${r.selector} {opacity: ${r.decls.get("opacity")}; cursor: ${r.decls.get("cursor")}}`).join(" | "));
}
{
  const delayButton = rules.filter((r) => r.selector === ".delay-box button" && !r.media);
  const mine = lockRule(/\.delay-box\.nav-locked button$/);
  expect(".delay-box button still exists and loses to the locked rule",
    delayButton.length > 0 && mine.length > 0 && mine.every((r) => specificity(r.selector) > specificity(".delay-box button")));
  const themed = rules.filter((r) => /\.nav-locked\b/.test(r.selector) && /(dark|light)/i.test(`${r.media} ${r.selector}`));
  expect("the dim is opacity only, so Light and Dark both dim (no theme-only lock rule)", themed.length === 0, themed.map((r) => r.selector).join(", "));
}

// --- e. The map's Stops / done / next-stop path still works ---
console.log("\ne. Stops button and done / next stop still work");
{
  const doc = live.render();
  for (const sel of NAV_KEEP) {
    const found = doc.querySelectorAll(sel);
    const bad = found.filter((el) => el.disabled || el.hasAttribute("aria-disabled"));
    expect(`navOn: ${sel} is not disabled`, found.length > 0 && bad.length === 0, bad.map(describe).join(" | "));
  }
  const bindSrc = extract("bind");
  expect("#routeStops still opens the stops menu", /\$\("#routeStops"\)\?\.addEventListener\("click", \(\) => toggleRailMenu\("stops"\)\)/.test(bindSrc));
  expect("tapping a stop in that menu still aims at it", /closest\("\[data-aim-stop\]"\)[\s\S]{0,80}aimNavAtStop\(/.test(bindSrc));
  const blocked = ["addStop", "addStopBefore", "removeStop", "moveStop", "pasteAddress", "applyStopPaste", "chooseSuggestion",
    "lookupAddress", "openChooseMap", "changeDelay", "writeStopWhen", "applyMapHit", "useChosenSpot"];
  for (const name of ["paintStopButton", "aimNavAtStop", "confirmStopSwitch", "declineStopSwitch", "markStopDone", "paintDoneStop",
    "rebuildPlanAfterDone", "patchPlanAfterDone", "patchPlanOnCards", "toggleRailMenu"]) {
    if (!find(name)) {
      expect(`${name} exists`, false);
      continue;
    }
    const src = extract(name);
    const calls = blocked.filter((fn) => new RegExp(`\\b${fn}\\(`).test(src.slice(src.indexOf("{"))));
    const refuses = /if \(navOn\) return;|if \([^)]*\bnavOn\)\s*return/.test(src);
    expect(`${name} does not call a locked edit and does not refuse while navOn`, calls.length === 0 && !refuses, calls.join(", ") || (refuses ? "refuses while navOn" : ""));
  }
  // Run the real markStopDone while navigating.
  const ctx = {
    console, Math, Number, Array, Date,
    navOn: true,
    state: { stops: trip().map((stop) => ({ ...stop, miles: 10, hours: 1 })), driveProgress: null },
    isOriginStop: plan.isOriginStop,
    stopHasSavedLeg: (stop) => Number(stop?.miles) > 0,
    paintDoneStop() {}, rebuildPlanAfterDone() {}, paintDirectionToward() {}, rememberNavProgress() {}, keepDoneOnSavedTrip() {}, paintDrive() {},
  };
  vm.createContext(ctx);
  vm.runInContext(extract("markStopDone"), ctx);
  const s1 = ctx.state.stops.find((stop) => stop.id === "s1");
  ctx.markStopDone(s1, { switched: true });
  expect("navOn: markStopDone still marks the stop done and moves to the next stop",
    s1.done === true && s1.skipRoute === true && ctx.state.driveProgress?.stopId === "s2", JSON.stringify(ctx.state.driveProgress));
}

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
