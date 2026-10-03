// Build #622: Search here / Next Walmart results show on the pins only. No
// list on the map (full screen or page map), no city or state in any label,
// only the chosen pin has the box (with Add and recalculate); the others are
// small numbered dots. Search here / Clear sit between the rails at the top.
// Not loaded by the site. Run: node tests/search-declutter.test.mjs
// Against other copies: APP_JS=/path/to/app.js CSS_FILE=/path/to/styles.css node tests/search-declutter.test.mjs
//
// Loads planBox, the place list and the pin painters from js/app.js by name
// into a vm sandbox with a fake DOM and a fake maplibregl.Marker, and reads
// the rules in styles.css.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appSource = readFileSync(process.env.APP_JS || path.join(root, "js/app.js"), "utf8");
const cssSource = readFileSync(process.env.CSS_FILE || path.join(root, "styles.css"), "utf8");

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

// Only in one of the two builds. It runs without them, so this test can show #621 failing.
const optional = (name) => (find(name) ? extract(name) : "");

const APP_CODE = [
  ...["escapeAttr", "formatMiles", "planBox", "truckNoteText", "clearTruckPins", "paintTruckPins", "paintPlaceList",
    "selectTruckHit", "showTruckHits", "forgetTruckChoice", "syncTruckAdd"].map(extract),
  ...["truckLabelParts", "seatTruckLabel", "fillPagePlaceList", "fillPlaceChoices", "pinDetailLines"].map(optional),
].join("\n\n");

