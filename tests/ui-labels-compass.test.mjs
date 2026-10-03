// Map button labels (Stops, Detours, Exit full), the compass (letters fixed,
// only the needle turns to the heading), and "Directions (NAME)".
// Not loaded by the site. Run: node tests/ui-labels-compass.test.mjs
// Against other copies: APP_JS=/path/to/app.js CSS_FILE=/path/to/styles.css node tests/ui-labels-compass.test.mjs
// The button-box check compares styles.css with BASE_REF (default: the Build #612 commit).
//
// Loads planBox, directionsBlock, paintDirectionToward and paintCompassRose from
// js/app.js by name into a vm sandbox and reads the rules in styles.css.

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appSource = readFileSync(process.env.APP_JS || path.join(root, "js/app.js"), "utf8");
const cssSource = readFileSync(process.env.CSS_FILE || path.join(root, "styles.css"), "utf8");
const BASE_REF = process.env.BASE_REF || "1251330";

function extract(name) {
  const head = new RegExp(`^(?:async\\s+)?function\\s+${name}\\s*\\(`, "m").exec(appSource);
  if (!head) throw new Error(`app.js has no function ${name}`);
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

const APP_FUNCTIONS = [
  "escapeAttr", "navStopTitle", "directionTowardName", "paintDirectionToward", "directionsBlock", "planBox", "paintCompassRose",
];
const APP_CODE = APP_FUNCTIONS.map((name) => extract(name)).join("\n\n");

let failures = 0;
function expect(label, ok, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`);
}

class FakeNode {
  constructor(id) {
    this.id = id;
    this.textContent = "";
    this.hidden = false;
    this.attrs = {};
    this.dataset = {};
    this.props = {};
    this.style = { setProperty: (key, value) => { this.props[key] = String(value); } };
    this.classes = new Set();
    this.classList = { toggle: (name, on) => (on ? this.classes.add(name) : this.classes.delete(name)) };
  }
  setAttribute(key, value) { this.attrs[key] = String(value); }
  removeAttribute(key) { delete this.attrs[key]; }
  getAttribute(key) { return this.attrs[key] ?? null; }
}

function sandbox({ stops, aim = null, bearing = 0, heading = null }) {
  const nodes = { dirToward: new FakeNode("dirToward"), routeCompass: new FakeNode("routeCompass") };
  const context = {
    console, Math, Number, String, JSON, Array, Object, Infinity, NaN, Set, Map, RegExp, Error,
    state: { stops, plan: { legs: [] }, estimating: false, unlimited: true, credits: 40, darkMode: false },
    basemap: "satellite", navOn: false, navAimStopId: aim, navLegs: [], northLock: false,
    placeListMode: false, truckHit: null, truckHits: [], placeSeek: false, placeMapMoved: false,
    routeMap: { getBearing: () => bearing },
    routeHeading: () => heading,
    rebuildNavLegs: () => {},
    activeNavLeg: () => null,
    isOriginStop: (list, index) => index === 0,
    shownDirection: (step) => String(step?.text || ""),
    voiceStepper: () => "",
    themeButtonLabel: () => "Light mode",
    activeTransportMode: () => "truck",
    transportButtonLabel: () => "Truck",
    truckNoteText: () => "",
    summaryLivesOnPlan: () => true,
    planSummary: () => "",
    document: { getElementById: (id) => nodes[id] || null },
  };
  vm.createContext(context);
  vm.runInContext(APP_CODE, context);
  return { ctx: context, nodes };
}

const trip = (doneDock = false) => [
  { id: "start", name: "Home", directions: [{ text: "Head north." }] },
  { id: "dock", name: "WALMARdo", done: doneDock, directions: [{ text: "Turn right." }, { text: "Arrive at WALMARdo" }] },
];

// Opening tag and inner text of the element with this id in rendered markup.
function element(html, id) {
  const open = new RegExp(`<(\\w+)\\b[^>]*\\bid="${id}"[^>]*>`).exec(html);
  if (!open) return null;
  const tag = open[1];
  let depth = 1;
  let i = open.index + open[0].length;
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, "g");
  re.lastIndex = i;
  let m;
  while ((m = re.exec(html))) {
    depth += m[1] ? -1 : 1;
    if (!depth) {
      const inner = html.slice(i, m.index);
      return { open: open[0], inner, text: inner.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() };
    }
  }
  return null;
}
const attr = (open, name) => {
  const hit = new RegExp(`\\b${name}="([^"]*)"`).exec(open || "");
  return hit ? hit[1] : null;
};

