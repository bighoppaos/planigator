// Leeway is spare time, so it never runs through an Off-duty/Sleeper Berth or a
// 30-minute break. It shows before the break and again after it.
// Not loaded by the site. Run: node tests/leeway-split.test.mjs
// Against other copies: PLAN_JS=/path/plan.js APP_JS=/path/app.js node tests/leeway-split.test.mjs
// (a plan.js copy needs its hos.js beside it.)
//
// The scenario is the real buildPlan from js/plan.js, phone in America/New_York:
// leave Sun 10/4/2026 8:00 AM, one stop 5 hr 51 min away whose window opens and
// closes Mon 10/5 11:00 AM, driving day 5:30 AM – 5:30 PM. The drive ends Sun
// 1:51 PM, the planner puts the 12 hr Off-duty at Sun 5:30 PM – Mon 5:30 AM,
// and the finish card is Mon 11:00 AM. leewayDays and eventsAround come from
// js/app.js (by name, into a vm sandbox).

process.env.TZ = "America/New_York";

import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const plan = await import(pathToFileURL(process.env.PLAN_JS || path.join(root, "js/plan.js")).href);
const appSource = readFileSync(process.env.APP_JS || path.join(root, "js/app.js"), "utf8");

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

const app = { state: { plan: null } };
vm.createContext(app);
vm.runInContext(["leewayDays", "eventsAround"].map(extract).join("\n\n"), app);

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const local = (y, m, d, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi).getTime();
const clock = (ms) => new Date(ms).toLocaleString("en-US", {
  weekday: "short", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit",
});
const span = (event) => (event ? `${clock(event.start)} – ${clock(event.end)}` : "missing");
const isBreak = (event) => event.kind === "rest" || event.kind === "thirty";

