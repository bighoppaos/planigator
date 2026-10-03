// Turn zoom shows the road past the turn and stops zooming in at street level
// (Build #621). Not loaded by the site.
// Run: node tests/turn-zoom-cap.test.mjs
// Against another copy of app.js: APP_JS=/path/to/app.js node tests/turn-zoom-cap.test.mjs
//
// Same set-up as tests/turn-dot-lock.test.mjs: the real Turn zoom framing is
// loaded from js/app.js by name into a vm sandbox, over a fake MapLibre map
// doing real Web Mercator math (512px world), with the DOM stubbed to fixed
// boxes so the screen spots are known up front. The North lock check runs
// the same fixes through Build #620's app.js (from git) and compares cameras.

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appSource = readFileSync(process.env.APP_JS || path.join(root, "js/app.js"), "utf8");
const BUILD_620 = "290925a";
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
  "turnViewPadding", "railClearance", "noHandsSlots", "stretchMeters", "mercatorMpp", "cameraForStretch", "cameraForFullTurn",
  "placeTurnPin", "placeNavDot", "showNavCamera", "travelBearing", "frameNextTurn", "clearTurnFrame", "stopTurnZoomOut",
  "syncTripFitButton", "tripFitLines", "cycleTripFit", "aimNavDot", "paintNavMotion",
  "mercatorWorld", "mercatorLngLat", "wrapBearing", "cameraAtSpot", "spotOnCamera", "pinTwoPoints", "roadRoom",
  "turnPinFrame", "hookTurnPinGlide", "settleTurnPin", "framePinnedTurn", "showPinnedTurn",
];
// #620 has syncTurnMaxZoom (it raised the map's max zoom to 23); #621 does not.
const OPTIONAL_FUNCTIONS = ["syncTurnMaxZoom"];
const APP_CONSTS = [
  "MERCATOR_MPP0", "FULL_TURN_TOP_PX", "FULL_TURN_MAX_ZOOM", "NAV_DOT_HALO_PX", "NAV_DOT_CHIP_GAP_PX",
  "TURN_PIN_MAX_ZOOM", "TURN_PIN_HOLD_M", "TURN_PIN_HOLD_OUT_M", "TURN_PIN_PAST_M", "TURN_PIN_EASE_MS",
];
const OPTIONAL_CONSTS = ["TURN_PIN_AFTER_MIN_M", "TURN_PIN_AFTER_MAX_M"];

function appCode(source) {
  return [
    ...APP_CONSTS.map((name) => constLine(source, name)),
    ...OPTIONAL_CONSTS.map((name) => constLine(source, name, true)),
    ...APP_FUNCTIONS.map((name) => extract(source, name)),
    ...OPTIONAL_FUNCTIONS.map((name) => extract(source, name, true)),
  ].join("\n\n");
}
const APP_CODE = appCode(appSource);

// --- Ground, in meters east (x) and north (y) of a corner near Carlisle, PA. ---

const ORIGIN = [40.2, -77.1];
const COS = Math.cos(ORIGIN[0] * Math.PI / 180);
const ll = (x, y) => [ORIGIN[0] + y / 111320, ORIGIN[1] + x / (111320 * COS)];
const MILE = 1609.344;
const noop = () => {};

function run(from, to, stepM = 25) {
  const out = [];
  const n = Math.max(1, Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1]) / stepM));
  for (let k = 0; k <= n; k += 1) out.push([from[0] + (to[0] - from[0]) * (k / n), from[1] + (to[1] - from[1]) * (k / n)]);
  return out;
}

// An arc around (cx, cy) of radius r from angle a0 to a1 (degrees, 0 = east, counterclockwise).
function arc(cx, cy, r, a0, a1, stepM = 10) {
  const n = Math.max(2, Math.ceil((Math.abs(a1 - a0) * Math.PI / 180) * r / stepM));
  const out = [];
  for (let k = 0; k <= n; k += 1) {
    const a = (a0 + (a1 - a0) * (k / n)) * Math.PI / 180;
    out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
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

// --- The screen. Same boxes as tests/turn-dot-lock.test.mjs. ---

const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top });
const WIDTH = 390;
const LAYOUTS = {
  page: { height: 420, full: false, you: { x: 195, y: 347 }, turn: { x: 195, y: 120 }, box: { left: 92, right: 298, top: 12, bottom: 361 } },
  full: { height: 844, full: true, you: { x: 195, y: 549 }, turn: { x: 195, y: 96 }, box: { left: 92, right: 298, top: 51, bottom: 832 } },
};

