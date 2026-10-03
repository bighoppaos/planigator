// The street map goes dark only when Planigator's own Dark mode is on, by
// changing paint in place on the map the user sees. Not loaded by the site.
// Run: node tests/dark-street-map.test.mjs
// Against another copy of app.js: APP_JS=/path/to/app.js node tests/dark-street-map.test.mjs
//
// Loads the real theme and basemap code (toggleDarkMode, applyBasemap,
// ensureRouteLayers, syncStreetTheme and its helpers) from js/app.js by name
// into a vm sandbox. The map is a fake MapLibre map holding liberty layer ids
// and the app's route layers; it records every paint, style, source, marker
// and camera call so the test can see what changed and what did not.

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

const APP_FUNCTIONS = [
  "applyDarkMode", "themeButtonLabel", "toggleDarkMode", "routeStyle", "styleIsBasemap", "ensureRouteLayers",
  "paintRouteLines", "restoreRouteLine", "queueBasemap", "applyBasemap",
];
// #613 has none of these; it runs without them so this test can show it failing.
const OPTIONAL_FUNCTIONS = ["darkStreetPaint", "restoreStreetPaint", "darkenStreetPaint", "syncStreetTheme"];
const APP_CONSTS = ["vectorStyleUrl", "ROUTE_LINE_COLOR"];
// #619's route colors; ROUTE_LINE_COLOR and DARK_STREET_PAINT use them, so they load first.
const ROUTE_CONSTS = ["ROUTE_CURRENT_COLOR", "ROUTE_DRIVEN_COLOR", "ROUTE_CURRENT_CASING"];
const OPTIONAL_CONSTS = ["ROUTE_DRIVEN_LINE_COLOR", "ROUTE_CASING_COLOR", "DARK_STREET_TEXT", "DARK_STREET_PAINT", "DARK_STREET_RULES", "streetThemeSaved"];
const HAS_SYNC = Boolean(extract("syncStreetTheme", true));
const APP_CODE = [
  ...ROUTE_CONSTS.map((name) => constDecl(name, true)),
  ...APP_CONSTS.map((name) => constDecl(name)),
  ...OPTIONAL_CONSTS.map((name) => constDecl(name, true)),
  ...APP_FUNCTIONS.map((name) => extract(name)),
  ...OPTIONAL_FUNCTIONS.map((name) => extract(name, true)),
  HAS_SYNC ? "" : "function syncStreetTheme() {}",
].join("\n\n");

// --- Liberty layers, as served by tiles.openfreemap.org/styles/liberty (id:type). ---

const LIBERTY_IDS = [
  "background:b natural_earth:r park:f park_outline:l landuse_residential:f landcover_wood:f landcover_grass:f",
  "landcover_ice:f landcover_wetland:f landuse_pitch:f landuse_track:f landuse_cemetery:f landuse_hospital:f",
  "landuse_school:f waterway_tunnel:l waterway_river:l waterway_other:l water:f landcover_sand:f aeroway_fill:f",
  "aeroway_runway:l aeroway_taxiway:l tunnel_motorway_link_casing:l tunnel_service_track_casing:l",
  "tunnel_link_casing:l tunnel_street_casing:l tunnel_secondary_tertiary_casing:l tunnel_trunk_primary_casing:l",
  "tunnel_motorway_casing:l tunnel_path_pedestrian:l tunnel_motorway_link:l tunnel_service_track:l tunnel_link:l",
  "tunnel_minor:l tunnel_secondary_tertiary:l tunnel_trunk_primary:l tunnel_motorway:l tunnel_major_rail:l",
  "tunnel_major_rail_hatching:l tunnel_transit_rail:l tunnel_transit_rail_hatching:l road_area_pattern:f",
  "road_motorway_link_casing:l road_service_track_casing:l road_link_casing:l road_minor_casing:l",
  "road_secondary_tertiary_casing:l road_trunk_primary_casing:l road_motorway_casing:l road_path_pedestrian:l",
  "road_motorway_link:l road_service_track:l road_link:l road_minor:l road_secondary_tertiary:l",
  "road_trunk_primary:l road_motorway:l road_major_rail:l road_major_rail_hatching:l road_transit_rail:l",
  "road_transit_rail_hatching:l road_one_way_arrow:s road_one_way_arrow_opposite:s bridge_motorway_link_casing:l",
  "bridge_service_track_casing:l bridge_link_casing:l bridge_street_casing:l bridge_path_pedestrian_casing:l",
  "bridge_secondary_tertiary_casing:l bridge_trunk_primary_casing:l bridge_motorway_casing:l",
  "bridge_path_pedestrian:l bridge_motorway_link:l bridge_service_track:l bridge_link:l bridge_street:l",
  "bridge_secondary_tertiary:l bridge_trunk_primary:l bridge_motorway:l bridge_major_rail:l",
  "bridge_major_rail_hatching:l bridge_transit_rail:l bridge_transit_rail_hatching:l building:f building-3d:x",
  "boundary_3:l boundary_2:l boundary_disputed:l waterway_line_label:s water_name_point_label:s",
  "water_name_line_label:s poi_r20:s poi_r7:s poi_r1:s poi_transit:s highway-name-path:s highway-name-minor:s",
  "highway-name-major:s highway-shield-non-us:s highway-shield-us-interstate:s road_shield_us:s airport:s",
  "label_other:s label_village:s label_town:s label_state:s label_city:s label_city_capital:s label_country_3:s",
  "label_country_2:s label_country_1:s",
].join(" ").split(" ").map((pair) => {
  const [id, t] = pair.split(":");
  return { id, type: { b: "background", r: "raster", f: "fill", l: "line", s: "symbol", x: "fill-extrusion" }[t] };
});