let failures = 0;
function expect(label, ok, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`);
}

// --- Fake DOM ---

class FakeEl {
  constructor(tag = "span", id = "") {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.className = "";
    this.children = [];
    this.parent = null;
    this.ownText = "";
    this.hidden = false;
    this.type = "";
    this.style = {};
    this.listeners = {};
    this.rect = { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 };
    this.offsetHeight = 0;
    const el = this;
    this.classList = {
      contains: (name) => el.className.split(/\s+/).includes(name),
      add: (name) => { if (!el.classList.contains(name)) el.className = `${el.className} ${name}`.trim(); },
      remove: (name) => { el.className = el.className.split(/\s+/).filter((c) => c && c !== name).join(" "); },
      toggle: (name, on = !el.classList.contains(name)) => {
        if (on) el.classList.add(name);
        else el.classList.remove(name);
        return on;
      },
    };
  }
  get textContent() {
    if (!this.children.length) return this.ownText;
    return this.children.map((child) => (typeof child === "string" ? child : child.textContent)).join("");
  }
  set textContent(value) {
    for (const child of this.children) if (typeof child !== "string") child.parent = null;
    this.children = [];
    this.ownText = String(value);
  }
  append(...nodes) {
    for (const node of nodes) {
      if (typeof node !== "string") node.parent = this;
      this.children.push(node);
    }
  }
  replaceChildren() { this.textContent = ""; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  getBoundingClientRect() { return this.rect; }
  elements() { return this.children.filter((child) => typeof child !== "string"); }
  descendants() { return this.elements().flatMap((child) => [child, ...child.descendants()]); }
  matches(selector) {
    const parts = selector.trim().split(/\s+/);
    return matchChain(this, parts);
  }
  closest(selector) {
    for (let el = this; el; el = el.parent) if (el.matches(selector)) return el;
    return null;
  }
  querySelector(selector) { return this.descendants().find((el) => el.matches(selector)) || null; }
  querySelectorAll(selector) { return this.descendants().filter((el) => el.matches(selector)); }
}

function matchSimple(el, simple) {
  const m = /^([a-z]*)((?:[#.][\w-]+)*)$/i.exec(simple);
  if (!m) throw new Error(`fake DOM cannot match ${simple}`);
  if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
  for (const bit of m[2].match(/[#.][\w-]+/g) || []) {
    if (bit[0] === "#" ? el.id !== bit.slice(1) : !el.classList.contains(bit.slice(1))) return false;
  }
  return true;
}

// The last part matches el and the parts before it match ancestors, in order.
function matchChain(el, parts) {
  if (!matchSimple(el, parts[parts.length - 1])) return false;
  let at = parts.length - 2;
  for (let up = el.parent; up && at >= 0; up = up.parent) if (matchSimple(up, parts[at])) at -= 1;
  return at < 0;
}

function click(el, target = el) {
  const event = { target, defaultPrevented: false, stopped: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } };
  for (let node = target; node; node = node.parent) {
    for (const fn of node.listeners.click || []) fn(event);
    if (event.stopped || node === el) break;
  }
}

const WALMARTS = [
  { name: "Walmart Supercenter", city: "Everett", state: "PA", lat: 40.01, lon: -78.37, milesAhead: 66.9, milesOff: 0.8 },
  { name: "Walmart Supercenter", city: "Bedford", state: "PA", lat: 40.02, lon: -78.5, milesAhead: 75.2, milesOff: 1.6 },
  { name: "Walmart", city: "Somerset", state: "PA", lat: 40.0, lon: -79.07, milesAhead: 104.3, milesOff: 0.4 },
  { name: "Walmart Supercenter", city: "Hagerstown", state: "MD", lat: 39.64, lon: -77.72, milesAhead: 112.0, milesOff: 4.1 },
  { name: "Walmart Supercenter", city: "Greensburg", state: "PA", lat: 40.3, lon: -79.54, milesAhead: 131.5, milesOff: 2.2 },
].map((hit) => ({ ...hit, place: "walmart" }));

const WANT_FIRST = "Walmart Supercenter · 66.9 miles ahead · 0.8 miles off the route";

const PAGE_IDS = ["nextTruckNote", "nextPlaceList", "searchPlaces", "clearPlaces", "addTruckStop", "routeMap",
  "routePlaceTools", "routePlaceSearch", "routePlaceClear", "routePlaceStatus"];

function sandbox({ full = true, decoyList = false } = {}) {
  const map = { markers: [] };
  const nodes = {};
  for (const id of PAGE_IDS) nodes[id] = new FakeEl(id === "nextPlaceList" || id === "routeMap" || id === "routePlaceTools" ? "div" : "p", id);
  if (decoyList) nodes.routePlaceList = new FakeEl("div", "routePlaceList");
  const roots = () => [...Object.values(nodes), ...map.markers.map((marker) => marker.element)];
  const all = () => roots().flatMap((el) => [el, ...el.descendants()]);
  const calls = { added: [] };
  class Marker {
    constructor({ element, anchor }) { this.element = element; this.anchor = anchor; }
    setLngLat(lngLat) { this.lngLat = lngLat; return this; }
    addTo(target) { target.markers.push(this); return this; }
    remove() { map.markers = map.markers.filter((marker) => marker !== this); }
  }
  const ctx = {
    console, Math, Number, String, JSON, Array, Object, Infinity, NaN, Set, Map, RegExp, Error,
    window: { maplibregl: { Marker } },
    document: {
      createElement: (tag) => new FakeEl(tag),
      getElementById: (id) => nodes[id] || null,
      querySelector: (selector) => all().find((el) => el.matches(selector)) || null,
      querySelectorAll: (selector) => all().filter((el) => el.matches(selector)),
    },
    state: {
      stops: [], plan: { legs: [] }, estimating: false, unlimited: true, credits: 40, darkMode: false,
      settings: { kilometers: false },
    },
    basemap: "street", navOn: true, routeFull: full, routeMap: map,
    truckHit: null, truckHits: [], truckMarkers: [], truckMarker: null, placeListMode: false,
    placeSeek: "walmart", placeSeekFull: full, placeMapMoved: false, placeHereNote: "",
    directionsBlock: () => "<details class=\"directions\" id=\"routeDirections\"></details>",
    voiceStepper: () => "", themeButtonLabel: () => "Light mode", activeTransportMode: () => "truck",
    transportButtonLabel: () => "Truck", summaryLivesOnPlan: () => true, planSummary: () => "",
    addTruckAndRecalculate: () => { calls.added.push(ctx.truckHit); },
  };
  vm.createContext(ctx);
  vm.runInContext(APP_CODE, ctx);
  return { ctx, nodes, map, calls };
}

const wrapOf = (marker) => marker.element;
const boxOf = (marker) => wrapOf(marker).querySelector(".truck-pin-label");
const pinOf = (marker) => wrapOf(marker).querySelector(".truck-pin");
const markerText = (map) => map.markers.map((marker) => wrapOf(marker).textContent).join(" | ");
const chosenIndex = (map) => map.markers.findIndex((marker) => boxOf(marker));

// Words that only come from a city or state. Text of sibling spans runs together
// ("SupercenterEverett, PA66.9"), so cities match anywhere and states between non-letters.
const cities = [...new Set(WALMARTS.map((hit) => hit.city))];
const states = [...new Set(WALMARTS.map((hit) => hit.state))];
const leaked = (text) => [
  ...cities.filter((city) => text.includes(city)),
  ...states.filter((st) => new RegExp(`(^|[^A-Za-z])${st}([^A-Za-z]|$)`).test(text)),
];

// --- a. No result list on the map; the page list stays ---
console.log("a. No list of results on the map");
{
  const { ctx } = sandbox();
  ctx.state.plan = { legs: [] };
  ctx.truckHits = WALMARTS.slice();
  ctx.truckHit = WALMARTS[0];
  ctx.placeListMode = true;
  const html = ctx.planBox();
  expect("planBox has no #routePlaceList", !/id="routePlaceList"/.test(html));
  expect("planBox has no .route-place-list", !/route-place-list/.test(html));
  expect("planBox still has the page list #nextPlaceList", /id="nextPlaceList"/.test(html));
  expect("app.js no longer has fillPlaceChoices or routePlaceList (nothing can re-create the map list)",
    !/fillPlaceChoices|routePlaceList/.test(appSource),
    [...new Set(appSource.match(/fillPlaceChoices|routePlaceList/g) || [])].join(", "));
}
for (const full of [true, false]) {
  const { ctx, nodes, map } = sandbox({ full, decoyList: true });
  ctx.showTruckHits(WALMARTS, true);
  const where = full ? "full screen" : "page map";
  const decoy = nodes.routePlaceList;
  expect(`${where}: 5 Walmart hits paint 5 pins`, map.markers.length === 5, String(map.markers.length));
  expect(`${where}: a #routePlaceList left in the page is never filled`,
    decoy.children.length === 0 && decoy.textContent === "",
    `${decoy.children.length} child(ren), "${decoy.textContent.slice(0, 80)}"`);
  const pageList = nodes.nextPlaceList;
  expect(`${where}: the page list under the map (#nextPlaceList) is still filled, 5 lines`,
    pageList.elements().length === 5 && !pageList.hidden, String(pageList.elements().length));
}
{
  const rules = parseCss(cssSource);
  const listRules = rules.filter((r) => /route-place-list/.test(r.selector));
  expect("styles.css has no .route-place-list rule", listRules.length === 0, listRules.map((r) => r.selector).join(", "));
}