function page(layout, { stops, code = APP_CODE, northLock = false }) {
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
    routeMap: map, routeFull: L.full, tripFit: "nextTurn", navOn: true, northLock,
    navLine: [], navLegs: [], navAimStopId: "dock", navStopPicked: false, navFix: null, navTravel: null,
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
  vm.runInContext(code, context);
  context.rebuildNavLegs();
  return { ctx: context, map, L };
}

// A route made of pieces, each ending at a maneuver.
function routeStops(pieces) {
  const pts = [];
  for (const piece of pieces) for (const p of piece) {
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(last[0] - p[0], last[1] - p[1]) > 1e-6) pts.push(p);
  }
  const pathLL = pts.map(([x, y]) => ll(x, y));
  const meters = (a) => {
    let total = 0;
    for (let i = 1; i < a.length; i += 1) total += navMatch.metersBetween(a[i - 1], a[i]);
    return total;
  };
  const directions = pieces.map((piece, i) => ({ text: i ? "Take ramp." : "Head north.", miles: meters(piece.map(([x, y]) => ll(x, y))) / MILE }));
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
const px = (p) => (p ? `(${p.x.toFixed(1)}, ${p.y.toFixed(1)})` : "none");
const lngLat = (x, y) => [ll(x, y)[1], ll(x, y)[0]];
const lngLatObj = (x, y) => ({ lat: ll(x, y)[0], lng: ll(x, y)[1] });
const sameSpot = (a, b) => a && b && Math.abs(a.lat - b.lat) < 1e-7 && Math.abs(a.lng - b.lng) < 1e-7;

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

// Route points (meters) between two distances along the route, projected.
function roadOnScreen(pg, fromAlong, toAlong) {
  return pg.ctx.navRemaining(fromAlong, toAlong).map((c) => pg.map.project(c));
}

function outsideBox(points, box) {
  return points.filter((p) => p.x < box.left - 1 || p.x > box.right + 1 || p.y < box.top - 1 || p.y > box.bottom + 1);
}

// Meters of route right past the turn that stay inside the box, walking on
// from the turn until the first point that leaves it.
function metersPastTurnInBox(pg, target) {
  const { ctx, map, L } = pg;
  const pts = ctx.navRemaining(target, target + 2000);
  let walked = 0;
  for (let i = 1; i < pts.length; i += 1) {
    const p = map.project(pts[i]);
    if (outsideBox([p], L.box).length) break;
    walked += navMatch.metersBetween([pts[i - 1][1], pts[i - 1][0]], [pts[i][1], pts[i][0]]);
  }
  return walked;
}

const afterRule = (left) => Math.max(400, Math.min(800, 0.5 * left));
const VIEWS = ["page", "full"];

