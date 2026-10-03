// Build #628: in Trip, Left and Stop zoom the stop chips stand above and below
// the route, each with a line and arrow to its stop, and none covers another
// chip or the buttons. Not loaded by the site.
// Run: node tests/chip-callouts.test.mjs
// Against other copies: APP_JS=/path/to/app.js CSS_FILE=/path/to/styles.css node tests/chip-callouts.test.mjs
//
// The real framing (showWholeTrip, fitCoords, frameNextStop, frameNextTurn)
// and stop chips (addRoutePins, declutterRoutePins) are loaded from js/app.js
// by name into a vm sandbox, over a fake MapLibre map doing real Web Mercator
// math (512px world). The DOM is stubbed to the boxes of the full-screen map in
// the 3:47 PM screenshot (390x844 iPhone). Chip sizes come from the .route-pin
// rules in styles.css. Turn zoom, Follow me and the page map are compared with
// Build #627's app.js from git.

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appSource = readFileSync(process.env.APP_JS || path.join(root, "js/app.js"), "utf8");
const cssSource = readFileSync(process.env.CSS_FILE || path.join(root, "styles.css"), "utf8");
const BUILD_627 = "9f79454";
const navMatch = await import(pathToFileURL(path.join(root, "js/nav-match.js")).href);

function extract(source, name, optional = false) {
  const head = new RegExp(`^(?:async\\s+)?function\\s+${name}\\s*\\(`, "m").exec(source);
  if (!head) {
    if (optional) return "";
    throw new Error(`app.js has no function ${name}`);
  }
  let i = head.index + head[0].length;
  let depth = 1;
  while (depth) {
    const ch = source[i++];
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
  }
  i = source.indexOf("{", i);
  const start = head.index;
  depth = 0;
  let quote = "";
  for (; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      i = source.indexOf("\n", i);
      continue;
    }
    if (ch === "'" || ch === "\"" || ch === "`") quote = ch;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (!depth) return source.slice(start, i + 1);
    }
  }
  throw new Error(`Could not read function ${name}`);
}

function constLine(source, name) {
  const hit = new RegExp(`^const ${name} = [^;]+;`, "m").exec(source);
  if (!hit) throw new Error(`app.js has no const ${name}`);
  return hit[0].replace(/^const /, "var ");
}

