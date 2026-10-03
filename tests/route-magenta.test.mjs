// The current trip's route line is bold magenta #C026D3 with a #6B0F72 casing,
// on the light and dark street maps and on satellite. Not loaded by the site.
// Run: node tests/route-magenta.test.mjs
// Against another copy of app.js: APP_JS=/path/to/app.js node tests/route-magenta.test.mjs
//
// Loads the real route-line code (ensureRouteLayers, paintRouteLines,
// paintNavLine, navRemaining, routeFeatureCollection, endRouteNav and the
// dark street theme) from js/app.js by name into a vm sandbox, plus the layer
// block of mountMap's load handler. The map is a fake MapLibre map; paint
// expressions are resolved per feature the way MapLibre would.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appSource = readFileSync(process.env.APP_JS || path.join(root, "js/app.js"), "utf8");

// Reads from `start` to the end of a balanced statement: the closing brace of a
// function body, or the `;` that ends a top-level const.
function readBalanced(start, endAtSemicolon) {
  let depth = 0;
  let quote = "";
  let seenBody = false;
  for (let i = start; i < appSource.length; i += 1) {
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
    if (ch === "/" && appSource[i + 1] === "[") {
      i = appSource.indexOf("/", i + 2);
      continue;
    }
    if (ch === "'" || ch === "\"" || ch === "`") quote = ch;
    else if (ch === "{" || ch === "(" || ch === "[") {
      depth += 1;
      if (ch === "{") seenBody = true;
    } else if (ch === "}" || ch === ")" || ch === "]") {
      depth -= 1;
      if (!endAtSemicolon && !depth && seenBody && ch === "}") return appSource.slice(start, i + 1);
    } else if (endAtSemicolon && ch === ";" && !depth) return appSource.slice(start, i + 1);
  }
  throw new Error("Could not read a statement");
}

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
  const body = readBalanced(appSource.indexOf("{", i), false);
  return appSource.slice(head.index, appSource.indexOf("{", i)) + body;
}

function constDecl(name, optional = false) {
  const head = new RegExp(`^const ${name} = `, "m").exec(appSource);
  if (!head) {
    if (optional) return "";
    throw new Error(`app.js has no const ${name}`);
  }
  return readBalanced(head.index, true).replace(/^const /, "var ");
}

// Order matters: DARK_STREET_PAINT may use the route casing color.
const CONSTS = [
  ["ROUTE_CURRENT_COLOR", true], ["ROUTE_DRIVEN_COLOR", true], ["ROUTE_CURRENT_CASING", true],
  ["ROUTE_LINE_COLOR", false], ["ROUTE_DRIVEN_LINE_COLOR", true], ["ROUTE_CASING_COLOR", true],
  ["DARK_STREET_TEXT", false], ["DARK_STREET_PAINT", false], ["DARK_STREET_RULES", false], ["streetThemeSaved", false],
];
const FUNCTIONS = [
  "ensureRouteLayers", "paintRouteLines", "restoreRouteLine", "paintNavLine", "navRemaining", "metersBetween",
  "routeFeatureCollection", "activeNavLeg", "darkStreetPaint", "restoreStreetPaint", "darkenStreetPaint",
  "syncStreetTheme", "endRouteNav",
];
// #618 has no paintRouteColor; it runs without it so this test can show it failing.
const OPTIONAL_FUNCTIONS = ["paintRouteColor"];
const APP_CODE = [
  ...CONSTS.map(([name, optional]) => constDecl(name, optional)),
  ...FUNCTIONS.map((name) => extract(name)),
  ...OPTIONAL_FUNCTIONS.map((name) => extract(name, true)),
].join("\n\n");

// mountMap's load handler: everything from adding the route source up to the theme sync.
const MOUNT_LAYERS = (() => {
  const mount = extract("mountMap");
  const start = mount.indexOf("map.addSource(\"route\"");
  const end = mount.indexOf("syncStreetTheme(true);", start);
  if (start < 0 || end < 0) throw new Error("mountMap has no route layer block");
  return mount.slice(start, end);
})();

const PRELUDE_VARS = {
  state: "{ darkMode: false, stops: [] }",
  basemap: "\"vector\"",
  routeMap: "null",
  routeMapReady: "false",
  navOn: "false",
  navFix: "null",
  navLine: "[]",
  navLegs: "[]",
  navAimStopId: "\"\"",
  turnShownAlong: "null",
};
const PRELUDE_FUNCS = {
  navNearest: "function navNearest() { return { along: 0 }; }",
  legUnderFix: "function legUnderFix() { return null; }",
};