let failures = 0;
function expect(label, ok, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`);
}

function noOverlaps(label, events) {
  const leeway = events.filter((event) => event.kind === "leeway");
  const breaks = events.filter(isBreak);
  const hits = leeway.flatMap((gap) => breaks
    .filter((pause) => pause.start < gap.end && pause.end > gap.start)
    .map((pause) => `${gap.id} (${span(gap)}) over ${pause.id} (${span(pause)})`));
  expect(`${label}: no leeway overlaps an Off-duty or 30-minute break`, hits.length === 0, hits.join("; "));
  const short = leeway.filter((gap) => gap.end - gap.start < MIN);
  expect(`${label}: no leeway under a minute`, short.length === 0, short.map((gap) => gap.id).join(", "));
}

const SETTINGS = {
  governed: true, governedMph: 62, leaveNow: false, startMinutes: 330, endMinutes: 1050,
  startAnytime: false, endAnytime: false, hoursOfEleven: 11, hoursBeforeThirty: 8, military: false,
  kilometers: false, arrival: "earliest",
};

// a, b, e. The user's Plan: last stop reached Sun 1:51 PM, finish Mon 11:00 AM.
console.log("Last stop Sun 1:51 PM, Off-duty Sun 5:30 PM – Mon 5:30 AM, finish Mon 11:00 AM");
{
  const LEAVE = local(2026, 10, 4, 8, 0);
  const APPT = local(2026, 10, 5, 11, 0);
  const DRIVE = 5 + 51 / 60;
  const stops = [
    { id: "here", name: "Start", useCurrentLocation: true, lat: 39.9, lon: -75.6, miles: 0, hours: 0 },
    { id: "dc", name: "DC", lat: 41, lon: -84, miles: DRIVE * 62, hours: DRIVE, anytime: false, window: true,
      start: APPT, end: APPT },
  ];
  const p = plan.buildPlan({ stops, settings: { ...SETTINGS, leaveAt: LEAVE }, now: LEAVE });
  const events = p.events || [];
  const drive = events.find((event) => event.id === "dc");
  const afterDrive = events.filter((event) => drive && event.start >= drive.end);
  const want = [
    { kind: "leeway", start: local(2026, 10, 4, 13, 51), end: local(2026, 10, 4, 17, 30), text: "0 days 3 hr 39 min" },
    { kind: "rest", start: local(2026, 10, 4, 17, 30), end: local(2026, 10, 5, 5, 30), hours: 12 },
    { kind: "leeway", start: local(2026, 10, 5, 5, 30), end: APPT, text: "0 days 5 hr 30 min" },
    { kind: "finish", start: APPT, end: APPT },
  ];
  expect("a. after the drive: Leeway, Off-duty, Leeway, Finish stop",
    afterDrive.map((event) => event.kind).join(",") === want.map((item) => item.kind).join(","),
    afterDrive.map((event) => `${event.kind} ${span(event)}`).join(" | "));
  want.forEach((item, at) => {
    const got = afterDrive[at];
    const ok = got && got.kind === item.kind && got.start === item.start && got.end === item.end;
    expect(`a. ${at + 1}. ${item.kind} ${clock(item.start)} – ${clock(item.end)}`, ok, got ? `${got.kind} ${span(got)}` : "missing");
    if (item.text) {
      const text = got ? app.leewayDays(got.tripHours) : "";
      expect(`a. ${at + 1}. leeway reads "${item.text}"`, text === item.text, text);
      expect(`a. ${at + 1}. tripHours is its own span`, got && Math.abs(got.tripHours - (got.end - got.start) / HOUR) < 1e-9,
        got ? String(got.tripHours) : "missing");
    }
    if (item.hours) expect(`a. ${at + 1}. Off-duty is 12 hr`, got && Math.abs(got.tripHours - item.hours) < 1e-9, String(got?.tripHours));
  });
  const pieces = events.filter((event) => event.kind === "leeway");
  expect("a. first piece keeps the id, second gets -2",
    pieces.map((event) => event.id).join(",") === "leeway-after-dc,leeway-after-dc-2", pieces.map((event) => event.id).join(","));
  expect("a. both pieces keep kind, after, stopID, rgb, timePhrase",
    pieces.length === 2 && pieces.every((event) => event.after === 1 && event.stopID === "dc" && event.timePhrase === "Leeway"
      && JSON.stringify(event.rgb) === JSON.stringify(pieces[0].rgb)));

  app.state.plan = p;
  const around = app.eventsAround("dc");
  expect("a. stop card: drive, then Leeway, Off-duty, Leeway, Finish stop",
    around.self?.id === "dc" && around.before.length === 0
      && around.following.map((event) => event.id).join(",") === "leeway-after-dc,rest-day-dc,leeway-after-dc-2,finish-dc",
    `before [${around.before.map((event) => event.id)}] following [${around.following.map((event) => event.id)}]`);

  noOverlaps("b", events);

  // e. Read from Build #614's buildPlan with the same inputs.
  expect("e. drive unchanged: Sun 8:00 AM – 1:51 PM, 5 hr 51 min, 362.7 miles",
    drive && drive.start === LEAVE && drive.end === local(2026, 10, 4, 13, 51)
      && Math.abs(drive.tripHours - DRIVE) < 1e-9 && Math.abs(drive.miles - DRIVE * 62) < 1e-9, drive ? span(drive) : "missing");
  const rests = events.filter(isBreak);
  expect("e. one Off-duty, rest-day-dc, Sun 5:30 PM – Mon 5:30 AM, no 30-minute break",
    rests.length === 1 && rests[0].id === "rest-day-dc" && rests[0].start === local(2026, 10, 4, 17, 30)
      && rests[0].end === local(2026, 10, 5, 5, 30), rests.map((event) => `${event.id} ${span(event)}`).join(", "));
  expect("e. plan totals unchanged: arrive Sun 1:51 PM, 1 Off-duty, 0 breaks",
    p.arriveAt === local(2026, 10, 4, 13, 51) && p.restCount === 1 && p.breakCount === 0,
    `${clock(p.arriveAt)}, ${p.restCount} rest, ${p.breakCount} breaks`);
}

// c. A leeway between two stops with a 30-minute break inside it. The planner
// leaves no break inside a between-stops leeway, so the events are built by hand.
console.log("\nBetween stops: Leeway Sun 1:00 PM – 5:00 PM with a 30-minute break 2:00 – 2:30 PM");
{
  const rgb = [0.5, 0.5, 0.5];
  const built = [
    { id: "a", kind: "stop", start: local(2026, 10, 4, 8, 0), end: local(2026, 10, 4, 13, 0), stopID: "a", index: 1, tripHours: 5 },
    { id: "leeway-after-a", kind: "leeway", start: local(2026, 10, 4, 13, 0), end: local(2026, 10, 4, 17, 0),
      tripHours: 4, timePhrase: "Leeway", rgb, after: 1, stopID: "a" },
    { id: "thirty-b-0", kind: "thirty", start: local(2026, 10, 4, 14, 0), end: local(2026, 10, 4, 14, 30),
      tripHours: 0.5, timePhrase: "30-minute break", stopID: "b" },
    { id: "b", kind: "stop", start: local(2026, 10, 4, 17, 0), end: local(2026, 10, 4, 19, 0), stopID: "b", index: 2, tripHours: 2 },
  ];
  const split = typeof plan.splitLeewayAroundBreaks === "function" ? plan.splitLeewayAroundBreaks(built) : null;
  expect("c. plan.js has splitLeewayAroundBreaks", Boolean(split));
  const pieces = (split || []).filter((event) => event.kind === "leeway");
  expect("c. two pieces: 1:00 – 2:00 PM (1 hr) and 2:30 – 5:00 PM (2 hr 30 min)",
    pieces.length === 2
      && pieces[0].id === "leeway-after-a" && pieces[0].start === local(2026, 10, 4, 13, 0) && pieces[0].end === local(2026, 10, 4, 14, 0)
      && pieces[1].id === "leeway-after-a-2" && pieces[1].start === local(2026, 10, 4, 14, 30) && pieces[1].end === local(2026, 10, 4, 17, 0)
      && app.leewayDays(pieces[0].tripHours) === "0 days 1 hr 0 min" && app.leewayDays(pieces[1].tripHours) === "0 days 2 hr 30 min",
    pieces.map((event) => `${event.id} ${span(event)} ${app.leewayDays(event.tripHours)}`).join(" | "));
  expect("c. pieces keep after and stopID", pieces.length === 2 && pieces.every((event) => event.after === 1 && event.stopID === "a" && event.rgb === rgb));
  expect("c. other events untouched", (split || []).filter((event) => event.kind !== "leeway").every((event, at) => (
    event === built.filter((item) => item.kind !== "leeway")[at])));
  noOverlaps("c", split || built);

  app.state.plan = { events: (split || built).slice().sort((x, y) => x.start - y.start) };
  const around = app.eventsAround("a");
  expect("c. stop card for a: Leeway, Leeway after the drive",
    around.following.map((event) => event.id).join(",") === "leeway-after-a,leeway-after-a-2",
    around.following.map((event) => event.id).join(","));

  const edge = typeof plan.splitLeewayAroundBreaks === "function" ? plan.splitLeewayAroundBreaks([
    { id: "leeway-after-a", kind: "leeway", start: local(2026, 10, 4, 13, 0), end: local(2026, 10, 4, 14, 0), tripHours: 1, after: 1, stopID: "a" },
    { id: "thirty-b-0", kind: "thirty", start: local(2026, 10, 4, 13, 0) + 30 * 1000, end: local(2026, 10, 4, 13, 30), stopID: "b" },
  ]) : [];
  const edgeLeeway = edge.filter((event) => event.kind === "leeway");
  expect("c. a sliver under a minute is dropped; the rest keeps the id",
    edgeLeeway.length === 1 && edgeLeeway[0].id === "leeway-after-a" && edgeLeeway[0].start === local(2026, 10, 4, 13, 30),
    edgeLeeway.map((event) => `${event.id} ${span(event)}`).join(" | "));
}

// d. Leeway with no break inside it stays exactly as Build #614 had it.
console.log("\nLeeway with no break inside");
{
  const LEAVE = local(2026, 10, 4, 8, 0);
  const stops = [
    { id: "here", name: "Start", useCurrentLocation: true, lat: 39.9, lon: -75.6, miles: 0, hours: 0 },
    { id: "pu", name: "PU", lat: 40, lon: -76.5, miles: 62, hours: 1, anytime: false, window: true,
      start: local(2026, 10, 4, 11, 0), end: local(2026, 10, 4, 15, 0) },
    { id: "dc", name: "DC", lat: 41, lon: -84, miles: 124, hours: 2, anytime: false, window: false,
      start: local(2026, 10, 4, 17, 0), end: local(2026, 10, 4, 17, 0) },
  ];
  const p = plan.buildPlan({ stops, settings: { ...SETTINGS, leaveAt: LEAVE }, now: local(2026, 10, 4, 7, 0) });
  // Read from Build #614's buildPlan with the same inputs.
  const was = [
    { id: "leeway-now-pu", start: local(2026, 10, 4, 7, 0), end: local(2026, 10, 4, 8, 0), tripHours: 1 },
    { id: "leeway-after-pu", start: local(2026, 10, 4, 9, 0), end: local(2026, 10, 4, 11, 0), tripHours: 2 },
    { id: "leeway-after-dc", start: local(2026, 10, 4, 13, 0), end: local(2026, 10, 4, 17, 0), tripHours: 4 },
  ];
  const leeway = (p.events || []).filter((event) => event.kind === "leeway");
  const same = leeway.length === was.length && was.every((item, at) => (
    leeway[at].id === item.id && leeway[at].start === item.start && leeway[at].end === item.end
      && Math.abs(leeway[at].tripHours - item.tripHours) < 1e-9));
  expect("d. before the first stop, between stops, after the last: same id/start/end/tripHours as #614", same,
    leeway.map((event) => `${event.id} ${span(event)} ${event.tripHours}`).join(" | "));
  expect("d. finish card at PU still shows at 11:00 AM",
    (p.events || []).some((event) => event.id === "finish-pu" && event.start === local(2026, 10, 4, 11, 0)));
  noOverlaps("d", p.events || []);
}

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