// --- a. The map buttons ---
console.log("Map buttons");
{
  const { ctx } = sandbox({ stops: trip() });
  const html = ctx.planBox();
  const stopsBtn = element(html, "routeStops");
  const detourBtn = element(html, "routeDetour");
  const exitBtn = element(html, "routeExit");
  expect("#routeStops says Stops", stopsBtn?.text === "Stops", JSON.stringify(stopsBtn?.text));
  expect("#routeStops aria-label is Stops", attr(stopsBtn?.open, "aria-label") === "Stops", attr(stopsBtn?.open, "aria-label"));
  expect("#routeDetour says Detours", detourBtn?.text === "Detours", JSON.stringify(detourBtn?.text));
  expect("#routeDetour aria-label is Detours", attr(detourBtn?.open, "aria-label") === "Detours", attr(detourBtn?.open, "aria-label"));
  expect("#routeExit says Exit full", exitBtn?.text === "Exit full", JSON.stringify(exitBtn?.text));
  expect("#routeExit aria-label is Exit full screen", attr(exitBtn?.open, "aria-label") === "Exit full screen", attr(exitBtn?.open, "aria-label"));
  expect("#routeExit still starts hidden", /\shidden(\s|>|=)/.test(exitBtn?.open || ""), exitBtn?.open);
  const zoom = element(html, "routeWhole");
  expect("the zoom button markup is untouched (Trip zoom)", zoom?.text === "Trip zoom", JSON.stringify(zoom?.text));
}

// --- b. The directions header ---
console.log("\nDirections header");
{
  const { ctx, nodes } = sandbox({ stops: trip(), aim: "dock" });
  const html = ctx.directionsBlock();
  const toward = element(html, "dirToward");
  expect("directionsBlock shows (WALMARdo)", toward?.text === "(WALMARdo)", JSON.stringify(toward?.text));
  expect("directionsBlock: not hidden", toward && !/\shidden(\s|>|=)/.test(toward.open), toward?.open);
  expect("the header still sits next to the directions label", /<summary><span class="dir-label">[^<]*<\/span><span class="dir-toward" id="dirToward"/.test(html));
  ctx.paintDirectionToward();
  expect("paintDirectionToward shows (WALMARdo)", nodes.dirToward.textContent === "(WALMARdo)", JSON.stringify(nodes.dirToward.textContent));
  expect("paintDirectionToward: not hidden", nodes.dirToward.hidden === false);
  ctx.paintDirectionToward();
  expect("painting again does not double the parentheses", nodes.dirToward.textContent === "(WALMARdo)", JSON.stringify(nodes.dirToward.textContent));

  const named = sandbox({ stops: [trip()[0], { ...trip()[1], name: "A<B&C" }], aim: "dock" });
  const escaped = element(named.ctx.directionsBlock(), "dirToward");
  expect("a name with < and & is escaped inside the parentheses", escaped?.inner === "(A&lt;B&amp;C)", JSON.stringify(escaped?.inner));
}
{
  const { ctx, nodes } = sandbox({ stops: trip(true) });
  const toward = element(ctx.directionsBlock(), "dirToward");
  expect("no stop name: directionsBlock leaves it hidden and empty", toward && /\shidden(\s|>|=)/.test(toward.open) && toward.inner === "", toward?.open);
  nodes.dirToward.textContent = "(OLD)";
  ctx.paintDirectionToward();
  expect("no stop name: paintDirectionToward hides it with no parentheses", nodes.dirToward.hidden === true && nodes.dirToward.textContent === "", JSON.stringify(nodes.dirToward.textContent));
}

// --- CSS rules ---

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

const rules = parseCss(cssSource);
const subject = (selector) => selector.split(/\s*[>+~]\s*|\s+/).pop();
const ruleFor = (selector) => rules.filter((r) => r.selector === selector && !r.media);

