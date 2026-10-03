// While navigating, the saved trips' Delete (both taps), Load, Clear trip, and
// Save, and every control in "Choose where the trip starts" and "Set speed,
// hours, and when you leave" (Step 1 and Step 2 on the home page, whatever
// numbers other layouts give them) are disabled, aria-disabled, dimmed, and do
// nothing. They come back after End navigation, except ones disabled for their
// own reason (#locate while waiting for permission, a Delete already deleting).
// Not loaded by the site. Run: node tests/nav-lock-steps.test.mjs
// Against other copies: APP_JS=/path/to/app.js CSS_FILE=/path/to/styles.css node tests/nav-lock-steps.test.mjs
//
// Renders the real arrangedPage() (every layout, signed in and out) from
// js/app.js in a vm sandbox, parses it into a small fake DOM, and runs the real
// lock routines, click handlers, and picker code on it. Reads styles.css and
// works out the winning opacity / cursor for the rendered buttons.

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

// From `from` (an opening bracket), the index just past its matching close.
// Only the given bracket kinds count, so regex literals in a body do not.
// Template literals are walked with their ${...} parts, which nest.
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

function extractConst(name) {
  const head = new RegExp(`^const ${name} = `, "m").exec(appSource);
  if (!head) throw new Error(`app.js has no const ${name}`);
  const end = skipBalanced(appSource, head.index + head[0].length);
  return `var ${appSource.slice(head.index + 6, end)};`;
}

// One statement inside bind(), e.g. the [data-delete] forEach.
function bindStatement(marker) {
  const src = extract("bind");
  const at = src.indexOf(marker);
  if (at < 0) throw new Error(`bind() has no ${marker}`);
  const end = skipBalanced(src, src.indexOf("(", at + marker.length - 1), "(", ")");
  return src.slice(at, end) + ";";
}

// Not in the old pages. They run without them, so this test can show them failing.
const optional = (name) => (find(name) ? extract(name) : "");

