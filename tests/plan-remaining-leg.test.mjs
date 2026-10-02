// While navigation is driving a leg, the Plan starts that leg now and runs only
// the drive time left on it (plus any delay on that card). Later cards, the
// arrive-by, the be-there-by warning, and the 11/14-hour clocks follow from there.
// Not loaded by the site. Run: node tests/plan-remaining-leg.test.mjs
//
// Loads the real plan, live-drive, and chip functions from js/app.js (by name,
// into a vm sandbox) with buildPlan from js/plan.js, the DOM stubbed, and a fake
// clock at 2:31 PM ET, Fri Oct 2 2026. First leg to PACTIV is 146.9 mi / 2 hr 38
// min; the truck is partway with 68.8 mi / 1 hr 14 min left.

process.env.TZ = "America/New_York";

import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appSource = readFileSync(path.join(root, "js/app.js"), "utf8");
const plan = await import(pathToFileURL(path.join(root, "js/plan.js")).href);
const hos = await import(pathToFileURL(path.join(root, "js/hos.js")).href);

const MILE = 1609.344;
const MIN = 60 * 1000;

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

function constLine(name) {
  const hit = new RegExp(`^const ${name} = [^;]+;`, "m").exec(appSource);
  if (!hit) throw new Error(`app.js has no const ${name}`);
  return hit[0].replace(/^const /, "var ");
}

const APP_FUNCTIONS = [
  "normalizeStop", "stopHasSavedLeg", "stopsAndLeaveForPlan", "leaveAtNow", "planClockNow", "rebuiltPlan",
  "zonedPlanStops", "planShape", "paintPlanClocks", "tickLeaveNow", "isDriveChip", "trackLiveDrive", "clearLiveDrive",
  "liveChipState", "liveLeftLine", "paintLiveDriveChips", "chipStatLine", "chipDelayLine", "chipParts", "chip",
  "lateNote", "drivePieceIndex", "driveDelayTarget", "driveDelayAt", "delayBox", "delayLabel", "doneStamp",
  "escapeAttr", "formatMiles", "formatShort", "formatPlanSpan", "formatPlanClock", "shownZone", "eventZone",
  "originStop", "driveTowardName", "leewayDays",
  "tripProgressKey", "readNavProgress", "readNavSpot", "writeNavProgress", "clearNavProgress", "readNavRecord", "readNavProgressMap",
  "writeNavProgressMap",
];
// Not in the old pages. They run without them, so this test can show them failing.
const OPTIONAL_FUNCTIONS = [
  "liveLegProgress", "legProgressFrom", "legDrive", "readLeftLeg", "leftLegKey", "openLeftLeg", "saveLeftLeg",
  "forgetLeftLeg",
];
const APP_CODE = [
  constLine("LIVE_DRIVE_MS"),
  constLine("LIVE_DRIVE_M"),
  constLine("NAV_PROGRESS_KEY"),
  constLine("NAV_PROGRESS_TRIPS"),
  "var navAimStopId = \"\";",
  "var liveDrive = null;",
  "var liveDrivePaintAt = 0;",
  "var liveDrivePaintAlong = NaN;",
  ...APP_FUNCTIONS.map((name) => extract(name)),
  ...OPTIONAL_FUNCTIONS.map((name) => extract(name, true)),
].join("\n\n");

const NOW = Date.UTC(2026, 9, 2, 18, 31, 0); // 2:31 PM EDT
const clock = { now: NOW };
class FakeDate extends Date {
  constructor(...args) {
    if (args.length) super(...args);
    else super(clock.now);
  }
  static now() { return clock.now; }
}

const LEG1 = { miles: 146.9, hours: 158 / 60 };
const LEFT_MILES = 68.8;
const LEFT_HOURS = LEG1.hours * (LEFT_MILES / LEG1.miles); // 1 hr 14 min
const LEG2 = { miles: 495, hours: 9 };
const WALMART_BY = Date.UTC(2026, 9, 3, 10, 0, 0); // be there by 6:00 AM Sat

