// After a refresh during navigation, the mile callouts must still be heard.
// Not loaded by the site. Run: node tests/refresh-voice.test.mjs
//
// Loads the real callout functions from js/app.js (by name, into a vm sandbox),
// drives toward an exit, refreshes into a fresh sandbox the way iPhone Safari
// comes back (audio locked until a tap), and checks which lines are spoken.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appSource = readFileSync(path.join(root, "js/app.js"), "utf8");

const MILE = 1609.344;

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
  "metersBetween", "polylineMeters", "stepLengthMeters", "scaledStepLengths", "navStep", "metersLeftInStep",
  "withoutGo", "maneuverText", "inDistance", "approachPhrase", "spokenApproach", "directionWithMilesLeft", "upcomingDirection",
  "speakNavProgress", "speakNav", "navVoiceLocked", "onVoiceGesture",
];
const APP_CODE = APP_FUNCTIONS.map(extract).join("\n\n");

// A straight road east with three directions. The exit is 7 miles in.
const road = [];
for (let m = 0; m <= 12 * MILE; m += 100) road.push([40, -80 + m / (111320 * Math.cos(40 * Math.PI / 180))]);
const stop = {
  id: "pactiv",
  directions: [
    { text: "Head east on I-76 E (Pennsylvania Tpke)", miles: 7 },
    { text: "Take exit 312 toward Downingtown", miles: 4 },
    { text: "Arrive at PACTIV", miles: 1 },
  ],
};
const EXIT_ALONG = 7 * MILE;

// One page load: fresh module memory. voice is "us" (page voice) or "phone".
function page(voice) {
  const said = [];
  const context = {
    console, Math, Number, String, JSON, Array, Object, Infinity, NaN, Set, Map, RegExp,
    navOn: true, navProgressResume: false,
    voiceGestureSeen: false, navVoiceMissed: false, navVoiceIntroPending: false,
    spokenStepKey: "", spokenTurnKey: "", spokenMiles: new Set(),
    // A context made before the tap stays suspended on iPhone.
    mixCtx: voice === "phone" ? null : { state: "suspended" },
    navLegs: [],
    navVoiceId: () => voice,
    playChosenVoice: (text) => { said.push(text); return Promise.resolve(); },
    paintVoiceHint: () => {},
    disarmVoiceGesture: () => {},
    warmPhoneVoice: () => {},
    stopNavUtterance: () => {},
    said,
  };
  context.unlockMix = () => { if (context.mixCtx) context.mixCtx.state = "running"; else context.mixCtx = { state: "running" }; };
  vm.createContext(context);
  vm.runInContext(APP_CODE, context);
  context.leg = { start: 0, end: context.polylineMeters(road), path: road, stop };
  context.navLegs = [context.leg];
  return context;
}

// A GPS fix this many miles before the exit.
function fix(pg, milesToExit) {
  const along = EXIT_ALONG - milesToExit * MILE;
  pg.speakNavProgress(pg.leg, pg.navStep(pg.leg, along), along);
}

function drive(pg, fromMiles, toMiles, every = 0.05) {
  for (let m = fromMiles; m >= toMiles - 1e-9; m -= every) fix(pg, Math.round(m * 1000) / 1000);
}

function heardMiles(pg) {
  return pg.said.map((text) => {
    const hit = /^In ([0-9.]+) miles?,/i.exec(text);
    if (!hit) throw new Error(`Unexpected line: "${text}"`);
    return Number(hit[1]);
  });
}

let failures = 0;

