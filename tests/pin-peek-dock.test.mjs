// Build #625: tapping a search result pin zooms to about a quarter mile (402 m)
// around it, and for those 5 s its box (name, miles, Add and recalculate) is
// docked out of the way: at the top of the clear area just under Search here /
// Clear, centered between the rails, or just above the ETA when the top has no
// room. The fit keeps the pin and its ±402 m area clear of the docked box, the
// box stays still while the map moves, another pin tap shows that place in it,
// and Add and recalculate in it still works. After the 5 s, and on Add and
// recalculate, Clear, the zoom button, Follow me, Start / End navigation and a
// map rebuild, the box goes back by its pin.
// Not loaded by the site.
// Run: node tests/pin-peek-dock.test.mjs
// Against other copies: APP_JS=/path/to/app.js CSS_FILE=/path/to/styles.css node tests/pin-peek-dock.test.mjs
//
// Same sandbox as tests/pin-peek.test.mjs: the real pin painters, trip-fit
// framing, the peek and the tap wiring (mountMap's map click and move
// listeners, bind()'s button handlers) from js/app.js, over a fake MapLibre map
// with real Web Mercator math, a fake clock and fake timers. Where the box
// shows on screen comes from the .truck-pin-label rules in styles.css plus its
// inline style. The screen is the full-screen map (390x844).

import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appSource = readFileSync(process.env.APP_JS || path.join(root, "js/app.js"), "utf8");
const cssSource = readFileSync(process.env.CSS_FILE || path.join(root, "styles.css"), "utf8");
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

// The arguments of `<prefix>"<type>", …)` inside `body`, e.g. `"click", () => cycleTripFit()`.
function listenerArgs(body, prefix, type) {
  const at = body.indexOf(`${prefix}"${type}"`);
  if (at < 0) return "";
  const open = at + prefix.length - 1;
  return body.slice(open + 1, skipBalanced(body, open, "(", ")") - 1);
}
const clickArgs = (body, prefix) => listenerArgs(body, prefix, "click");

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
// The 5 s peek from Build #624.
const PEEK_FUNCTIONS = ["onRouteMapClick", "peekTruckHit", "pinPeekPadding", "showPinPeek", "cancelPinPeek", "endPinPeek"];
const APP_CONSTS = [
  "MERCATOR_MPP0", "FULL_TURN_TOP_PX", "FULL_TURN_MAX_ZOOM", "NAV_DOT_HALO_PX", "NAV_DOT_CHIP_GAP_PX",
  "TURN_PIN_MAX_ZOOM", "TURN_PIN_HOLD_M", "TURN_PIN_HOLD_OUT_M", "TURN_PIN_PAST_M", "TURN_PIN_EASE_MS",
  "TURN_PIN_AFTER_MIN_M", "TURN_PIN_AFTER_MAX_M",
];
const PEEK_CONSTS = ["PIN_PEEK_MS", "PIN_PEEK_M"];

const APP_CODE = [
  ...APP_CONSTS.map((name) => constLine(appSource, name)),
  ...PEEK_CONSTS.map((name) => constLine(appSource, name)),
  ...APP_FUNCTIONS.map((name) => extract(appSource, name)),
  ...PEEK_FUNCTIONS.map((name) => extract(appSource, name)),
].join("\n\n");