const SETTINGS = {
  governed: true, governedMph: 62, leaveNow: true, leaveAt: NOW, startMinutes: 330, endMinutes: 1050,
  startAnytime: true, endAnytime: true, hoursOfEleven: 11, hoursBeforeThirty: 8, military: false,
  kilometers: false, arrival: "earliest",
};

function plannedStops({ delayMinutes = 0 } = {}) {
  return [
    { id: "here", name: "Current location", useCurrentLocation: true, lat: 39.9, lon: -75.6, miles: "", hours: "" },
    { id: "pactiv", name: "PACTIV", lat: 40, lon: -76.5, miles: String(LEG1.miles), hours: String(LEG1.hours),
      anytime: true, window: false, start: 0, end: 0, delayMinutes },
    { id: "walmart", name: "WALMART", lat: 41, lon: -84, miles: String(LEG2.miles), hours: String(LEG2.hours),
      anytime: false, window: false, start: WALMART_BY, end: WALMART_BY },
  ];
}

function memoryStorage() {
  const items = new Map();
  return {
    getItem: (key) => (items.has(key) ? items.get(key) : null),
    setItem: (key, value) => { items.set(key, String(value)); },
    removeItem: (key) => { items.delete(key); },
  };
}

function page({ delayMinutes = 0, settings = {} } = {}) {
  const calls = { patch: 0, render: 0 };
  const context = {
    console, Math, Number, String, JSON, Array, Object, Infinity, NaN, Set, Map, RegExp, Promise, Intl,
    Date: FakeDate,
    ...plan, ...hos,
    calls,
    localStorage: memoryStorage(),
    document: {
      visibilityState: "visible",
      activeElement: null,
      querySelectorAll: () => [],
      getElementById: () => null,
    },
    state: {
      stops: plannedStops({ delayMinutes }),
      settings: { ...SETTINGS, ...settings },
      plan: null, estimating: false, driveProgress: null, picker: null, origin: null, activeTripId: "trip-1",
    },
    navOn: false, routeFull: false, routePageStale: false,
    zoneForStop: () => "",
    patchPlanAfterDone: () => { calls.patch += 1; },
    render: () => { calls.render += 1; },
  };
  vm.createContext(context);
  vm.runInContext(APP_CODE, context);
  context.state.plan = context.rebuiltPlan();
  return context;
}

// The nav fix handler: the truck is `drivenMiles` into the 146.9 mi leg to PACTIV.
function driveTo(pg, drivenMiles) {
  const stop = pg.state.stops.find((item) => item.id === "pactiv");
  pg.trackLiveDrive({ along: drivenMiles * MILE }, { stop, start: 0, end: LEG1.miles * MILE });
}

function startNav(pg, drivenMiles) {
  pg.navOn = true;
  driveTo(pg, drivenMiles);
  // The minute tick re-plans too. The new page also re-plans as soon as the
  // leg is found; the old page only on the tick.
  pg.tickLeaveNow();
}

const byId = (p, id) => p.events.find((event) => event.id === id);
const drives = (p, stopId) => p.events.filter((event) => (event.kind === "lead" || event.kind === "stop") && event.stopID === stopId);
const driveHoursIn = (p) => p.events
  .filter((event) => event.kind === "lead" || event.kind === "stop")
  .reduce((sum, event) => sum + (Number(event.tripHours) || 0), 0);
const near = (a, b, ms = MIN) => Math.abs(a - b) <= ms;
const clockText = (ms) => new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }).format(new Date(ms));
const sections = (html) => [...html.matchAll(/<div class="chip-sec( [\w-]+)?">([^<]*)<\/div>/g)]
  .map((hit) => ({ kind: (hit[1] || "").trim() || "label", text: hit[2] }));

