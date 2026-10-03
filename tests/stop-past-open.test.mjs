// A stop's date picker allows dates up to 30 days back, so a window that
// already opened (Opens 10/02 16:41, Closes 10/05, now 10/03 04:29) can be
// entered. Older dates clamp to today - 30 days. Leave at still starts today.
// The Plan takes a past Opens as already open: no throw, no rolled dates.
// Not loaded by the site. Run: node tests/stop-past-open.test.mjs
// Against another copy: APP_JS=/path/app.js node tests/stop-past-open.test.mjs
//
// Loads the real picker, applyWhen, writeStopWhen and updateStop functions from
// js/app.js (by name, into a vm sandbox) with the DOM stubbed, and buildPlan
// from js/plan.js. The phone is in America/New_York; the clock is faked.

process.env.TZ = "America/New_York";

import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appSource = readFileSync(process.env.APP_JS || path.join(root, "js/app.js"), "utf8");
const plan = await import(pathToFileURL(path.join(root, "js/plan.js")).href);

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

// Not in the old pages. They run without it, so this test can show them failing.
function optionalConst(name) {
  const hit = new RegExp(`^const ${name} = [^;]+;`, "m").exec(appSource);
  return hit ? hit[0].replace(/^const /, "var ") : "";
}

const APP_FUNCTIONS = [
  "pad", "deviceOffset", "clockOffset", "wallParts", "msFromWall", "enteredOffset", "escapeAttr",
  "pickerStop", "pickerStopMs", "stopWhenTitle", "leaveDateValue", "todayDateValue", "clampDateValue", "wallMinutes",
  "pickerSheet", "chosenWheel", "minutesFromSheet", "readDatedMs", "readLeaveDate", "writeStopWhen", "commitPicker",
  "minutesFromWrap", "applyWhen", "stopHasSavedLeg", "updateStop",
];
const APP_CODE = [
  optionalConst("STOP_DATE_DAYS_BACK"),
  ...APP_FUNCTIONS.map((name) => extract(name)),
].join("\n\n");

// Wall clock in New York -> ms.
const local = (y, m, d, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi).getTime();
const NOW = local(2026, 10, 3, 4, 29); // Sat Oct 3 2026, 4:29 AM ET
const OPENS = local(2026, 10, 2, 16, 41);
const CLOSES = local(2026, 10, 5, 10, 59);

function page() {
  class FakeDate extends Date {
    constructor(...args) {
      if (args.length) super(...args);
      else super(NOW);
    }
    static now() { return NOW; }
  }
  const offset = new Date(NOW).getTimezoneOffset();
  // The picker opens on whatever the stop had (here: now), like a fresh card.
  const stop = {
    id: "s1", name: "SWFT", address: "", anytime: false, window: true,
    start: NOW, end: CLOSES, startOffset: offset, endOffset: offset,
  };
  const dom = { sheetDate: "", wheels: {} };
  const sandbox = {
    Date: FakeDate,
    Intl,
    console,
    dom,
    navOn: false,
    state: {
      settings: { military: true, leaveNow: false, leaveAt: NOW, leaveAtOffset: offset },
      stops: [stop],
      plan: null,
      picker: "",
      pickerTarget: null,
    },
    document: {
      querySelector(selector) {
        if (selector === "#pickerSheet [data-part=date]") return { value: dom.sheetDate };
        const wheel = /^#pickerSheet \[data-part="(\w+)"\]\.on$/.exec(selector);
        if (wheel && dom.wheels[wheel[1]] != null) return { getAttribute: () => String(dom.wheels[wheel[1]]) };
        return null;
      },
    },
    lookupOpen: new Set(),
    clearUsingNote() {},
    clearDriveProgress() {},
    persist() {},
    saveActiveTripSettings() {},
    refreshShownPlan() {},
    render() {},
    calculate() {},
  };
  vm.createContext(sandbox);
  vm.runInContext(APP_CODE, sandbox);
  return { sb: sandbox, stop };
}

