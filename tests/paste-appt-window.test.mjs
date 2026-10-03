// A pasted pickup window keeps the dates that were pasted. A year-less date
// takes the year that puts it closest to today, and the close of a range takes
// the open's year (next year only when it crosses New Year). An end with its
// own date is never pushed a day; open == close stays one fixed time. Banner
// lines (*PRE-LOADED*), phone/contact lines and APPT leftovers are not part of
// the address, and the address stops at the city/state/ZIP line.
// Not loaded by the site. Run: node tests/paste-appt-window.test.mjs
// Against other copies: PASTE_JS=/path/paste-stop.js APP_JS=/path/app.js node tests/paste-appt-window.test.mjs
//
// Loads parseStopPaste from js/paste-stop.js, and the real applyStopPaste,
// pastedInstant, updateStop and card when-row functions from js/app.js (by
// name, into a vm sandbox, with parseStopPaste handed in for its import). The
// phone is in America/New_York; the clock is faked per check.

process.env.TZ = "America/New_York";

import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appSource = readFileSync(process.env.APP_JS || path.join(root, "js/app.js"), "utf8");
const pastePath = process.env.PASTE_JS || path.join(root, "js/paste-stop.js");
const { parseStopPaste } = await import(pathToFileURL(path.resolve(pastePath)).href);

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

function constLine(name) {
  const hit = new RegExp(`^const ${name} = [^;]+;`, "m").exec(appSource);
  if (!hit) throw new Error(`app.js has no const ${name}`);
  return hit[0].replace(/^const /, "var ");
}

const APP_FUNCTIONS = [
  "pad", "deviceOffset", "clockOffset", "wallParts", "msFromWall", "offsetZone", "formatUserShort", "enteredOffset",
  "escapeAttr", "whenBox", "whenRow", "placeholderStopName", "clipStopName", "stopHasSavedLeg", "pastedInstant",
  "pasteNote", "applyStopPaste", "updateStop",
];
const APP_CODE = [
  constLine("STOP_NAME_LIMIT"),
  ...APP_FUNCTIONS.map((name) => extract(name)),
  // The two when rows the stop card draws.
  `function cardWhen(stop) {
    return (stop.window ? whenRow("Opens", stop, "start", stop.start) : "")
      + whenRow(stop.window ? "Closes" : "Be there by", stop, stop.window ? "end" : "start", stop.window ? stop.end : stop.start);
  }`,
].join("\n\n");

// Wall clock in New York -> ms.
const local = (y, m, d, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi).getTime();

function throughApp(text, nowMs) {
  const clock = { now: nowMs };
  class FakeDate extends Date {
    constructor(...args) {
      if (args.length) super(...args);
      else super(clock.now);
    }
    static now() { return clock.now; }
  }
  const stop = {
    id: "s1", name: "Stop 2", address: "", anytime: true, window: false,
    start: nowMs, end: nowMs, startOffset: new Date(nowMs).getTimezoneOffset(), endOffset: new Date(nowMs).getTimezoneOffset(),
  };
  const sandbox = {
    Date: FakeDate,
    Intl,
    console,
    parseStopPaste,
    navOn: false,
    state: { settings: { military: true }, stops: [stop], plan: null },
    lookupOpen: new Set(),
    setLookupMessage() {},
    clearUsingNote() {},
    clearDriveProgress() {},
    persist() {},
    render() {},
    calculate() {},
  };
  vm.createContext(sandbox);
  vm.runInContext(APP_CODE, sandbox);
  sandbox.applyStopPaste("s1", text);
  const html = sandbox.cardWhen(stop);
  const rows = {};
  for (const hit of html.matchAll(/<span class="flag-box">([^<]+)<\/span>.*?<button[^>]*>([^<]+)<\/button>/g)) rows[hit[1]] = hit[2];
  return { stop, rows };
}