function expect(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${JSON.stringify(got)}${ok ? "" : ` (want ${JSON.stringify(want)})`}`);
}

const FULL = [5, 4, 3, 2, 1, 0.5];

console.log("No refresh (Start tapped)");
{
  const pg = page("us");
  pg.voiceGestureSeen = true;
  drive(pg, 6, 0.1);
  expect("every mile callout once", heardMiles(pg), [6, ...FULL]);
}

for (const voice of ["us", "phone"]) {
  console.log(`\nRefresh at 6 mi, no tap until 3.6 mi (${voice} voice)`);
  const pg = page(voice);
  drive(pg, 6, 3.6);
  expect("nothing sent to the voice while locked", pg.said, []);
  expect("locked lines are remembered", pg.navVoiceMissed, true);
  pg.onVoiceGesture({ type: "pointerdown", pointerType: "touch" });
  expect("finger down alone does not count as the tap", pg.voiceGestureSeen, false);
  pg.onVoiceGesture({ type: "touchend" });
  expect("finger up unlocks the voice", pg.voiceGestureSeen, true);
  drive(pg, 3.55, 0.1);
  expect("current direction right after the tap, then every later callout", heardMiles(pg), [3.6, 3, 2, 1, 0.5]);
}

console.log("\nRefresh at 4.3 mi after 6 and 5 were heard, tap right away");
{
  const before = page("us");
  before.voiceGestureSeen = true;
  drive(before, 6, 4.3);
  expect("before the refresh", heardMiles(before), [6, 5]);
  const pg = page("us");
  pg.onVoiceGesture({ type: "click" });
  drive(pg, 4.25, 0.1);
  expect("after the refresh 4, 3, 2, 1, 0.5 are not marked as already spoken", heardMiles(pg), [4.3, 4, 3, 2, 1, 0.5]);
}

console.log("\nRefresh at 4.3 mi, tap at 2.4 mi");
{
  const pg = page("us");
  drive(pg, 4.25, 2.4);
  pg.onVoiceGesture({ type: "keydown" });
  drive(pg, 2.35, 0.1);
  expect("the missed 4 and 3 do not play late; 2, 1, 0.5 still speak", heardMiles(pg), [2.4, 2, 1, 0.5]);
}

console.log("\nTap while not navigating");
{
  const pg = page("phone");
  pg.navOn = false;
  pg.onVoiceGesture({ type: "click" });
  expect("the tap is kept for later", pg.voiceGestureSeen, false);
  pg.navProgressResume = true;
  pg.onVoiceGesture({ type: "click" });
  expect("a tap while the drive is resuming unlocks", pg.voiceGestureSeen, true);
}

// Two legs: a rest stop 3 miles in, then PACTIV. The list highlights the
// rest stop's last row once you are parked there, and that row names the
// first move of the next leg ("Head west").
const restPath = road.slice(0, 49);
const pactivPath = road.slice(48, 59);
const restStop = {
  id: "rest",
  directions: [
    { text: "Head east on I-76 E (Pennsylvania Tpke)", miles: 2.4 },
    { text: "Take exit 2 toward Rest Area", miles: 0.5 },
    { text: "Arrive at your destination on the left.", miles: 0 },
  ],
};
const pactivStop = {
  id: "pactiv",
  directions: [
    { text: "Head west. Go for 0.1 mi.", miles: 0.1 },
    { text: "Turn right onto Woodbine Rd. Go for 0.5 mi.", miles: 0.5 },
    { text: "Arrive at PACTIV", miles: 0 },
  ],
};

function tripPage(voice) {
  const pg = page(voice);
  const restEnd = pg.polylineMeters(restPath);
  pg.restLeg = { start: 0, end: restEnd, path: restPath, stop: restStop };
  pg.pactivLeg = { start: restEnd, end: restEnd + pg.polylineMeters(pactivPath), path: pactivPath, stop: pactivStop };
  pg.navLegs = [pg.restLeg, pg.pactivLeg];
  return pg;
}

// A GPS fix this many miles before the end of a leg (negative is past it).
function legFix(pg, leg, milesToEnd) {
  const along = leg.end - milesToEnd * MILE;
  pg.speakNavProgress(leg, pg.navStep(leg, Math.max(0, along - leg.start)), along);
}

function noFeet(pg) {
  return pg.said.filter((text) => /\b(?:foot|feet)\b/i.test(text));
}

console.log("\nDrive into the rest stop and park (no refresh)");
{
  const pg = tripPage("us");
  pg.voiceGestureSeen = true;
  for (let m = 2.9; m >= 0.05; m -= 0.05) legFix(pg, pg.restLeg, Math.round(m * 1000) / 1000);
  for (const m of [0.01, 0, 0, -0.002, 0]) legFix(pg, pg.restLeg, m);
  const arrive = pg.said.filter((text) => /arrive/i.test(text));
  expect("the arrival is said once on the way in", arrive, ["In 0.5 miles, Arrive at your destination on the left."]);
  expect("parked: says the highlighted next move, once", pg.said.slice(-1), ["Head west"]);
  expect("no foot or feet lines", noFeet(pg), []);
}

for (const voice of ["us", "phone"]) {
  console.log(`\nRefresh while parked at the rest stop, then tap (${voice} voice)`);
  const pg = tripPage(voice);
  for (const m of [0, 0, -0.001]) legFix(pg, pg.restLeg, m);
  expect("nothing while locked", pg.said, []);
  pg.onVoiceGesture({ type: "touchend" });
  for (const m of [0, 0, 0, -0.001]) legFix(pg, pg.restLeg, m);
  expect("the tap says the highlighted step, not the arrival", pg.said, ["Head west"]);
  expect("no foot or feet lines", noFeet(pg), []);
}

console.log("\nRefresh while parked at the last stop, then tap");
{
  const pg = tripPage("us");
  legFix(pg, pg.pactivLeg, 0);
  pg.onVoiceGesture({ type: "click" });
  for (const m of [0, 0, -0.001]) legFix(pg, pg.pactivLeg, m);
  expect("an arrival that already happened is not said again", pg.said, []);
}

console.log("\nA turn closer than 0.1 mi");
{
  const pg = tripPage("us");
  pg.voiceGestureSeen = true;
  legFix(pg, pg.pactivLeg, 0.6);
  expect("no feet, just the turn", pg.said, ["Turn right onto Woodbine Rd"]);
  const near = tripPage("us");
  near.voiceGestureSeen = true;
  legFix(near, near.restLeg, 0.03);
  expect("arriving in under 0.1 mi says just the arrival", near.said, ["Arrive at your destination on the left."]);
}

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