// --- b. No city or state anywhere ---
console.log("\nb. No city or state in any label");
{
  const { ctx, nodes, map } = sandbox();
  ctx.showTruckHits(WALMARTS, true);
  expect("pin text has no city or state", leaked(markerText(map)).length === 0, `${leaked(markerText(map))} in "${markerText(map)}"`);
  const listText = nodes.nextPlaceList.textContent;
  expect("page list has no city or state", leaked(listText).length === 0, `${leaked(listText)} in "${listText.slice(0, 120)}"`);
  const notes = WALMARTS.map((hit) => ctx.truckNoteText(hit));
  expect("truckNoteText never names the city or state", notes.every((note) => !leaked(note).length),
    notes.filter((note) => leaked(note).length).join(" | "));
}
{
  const { ctx, nodes, map } = sandbox();
  ctx.showTruckHits([WALMARTS[0]], false);
  const note = nodes.nextTruckNote;
  expect("one place (Next truck stop): the note under the map has no city or state",
    !note.hidden && !leaked(note.textContent).length && note.textContent.length > 0, JSON.stringify(note.textContent));
  expect("one place: its pin box has no city or state", !leaked(markerText(map)).length, markerText(map));
  ctx.state.plan = { legs: [] };
  const html = ctx.planBox();
  const noteHtml = /<p class="flag-box" id="nextTruckNote"[^>]*>([^<]*)<\/p>/.exec(html)?.[1] || "";
  expect("one place: the note planBox renders has no city or state", noteHtml && !leaked(noteHtml).length, JSON.stringify(noteHtml));
}