for (const view of VIEWS) {
  const label = view === "page" ? "Page" : "Full screen";
  const L = LAYOUTS[view];

  // (a) 0.8 mi (1290 m) north of a ramp. Past the ramp it curls 270° to the
  // right around a cloverleaf loop (radius 100 m), then runs west under the
  // road you are on.
  console.log(`\n${label}: 0.8 mi before a ramp that curls 270° (cloverleaf)`);
  {
    const R = 100;
    const T = [0, 0];
    const after = [...arc(R, 0, R, 180, -90), ...run([R, -R], [-1500, -R]).slice(1)];
    const pg = page(view, { stops: routeStops([run([0, -3000], T), after]) });
    fix(pg, 0, -1330);
    const got = fix(pg, 0, -1290);
    const along = pg.ctx.turnGuideAlong();
    const target = pg.ctx.turnLockAlong;
    const left = target - along;
    expect("set-up: the turn locked is the ramp, 0.8 mi on", Math.abs(left - 1290) < 5 && got.turnAt
      && Math.abs(got.turnAt.lat - ll(...T)[0]) < 1e-6, `${left.toFixed(0)} m to the turn`);
    expect("zoom is street level or wider (<= 17)", pg.map.zoom <= 17 + 1e-9, `zoom ${pg.map.zoom.toFixed(2)}`);
    expect("your dot on its spot", off(got.you, L.you) <= 2, px(got.you));
    const toTurn = outsideBox(roadOnScreen(pg, along, target), L.box);
    expect("all the road from you to the ramp is inside the box", toTurn.length === 0, `${toTurn.length} points outside, e.g. ${px(toTurn[0])}`);
    const past = metersPastTurnInBox(pg, target);
    expect("at least 400 m of route past the ramp is inside the box", past >= 400, `${past.toFixed(0)} m`);
    expect(`the rule's ${afterRule(left).toFixed(0)} m past the ramp (half the 1290 m) is inside the box`, past >= afterRule(left) - 5, `${past.toFixed(0)} m`);
    const k = (got.turn.y - L.you.y) / (L.turn.y - L.you.y);
    const lineX = L.you.x + (L.turn.x - L.you.x) * k;
    expect("the turn dot is on the line toward its spot (slid toward you, not off to a side)", Math.abs(got.turn.x - lineX) <= 2 && k > 0 && k <= 1.01, `turn ${px(got.turn)}`);
  }

  // (a, the screenshot) He is on the ramp off one road: it loops 270° around
  // a cloverleaf (radius 100 m) and runs west to "Take ramp" 1290 m on, which
  // turns right (north). #620 fits the zoom to that loop alone, puts the turn
  // on the top spot, and there is next to no road past it on screen.
  console.log(`\n${label}: the road to the ramp is a cloverleaf loop (the screenshot)`);
  {
    const R = 100;
    const exit = [0, -250];
    const M = [100 - 779, -300];
    const toRamp = [...run(exit, [0, -200]), ...arc(R, -200, R, 180, -90).slice(1), ...run([R, -300], M).slice(1)];
    const pg = page(view, { stops: routeStops([run([0, -1500], exit), toRamp, run(M, [M[0], 2500])]) });
    fix(pg, 0, -245);
    const got = fix(pg, 0, -240);
    const along = pg.ctx.turnGuideAlong();
    const target = pg.ctx.turnLockAlong;
    const left = target - along;
    expect("set-up: the turn locked is the ramp, 0.8 mi on", Math.abs(left - 1290) < 10, `${left.toFixed(0)} m to the turn`);
    expect("zoom is street level or wider (<= 17)", pg.map.zoom <= 17 + 1e-9, `zoom ${pg.map.zoom.toFixed(2)}`);
    expect("your dot on its spot", off(got.you, L.you) <= 2, px(got.you));
    const toTurn = outsideBox(roadOnScreen(pg, along, target), L.box);
    expect("all the road from you to the ramp (the whole loop) is inside the box", toTurn.length === 0, `${toTurn.length} points outside, e.g. ${px(toTurn[0])}`);
    const past = metersPastTurnInBox(pg, target);
    expect("at least 400 m of route past the ramp is inside the box", past >= 400, `${past.toFixed(0)} m, zoom ${pg.map.zoom.toFixed(2)}`);
  }

  // (a, the too-close cause) Turn zoom comes on (or hands over to the ramp)
  // where the road passes 17 m from the ramp's start, but the route first
  // loops 1290 m around to reach it. #620 measured "near the turn" as the
  // crow flies, held, and with no zoom to hold aimed at a point 20 m ahead:
  // zoom ~20, the loop and the ramp off screen.
  console.log(`\n${label}: the road passes beside the ramp 0.8 mi before reaching it`);
  {
    const R = 135;
    const M = [-12, 2];
    const loop = [
      ...run([0, -3000], [0, 300]),
      ...arc(-R, 300, R, 0, 180).slice(1),
      ...run([-2 * R, 300], [-2 * R, 2]).slice(1),
      ...run([-2 * R, 2], M).slice(1),
    ];
    const pg = page(view, { stops: routeStops([loop, run(M, [M[0] - 600, M[1] - 600])]) });
    const got = fix(pg, 0, -10);
    const along = pg.ctx.turnGuideAlong();
    const target = pg.ctx.turnLockAlong;
    const left = target - along;
    const crow = navMatch.metersBetween(ll(0, -10), ll(...M));
    expect("set-up: 0.8 mi to the ramp by road, under 20 m as the crow flies", Math.abs(left - 1290) < 10 && crow < 20, `${left.toFixed(0)} m by road, ${crow.toFixed(1)} m straight`);
    expect("zoom is street level or wider (<= 17)", pg.map.zoom <= 17 + 1e-9, `zoom ${pg.map.zoom.toFixed(2)}`);
    expect("your dot on its spot", off(got.you, L.you) <= 2, px(got.you));
    const toTurn = outsideBox(roadOnScreen(pg, along, target), L.box);
    expect("all the road from you around the loop to the ramp is inside the box", toTurn.length === 0, `${toTurn.length} of ${roadOnScreen(pg, along, target).length} points outside, e.g. ${px(toTurn[0])}`);
    // Driving on past the ramp's start: Turn zoom keeps framing the ramp
    // (turn dot on the line toward its spot), it does not freeze the camera
    // as if he were 20 m from the turn.
    const drive = page(view, { stops: routeStops([loop, run(M, [M[0] - 600, M[1] - 600])]) });
    let worstLine = 0;
    let worstAt = "";
    for (const y of [-40, -30, -22, -14, -6, 2, 10, 18, 26]) {
      const g = fix(drive, 0, y);
      const k = (g.turn.y - L.you.y) / (L.turn.y - L.you.y);
      const miss = k > 0 && k <= 1.01 ? Math.abs(g.turn.x - (L.you.x + (L.turn.x - L.you.x) * k)) : Infinity;
      if (miss > worstLine) { worstLine = miss; worstAt = `y ${y}, turn ${px(g.turn)}`; }
    }
    expect("driving past the ramp's start: the turn dot stays on the line toward its spot", worstLine <= 2, `worst ${worstLine.toFixed(2)} px (${worstAt})`);
  }

  // (b) Close to a turn. North 3 km to a right turn; past it the route runs
  // east 1 km, then north.
  console.log(`\n${label}: close to a turn`);
  {
    const T = [0, 0];
    const pg = page(view, { stops: routeStops([run([0, -3000], T), run(T, [1000, 0]), run([1000, 0], [1000, 2000])]) });
    for (let y = -300; y < -60; y += 20) fix(pg, 0, y);
    const at60 = fix(pg, 0, -60);
    expect("60 m out: zoom <= 17", pg.map.zoom <= 17 + 1e-9, `zoom ${pg.map.zoom.toFixed(2)}`);
    expect("60 m out: your dot on its spot", off(at60.you, L.you) <= 2, px(at60.you));
    let worstZoom = 0;
    let worstYou = 0;
    let holds = 0;
    for (let y = -55; y <= -12; y += 3) {
      const got = fix(pg, 0, y);
      if (pg.ctx.turnPin?.mode === "hold") holds += 1;
      worstZoom = Math.max(worstZoom, pg.map.zoom);
      worstYou = Math.max(worstYou, off(got.you, L.you));
    }
    expect("set-up: the last fixes are inside the hold range", holds >= 3, `${holds} fixes held`);
    expect("in to 12 m (hold included): zoom <= 17 every fix", worstZoom <= 17 + 1e-9, `highest ${worstZoom.toFixed(2)}`);
    expect("in to 12 m (hold included): your dot within 2 px of its spot", worstYou <= 2, `worst ${worstYou.toFixed(2)} px`);
  }

  // (b) The street-level max on its own: the stop is 30 m past the turn, so
  // there is no road past it to show, and pinning would need zoom ~18-19.
  console.log(`\n${label}: 60 m from a turn 30 m before the stop`);
  {
    const T = [0, 0];
    const pg = page(view, { stops: routeStops([run([0, -2000], T), run(T, [30, 0], 10)]) });
    fix(pg, 0, -80);
    const got = fix(pg, 0, -60);
    expect("zoom stops at 17", Math.abs(pg.map.zoom - 17) < 1e-6, `zoom ${pg.map.zoom.toFixed(2)}`);
    expect("your dot on its spot", off(got.you, L.you) <= 2, px(got.you));
    const truth = pg.map.project(lngLat(...T));
    expect("the turn dot is where the turn really is (not pinned to the top spot)", got.turn && off(got.turn, truth) <= 1 && off(got.turn, L.turn) > 20, `turn ${px(got.turn)}, real ${px(truth)}`);
  }

  // (b) Through a turn onto a short street: the next turn is 40 m on and the
  // stop 30 m past it, so the new turn is framed at street level. While the
  // map eases over, the turn dot waits where that turn really lands.
  console.log(`\n${label}: easing to a next turn framed at street level`);
  {
    const T1 = [0, 0];
    const T2 = [40, 0];
    const pg = page(view, { stops: routeStops([run([0, -1000], T1), run(T1, T2, 5), run(T2, [40, 30], 5)]) });
    let gliding = [];
    let glideFrames = 0;
    let jump = 0;
    let capped = false;
    pg.map.onFrame = () => {
      if (pg.ctx.turnPin?.glide && pg.ctx.turnMarker) gliding.push(pg.map.project(pg.ctx.turnMarker.getLngLat()));
    };
    for (let y = -120; y <= 0; y += 4) {
      gliding = [];
      const got = fix(pg, 0, y);
      if (gliding.length && sameSpot(got.turnAt, lngLatObj(...T2))) {
        glideFrames += gliding.length;
        if (Math.abs(pg.map.zoom - 17) < 1e-6) capped = true;
        jump = Math.max(jump, ...gliding.map((p) => off(p, got.turn)));
      }
    }
    expect("set-up: the map eased to the next turn at the street-level max", glideFrames > 0 && capped, `${glideFrames} frames, capped ${capped}`);
    expect("the turn dot waits where the next turn lands (no jump when the map stops)", jump <= 2, `worst ${jump.toFixed(2)} px`);
  }

  // (c) A long straight approach: 4 km to a right turn, 1 km east, then north.
  // The 800 m past the turn already fits beside the turn spot, so the camera
  // is #620's: both dots on their spots, no extra zoom out.
  console.log(`\n${label}: 4 km of straight road to the turn`);
  {
    const T = [0, 0];
    const pg = page(view, { stops: routeStops([run([0, -6000], T, 100), run(T, [1000, 0]), run([1000, 0], [1000, 3000], 100)]) });
    fix(pg, 0, -4040);
    const got = fix(pg, 0, -4000);
    const screen = Math.hypot(L.turn.x - L.you.x, L.turn.y - L.you.y);
    const a = pg.ctx.mercatorWorld(...lngLat(0, -4000));
    const b = pg.ctx.mercatorWorld(...lngLat(...T));
    const pinZoom = Math.log2(screen / Math.hypot(b.x - a.x, b.y - a.y));
    expect("your dot on its spot", off(got.you, L.you) <= 2, px(got.you));
    expect("the turn on its spot", got.turn && off(got.turn, L.turn) <= 2, px(got.turn));
    expect("no extra zoom out: zoom is the two-dot pin zoom", Math.abs(pg.map.zoom - pinZoom) < 0.01, `zoom ${pg.map.zoom.toFixed(3)}, pin ${pinZoom.toFixed(3)}`);
    const past = metersPastTurnInBox(pg, pg.ctx.turnLockAlong);
    expect("the 800 m past the turn is on screen", past >= 795, `${past.toFixed(0)} m`);
  }

  // (d) The map's max zoom.
  console.log(`\n${label}: the map's max zoom`);
  {
    const T = [0, 0];
    const pg = page(view, { stops: routeStops([run([0, -2000], T), run(T, [30, 0], 10)]) });
    const before = pg.map.getMaxZoom();
    pg.ctx.syncTripFitButton();
    fix(pg, 0, -60);
    fix(pg, 0, -40);
    const during = pg.map.getMaxZoom();
    expect("during Turn zoom the map's max zoom is not raised to 23", during === before, `${before} -> ${during}`);
    pg.ctx.cycleTripFit();
    expect("leaving Turn zoom, the max zoom is the map's own", pg.map.getMaxZoom() === before, `max ${pg.map.getMaxZoom()}`);
    pg.ctx.tripFit = "nextTurn";
    pg.ctx.syncTripFitButton();
    pg.ctx.navOn = false;
    pg.ctx.syncTripFitButton();
    expect("after navigation ends, still the map's own", pg.map.getMaxZoom() === before, `max ${pg.map.getMaxZoom()}`);
  }
}