function sheetDate(html) {
  const input = /<input class="picker-date"[^>]*>/.exec(html)?.[0] || "";
  return {
    min: /min="([^"]*)"/.exec(input)?.[1],
    value: /value="([^"]*)"/.exec(input)?.[1],
  };
}

// Picker: open the stop's Opens (or Closes), pick a date, then a time.
function pickStop(sb, field, date, hour, minute) {
  sb.state.pickerTarget = { id: "s1", field };
  sb.state.picker = "stopDate";
  sb.dom.sheetDate = date;
  sb.commitPicker();
  sb.dom.wheels = { hour, minute };
  sb.commitPicker();
}

// Inline [data-when] date + time inputs on a stop card (or Leave at).
function whenWrap({ when = "s1", field = "start", date, hour, minute }) {
  const values = { date, hour: String(hour), minute: String(minute) };
  return {
    getAttribute: (name) => (name === "data-when" ? when : name === "data-stop-field" ? field : null),
    closest: (selector) => (selector === "[data-stop]" && when !== "leaveAt" ? { getAttribute: () => "s1" } : null),
    querySelector: (selector) => {
      const part = /^\[data-part=(\w+)\]$/.exec(selector)?.[1];
      return part && values[part] != null ? { value: values[part] } : null;
    },
  };
}

