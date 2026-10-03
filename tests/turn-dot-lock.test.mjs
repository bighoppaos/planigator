// Turn zoom keeps your dot and the next-turn dot on their screen spots while
// the map turns, pans and zooms under them. Not loaded by the site.
// Run: node tests/turn-dot-lock.test.mjs
// Against another copy of app.js: APP_JS=/path/to/app.js node tests/turn-dot-lock.test.mjs
//
// Loads the real Turn zoom framing (frameNextTurn and everything it calls)
// from js/app.js by name into a vm sandbox. The map is a fake MapLibre map
// doing real Web Mercator math (512px world, bearing = compass direction
// that is up), so every dot's screen position is computed honestly from the
// camera the app sets. The DOM is stubbed with fixed boxes for the ETA chip,
// Detour, the compass, and the side rails, so the spots are known up front.

import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appSource = readFileSync(process.env.APP_JS || path.join(root, "js/app.js"), "utf8");
const navMatch = await import(pathToFileURL(path.join(root, "js/nav-match.js")).href);

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
  "metersBetween", "polylineMeters", "pointAlong", "stepLengthMeters", "scaledStepLengths", "navStep", "metersLeftInStep",
  "navBearing", "pointAhead", "rebuildNavLegs", "activeNavLeg", "currentDirectionEnd", "turnGuideAlong", "navRemaining",
  "turnViewPadding", "railClearance", "noHandsSlots", "stretchMeters", "mercatorMpp", "cameraForStretch", "cameraForFullTurn",
  "placeTurnPin", "placeNavDot", "showNavCamera", "travelBearing", "frameNextTurn", "clearTurnFrame", "stopTurnZoomOut",
  "syncTripFitButton", "tripFitLines", "cycleTripFit", "aimNavDot", "paintNavMotion",
];
// #607 has none of these; it runs without them so this test can show it failing.
const OPTIONAL_FUNCTIONS = [
  "mercatorWorld", "mercatorLngLat", "wrapBearing", "cameraAtSpot", "spotOnCamera", "pinTwoPoints", "roadRoom",
  "turnPinFrame", "syncTurnMaxZoom", "hookTurnPinGlide", "settleTurnPin", "framePinnedTurn", "showPinnedTurn",
];
const APP_CONSTS = ["MERCATOR_MPP0", "FULL_TURN_TOP_PX", "FULL_TURN_MAX_ZOOM", "NAV_DOT_HALO_PX", "NAV_DOT_CHIP_GAP_PX"];
const OPTIONAL_CONSTS = [
  "TURN_PIN_MAX_ZOOM", "TURN_PIN_HOLD_M", "TURN_PIN_HOLD_OUT_M", "TURN_PIN_PAST_M", "TURN_PIN_EASE_MS",
  "TURN_PIN_AFTER_MIN_M", "TURN_PIN_AFTER_MAX_M",
];
const APP_CODE = [
  ...APP_CONSTS.map((name) => constLine(name)),
  ...OPTIONAL_CONSTS.map((name) => constLine(name, true)),
  ...APP_FUNCTIONS.map((name) => extract(name)),
  ...OPTIONAL_FUNCTIONS.map((name) => extract(name, true)),
].join("\n\n");

// --- Ground, in meters east (x) and north (y) of a Kansas City corner. ---

const ORIGIN = [39.1, -94.6];
const COS = Math.cos(ORIGIN[0] * Math.PI / 180);
const ll = (x, y) => [ORIGIN[0] + y / 111320, ORIGIN[1] + x / (111320 * COS)];
const MILE = 1609.344;
const FOOT = 0.3048;
const noop = () => {};

function run(from, to, stepM = 50) {
  const out = [];
  const n = Math.max(1, Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1]) / stepM));
  for (let k = 0; k <= n; k += 1) out.push([from[0] + (to[0] - from[0]) * (k / n), from[1] + (to[1] - from[1]) * (k / n)]);
  return out;
}

// --- A fake MapLibre map: real Web Mercator, bearing = the compass direction that is up. ---