// --- c. Only the chosen pin has the box ---
console.log("\nc. Only the chosen pin has a box");
{
  const { ctx, map, calls } = sandbox();
  ctx.showTruckHits(WALMARTS, true);
  const boxes = map.markers.filter((marker) => boxOf(marker));
  expect("exactly one pin has a .truck-pin-label box", boxes.length === 1, String(boxes.length));
  expect("…the first result (chosen by default)", chosenIndex(map) === 0 && ctx.truckHit === WALMARTS[0], String(chosenIndex(map)));
  const adds = map.markers.filter((marker) => wrapOf(marker).querySelector(".truck-pin-add"));
  expect("only that pin has Add and recalculate", adds.length === 1 && adds[0] === map.markers[0], String(adds.length));
  const numbers = map.markers.map((marker) => pinOf(marker)?.textContent || "");
  expect("every pin shows its number on the dot (1-5)", JSON.stringify(numbers) === JSON.stringify(["1", "2", "3", "4", "5"]), JSON.stringify(numbers));
  const plain = map.markers.slice(1);
  expect("the other pins are only the numbered dot (no box, no other text)",
    plain.every((marker, i) => !boxOf(marker) && wrapOf(marker).textContent === String(i + 2) && pinOf(marker).classList.contains("is-num")),
    plain.map((marker) => JSON.stringify(wrapOf(marker).textContent)).join(", "));
  expect("the chosen pin sits above the others (z-index)",
    Number(wrapOf(map.markers[0]).style.zIndex) > Math.max(...plain.map((marker) => Number(wrapOf(marker).style.zIndex) || 0)),
    map.markers.map((marker) => wrapOf(marker).style.zIndex).join(","));

  click(wrapOf(map.markers[2]), pinOf(map.markers[2]));
  expect("tapping dot 3 chooses the third place", ctx.truckHit === WALMARTS[2], ctx.truckHit?.city);
  expect("…the box moves to pin 3", chosenIndex(map) === 2 && map.markers.filter((marker) => boxOf(marker)).length === 1, String(chosenIndex(map)));
  expect("…pin 1 is now just its numbered dot", !boxOf(map.markers[0]) && wrapOf(map.markers[0]).textContent === "1", JSON.stringify(wrapOf(map.markers[0]).textContent));
  expect("…pin 3 is on top now", Number(wrapOf(map.markers[2]).style.zIndex) > Number(wrapOf(map.markers[0]).style.zIndex));
  expect("…still 5 pins", map.markers.length === 5, String(map.markers.length));

  const add = wrapOf(map.markers[2]).querySelector(".truck-pin-add");
  click(wrapOf(map.markers[2]), add);
  expect("Add and recalculate on pin 3 adds the third place", calls.added.length === 1 && calls.added[0] === WALMARTS[2], String(calls.added.length));
}
{
  const { ctx, map } = sandbox();
  ctx.showTruckHits([WALMARTS[0]], false);
  expect("one place: its pin has the box and Add", map.markers.length === 1 && boxOf(map.markers[0]) && wrapOf(map.markers[0]).querySelector(".truck-pin-add"));
  expect("one place: no number on the dot or in the box",
    !pinOf(map.markers[0]).classList.contains("is-num") && !/^1\./.test(boxOf(map.markers[0])?.textContent || ""),
    JSON.stringify(boxOf(map.markers[0])?.textContent));
}
{
  const { ctx, nodes, map } = sandbox();
  ctx.showTruckHits(WALMARTS, true);
  const wrap = wrapOf(map.markers[0]);
  const box = boxOf(map.markers[0]);
  const seat = typeof ctx.seatTruckLabel === "function" ? ctx.seatTruckLabel : null;
  nodes.routeMap.rect = { top: 0, bottom: 844, left: 0, right: 390, width: 390, height: 844 };
  nodes.routePlaceTools.rect = { top: 47, bottom: 82, left: 76, right: 314, width: 238, height: 35 };
  if (box) box.offsetHeight = 70;
  wrap.rect = { top: 100, bottom: 126, left: 180, right: 206, width: 26, height: 26 };
  seat?.();
  expect("a chosen pin just under Search here / Clear puts its box below the dot", seat && wrap.classList.contains("is-below"));
  wrap.rect = { top: 400, bottom: 426, left: 180, right: 206, width: 26, height: 26 };
  seat?.();
  expect("…and back above the dot when there is room", seat && !wrap.classList.contains("is-below"));
}

// --- d. Search here / Clear placement (CSS) ---
console.log("\nd. Search here / Clear stay clear of the rails and the directions");

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