let failures = 0;
function expect(label, ok, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`);
}
const show = (value) => JSON.stringify(value);
const wall = (p) => (p ? `${p.year}-${String(p.monthIndex + 1).padStart(2, "0")}-${String(p.day).padStart(2, "0")} ${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}` : String(p));
const stamp = (ms) => {
  const d = new Date(ms);
  return wall({ year: d.getFullYear(), monthIndex: d.getMonth(), day: d.getDate(), hour: d.getHours(), minute: d.getMinutes() });
};

const COLUMBUS = [
  "SWFT COLUMBUS                ",
  "         4141 PARKWEST DR             ",
  "                                               COLUMBUS               OH    ",
  "LOAD AT PHONE#: 380-210-6200          ",
  "LOAD AT CONTACT:                      ",
  "**************************************",
  "*PRE-LOADED                          *",
  "**************************************",
  "PICKUP APPT  10/02 16:41 - 10/05 10:59",
].join("\n");

const PITTSBURGH = [
  "FRANK B FUHRER WHOLESALE    ",
  "          3100 E CARSON ST            ",
  "                                                PITTSBURGH ,PA 15203        ",
  "CONSIGN PHONE#: 800-837-8845          ",
  "CONSIGN CONTACT: ONLINE               ",
  "**************************************",
  "*LIVE UNLOAD                         *",
  "**************************************",
  "DELIVRY APPT 10/05 11:00 - 10/05 11:00",
].join("\n");

const PASTED = local(2026, 10, 3, 4, 29); // Sat Oct 3 2026, 4:29 AM ET

// a. Parser keeps the pasted window in 2026, no extra day on the close.
{
  const p = parseStopPaste(COLUMBUS, PASTED);
  expect("a. open is 2026-10-02 16:41", wall(p?.start) === "2026-10-02 16:41", wall(p?.start));
  expect("a. close is 2026-10-05 10:59", wall(p?.end) === "2026-10-05 10:59", wall(p?.end));
  expect("a. it is a window", p?.window === true, show(p?.window));
  // b. Address stops at the city line; banners and phone/contact lines are gone.
  expect("b. address", p?.address === "SWFT COLUMBUS, 4141 PARKWEST DR, COLUMBUS OH", show(p?.address));
  expect("b. name", p?.name === "SWFT", show(p?.name));
}

// c. Through applyStopPaste: the stop's ms and the card's Opens/Closes labels.
{
  const { stop, rows } = throughApp(COLUMBUS, PASTED);
  expect("c. stop start = local 2026-10-02 16:41", stop.start === local(2026, 10, 2, 16, 41), stamp(stop.start));
  expect("c. stop end = local 2026-10-05 10:59", stop.end === local(2026, 10, 5, 10, 59), stamp(stop.end));
  expect("c. stop is a window", stop.window === true, show(stop.window));
  expect("c. card Opens says Fri, 10/2, 16:41", rows.Opens === "Fri, 10/2, 16:41", show(rows));
  expect("c. card Closes says Mon, 10/5, 10:59", rows.Closes === "Mon, 10/5, 10:59", show(rows));
  expect("c. address on the stop", stop.address === "SWFT COLUMBUS, 4141 PARKWEST DR, COLUMBUS OH", show(stop.address));
}

// d. Pasted before the window opens: same dates.
{
  const now = local(2026, 10, 1, 9, 0);
  const p = parseStopPaste(COLUMBUS, now);
  expect("d. parser open/close before the window", wall(p?.start) === "2026-10-02 16:41" && wall(p?.end) === "2026-10-05 10:59", `${wall(p?.start)} .. ${wall(p?.end)}`);
  const { stop } = throughApp(COLUMBUS, now);
  expect("d. stop open/close before the window", stop.start === local(2026, 10, 2, 16, 41) && stop.end === local(2026, 10, 5, 10, 59), `${stamp(stop.start)} .. ${stamp(stop.end)}`);
}

// e. Nearest-year rule.
{
  const now = local(2026, 10, 6, 9, 0);
  const p = parseStopPaste(COLUMBUS, now);
  expect("e. window just past stays 2026 (parser)", wall(p?.start) === "2026-10-02 16:41" && wall(p?.end) === "2026-10-05 10:59", `${wall(p?.start)} .. ${wall(p?.end)}`);
  const { stop } = throughApp(COLUMBUS, now);
  expect("e. window just past stays 2026 (stop)", stop.start === local(2026, 10, 2, 16, 41) && stop.end === local(2026, 10, 5, 10, 59), `${stamp(stop.start)} .. ${stamp(stop.end)}`);

  const jan = parseStopPaste("APPT 01/05 08:00", local(2026, 12, 20, 9, 0));
  expect("e. 01/05 pasted 2026-12-20 is 2027-01-05", wall(jan?.start) === "2027-01-05 08:00", wall(jan?.start));
  const janStop = throughApp("APPT 01/05 08:00", local(2026, 12, 20, 9, 0)).stop;
  expect("e. 01/05 pasted 2026-12-20 on the stop", janStop.start === local(2027, 1, 5, 8, 0), stamp(janStop.start));

  const dec = parseStopPaste("APPT 12/28 08:00", local(2027, 1, 3, 9, 0));
  expect("e. 12/28 pasted 2027-01-03 is 2026-12-28", wall(dec?.start) === "2026-12-28 08:00", wall(dec?.start));
  const decStop = throughApp("APPT 12/28 08:00", local(2027, 1, 3, 9, 0)).stop;
  expect("e. 12/28 pasted 2027-01-03 on the stop", decStop.start === local(2026, 12, 28, 8, 0), stamp(decStop.start));

  for (const now of [PASTED, local(2027, 6, 1, 9, 0), local(2025, 3, 1, 9, 0)]) {
    const given = parseStopPaste("APPT 10/02/26 16:41", now);
    expect(`e. explicit 10/02/26 is 2026 (pasted ${stamp(now)})`, wall(given?.start) === "2026-10-02 16:41", wall(given?.start));
    // Wall clock in the offset the stop was entered in (what the card shows).
    const givenStop = throughApp("APPT 10/02/26 16:41", now).stop;
    const entered = new Date(givenStop.start - givenStop.startOffset * 60 * 1000);
    const enteredWall = wall({ year: entered.getUTCFullYear(), monthIndex: entered.getUTCMonth(), day: entered.getUTCDate(), hour: entered.getUTCHours(), minute: entered.getUTCMinutes() });
    expect(`e. explicit 10/02/26 on the stop (pasted ${stamp(now)})`, enteredWall === "2026-10-02 16:41", enteredWall);
  }
}

// f. A window that crosses New Year.
{
  const text = "PICKUP APPT 12/30 08:00 - 01/02 17:00";
  for (const now of [local(2026, 12, 31, 9, 0), local(2026, 12, 20, 9, 0), local(2027, 1, 1, 9, 0)]) {
    const p = parseStopPaste(text, now);
    expect(`f. 12/30 .. 01/02 pasted ${stamp(now)} (parser)`, wall(p?.start) === "2026-12-30 08:00" && wall(p?.end) === "2027-01-02 17:00", `${wall(p?.start)} .. ${wall(p?.end)}`);
    const { stop } = throughApp(text, now);
    expect(`f. 12/30 .. 01/02 pasted ${stamp(now)} (stop)`, stop.start === local(2026, 12, 30, 8, 0) && stop.end === local(2027, 1, 2, 17, 0), `${stamp(stop.start)} .. ${stamp(stop.end)}`);
  }
}

// g. An overnight window on one date still closes the next morning.
{
  const p = parseStopPaste("APPT 10/10 22:00 - 06:00", PASTED);
  expect("g. overnight 22:00 - 06:00 closes 10/11 06:00", wall(p?.start) === "2026-10-10 22:00" && wall(p?.end) === "2026-10-11 06:00" && p?.window === true, `${wall(p?.start)} .. ${wall(p?.end)}`);
}

// h. QualComm-style ranges parse as before.
{
  const both = parseStopPaste("10/04 16:00 - 10/04 23:59", PASTED);
  expect("h. 10/04 16:00 - 10/04 23:59", wall(both?.start) === "2026-10-04 16:00" && wall(both?.end) === "2026-10-04 23:59" && both?.window === true, `${wall(both?.start)} .. ${wall(both?.end)}`);
  const mid = parseStopPaste("16:00 - 10/04 23:59", PASTED);
  expect("h. 16:00 - 10/04 23:59", wall(mid?.start) === "2026-10-04 16:00" && wall(mid?.end) === "2026-10-04 23:59" && mid?.window === true, `${wall(mid?.start)} .. ${wall(mid?.end)}`);
}

// i. Banner lines are never in the address, before or after the city line.
{
  const after = parseStopPaste("ACME FOODS\n123 MAIN ST\nCHICAGO, IL 60601\n*PRE-LOADED *\n**** LIVE LOAD ****\n*****\nAPPT 10/05 08:00", PASTED);
  expect("i. banners after the city line", after?.address === "ACME FOODS, 123 MAIN ST, CHICAGO, IL 60601", show(after?.address));
  const before = parseStopPaste("ACME FOODS\n*PRE-LOADED *\n**** LIVE LOAD ****\n*****\n123 MAIN ST\nCOLUMBUS OH\nAPPT 10/05 08:00", PASTED);
  expect("i. banners before the city line", before?.address === "ACME FOODS, 123 MAIN ST, COLUMBUS OH", show(before?.address));
  const noStars = [after?.address, before?.address].every((a) => a && !/PRE-LOADED|LIVE LOAD|\*/.test(a));
  expect("i. no banner text or asterisks", noStars, show([after?.address, before?.address]));
}

// j. Open == close is one fixed time, on both the parser and the card.
{
  const p = parseStopPaste(PITTSBURGH, PASTED);
  expect("j. parser open = 2026-10-05 11:00", wall(p?.start) === "2026-10-05 11:00", wall(p?.start));
  expect("j. parser close = 2026-10-05 11:00 (no extra day)", wall(p?.end) === "2026-10-05 11:00", wall(p?.end));
  expect("j. address", p?.address === "FRANK B FUHRER WHOLESALE, 3100 E CARSON ST, PITTSBURGH, PA 15203", show(p?.address));
  expect("j. name", p?.name === "FRANK", show(p?.name));
  const { stop, rows } = throughApp(PITTSBURGH, PASTED);
  expect("j. stop start = end = local 2026-10-05 11:00", stop.start === local(2026, 10, 5, 11, 0) && stop.end === stop.start, `${stamp(stop.start)} .. ${stamp(stop.end)}`);
  expect("j. card Opens says Mon, 10/5, 11:00", rows.Opens === "Mon, 10/5, 11:00", show(rows));
  expect("j. card Closes says Mon, 10/5, 11:00", rows.Closes === "Mon, 10/5, 11:00", show(rows));
}

// k. Any "<who> PHONE#" / "<who> CONTACT" line stays out of the address.
{
  const p = parseStopPaste("ACME FOODS\n4141 PARKWEST DR\nCOLUMBUS OH\nSHIPPER PHONE#: 614-555-1212\nCONSIGN PHONE#: 800-837-8845\nCONSIGN CONTACT: ONLINE\nAPPT 10/05 08:00", PASTED);
  expect("k. phone/contact lines after the city line", p?.address === "ACME FOODS, 4141 PARKWEST DR, COLUMBUS OH", show(p?.address));
  const inside = parseStopPaste("ACME FOODS\nCONSIGN PHONE#: 800-837-8845\nSHIPPER PHONE#: 614-555-1212\nCONSIGN CONTACT: ONLINE\n4141 PARKWEST DR\nCOLUMBUS, OH 43219\nAPPT 10/05 08:00", PASTED);
  expect("k. phone/contact lines before the city line", inside?.address === "ACME FOODS, 4141 PARKWEST DR, COLUMBUS, OH 43219", show(inside?.address));
}

// l. A suite line after the street is still part of the address.
{
  const p = parseStopPaste("ACME FOODS\n123 MAIN ST\nSUITE 200\nCHICAGO, IL 60601\nAPPT 10/05 08:00", PASTED);
  expect("l. suite line kept", p?.address === "ACME FOODS, 123 MAIN ST, SUITE 200, CHICAGO, IL 60601", show(p?.address));
}

process.exit(failures ? 1 : 0);