const APP_FUNCTIONS = [
  "metersBetween", "polylineMeters", "pointAlong", "stepLengthMeters", "scaledStepLengths", "navStep", "metersLeftInStep",
  "navBearing", "pointAhead", "rebuildNavLegs", "activeNavLeg", "currentDirectionEnd", "turnGuideAlong", "navRemaining",
  "turnViewPadding", "railClearance", "paddingForTurnZoom", "noHandsSlots", "stretchMeters", "mercatorMpp", "cameraForStretch",
  "cameraForFullTurn", "placeTurnPin", "placeNavDot", "showNavCamera", "travelBearing", "frameNextTurn", "clearTurnFrame",
  "stopTurnZoomOut", "syncTripFitButton", "tripFitLines", "cycleTripFit", "aimNavDot", "paintNavMotion",
  "mercatorWorld", "mercatorLngLat", "wrapBearing", "cameraAtSpot", "spotOnCamera", "pinTwoPoints", "roadRoom",
  "turnPinFrame", "hookTurnPinGlide", "settleTurnPin", "framePinnedTurn", "showPinnedTurn",
  "originPoint", "tripViewPadding", "fitCoords", "showWholeTrip", "frameNextStop", "clearRoutePins", "addRoutePins", "routePins",
  "routePinFor", "declutterRoutePins", "hookRoutePinDeclutter", "stopZoomPadding",
];
const APP_CONSTS = [
  "MERCATOR_MPP0", "FULL_TURN_TOP_PX", "FULL_TURN_MAX_ZOOM", "NAV_DOT_HALO_PX", "NAV_DOT_CHIP_GAP_PX",
  "TURN_PIN_MAX_ZOOM", "TURN_PIN_HOLD_M", "TURN_PIN_HOLD_OUT_M", "TURN_PIN_PAST_M", "TURN_PIN_EASE_MS",
  "TURN_PIN_AFTER_MIN_M", "TURN_PIN_AFTER_MAX_M",
];
const appCode = (source) => [
  ...APP_CONSTS.map((name) => constLine(source, name)),
  ...APP_FUNCTIONS.map((name) => extract(source, name)),
].join("\n\n");
const APP_CODE = appCode(appSource);
let CODE_627 = "";
try {
  CODE_627 = appCode(execFileSync("git", ["show", `${BUILD_627}:js/app.js`], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
} catch (err) {
  console.log(`(could not read Build #627's app.js from git: ${String(err.message || err).split("\n")[0]})`);
}

// --- Chip sizes from styles.css ---

function cssDecls(selector) {
  const text = cssSource.replace(/\/\*[\s\S]*?\*\//g, "");
  const decls = new Map();
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(text))) {
    const selectors = m[1].split(",").map((s) => s.trim().replace(/\s+/g, " "));
    if (!selectors.includes(selector)) continue;
    for (const part of m[2].split(";")) {
      const colon = part.indexOf(":");
      if (colon > 0) decls.set(part.slice(0, colon).trim(), part.slice(colon + 1).trim());
    }
  }
  return decls;
}
const PIN = cssDecls(".route-pin");
const TARGET = new Map([...PIN, ...cssDecls(".route-pin.is-target")]);
const MARKER_Z = Number(cssDecls(".route-map .maplibregl-marker").get("z-index")) || 0;

function chipSize(decls, label) {
  const font = parseFloat(decls.get("font-size")) || 12;
  const [py, px = py] = (decls.get("padding") || "3px 8px").split(/\s+/).map(parseFloat);
  const border = parseFloat(decls.get("border")) || 2;
  const line = parseFloat(decls.get("line-height")) || 1.2;
  return {
    w: Math.round(label.length * font * 0.62 + 2 * px + 2 * border),
    h: Math.round(font * line + 2 * py + 2 * border),
  };
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
    this.fits = [];
  }
  getContainer() { return this.el; }
  getZoom() { return this.zoom; }
  getBearing() { return this.bearing; }
  getCenter() { return { ...this.center }; }
  getMaxZoom() { return this.maxZoom; }
  getMinZoom() { return this.minZoom; }
  setMaxZoom(z) { this.maxZoom = z == null ? 22 : z; return this; }
  on(type, fn) { (this.handlers[type] ||= []).push(fn); return this; }
  fire(type) { for (const fn of this.handlers[type] || []) fn({ type }); }
  stop() { return this; }
  redraw() { return this; }
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
    this.fits.push(pad);
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

class FakeMarker {
  constructor({ element }) { this.el = element; this.at = null; this.map = null; }
  setLngLat(v) { this.at = toLngLat(v); return this; }
  getLngLat() { return this.at; }
  addTo(map) { this.map = map; (map.markers ||= []).push(this); return this; }
  remove() { if (this.map) this.map.markers = this.map.markers.filter((m) => m !== this); return this; }
  getElement() { return this.el; }
}

const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top });

class FakeEl {
  constructor() {
    this.className = "";
    this.textContent = "";
    this.innerHTML = "";
    this.style = {};
    this.dataset = {};
    this.isConnected = true;
    const el = this;
    this.classList = {
      contains: (name) => el.className.split(/\s+/).includes(name),
      add: (name) => { if (!el.classList.contains(name)) el.className = `${el.className} ${name}`.trim(); },
      remove: (name) => { el.className = el.className.split(/\s+/).filter((c) => c && c !== name).join(" "); },
      toggle: (name, on = !el.classList.contains(name)) => { if (on) el.classList.add(name); else el.classList.remove(name); return on; },
    };
  }
  size() {
    if (!this.classList.contains("route-pin")) return { w: 24, h: 24 };
    return chipSize(this.classList.contains("is-target") ? TARGET : PIN, this.textContent);
  }
  get offsetWidth() { return this.size().w; }
  get offsetHeight() { return this.size().h; }
  getBoundingClientRect() { return rect(0, 0, this.offsetWidth, this.offsetHeight); }
}