// Rotation in degrees from a transform, given the custom properties.
function rotation(transform, vars) {
  const hit = /rotate\(\s*calc\(([\s\S]*)\)\s*\)/.exec(transform || "") || /rotate\(([^)]*)\)/.exec(transform || "");
  if (!hit) return 0;
  const expr = hit[1]
    .replace(/var\((--[\w-]+)\)/g, (_, name) => (name in vars ? `(${Number(vars[name])})` : "NaN"))
    .replace(/deg/g, "");
  if (!/^[\d\s.+\-*/()NaN]+$/.test(expr)) return NaN;
  return Function(`return (${expr});`)();
}
const wrap = (deg) => ((Math.round(deg * 10) / 10 % 360) + 360) % 360;

// --- c. The compass ---
console.log("\nCompass");
{
  const roseRules = rules.filter((r) => /\.compass-rose\b/.test(r.selector));
  const rotating = roseRules.filter((r) => /rotate/.test(r.decls.get("transform") || ""));
  expect(".compass-rose has a rule", ruleFor(".compass-rose").length > 0);
  expect(".compass-rose span has a rule", ruleFor(".compass-rose span").length > 0);
  expect("no .compass-rose rule (rose or letters) rotates", rotating.length === 0, rotating.map((r) => `${r.selector} { transform: ${r.decls.get("transform")} }`).join("; "));
  const usesCompass = roseRules.filter((r) => [...r.decls.values()].some((v) => v.includes("--compass")));
  expect("no .compass-rose rule depends on --compass", usesCompass.length === 0, usesCompass.map((r) => r.selector).join(", "));

  const needle = ruleFor("#routeCompass .compass-needle");
  const needleTransform = needle.map((r) => r.decls.get("transform")).filter(Boolean).pop() || "";
  expect("#routeCompass .compass-needle rotates", /rotate\(/.test(needleTransform), needleTransform);
  expect("the needle rotation uses --heading", needleTransform.includes("var(--heading)"), needleTransform);
  const needleCompass = rules.filter((r) => /\.compass-needle|\.compass-fill|\.compass-line/.test(r.selector) && [...r.decls.values()].some((v) => v.includes("--compass")));
  expect("no needle rule (needle, fill, line) depends on --compass", needleCompass.length === 0, needleCompass.map((r) => r.selector).join(", "));
  const otherNeedleTransforms = rules.filter((r) => /\.compass-(fill|line)\b/.test(subject(r.selector)) && r.decls.has("transform"));
  expect("the fill and line take the needle's rotation (no own transform)", otherNeedleTransforms.length === 0, otherNeedleTransforms.map((r) => r.selector).join(", "));

  for (const [label, bearing, heading, want] of [
    ["map turned 30°, driving east", 30, 90, 90],
    ["map turned 200°, driving north", 200, 0, 0],
    ["north-up map, driving south-west", 0, 225, 225],
    ["no heading yet, map turned 45°", 45, null, 45],
  ]) {
    const { ctx, nodes } = sandbox({ stops: [], bearing, heading });
    ctx.paintCompassRose();
    const props = nodes.routeCompass.props;
    const needleDeg = wrap(rotation(needleTransform, props));
    const roseDeg = wrap(rotation(ruleFor(".compass-rose").map((r) => r.decls.get("transform")).pop(), props));
    expect(`${label}: paintCompassRose sets --heading on #routeCompass`, props["--heading"] === String(want), JSON.stringify(props));
    expect(`${label}: the needle points at ${want}° on the fixed letters`, needleDeg === want && roseDeg === 0, `needle ${needleDeg}°, letters turned ${roseDeg}°`);
  }
  {
    const { ctx, nodes } = sandbox({ stops: [], bearing: 30, heading: 90 });
    ctx.northLock = true;
    ctx.paintCompassRose();
    const b = nodes.routeCompass;
    expect("north lock still paints the on ring and its label", b.classes.has("on") && b.attrs["aria-pressed"] === "true" && b.attrs["aria-label"] === "Unlock heading-up");
    expect("paintCompassRose still sets --compass", b.props["--compass"] === "30", JSON.stringify(b.props));
  }
}

// --- d. The Detour and compass boxes (Turn zoom anchors) ---
console.log("\nDetours and compass button boxes");
{
  let baseCss = "";
  try {
    baseCss = execFileSync("git", ["show", `${BASE_REF}:styles.css`], { cwd: root, encoding: "utf8", maxBuffer: 1 << 26 });
  } catch (error) {
    expect(`read styles.css at ${BASE_REF}`, false, String(error.message).split("\n")[0]);
  }
  if (baseCss) {
    const BOX = /^(width|height|min-width|max-width|min-height|max-height|flex|flex-basis|flex-grow|flex-shrink|flex-direction|flex-wrap|margin.*|padding.*|border|border-width|border-(top|right|bottom|left)(-width)?|box-sizing|position|top|right|bottom|left|inset|transform|gap|display|align-items|align-self|justify-content|order|z-index)$/;
    const BOX_SUBJECT = /^(#routeDetour|#routeCompass|\.route-rail|\.route-rail-left|\.rail-pop|\.rail-col|button)(?=$|[.:[#])/;
    const boxRules = (list) => {
      const out = new Map();
      for (const r of list) {
        const subj = subject(r.selector);
        if (!BOX_SUBJECT.test(subj)) continue;
        if (/^button/.test(subj) && !/rail|^button/.test(r.selector)) continue;
        const decls = [...r.decls].filter(([k]) => BOX.test(k)).map(([k, v]) => `${k}: ${v}`).sort();
        if (!decls.length) continue;
        const key = `${r.media}|${r.selector}`;
        out.set(key, [...(out.get(key) || []), ...decls].join("; "));
      }
      return out;
    };
    const now = boxRules(rules);
    const base = boxRules(parseCss(baseCss));
    const changed = [...new Set([...now.keys(), ...base.keys()])].filter((key) => now.get(key) !== base.get(key));
    for (const sel of ["#routeCompass", ".route-rail button", ".route-stage.is-full .route-rail button", ".route-rail", ".rail-pop"]) {
      expect(`the box rule for ${sel} is compared`, base.has(`|${sel}`) && now.has(`|${sel}`));
    }
    expect(`no box rule for the Detour, compass, or rail buttons changed vs ${BASE_REF}`, changed.length === 0,
      changed.map((key) => `${key}: was {${base.get(key) || "none"}} now {${now.get(key) || "none"}}`).join(" | "));
  }

  const baseApp = (() => {
    try {
      return execFileSync("git", ["show", `${BASE_REF}:js/app.js`], { cwd: root, encoding: "utf8", maxBuffer: 1 << 26 });
    } catch {
      return "";
    }
  })();
  const { ctx } = sandbox({ stops: trip() });
  const html = ctx.planBox();
  const order = (markup) => [...markup.matchAll(/<button\b[^>]*\bid="(route[A-Z]\w*)"/g)].map((m) => m[1]).join(",");
  const strip = (open) => (open || "").replace(/\s*aria-label="[^"]*"/, "");
  if (baseApp) {
    const baseHtml = /<aside class="route-rail route-rail-left">[\s\S]*?<\/aside>\s*<aside class="route-rail">[\s\S]*?<\/aside>/.exec(baseApp)?.[0] || "";
    const nowRails = /<aside class="route-rail route-rail-left">[\s\S]*?<\/aside>\s*<aside class="route-rail">[\s\S]*?<\/aside>/.exec(html)?.[0] || "";
    expect("the rail buttons are in the same order as before", baseHtml && order(nowRails) === order(baseHtml), order(nowRails));
    for (const id of ["routeDetour", "routeCompass"]) {
      const was = /<button\b[^>]*\bid="ID"[^>]*>/.source.replace("ID", id);
      const baseOpen = new RegExp(was).exec(baseApp)?.[0];
      expect(`#${id} keeps its tag (no new class or style)`, strip(element(html, id)?.open) === strip(baseOpen), element(html, id)?.open);
    }
  } else {
    expect(`read js/app.js at ${BASE_REF}`, false);
  }
}

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