{
  const rules = parseCss(cssSource);
  // Last declaration wins, like the browser, for rules outside @media.
  const decl = (selector, prop) => rules.filter((r) => r.selector === selector && !r.media && r.decls.has(prop)).map((r) => r.decls.get(prop)).pop();
  // A px length (with env(), max(), min(), calc()) for a given safe-area inset; NaN if not a px length.
  const px = (value, inset = 0) => {
    if (!value) return NaN;
    const expr = value.replace(/env\([^)]*\)/g, `${inset}px`).replace(/calc/g, "").replace(/max/g, "M").replace(/min/g, "N");
    if (/%|vh|vw|dvh|em|auto/.test(expr)) return NaN;
    const js = expr.replace(/px/g, "").replace(/M/g, "Math.max").replace(/N/g, "Math.min");
    if (!/^(?:[\d\s.+\-*/(),]|Math\.max|Math\.min)+$/.test(js)) return NaN;
    return Function(`return (${js});`)();
  };
  const tools = ".route-place-tools";
  const fullTools = ".route-stage.is-full .route-place-tools";
  const GAP = 4;

  // Page map: rails sit at 8px from each edge, .route-rail button wide.
  const railWidth = px(decl(".route-rail button", "width"));
  const leftRail = px(decl(".route-rail-left", "left")) + railWidth;
  const rightRail = px(decl(".route-rail", "right")) + railWidth;
  const pageLeft = px(decl(tools, "left"));
  const pageRight = px(decl(tools, "right"));
  expect(`page map: Search here / Clear start right of the left rail (${leftRail}px)`, pageLeft >= leftRail + GAP, `left: ${decl(tools, "left")}`);
  expect(`page map: …and end left of the right rail (${rightRail}px)`, pageRight >= rightRail + GAP, `right: ${decl(tools, "right")}`);
  expect("page map: no centering transform that ignores the rails", !/translate/.test(decl(tools, "transform") || ""), decl(tools, "transform"));
  expect("page map: at 390px wide (366px map) there is room for Search here + Clear (~190px)",
    366 - pageLeft - pageRight >= 190, `${366 - pageLeft - pageRight}px`);

  // Full screen: rails at max(8px, safe area), .route-stage.is-full .route-rail button wide.
  const fullRailWidth = px(decl(".route-stage.is-full .route-rail button", "width"));
  for (const inset of [0, 20, 47]) {
    const railL = px(decl(".route-stage.is-full .route-rail-left", "left"), inset) + fullRailWidth;
    const railR = px(decl(".route-stage.is-full .route-rail", "right"), inset) + fullRailWidth;
    const left = px(decl(fullTools, "left") || decl(tools, "left"), inset);
    const right = px(decl(fullTools, "right") || decl(tools, "right"), inset);
    expect(`full screen, safe area ${inset}px: clear of the left rail (${railL}px) and right rail (${railR}px)`,
      left >= railL + GAP && right >= railR + GAP, `left ${left}, right ${right}`);
    if (inset === 0) {
      expect("full screen at 390px wide: room for Search here + Clear", 390 - left - right >= 190, `${390 - left - right}px`);
    }
  }

  // The directions (and ETA) stack is anchored to the bottom; the tools to the top.
  expect("Search here / Clear sit at the top (top set, no bottom)", decl(tools, "top") && !decl(tools, "bottom"), `top ${decl(tools, "top")}, bottom ${decl(tools, "bottom")}`);
  expect("full screen: below the notch (safe-area top)", /safe-area-inset-top/.test(decl(fullTools, "top") || ""), decl(fullTools, "top"));
  expect("the directions stack (.route-bottom) is anchored to the bottom", decl(".route-bottom", "bottom") && !decl(".route-bottom", "top"));
  const toolsZ = Number(decl(tools, "z-index"));
  expect("Search here / Clear stay above every pin (z-index over markers and the chosen pin's 4)",
    toolsZ > Number(decl(".route-map .maplibregl-marker", "z-index")) && toolsZ > 4, `tools ${toolsZ}`);
  expect("the chosen box floats over the map (absolute), so it does not grow the pin", decl(".truck-pin-label", "position") === "absolute",
    decl(".truck-pin-label", "position"));
  expect("a box flipped under its pin has a rule", Boolean(decl(".truck-pin-wrap.is-below .truck-pin-label", "top")));
}

// --- e. The label format ---
console.log("\ne. Label: name · miles ahead · miles off the route");
{
  const { ctx, nodes, map } = sandbox();
  ctx.showTruckHits(WALMARTS, true);
  const note = ctx.truckNoteText(WALMARTS[0]);
  expect("truckNoteText", note === WANT_FIRST, JSON.stringify(note));
  const boxText = boxOf(map.markers[0])?.querySelector(".truck-pin-text")?.textContent
    ?? boxOf(map.markers[0])?.textContent;
  expect("the chosen pin's box", boxText === `1. ${WANT_FIRST}`, JSON.stringify(boxText));
  const firstLine = nodes.nextPlaceList.elements()[0]?.textContent;
  expect("the page list's first line", firstLine === `1. ${WANT_FIRST}`, JSON.stringify(firstLine));
  const add = boxOf(map.markers[0])?.querySelector(".truck-pin-add")?.textContent;
  expect("the box ends with Add and recalculate", add === "Add and recalculate", JSON.stringify(add));
}

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