// --- The full-screen map in the screenshot (390x844, notch 47px). ---

const SAFE_TOP = 47;

function page({ code = APP_CODE, stops = STOPS(), tools = true, chosen = null } = {}) {
  const clock = { now: 1_780_000_000_000 };
  class FakeDate extends Date {
    static now() { return clock.now; }
  }
  const layout = { width: 390, height: 844, stackTop: 580, tools, chosen };
  const rails = () => [rect(8, 270, 60, layout.stackTop - 280), rect(layout.width - 68, 270, 60, layout.stackTop - 280)];
  const toolsBox = () => (layout.tools ? rect(76, SAFE_TOP, layout.width - 152, 36) : rect(76, SAFE_TOP, layout.width - 152, 0));
  const etaBox = () => rect(layout.width / 2 - 95, layout.stackTop, 190, 26);
  const dirBox = () => rect(8, layout.stackTop + 30, layout.width - 16, layout.height - 8 - layout.stackTop - 30);
  const stackBox = () => rect(8, layout.stackTop, layout.width - 16, layout.height - 8 - layout.stackTop);
  const children = [];
  const mapEl = {
    id: "routeMap", hidden: false,
    get clientWidth() { return layout.width; },
    get clientHeight() { return layout.height; },
    getBoundingClientRect: () => rect(0, 0, layout.width, layout.height),
    contains: () => true,
    appendChild: (el) => { children.push(el); return el; },
    querySelector: (sel) => children.find((el) => sel === `.${el.className}`) || null,
  };
  const els = {
    routeMap: mapEl,
    routeRecalc: { getBoundingClientRect: () => rect(layout.width - 68, 450, 60, 60) },
    routeDetour: { getBoundingClientRect: () => rect(8, 330, 60, 60) },
    routeCompass: { getBoundingClientRect: () => rect(layout.width - 68, 330, 60, 60) },
    routeStopMiles: { getBoundingClientRect: etaBox },
    routeDirections: { hidden: false, getBoundingClientRect: dirBox },
    routePlaceTools: { getBoundingClientRect: toolsBox },
    routeWhole: { innerHTML: "", setAttribute: noop, classList: { toggle: noop } },
  };
  const stack = { hidden: false, getBoundingClientRect: stackBox };
  const railEls = [0, 1].map((i) => ({ getBoundingClientRect: () => rails()[i] }));
  const chosenEl = { getBoundingClientRect: () => layout.chosen };
  const map = new FakeMap(mapEl);
  const context = {
    console, Math, Number, String, JSON, Array, Object, Infinity, NaN, Set, Map, RegExp, Promise, Error, Boolean,
    Date: FakeDate,
    ...navMatch,
    clock,
    performance: { now: () => clock.now },
    requestAnimationFrame: () => 0,
    routeMapReady: true, navMotion: 0, navMapTouch: false, navZoom: 15, navZoomHold: 0,
    document: {
      getElementById: (id) => els[id] || null,
      querySelector: (sel) => {
        if (sel === "#routeStage .route-bottom") return stack;
        if (sel === ".truck-pin-wrap.is-chosen") return layout.chosen ? chosenEl : null;
        return null;
      },
      querySelectorAll: (sel) => (sel === ".route-stage .route-rail" ? railEls : []),
      createElement: () => new FakeEl(),
    },
    window: { maplibregl: { Marker: FakeMarker, LngLatBounds: FakeBounds }, clearTimeout: noop, setTimeout: () => 0 },
    state: { stops, settings: {} },
    routeMap: map, routeFull: true, tripFit: "nextTurn", navOn: true, northLock: false,
    navLine: [], navLegs: [], navAimStopId: "", navStopPicked: false, navFix: null, navTravel: null,
    navYou: null, navAim: null, navShown: null, turnMarker: null, framingTurn: false,
    navFollowing: false, followPinned: false, navReturnTimer: 0,
    stopFrameAt: null, stopFrameId: "", stopFrameLayout: "", stopTargetId: "",
    routePinMarkers: [], routePinsHooked: null, routePinsPlain: true,
    turnFrameAt: null, turnFrameTarget: null, turnFrameBearing: null, turnShownKey: "", turnShownAlong: null,
    turnKeepAlong: null, turnLockAlong: null, turnPhase: "approach", turnWidenAt: 0, turnZoomOut: null, turnZoomOutTimer: 0,
    turnPin: null, turnPinHooked: null, turnMaxZoomKept: null,
    navNearest: (lat, lon, line) => navMatch.nearestOnPath(lat, lon, line),
    safeTopPad: () => SAFE_TOP,
    seatRails: noop,
    syncRouteChrome: noop,
    routePoints: () => context.navLine.slice(),
    cardTitle: (index, list) => list[index].name,
    stopColor: () => [200, 80, 40],
    stopInk: () => ({ color: "#fff" }),
    cssRGB: (rgb) => `rgb(${rgb.join(" ")})`,
  };
  vm.createContext(context);
  vm.runInContext(code, context);
  context.rebuildNavLegs();
  context.addRoutePins();
  const pg = { ctx: context, map, layout, mapEl, children, rails, toolsBox, etaBox, dirBox, stackBox };
  return pg;
}