const toLngLat = (v) => (Array.isArray(v) ? { lng: v[0], lat: v[1] } : { lng: v.lng ?? v.lon, lat: v.lat });

class FakeMap {
  constructor(el) {
    this.el = el;
    this.center = { lng: ORIGIN[1], lat: ORIGIN[0] };
    this.zoom = 10;
    this.bearing = 0;
    this.maxZoom = 22;
    this.minZoom = 0;
    this.handlers = {};
    this.onFrame = null;
    this.eases = 0;
  }
  getContainer() { return this.el; }
  getZoom() { return this.zoom; }
  getBearing() { return this.bearing; }
  getCenter() { return { ...this.center }; }
  getMaxZoom() { return this.maxZoom; }
  getMinZoom() { return this.minZoom; }
  setMaxZoom(z) {
    this.maxZoom = z == null ? 22 : z;
    if (this.zoom > this.maxZoom) this.zoom = this.maxZoom;
    return this;
  }
  on(type, fn) { (this.handlers[type] ||= []).push(fn); return this; }
  fire(type) { for (const fn of this.handlers[type] || []) fn({ type }); }
  stop() { return this; }
  redraw() { return this; }
  worldSize() { return 512 * 2 ** this.zoom; }
  world(lng, lat) {
    const size = this.worldSize();
    const y = 180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));
    return { x: (180 + lng) / 360 * size, y: y / 360 * size };
  }
  fromWorld(x, y) {
    const size = this.worldSize();
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
  // Like MapLibre: zoom and bearing step, and `around` stays on its screen point.
  easeTo(o) {
    this.eases += 1;
    const z0 = this.zoom;
    const z1 = o.zoom != null ? this.clampZoom(o.zoom) : z0;
    const b0 = this.bearing;
    let b1 = o.bearing != null ? o.bearing : b0;
    while (b1 - b0 > 180) b1 -= 360;
    while (b1 - b0 < -180) b1 += 360;
    const around = o.around ? toLngLat(o.around) : null;
    const aroundPt = around ? this.project(around) : null;
    const c0 = this.center;
    const c1 = o.center ? toLngLat(o.center) : c0;
    const steps = 10;
    for (let i = 1; i <= steps; i += 1) {
      const k = i / steps;
      this.zoom = z0 + (z1 - z0) * k;
      this.bearing = this.wrap(b0 + (b1 - b0) * k);
      if (around) this.setLocationAtPoint(around, aroundPt);
      else this.center = { lng: c0.lng + (c1.lng - c0.lng) * k, lat: c0.lat + (c1.lat - c0.lat) * k };
      this.fire("move");
      if (this.onFrame) this.onFrame();
    }
    this.fire("moveend");
    return this;
  }
}

class FakeMarker {
  constructor({ element }) { this.el = element; this.at = null; }
  setLngLat(v) { this.at = toLngLat(v); return this; }
  getLngLat() { return this.at; }
  addTo() { return this; }
  remove() { return this; }
  getElement() { return this.el; }
}

// --- The screen. Spots are worked out here from the boxes, not by the app. ---

const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top });
const WIDTH = 390;
const LAYOUTS = {
  // Page: Detour (left rail) and the compass (right rail) tops at 120; ETA chip top at 370.
  // Your spot: just above the chip, 370 - (11 + 6 halo) - 6 gap = 347. The turn spot:
  // the middle of the line across the button tops, x = (36 + 354) / 2 = 195, y = 120.
  page: { height: 420, full: false, you: { x: 195, y: 347 }, turn: { x: 195, y: 120 }, box: { left: 92, right: 298, top: 12, bottom: 361 } },
  // Full screen: bottom stack from 600, safe top 47. Your spot sits above the
  // reserved 34% (844 - 287 - 8 = 549); the turn spot is 96px down. Both are
  // centered between the rails: (92 + 298) / 2 = 195.
  full: { height: 844, full: true, you: { x: 195, y: 549 }, turn: { x: 195, y: 96 }, box: { left: 92, right: 298, top: 51, bottom: 832 } },
};

