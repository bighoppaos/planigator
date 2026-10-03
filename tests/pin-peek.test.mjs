// Build #624: tapping a search result pin on the map zooms to about half a mile
// around it for 5 s, with its box and Add and recalculate, then goes back to
// the zoom mode he was in. GPS fixes do not move the map during those 5 s.
// Another tap restarts the 5 s; Add and recalculate, Clear, the zoom button,
// Follow me, End navigation and a map rebuild stop them.
// Not loaded by the site.
// Run: node tests/pin-peek.test.mjs
// Against other copies: APP_JS=/path/to/app.js node tests/pin-peek.test.mjs
//
// The real pin painters, trip-fit framing (Turn, Stop, Left, Trip zoom, Follow
// me), onNavFix and the tap wiring (mountMap's map listeners and bind()'s
// button handlers) are loaded from js/app.js by name into a vm sandbox, over a
// fake MapLibre map doing real Web Mercator math (512px world) and a fake
// clock with fake timers. The screen is the full-screen map (390x844).

import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appSource = readFileSync(process.env.APP_JS || path.join(root, "js/app.js"), "utf8");
const navMatch = await import(pathToFileURL(path.join(root, "js/nav-match.js")).href);

function find(source, name) {
  return new RegExp(`^(?:async\\s+)?function\\s+${name}\\s*\\(`, "m").exec(source);
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

function extract(source, name, optional = false) {
  const head = find(source, name);
  if (!head) {
    if (optional) return "";
    throw new Error(`app.js has no function ${name}`);
  }
  const params = skipBalanced(source, head.index + head[0].length - 1, "(", ")");
  return source.slice(head.index, skipBalanced(source, source.indexOf("{", params), "{", "}"));
}

function constLine(source, name, optional = false) {
  const hit = new RegExp(`^const ${name} = [^;]+;`, "m").exec(source);
  if (!hit) {
    if (optional) return "";
    throw new Error(`app.js has no const ${name}`);
  }
  return hit[0].replace(/^const /, "var ");
}

// The arguments of `<prefix>"click", …)` inside `body`, e.g. `"click", () => cycleTripFit()`.
function clickArgs(body, prefix) {
  const at = body.indexOf(`${prefix}"click"`);
  if (at < 0) return "";
  const open = at + prefix.length - 1;
  return body.slice(open + 1, skipBalanced(body, open, "(", ")") - 1);
}

const APP_FUNCTIONS = [
  "metersBetween", "polylineMeters", "pointAlong", "stepLengthMeters", "scaledStepLengths", "navStep", "metersLeftInStep",
  "navBearing", "pointAhead", "rebuildNavLegs", "activeNavLeg", "currentDirectionEnd", "turnGuideAlong", "navRemaining",
  "turnViewPadding", "railClearance", "paddingForTurnZoom", "noHandsSlots", "stretchMeters", "mercatorMpp", "cameraForStretch",
  "cameraForFullTurn", "placeTurnPin", "placeNavDot", "showNavCamera", "travelBearing", "frameNextTurn", "clearTurnFrame",
  "stopTurnZoomOut", "syncTripFitButton", "tripFitLines", "cycleTripFit", "aimNavDot", "paintNavMotion",
  "mercatorWorld", "mercatorLngLat", "wrapBearing", "cameraAtSpot", "spotOnCamera", "pinTwoPoints", "roadRoom",
  "turnPinFrame", "hookTurnPinGlide", "settleTurnPin", "framePinnedTurn", "showPinnedTurn",
  "originPoint", "tripViewPadding", "fitCoords", "showWholeTrip", "frameNextStop", "clearRoutePins",
  "routePins", "routePinFor", "declutterRoutePins", "stopZoomPadding",
  "onNavFix", "onNavCompass", "snapNavLock", "followBearing", "resumeTurnZoom", "clearDirectionPin", "clearRouteMap",
  "formatMiles", "truckLabelParts", "truckNoteText", "clearTruckPins", "paintTruckPins", "seatTruckLabel",
  "fillPagePlaceList", "paintPlaceList", "selectTruckHit", "showTruckHits", "forgetTruckChoice", "syncTruckAdd",
  "clearPlacePins", "addTruckAndRecalculate",
];
// Build #624 only. #623 runs without them, so this test can show it failing.
const OPTIONAL_FUNCTIONS = ["onRouteMapClick", "peekTruckHit", "pinPeekPadding", "showPinPeek", "cancelPinPeek", "endPinPeek"];
const APP_CONSTS = [
  "MERCATOR_MPP0", "FULL_TURN_TOP_PX", "FULL_TURN_MAX_ZOOM", "NAV_DOT_HALO_PX", "NAV_DOT_CHIP_GAP_PX",
  "TURN_PIN_MAX_ZOOM", "TURN_PIN_HOLD_M", "TURN_PIN_HOLD_OUT_M", "TURN_PIN_PAST_M", "TURN_PIN_EASE_MS",
  "TURN_PIN_AFTER_MIN_M", "TURN_PIN_AFTER_MAX_M",
];
const OPTIONAL_CONSTS = ["PIN_PEEK_MS", "PIN_PEEK_M"];

const APP_CODE = [
  ...APP_CONSTS.map((name) => constLine(appSource, name)),
  ...OPTIONAL_CONSTS.map((name) => constLine(appSource, name, true)),
  ...APP_FUNCTIONS.map((name) => extract(appSource, name)),
  ...OPTIONAL_FUNCTIONS.map((name) => extract(appSource, name, true)),
].join("\n\n");

// How the app wires the taps: bind()'s button handlers and mountMap's click listener on the map.
const BIND = extract(appSource, "bind");
const HANDLERS = Object.fromEntries(["routeWhole", "routeFollow", "routePlaceClear", "endNav"].map((id) => {
  const args = clickArgs(BIND, `$("#${id}")?.addEventListener(`);
  if (!args) throw new Error(`bind() has no click handler for #${id}`);
  return [id, args];
}));
const MAP_CLICK = clickArgs(extract(appSource, "mountMap"), "el.addEventListener(");

let failures = 0;
function expect(label, ok, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`);
}

// --- A fake MapLibre map: real Web Mercator, bearing = the compass direction that is up. ---

const toLngLat = (v) => (Array.isArray(v) ? { lng: v[0], lat: v[1] } : { lng: v.lng ?? v.lon, lat: v.lat });
const noop = () => {};

class FakeBounds {
  constructor(a, b) {
    const p = toLngLat(a);
    const q = toLngLat(b || a);
    this.w = Math.min(p.lng, q.lng); this.e = Math.max(p.lng, q.lng);
    this.s = Math.min(p.lat, q.lat); this.n = Math.max(p.lat, q.lat);
  }
  extend(v) {
    const { lng, lat } = toLngLat(v);
    this.w = Math.min(this.w, lng); this.e = Math.max(this.e, lng);
    this.s = Math.min(this.s, lat); this.n = Math.max(this.n, lat);
    return this;
  }
  getWest() { return this.w; }
  getEast() { return this.e; }
  getSouth() { return this.s; }
  getNorth() { return this.n; }
}

class FakeMap {
  constructor(el) {
    this.el = el;
    this.center = { lng: -79, lat: 40 };
    this.zoom = 6;
    this.bearing = 0;
    this.maxZoom = 22;
    this.minZoom = 0;
    this.handlers = {};
    this.markers = [];
    this.removed = false;
  }
  getContainer() { return this.el; }
  getZoom() { return this.zoom; }
  getBearing() { return this.bearing; }
  getPitch() { return 0; }
  getCenter() { return { ...this.center }; }
  getMaxZoom() { return this.maxZoom; }
  getMinZoom() { return this.minZoom; }
  setMaxZoom(z) { this.maxZoom = z == null ? 22 : z; return this; }
  on(type, fn) { (this.handlers[type] ||= []).push(fn); return this; }
  fire(type) { for (const fn of this.handlers[type] || []) fn({ type }); }
  stop() { return this; }
  redraw() { return this; }
  remove() { this.removed = true; }
  worldSize(z = this.zoom) { return 512 * 2 ** z; }
  world(lng, lat, z = this.zoom) {
    const size = this.worldSize(z);
    const y = 180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));
    return { x: (180 + lng) / 360 * size, y: y / 360 * size };
  }
  fromWorld(x, y, z = this.zoom) {
    const size = this.worldSize(z);
    const y2 = 180 - (y / size) * 360;
    return { lng: (x / size) * 360 - 180, lat: (360 / Math.PI) * Math.atan(Math.exp(y2 * Math.PI / 180)) - 90 };
  }
  project(v) {
    const { lng, lat } = toLngLat(v);
    const p = this.world(lng, lat);
    const c = this.world(this.center.lng, this.center.lat);
    const b = this.bearing * Math.PI / 180;
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    return { x: this.el.clientWidth / 2 + dx * Math.cos(b) + dy * Math.sin(b), y: this.el.clientHeight / 2 - dx * Math.sin(b) + dy * Math.cos(b) };
  }
  unproject(pt) {
    const [px, py] = Array.isArray(pt) ? pt : [pt.x, pt.y];
    const sx = px - this.el.clientWidth / 2;
    const sy = py - this.el.clientHeight / 2;
    const b = this.bearing * Math.PI / 180;
    const c = this.world(this.center.lng, this.center.lat);
    return this.fromWorld(c.x + sx * Math.cos(b) - sy * Math.sin(b), c.y + sx * Math.sin(b) + sy * Math.cos(b));
  }
  clampZoom(z) { return Math.max(this.minZoom, Math.min(this.maxZoom, z)); }
  wrap(b) { return ((((b + 180) % 360) + 360) % 360) - 180; }
  setLocationAtPoint(v, pt) {
    const p = this.project(v);
    this.center = this.unproject([this.el.clientWidth / 2 + p.x - pt.x, this.el.clientHeight / 2 + p.y - pt.y]);
  }
  jumpTo(o) {
    if (o.center) this.center = toLngLat(o.center);
    if (o.zoom != null) this.zoom = this.clampZoom(o.zoom);
    if (o.bearing != null) this.bearing = this.wrap(o.bearing);
    this.fire("move");
    this.fire("moveend");
    return this;
  }
  easeTo(o) {
    const around = o.around ? toLngLat(o.around) : null;
    const aroundPt = around ? this.project(around) : null;
    if (o.zoom != null) this.zoom = this.clampZoom(o.zoom);
    if (o.bearing != null) this.bearing = this.wrap(o.bearing);
    if (around) this.setLocationAtPoint(around, aroundPt);
    else if (o.center) this.center = toLngLat(o.center);
    this.fire("move");
    this.fire("moveend");
    return this;
  }
  flyTo(o) { return this.easeTo(o); }
  // MapLibre's fitBounds at bearing 0: the bounds fill the padded box, centered in it.
  fitBounds(bounds, o = {}) {
    const pad = typeof o.padding === "number"
      ? { top: o.padding, right: o.padding, bottom: o.padding, left: o.padding }
      : { top: 0, right: 0, bottom: 0, left: 0, ...o.padding };
    const W = this.el.clientWidth;
    const H = this.el.clientHeight;
    const nw = this.world(bounds.getWest(), bounds.getNorth(), 0);
    const se = this.world(bounds.getEast(), bounds.getSouth(), 0);
    const roomX = W - pad.left - pad.right;
    const roomY = H - pad.top - pad.bottom;
    if (roomX <= 0 || roomY <= 0) return this;
    const scale = Math.min(roomX / Math.max(se.x - nw.x, 1e-9), roomY / Math.max(se.y - nw.y, 1e-9));
    const zoom = this.clampZoom(Math.min(Math.log2(scale), o.maxZoom ?? this.maxZoom));
    const k = 2 ** zoom;
    const midX = (nw.x + se.x) / 2 * k;
    const midY = (nw.y + se.y) / 2 * k;
    const boxX = (pad.left + W - pad.right) / 2;
    const boxY = (pad.top + H - pad.bottom) / 2;
    this.zoom = zoom;
    this.bearing = this.wrap(o.bearing ?? this.bearing);
    this.center = this.fromWorld(midX - (boxX - W / 2), midY - (boxY - H / 2), zoom);
    this.fire("move");
    this.fire("moveend");
    return this;
  }
}

// Markers live in the map's container, like MapLibre's canvas container.
class FakeMarker {
  constructor({ element }) { this.el = element; this.at = null; this.map = null; }
  setLngLat(v) { this.at = toLngLat(v); return this; }
  getLngLat() { return this.at; }
  addTo(map) {
    this.map = map;
    map.markers.push(this);
    this.el.parent = map.el;
    this.el.marker = this;
    return this;
  }
  remove() {
    if (this.map) this.map.markers = this.map.markers.filter((m) => m !== this);
    this.el.parent = null;
    this.el.isConnected = false;
    return this;
  }
  getElement() { return this.el; }
}

const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top });

// --- A small DOM: classes, children, selectors, and click with capture and bubble ---

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
    this.dataset = {};
    this.listeners = {};
    this.isConnected = true;
    this.box = null;
    const el = this;
    this.classList = {
      contains: (name) => el.className.split(/\s+/).includes(name),
      add: (name) => { if (!el.classList.contains(name)) el.className = `${el.className} ${name}`.trim(); },
      remove: (name) => { el.className = el.className.split(/\s+/).filter((c) => c && c !== name).join(" "); },
      toggle: (name, on = !el.classList.contains(name)) => { if (on) el.classList.add(name); else el.classList.remove(name); return on; },
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
  addEventListener(type, fn, options) {
    const capture = options === true || Boolean(options?.capture);
    (this.listeners[type] ||= []).push({ fn, capture });
  }
  get offsetHeight() {
    if (this.classList.contains("truck-pin-label")) return 44;
    return this.classList.contains("route-you") ? 24 : 0;
  }
  get offsetWidth() { return this.classList.contains("truck-pin-label") ? 200 : 24; }
  getBoundingClientRect() {
    if (this.box) return this.box();
    // A result pin: anchored at the bottom of its 26px dot.
    if (this.marker?.map && this.classList.contains("truck-pin-wrap")) {
      const at = this.marker.map.project(this.marker.getLngLat());
      return rect(at.x - 13, at.y - 26, 26, 26);
    }
    return rect(0, 0, this.offsetWidth, this.offsetHeight);
  }
  contains(el) {
    for (let node = el; node; node = node.parent) if (node === this) return true;
    return false;
  }
  elements() { return this.children.filter((child) => typeof child !== "string"); }
  descendants() { return this.elements().flatMap((child) => [child, ...child.descendants()]); }
  matches(selector) {
    return selector.split(",").some((one) => matchChain(this, one.trim().split(/\s+/)));
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
  if (!m) return false;
  if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
  for (const bit of m[2].match(/[#.][\w-]+/g) || []) {
    if (bit[0] === "#" ? el.id !== bit.slice(1) : !el.classList.contains(bit.slice(1))) return false;
  }
  return true;
}

function matchChain(el, parts) {
  if (!matchSimple(el, parts[parts.length - 1])) return false;
  let at = parts.length - 2;
  for (let up = el.parent; up && at >= 0; up = up.parent) if (matchSimple(up, parts[at])) at -= 1;
  return at < 0;
}

// Capture listeners from the top down to the target, then bubble back up.
function click(target) {
  const chain = [];
  for (let node = target; node; node = node.parent) chain.push(node);
  const event = {
    type: "click", target, stopped: false, defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; },
  };
  for (const node of [...chain].reverse()) {
    for (const l of node.listeners.click || []) if (l.capture) l.fn(event);
    if (event.stopped) return;
  }
  for (const node of chain) {
    for (const l of node.listeners.click || []) if (!l.capture) l.fn(event);
    if (event.stopped) return;
  }
}

// --- The full-screen map (390x844, notch 47px), Search here / Clear at the top ---

const WIDTH = 390;
const HEIGHT = 844;
const SAFE_TOP = 47;
const STACK_TOP = 580;
const RAILS = [rect(8, 270, 60, 300), rect(322, 270, 60, 300)];
const TOOLS = rect(76, SAFE_TOP + 8, 238, 36);
// What nothing covers: between the rails, under Search here / Clear, above the ETA and the directions.
const CLEAR = { left: RAILS[0].right, right: RAILS[1].left, top: TOOLS.bottom, bottom: STACK_TOP };

// --- The trip: Harrisburg PA west on the turnpike past Pittsburgh to Columbus OH. ---

const HERE = [40.27, -76.88];
const PITTSBURGH = [40.44, -80.0];
const PLACES = {
  start: [40.04, -76.31],
  walmar: [40.27, -76.79],
  pilotfue: [39.95, -82.9],
  swft: [39.96, -83.0],
};

function line(points, stepM = 3000) {
  const out = [];
  for (let i = 1; i < points.length; i += 1) {
    const [a, b] = [points[i - 1], points[i]];
    const n = Math.max(1, Math.ceil(navMatch.metersBetween(a, b) / stepM));
    for (let k = i === 1 ? 0 : 1; k <= n; k += 1) out.push([a[0] + (b[0] - a[0]) * (k / n), a[1] + (b[1] - a[1]) * (k / n)]);
  }
  return out;
}

function leg(id, name, to, via, extra = {}) {
  const pathLL = line(via);
  let meters = 0;
  for (let i = 1; i < pathLL.length; i += 1) meters += navMatch.metersBetween(pathLL[i - 1], pathLL[i]);
  const half = meters / 2 / 1609.344;
  return {
    id, name, lat: to[0], lon: to[1], miles: String(meters / 1609.344), hours: "1", path: pathLL,
    directions: [{ text: "Head west", miles: half }, { text: "Take exit", miles: half }, { text: `Arrive at ${name}`, miles: 0 }],
    ...extra,
  };
}

function STOPS() {
  return [
    { id: "start", name: "START", lat: PLACES.start[0], lon: PLACES.start[1] },
    leg("walmar", "WALMAR", PLACES.walmar, [PLACES.start, PLACES.walmar], { done: true }),
    leg("pilotfue", "pilotfue", PLACES.pilotfue, [PLACES.walmar, HERE, PITTSBURGH, PLACES.pilotfue]),
    leg("swft", "SWFT", PLACES.swft, [PLACES.pilotfue, PLACES.swft]),
  ];
}

// Detour results ahead on the turnpike (Walmarts near Carlisle, Bedford, Somerset).
const HITS = [
  { name: "Walmart Supercenter", lat: 40.205, lon: -77.19, milesAhead: 17.4, milesOff: 0.8, place: "walmart" },
  { name: "Walmart Supercenter", lat: 40.02, lon: -78.5, milesAhead: 88.2, milesOff: 1.6, place: "walmart" },
  { name: "Walmart", lat: 40.0, lon: -79.07, milesAhead: 117.3, milesOff: 0.4, place: "walmart" },
];
// 300 m further along the road from HERE (toward Pittsburgh).
const AHEAD = (() => {
  const d = navMatch.metersBetween(HERE, PITTSBURGH);
  const t = 300 / d;
  return [HERE[0] + (PITTSBURGH[0] - HERE[0]) * t, HERE[1] + (PITTSBURGH[1] - HERE[1]) * t];
})();

const ON_NAV_FIX_STUBS = [
  "startNavMotion", "paintCompassRose", "queueBasemap", "refreshPlace", "paintRouteLines", "noteArrivedStops", "paintDrive",
  "setStopChip", "paintSwitchOffer", "sayNav", "paintNavLine", "clearStopNote", "trackLiveDrive", "markDirection",
  "paintDirectionMiles", "openDirectionsNear", "speakNavProgress", "paintDirectionToward",
];

function world() {
  const clock = { now: 1_780_000_000_000 };
  class FakeDate extends Date {
    static now() { return clock.now; }
  }
  const timers = [];
  let timerId = 0;
  const mapEl = new FakeEl("div", "routeMap");
  mapEl.clientWidth = WIDTH;
  mapEl.clientHeight = HEIGHT;
  mapEl.box = () => rect(0, 0, WIDTH, HEIGHT);
  const els = {
    routeMap: mapEl,
    routePlaceTools: Object.assign(new FakeEl("div", "routePlaceTools"), { box: () => TOOLS }),
    nextPlaceList: new FakeEl("div", "nextPlaceList"),
    routeRecalc: { getBoundingClientRect: () => rect(322, 450, 60, 60) },
    routeDetour: { getBoundingClientRect: () => rect(8, 330, 60, 60) },
    routeCompass: { getBoundingClientRect: () => rect(322, 330, 60, 60) },
    routeStopMiles: { getBoundingClientRect: () => rect(100, STACK_TOP, 190, 26) },
    routeDirections: { hidden: false, getBoundingClientRect: () => rect(8, STACK_TOP + 30, 374, HEIGHT - 8 - STACK_TOP - 30) },
    routeWhole: { innerHTML: "", setAttribute: noop, classList: { toggle: noop } },
  };
  const stack = { hidden: false, getBoundingClientRect: () => rect(8, STACK_TOP, 374, HEIGHT - 8 - STACK_TOP) };
  const rails = RAILS.map((box) => ({ getBoundingClientRect: () => box }));
  const map = new FakeMap(mapEl);
  const markerEls = () => (context.routeMap ? context.routeMap.markers.map((m) => m.el) : []);
  const all = () => [...Object.values(els).filter((el) => el instanceof FakeEl), ...markerEls()].flatMap((el) => [el, ...el.descendants()]);
  const calls = { added: [], ended: 0 };
  const context = {
    console, Math, Number, String, JSON, Array, Object, Infinity, NaN, Set, Map, RegExp, Promise, Error, Boolean,
    Date: FakeDate,
    ...navMatch,
    clock, calls,
    performance: { now: () => clock.now },
    requestAnimationFrame: () => 0,
    routeMapReady: true, navMotion: 0, navMapTouch: false, navZoom: 15, navZoomHold: 0,
    document: {
      visibilityState: "visible",
      getElementById: (id) => els[id] || null,
      querySelector: (sel) => (sel === "#routeStage .route-bottom" ? stack : all().find((el) => el.matches(sel)) || null),
      querySelectorAll: (sel) => (sel === ".route-stage .route-rail" ? rails : all().filter((el) => el.matches(sel))),
      createElement: (tag) => new FakeEl(tag),
    },
    window: {
      maplibregl: { Marker: FakeMarker, LngLatBounds: FakeBounds },
      setTimeout: (fn, ms = 0) => { timerId += 1; timers.push({ id: timerId, at: clock.now + ms, fn }); return timerId; },
      clearTimeout: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    },
    state: { stops: STOPS(), settings: { kilometers: false }, estimating: false },
    routeMap: map, routeFull: true, tripFit: "nextTurn", navOn: true, northLock: false,
    navLine: [], navLegs: [], navAimStopId: "", navStopPicked: false, navFix: null, navTravel: 280, navCompass: null,
    navCompassTimer: 0, compassAim: false, navFixTime: 0, navFixAt: 0, navVoiceNow: null,
    navYou: null, navAim: null, navShown: null, turnMarker: null, framingTurn: false, pendingTurn: null,
    navFollowing: false, followPinned: false, navReturnTimer: 0, dirPinned: null, dirPinTimer: 0,
    stopFrameAt: null, stopFrameId: "", stopFrameLayout: "", stopTargetId: "",
    routePinMarkers: [], routePinsHooked: null, routePinsPlain: true,
    turnFrameAt: null, turnFrameTarget: null, turnFrameBearing: null, turnShownKey: "", turnShownAlong: null,
    turnKeepAlong: null, turnLockAlong: null, turnPhase: "approach", turnWidenAt: 0, turnZoomOut: null, turnZoomOutTimer: 0,
    turnPin: null, turnPinHooked: null, turnMaxZoomKept: null,
    truckHit: null, truckHits: [], truckMarkers: [], truckMarker: null, placeListMode: false,
    placeSeek: "walmart", placeSeekFull: true, placeMapMoved: false, placeHereNote: "", pinPeek: null,
    navNearest: (lat, lon, pts) => navMatch.nearestOnPath(lat, lon, pts),
    navOffRoute: () => false,
    navMatchSpan: () => 0,
    navStopTitle: (stop) => stop?.name || "Stop",
    navMiles: (m) => `${(m / 1609.344).toFixed(1)} mi`,
    bannerDirection: () => "",
    styleIsBasemap: () => true,
    safeTopPad: () => SAFE_TOP,
    seatRails: noop,
    syncRouteChrome: noop,
    enableNavCompass: async () => {},
    endRouteNav: () => { calls.ended += 1; context.navOn = false; },
    addPlaceAsNextStop: async (hit) => { calls.added.push(hit); },
    routePoints: () => context.navLine.slice(),
    cardTitle: (index, stops) => stops[index].name,
    stopColor: () => [200, 80, 40],
    stopInk: () => ({ color: "#fff" }),
    cssRGB: (rgb) => `rgb(${rgb.join(" ")})`,
  };
  for (const name of ON_NAV_FIX_STUBS) context[name] = noop;
  vm.createContext(context);
  vm.runInContext(APP_CODE, context);
  const handler = (args) => vm.runInContext(`[${args}]`, context);
  const buttons = Object.fromEntries(Object.entries(HANDLERS).map(([id, args]) => [id, handler(args)[1]]));
  // mountMap: a click listener on the map container (Build #624), and the box re-seats on every move.
  if (MAP_CLICK) {
    const [type, fn, options] = handler(MAP_CLICK);
    mapEl.addEventListener(type, fn, options);
  }
  map.on("move", () => context.seatTruckLabel?.());
  context.rebuildNavLegs();
  const advance = (ms) => {
    const end = clock.now + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = timers[0];
      if (!next || next.at > end) break;
      timers.shift();
      clock.now = Math.max(clock.now, next.at);
      next.fn();
    }
    clock.now = end;
  };
  return { ctx: context, map, timers, advance, buttons, mapEl };
}

// --- Helpers ---

const cam = (w) => ({ lat: w.map.center.lat, lng: w.map.center.lng, zoom: w.map.zoom, bearing: w.map.bearing });
const sameCam = (a, b) => navMatch.metersBetween([a.lat, a.lng], [b.lat, b.lng]) < 0.5
  && Math.abs(a.zoom - b.zoom) < 1e-6 && Math.abs(((a.bearing - b.bearing + 540) % 360) - 180) < 1e-6;
const fmtCam = (c) => `center ${c.lat.toFixed(5)},${c.lng.toFixed(5)} zoom ${c.zoom.toFixed(3)} bearing ${c.bearing.toFixed(1)}`;
const at = (w, hit) => w.map.project({ lat: hit.lat, lng: hit.lon });
const metersPerPx = (w, lat) => (2 * Math.PI * 6378137 * Math.cos(lat * Math.PI / 180)) / (512 * 2 ** w.map.zoom);

function pinOf(w, hit) {
  return w.ctx.truckMarkers.find((m) => {
    const p = m.getLngLat();
    return Math.abs(p.lat - hit.lat) < 1e-9 && Math.abs(p.lng - hit.lon) < 1e-9;
  });
}

// Tap the numbered dot of `hit` on the map (through the map container, like a finger).
function tapPin(w, hit) {
  const wrap = pinOf(w, hit)?.getElement();
  if (!wrap) throw new Error(`no pin for ${hit.name}`);
  click(wrap.querySelector(".truck-pin") || wrap);
}

// The pin sits in the middle of the clear area with about half a mile to the nearest edge.
function peekOn(w, hit) {
  const p = at(w, hit);
  const mid = (CLEAR.left + CLEAR.right) / 2;
  const tall = CLEAR.bottom - CLEAR.top;
  const centered = Math.abs(p.x - mid) <= 3 && p.y >= CLEAR.top + 0.2 * tall && p.y <= CLEAR.bottom - 0.2 * tall;
  const px = Math.min(p.x - CLEAR.left, CLEAR.right - p.x, p.y - CLEAR.top, CLEAR.bottom - p.y);
  const radius = px * metersPerPx(w, hit.lat);
  return { ok: centered && radius >= 0.85 * 805 && radius <= 1.3 * 805, p, radius, centered };
}
const fmtPeek = (r) => `pin at (${r.p.x.toFixed(0)}, ${r.p.y.toFixed(0)}), ${r.radius.toFixed(0)} m to the nearest clear edge`;

const pending = (w) => w.timers.filter((t) => t.at > w.ctx.clock.now).length;

// Set up a mode the way he gets there, with the results on the map.
async function enter(mode) {
  const w = world();
  const { ctx } = w;
  ctx.navFix = HERE.slice();
  ctx.placeNavDot(HERE[0], HERE[1]);
  if (mode === "follow") {
    ctx.tripFit = "remaining";
    ctx.cycleTripFit();
    await w.buttons.routeFollow();
  } else if (mode === "free") {
    ctx.tripFit = "off";
    ctx.navFollowing = false;
    w.map.jumpTo({ center: [-77.3, 40.1], zoom: 9.4, bearing: 25 });
  } else {
    ctx.tripFit = { nextTurn: "remaining", nextStop: "nextTurn", full: "nextStop", remaining: "full" }[mode];
    ctx.cycleTripFit();
  }
  ctx.showTruckHits(HITS, false);
  w.advance(2000);
  return w;
}

const NAMES = { nextTurn: "Turn zoom", nextStop: "Stop zoom", full: "Trip zoom", remaining: "Left zoom", follow: "Follow me", free: "free map (moved by hand)" };

// --- a. Tap a pin: half a mile around it, in the clear area, box still there ---
console.log("a. Tapping a result pin zooms to about half a mile around it, in the clear area");
{
  const w = await enter("nextTurn");
  const before = cam(w);
  tapPin(w, HITS[1]);
  const r = peekOn(w, HITS[1]);
  expect("the camera moved off the Turn zoom view", !sameCam(cam(w), before), fmtCam(cam(w)));
  expect(`pin 2 is centered between the rails (x ${(CLEAR.left + CLEAR.right) / 2}) and in the middle of the clear area (y ${CLEAR.top}..${CLEAR.bottom})`,
    r.centered, fmtPeek(r));
  expect("about half a mile (805 m) shows from the pin to the nearest clear edge", r.ok, fmtPeek(r));
  const mpp = metersPerPx(w, HITS[1].lat);
  const dLat = 805 / 111320;
  const dLon = 805 / (111320 * Math.cos(HITS[1].lat * Math.PI / 180));
  const corners = [[-1, -1], [-1, 1], [1, -1], [1, 1]].map(([a, b]) => w.map.project({ lat: HITS[1].lat + a * dLat, lng: HITS[1].lon + b * dLon }));
  const inClear = corners.every((c) => c.x >= CLEAR.left - 1 && c.x <= CLEAR.right + 1 && c.y >= CLEAR.top - 1 && c.y <= CLEAR.bottom + 1);
  expect("the whole ±805 m square around the pin is inside the clear area", inClear,
    corners.map((c) => `(${c.x.toFixed(0)}, ${c.y.toFixed(0)})`).join(" "));
  expect("…and the map is not zoomed far past it (the square spans at least 85% of the room between the rails)",
    (2 * 805 / mpp) >= 0.85 * (CLEAR.right - CLEAR.left - 32), `${(2 * 805 / mpp).toFixed(0)} px of ${CLEAR.right - CLEAR.left} px`);
  const wrap = pinOf(w, HITS[1])?.getElement();
  const box = wrap?.querySelector(".truck-pin-label");
  expect("pin 2 is the chosen place and has its box with Add and recalculate",
    w.ctx.truckHit === HITS[1] && box && box.querySelector(".truck-pin-add")?.textContent === "Add and recalculate",
    box ? JSON.stringify(box.textContent) : "no box");
  const pinTop = wrap.getBoundingClientRect().top;
  const below = pinTop - 44 - 4 < Math.max(0, TOOLS.bottom) + 8;
  expect("the box flip (above / under its pin) matches where the pin is after the move", wrap.classList.contains("is-below") === below,
    `pin top ${pinTop.toFixed(0)}, is-below ${wrap.classList.contains("is-below")}`);
  expect("a 5 s timer is running", pending(w) === 1 && w.timers.some((t) => Math.abs(t.at - w.ctx.clock.now - 5000) < 1), `${pending(w)} timer(s)`);
}
{
  const w = await enter("nextTurn");
  w.ctx.showTruckHits(HITS, true);
  const before = cam(w);
  const second = w.mapEl && w.ctx.document.getElementById("nextPlaceList").elements()[1];
  click(second);
  expect("the list under the page map only chooses the place (no zoom, no timer)",
    w.ctx.truckHit === HITS[1] && sameCam(cam(w), before) && pending(w) === 0, `${pending(w)} timer(s), ${fmtCam(cam(w))}`);
}

// --- b. After 5 s, back to the mode he was in ---
console.log("\nb. After 5 seconds the map goes back to the zoom mode he was in");
for (const mode of ["nextTurn", "nextStop", "follow", "full", "remaining", "free"]) {
  const w = await enter(mode);
  const before = cam(w);
  const fit = w.ctx.tripFit;
  const following = w.ctx.navFollowing;
  tapPin(w, HITS[0]);
  w.advance(4900);
  const held = peekOn(w, HITS[0]);
  w.advance(200);
  const back = cam(w);
  expect(`${NAMES[mode]}: on the pin until 5 s, then back to the ${NAMES[mode]} view`,
    held.ok && sameCam(back, before) && w.ctx.tripFit === fit && w.ctx.navFollowing === following,
    `at 4.9 s ${fmtPeek(held)}; after: ${fmtCam(back)} vs ${fmtCam(before)}, mode ${w.ctx.tripFit}/${w.ctx.navFollowing}`);
}

// --- c. Another tap during the 5 s ---
console.log("\nc. Another tap during the 5 seconds jumps there and starts the 5 seconds again");
{
  const w = await enter("nextTurn");
  const before = cam(w);
  tapPin(w, HITS[0]);
  w.advance(3000);
  tapPin(w, HITS[2]);
  const moved = peekOn(w, HITS[2]);
  expect("a tap on pin 3 at 3 s jumps to half a mile around pin 3", moved.ok && w.ctx.truckHit === HITS[2], fmtPeek(moved));
  w.advance(3000);
  const still = peekOn(w, HITS[2]);
  expect("…6 s after the first tap it is still on pin 3 (the 5 s started again)", still.ok, fmtPeek(still));
  w.advance(2100);
  expect("…and 5 s after the second tap it is back in Turn zoom", sameCam(cam(w), before) && w.ctx.tripFit === "nextTurn",
    `${fmtCam(cam(w))} vs ${fmtCam(before)}`);
  expect("…with no timer left over", pending(w) === 0, `${pending(w)} timer(s)`);
}
{
  const w = await enter("nextStop");
  const before = cam(w);
  tapPin(w, HITS[1]);
  w.advance(3000);
  w.map.jumpTo({ center: [HITS[1].lon + 0.05, HITS[1].lat + 0.03] });
  tapPin(w, HITS[1]);
  const again = peekOn(w, HITS[1]);
  expect("tapping the same pin again centers it again", again.ok, fmtPeek(again));
  w.advance(3000);
  const still = peekOn(w, HITS[1]);
  expect("…and starts the 5 s again (still on it 6 s after the first tap)", still.ok, fmtPeek(still));
  w.advance(2100);
  expect("…then back to Stop zoom", sameCam(cam(w), before) && w.ctx.tripFit === "nextStop", `${fmtCam(cam(w))} vs ${fmtCam(before)}`);
}

// --- d. Actions that stop the 5 s ---
console.log("\nd. Add and recalculate, Clear, the zoom button, Follow me, End navigation and a map rebuild stop the 5 seconds");

// The same action without a pin tap first, for "works as before".
async function control(mode, act) {
  const w = await enter(mode);
  await act(w);
  return { cam: cam(w), fit: w.ctx.tripFit, following: w.ctx.navFollowing };
}

{
  const w = await enter("nextTurn");
  tapPin(w, HITS[1]);
  const armed = pending(w) === 1;
  const add = pinOf(w, HITS[1]).getElement().querySelector(".truck-pin-add");
  click(add);
  const after = cam(w);
  w.advance(6000);
  expect("Add and recalculate: the 5 s timer was running and is gone, and the map does not jump back after it",
    armed && pending(w) === 0 && sameCam(cam(w), after) && w.ctx.navZoomHold <= w.ctx.clock.now,
    `armed ${armed}, ${pending(w)} timer(s), hold ${w.ctx.navZoomHold > w.ctx.clock.now ? "still on" : "off"}`);
  expect("…and it adds that place as before", w.ctx.calls.added.length === 1 && w.ctx.calls.added[0] === HITS[1] && w.ctx.truckHits.length === 0,
    `${w.ctx.calls.added.length} add(s)`);
}
{
  const clear = (w) => w.buttons.routePlaceClear();
  const want = await control("nextStop", clear);
  const w = await enter("nextStop");
  tapPin(w, HITS[1]);
  const armed = pending(w) === 1;
  clear(w);
  const after = cam(w);
  w.advance(6000);
  expect("Clear: the 5 s timer was running and is gone, and the map does not jump back after it",
    armed && pending(w) === 0 && sameCam(cam(w), after), `armed ${armed}, ${pending(w)} timer(s)`);
  expect("…and Clear works as before (pins gone, Turn zoom, same view as without the tap)",
    w.ctx.truckHits.length === 0 && w.ctx.tripFit === "nextTurn" && sameCam(cam(w), want.cam), `${fmtCam(cam(w))} vs ${fmtCam(want.cam)}`);
}
{
  const press = (w) => w.buttons.routeWhole();
  const want = await control("nextTurn", press);
  const w = await enter("nextTurn");
  tapPin(w, HITS[0]);
  const armed = pending(w) === 1;
  press(w);
  const after = cam(w);
  w.advance(6000);
  expect("the zoom button: the 5 s timer was running and is gone, and the map does not jump back after it",
    armed && pending(w) === 0 && sameCam(cam(w), after), `armed ${armed}, ${pending(w)} timer(s)`);
  expect("…and it goes on to Stop zoom as before (same view as without the tap)",
    w.ctx.tripFit === "nextStop" && sameCam(cam(w), want.cam), `${w.ctx.tripFit}, ${fmtCam(cam(w))} vs ${fmtCam(want.cam)}`);
  expect("…and Stop zoom follows the GPS again right away", w.ctx.navZoomHold <= w.ctx.clock.now + 700, `hold ends in ${w.ctx.navZoomHold - w.ctx.clock.now} ms`);
}
{
  const press = (w) => w.buttons.routeFollow();
  const want = await control("nextTurn", press);
  const w = await enter("nextTurn");
  tapPin(w, HITS[0]);
  const armed = pending(w) === 1;
  await press(w);
  const after = cam(w);
  w.advance(6000);
  expect("Follow me: the 5 s timer was running and is gone, and the map does not jump back to Turn zoom",
    armed && pending(w) === 0 && sameCam(cam(w), after) && w.ctx.tripFit === "off" && w.ctx.navFollowing,
    `armed ${armed}, ${pending(w)} timer(s), ${w.ctx.tripFit}/${w.ctx.navFollowing}`);
  expect("…and Follow me shows you as before", sameCam(cam(w), want.cam), `${fmtCam(cam(w))} vs ${fmtCam(want.cam)}`);
}
{
  const w = await enter("nextTurn");
  tapPin(w, HITS[0]);
  const armed = pending(w) === 1;
  w.buttons.endNav();
  expect("End navigation: the 5 s timer was running and is gone", armed && pending(w) === 0 && w.ctx.calls.ended === 1,
    `armed ${armed}, ${pending(w)} timer(s)`);
}
{
  const w = await enter("nextTurn");
  tapPin(w, HITS[0]);
  const armed = pending(w) === 1;
  const old = w.map;
  w.ctx.clearRouteMap();
  let threw = "";
  try { w.advance(6000); } catch (err) { threw = String(err.message || err); }
  expect("the map is rebuilt: the 5 s timer was running and is gone, nothing fires on the old map",
    armed && pending(w) === 0 && old.removed && !threw && w.ctx.routeMap === null, threw || `armed ${armed}, ${pending(w)} timer(s)`);
}

// --- e. GPS during the 5 s ---
console.log("\ne. GPS updates during the 5 seconds do not move the map off the pin");
{
  const w = await enter("nextTurn");
  tapPin(w, HITS[1]);
  const peek = cam(w);
  w.advance(1000);
  w.ctx.onNavFix(AHEAD[0], AHEAD[1], w.ctx.clock.now);
  w.advance(500);
  w.ctx.snapNavLock();
  w.ctx.onNavCompass({ webkitCompassHeading: 95 });
  const r = peekOn(w, HITS[1]);
  expect("Turn zoom: a new GPS fix, a resume and a compass turn leave the map on the pin",
    r.ok && sameCam(cam(w), peek), `${fmtPeek(r)}; ${fmtCam(cam(w))} vs ${fmtCam(peek)}`);
  w.advance(3600);
  const want = world();
  want.ctx.navFix = AHEAD.slice();
  want.ctx.navCompass = 95;
  want.ctx.placeNavDot(AHEAD[0], AHEAD[1]);
  want.ctx.tripFit = "remaining";
  want.ctx.cycleTripFit();
  expect("…after 5 s Turn zoom frames once, from where he is now", sameCam(cam(w), cam(want)) && w.ctx.tripFit === "nextTurn",
    `${fmtCam(cam(w))} vs ${fmtCam(cam(want))}`);
}
{
  const w = await enter("nextStop");
  tapPin(w, HITS[2]);
  const peek = cam(w);
  w.advance(1000);
  w.ctx.onNavFix(AHEAD[0], AHEAD[1], w.ctx.clock.now);
  const r = peekOn(w, HITS[2]);
  expect("Stop zoom: a new GPS fix leaves the map on the pin", r.ok && sameCam(cam(w), peek), fmtPeek(r));
}
{
  const w = await enter("follow");
  tapPin(w, HITS[0]);
  const peek = cam(w);
  w.advance(1000);
  w.ctx.onNavFix(AHEAD[0], AHEAD[1], w.ctx.clock.now);
  w.ctx.navShown = { lat: AHEAD[0], lon: AHEAD[1] };
  w.ctx.paintNavMotion(w.ctx.clock.now);
  const r = peekOn(w, HITS[0]);
  expect("Follow me: the moving dot does not pull the map off the pin", r.ok && sameCam(cam(w), peek), fmtPeek(r));
  w.advance(4100);
  const c = cam(w);
  expect("…after 5 s it follows you again", navMatch.metersBetween([c.lat, c.lng], AHEAD) < 1 && Math.abs(c.zoom - 15) < 1e-6,
    fmtCam(c));
}

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