let failures = 0;
function expect(label, ok, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`);
}

// What the plan was before this build, straight from buildPlan with the whole legs.
const wholeLegs = plan.buildPlan({
  stops: plannedStops().map((stop) => ({ ...stop, miles: Number(stop.miles) || 0, hours: Number(stop.hours) || 0 })),
  settings: { ...SETTINGS, leaveAt: NOW },
  now: NOW,
});

console.log("Driving to PACTIV, 68.8 miles left at 2:31 PM");
{
  const pg = page();
  startNav(pg, LEG1.miles - LEFT_MILES);
  const p = pg.state.plan;
  const leg = byId(p, "pactiv");
  expect("PACTIV card starts now", leg && near(leg.start, NOW), leg && clockText(leg.start));
  expect("PACTIV card ends after only the time left (~3:45 PM)", leg && near(leg.end, NOW + LEFT_HOURS * 3600000),
    leg && `${clockText(leg.end)}, the whole leg would end ${clockText(NOW + LEG1.hours * 3600000)}`);
  expect("Leave by is now", near(p.rollAt, NOW), clockText(p.rollAt));

  const next = drives(p, "walmart")[0];
  const nextBefore = drives(wholeLegs, "walmart")[0];
  expect("next drive starts when PACTIV ends", next && leg && near(next.start, leg.end), next && clockText(next.start));
  expect("next drive moves up by the 1 hr 24 min already driven", next && nextBefore
    && near(nextBefore.start - next.start, (LEG1.hours - LEFT_HOURS) * 3600000), next && `${clockText(nextBefore.start)} -> ${clockText(next.start)}`);

  const driveSum = p.driveHours;
  expect("11-hour clock counts only the 1 hr 14 min left on this leg", Math.abs(driveSum - (LEFT_HOURS + LEG2.hours)) < 0.01
    && Math.abs(driveHoursIn(p) - (LEFT_HOURS + LEG2.hours)) < 0.01, `${hos.hoursLabel(driveSum)} planned driving`);
  expect("no Off-duty/Sleeper Berth: 10 hr 14 min of driving fits in the 11", p.restCount === 0,
    `${p.restCount} rest(s); the whole legs had ${wholeLegs.restCount}`);
  expect("one 30-minute break after 8 hours", p.breakCount === 1, `${p.breakCount}`);
  const arrive = NOW + (LEFT_HOURS + LEG2.hours + 0.5) * 3600000;
  expect("arrive-by moves up", near(p.arriveAt, arrive), `${clockText(p.arriveAt)} (was ${clockText(wholeLegs.arriveAt)})`);
  expect("total trip time is from now to that arrival", near(p.arriveAt - p.rollAt, (LEFT_HOURS + LEG2.hours + 0.5) * 3600000),
    hos.durationLabel((p.arriveAt - p.rollAt) / 3600000));
  expect("WALMART be-there-by is made (the whole legs said late)", !p.late && wholeLegs.late, `late=${p.late}, before=${wholeLegs.late}`);

  const html = pg.chip(leg);
  const rows = sections(html);
  const left = rows.find((row) => row.kind === "chip-left");
  expect("PACTIV card keeps the left row", left?.text === "1 hr 14 min · 68.8 miles left", JSON.stringify(rows));
  expect("PACTIV card has no full-leg row", !rows.some((row) => row.kind === "chip-mid")
    && !html.includes("2 hr 38 min") && !html.includes("146.9 miles"), JSON.stringify(rows));
  const when = rows.find((row) => row.kind === "chip-when")?.text || "";
  // 1 hr 14 min is 73.999 min of the 146.9 mi leg, so the clock can read 3:44.
  expect("PACTIV time range is 2:31 PM – ~3:45 PM", /2:31 PM – .*3:4[45] PM$/.test(when), when);

  const nextRows = sections(pg.chip(next));
  expect("a leg not started keeps its normal row", nextRows.some((row) => row.kind === "chip-mid")
    && !nextRows.some((row) => row.kind === "chip-left"), JSON.stringify(nextRows));

  // Keep driving; the left row counts down, and the next re-plan starts from there.
  clock.now += 10 * MIN;
  driveTo(pg, LEG1.miles - 60);
  const between = sections(pg.chip(byId(pg.state.plan, "pactiv"))).find((row) => row.kind === "chip-left")?.text;
  expect("left row counts down between re-plans", between === "1 hr 5 min · 60.0 miles left", between);
  pg.tickLeaveNow();
  const again = byId(pg.state.plan, "pactiv");
  const againLeft = sections(pg.chip(again)).find((row) => row.kind === "chip-left")?.text;
  expect("a re-plan starts from what is left now", again && near(again.start, clock.now)
    && near(again.end, clock.now + LEG1.hours * (60 / LEG1.miles) * 3600000), again && `${clockText(again.start)} – ${clockText(again.end)}`);
  expect("left row right after that re-plan", againLeft === "1 hr 5 min · 60.0 miles left", againLeft);
  const twice = JSON.stringify(pg.state.plan.events);
  pg.tickLeaveNow();
  expect("the same minute re-plans the same", JSON.stringify(pg.state.plan.events) === twice);
  clock.now = NOW;
}

console.log("\nA 1 hr delay on the PACTIV card");
{
  const pg = page({ delayMinutes: 60 });
  startNav(pg, LEG1.miles - LEFT_MILES);
  const p = pg.state.plan;
  const leg = byId(p, "pactiv");
  expect("PACTIV card ends after the time left plus the delay (~4:45 PM)", leg && near(leg.end, NOW + (LEFT_HOURS + 1) * 3600000),
    leg && clockText(leg.end));
  expect("the delay counts toward the 11: 1 hr 14 min + 1 hr + 9 hr needs an Off-duty/Sleeper Berth", p.restCount === 1,
    `${p.restCount} rest(s)`);
  const rows = sections(pg.chip(leg));
  expect("delay row stays, left row stays, no full-leg row", rows.some((row) => row.kind === "chip-delay")
    && rows.some((row) => row.kind === "chip-left") && !rows.some((row) => row.kind === "chip-mid"), JSON.stringify(rows));
  expect("left row has no delay in it", rows.find((row) => row.kind === "chip-left")?.text === "1 hr 14 min · 68.8 miles left",
    JSON.stringify(rows));
}

console.log("\nLeave at set (not Leave now), driving the leg");
{
  const pg = page({ settings: { leaveNow: false, leaveAt: NOW - 90 * MIN } });
  startNav(pg, LEG1.miles - LEFT_MILES);
  const leg = byId(pg.state.plan, "pactiv");
  expect("the leg being driven still starts now and ends after the time left", leg && near(leg.start, NOW)
    && near(leg.end, NOW + LEFT_HOURS * 3600000), leg && `${clockText(leg.start)} – ${clockText(leg.end)}`);
}

console.log("\nNavigation off");
{
  const pg = page();
  expect("plan is the same as before this build", JSON.stringify(pg.state.plan.events) === JSON.stringify(wholeLegs.events)
    && pg.state.plan.arriveAt === wholeLegs.arriveAt);
  const rows = sections(pg.chip(byId(pg.state.plan, "pactiv")));
  expect("PACTIV card has its normal row and no left row", rows.find((row) => row.kind === "chip-mid")?.text === "2 hr 38 min · 146.9 miles"
    && !rows.some((row) => row.kind === "chip-left"), JSON.stringify(rows));

  startNav(pg, LEG1.miles - LEFT_MILES);
  pg.navOn = false;
  pg.clearLiveDrive();
  // Build #603: End navigation keeps what is left of the leg, not the whole leg.
  const ended = byId(pg.state.plan, "pactiv");
  expect("after End navigation the plan keeps what is left of the leg",
    ended && near(ended.start, NOW) && near(ended.end, NOW + LEFT_HOURS * 3600000), ended && clockText(ended.end));
  clock.now += 5 * MIN;
  pg.tickLeaveNow();
  const ticked = byId(pg.state.plan, "pactiv");
  expect("and the next tick keeps it, from the new now", ticked && near(ticked.start, clock.now)
    && near(ticked.end, clock.now + LEFT_HOURS * 3600000), ticked && clockText(ticked.end));
  clock.now = NOW;
}

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