function page(layout, { stops, aim = "dock" }) {
  const L = LAYOUTS[layout];
  const clock = { now: 1_780_000_000_000 };
  class FakeDate extends Date {
    static now() { return clock.now; }
  }
  const mapEl = {
    id: "routeMap", clientWidth: WIDTH, clientHeight: L.height, hidden: false,
    getBoundingClientRect: () => rect(0, 0, WIDTH, L.height),
    contains: () => true,
  };
  const els = {
    routeMap: mapEl,
    routeRecalc: { getBoundingClientRect: () => rect(8, 300, 56, 56) },
    routeDetour: { getBoundingClientRect: () => rect(8, 120, 56, 56) },
    routeCompass: { getBoundingClientRect: () => rect(326, 120, 56, 56) },
    routeStopMiles: { getBoundingClientRect: () => (L.full ? rect(100, 610, 190, 36) : rect(100, 370, 190, 36)) },
    routeDirections: { hidden: false, getBoundingClientRect: () => (L.full ? rect(0, 650, WIDTH, 194) : rect(0, 430, WIDTH, 200)) },
    routeWhole: { innerHTML: "", setAttribute: noop, classList: { toggle: noop } },
  };
  const stack = { hidden: false, getBoundingClientRect: () => rect(0, 600, WIDTH, 244) };
  const rails = [
    { getBoundingClientRect: () => rect(8, 60, 56, L.height - 120) },
    { getBoundingClientRect: () => rect(326, 60, 56, L.height - 120) },
  ];
  const map = new FakeMap(mapEl);
  const calls = [];
  const context = {
    console, Math, Number, String, JSON, Array, Object, Infinity, NaN, Set, Map, RegExp, Promise, Error,
    Date: FakeDate,
    ...navMatch,
    clock, calls,
    performance: { now: () => clock.now },
    requestAnimationFrame: () => 0,
    routeMapReady: true, navMotion: 0, navMapTouch: false, navZoom: 15, navZoomHold: 0,
    document: {
      getElementById: (id) => els[id] || null,
      querySelector: (sel) => (sel === "#routeStage .route-bottom" && L.full ? stack : null),
      querySelectorAll: (sel) => (sel === ".route-stage .route-rail" ? rails : []),
      createElement: () => ({ className: "", isConnected: true, getBoundingClientRect: () => rect(0, 0, 22, 22) }),
    },
    window: { maplibregl: { Marker: FakeMarker }, clearTimeout: noop, setTimeout: () => 0 },
    state: { stops, settings: {} },
    routeMap: map, routeFull: L.full, tripFit: "nextTurn", navOn: true, northLock: false,
    navLine: [], navLegs: [], navAimStopId: aim, navStopPicked: false, navFix: null, navTravel: null,
    navYou: null, navAim: null, navShown: null, turnMarker: null, framingTurn: false,
    navFollowing: false, followPinned: false, navReturnTimer: 0, stopFrameAt: null, stopFrameId: "",
    turnFrameAt: null, turnFrameTarget: null, turnFrameBearing: null, turnShownKey: "", turnShownAlong: null,
    turnKeepAlong: null, turnLockAlong: null, turnPhase: "approach", turnWidenAt: 0, turnZoomOut: null, turnZoomOutTimer: 0,
    turnPin: null, turnPinHooked: null, turnMaxZoomKept: null,
    navNearest: (lat, lon, line) => navMatch.nearestOnPath(lat, lon, line),
    safeTopPad: () => (L.full ? 47 : 0),
    seatRails: noop,
    syncRouteChrome: noop,
    showWholeTrip: () => calls.push("showWholeTrip"),
    fitCoords: () => calls.push("fitCoords"),
    frameNextStop: () => calls.push("frameNextStop"),
  };
  vm.createContext(context);
  vm.runInContext(APP_CODE, context);
  context.rebuildNavLegs();
  return { ctx: context, map, L };
}

