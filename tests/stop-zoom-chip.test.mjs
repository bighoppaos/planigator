// Build #623: in Stop zoom the stop you are driving to always shows its chip.
// Not loaded by the site.
// Run: node tests/stop-zoom-chip.test.mjs
// Against other copies: APP_JS=/path/to/app.js CSS_FILE=/path/to/styles.css node tests/stop-zoom-chip.test.mjs
//
// The real Stop zoom framing (frameNextStop) and stop chips (addRoutePins) are
// loaded from js/app.js by name into a vm sandbox, over a fake MapLibre map
// doing real Web Mercator math (512px world) with a fitBounds that pads like
// MapLibre's. The DOM is stubbed to the boxes of the full-screen map in the
// screenshot (390x844). Chip sizes come from the .route-pin rules in
// styles.css. The other trip-fit modes are run through Build #622's app.js
// (from git) too and their cameras compared.

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appSource = readFileSync(process.env.APP_JS || path.join(root, "js/app.js"), "utf8");
const cssSource = readFileSync(process.env.CSS_FILE || path.join(root, "styles.css"), "utf8");
const BUILD_622 = "0630cbd";
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

function constLine(source, name, optional = false) {
  const hit = new RegExp(`^const ${name} = [^;]+;`, "m").exec(source);
  if (!hit) {
    if (optional) return "";
    throw new Error(`app.js has no const ${name}`);
  }
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
];
// Build #623 only. #622 runs without them, so this test can show it failing.
const OPTIONAL_FUNCTIONS = ["routePinFor", "declutterRoutePins", "hookRoutePinDeclutter", "stopZoomPadding"];
const APP_CONSTS = [
  "MERCATOR_MPP0", "FULL_TURN_TOP_PX", "FULL_TURN_MAX_ZOOM", "NAV_DOT_HALO_PX", "NAV_DOT_CHIP_GAP_PX",
  "TURN_PIN_MAX_ZOOM", "TURN_PIN_HOLD_M", "TURN_PIN_HOLD_OUT_M", "TURN_PIN_PAST_M", "TURN_PIN_EASE_MS",
  "TURN_PIN_AFTER_MIN_M", "TURN_PIN_AFTER_MAX_M",
];

function appCode(source) {
  return [
    ...APP_CONSTS.map((name) => constLine(source, name)),
    ...APP_FUNCTIONS.map((name) => extract(source, name)),
    ...OPTIONAL_FUNCTIONS.map((name) => extract(source, name, true)),
  ].join("\n\n");
}
const APP_CODE = appCode(appSource);

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

const WIDTH = 390;
const HEIGHT = 844;
const SAFE_TOP = 47;
const RAILS = [rect(8, 270, 60, 300), rect(322, 270, 60, 300)];

function page({ code = APP_CODE, stackTop = 580, stops = STOPS() } = {}) {
  const clock = { now: 1_780_000_000_000 };
  class FakeDate extends Date {
    static now() { return clock.now; }
  }
  const layout = { stackTop };
  const mapEl = {
    id: "routeMap", clientWidth: WIDTH, clientHeight: HEIGHT, hidden: false,
    getBoundingClientRect: () => rect(0, 0, WIDTH, HEIGHT),
    contains: () => true,
  };
  const els = {
    routeMap: mapEl,
    routeRecalc: { getBoundingClientRect: () => rect(322, 450, 60, 60) },
    routeDetour: { getBoundingClientRect: () => rect(8, 330, 60, 60) },
    routeCompass: { getBoundingClientRect: () => rect(322, 330, 60, 60) },
    routeStopMiles: { getBoundingClientRect: () => rect(100, layout.stackTop, 190, 26) },
    routeDirections: { hidden: false, getBoundingClientRect: () => rect(8, layout.stackTop + 30, 374, HEIGHT - 8 - layout.stackTop - 30) },
    routeWhole: { innerHTML: "", setAttribute: noop, classList: { toggle: noop } },
  };
  const stack = { hidden: false, getBoundingClientRect: () => rect(8, layout.stackTop, 374, HEIGHT - 8 - layout.stackTop) };
  const rails = RAILS.map((box) => ({ getBoundingClientRect: () => box }));
  const map = new FakeMap(mapEl);
  const calls = [];
  const context = {
    console, Math, Number, String, JSON, Array, Object, Infinity, NaN, Set, Map, RegExp, Promise, Error, Boolean,
    Date: FakeDate,
    ...navMatch,
    clock, calls,
    performance: { now: () => clock.now },
    requestAnimationFrame: () => 0,
    routeMapReady: true, navMotion: 0, navMapTouch: false, navZoom: 15, navZoomHold: 0,
    document: {
      getElementById: (id) => els[id] || null,
      querySelector: (sel) => (sel === "#routeStage .route-bottom" ? stack : null),
      querySelectorAll: (sel) => (sel === ".route-stage .route-rail" ? rails : []),
      createElement: () => new FakeEl(),
    },
    window: { maplibregl: { Marker: FakeMarker, LngLatBounds: FakeBounds }, clearTimeout: noop, setTimeout: () => 0 },
    state: { stops, settings: {} },
    routeMap: map, routeFull: true, tripFit: "nextStop", navOn: true, northLock: false,
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
    cardTitle: (index, stops) => stops[index].name,
    stopColor: () => [200, 80, 40],
    stopInk: () => ({ color: "#fff" }),
    cssRGB: (rgb) => `rgb(${rgb.join(" ")})`,
  };
  vm.createContext(context);
  vm.runInContext(code, context);
  context.rebuildNavLegs();
  context.addRoutePins();
  return { ctx: context, map, layout };
}