let failures = 0;
function expect(label, ok, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`);
}

// --- A small DOM: HTML parsing, selectors, text, and click handlers ---

const VOID = new Set(["input", "img", "br", "meta", "link", "hr", "source", "wbr"]);
const camelToData = (key) => `data-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;

class El {
  constructor(tag, attrs = new Map(), parent = null) {
    this.tagName = tag.toLowerCase();
    this.attrs = attrs;
    this.parent = parent;
    this.children = [];
    this.text = "";
    this.handlers = {};
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
  get parentElement() { return this.parent?.tagName === "#document" ? null : this.parent; }
  get textContent() { return this.text + this.children.map((c) => c.textContent).join(""); }
  getAttribute(key) { return this.attrs.has(key) ? this.attrs.get(key) : null; }
  setAttribute(key, value) { this.attrs.set(key, String(value)); }
  removeAttribute(key) { this.attrs.delete(key); }
  hasAttribute(key) { return this.attrs.has(key); }
  addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); }
  fire(type) { for (const fn of this.handlers[type] || []) fn({ target: this, currentTarget: this, preventDefault() {} }); }
  scrollIntoView() {}
  *walk() {
    for (const child of this.children) {
      yield child;
      yield* child.walk();
    }
  }
  matches(selector) { return parseSelector(selector).some((chain) => matchChain(this, chain)); }
  closest(selector) {
    for (let node = this; node && node.tagName !== "#document"; node = node.parent) if (node.matches(selector)) return node;
    return null;
  }
  querySelectorAll(selector) {
    const chains = parseSelector(selector);
    return [...this.walk()].filter((el) => chains.some((chain) => matchChain(el, chain)));
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  getElementById(id) { return [...this.walk()].find((el) => el.id === id) || null; }
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
    } else if (!m[0].startsWith("<!--")) {
      node.text += m[0];
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

// --- The page: the real arrangedPage() with the real blocks it builds ---

const HOUR = 3600 * 1000;
const T0 = Date.UTC(2026, 9, 3, 14, 0);

function trip() {
  return [
    { id: "here", name: "Current location", useCurrentLocation: true, lat: 35, lon: -90 },
    { id: "s1", name: "SWFT", address: "100 Swift Rd", lat: 35.1, lon: -90.1, start: T0, end: T0 + 2 * HOUR, driveDelays: [0] },
    { id: "s2", name: "FRANK", address: "9 Frank St", start: T0 + 8 * HOUR, end: T0 + 8 * HOUR, driveDelays: [30] },
  ];
}

function settings() {
  return {
    governed: true, governedMph: 65, leaveNow: false, leaveAt: T0, leaveAtOffset: 0, startAnytime: false, startMinutes: 360,
    endAnytime: false, endMinutes: 1200, military: false, kilometers: false, hoursOfEleven: 11, hoursBeforeThirty: 8, routeMode: "fast",
  };
}

const PAGE_CODE = [
  extractConst("ARRANGEMENTS"),
  extractConst("HOME_LAYOUT"),
  ...["arrangedPage", "arrangeBar", "escapeAttr", "settingToggle", "settingValue", "thirtyLabel", "clearTripButton", "tripNameRow",
    "savedTripsBlock", "authBlock", "exampleBlock", "stopCard", "delayBox", "delayLabel", "driveDelayAt", "whenRow", "whenBox",
    "stopCanRemove", "pointReady", "lookupMapPreview", "syncTripNavLocks", "syncStopCardNavLock"].map(extract),
  optional("syncStepNavLock"),
  optional("navLockControls"),
].join("\n\n");

const LAYOUT_IDS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const layoutName = (id) => (id ? `arrange-${id}` : "home");

// Nav controls the map step draws (planBox is not under test here).
const NAV_STAGE = `<div class="route-stage" id="routeStage">
  <button type="button" id="routeStops" aria-label="Stops">Stops</button>
  <div id="railStopsMenu"><button type="button" data-aim-stop="s2">FRANK</button></div>
  <button type="button" id="routeDetour">Detours</button>
  <button type="button" id="routeRecalc">Recalculate</button>
  <button type="button" id="routeSwitch">Yes, done</button>
  <button type="button" id="routeSwitchNo">No</button>
  <button type="button" id="routeFollow">Follow me</button>
  <button type="button" id="routeWhole">Turn zoom</button>
  <button type="button" id="routeZoomIn">+</button><button type="button" id="routeZoomOut">−</button>
  <button type="button" id="routeCompass">N</button>
  <button type="button" id="routeExit">Exit full</button>
  <button type="button" id="voicePrev">‹</button><button type="button" id="voiceNext">›</button>
  <button type="button" id="endNav">End navigation</button>
</div>`;

function renderer({ navOn = true, signedIn = true, id = 0, locating = false, chooseStart = false } = {}) {
  const stops = trip();
  const ctx = {
    console, Math, Number, String, JSON, Array, Object, Set, Map, Date,
    navOn,
    state: {
      stops, settings: settings(), plan: { events: [] }, confirmRemoveId: null, looking: "", signedIn,
      lookupStopId: "", lookupMessage: "", lookupOk: false, tripName: "", saveNote: "",
      trips: [{ id: "t1", name: "Memphis run", savedAt: T0 }, { id: "t2", name: "Dallas run", savedAt: T0 }],
      activeTripId: "t1", confirmDeleteId: null, tripsLoading: false,
      boxFont: 13, chooseStart, locating, locationNotice: "", locationError: "",
      email: "driver@example.com", emailRevealed: false, googleClientId: "", cardOnFile: false, unlimited: false,
      savingCard: false, cardGrantUsed: false, cardSavedNote: false, idleNote: "", notice: "", cardNote: "",
      estimating: false, credits: 5, error: "",
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
    eventsAround: (sid) => ({ now: [], before: [], self: { id: sid, stopID: sid }, following: [] }),
    chip: (event) => `<div class="chip-row"><div class="chip drive"></div>${ctx.delayBox(stops.find((s) => s.id === event.stopID), 0)}</div>`,
    donePlanChip: () => "",
    doneStamp: () => "",
    hereLeg: () => "",
    lookupPins: () => [],
    formatUserShort: (ms) => new Date(ms).toISOString(),
    formatClockMinutes: (minutes) => `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`,
    formatShort: (ms) => new Date(ms).toISOString(),
    enteredOffset: () => 0,
    speedNoteText: () => "",
    maskEmail: (email) => email,
    exampleOpenNote: () => "",
    openedTripNote: () => "",
    calculateButtonLabel: () => "Calculate",
    tripOnAccount: () => true,
    summaryLivesOnPlan: () => false,
    planEndButtons: () => "",
    planTimeline: (heading) => `<section class="step" id="planStep"><h2>${heading}</h2></section>`,
    planBox: (heading) => `<section class="step result" id="navStep"><h2>${heading}</h2>${NAV_STAGE}</section>`,
    document: null,
  };
  vm.createContext(ctx);
  vm.runInContext(PAGE_CODE, ctx);
  const routeFrom = `<span class="flag-box">Routing from 35.0000, -90.0000</span>`;
  // render() ends in bind(), and bind() runs syncRouteChrome(), which runs the locks.
  const chrome = () => {
    ctx.syncTripNavLocks();
    ctx.syncStopCardNavLock();
    if (typeof ctx.syncStepNavLock === "function") ctx.syncStepNavLock();
  };
  const render = () => {
    ctx.document = parseHtml(`<main>${ctx.arrangedPage({ s: ctx.state.settings, routeFrom, id })}</main>`);
    chrome();
    return ctx.document;
  };
  return { ctx, render, chrome };
}

const BLOCK_BY_HEADING = {
  "Sign in": "sign",
  "Choose where the trip starts": "start",
  "Set speed, hours, and when you leave": "hours",
  "Add each stop": "stops",
  "The plan": "plan",
  "Calculate the truck route": "calculate",
  "Navigate": "map",
};

// Found by heading text here in the test only, so it also works on the old page.
function steps(doc) {
  const out = new Map();
  for (const h2 of doc.querySelectorAll("h2")) {
    const m = /^\s*Step (\d+)\. (.+?)\s*$/.exec(h2.textContent);
    if (!m) continue;
    out.set(Number(m[1]), { block: BLOCK_BY_HEADING[m[2]] || m[2], section: h2.closest("section") });
  }
  return out;
}
const sectionOf = (doc, block) => [...steps(doc).values()].find((step) => step.block === block)?.section || null;
const controlsIn = (section) => (section ? section.querySelectorAll("button, select") : []);
const describe = (el) => `<${el.tagName} ${[...el.attrs].filter(([k]) => k !== "style").map(([k, v]) => `${k}="${v}"`).join(" ")}>`;
const lockedOk = (el) => el.disabled && el.getAttribute("aria-disabled") === "true";
const TRIP_BUTTONS = "[data-delete], [data-load], #newTrip, #saveTrip";
const disabledKey = (doc) => [...doc.walk()].filter((el) => el.tagName === "button" || el.tagName === "select")
  .map((el, i) => `${i}:${el.disabled ? 1 : 0}:${el.getAttribute("aria-disabled") ?? "-"}`).join(",");

// --- Which blocks are Step 1 and Step 2 ---
console.log("Step 1 and Step 2 by layout (signed in / signed out):");
for (const id of LAYOUT_IDS) {
  const row = [true, false].map((signedIn) => {
    const s = steps(renderer({ signedIn, id, navOn: false }).render());
    return `${s.get(1)?.block} + ${s.get(2)?.block}`;
  });
  console.log(`  ${layoutName(id).padEnd(10)} ${row[0]}${row[0] === row[1] ? "" : `  (signed out: ${row[1]})`}`);
}
{
  const home = steps(renderer({ id: 0, navOn: false }).render());
  expect("home page: Step 1 is Set speed, hours, and when you leave", home.get(1)?.block === "hours", home.get(1)?.block);
  expect("home page: Step 2 is Choose where the trip starts", home.get(2)?.block === "start", home.get(2)?.block);
}

// --- a. Locked while navigating, and again after a re-render ---
console.log("\na. Locked while navigating");
{
  const live = renderer({ id: 0 });
  for (const pass of ["first render", "after a re-render"]) {
    const doc = live.render();
    const s = steps(doc);
    for (const n of [1, 2]) {
      const controls = controlsIn(s.get(n)?.section);
      const open = controls.filter((el) => !lockedOk(el));
      expect(`home, ${pass}: every control in Step ${n} (${s.get(n)?.block}, ${controls.length}) is disabled + aria-disabled="true"`,
        controls.length > 0 && open.length === 0, open.map(describe).join(" | "));
    }
    for (const [label, sel] of [["Delete", "[data-delete]"], ["Load", "[data-load]"], ["Clear trip", "#newTrip"], ["Save", "#saveTrip"]]) {
      const found = doc.querySelectorAll(sel);
      const open = found.filter((el) => !lockedOk(el));
      expect(`home, ${pass}: ${label} (${found.length}) is disabled + aria-disabled="true"`, found.length > 0 && open.length === 0, open.map(describe).join(" | "));
    }
    const start = sectionOf(doc, "start");
    const hours = sectionOf(doc, "hours");
    expect(`home, ${pass}: both sections carry nav-locked`, start?.classList.contains("nav-locked") && hours?.classList.contains("nav-locked"));
    expect(`home, ${pass}: the saved trips list carries nav-locked`, doc.querySelector("section.trips")?.classList.contains("nav-locked"));
  }
}
for (const id of LAYOUT_IDS) {
  for (const signedIn of [true, false]) {
    const doc = renderer({ id, signedIn }).render();
    const open = ["start", "hours"].flatMap((block) => controlsIn(sectionOf(doc, block))).filter((el) => !lockedOk(el));
    const count = ["start", "hours"].flatMap((block) => controlsIn(sectionOf(doc, block))).length;
    expect(`${layoutName(id)}, signed ${signedIn ? "in" : "out"}: start and hours controls (${count}) are all locked`, count >= 12 && open.length === 0,
      open.map(describe).join(" | "));
  }
}
{
  const chromeSrc = extract("syncRouteChrome");
  expect("syncRouteChrome runs the Step lock and the saved-trip lock (bind() runs it on every render)",
    /syncStepNavLock\(\)/.test(chromeSrc) && /syncTripNavLocks\(\)/.test(chromeSrc) && /syncRouteChrome\(\)/.test(extract("bind")));
  const lockSrc = optional("syncStepNavLock");
  expect("the Step lock finds its sections by a hook on the section, not by heading text",
    /\[data-block=/.test(lockSrc) && !/Step |Choose where|Set speed/.test(lockSrc));
  const pageSrc = extract("arrangedPage");
  expect('the start block has data-block="start" and the hours block has data-block="hours"',
    /start: \(\) => `<section[^>]*data-block="start"/.test(pageSrc) && /hours: \(\) => `<section[^>]*data-block="hours"/.test(pageSrc));
}

// --- b. Unlocked after navigation ends ---
console.log("\nb. Unlocked after End navigation");

function deleteHandlers(doc, navOn, state) {
  const counts = { arm: 0, delete: 0 };
  const ctx = {
    navOn, state,
    document: doc,
    window: { clearTimeout() {} },
    deleteArmTimer: 0,
    armDelete(tid) { counts.arm += 1; state.confirmDeleteId = tid; },
    deleteTrip() { counts.delete += 1; },
  };
  vm.createContext(ctx);
  vm.runInContext(bindStatement('document.querySelectorAll("[data-delete]").forEach('), ctx);
  return counts;
}

{
  const { ctx, render, chrome } = renderer({ id: 0 });
  const doc = render();
  ctx.navOn = false;
  chrome();
  const fresh = renderer({ id: 0, navOn: false }).render();
  expect("every button is back to exactly how a page with navigation off draws it", disabledKey(doc) === disabledKey(fresh));
  const back = [...controlsIn(sectionOf(doc, "start")), ...controlsIn(sectionOf(doc, "hours")), ...doc.querySelectorAll(TRIP_BUTTONS)];
  const stuck = back.filter((el) => el.disabled);
  expect(`start, hours, Delete, Load, Clear trip, Save (${back.length}) are enabled again`, back.length > 0 && stuck.length === 0, stuck.map(describe).join(" | "));
  const aria = [...doc.walk()].filter((el) => el.hasAttribute("aria-disabled"));
  expect("no aria-disabled is left behind", aria.length === 0, aria.map(describe).join(" | "));
  const tags = [...doc.walk()].filter((el) => el.hasAttribute("data-nav-lock") || el.hasAttribute("data-nav-aria"));
  expect("no lock markers are left behind", tags.length === 0, tags.map(describe).join(" | "));
  const still = [sectionOf(doc, "start"), sectionOf(doc, "hours"), doc.querySelector("section.trips")].filter((el) => el?.classList.contains("nav-locked"));
  expect("nav-locked is off both sections and the saved trips list", still.length === 0);
}
{
  // Start from my location tapped before navigation, still waiting for permission.
  const { ctx, render, chrome } = renderer({ id: 0, locating: true });
  const doc = render();
  const locateButton = doc.querySelector("#locate");
  expect("navOn + locating: #locate is aria-disabled while navigating", locateButton && lockedOk(locateButton));
  ctx.navOn = false;
  chrome();
  expect("after End navigation, #locate stays disabled while it is still waiting for permission",
    locateButton?.disabled === true && !locateButton.hasAttribute("aria-disabled"), locateButton && describe(locateButton));
  expect("…and Start from an address is enabled again", doc.querySelector("#fromAddress")?.disabled === false);
}
{
  // A delete in progress when navigation starts and ends.
  const { ctx, render, chrome } = renderer({ id: 0, navOn: false });
  const doc = render();
  const state = { confirmDeleteId: null };
  deleteHandlers(doc, false, state);
  const busy = doc.querySelector('[data-delete="t2"]');
  busy.fire("click");
  busy.fire("click");
  expect("navigation off: two taps on Delete leave it busy (disabled, spinner)", busy.disabled && /arrival-spin/.test(busy.innerHTML || ""));
  ctx.navOn = true;
  chrome();
  ctx.navOn = false;
  chrome();
  expect("a Delete that was already deleting stays disabled after navigation starts and ends", busy.disabled === true, describe(busy));
  expect("the other Delete is enabled again", doc.querySelector('[data-delete="t1"]')?.disabled === false);
}

// --- c. The actions refuse while navigating ---
console.log("\nc. Actions refused while navigating");
{
  for (const armed of [false, true]) {
    const doc = renderer({ id: 0 }).render();
    const state = { confirmDeleteId: armed ? "t1" : null };
    const counts = deleteHandlers(doc, true, state);
    const button = doc.querySelector('[data-delete="t1"]');
    button.fire("click");
    if (!armed) button.fire("click");
    expect(`navOn: Delete ${armed ? "already armed (Confirm delete) then tapped" : "tapped twice"} does not arm, does not delete, no spinner`,
      counts.arm === 0 && counts.delete === 0 && state.confirmDeleteId === (armed ? "t1" : null) && button.innerHTML === undefined,
      `${JSON.stringify(counts)} confirmDeleteId=${state.confirmDeleteId}`);
  }
  {
    const doc = renderer({ id: 0, navOn: false }).render();
    const state = { confirmDeleteId: null };
    const counts = deleteHandlers(doc, false, state);
    const button = doc.querySelector('[data-delete="t1"]');
    button.fire("click");
    const armedAfterOne = state.confirmDeleteId === "t1" && counts.delete === 0;
    button.fire("click");
    expect("navigation off: Delete still arms on the first tap and deletes on Confirm delete", armedAfterOne && counts.delete === 1, JSON.stringify(counts));
  }
}

function tripActions(navOn) {
  const counts = { persist: 0, render: 0, put: 0, other: 0 };
  const ctx = {
    console, Math, Number, String, JSON, Array, Object, Date, Promise,
    navOn,
    state: { trips: [{ id: "t1", name: "Memphis run" }, { id: "t2", name: "Dallas run" }], activeTripId: "t1", stops: trip(), tripName: "X", signedIn: true },
    persist() { counts.persist += 1; },
    render() { counts.render += 1; },
    putTrips() { counts.put += 1; return Promise.resolve(); },
    markTripsUploaded() {},
    leaveNavSession() { counts.other += 1; },
    forgetLeftLeg() { counts.other += 1; },
    parkSpeedNote() { counts.other += 1; },
    showTripSpeedNote() { counts.other += 1; },
    storedTripHasWork: () => true,
    saveTrip() { counts.other += 1; },
    originPoint: () => null,
    document: { getElementById: () => ({ value: "Typed name" }) },
  };
  vm.createContext(ctx);
  vm.runInContext(["deleteTrip", "loadTrip", "newTrip", "saveNamedTrip"].map(extract).join("\n\n"), ctx);
  return { ctx, counts };
}
for (const [label, run] of [
  ["deleteTrip (Confirm delete)", (c) => c.deleteTrip("t1")],
  ["Load", (c) => c.loadTrip("t2")],
  ["Clear trip", (c) => c.newTrip()],
  ["Save", (c) => c.saveNamedTrip()],
]) {
  const { ctx, counts } = tripActions(true);
  const before = JSON.stringify(ctx.state);
  let error = "";
  try { await run(ctx); } catch (err) { error = String(err?.message || err); }
  const side = counts.persist + counts.render + counts.put + counts.other;
  expect(`navOn: ${label} changes nothing (no persist, no render)`, !error && JSON.stringify(ctx.state) === before && side === 0, error || JSON.stringify(counts));
}

function startActions(navOn) {
  const counts = { geo: 0, persist: 0, render: 0, progress: 0 };
  const ctx = {
    console, Math, Number, String, JSON, Array, Object, Date,
    navOn,
    state: { chooseStart: true, stops: trip(), origin: { lat: 35, lon: -90 }, locationError: "Old error", locationNotice: "", notice: "Hi", locating: false },
    window: { isSecureContext: true },
    navigator: {
      userAgent: "iPhone Mobile",
      geolocation: { getCurrentPosition() { counts.geo += 1; }, watchPosition() { counts.geo += 1; return 1; } },
    },
    document: { querySelector: () => null },
    setTimeout: () => 0,
    LOCATE_PRECISE: {}, LOCATE_COARSE: {},
    locateAttempt: 0,
    endLocateWatch() {},
    originPoint: () => null,
    movedEnough: () => false,
    locateSucceeded() {}, locateFailed() {}, locateRetry() {},
    showLocateProgress() { counts.progress += 1; },
    dropAddressStart: () => false,
    defaultStop: (patch) => ({ id: "new", ...patch }),
    persist() { counts.persist += 1; },
    render() { counts.render += 1; },
  };
  vm.createContext(ctx);
  vm.runInContext(["locate", "startFromAddress"].map(extract).join("\n\n"), ctx);
  return { ctx, counts };
}
for (const [label, run] of [["Start from my location", (c) => c.locate()], ["Start from an address", (c) => c.startFromAddress()]]) {
  const { ctx, counts } = startActions(true);
  const before = JSON.stringify(ctx.state);
  let error = "";
  try { run(ctx); } catch (err) { error = String(err?.message || err); }
  expect(`navOn: ${label} changes nothing (no GPS ask, no persist, no render)`,
    !error && JSON.stringify(ctx.state) === before && counts.geo + counts.persist + counts.render + counts.progress === 0, error || JSON.stringify(counts));
}
{
  const a = startActions(false);
  a.ctx.locate();
  expect("navigation off: Start from my location still asks for the location", a.counts.geo === 1 && a.ctx.state.locating === true, JSON.stringify(a.counts));
  const b = startActions(false);
  b.ctx.startFromAddress();
  expect("navigation off: Start from an address still adds the Start stop", b.ctx.state.stops[0]?.name === "Start" && b.counts.persist === 1);
}

// The real bindSettings() on a rendered page, then real clicks.
function boundPage(navOn) {
  const page = renderer({ id: 0, navOn });
  const doc = page.render();
  const counts = { persist: 0, save: 0, refresh: 0, render: 0, voice: 0 };
  const { ctx } = page;
  Object.assign(ctx, {
    speedChoiceLabel: () => "",
    markGovernedStale() {},
    poofBox() {},
    persist() { counts.persist += 1; },
    saveActiveTripSettings() { counts.save += 1; },
    refreshShownPlan() { counts.refresh += 1; },
    render() { counts.render += 1; },
    stepNavVoice() { counts.voice += 1; },
    commitPicker() {},
  });
  ctx.state.picker = "";
  vm.runInContext(extract("bindSettings"), ctx);
  ctx.bindSettings();
  return { ctx, doc, counts };
}
{
  const { ctx, doc, counts } = boundPage(true);
  const hours = sectionOf(doc, "hours");
  const toggles = hours.querySelectorAll("[data-toggle]");
  const picks = hours.querySelectorAll("button[data-pick]");
  const before = JSON.stringify(ctx.state.settings);
  toggles.forEach((el) => el.fire("click"));
  expect(`navOn: the ${toggles.length} setting toggles (${toggles.map((el) => el.getAttribute("data-toggle")).join(", ")}) change nothing`,
    toggles.length >= 6 && JSON.stringify(ctx.state.settings) === before && counts.persist + counts.save + counts.refresh + counts.render === 0,
    `${JSON.stringify(counts)} ${JSON.stringify(ctx.state.settings) === before ? "" : "settings changed"}`);
  const opened = [];
  picks.forEach((el) => {
    el.fire("click");
    if (ctx.state.picker) opened.push(ctx.state.picker);
    ctx.state.picker = "";
  });
  expect(`navOn: the ${picks.length} value pickers (${picks.map((el) => el.getAttribute("data-pick")).join(", ")}) do not open and change nothing`,
    picks.length >= 5 && opened.length === 0 && JSON.stringify(ctx.state.settings) === before && counts.persist + counts.save + counts.render === 0,
    `opened: ${opened.join(", ")} ${JSON.stringify(counts)}`);
}
{
  const { ctx, doc } = boundPage(false);
  const hours = sectionOf(doc, "hours");
  hours.querySelector('[data-toggle="kilometers"]').fire("click");
  hours.querySelector('[data-pick="hoursOfEleven"]').fire("click");
  expect("navigation off: Kilometers still toggles and Hours I'll drive still opens its picker",
    ctx.state.settings.kilometers === true && ctx.state.picker === "hoursOfEleven");
}

function pickerRun(navOn, id) {
  const counts = { persist: 0, save: 0, refresh: 0, render: 0, update: 0 };
  const wheel = { mph: "70", hoursOfEleven: "5", hoursBeforeThirty: "2", hour: "3", minute: "15", ampm: "PM" };
  const ctx = {
    console, Math, Number, String, JSON, Array, Object, Date,
    navOn,
    state: { picker: id, pickerTarget: null, settings: settings(), stops: trip() },
    document: {
      querySelector(sel) {
        const m = /\[data-part="(\w+)"\]\.on/.exec(sel);
        if (m && wheel[m[1]]) return { getAttribute: () => wheel[m[1]] };
        if (/data-part=date/.test(sel)) return { value: "2026-10-09" };
        return null;
      },
    },
    DEFAULT_MPH: 65,
    STOP_DATE_DAYS_BACK: 30,
    clockOffset: (value) => value || 0,
    readLeaveDate: () => T0 + 99 * HOUR,
    readDatedMs: () => T0 + 98 * HOUR,
    wallParts: () => ({ year: 2026, month: 9, day: 3, hour: 1, minute: 0 }),
    msFromWall: () => T0 + 77 * HOUR,
    speedChoiceLabel: () => "",
    markGovernedStale() {},
    pickerStop: () => null,
    pickerStopMs: () => T0,
    enteredOffset: () => 0,
    updateStop() { counts.update += 1; },
    persist() { counts.persist += 1; },
    saveActiveTripSettings() { counts.save += 1; },
    refreshShownPlan() { counts.refresh += 1; },
    render() { counts.render += 1; },
  };
  vm.createContext(ctx);
  vm.runInContext(["commitPicker", "chosenWheel", "minutesFromSheet", "writeStopWhen"].map(extract).join("\n\n"), ctx);
  ctx.commitPicker();
  return { ctx, counts };
}
for (const id of ["mph", "leaveAt", "leaveAtTime", "startTime", "endTime", "hoursOfEleven", "hoursBeforeThirty"]) {
  const { ctx, counts } = pickerRun(true, id);
  const unchanged = JSON.stringify(ctx.state.settings) === JSON.stringify(settings());
  expect(`navOn: an open ${id} picker's Done changes nothing and closes`,
    unchanged && counts.persist + counts.save + counts.refresh === 0 && ctx.state.picker === "",
    `${unchanged ? "" : "settings changed, "}${JSON.stringify(counts)} picker=${ctx.state.picker}`);
}
{
  const { ctx } = pickerRun(false, "mph");
  const hrs = pickerRun(false, "hoursOfEleven");
  expect("navigation off: the pickers still apply (70 mph, 5 of 11)", ctx.state.settings.governedMph === 70 && hrs.ctx.state.settings.hoursOfEleven === 5);
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
          rules.push({ media: media.trim(), selector, decls, order: rules.length });
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

// Looser than a browser: drops :not(), :hover and the like, and reads > + ~ as
// descendant, so a rule that could win is never missed. Pseudo-elements skipped.
function looseSelector(selector) {
  if (selector.includes("::")) return null;
  const s = selector
    .replace(/:not\((?:[^()]|\([^()]*\))*\)/g, "")
    .replace(/\s*[>+~]\s*/g, " ")
    .replace(/:(?!disabled\b)[\w-]+(?:\([^)]*\))?/g, "")
    .trim();
  return s || "*";
}

const cssRules = parseCss(cssSource)
  .filter((r) => !/prefers-reduced-motion/.test(r.media))
  .map((r) => ({ ...r, loose: looseSelector(r.selector), spec: specificity(r.selector) }))
  .filter((r) => r.loose);

function winner(el, prop) {
  const hits = cssRules.filter((r) => r.decls.has(prop) && el.matches(r.loose));
  hits.sort((a, b) => {
    const ia = /!important/.test(a.decls.get(prop)) ? 1 : 0;
    const ib = /!important/.test(b.decls.get(prop)) ? 1 : 0;
    return ia - ib || a.spec - b.spec || a.order - b.order;
  });
  return hits[hits.length - 1] || null;
}
const valueOf = (el, prop) => winner(el, prop)?.decls.get(prop).replace(/\s*!important/, "") ?? null;
function shownOpacity(el) {
  let out = 1;
  for (let node = el; node && node.tagName !== "#document"; node = node.parent) {
    const v = Number.parseFloat(valueOf(node, "opacity"));
    if (Number.isFinite(v)) out *= v;
  }
  return Math.round(out * 1000) / 1000;
}
const looksLocked = (el) => shownOpacity(el) <= 0.45 && valueOf(el, "cursor") === "not-allowed";
const why = (el) => `${describe(el)} opacity ${shownOpacity(el)} (${winner(el, "opacity")?.selector || "none"}), cursor ${valueOf(el, "cursor")} (${winner(el, "cursor")?.selector})`;

{
  const doc = renderer({ id: 0 }).render();
  const deletes = doc.querySelectorAll("[data-delete]");
  const bright = deletes.filter((el) => !looksLocked(el));
  expect(`navOn: Delete (${deletes.length}) shows opacity <= 0.45 and cursor not-allowed`, deletes.length > 0 && bright.length === 0, bright.map(why).join(" | "));
  const s = steps(doc);
  for (const n of [1, 2]) {
    const controls = controlsIn(s.get(n)?.section);
    const loose = controls.filter((el) => !looksLocked(el));
    expect(`navOn: every control in Step ${n} (${s.get(n)?.block}, ${controls.length}) shows opacity <= 0.45 and cursor not-allowed`,
      controls.length > 0 && loose.length === 0, loose.map(why).join(" | "));
  }
  const governed = sectionOf(doc, "hours")?.querySelectorAll("div.set-box button") || [];
  expect(`navOn: the Governed speed buttons (${governed.length}) are dimmed once, not twice (opacity >= 0.3)`,
    governed.length === 2 && governed.every((el) => shownOpacity(el) >= 0.3 && shownOpacity(el) <= 0.45), governed.map(why).join(" | "));
  const others = doc.querySelectorAll("[data-load], #newTrip, #saveTrip");
  const plain = others.filter((el) => !looksLocked(el));
  expect(`navOn: Load, Clear trip, Save (${others.length}) show opacity <= 0.45 and cursor not-allowed`, others.length > 0 && plain.length === 0, plain.map(why).join(" | "));
}
{
  const doc = renderer({ id: 0, chooseStart: true }).render();
  const pulsing = ["#locate", "#fromAddress"].map((sel) => doc.querySelector(sel)).filter((el) => el && valueOf(el, "animation") !== "none");
  expect("navOn: a locked Start from my location / an address does not keep pulsing (choose-start)", pulsing.length === 0, pulsing.map((el) => `${describe(el)} animation ${valueOf(el, "animation")}`).join(" | "));
}
{
  const doc = renderer({ id: 0, navOn: false }).render();
  deleteHandlers(doc, false, { confirmDeleteId: null });
  const busy = doc.querySelector('[data-delete="t1"]');
  busy.fire("click");
  busy.fire("click");
  expect("navigation off: a busy Delete still shows opacity 1 and cursor wait",
    busy.disabled && shownOpacity(busy) === 1 && valueOf(busy, "cursor") === "wait", why(busy));
  const idle = doc.querySelector('[data-delete="t2"]');
  expect("navigation off: an idle Delete is not dimmed", shownOpacity(idle) === 1 && valueOf(idle, "cursor") === "pointer", why(idle));
  const hoursButtons = controlsIn(sectionOf(doc, "hours"));
  expect("navigation off: the hours buttons are not dimmed", hoursButtons.length > 0 && hoursButtons.every((el) => shownOpacity(el) === 1), hoursButtons.filter((el) => shownOpacity(el) !== 1).map(why).join(" | "));
  expect("button[data-delete]:disabled { opacity: 1; cursor: wait } is still there",
    cssRules.some((r) => r.selector === "button[data-delete]:disabled" && r.decls.get("opacity") === "1" && r.decls.get("cursor") === "wait"));
}

// --- e. Navigation controls, Sign in, and stop cards are not locked differently ---
console.log("\ne. Navigation controls still work");
const NAV_KEEP = ["#endNav", "#routeStops", "[data-aim-stop]", "#routeRecalc", "#routeDetour", "#routeFollow", "#routeWhole", "#routeZoomIn",
  "#routeZoomOut", "#routeCompass", "#routeExit", "#voicePrev", "#voiceNext", "#routeSwitch", "#routeSwitchNo"];
{
  const bad = [];
  for (const id of LAYOUT_IDS) {
    const doc = renderer({ id }).render();
    for (const sel of NAV_KEEP) {
      const found = doc.querySelectorAll(sel);
      if (!found.length) bad.push(`${layoutName(id)}: ${sel} missing`);
      found.filter((el) => el.disabled || el.hasAttribute("aria-disabled")).forEach((el) => bad.push(`${layoutName(id)}: ${describe(el)}`));
    }
  }
  expect(`navOn, every layout: End navigation, Stops, Recalculate, Detours, Follow, zoom, compass, Exit full, voice ‹ › are not disabled`, bad.length === 0, bad.join(" | "));
}
{
  const bad = [];
  for (const id of LAYOUT_IDS) {
    const live = renderer({ id }).render();
    const off = renderer({ id, navOn: false }).render();
    const signLive = sectionOf(live, "sign");
    const signOff = sectionOf(off, "sign");
    if (!signLive) bad.push(`${layoutName(id)}: no Sign in`);
    else if (disabledKey(signLive) !== disabledKey(signOff) || controlsIn(signLive).some((el) => el.hasAttribute("data-nav-lock"))) bad.push(`${layoutName(id)}: Sign in changed`);
    const calcLive = sectionOf(live, "calculate");
    if (disabledKey(calcLive) !== disabledKey(sectionOf(off, "calculate"))) bad.push(`${layoutName(id)}: Calculate changed`);
    const cards = live.querySelectorAll(".stop-card button");
    if (!cards.length || cards.some((el) => !el.disabled)) bad.push(`${layoutName(id)}: stop card not locked as in #616`);
  }
  expect("navOn, every layout: Sign in and Calculate are untouched; stop cards are locked exactly as #616 locks them", bad.length === 0, bad.join(" | "));
}
{
  const { ctx, doc, counts } = boundPage(true);
  doc.querySelector("#routeMode").fire("click");
  doc.querySelector("#voiceNext").fire("click");
  expect("navOn: Fast/Short mode (outside the locked sections) still toggles, and the voice stepper still steps",
    ctx.state.settings.routeMode === "short" && counts.voice === 1);
}
{
  const calls = (name) => [...appSource.matchAll(new RegExp(`(?<!function )\\b${name}\\(`, "g"))].length;
  const bindSrc = extract("bind");
  expect("navigation never calls locate() or startFromAddress() itself (only the two taps in bind() do)",
    calls("locate") === 1 && calls("startFromAddress") === 1
      && /\$\("#locate"\)\?\.addEventListener\("click", \(\) => locate\(\)\)/.test(bindSrc)
      && /\$\("#fromAddress"\)\?\.addEventListener\("click", \(\) => startFromAddress\(\)\)/.test(bindSrc),
    `locate( x${calls("locate")}, startFromAddress( x${calls("startFromAddress")}`);
}

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