// How the app wires the taps: bind()'s button handlers, and mountMap's click
// listener on the map and its listener for every map move.
const BIND = extract(appSource, "bind");
const HANDLERS = Object.fromEntries(["routeWhole", "routeFollow", "routePlaceClear", "startNav", "endNav"].map((id) => {
  const args = clickArgs(BIND, `$("#${id}")?.addEventListener(`);
  if (!args) throw new Error(`bind() has no click handler for #${id}`);
  return [id, args];
}));
const MOUNT = extract(appSource, "mountMap");
const MAP_CLICK = clickArgs(MOUNT, "el.addEventListener(");
const MAP_MOVE = listenerArgs(MOUNT, "map.on(", "move");
if (!MAP_CLICK || !MAP_MOVE) throw new Error("mountMap has no map click or move listener");

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
  // The box wraps its text at about 28 characters a line, over the 40px button row.
  get offsetHeight() {
    if (this.classList.contains("truck-pin-label")) {
      const text = this.querySelector(".truck-pin-text")?.textContent || "";
      return 16 * Math.max(1, Math.ceil(text.length / 28)) + 40;
    }
    if (this.classList.contains("truck-pin-wrap")) return 26;
    return this.classList.contains("route-you") ? 24 : 0;
  }
  get offsetWidth() {
    if (this.classList.contains("truck-pin-label")) return 200;
    return this.classList.contains("truck-pin-wrap") ? 26 : 24;
  }
  getBoundingClientRect() {
    if (this.box) return this.box();
    // A result pin: anchored at the bottom of its 26px dot.
    if (this.marker?.map && this.classList.contains("truck-pin-wrap")) {
      const at = this.marker.map.project(this.marker.getLngLat());
      return rect(at.x - 13, at.y - 26, 26, 26);
    }
    const wrap = this.parent;
    if (this.classList.contains("truck-pin-label") && wrap?.marker?.map) return placeBox(this, wrap);
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

// --- Where styles.css puts the box: its rules for .truck-pin-label, then the inline style ---

function parseCss(source) {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("{", i);
    if (open < 0) break;
    const head = text.slice(i, open).trim();
    let close = open + 1;
    for (let depth = 1; close < text.length && depth; close += 1) {
      if (text[close] === "{") depth += 1;
      else if (text[close] === "}") depth -= 1;
    }
    if (!head.startsWith("@")) {
      const decls = {};
      for (const part of text.slice(open + 1, close - 1).split(";")) {
        const colon = part.indexOf(":");
        if (colon > 0) decls[part.slice(0, colon).trim()] = part.slice(colon + 1).trim();
      }
      for (const selector of head.split(",").map((s) => s.trim().replace(/\s+/g, " "))) rules.push({ selector, decls });
    }
    i = close;
  }
  return rules;
}
const LABEL_RULES = parseCss(cssSource)
  .filter((r) => /(^|\s)\.truck-pin-label$/.test(r.selector) && /^[\w\s.#-]+$/.test(r.selector))
  .map((r, order) => ({ ...r, order, weight: (r.selector.match(/[.#]/g) || []).length }))
  .sort((a, b) => a.weight - b.weight || a.order - b.order);

// "50%", "12px", "calc(100% + 4px)" against the wrap's size; null for auto.
function cssLength(value, size) {
  if (value == null || value === "auto" || value === "") return null;
  const v = String(value).replace(/^calc\((.*)\)$/, "$1");
  let total = 0;
  for (const m of v.matchAll(/([+-]?)\s*(-?[\d.]+)(px|%)/g)) {
    const n = Number(m[2]) * (m[3] === "%" ? size / 100 : 1);
    total += m[1] === "-" ? -n : n;
  }
  return total;
}

function placeBox(label, wrap) {
  const css = {};
  for (const r of LABEL_RULES) if (label.matches(r.selector)) Object.assign(css, r.decls);
  for (const key of ["left", "top", "bottom", "transform"]) if (label.style[key]) css[key] = label.style[key];
  const pin = wrap.getBoundingClientRect();
  const w = label.offsetWidth;
  const h = label.offsetHeight;
  const shift = /translateX\(\s*-50%\s*\)/.test(css.transform || "") ? -w / 2 : 0;
  const left = pin.left + (cssLength(css.left, pin.width) ?? 0) + shift;
  const top = cssLength(css.top, pin.height);
  const bottom = cssLength(css.bottom, pin.height);
  const y = top != null ? pin.top + top : pin.top + pin.height - (bottom ?? 0) - h;
  return rect(left, y, w, h);
}

// --- The full-screen map (390x844, notch 47px), Search here / Clear at the top ---

const WIDTH = 390;
const HEIGHT = 844;
const SAFE_TOP = 47;
const STACK_TOP = 580;
const RAILS = [rect(8, 270, 60, 300), rect(322, 270, 60, 300)];
const TOOLS = rect(76, SAFE_TOP + 8, 238, 36);

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

function world({ tools = TOOLS, stackTop = STACK_TOP } = {}) {
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
    routePlaceTools: Object.assign(new FakeEl("div", "routePlaceTools"), { box: () => tools }),
    nextPlaceList: new FakeEl("div", "nextPlaceList"),
    routeRecalc: { getBoundingClientRect: () => rect(322, 450, 60, 60) },
    routeDetour: { getBoundingClientRect: () => rect(8, 330, 60, 60) },
    routeCompass: { getBoundingClientRect: () => rect(322, 330, 60, 60) },
    routeStopMiles: { getBoundingClientRect: () => rect(100, stackTop, 190, 26) },
    routeDirections: { hidden: false, getBoundingClientRect: () => rect(8, stackTop + 30, 374, HEIGHT - 8 - stackTop - 30) },
    routeWhole: { innerHTML: "", setAttribute: noop, classList: { toggle: noop } },
  };
  const stack = { hidden: false, getBoundingClientRect: () => rect(8, stackTop, 374, HEIGHT - 8 - stackTop) };
  const rails = RAILS.map((box) => ({ getBoundingClientRect: () => box }));
  const map = new FakeMap(mapEl);
  const markerEls = () => (context.routeMap ? context.routeMap.markers.map((m) => m.el) : []);
  const all = () => [...Object.values(els).filter((el) => el instanceof FakeEl), ...markerEls()].flatMap((el) => [el, ...el.descendants()]);
  const calls = { added: [], ended: 0, started: 0 };
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
    unlockNavVoice: noop,
    beginRouteNav: async () => { calls.started += 1; },
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
  // mountMap: the click listener on the map container and the listener for every map move.
  const [type, fn, options] = handler(MAP_CLICK);
  mapEl.addEventListener(type, fn, options);
  const [moveType, onMove] = handler(MAP_MOVE);
  map.on(moveType, onMove);
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
  // What nothing covers: between the rails, under Search here / Clear, above the ETA and the directions.
  const clear = { left: RAILS[0].right, right: RAILS[1].left, top: tools.bottom, bottom: stackTop };
  return { ctx: context, map, timers, advance, buttons, mapEl, tools, stackTop, clear, onMove };
}

// --- Helpers ---

const RADIUS = 402;
const cam = (w) => ({ lat: w.map.center.lat, lng: w.map.center.lng, zoom: w.map.zoom, bearing: w.map.bearing });
const sameCam = (a, b) => navMatch.metersBetween([a.lat, a.lng], [b.lat, b.lng]) < 0.5
  && Math.abs(a.zoom - b.zoom) < 1e-6 && Math.abs(((a.bearing - b.bearing + 540) % 360) - 180) < 1e-6;
const fmtCam = (c) => `center ${c.lat.toFixed(5)},${c.lng.toFixed(5)} zoom ${c.zoom.toFixed(3)} bearing ${c.bearing.toFixed(1)}`;
const at = (w, hit) => w.map.project({ lat: hit.lat, lng: hit.lon });
const metersPerPx = (w, lat) => (2 * Math.PI * 6378137 * Math.cos(lat * Math.PI / 180)) / (512 * 2 ** w.map.zoom);
const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;
const fmtBox = (b) => (b ? `(${b.left.toFixed(1)}, ${b.top.toFixed(1)})-(${b.right.toFixed(1)}, ${b.bottom.toFixed(1)})` : "none");
const overlap = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
const pending = (w) => w.timers.filter((t) => t.at > w.ctx.clock.now).length;

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

// The chosen pin, its box, and where both are on screen.
function chosen(w) {
  const wrap = w.ctx.document.querySelector(".truck-pin-wrap.is-chosen");
  const label = wrap?.querySelector(".truck-pin-label") || null;
  return { wrap, label, box: label ? label.getBoundingClientRect() : null, pin: wrap ? wrap.getBoundingClientRect() : null };
}

// The ±402 m square around a place, on screen.
function square(w, hit, m = RADIUS) {
  const dLat = m / 111320;
  const dLon = m / (111320 * Math.cos(hit.lat * Math.PI / 180));
  const pts = [[-1, -1], [-1, 1], [1, -1], [1, 1]].map(([a, b]) => w.map.project({ lat: hit.lat + a * dLat, lng: hit.lon + b * dLon }));
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  return rect(Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
}

// Docked: at the top just under Search here / Clear, or at the bottom just above
// the ETA, centered between the rails either way.
function docked(w, side = "top") {
  const { box } = chosen(w);
  if (!box) return { ok: false, detail: "no box" };
  const mid = (w.clear.left + w.clear.right) / 2;
  const level = side === "top"
    ? box.top >= w.tools.bottom && box.top <= w.tools.bottom + 16
    : box.bottom <= w.stackTop && box.bottom >= w.stackTop - 16;
  const centered = near((box.left + box.right) / 2, mid, 2) && box.left >= w.clear.left && box.right <= w.clear.right;
  const what = side === "top" ? `Search here / Clear end at y ${w.tools.bottom}` : `the ETA starts at y ${w.stackTop}`;
  return { ok: level && centered, detail: `box ${fmtBox(box)}; ${what}; rails ${w.clear.left}..${w.clear.right}` };
}

// The pin and its ±402 m area are inside the clear area and not under the box.
function areaClear(w, hit) {
  const { box, pin } = chosen(w);
  const sq = square(w, hit);
  const c = w.clear;
  const inside = sq.left >= c.left - 1 && sq.right <= c.right + 1 && sq.top >= c.top - 1 && sq.bottom <= c.bottom + 1;
  const ok = Boolean(box) && inside && !overlap(sq, box) && !overlap(pin, box);
  return { ok, detail: `±402 m ${fmtBox(sq)}, pin ${fmtBox(pin)}, box ${fmtBox(box)}, clear (${c.left}, ${c.top})-(${c.right}, ${c.bottom})` };
}

// About 402 m from the pin to the nearest edge of what is left open: the clear
// area minus the box.
function radiusOn(w, hit) {
  const p = at(w, hit);
  const { box } = chosen(w);
  const c = w.clear;
  const top = Math.max(c.top, box && box.bottom <= p.y ? box.bottom : -Infinity);
  const bottom = Math.min(c.bottom, box && box.top >= p.y ? box.top : Infinity);
  const px = Math.min(p.x - c.left, c.right - p.x, p.y - top, bottom - p.y);
  const radius = px * metersPerPx(w, hit.lat);
  const span = 2 * RADIUS / metersPerPx(w, hit.lat);
  const ok = radius >= 0.85 * RADIUS && radius <= 1.3 * RADIUS && span >= 0.85 * (c.right - c.left - 32);
  return { ok, detail: `pin at (${p.x.toFixed(0)}, ${p.y.toFixed(0)}), ${radius.toFixed(0)} m to the nearest open edge, ±402 m spans ${span.toFixed(0)} px` };
}

// Back by its pin the normal way: right above it (or under it when flipped),
// centered on it, with nothing left of the dock.
function byPin(w) {
  const { wrap, label, box, pin } = chosen(w);
  if (!box) return { ok: false, detail: "no box" };
  const below = wrap.classList.contains("is-below");
  const touching = below ? near(box.top, pin.bottom + 4) : near(box.bottom, pin.top - 4);
  const centered = near((box.left + box.right) / 2, (pin.left + pin.right) / 2);
  const clean = !wrap.classList.contains("is-docked") && !label.style.left && !label.style.top
    && !w.mapEl.classList.contains("is-pin-dock");
  return {
    ok: touching && centered && clean,
    detail: `box ${fmtBox(box)}, pin ${fmtBox(pin)} (${below ? "under" : "above"} it), class "${wrap.className}", inline left "${label.style.left || ""}" top "${label.style.top || ""}"`,
  };
}

const boxText = (w) => chosen(w).label?.querySelector(".truck-pin-text")?.textContent || "";

// Set up a mode the way he gets there, with the results on the map.
async function enter(mode, layout = {}) {
  const w = world(layout);
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

// Search here / Clear with the status line under them (two rows), and the
// directions open higher up: the box would reach into a plain ±402 m fit.
const BUSY = { tools: rect(76, SAFE_TOP + 8, 238, 80), stackTop: 480 };
// Search here / Clear take up most of the top: no room for the box there.
const CROWDED = { tools: rect(76, SAFE_TOP + 8, 238, 330), stackTop: STACK_TOP };

// --- a. A quarter mile around the pin ---
console.log("a. Tapping a result pin zooms to about a quarter mile (402 m) around it");
{
  const w = await enter("nextTurn");
  const first = byPin(w);
  expect("before the tap the chosen box sits by its pin as before", first.ok, first.detail);
  tapPin(w, HITS[1]);
  const r = radiusOn(w, HITS[1]);
  expect("about 402 m shows from pin 2 to the nearest open edge, and ±402 m fills the room between the rails", r.ok, r.detail);
  expect("a 5 s timer is running", pending(w) === 1 && w.timers.some((t) => Math.abs(t.at - w.ctx.clock.now - 5000) < 1), `${pending(w)} timer(s)`);
}

// --- b. The box is docked during the 5 s, and the fit keeps the pin's area clear of it ---
console.log("\nb. During the 5 seconds the box is docked out of the way, and the pin's area is clear of it");
{
  const w = await enter("nextTurn");
  tapPin(w, HITS[1]);
  const d = docked(w, "top");
  expect("the box is at the top of the clear area, just under Search here / Clear, centered between the rails", d.ok, d.detail);
  const c = areaClear(w, HITS[1]);
  expect("…and the pin and its ±402 m area are below it, inside the clear area", c.ok, c.detail);
  const { wrap, label } = chosen(w);
  expect("…it is still pin 2's box, with its text and Add and recalculate",
    pinOf(w, HITS[1])?.getElement() === wrap && /^2\. Walmart Supercenter · 88\.2 miles ahead · 1\.6 miles off the route$/.test(boxText(w))
      && label?.querySelector(".truck-pin-add")?.textContent === "Add and recalculate",
    JSON.stringify(boxText(w)));
  w.advance(4900);
  const still = docked(w, "top");
  expect("…and it is still docked at 4.9 s", still.ok, still.detail);
}
{
  const w = await enter("nextStop", BUSY);
  tapPin(w, HITS[0]);
  const d = docked(w, "top");
  expect("with two rows under Search here / Clear and the directions open: docked just under them", d.ok, d.detail);
  const c = areaClear(w, HITS[0]);
  expect("…and the fit leaves room for the box: the pin and its ±402 m area are below it", c.ok, c.detail);
}
{
  const w = await enter("nextTurn", CROWDED);
  tapPin(w, HITS[2]);
  const d = docked(w, "bottom");
  expect("no room at the top: the box docks at the bottom, just above the ETA, centered between the rails", d.ok, d.detail);
  const c = areaClear(w, HITS[2]);
  expect("…and the pin and its ±402 m area are above it, below Search here / Clear", c.ok, c.detail);
}

// --- c. The docked box stays put while the map moves ---
console.log("\nc. The docked box stays put while the map moves to the pin");
{
  const w = await enter("nextTurn");
  const from = cam(w);
  tapPin(w, HITS[1]);
  const to = cam(w);
  const spot = chosen(w).box;
  // MapLibre's 600 ms ease: the camera steps from the old view to the peek, one move event a frame.
  let drift = 0;
  let pinMoved = 0;
  let last = null;
  for (let i = 0; i <= 12; i += 1) {
    const t = i / 12;
    w.map.center = { lat: from.lat + (to.lat - from.lat) * t, lng: from.lng + (to.lng - from.lng) * t };
    w.map.zoom = from.zoom + (to.zoom - from.zoom) * t;
    w.map.bearing = from.bearing * (1 - t);
    w.map.fire("move");
    const { box, pin } = chosen(w);
    drift = Math.max(drift, Math.abs(box.left - spot.left), Math.abs(box.top - spot.top));
    if (last) pinMoved = Math.max(pinMoved, Math.hypot(pin.left - last.left, pin.top - last.top));
    last = pin;
  }
  w.map.fire("moveend");
  expect("on every frame the box is where it docked (the pin moves under the map, the box does not)",
    spot && drift <= 1 && pinMoved > 20, `box drifts up to ${drift.toFixed(2)} px while the pin moves up to ${pinMoved.toFixed(0)} px a frame`);
  const d = docked(w, "top");
  expect("…and it is still docked when the move ends", d.ok, d.detail);
}

// --- d. Another pin during the 5 s ---
console.log("\nd. Tapping another pin during the 5 seconds shows that place in the docked box");
{
  const w = await enter("nextTurn");
  tapPin(w, HITS[0]);
  w.advance(3000);
  tapPin(w, HITS[2]);
  const boxes = w.ctx.document.querySelectorAll(".truck-pin-label");
  expect("the box now shows pin 3 (and it is the only box)",
    boxes.length === 1 && /^3\. Walmart · 117\.3 miles ahead · 0\.4 miles off the route$/.test(boxText(w)) && pinOf(w, HITS[2])?.getElement() === chosen(w).wrap,
    `${boxes.length} box(es), ${JSON.stringify(boxText(w))}`);
  const d = docked(w, "top");
  expect("…docked at the top as before", d.ok, d.detail);
  const c = areaClear(w, HITS[2]);
  expect("…with pin 3 and its ±402 m area below it", c.ok, c.detail);
  const want = await enter("nextTurn");
  want.ctx.selectTruckHit(2);
  tapPin(want, HITS[2]);
  expect("…framed for pin 3's own box (same view as tapping pin 3 when it was already chosen)", sameCam(cam(w), cam(want)),
    `${fmtCam(cam(w))} vs ${fmtCam(cam(want))}`);
  w.advance(4900);
  const held = docked(w, "top");
  expect("…still docked 4.9 s after the second tap", held.ok, held.detail);
  w.advance(200);
  const back = byPin(w);
  expect("…and back by pin 3 5 s after the second tap", back.ok, back.detail);
}

// --- e. Add and recalculate in the docked box ---
console.log("\ne. Add and recalculate in the docked box works as before");
{
  const w = await enter("nextTurn");
  tapPin(w, HITS[1]);
  const wasDocked = docked(w, "top").ok;
  const add = chosen(w).label?.querySelector(".truck-pin-add");
  click(add);
  const after = cam(w);
  const back = byPin(w);
  expect("tapping it in the docked box stops the 5 s and the box goes back by its pin",
    wasDocked && back.ok && !w.timers.some((t) => t.at - w.ctx.clock.now > 1000), `docked before: ${wasDocked}; ${back.detail}`);
  w.advance(6000);
  expect("…it adds that place as before, and the map does not jump back after the 5 s",
    w.ctx.calls.added.length === 1 && w.ctx.calls.added[0] === HITS[1] && w.ctx.truckHits.length === 0 && sameCam(cam(w), after),
    `${w.ctx.calls.added.length} add(s), ${w.ctx.truckHits.length} pin(s) left`);
  w.ctx.state.estimating = false;
  w.ctx.showTruckHits(HITS, false);
  const fresh = byPin(w);
  expect("…and the next search's box sits by its pin, not docked", fresh.ok, fresh.detail);
}

// --- f. After the 5 s, and on every other stop, the box goes back by its pin ---
console.log("\nf. After the 5 seconds, and when they are stopped, the box goes back by its pin");
for (const mode of ["nextTurn", "nextStop", "follow", "full", "remaining", "free"]) {
  const w = await enter(mode);
  tapPin(w, HITS[0]);
  w.advance(4900);
  const held = docked(w, "top");
  w.advance(200);
  const back = byPin(w);
  expect(`${NAMES[mode]}: docked until 5 s, then back by its pin`, held.ok && back.ok, `${held.detail} → ${back.detail}`);
}
{
  const w = await enter("nextStop");
  tapPin(w, HITS[1]);
  const wasDocked = docked(w, "top").ok;
  w.buttons.routePlaceClear();
  const gone = w.ctx.truckMarkers.length === 0 && !w.mapEl.classList.contains("is-pin-dock");
  w.ctx.showTruckHits(HITS, false);
  w.advance(6000);
  const back = byPin(w);
  expect("Clear: docked before; the pins go, and the next search's box sits by its pin", wasDocked && gone && back.ok,
    `docked before: ${wasDocked}, pins gone: ${gone}; ${back.detail}`);
}
for (const [label, act] of [
  ["the zoom button", (w) => w.buttons.routeWhole()],
  ["Follow me", (w) => w.buttons.routeFollow()],
  ["Start navigation", (w) => w.buttons.startNav()],
  ["End navigation", (w) => w.buttons.endNav()],
]) {
  const w = await enter("nextTurn");
  tapPin(w, HITS[0]);
  const wasDocked = docked(w, "top").ok;
  await act(w);
  const back = byPin(w);
  w.advance(6000);
  const later = byPin(w);
  expect(`${label}: docked before; right after it the box is back by its pin, and stays there`,
    wasDocked && back.ok && later.ok && pending(w) === 0, `docked before: ${wasDocked}; ${back.detail}; ${pending(w)} timer(s)`);
}
{
  const w = await enter("nextTurn");
  tapPin(w, HITS[0]);
  const wasDocked = docked(w, "top").ok;
  w.ctx.clearRouteMap();
  const undocked = !w.mapEl.classList.contains("is-pin-dock") && w.ctx.truckMarkers.length === 0;
  const fresh = new w.map.constructor(w.mapEl);
  fresh.on("move", w.onMove);
  w.map = fresh;
  w.ctx.routeMap = fresh;
  w.ctx.paintTruckPins();
  w.advance(6000);
  const back = byPin(w);
  expect("map rebuild: docked before; the new map's box sits by its pin", wasDocked && undocked && back.ok,
    `docked before: ${wasDocked}, dock cleared: ${undocked}; ${back.detail}`);
}
{
  const w = await enter("nextTurn");
  w.ctx.showTruckHits(HITS, true);
  click(w.ctx.document.getElementById("nextPlaceList").elements()[1]);
  const back = byPin(w);
  expect("the list under the page map only chooses the place: its box sits by its pin, nothing docks",
    w.ctx.truckHit === HITS[1] && pending(w) === 0 && back.ok, back.detail);
}

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