// --- The trip: Dayton OH, a Columbus cluster of four stops, then east to New Jersey. ---

const PLACES = {
  start: [39.76, -84.19],
  swft: [39.96, -83.0],
  walmardo: [39.975, -82.95],
  walmart1: [39.95, -82.92],
  walmart2: [39.99, -82.9],
  frank: [40.44, -80.0],
  walmarpu: [40.27, -76.79],
  pilotfue: [40.22, -74.75],
};
const HERE = [39.88, -83.5];

function line(points, stepM = 3000) {
  const out = [];
  for (let i = 1; i < points.length; i += 1) {
    const [a, b] = [points[i - 1], points[i]];
    const n = Math.max(1, Math.ceil(navMatch.metersBetween(a, b) / stepM));
    for (let k = i === 1 ? 0 : 1; k <= n; k += 1) out.push([a[0] + (b[0] - a[0]) * (k / n), a[1] + (b[1] - a[1]) * (k / n)]);
  }
  return out;
}

function leg(id, name, to, via) {
  const pathLL = line(via);
  let meters = 0;
  for (let i = 1; i < pathLL.length; i += 1) meters += navMatch.metersBetween(pathLL[i - 1], pathLL[i]);
  const half = meters / 2 / 1609.344;
  return {
    id, name, lat: to[0], lon: to[1], miles: String(meters / 1609.344), hours: "1", path: pathLL,
    directions: [{ text: "Head east", miles: half }, { text: "Take exit", miles: half }, { text: `Arrive at ${name}`, miles: 0 }],
  };
}

function STOPS() {
  const P = PLACES;
  return [
    { id: "start", name: "START", lat: P.start[0], lon: P.start[1] },
    leg("swft", "SWFT", P.swft, [P.start, HERE, P.swft]),
    leg("walmardo", "WALMARdo", P.walmardo, [P.swft, P.walmardo]),
    leg("walmart1", "Walmart", P.walmart1, [P.walmardo, P.walmart1]),
    leg("walmart2", "Walmart", P.walmart2, [P.walmart1, P.walmart2]),
    leg("frank", "FRANK", P.frank, [P.walmart2, [40.03, -81.59], P.frank]),
    leg("walmarpu", "WALMARpu", P.walmarpu, [P.frank, P.walmarpu]),
    leg("pilotfue", "pilotfue", P.pilotfue, [P.walmarpu, P.pilotfue]),
  ];
}