// The subset the scenarios use, with liberty's real paint.
const LIBERTY_SUBSET = [
  { id: "background", type: "background", paint: { "background-color": "#f8f4f0" } },
  { id: "natural_earth", type: "raster", paint: { "raster-opacity": ["interpolate", ["exponential", 1.5], ["zoom"], 0, 0.6, 6, 0.1] } },
  { id: "park", type: "fill", paint: { "fill-color": "#d8e8c8", "fill-opacity": 0.7, "fill-outline-color": "rgba(95, 208, 100, 1)" } },
  { id: "water", type: "fill", paint: { "fill-color": "rgb(158,189,255)" } },
  { id: "road_minor_casing", type: "line", paint: { "line-color": "#cfcdca", "line-opacity": ["interpolate", ["linear"], ["zoom"], 12, 0, 12.5, 1], "line-width": ["interpolate", ["exponential", 1.2], ["zoom"], 12, 0.5, 13, 1, 14, 4, 20, 20] } },
  { id: "road_minor", type: "line", paint: { "line-color": "#fff", "line-width": ["interpolate", ["exponential", 1.2], ["zoom"], 13.5, 0, 14, 2.5, 20, 18] } },
  { id: "road_motorway", type: "line", paint: { "line-color": ["interpolate", ["linear"], ["zoom"], 5, "hsl(26,87%,62%)", 6, "#fc8"], "line-width": ["interpolate", ["exponential", 1.2], ["zoom"], 5, 0, 7, 1, 20, 18] } },
  { id: "building", type: "fill", paint: { "fill-color": "hsl(35,8%,85%)", "fill-outline-color": ["interpolate", ["linear"], ["zoom"], 13, "hsla(35,6%,79%,0.32)", 14, "hsl(35,6%,79%)"] } },
  { id: "building-3d", type: "fill-extrusion", paint: { "fill-extrusion-color": "hsl(35,8%,85%)", "fill-extrusion-opacity": 0.8 } },
  { id: "highway-name-major", type: "symbol", layout: { "text-field": ["get", "name"] }, paint: { "text-color": "#666", "text-halo-blur": 0.5, "text-halo-width": 1 } },
  { id: "highway-shield-us-interstate", type: "symbol", layout: { "icon-image": ["concat", ["get", "network"], "_", ["get", "ref_length"]], "text-field": ["to-string", ["get", "ref"]] }, paint: {} },
  { id: "label_city", type: "symbol", layout: { "text-field": ["get", "name"] }, paint: { "text-color": "#000", "text-halo-blur": 1, "text-halo-color": "#fff", "text-halo-width": 1 } },
];

const SATELLITE_LAYERS = [
  { id: "satellite", type: "raster", paint: {} },
  { id: "places", type: "raster", paint: {} },
];

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const PREFIX = { background: ["background-"], raster: ["raster-"], fill: ["fill-"], line: ["line-"], symbol: ["text-", "icon-"], "fill-extrusion": ["fill-extrusion-"] };