// endRouteNav calls many UI helpers that do not matter here. Every name it uses
// that the sandbox does not define becomes a no-op function (when called) or null.
const KEYWORDS = new Set(("function const let var if else return true false null new typeof of in for while do break "
  + "continue undefined this await async try catch throw Infinity Number Array Math Object JSON String Boolean window "
  + "document").split(" "));
function autoStubs(source, known) {
  const out = new Map();
  const re = /(?<![.\w$])([A-Za-z_$][\w$]*)(\s*\()?/g;
  let m;
  while ((m = re.exec(source))) {
    const name = m[1];
    if (KEYWORDS.has(name) || known.has(name) || out.has(name)) continue;
    out.set(name, m[2] ? `function ${name}() {}` : `var ${name} = null;`);
  }
  return [...out.values()].join("\n");
}
const KNOWN = new Set([
  ...CONSTS.map(([name]) => name), ...FUNCTIONS, ...OPTIONAL_FUNCTIONS,
  ...Object.keys(PRELUDE_VARS), ...Object.keys(PRELUDE_FUNCS),
]);
const STUBS = autoStubs(extract("endRouteNav"), KNOWN);

// --- MapLibre expressions, resolved for one feature. ---

function evaluate(expr, props) {
  if (!Array.isArray(expr)) return expr;
  const [op, ...args] = expr;
  if (op === "get") return props[args[0]];
  if (op === "==") return evaluate(args[0], props) === evaluate(args[1], props);
  if (op === "case") {
    for (let i = 0; i + 1 < args.length; i += 2) if (evaluate(args[i], props)) return evaluate(args[i + 1], props);
    return evaluate(args[args.length - 1], props);
  }
  throw new Error(`expression op ${op} is not handled by this test`);
}
const CURRENT = { current: 1 };
const OTHER = { current: 0 };
const lc = (v) => String(v).toLowerCase();

// --- Colors: hue in degrees, from #hex, rgb() or hsl(). ---

function hue(color) {
  const s = String(color).trim();
  let m = /^hsla?\(\s*([\d.]+)/i.exec(s);
  if (m) return Number(m[1]) % 360;
  let r;
  let g;
  let b;
  m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
  if (m) {
    const hex = m[1].length === 3 ? m[1].replace(/./g, "$&$&") : m[1];
    [r, g, b] = [0, 2, 4].map((k) => parseInt(hex.slice(k, k + 2), 16));
  } else if ((m = /^rgba?\(([^)]+)\)$/i.exec(s))) {
    [r, g, b] = m[1].split(",").map((part) => Number(part.trim()));
  } else return NaN;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return NaN;
  let h;
  if (max === r) h = ((g - b) / (max - min)) % 6;
  else if (max === g) h = (b - r) / (max - min) + 2;
  else h = (r - g) / (max - min) + 4;
  return (h * 60 + 360) % 360;
}
const hueGap = (a, b) => {
  const d = Math.abs(hue(a) - hue(b));
  return Math.min(d, 360 - d);
};

// --- A fake MapLibre map. ---

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

class FakeMap {
  constructor({ layers = [], sources = {} } = {}) {
    this.layers = clone(layers);
    this.sources = { ...sources };
    this.container = { classList: { toggle() {} } };
  }
  layer(id) { return this.layers.find((item) => item.id === id); }
  index(id) { return this.layers.findIndex((item) => item.id === id); }
  getContainer() { return this.container; }
  isStyleLoaded() { return true; }
  getStyle() { return { version: 8, sources: { ...this.sources }, layers: clone(this.layers) }; }
  getLayer(id) { return this.layer(id); }
  getSource(id) { return this.sources[id]; }
  addSource(id, spec) {
    this.sources[id] = { type: spec.type, data: clone(spec.data), setData(data) { this.data = clone(data); } };
  }
  addLayer(layer) { this.layers.push({ ...clone(layer), paint: clone(layer.paint || {}) }); }
  getPaintProperty(id, prop) { return clone(this.layer(id)?.paint?.[prop]); }
  setPaintProperty(id, prop, value) {
    const layer = this.layer(id);
    if (layer) layer.paint[prop] = clone(value);
    return this;
  }
  easeTo() { return this; }
}

const LIBERTY = [
  { id: "background", type: "background", paint: { "background-color": "#f8f4f0" } },
  { id: "park", type: "fill", paint: { "fill-color": "#d8e8c8", "fill-outline-color": "rgba(95, 208, 100, 1)" } },
  { id: "water", type: "fill", paint: { "fill-color": "rgb(158,189,255)" } },
  { id: "road_trunk_primary", type: "line", paint: { "line-color": "#fea" } },
  { id: "road_motorway", type: "line", paint: { "line-color": ["interpolate", ["linear"], ["zoom"], 5, "hsl(26,87%,62%)", 6, "#fc8"] } },
];
const SATELLITE = [
  { id: "satellite", type: "raster", paint: {} },
  { id: "places", type: "raster", paint: {} },
];

// Two legs: the first is the one being driven toward (current), the second is not.
const STOPS = [
  { id: "start", useCurrentLocation: true },
  { id: "a", path: [[40.0, -76.3], [40.01, -76.29], [40.02, -76.28], [40.03, -76.27]] },
  { id: "b", path: [[40.03, -76.27], [40.05, -76.25], [40.07, -76.23]] },
];

function makeWorld({ darkMode = false, basemap = "vector", mount = "ensure" } = {}) {
  const sandbox = {
    console, JSON, Object, Map, WeakMap, Set, RegExp, Boolean, Number, String, Array, Math, Date, Infinity,
    document: { getElementById: () => null, querySelectorAll: () => [] },
    window: { setTimeout: () => 1, clearTimeout() {}, removeEventListener() {} },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const prelude = [
    ...Object.entries(PRELUDE_VARS).map(([name, value]) => `var ${name} = ${value};`),
    ...Object.values(PRELUDE_FUNCS),
    STUBS,
  ].join("\n");
  vm.runInContext(prelude + "\n" + APP_CODE, sandbox);
  vm.runInContext(`state.darkMode = ${darkMode}; basemap = ${JSON.stringify(basemap)};`, sandbox);
  sandbox.__stops = clone(STOPS);
  vm.runInContext("state.stops = __stops;", sandbox);
  const map = basemap === "vector"
    ? new FakeMap({ layers: LIBERTY, sources: { openmaptiles: { type: "vector" } } })
    : new FakeMap({ layers: SATELLITE, sources: { satellite: { type: "raster" }, places: { type: "raster" } } });
  sandbox.routeMap = map;
  sandbox.__map = map;
  if (mount === "ensure") vm.runInContext("ensureRouteLayers(routeMap);", sandbox);
  else vm.runInContext(`(function (map) {\n${MOUNT_LAYERS}\n})(__map);`, sandbox);
  vm.runInContext("syncStreetTheme(true); routeMapReady = true;", sandbox);
  const run = (code) => vm.runInContext(code, sandbox);
  return { sandbox, map, run };
}

let failures = 0;
let passes = 0;
function check(name, cond, detail = "") {
  if (cond) {
    passes += 1;
    console.log(`ok   ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` -- ${detail}` : ""}`);
  }
}

const paint = (map, id, prop = "line-color") => map.layer(id)?.paint?.[prop];
const color = (map, id, props) => lc(evaluate(paint(map, id), props));
const MAGENTA = "#c026d3";
const CASING = "#6b0f72";
const DRIVEN = "#e3a6ec";
const leftCoords = (map) => map.getSource("left")?.data?.geometry?.coordinates || [];

// --- a. Not navigating: current part magenta on a #6B0F72 casing, the other leg as before. ---
{
  const w = makeWorld();
  const data = w.map.getSource("route").data;
  const flags = data.features.map((f) => f.properties.current).join(",");
  check(`a. routeFeatureCollection marks the first leg current and the second not (${flags})`, flags === "1,0");
  check(`a. route current part is #C026D3 (${color(w.map, "route", CURRENT)})`, color(w.map, "route", CURRENT) === MAGENTA);
  check(`a. route-casing under the current part is #6B0F72 (${color(w.map, "route-casing", CURRENT)})`,
    color(w.map, "route-casing", CURRENT) === CASING);
  check(`a. non-current part stays #1f8a62 (${color(w.map, "route", OTHER)})`, color(w.map, "route", OTHER) === "#1f8a62");
  check(`a. non-current casing stays white (${color(w.map, "route-casing", OTHER)})`, color(w.map, "route-casing", OTHER) === "#ffffff");
  w.run("paintRouteLines();");
  check("a. paintRouteLines keeps the current part bold #C026D3", color(w.map, "route", CURRENT) === MAGENTA);
  check("a. widths unchanged: route 4, route-casing 7, left 6",
    paint(w.map, "route", "line-width") === 4 && paint(w.map, "route-casing", "line-width") === 7
    && paint(w.map, "left", "line-width") === 6);
}

// --- b. "left" is magenta with a #6B0F72 casing beneath it, in both layer-creation paths. ---
for (const mount of ["ensure", "mountMap"]) {
  const label = mount === "ensure" ? "ensureRouteLayers" : "mountMap load";
  const w = makeWorld({ mount });
  check(`b. ${label}: left is #C026D3 (${color(w.map, "left", {})})`, color(w.map, "left", {}) === MAGENTA);
  const casing = w.map.layer("left-casing");
  check(`b. ${label}: a left-casing layer exists on the left source`, casing && casing.source === "left" && casing.type === "line");
  check(`b. ${label}: left-casing is #6B0F72`, casing && color(w.map, "left-casing", {}) === CASING);
  check(`b. ${label}: left-casing is wider than left`,
    casing && paint(w.map, "left-casing", "line-width") > paint(w.map, "left", "line-width"));
  check(`b. ${label}: left-casing draws right under left, above route`,
    casing && w.map.index("left-casing") === w.map.index("left") - 1 && w.map.index("left-casing") > w.map.index("route"));
  check(`b. ${label}: route casing current #6B0F72, non-current white`,
    color(w.map, "route-casing", CURRENT) === CASING && color(w.map, "route-casing", OTHER) === "#ffffff");
}

// --- c. Navigating: the driven part is the lighter shade; End navigation makes it bold again. ---
{
  const w = makeWorld();
  w.run(`
    navOn = true;
    navLine = state.stops[1].path.concat(state.stops[2].path.slice(1));
    navFix = navLine[1];
    paintRouteLines();
    paintNavLine(metersBetween(navLine[0], navLine[1]), metersBetween(navLine[0], navLine[1]) + metersBetween(navLine[1], navLine[2]) + metersBetween(navLine[2], navLine[3]));
  `);
  check(`c. navigating: the left line is drawn (${leftCoords(w.map).length} points)`, leftCoords(w.map).length >= 2);
  check(`c. navigating: left (still to drive) is bold #C026D3`, color(w.map, "left", {}) === MAGENTA);
  check(`c. navigating: driven current part is #E3A6EC (${color(w.map, "route", CURRENT)})`, color(w.map, "route", CURRENT) === DRIVEN);
  check("c. navigating: driven part casing stays #6B0F72", color(w.map, "route-casing", CURRENT) === CASING);
  check(`c. navigating: non-current leg stays #1f8a62 (${color(w.map, "route", OTHER)})`, color(w.map, "route", OTHER) === "#1f8a62");

  w.run("paintRouteLines(); paintNavLine(5, 5);");
  check("c. navigating with nothing left to draw: the current part is bold again",
    leftCoords(w.map).length === 0 && color(w.map, "route", CURRENT) === MAGENTA);

  w.run(`paintRouteLines(); paintNavLine(0, 1e9);`);
  check("c. navigating again: driven shade back on", color(w.map, "route", CURRENT) === DRIVEN);
  let threw = null;
  try { w.run("endRouteNav({ paint: false });"); } catch (error) { threw = error; }
  check("c. endRouteNav runs", !threw, threw?.message);
  check("c. after End navigation: left line is cleared", leftCoords(w.map).length === 0);
  check(`c. after End navigation: current part bold #C026D3 again (${color(w.map, "route", CURRENT)})`,
    color(w.map, "route", CURRENT) === MAGENTA);
  check("c. after End navigation: non-current leg still #1f8a62", color(w.map, "route", OTHER) === "#1f8a62");
}

// --- d. Dark street map: current casing stays #6B0F72, the rest #0b1114; leaving dark restores. ---
{
  const w = makeWorld({ darkMode: true });
  check(`d. dark: current casing #6B0F72 (${color(w.map, "route-casing", CURRENT)})`, color(w.map, "route-casing", CURRENT) === CASING);
  check(`d. dark: non-current casing #0b1114 (${color(w.map, "route-casing", OTHER)})`, color(w.map, "route-casing", OTHER) === "#0b1114");
  check("d. dark: route current #C026D3, left #C026D3, left-casing #6B0F72",
    color(w.map, "route", CURRENT) === MAGENTA && color(w.map, "left", {}) === MAGENTA
    && w.map.layer("left-casing") && color(w.map, "left-casing", {}) === CASING);
  check("d. dark: the water is darkened, so the theme really ran", lc(paint(w.map, "water", "fill-color")) !== "rgb(158,189,255)");
  w.run("state.darkMode = false; syncStreetTheme();");
  check("d. leaving dark: current casing #6B0F72, non-current white again",
    color(w.map, "route-casing", CURRENT) === CASING && color(w.map, "route-casing", OTHER) === "#ffffff");
  check("d. leaving dark: water back to liberty's", paint(w.map, "water", "fill-color") === "rgb(158,189,255)");
  w.run("state.darkMode = true; syncStreetTheme();");
  check("d. dark again: current #6B0F72, non-current #0b1114",
    color(w.map, "route-casing", CURRENT) === CASING && color(w.map, "route-casing", OTHER) === "#0b1114");

  const sat = makeWorld({ darkMode: true, basemap: "satellite" });
  check("d. satellite + dark mode: same colors, no dark casing",
    color(sat.map, "route", CURRENT) === MAGENTA && color(sat.map, "route-casing", CURRENT) === CASING
    && color(sat.map, "route-casing", OTHER) === "#ffffff" && color(sat.map, "left", {}) === MAGENTA);
}

// --- e. No old blues, and the new colors are far in hue from water, parks and highways. ---
{
  const seen = new Set();
  const collect = (v) => {
    if (Array.isArray(v)) v.forEach(collect);
    else if (typeof v === "string" && /^(#|rgb|hsl)/i.test(v)) seen.add(lc(v));
  };
  for (const darkMode of [false, true]) {
    for (const mount of ["ensure", "mountMap"]) {
      const w = makeWorld({ darkMode, mount });
      w.run("navOn = true; navLine = state.stops[1].path; paintRouteLines(); paintNavLine(0, 1e9);");
      for (const id of ["route", "route-casing", "left", "left-casing"]) collect(paint(w.map, id));
    }
  }
  const list = [...seen].join(" ");
  check(`e. no route/left/casing color is the old #2f6fed or #9ec5ff (${list})`, !seen.has("#2f6fed") && !seen.has("#9ec5ff"));

  const w = makeWorld();
  const dark = w.sandbox.DARK_STREET_PAINT;
  const basemapColors = {
    "light water": "rgb(158,189,255)",
    "light park": "#d8e8c8",
    "light park outline": "rgba(95, 208, 100, 1)",
    "light trunk": "#fea",
    "light motorway": "#fc8",
    "light motorway (low zoom)": "hsl(26,87%,62%)",
    "dark water": dark.water["fill-color"],
    "dark river": dark.waterway_river["line-color"],
    "dark park": dark.park["fill-color"],
    "dark park outline": dark.park_outline["line-color"],
    "dark trunk": dark["*_trunk_primary"]["line-color"],
    "dark motorway": dark["*_motorway"]["line-color"],
    "location dot": "#2f6fed",
  };
  const ours = { "route current": MAGENTA, "driven": DRIVEN, "casing": CASING };
  for (const [name, mine] of Object.entries(ours)) {
    const near = Object.entries(basemapColors)
      .filter(([, theirs]) => !(hueGap(mine, theirs) >= 60))
      .map(([label, theirs]) => `${label} ${theirs} ${hueGap(mine, theirs).toFixed(0)}°`);
    check(`e. ${name} ${mine} is at least 60° of hue from water, park, highway and the location dot`, near.length === 0, near.join(", "));
  }
  const routeCurrent = color(w.map, "route", CURRENT);
  const nearMap = Object.entries(basemapColors)
    .filter(([, theirs]) => !(hueGap(routeCurrent, theirs) >= 60))
    .map(([label]) => label);
  check(`e. the line app.js draws for the current part (${routeCurrent}) is far from them too`, nearMap.length === 0, nearMap.join(", "));
}

console.log(`\n${passes} passed, ${failures} failed`);
if (failures) process.exit(1);