let failures = 0;
function expect(label, ok, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`);
}

// Where each chip is drawn: its pin, plus the translate the layout gave it.
const chips = (pg) => pg.ctx.routePinMarkers.map((marker) => {
  const el = marker.getElement();
  const at = pg.map.project(marker.getLngLat());
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const [dx = 0, dy = 0] = String(el.style.translate || "").split(/\s+/).map((v) => parseFloat(v) || 0);
  return {
    id: el.dataset.stopId, label: el.textContent, el, at, dx, dy,
    box: { left: at.x + dx - w / 2, right: at.x + dx + w / 2, top: at.y + dy - h, bottom: at.y + dy },
    z: el.style.zIndex ? Number(el.style.zIndex) : MARKER_Z,
    shown: el.style.visibility !== "hidden" && el.style.display !== "none" && !el.hidden && el.style.opacity !== "0",
  };
});
const onScreen = (pg, chip) => chip.at.x >= 0 && chip.at.x <= pg.layout.width && chip.at.y >= 0 && chip.at.y <= pg.layout.height;
const overlap = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
const fmt = (b) => `x ${b.left.toFixed(0)}..${b.right.toFixed(0)}, y ${b.top.toFixed(0)}..${b.bottom.toFixed(0)}`;

// The leader lines in the overlay, by stop id: line start/end and arrow tip.
function leads(pg) {
  const overlay = pg.children.find((el) => el.className === "route-pin-leads");
  const html = overlay?.innerHTML || "";
  const out = new Map();
  for (const g of html.matchAll(/<g data-stop-id="([^"]*)">([\s\S]*?)<\/g>/g)) {
    const num = (s) => s.split(/[ML\sZ]+/).filter(Boolean).map(Number);
    const lineD = /class="line" d="([^"]*)"/.exec(g[2])?.[1] || "";
    const tipD = /class="tip" d="([^"]*)"/.exec(g[2])?.[1] || "";
    const l = num(lineD);
    const t = num(tipD);
    out.set(g[1], { from: { x: l[0], y: l[1] }, to: { x: l[2], y: l[3] }, tip: { x: t[0], y: t[1] } });
  }
  return { html, out };
}

function enterNav(pg, fix = HERE) {
  pg.ctx.navFix = fix.slice();
  pg.ctx.placeNavDot(fix[0], fix[1]);
}
// cycleTripFit goes Trip -> Left -> Turn -> Stop -> Trip.
const BEFORE = { full: "nextStop", remaining: "full", nextTurn: "remaining", nextStop: "nextTurn" };
function enterMode(pg, mode) {
  pg.ctx.clock.now += 1000;
  pg.ctx.tripFit = BEFORE[mode];
  pg.ctx.cycleTripFit();
}

function dotBox(pg) {
  const at = pg.map.project({ lat: pg.ctx.navFix[0], lng: pg.ctx.navFix[1] });
  const r = 12 + pg.ctx.NAV_DOT_HALO_PX;
  return { left: at.x - r, right: at.x + r, top: at.y - r, bottom: at.y + r };
}

// Every check of one callout layout.
function checkCallouts(pg, name, { allShown = true } = {}) {
  const all = chips(pg).filter((chip) => onScreen(pg, chip));
  const shown = all.filter((chip) => chip.shown);
  const hidden = all.filter((chip) => !chip.shown);
  if (allShown) expect(`${name}: every chip on screen is shown (${all.length})`, all.length >= 7 && hidden.length === 0, hidden.map((c) => c.label).join(", "));
  else expect(`${name}: chips shown ${shown.length} of ${all.length}`, shown.length >= 1, hidden.map((c) => `${c.label} hidden`).join(", "));

  const pairs = [];
  for (let i = 0; i < shown.length; i += 1) {
    for (let j = i + 1; j < shown.length; j += 1) if (overlap(shown[i].box, shown[j].box)) pairs.push(`${shown[i].id} ${fmt(shown[i].box)} / ${shown[j].id} ${fmt(shown[j].box)}`);
  }
  expect(`${name}: no two chips overlap`, pairs.length === 0, pairs.join("; "));

  const walls = [
    ["left rail", pg.rails()[0]], ["right rail", pg.rails()[1]], ["ETA chip", pg.etaBox()], ["directions", pg.dirBox()],
    ["bottom stack", pg.stackBox()], ["Search here / Clear", pg.toolsBox()], ["top safe area", rect(0, 0, pg.layout.width, SAFE_TOP)],
  ].filter(([, box]) => box.height > 0);
  const under = [];
  for (const chip of shown) {
    for (const [label, box] of walls) if (overlap(chip.box, box)) under.push(`${chip.id} under ${label} ${fmt(chip.box)}`);
    if (chip.box.left < 0 || chip.box.right > pg.layout.width || chip.box.bottom > pg.layout.height) under.push(`${chip.id} off the map ${fmt(chip.box)}`);
  }
  expect(`${name}: no chip covers the rails, ETA, directions, Search here / Clear or the top`, under.length === 0, under.join("; "));

  const dot = dotBox(pg);
  const onDot = shown.filter((chip) => overlap(chip.box, dot));
  expect(`${name}: no chip covers your dot`, onDot.length === 0, onDot.map((c) => c.id).join(", "));

  const { out } = leads(pg);
  const bad = [];
  for (const chip of shown) {
    const lead = out.get(chip.id);
    if (!lead) {
      bad.push(`${chip.id} has no line`);
      continue;
    }
    const tipOff = Math.hypot(lead.tip.x - chip.at.x, lead.tip.y - chip.at.y);
    if (tipOff > 2) bad.push(`${chip.id} arrow ${tipOff.toFixed(1)} px from its stop`);
    const b = chip.box;
    const onEdge = lead.from.x >= b.left - 1 && lead.from.x <= b.right + 1 && (Math.abs(lead.from.y - b.top) <= 1 || Math.abs(lead.from.y - b.bottom) <= 1);
    if (!onEdge) bad.push(`${chip.id} line starts off its chip (${lead.from.x}, ${lead.from.y}) vs ${fmt(b)}`);
  }
  expect(`${name}: every chip has a line whose arrow tip is within 2 px of its stop`, bad.length === 0, bad.join("; "));
  const extra = [...out.keys()].filter((id) => !shown.some((chip) => chip.id === id));
  expect(`${name}: no line without a shown chip`, extra.length === 0, extra.join(", "));

  const above = shown.filter((chip) => chip.box.bottom <= chip.at.y - 10).length;
  const below = shown.filter((chip) => chip.box.top >= chip.at.y + 10).length;
  expect(`${name}: chips stand off the line on both sides`, above > 0 && below > 0 && above + below === shown.length, `${above} above, ${below} below of ${shown.length}`);
  return { shown, out };
}

const plainState = (pg) => chips(pg).map((chip) => ({
  id: chip.id, cls: chip.el.className, z: chip.el.style.zIndex || "", vis: chip.el.style.visibility || "", tr: chip.el.style.translate || "",
}));
const isPlain = (pg) => plainState(pg).every((c) => !c.tr && !c.z && !c.vis && c.cls === "route-pin") && !leads(pg).html.includes("<g");
const describe = (pg) => plainState(pg).map((c) => `${c.id}${c.tr ? ` [${c.tr}]` : ""}${c.z ? ` z${c.z}` : ""}${c.vis ? ` ${c.vis}` : ""}${c.cls !== "route-pin" ? ` .${c.cls}` : ""}`).join(", ")
  + (leads(pg).html.includes("<g") ? " + lines" : "");
const camera = (pg) => ({ zoom: pg.map.zoom, bearing: pg.map.bearing, lat: pg.map.center.lat, lng: pg.map.center.lng });
const sameCamera = (a, b) => Math.abs(a.zoom - b.zoom) < 1e-9 && Math.abs(a.bearing - b.bearing) < 1e-9
  && Math.abs(a.lat - b.lat) < 1e-12 && Math.abs(a.lng - b.lng) < 1e-12;

// --- a. Trip zoom ---
console.log("a. Trip zoom: chips above and below the route, each with a line and arrow");
{
  const pg = page();
  enterNav(pg);
  enterMode(pg, "full");
  const cluster = chips(pg).filter((chip) => ["swft", "walmardo", "walmart1", "walmart2"].includes(chip.id));
  const spread = Math.max(...cluster.map((c) => c.at.x)) - Math.min(...cluster.map((c) => c.at.x));
  expect("set-up: Trip zoom, the Columbus cluster's four pins are within a few px", pg.ctx.tripFit === "full" && spread < 8, `${spread.toFixed(1)} px apart`);
  checkCallouts(pg, "Trip zoom");

  // A map move / zoom, then a resize (shorter screen, taller directions).
  pg.map.easeTo({ zoom: pg.map.zoom + 0.6, around: { lat: PLACES.walmardo[0], lng: PLACES.walmardo[1] } });
  checkCallouts(pg, "Trip zoom after a zoom in");
  pg.map.easeTo({ zoom: pg.map.zoom - 0.6, around: { lat: PLACES.walmardo[0], lng: PLACES.walmardo[1] } });
  pg.layout.height = 760;
  pg.layout.stackTop = 520;
  pg.map.fire("resize");
  checkCallouts(pg, "Trip zoom after a resize");
}

// --- b. Left zoom ---
console.log("\nb. Left zoom");
{
  const pg = page();
  enterNav(pg);
  enterMode(pg, "remaining");
  expect("set-up: Left zoom", pg.ctx.tripFit === "remaining");
  checkCallouts(pg, "Left zoom");
  pg.map.easeTo({ center: pg.map.unproject([pg.layout.width / 2 + 12, pg.layout.height / 2 - 9]) });
  checkCallouts(pg, "Left zoom after a pan");
}

// --- c. Stop zoom ---
console.log("\nc. Stop zoom: the stop you are driving to is placed first and on top");
{
  const pg = page();
  enterNav(pg);
  enterMode(pg, "nextStop");
  expect("set-up: Stop zoom framed SWFT", pg.ctx.tripFit === "nextStop" && pg.ctx.stopFrameId === "swft", `framed "${pg.ctx.stopFrameId}"`);
  const { shown } = checkCallouts(pg, "Stop zoom", { allShown: false });
  const all = chips(pg);
  const target = all.find((chip) => chip.id === "swft");
  expect("the target chip is shown, marked is-target, and on top", target?.shown && target.el.classList.contains("is-target")
    && all.every((chip) => chip === target || (chip.z < target.z && !chip.el.classList.contains("is-target"))),
  all.map((chip) => `${chip.id} z${chip.z}`).join(", "));
  const clear = { left: pg.rails()[0].right, right: pg.rails()[1].left, top: SAFE_TOP, bottom: pg.layout.stackTop };
  const inside = (b) => b.left >= clear.left && b.right <= clear.right && b.top >= clear.top && b.bottom <= clear.bottom;
  expect("the target chip, as drawn, is inside the clear area", target && inside(target.box), target ? fmt(target.box) : "");
  expect("your dot is inside the clear area", inside(dotBox(pg)), fmt(dotBox(pg)));
  const cluster = shown.filter((chip) => ["walmardo", "walmart1", "walmart2"].includes(chip.id));
  expect("the other Columbus chips are shown around it", cluster.length === 3, `${cluster.length} of 3 shown`);
  // Placed first: alone on the map it would take the same spot.
  const full = { dx: target.dx, dy: target.dy };
  const markers = pg.ctx.routePinMarkers;
  pg.ctx.routePinMarkers = markers.filter((marker) => marker.getElement().dataset.stopId === "swft");
  pg.ctx.declutterRoutePins();
  const alone = chips(pg)[0];
  pg.ctx.routePinMarkers = markers;
  pg.ctx.declutterRoutePins();
  expect("the target chip takes its own best spot, as if it were alone (placed first)", alone.dx === full.dx && alone.dy === full.dy && (full.dx || full.dy),
    `with others ${full.dx},${full.dy}; alone ${alone.dx},${alone.dy}`);
  pg.map.easeTo({ zoom: pg.map.zoom - 1, around: { lat: PLACES.swft[0], lng: PLACES.swft[1] } });
  checkCallouts(pg, "Stop zoom zoomed out", { allShown: false });
  const t2 = chips(pg).find((chip) => chip.id === "swft");
  expect("…the target chip is still shown and on top", t2.shown && t2.z === Math.max(...chips(pg).map((c) => c.z)));
}

// --- d. Avoid the chosen detour result box ---
console.log("\nd. A chosen search result box is not covered");
{
  const pg = page();
  enterNav(pg);
  enterMode(pg, "full");
  const pin = chips(pg).find((chip) => chip.id === "walmardo").at;
  pg.layout.chosen = rect(pin.x - 30, pin.y - 70, 110, 44);
  pg.map.fire("move");
  const covering = chips(pg).filter((chip) => chip.shown && onScreen(pg, chip) && overlap(chip.box, pg.layout.chosen));
  expect("no chip covers the chosen result box", covering.length === 0, covering.map((c) => `${c.id} ${fmt(c.box)}`).join("; "));
  checkCallouts(pg, "Trip zoom with a result box");
}

// --- e. Turn zoom, Follow me, End navigation and the page map: as Build #627 ---
console.log("\ne. Turn zoom, Follow me, leaving Trip zoom and the page map: chips on their pins as Build #627");
{
  const flows = {
    "Turn zoom": (pg) => { enterNav(pg); enterMode(pg, "nextTurn"); },
    "Trip zoom -> Left -> Turn zoom": (pg) => { enterNav(pg); enterMode(pg, "full"); pg.ctx.cycleTripFit(); pg.ctx.cycleTripFit(); },
    "Trip zoom -> Follow me": (pg) => {
      enterNav(pg);
      enterMode(pg, "full");
      pg.ctx.tripFit = "off";
      pg.ctx.navFollowing = true;
      pg.ctx.syncTripFitButton();
      pg.map.jumpTo({ center: [HERE[1], HERE[0]], zoom: 9 });
    },
    "Stop zoom -> Follow me": (pg) => {
      enterNav(pg);
      enterMode(pg, "nextStop");
      pg.ctx.tripFit = "off";
      pg.ctx.syncTripFitButton();
      pg.map.jumpTo({ center: [HERE[1], HERE[0]], zoom: 9 });
    },
    "Trip zoom -> End navigation": (pg) => {
      enterNav(pg);
      enterMode(pg, "full");
      pg.ctx.navOn = false;
      pg.ctx.showWholeTrip();
    },
    "Page map before navigation (Trip fit, not navigating)": (pg) => {
      pg.ctx.navOn = false;
      pg.ctx.routeFull = false;
      pg.ctx.tripFit = "full";
      pg.ctx.showWholeTrip();
      pg.ctx.addRoutePins();
    },
  };
  for (const [name, flow] of Object.entries(flows)) {
    const pg = page();
    flow(pg);
    expect(`${name}: chips sit on their pins, no lines`, isPlain(pg), describe(pg));
    if (CODE_627) {
      const old = page({ code: CODE_627 });
      flow(old);
      const now = plainState(pg);
      const was = plainState(old);
      expect(`${name}: same chips and camera as Build #627`, JSON.stringify(now) === JSON.stringify(was) && sameCamera(camera(pg), camera(old)),
        `${describe(pg)} vs ${describe(old)}`);
    }
  }
  // Report only: in Turn zoom / Follow me the chips stay on their pins and may overlap.
  const pg = page();
  enterNav(pg);
  enterMode(pg, "nextTurn");
  const shown = chips(pg).filter((chip) => onScreen(pg, chip));
  const pairs = [];
  for (let i = 0; i < shown.length; i += 1) for (let j = i + 1; j < shown.length; j += 1) if (overlap(shown[i].box, shown[j].box)) pairs.push(`${shown[i].id}/${shown[j].id}`);
  console.log(`info Turn zoom on this trip: ${shown.length} chip(s) on screen, overlapping pairs: ${pairs.join(", ") || "none"}`);
}

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