// --- The trip: Harrisburg PA west on the turnpike past Pittsburgh to Columbus OH. ---

const HERE = [40.27, -76.88];
const PITTSBURGH = [40.44, -80.0];
const PLACES = {
  start: [40.04, -76.31],
  walmar: [40.27, -76.79],
  pilotfue: [39.95, -82.9],
  swft: [39.96, -83.0],
  walmardo: [39.97, -82.95],
  frank: PITTSBURGH,
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
    leg("walmardo", "WALMARdo", PLACES.walmardo, [PLACES.swft, PLACES.walmardo]),
    leg("frank", "FRANK", PLACES.frank, [PLACES.walmardo, PLACES.frank]),
  ];
}

let failures = 0;
function expect(label, ok, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`);
}

const chips = (pg) => pg.ctx.routePinMarkers.map((marker) => {
  const el = marker.getElement();
  const at = pg.map.project(marker.getLngLat());
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  return {
    id: el.dataset.stopId || el.textContent, label: el.textContent, el, at,
    box: { left: at.x - w / 2, right: at.x + w / 2, top: at.y - h, bottom: at.y },
    z: el.style.zIndex ? Number(el.style.zIndex) : MARKER_Z,
    shown: el.style.visibility !== "hidden" && el.style.display !== "none" && !el.hidden && el.style.opacity !== "0",
  };
});
const chipOf = (pg, label) => chips(pg).find((chip) => chip.label === label);
const overlap = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
const fmt = (b) => `x ${b.left.toFixed(0)}..${b.right.toFixed(0)}, y ${b.top.toFixed(0)}..${b.bottom.toFixed(0)}`;

// The part of the screen nothing covers: between the rails, under the notch,
// above the ETA chip and the directions.
const clearArea = (pg) => ({ left: RAILS[0].right, right: RAILS[1].left, top: SAFE_TOP, bottom: pg.layout.stackTop });
const inside = (b, area) => b.left >= area.left && b.right <= area.right && b.top >= area.top && b.bottom <= area.bottom;

function enterStopZoom(pg, fix = HERE) {
  const { ctx } = pg;
  ctx.navFix = fix.slice();
  ctx.placeNavDot(fix[0], fix[1]);
  ctx.tripFit = "nextTurn";
  ctx.cycleTripFit();
}

function dotBox(pg) {
  const at = pg.map.project({ lat: pg.ctx.navFix[0], lng: pg.ctx.navFix[1] });
  const r = 12 + pg.ctx.NAV_DOT_HALO_PX;
  return { left: at.x - r, right: at.x + r, top: at.y - r, bottom: at.y + r };
}

// --- a. The fit keeps the target pin, its chip and your dot in the clear area ---
console.log("a. Stop zoom keeps the stop you are driving to, its chip, and your dot in the clear area");
{
  const pg = page();
  enterStopZoom(pg);
  const target = chipOf(pg, "pilotfue");
  const area = clearArea(pg);
  expect("set-up: Stop zoom framed pilotfue, the stop you are driving to", pg.ctx.stopFrameId === "pilotfue" && pg.map.fits.length >= 1,
    `framed "${pg.ctx.stopFrameId}", ${pg.map.fits.length} fit(s)`);
  expect("the target pin is inside the clear area", target && inside({ left: target.at.x, right: target.at.x, top: target.at.y, bottom: target.at.y }, area),
    target ? `pin (${target.at.x.toFixed(0)}, ${target.at.y.toFixed(0)})` : "no chip");
  expect(`the target chip box is inside the clear area (x ${area.left}..${area.right}, y ${area.top}..${area.bottom})`,
    target && inside(target.box, area), target ? fmt(target.box) : "no chip");
  expect("the target chip is not under either rail", target && RAILS.every((r) => !overlap(target.box, r)), target ? fmt(target.box) : "");
  const dot = dotBox(pg);
  expect("your dot (with its ring) is inside the clear area", inside(dot, area), fmt(dot));

  // Parked: no new 150 m, but the directions open taller. Stop zoom fits again.
  pg.layout.stackTop = 470;
  pg.ctx.clock.now += 1000;
  const fits = pg.map.fits.length;
  pg.ctx.frameNextStop();
  const again = chipOf(pg, "pilotfue");
  const area2 = clearArea(pg);
  expect("parked, directions opened taller: Stop zoom fits the map again", pg.map.fits.length > fits, `${pg.map.fits.length - fits} new fit(s)`);
  expect("…and the target chip is still inside the clear area", again && inside(again.box, area2), again ? fmt(again.box) : "");
  expect("…and so is your dot", inside(dotBox(pg), area2), fmt(dotBox(pg)));
  pg.ctx.clock.now += 1000;
  const settled = pg.map.fits.length;
  pg.ctx.frameNextStop();
  expect("…same layout, same spot: no refit on the next fix", pg.map.fits.length === settled, `${pg.map.fits.length - settled} new fit(s)`);
}
// The same check with the stop east of you, and straight north of you.
for (const [label, fix, to, name] of [
  ["driving east (Columbus to near Harrisburg)", [39.96, -83.0], [40.27, -76.9], "PILOTFLYING"],
  ["driving north (Harrisburg to Buffalo)", HERE, [42.89, -78.88], "PILOTBUFFALO"],
]) {
  const stops = [
    { id: "start", name: "START", lat: fix[0], lon: fix[1] },
    leg("goal", name, to, [fix, to]),
    leg("later", "LATER", PLACES.frank, [to, PLACES.frank]),
  ];
  const pg = page({ stops });
  enterStopZoom(pg, fix);
  const target = chipOf(pg, name);
  const area = clearArea(pg);
  expect(`${label}: the target chip box is inside the clear area`, pg.ctx.stopFrameId === "goal" && target && inside(target.box, area),
    target ? fmt(target.box) : "no chip");
  expect(`${label}: your dot is inside the clear area`, inside(dotBox(pg), area), fmt(dotBox(pg)));
}

// --- b. The target chip is on top ---
console.log("\nb. The target chip is drawn above every other stop chip");
{
  const pg = page();
  enterStopZoom(pg);
  const all = chips(pg);
  const target = all.find((chip) => chip.label === "pilotfue");
  const others = all.filter((chip) => chip !== target);
  expect("the target chip has the highest z-index of all route chips", target && others.every((chip) => target.z > chip.z),
    all.map((chip) => `${chip.label} ${chip.z}`).join(", "));
  expect("the target chip is marked is-target (and no other chip is)",
    target?.el.classList.contains("is-target") && others.every((chip) => !chip.el.classList.contains("is-target")));
}

// --- c. No other visible chip covers it ---
console.log("\nc. No other visible chip overlaps the target chip");
{
  const pg = page();
  enterStopZoom(pg);
  const all = chips(pg);
  const target = all.find((chip) => chip.label === "pilotfue");
  const near = all.filter((chip) => chip !== target && overlap(chip.box, target.box));
  expect("set-up: SWFT and WALMARdo sit on the target chip at this zoom", ["SWFT", "WALMARdo"].every((label) => near.some((chip) => chip.label === label)),
    near.map((chip) => chip.label).join(", ") || "none");
  const covering = near.filter((chip) => chip.shown);
  expect("every chip that overlaps the target chip is hidden", covering.length === 0, covering.map((chip) => `${chip.label} ${fmt(chip.box)}`).join("; "));
  const roomy = { left: target.box.left - 4, right: target.box.right + 4, top: target.box.top - 4, bottom: target.box.bottom + 4 };
  const far = all.filter((chip) => chip !== target && !overlap(chip.box, roomy));
  expect("chips more than 4 px from it stay shown", far.length >= 2 && far.every((chip) => chip.shown),
    far.map((chip) => `${chip.label} ${chip.shown ? "shown" : "hidden"}`).join(", "));

  // Zoom in on Columbus: the chips spread apart and come back.
  const columbus = { lat: PLACES.pilotfue[0], lng: PLACES.pilotfue[1] };
  const spot = pg.map.project(columbus);
  pg.map.easeTo({ zoom: 13, around: columbus });
  pg.map.setLocationAtPoint(columbus, spot);
  pg.map.fire("move");
  const zoomed = chips(pg);
  const t2 = zoomed.find((chip) => chip.label === "pilotfue");
  const back = zoomed.filter((chip) => chip.label === "SWFT" || chip.label === "WALMARdo");
  expect("zoomed in (zoom 13): chips no longer touching the target are shown again",
    back.length === 2 && back.every((chip) => overlap(chip.box, t2.box) ? !chip.shown : chip.shown) && back.some((chip) => chip.shown),
    back.map((chip) => `${chip.label} ${chip.shown ? "shown" : "hidden"} ${fmt(chip.box)}`).join("; "));
  pg.map.easeTo({ zoom: 5, around: columbus });
  const out = chips(pg);
  const t3 = out.find((chip) => chip.label === "pilotfue");
  const covers = out.filter((chip) => chip !== t3 && chip.shown && overlap(chip.box, t3.box));
  expect("zoomed back out: the ones that cover it are hidden again", covers.length === 0, covers.map((chip) => chip.label).join(", "));
}

// --- d. Leaving Stop zoom puts every chip back ---
console.log("\nd. Leaving Stop zoom: every chip back, no target styling");
const plain = (pg) => chips(pg).every((chip) => chip.shown && !chip.el.style.zIndex && !chip.el.classList.contains("is-target"));
const state = (pg) => chips(pg).map((chip) => `${chip.label}${chip.shown ? "" : " hidden"}${chip.el.style.zIndex ? ` z${chip.el.style.zIndex}` : ""}${chip.el.classList.contains("is-target") ? " target" : ""}`).join(", ");
{
  const pg = page();
  enterStopZoom(pg);
  pg.ctx.cycleTripFit();
  expect("Stop zoom -> Trip zoom: all chips shown, none on top or marked", pg.ctx.tripFit === "full" && plain(pg), state(pg));
}
{
  const pg = page();
  enterStopZoom(pg);
  // Follow me: tripFit off, then the camera moves onto you.
  pg.ctx.tripFit = "off";
  pg.ctx.syncTripFitButton();
  pg.map.jumpTo({ center: [HERE[1], HERE[0]], zoom: 15 });
  expect("Stop zoom -> Follow me: all chips shown, none on top or marked", plain(pg), state(pg));
}
{
  const pg = page();
  enterStopZoom(pg);
  // End navigation: tripFit full, navOn off, the whole trip is shown.
  pg.ctx.navOn = false;
  pg.ctx.tripFit = "full";
  pg.ctx.syncTripFitButton();
  pg.ctx.showWholeTrip();
  expect("Stop zoom -> End navigation: all chips shown, none on top or marked", plain(pg), state(pg));
  pg.ctx.addRoutePins();
  expect("…and when the route repaints its chips", plain(pg), state(pg));
}
{
  const pg = page();
  pg.ctx.navFix = HERE.slice();
  pg.ctx.placeNavDot(HERE[0], HERE[1]);
  pg.ctx.tripFit = "remaining";
  pg.ctx.cycleTripFit();
  expect("Turn zoom never hides or marks a chip", pg.ctx.tripFit === "nextTurn" && plain(pg), state(pg));
}

// --- e. Other trip-fit modes: same cameras as Build #622 ---
console.log("\ne. Trip, Left and Turn zoom: same camera as Build #622");
{
  let code622 = "";
  try {
    code622 = appCode(execFileSync("git", ["show", `${BUILD_622}:js/app.js`], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
  } catch (err) {
    expect(`read Build #622's app.js from git (${BUILD_622})`, false, String(err.message || err).split("\n")[0]);
  }
  if (code622) {
    const run = (code) => {
      const pg = page({ code });
      enterStopZoom(pg);
      const shots = [];
      for (let i = 0; i < 3; i += 1) {
        pg.ctx.clock.now += 1000;
        pg.ctx.cycleTripFit();
        shots.push({ mode: pg.ctx.tripFit, zoom: pg.map.zoom, bearing: pg.map.bearing, center: { ...pg.map.center } });
      }
      return shots;
    };
    const now = run(APP_CODE);
    const old = run(code622);
    const names = { full: "Trip zoom", remaining: "Left zoom", nextTurn: "Turn zoom" };
    now.forEach((shot, i) => {
      const was = old[i];
      const same = shot.mode === was.mode && Math.abs(shot.zoom - was.zoom) < 1e-9 && Math.abs(shot.bearing - was.bearing) < 1e-9
        && Math.abs(shot.center.lat - was.center.lat) < 1e-12 && Math.abs(shot.center.lng - was.center.lng) < 1e-12;
      expect(`${names[shot.mode] || shot.mode}: same zoom, bearing and center`, same,
        `zoom ${shot.zoom.toFixed(4)} vs ${was.zoom.toFixed(4)}, bearing ${shot.bearing.toFixed(2)} vs ${was.bearing.toFixed(2)}`);
    });
  }
}

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