// A route made of straight-or-curvy pieces, each ending at a maneuver.
function routeStops(pieces) {
  const pts = [];
  for (const piece of pieces) for (const p of piece) {
    const last = pts[pts.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) pts.push(p);
  }
  const pathLL = pts.map(([x, y]) => ll(x, y));
  const meters = (a) => {
    let total = 0;
    for (let i = 1; i < a.length; i += 1) total += navMatch.metersBetween(a[i - 1], a[i]);
    return total;
  };
  const directions = pieces.map((piece, i) => ({ text: i ? "Turn." : "Head north.", miles: meters(piece.map(([x, y]) => ll(x, y))) / MILE }));
  directions.push({ text: "Arrive at DOCK", miles: 0 });
  const end = pathLL[pathLL.length - 1];
  return [
    { id: "start", name: "Start", lat: pathLL[0][0], lon: pathLL[0][1] },
    { id: "dock", name: "DOCK", lat: end[0], lon: end[1], miles: String(meters(pathLL) / MILE), hours: "1", path: pathLL, directions },
  ];
}

let failures = 0;
function expect(label, ok, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`);
}

const off = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);
const px = (p) => `(${p.x.toFixed(1)}, ${p.y.toFixed(1)})`;

// One GPS fix at (x, y) meters; Turn zoom frames it. Returns the dot spots.
function fix(pg, x, y) {
  const { ctx, map } = pg;
  const before = ctx.navFix;
  ctx.navFix = ll(x, y);
  if (before) ctx.navTravel = ctx.navBearing(before, ctx.navFix);
  ctx.clock.now += 1000;
  ctx.frameNextTurn();
  return {
    you: map.project(ctx.navYou.getLngLat()),
    turn: ctx.turnMarker ? map.project(ctx.turnMarker.getLngLat()) : null,
    turnAt: ctx.turnMarker ? ctx.turnMarker.getLngLat() : null,
  };
}

function sameSpot(a, b) {
  return a && b && Math.abs(a.lat - b.lat) < 1e-7 && Math.abs(a.lng - b.lng) < 1e-7;
}

// #621: Turn zoom also keeps the road past the turn on screen. When that road
// (or the road to the turn) would leave the box, it zooms out about your dot
// and the turn dot slides down the line toward you, only as far as the road
// needs, so some of it touches the box edge. At the street-level max zoom the
// turn dot is where the turn really is, on that same line. #620 and before
// have no such rule: there the turn must be on its spot.
// How far (px) the turn dot is from where that rule puts it.
function turnMiss(pg, got) {
  const { ctx, map, L } = pg;
  if (!got.turn) return Infinity;
  const onSpot = off(got.turn, L.turn);
  if (onSpot <= 2 || !(ctx.TURN_PIN_AFTER_MIN_M > 0)) return onSpot;
  const k = (got.turn.y - L.you.y) / (L.turn.y - L.you.y);
  if (k < -0.01 || k > 1.01) return onSpot;
  const lineMiss = Math.abs(got.turn.x - (L.you.x + (L.turn.x - L.you.x) * k));
  if (map.zoom >= ctx.TURN_PIN_MAX_ZOOM - 1e-6) return lineMiss;
  const along = ctx.turnGuideAlong();
  const target = ctx.turnLockAlong;
  const after = Math.max(ctx.TURN_PIN_AFTER_MIN_M, Math.min(ctx.TURN_PIN_AFTER_MAX_M, 0.5 * Math.max(0, target - along)));
  const road = ctx.navRemaining(along, target + after).map((c) => map.project(c));
  const outside = road.some((p) => p.x < L.box.left - 2 || p.x > L.box.right + 2 || p.y < L.box.top - 2 || p.y > L.box.bottom + 2);
  const tight = Math.min(...road.map((p) => Math.min(
    Math.abs(p.x - L.box.left), Math.abs(p.x - L.box.right), Math.abs(p.y - L.box.top), Math.abs(p.y - L.box.bottom))));
  return !outside && tight <= 2 ? lineMiss : onSpot;
}

const llObj = (x, y) => ({ lat: ll(x, y)[0], lng: ll(x, y)[1] });
const VIEWS = ["page", "full"];

// --- A fake-map sanity check, so the screen math is MapLibre's. ---
{
  const pg = page("page", { stops: routeStops([run([0, -3000], [0, 0]), run([0, 0], [1000, 0])]) });
  pg.map.jumpTo({ center: [ORIGIN[1], ORIGIN[0]], zoom: 15, bearing: 90 });
  const east = pg.map.project([ll(100, 0)[1], ll(100, 0)[0]]);
  const north = pg.map.project([ll(0, 100)[1], ll(0, 100)[0]]);
  expect("fake map: bearing 90 puts east up and north to the left", east.y < 210 - 50 && Math.abs(east.x - 195) < 1 && north.x < 195 - 50, `east ${px(east)}, north ${px(north)}`);
  const back = pg.map.unproject(pg.map.project([ll(250, -80)[1], ll(250, -80)[0]]));
  expect("fake map: unproject undoes project", Math.abs(back.lat - ll(250, -80)[0]) < 1e-9 && Math.abs(back.lng - ll(250, -80)[1]) < 1e-9);
}

// Route A: north 2.5 mi to a right turn, east 0.6 mi to a left turn, north 2 mi.
const T1 = [0, 0];
const T2 = [0.6 * MILE, 0];
const routeA = () => routeStops([run([0, -2.5 * MILE], T1), run(T1, T2), run(T2, [T2[0], 2 * MILE])]);

for (const view of VIEWS) {
  const label = view === "page" ? "Page" : "Full screen";
  const L = LAYOUTS[view];

  console.log(`\n${label}: driving at the turn from 2.2 mi out, a fix every 40 m`);
  {
    const pg = page(view, { stops: routeA() });
    let worstYou = 0;
    let worstTurn = 0;
    let worstAt = "";
    let wrongTurn = 0;
    const marks = { "2 mi": 2 * MILE, "1 mi": MILE, "0.5 mi": 0.5 * MILE, "1000 ft": 1000 * FOOT, "300 ft": 300 * FOOT, "100 ft": 100 * FOOT };
    const stops = [];
    for (let d = 2.2 * MILE; d > 100 * FOOT; d -= 40) stops.push(d);
    stops.push(...Object.values(marks));
    stops.sort((a, b) => b - a);
    for (const d of stops) {
      const got = fix(pg, 0, -d);
      if (!sameSpot(got.turnAt, llObj(...T1))) wrongTurn += 1;
      const ey = off(got.you, L.you);
      const et = turnMiss(pg, got);
      if (ey > worstYou) worstYou = ey;
      if (et > worstTurn) { worstTurn = et; worstAt = `${Math.round(d)} m out, turn at ${px(got.turn)}`; }
      const name = Object.keys(marks).find((key) => marks[key] === d);
      if (name) expect(`${name}: you on your spot, the turn on its spot or slid toward you for the road`, ey <= 2 && et <= 2, `you ${px(got.you)}, turn ${px(got.turn)}, zoom ${pg.map.zoom.toFixed(2)}`);
    }
    expect("the turn dot is the first turn the whole way", wrongTurn === 0, `${wrongTurn} fixes on another turn`);
    expect("every fix: you within 2 px of your spot", worstYou <= 2, `worst ${worstYou.toFixed(2)} px`);
    expect("every fix: the turn within 2 px of where the rule puts it", worstTurn <= 2, `worst ${worstTurn.toFixed(2)} px (${worstAt})`);
  }

  console.log(`\n${label}: the turn is 30° off the way you are driving`);
  {
    // North to a bend, then a straight run at 30° east of north to the turn.
    const bend = [0, -600];
    const turn = [bend[0] + 500 * Math.sin(Math.PI / 6), bend[1] + 500 * Math.cos(Math.PI / 6)];
    const pg = page(view, { stops: routeStops([[...run([0, -3000], bend), ...run(bend, turn).slice(1)], run(turn, [turn[0] + 2000, turn[1]])]) });
    fix(pg, 0, -760);
    const got = fix(pg, 0, -700);
    const travel = pg.ctx.navTravel;
    const toTurn = pg.ctx.navBearing(ll(0, -700), ll(...turn));
    expect("set-up: the turn is well off your heading", Math.abs(toTurn - travel) > 15, `travel ${travel.toFixed(0)}°, to the turn ${toTurn.toFixed(0)}°`);
    expect("you on your spot, the turn on its spot or slid toward you for the road", off(got.you, L.you) <= 2 && turnMiss(pg, got) <= 2, `you ${px(got.you)}, turn ${px(got.turn)}`);
  }

  console.log(`\n${label}: 100 mi of interstate to the next turn`);
  {
    // North 102 mi with long gentle curves (5 km either side), then a turn.
    const pts = [];
    for (let y = -102 * MILE; y <= 0; y += 400) pts.push([5000 * Math.sin((y / (40 * MILE)) * Math.PI), y]);
    pts.push([0, 0]);
    const pg = page(view, { stops: routeStops([pts, run([0, 0], [3000, 0])]) });
    const startX = 5000 * Math.sin((-100 * MILE / (40 * MILE)) * Math.PI);
    const got = fix(pg, startX, -100 * MILE);
    expect("you and the turn 100 mi away on their spots", off(got.you, L.you) <= 2 && off(got.turn, L.turn) <= 2, `you ${px(got.you)}, turn ${px(got.turn)}, zoom ${pg.map.zoom.toFixed(2)}`);
    const outside = pts.filter(([x, y]) => y >= -100 * MILE).map(([x, y]) => pg.map.project([ll(x, y)[1], ll(x, y)[0]]))
      .filter((p) => p.x < L.box.left - 1 || p.x > L.box.right + 1 || p.y < L.box.top - 1 || p.y > L.box.bottom + 1);
    expect("all the road to the turn is on screen, clear of the rails", outside.length === 0, `${outside.length} points outside, e.g. ${outside[0] ? px(outside[0]) : ""}`);
  }

  console.log(`\n${label}: a curve between you and the turn bulges past the rails`);
  {
    // North from -2000; between -1600 and -400 the road swings 1 km east; then straight to the turn.
    const pts = [...run([0, -2000], [0, -1600])];
    for (let y = -1600 + 50; y < -400; y += 50) pts.push([1000 * Math.sin(((y + 1600) / 1200) * Math.PI), y]);
    pts.push(...run([0, -400], T1));
    const pg = page(view, { stops: routeStops([pts, run(T1, [2000, 0])]) });
    fix(pg, 0, -1900);
    const got = fix(pg, 0, -1800);
    const road = pts.filter(([, y]) => y >= -1800).map(([x, y]) => pg.map.project([ll(x, y)[1], ll(x, y)[0]]));
    const outside = road.filter((p) => p.x < L.box.left - 1 || p.x > L.box.right + 1 || p.y < L.box.top - 1 || p.y > L.box.bottom + 1);
    const tight = Math.min(...road.map((p) => Math.min(Math.abs(p.x - L.box.right), Math.abs(p.x - L.box.left), Math.abs(p.y - L.box.top))));
    const lineX = L.you.x + (L.turn.x - L.you.x) * ((got.turn.y - L.you.y) / (L.turn.y - L.you.y));
    expect("your dot stays on its spot", off(got.you, L.you) <= 2, px(got.you));
    expect("the turn stays on the line toward its spot, closer to you", Math.abs(got.turn.x - lineX) <= 2 && got.turn.y > L.turn.y + 10 && got.turn.y < L.you.y, `turn ${px(got.turn)}`);
    expect("every point of that road is inside the box", outside.length === 0, `${outside.length} outside, e.g. ${outside[0] ? px(outside[0]) : ""}`);
    expect("zoomed out just enough: the curve touches the box edge", tight <= 2, `closest ${tight.toFixed(2)} px from an edge`);
    const after = fix(pg, 0, -350);
    expect("once the curve is behind you, the turn is back on its spot (or slid only for the road past it)", off(after.you, L.you) <= 2 && turnMiss(pg, after) <= 2, `you ${px(after.you)}, turn ${px(after.turn)}`);
  }

  console.log(`\n${label}: through the turn; the next one (0.6 mi on) takes the spot`);
  {
    const pg = page(view, { stops: routeA() });
    let worstYou = 0;
    let glideTurn = 0;
    let glideFrames = 0;
    let glideMiss = 0;
    let gliding = [];
    pg.map.onFrame = () => {
      const you = pg.map.project(pg.ctx.navYou.getLngLat());
      worstYou = Math.max(worstYou, off(you, L.you));
      if (pg.ctx.turnPin?.glide && pg.ctx.turnMarker) {
        glideFrames += 1;
        gliding.push(pg.map.project(pg.ctx.turnMarker.getLngLat()));
      }
    };
    const path = [];
    for (let y = -200; y <= 0; y += 4) path.push([0, y]);
    for (let x = 4; x <= 300; x += 4) path.push([x, 0]);
    let held = null;
    let heldMoved = false;
    let afterAdvance = [];
    let eases = 0;
    for (const [x, y] of path) {
      const easesBefore = pg.map.eases;
      const lockBefore = pg.ctx.turnLockAlong;
      gliding = [];
      const got = fix(pg, x, y);
      if (pg.map.eases > easesBefore) eases += 1;
      worstYou = Math.max(worstYou, off(got.you, L.you));
      const onNext = sameSpot(got.turnAt, llObj(...T2));
      const gap = -y;
      if (!onNext && x === 0 && gap < 20 && gap > 12) {
        if (!held) held = { zoom: pg.map.zoom, bearing: pg.map.bearing };
        else if (Math.abs(held.zoom - pg.map.zoom) > 1e-6 || Math.abs(held.bearing - pg.map.bearing) > 1e-6) heldMoved = true;
      }
      // The turn dot waits where the next turn lands once the map stops.
      if (gliding.length) {
        glideTurn = Math.max(glideTurn, ...gliding.map((p) => off(p, got.turn)));
        glideMiss = Math.max(glideMiss, turnMiss(pg, got));
      }
      if (onNext) afterAdvance.push({ x, y, got, lockBefore, miss: turnMiss(pg, got) });
    }
    expect("your dot within 2 px of its spot at every fix and every eased frame", worstYou <= 2, `worst ${worstYou.toFixed(2)} px`);
    expect("the last 20 m before the turn hold the zoom and bearing", held && !heldMoved, held ? `zoom ${held.zoom.toFixed(2)}` : "never held");
    expect("the next turn took the spot", afterAdvance.length > 0);
    const settled = afterAdvance.slice(1);
    const worstNext = Math.max(...settled.map((a) => a.miss));
    expect("after the switch, the next turn is on its spot (or slid for the road) at every fix", settled.length > 5 && worstNext <= 2, `worst ${worstNext.toFixed(2)} px over ${settled.length} fixes`);
    expect("the switch eased once (no jump)", eases === 1, `${eases} eases`);
    expect("while the map moves to the next turn, the turn dot waits where it lands, on its spot or slid for the road", glideFrames > 0 && glideTurn <= 2 && glideMiss <= 2, `${glideFrames} frames, worst ${glideTurn.toFixed(2)} px from where it lands, ${glideMiss.toFixed(2)} px off the rule`);
    const at = pg.ctx.turnMarker.getLngLat();
    expect("after the move, the turn dot is back on the real next turn", sameSpot(at, llObj(...T2)));
  }

  console.log(`\n${label}: through the turn when the next one is 3 mi on`);
  {
    const pg = page(view, { stops: routeStops([run([0, -2 * MILE], T1), run(T1, [3 * MILE, 0]), run([3 * MILE, 0], [3 * MILE, 2000])]) });
    let worstYou = 0;
    pg.map.onFrame = () => { worstYou = Math.max(worstYou, off(pg.map.project(pg.ctx.navYou.getLngLat()), L.you)); };
    const path = [];
    for (let y = -300; y <= 0; y += 10) path.push([0, y]);
    for (let x = 10; x <= 1800; x += 10) path.push([x, 0]);
    let next = [];
    let rotated = null;
    for (const [x, y] of path) {
      const got = fix(pg, x, y);
      worstYou = Math.max(worstYou, off(got.you, L.you));
      if (x === 200) rotated = pg.map.bearing;
      if (sameSpot(got.turnAt, llObj(3 * MILE, 0))) next.push(turnMiss(pg, got));
    }
    expect("your dot within 2 px of its spot the whole way", worstYou <= 2, `worst ${worstYou.toFixed(2)} px`);
    expect("past the turn the map turns to the road you are on (east up)", rotated != null && Math.abs(rotated - 90) < 3, `bearing ${rotated?.toFixed(1)}`);
    const settled = next.slice(1);
    const worst = settled.length ? Math.max(...settled) : Infinity;
    expect("a mile on, the next turn has the spot (or slid for the road)", settled.length > 3 && worst <= 2, `worst ${worst.toFixed(2)} px over ${settled.length} fixes`);
  }

  console.log(`\n${label}: GPS wobble near the turn does not flip the hold on and off`);
  {
    const pg = page(view, { stops: routeA() });
    for (let y = -200; y <= -30; y += 10) fix(pg, 0, y);
    fix(pg, 0, -19);
    const held = { zoom: pg.map.zoom, bearing: pg.map.bearing };
    let moved = 0;
    for (const y of [-22, -19.5, -25, -21, -18, -24, -16]) {
      fix(pg, 0.8 * Math.sign(y % 2 || 1), y);
      if (Math.abs(pg.map.zoom - held.zoom) > 1e-6 || Math.abs(pg.map.bearing - held.bearing) > 1e-6) moved += 1;
    }
    expect("zoom and bearing stay held between 16 and 25 m", moved === 0, `${moved} of 7 fixes moved the camera`);
  }

  console.log(`\n${label}: the dot's slide between fixes does not pull it off its spot`);
  {
    const pg = page(view, { stops: routeA() });
    const { ctx, map } = pg;
    // Like onNavFix: the dot is told to slide to the new fix, then Turn zoom frames it.
    const gpsFix = (y) => {
      const [lat, lon] = ll(0, y);
      ctx.clock.now += 1000;
      if (!ctx.navYou) ctx.placeNavDot(lat, lon);
      else ctx.aimNavDot(lat, lon);
      ctx.navFix = [lat, lon];
      ctx.frameNextTurn();
    };
    gpsFix(-800);
    gpsFix(-775);
    ctx.paintNavMotion(ctx.clock.now + 150);
    const you = map.project(ctx.navYou.getLngLat());
    expect("a frame after the fix, your dot is still on its spot", off(you, L.you) <= 2, `you ${px(you)}`);
  }

  console.log(`\n${label}: leaving Turn zoom puts the map's max zoom back`);
  {
    const pg = page(view, { stops: routeA() });
    const before = pg.map.getMaxZoom();
    fix(pg, 0, -60);
    const during = pg.map.getMaxZoom();
    expect("Turn zoom leaves the map's max zoom at 22 (it stops at street level itself)", during === before && pg.map.zoom <= 17 + 1e-9, `${before} -> ${during}, zoom ${pg.map.zoom.toFixed(2)}`);
    pg.ctx.cycleTripFit();
    expect("switching to the next-stop zoom restores 22 and frames the stop", pg.map.getMaxZoom() === before && pg.ctx.calls.includes("frameNextStop"), `max ${pg.map.getMaxZoom()}, calls [${pg.ctx.calls}]`);
    const zoomBefore = pg.map.zoom;
    pg.ctx.tripFit = "full";
    pg.ctx.syncTripFitButton();
    expect("Trip zoom keeps 22", pg.map.getMaxZoom() === before, `max ${pg.map.getMaxZoom()}`);
    expect("the other zooms are left alone (the map was not reframed)", pg.map.zoom === zoomBefore);
  }
}

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