let failures = 0;
function expect(label, ok, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`);
}
const stamp = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

// a. The stopDate picker for Opens: min is 30 days back, 10/02 is not clamped.
{
  const { sb, stop } = page();
  sb.state.pickerTarget = { id: "s1", field: "start" };
  sb.state.picker = "stopDate";
  const fresh = sheetDate(sb.pickerSheet());
  expect("a. Opens picker min = 2026-09-03", fresh.min === "2026-09-03", String(fresh.min));
  expect("a. Opens picker min <= 2026-10-02", Boolean(fresh.min) && fresh.min <= "2026-10-02", String(fresh.min));
  stop.start = OPENS;
  const past = sheetDate(sb.pickerSheet());
  expect("a. Opens picker shows 2026-10-02 (not today)", past.value === "2026-10-02", String(past.value));
  sb.dom.sheetDate = "2026-10-02";
  const read = sb.readDatedMs(stop.start, stop.startOffset, sb.STOP_DATE_DAYS_BACK ?? 0);
  expect("a. readDatedMs keeps 2026-10-02 for a stop", stamp(read).startsWith("2026-10-02"), stamp(read));
  sb.state.pickerTarget = { id: "s1", field: "end" };
  const closes = sheetDate(sb.pickerSheet());
  expect("a. Closes picker min = 2026-09-03 too", closes.min === "2026-09-03", String(closes.min));
}
{
  const { sb, stop } = page();
  sb.applyWhen(whenWrap({ field: "start", date: "2026-10-02", hour: 16, minute: 41 }));
  expect("a. applyWhen keeps 2026-10-02 for Opens", stamp(stop.start).startsWith("2026-10-02"), stamp(stop.start));
}

// b. Picking 10/02 16:41 for Opens saves local 2026-10-02 16:41.
{
  const { sb, stop } = page();
  pickStop(sb, "start", "2026-10-02", 16, 41);
  expect("b. picker saves Opens = local 2026-10-02 16:41", stop.start === OPENS, stamp(stop.start));
  expect("b. picker leaves Closes alone", stop.end === CLOSES, stamp(stop.end));
  expect("b. picker is closed after the time", sb.state.picker === "" && sb.state.pickerTarget === null);
}
{
  const { sb, stop } = page();
  sb.applyWhen(whenWrap({ field: "start", date: "2026-10-02", hour: 16, minute: 41 }));
  expect("b. inline when saves Opens = local 2026-10-02 16:41", stop.start === OPENS, stamp(stop.start));
}
{
  const { sb, stop } = page();
  pickStop(sb, "end", "2026-10-02", 23, 0);
  expect("b. Closes can be 2026-10-02 too", stop.end === local(2026, 10, 2, 23, 0), stamp(stop.end));
}

// c. 31+ days back clamps to the floor (today - 30 days).
{
  const { sb, stop } = page();
  pickStop(sb, "start", "2026-09-02", 8, 0);
  expect("c. picker 2026-09-02 -> 2026-09-03", stop.start === local(2026, 9, 3, 8, 0), stamp(stop.start));
  const edge = page();
  pickStop(edge.sb, "start", "2026-09-03", 8, 0);
  expect("c. picker 2026-09-03 (30 days back) is kept", edge.stop.start === local(2026, 9, 3, 8, 0), stamp(edge.stop.start));
  const inline = page();
  inline.sb.applyWhen(whenWrap({ field: "start", date: "2026-08-01", hour: 8, minute: 0 }));
  expect("c. inline 2026-08-01 -> 2026-09-03", inline.stop.start === local(2026, 9, 3, 8, 0), stamp(inline.stop.start));
  sb.state.pickerTarget = { id: "s1", field: "start" };
  sb.state.picker = "stopDate";
  stop.start = local(2026, 8, 1, 8, 0);
  const shown = sheetDate(sb.pickerSheet());
  expect("c. picker shows an old stop date as the floor", shown.value === "2026-09-03", String(shown.value));
}

// d. Leave at still starts today.
{
  const { sb } = page();
  sb.state.picker = "leaveAt";
  const sheet = sheetDate(sb.pickerSheet());
  expect("d. Leave at picker min = 2026-10-03", sheet.min === "2026-10-03", String(sheet.min));
  sb.dom.sheetDate = "2026-10-02";
  sb.commitPicker();
  expect("d. Leave at picker clamps 2026-10-02 -> 2026-10-03", stamp(sb.state.settings.leaveAt).startsWith("2026-10-03"),
    stamp(sb.state.settings.leaveAt));
  expect("d. Leave at picker goes on to the time", sb.state.picker === "leaveAtTime", sb.state.picker);
  sb.applyWhen(whenWrap({ when: "leaveAt", field: null, date: "2026-10-02", hour: 9, minute: 0 }));
  expect("d. Leave at inline clamps 2026-10-02 -> 2026-10-03 09:00", sb.state.settings.leaveAt === local(2026, 10, 3, 9, 0),
    stamp(sb.state.settings.leaveAt));
}

// e. Plan: Opens in the past, Closes ahead. No throw, no rolled dates.
for (const arrival of ["earliest", "latest"]) {
  const stops = [
    { id: "here", name: "Current location", useCurrentLocation: true, lat: 39.96, lon: -83.0, miles: 0, hours: 0 },
    { id: "swft", name: "SWFT", lat: 39.99, lon: -82.9, miles: 12, hours: 0.3, anytime: false, window: true,
      start: OPENS, end: CLOSES, startOffset: 240, endOffset: 240 },
  ];
  const before = JSON.stringify(stops);
  let p = null;
  let error = null;
  try {
    p = plan.buildPlan({
      stops,
      settings: {
        governed: true, governedMph: 62, leaveNow: true, leaveAt: NOW, startMinutes: 330, endMinutes: 1050,
        startAnytime: true, endAnytime: true, hoursOfEleven: 11, hoursBeforeThirty: 8, military: true,
        kilometers: false, arrival,
      },
      now: NOW,
    });
  } catch (err) {
    error = err;
  }
  expect(`e. (${arrival}) buildPlan does not throw`, !error, error?.message || "");
  const leg = p?.events?.find((event) => event.kind === "stop" && event.stopID === "swft");
  // The Plan's arrive-by search works to the minute.
  expect(`e. (${arrival}) arrives inside the window, before Closes`, leg && leg.end >= NOW && leg.end <= CLOSES + 60 * 1000,
    leg ? stamp(leg.end) : "no leg");
  if (arrival === "earliest") {
    expect("e. (earliest) leaves now, no wait for a past Opens", leg && Math.abs(leg.start - NOW) <= 60 * 1000,
      leg ? stamp(leg.start) : "no leg");
  }
  expect(`e. (${arrival}) not late`, p && !p.late, String(p?.late));
  expect(`e. (${arrival}) stop dates untouched`, JSON.stringify(stops) === before);
}

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