// --- Colors: relative luminance, 0 is black and 1 is white. ---

function luminance(color) {
  let r;
  let g;
  let b;
  const s = String(color).trim();
  let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
  if (m) {
    const hex = m[1].length === 3 ? m[1].replace(/./g, "$&$&") : m[1];
    [r, g, b] = [0, 2, 4].map((k) => parseInt(hex.slice(k, k + 2), 16));
  } else if ((m = /^rgba?\(([^)]+)\)$/i.exec(s))) {
    [r, g, b] = m[1].split(",").map((part) => Number(part.trim()));
  } else return NaN;
  const lin = (c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

// --- A fake MapLibre map. ---

class FakeClassList {
  constructor() { this.set = new Set(); }
  add(name) { this.set.add(name); }
  remove(name) { this.set.delete(name); }
  contains(name) { return this.set.has(name); }
  toggle(name, force) {
    const on = force === undefined ? !this.set.has(name) : Boolean(force);
    if (on) this.set.add(name);
    else this.set.delete(name);
    return on;
  }
}

class FakeMap {
  constructor({ layers, sources, log }) {
    this.log = log;
    this.layers = clone(layers);
    this.sources = { ...sources };
    this.loaded = true;
    this.handlers = {};
    this.container = { classList: new FakeClassList() };
    this.center = { lng: -94.6, lat: 39.1 };
    this.zoom = 13.5;
    this.bearing = 37;
    this.paintCalls = [];
    this.badPaint = [];
    this.setStyleCalls = [];
    this.cameraCalls = 0;
    this.hideFromGetLayer = new Set();
    this.throwOnGet = new Set();
  }
  layer(id) { return this.layers.find((item) => item.id === id); }
  getContainer() { return this.container; }
  isStyleLoaded() { return this.loaded; }
  getStyle() { return { version: 8, sources: { ...this.sources }, layers: clone(this.layers) }; }
  getLayer(id) { return this.hideFromGetLayer.has(id) ? undefined : this.layer(id); }
  getSource(id) { return this.sources[id]; }
  addSource(id, spec) {
    const log = this.log;
    this.sources[id] = { type: spec.type, data: spec.data, setDataCalls: 0, setData(data) { this.data = data; this.setDataCalls += 1; log.push(`setData ${id}`); } };
    log.push(`addSource ${id}`);
  }
  addLayer(layer) {
    this.layers.push({ ...clone(layer), paint: clone(layer.paint || {}) });
    this.log.push(`addLayer ${layer.id}`);
  }
  getPaintProperty(id, prop) {
    if (this.throwOnGet.has(id)) throw new Error(`boom ${id}`);
    return this.layer(id)?.paint?.[prop];
  }
  setPaintProperty(id, prop, value) {
    this.log.push(`paint ${id} ${prop}`);
    this.paintCalls.push({ id, prop, value: clone(value) });
    const layer = this.layer(id);
    if (!layer) return this;
    if (!(PREFIX[layer.type] || []).some((p) => prop.startsWith(p))) {
      this.badPaint.push(`${id} (${layer.type}) ${prop}`);
      return this;
    }
    layer.paint ||= {};
    if (value === undefined) delete layer.paint[prop];
    else layer.paint[prop] = clone(value);
    return this;
  }
  setLayoutProperty(id, prop, value) {
    this.log.push(`layout ${id} ${prop}`);
    const layer = this.layer(id);
    if (layer) (layer.layout ||= {})[prop] = value;
    return this;
  }
  setStyle(spec) {
    this.setStyleCalls.push(spec);
    this.log.push(`setStyle ${typeof spec === "string" ? spec : "satellite"}`);
    this.loaded = false;
    if (typeof spec === "string") {
      this.layers = clone(this.libertyLayers);
      this.sources = { openmaptiles: { type: "vector" } };
    } else {
      this.layers = clone(SATELLITE_LAYERS);
      this.sources = { satellite: { type: "raster" }, places: { type: "raster" } };
    }
    return this;
  }
  fireStyleLoad() {
    this.loaded = true;
    const list = this.handlers["style.load"] || [];
    this.handlers["style.load"] = [];
    for (const fn of list) fn({ type: "style.load" });
  }
  on(type, fn) { (this.handlers[type] ||= []).push(fn); return this; }
  once(type, fn) { return this.on(type, fn); }
  getCenter() { return { ...this.center }; }
  getZoom() { return this.zoom; }
  getBearing() { return this.bearing; }
  jumpTo() { this.cameraCalls += 1; return this; }
  easeTo() { this.cameraCalls += 1; return this; }
  flyTo() { this.cameraCalls += 1; return this; }
  fitBounds() { this.cameraCalls += 1; return this; }
}

// --- A world: the app code in a sandbox, with its map mounted like mountMap does. ---

const ROUTE_DATA = {
  type: "FeatureCollection",
  features: [{ type: "Feature", properties: { current: 1 }, geometry: { type: "LineString", coordinates: [[-94.6, 39.1], [-94.5, 39.2]] } }],
};

function makeWorld({ darkMode, basemap, styleLayers = LIBERTY_SUBSET, libertyLayers = LIBERTY_SUBSET, systemDark = false }) {
  const log = [];
  const html = new FakeClassList();
  const spies = { addRoutePins: 0, placeNavDot: 0, placeTurnPin: 0, matchMedia: 0, persist: 0 };
  const sandbox = {
    console,
    JSON,
    Object,
    Map,
    WeakMap,
    Set,
    RegExp,
    Boolean,
    Number,
    String,
    Array,
    Math,
    Date,
    Infinity,
    document: {
      documentElement: { classList: html },
      getElementById: () => null,
    },
    window: {
      setTimeout: () => 1,
      clearTimeout: () => {},
      matchMedia: (query) => {
        spies.matchMedia += 1;
        return { matches: systemDark && /dark/.test(query), media: query, addEventListener() {}, removeEventListener() {} };
      },
    },
    localStorage: { getItem: () => null, setItem: () => {} },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const prelude = `
    var state = { darkMode: ${darkMode === true} };
    var basemap = ${JSON.stringify(basemap)};
    var routeMap = null;
    var routeMapReady = false;
    var basemapTimer = 0;
    var navOn = false;
    var navFix = null;
    var navLine = [];
    var turnShownAlong = null;
    var __spies = null;
    function persist() { __spies.persist += 1; }
    function routeFeatureCollection() { return __routeData; }
    function addRoutePins() { __spies.addRoutePins += 1; }
    function placeNavDot() { __spies.placeNavDot += 1; }
    function placeTurnPin() { __spies.placeTurnPin += 1; }
    function paintBasemapButtons() {}
    function paintNavLine() {}
    function navNearest() { return { along: 0 }; }
    function legUnderFix() { return null; }
    function satelliteMapStyle() { return { version: 8, sources: {}, layers: [] }; }
  `;
  vm.runInContext(prelude + "\n" + APP_CODE, sandbox);
  sandbox.__spies = spies;
  sandbox.__routeData = ROUTE_DATA;
  const vectorSources = { openmaptiles: { type: "vector" } };
  const satSources = { satellite: { type: "raster" }, places: { type: "raster" } };
  const map = new FakeMap({ layers: styleLayers, sources: styleLayers === SATELLITE_LAYERS ? satSources : vectorSources, log });
  map.libertyLayers = libertyLayers;
  sandbox.routeMap = map;
  // mountMap's load handler: the route layers, then the theme, then ready.
  vm.runInContext(`
    routeMap.addSource("route", { type: "geojson", data: routeFeatureCollection() });
    routeMap.addLayer({ id: "route-casing", type: "line", source: "route", paint: { "line-color": ROUTE_CASING_COLOR, "line-width": 7 } });
    routeMap.addLayer({ id: "route", type: "line", source: "route", paint: { "line-color": ROUTE_LINE_COLOR, "line-width": 4 } });
    routeMap.addSource("left", { type: "geojson", data: { type: "Feature", geometry: { type: "LineString", coordinates: [] } } });
    routeMap.addLayer({ id: "left-casing", type: "line", source: "left", paint: { "line-color": ROUTE_CURRENT_CASING, "line-width": 9 } });
    routeMap.addLayer({ id: "left", type: "line", source: "left", paint: { "line-color": ROUTE_CURRENT_COLOR, "line-width": 6 } });
  `, sandbox);
  const original = clone(map.layers);
  vm.runInContext("syncStreetTheme(true); routeMapReady = true;", sandbox);
  const run = (code) => vm.runInContext(code, sandbox);
  return { sandbox, map, html, spies, log, original, run };
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

const paintOf = (map, id) => map.layer(id)?.paint || {};

// The route casing is data-driven by `current`: the leg being driven keeps its
// own casing, so these checks read the casing of the other legs.
function resolve(expr, props) {
  if (!Array.isArray(expr)) return expr;
  const [op, ...args] = expr;
  if (op === "get") return props[args[0]];
  if (op === "==") return resolve(args[0], props) === resolve(args[1], props);
  if (op === "case") {
    for (let i = 0; i + 1 < args.length; i += 2) if (resolve(args[i], props)) return resolve(args[i + 1], props);
    return resolve(args[args.length - 1], props);
  }
  return undefined;
}
const otherCasing = (map) => resolve(paintOf(map, "route-casing")["line-color"], { current: 0 });
const isDark = (c) => luminance(c) < 0.03;
const isLight = (c) => luminance(c) > 0.7;
const camera = (map) => JSON.stringify([map.getCenter(), map.getZoom(), map.getBearing()]);
const routeLayersPresent = (map) => ["route-casing", "route", "left-casing", "left"].every((id) => map.getLayer(id)) && map.getSource("route") && map.getSource("left");

function darkLooks(map, label) {
  const bg = paintOf(map, "background")["background-color"];
  check(`${label}: background is near-black (${bg})`, isDark(bg));
  const city = paintOf(map, "label_city");
  check(`${label}: label_city text is light (${city["text-color"]})`, isLight(city["text-color"]));
  check(`${label}: label_city halo is dark (${city["text-halo-color"]})`, isDark(city["text-halo-color"]));
  const name = paintOf(map, "highway-name-major");
  check(`${label}: highway-name-major text light, halo dark`, isLight(name["text-color"]) && isDark(name["text-halo-color"]));
  const water = paintOf(map, "water")["fill-color"];
  check(`${label}: water is dark (${water})`, luminance(water) < 0.08);
  const motorway = paintOf(map, "road_motorway")["line-color"];
  const minor = paintOf(map, "road_minor")["line-color"];
  const casing = paintOf(map, "road_minor_casing")["line-color"];
  check(`${label}: roads are dark greys (motorway ${motorway}, minor ${minor}, casing ${casing})`,
    luminance(motorway) < 0.2 && luminance(minor) < 0.1 && luminance(casing) < luminance(minor));
  check(`${label}: building and building-3d are dark`, luminance(paintOf(map, "building")["fill-color"]) < 0.05
    && luminance(paintOf(map, "building-3d")["fill-extrusion-color"]) < 0.05);
  const shield = map.layer("highway-shield-us-interstate");
  const shieldOriginal = LIBERTY_SUBSET.find((item) => item.id === "highway-shield-us-interstate");
  check(`${label}: interstate shield still visible and unchanged`, shield && shield.layout?.visibility !== "none"
    && same(shield.paint, shieldOriginal.paint) && same(shield.layout, shieldOriginal.layout));
  check(`${label}: map container has .street-dark`, map.container.classList.contains("street-dark"));
}

// --- a. Dark mode on + Street map: overrides, no style reload. ---
{
  const w = makeWorld({ darkMode: true, basemap: "vector" });
  darkLooks(w.map, "a. dark + street, on load");
  check("a. setStyle is not called", w.map.setStyleCalls.length === 0);
  check("a. no paint property is set on a layer of the wrong type", w.map.badPaint.length === 0, w.map.badPaint.join(", "));

  const live = makeWorld({ darkMode: false, basemap: "vector" });
  live.run("toggleDarkMode()");
  check("a. tapping Dark mode turns html.force-dark on", live.html.contains("force-dark") && !live.html.contains("force-light"));
  darkLooks(live.map, "a. tapping Dark mode with the street map up");
  check("a. tapping Dark mode does not call setStyle", live.map.setStyleCalls.length === 0);
}

// --- b. Dark mode off: the street map is liberty as served. ---
{
  const w = makeWorld({ darkMode: false, basemap: "vector" });
  const fresh = clone(LIBERTY_SUBSET);
  check("b. light mode: every liberty layer keeps its own paint", fresh.every((layer) => same(paintOf(w.map, layer.id), layer.paint)));
  check("b. light mode: route casing stays white", otherCasing(w.map) === "#ffffff");
  check("b. light mode: no .street-dark on the container", !w.map.container.classList.contains("street-dark"));
}

// --- c. Dark -> light -> dark in place. ---
{
  const w = makeWorld({ darkMode: true, basemap: "vector" });
  const darkSnapshot = clone(w.map.layers);
  const cam = camera(w.map);
  const routeSource = w.map.getSource("route");
  const routeData = JSON.stringify(routeSource.data);
  const darkCasing = otherCasing(w.map);
  check(`c. dark street: route casing is dark so the route line stands out (${darkCasing})`, isDark(darkCasing));
  check("c. dark street: route line keeps its magenta/green colors", same(paintOf(w.map, "route")["line-color"], w.sandbox.ROUTE_LINE_COLOR));

  w.run("toggleDarkMode()");
  check("c. back to light: html.force-light", w.html.contains("force-light") && !w.html.contains("force-dark"));
  const diffs = w.original.filter((layer) => !same(paintOf(w.map, layer.id), layer.paint)).map((layer) => layer.id);
  check("c. back to light: every layer's paint equals the original exactly", diffs.length === 0, diffs.join(", "));
  check("c. back to light: highway-name-major has no halo color again (liberty sets none)",
    !("text-halo-color" in paintOf(w.map, "highway-name-major")));
  check("c. back to light: route casing white again", otherCasing(w.map) === "#ffffff");
  check("c. back to light: no .street-dark", !w.map.container.classList.contains("street-dark"));

  w.run("toggleDarkMode()");
  const again = darkSnapshot.filter((layer) => !same(paintOf(w.map, layer.id), layer.paint)).map((layer) => layer.id);
  check("c. dark again: the same dark paint is back", again.length === 0, again.join(", "));
  darkLooks(w.map, "c. dark again");

  check("c. route, route-casing and left layers and sources still there", routeLayersPresent(w.map));
  check("c. the route source is the same object with the same data, never re-set",
    w.map.getSource("route") === routeSource && JSON.stringify(routeSource.data) === routeData && routeSource.setDataCalls === 0);
  check("c. pins, your dot and the turn dot are not re-made",
    w.spies.addRoutePins === 0 && w.spies.placeNavDot === 0 && w.spies.placeTurnPin === 0);
  check("c. setStyle never called", w.map.setStyleCalls.length === 0);
  check("c. camera (center, zoom, bearing) unchanged and never moved", camera(w.map) === cam && w.map.cameraCalls === 0);
  check("c. no layer added or removed by the toggles", w.log.filter((line) => /^add/.test(line)).length === 6);
}

// --- d. Satellite + Dark mode: never any overrides. ---
{
  const w = makeWorld({ darkMode: true, basemap: "satellite", styleLayers: SATELLITE_LAYERS });
  w.run("toggleDarkMode(); toggleDarkMode();");
  const diffs = w.original.filter((layer) => !same(paintOf(w.map, layer.id), layer.paint)).map((layer) => layer.id);
  check("d. satellite + dark: no layer paint changes (route casing stays white)", diffs.length === 0, diffs.join(", "));
  check("d. satellite + dark: no .street-dark", !w.map.container.classList.contains("street-dark"));

  const v = makeWorld({ darkMode: true, basemap: "vector" });
  v.run("basemap = 'satellite'; applyBasemap();");
  v.map.fireStyleLoad();
  check("d. switching dark street -> satellite: satellite style, route casing white, no .street-dark",
    v.map.getLayer("satellite") && otherCasing(v.map) === "#ffffff"
    && !v.map.container.classList.contains("street-dark"));
}

// --- e. A vector style.load while Dark mode is on darkens after the route layers are back. ---
{
  const w = makeWorld({ darkMode: true, basemap: "satellite", styleLayers: SATELLITE_LAYERS });
  w.log.length = 0;
  w.run("basemap = 'vector'; applyBasemap();");
  check("e. switching to the street map calls setStyle once with the liberty url",
    w.map.setStyleCalls.length === 1 && w.map.setStyleCalls[0] === w.sandbox.vectorStyleUrl);
  w.map.fireStyleLoad();
  darkLooks(w.map, "e. after style.load");
  check("e. route layers are back", routeLayersPresent(w.map));
  const added = w.log.indexOf("addLayer route-casing");
  const darkened = w.log.indexOf("paint background background-color");
  const casing = w.log.indexOf("paint route-casing line-color");
  check("e. overrides are applied after ensureRouteLayers re-adds the route", added >= 0 && darkened > added && casing > added);
  check("e. route casing dark after the reload", isDark(otherCasing(w.map)));

  w.run("toggleDarkMode()");
  const fresh = clone(LIBERTY_SUBSET);
  check("e. then light: liberty paint exactly as loaded", fresh.every((layer) => same(paintOf(w.map, layer.id), layer.paint)));
}

// --- f. The phone's dark mode alone does nothing. ---
{
  const w = makeWorld({ darkMode: false, basemap: "vector", systemDark: true });
  w.run("applyDarkMode(); syncStreetTheme();");
  const diffs = w.original.filter((layer) => !same(paintOf(w.map, layer.id), layer.paint)).map((layer) => layer.id);
  check("f. prefers-color-scheme dark + Planigator light mode: no overrides", diffs.length === 0, diffs.join(", "));
  check("f. no .street-dark", !w.map.container.classList.contains("street-dark"));
  check("f. the street theme never asks matchMedia", w.spies.matchMedia === 0);
}

// --- g. Missing or odd layers are skipped. ---
{
  const few = LIBERTY_SUBSET.filter((layer) => ["background", "label_city", "water"].includes(layer.id));
  let threw = null;
  let w = null;
  try {
    w = makeWorld({ darkMode: true, basemap: "vector", styleLayers: few });
    w.map.hideFromGetLayer.add("water");
    w.run("toggleDarkMode(); toggleDarkMode();");
    w.map.throwOnGet.add("label_city");
    w.run("toggleDarkMode(); toggleDarkMode();");
  } catch (error) {
    threw = error;
  }
  check("g. a style missing most liberty layers does not throw", !threw, threw?.message);
  check("g. layers that are there still go dark", w && isDark(paintOf(w.map, "background")["background-color"]));
  check("g. nothing is painted on a missing layer", w && w.map.paintCalls.every((call) => w.map.layer(call.id)));
}

// --- h. The whole liberty layer list: right property types, labels readable, shields untouched. ---
{
  const all = LIBERTY_IDS.map(({ id, type }) => ({ id, type, paint: {} }));
  const w = makeWorld({ darkMode: true, basemap: "vector", styleLayers: all });
  check("h. no override sets a property that does not belong to the layer type", w.map.badPaint.length === 0, w.map.badPaint.join(", "));
  const textLayers = LIBERTY_IDS.filter(({ id }) => /^(label_|poi_|highway-name-|water_name_|waterway_line_label|airport)/.test(id));
  const unreadable = textLayers.filter(({ id }) => {
    const p = paintOf(w.map, id);
    return !(luminance(p["text-color"]) > 0.35 && isDark(p["text-halo-color"]));
  }).map(({ id }) => id);
  check(`h. all ${textLayers.length} name and label layers get light text on a dark halo`, unreadable.length === 0, unreadable.join(", "));
  const shields = ["highway-shield-non-us", "highway-shield-us-interstate", "road_shield_us"];
  check("h. the three shield layers are not touched", w.map.paintCalls.every((call) => !shields.includes(call.id)));
  const keep = new Set([...shields, "road_one_way_arrow", "road_one_way_arrow_opposite"]);
  const missed = LIBERTY_IDS.filter(({ id }) => !keep.has(id) && !w.map.paintCalls.some((call) => call.id === id)).map(({ id }) => id);
  check("h. every other liberty layer has a dark override", missed.length === 0, missed.join(", "));
  w.run("toggleDarkMode()");
  const left = LIBERTY_IDS.filter(({ id }) => Object.keys(paintOf(w.map, id)).length).map(({ id }) => id);
  check("h. back to light: every liberty layer is back to its own paint", left.length === 0, left.join(", "));
}

// --- The real mountMap and applyBasemap call it at the right moments. ---
{
  const mount = extract("mountMap", true);
  const left = mount.indexOf("id: \"left\"");
  const sync = mount.indexOf("syncStreetTheme(true)");
  check("mountMap's load handler syncs the street theme once the route layers exist", left >= 0 && sync > left);
  const toggle = extract("toggleDarkMode");
  check("toggleDarkMode syncs the street theme in place", /syncStreetTheme\(\)/.test(toggle) && !/setStyle|applyBasemap/.test(toggle));
}

console.log(`\n${passes} passed, ${failures} failed`);
if (failures) process.exit(1);