// (e) North lock: the same fixes give the same camera as Build #620.
console.log("\nNorth lock: same camera as Build #620");
{
  let code620 = "";
  try {
    code620 = appCode(execFileSync("git", ["show", `${BUILD_620}:js/app.js`], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
  } catch (err) {
    expect(`read Build #620's app.js from git (${BUILD_620})`, false, String(err.message || err).split("\n")[0]);
  }
  if (code620) {
    const R = 100;
    const T = [0, 0];
    const stops = () => routeStops([run([0, -3000], T), [...arc(R, 0, R, 180, -90), ...run([R, -R], [-1500, -R]).slice(1)]]);
    for (const view of VIEWS) {
      for (const y of [-2400, -1290, -300, -60, -18]) {
        const now = page(view, { stops: stops(), northLock: true });
        const old = page(view, { stops: stops(), northLock: true, code: code620 });
        for (const pg of [now, old]) { fix(pg, 0, y - 40); fix(pg, 0, y); }
        const a = now.map;
        const b = old.map;
        const same = Math.abs(a.zoom - b.zoom) < 1e-9 && Math.abs(a.bearing - b.bearing) < 1e-9
          && Math.abs(a.center.lat - b.center.lat) < 1e-12 && Math.abs(a.center.lng - b.center.lng) < 1e-12;
        expect(`${view}, ${-y} m out: same zoom, bearing and center`, same, `zoom ${a.zoom.toFixed(4)} vs ${b.zoom.toFixed(4)}, bearing ${a.bearing.toFixed(2)} vs ${b.bearing.toFixed(2)}`);
      }
    }
  }
}

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
