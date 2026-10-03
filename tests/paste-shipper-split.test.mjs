// Phone, contact, fax and email lines ("SHIPPER PHONE#", "CONSIGN CONTACT")
// never start a new stop in a paste, and an APPT line ("PICKUP APPT ...")
// stays with the stop it belongs to. Real multi-stop pastes still split and
// fill the first stop.
// Not loaded by the site. Run: node tests/paste-shipper-split.test.mjs
// Against other copies: PASTE_JS=/path/paste-stop.js APP_JS=/path/app.js node tests/paste-shipper-split.test.mjs
//
// Loads parseStopPaste from js/paste-stop.js and the real pasteNote from
// js/app.js (by name, into a vm sandbox). The phone is in America/New_York;
// the clock is 2026-10-03 05:00.

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
  let i = appSource.indexOf("{", head.index + head[0].length);
  let depth = 0;
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
      if (!depth) return appSource.slice(head.index, i + 1);
    }
  }
  throw new Error(`Could not read function ${name}`);
}

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(`${extract("pasteNote")}\nthis.pasteNote = pasteNote;`, sandbox);
const { pasteNote } = sandbox;

let failures = 0;
function expect(label, ok, detail) {
  if (ok) console.log(`ok   ${label}`);
  else {
    failures += 1;
    console.log(`FAIL ${label}${detail === undefined ? "" : ` -> ${detail}`}`);
  }
}

const show = (value) => JSON.stringify(value);
const pad = (n) => String(n).padStart(2, "0");
const wall = (p) => (p ? `${p.year}-${pad(p.monthIndex + 1)}-${pad(p.day)} ${pad(p.hour ?? 0)}:${pad(p.minute ?? 0)}` : "null");
const NOW = new Date(2026, 9, 3, 5, 0).getTime();

const ACME = [
  "ACME PACKAGING CO              ",
  "          1200 INDUSTRIAL PKWY          ",
  "                                       DAYTON ,OH 45414        ",
  "SHIPPER PHONE#: 937-555-0142          ",
  "SHIPPER CONTACT: DOCK OFFICE          ",
  "**************************************",
  "*LIVE LOAD                           *",
  "**************************************",
  "PICKUP APPT  10/06 08:00 - 10/06 14:00",
];
const ACME_ADDRESS = "ACME PACKAGING CO, 1200 INDUSTRIAL PKWY, DAYTON, OH 45414";

const BIG_BOX = [
  "BIG BOX DC                    ",
  "          500 COMMERCE DR            ",
  "                                             COLUMBUS ,OH 43215        ",
  "CONSIGN PHONE#: 614-555-0199          ",
  "CONSIGN CONTACT: RECEIVING               ",
  "**************************************",
  "*LIVE UNLOAD                         *",
  "**************************************",
  "DELIVRY APPT 10/07 06:00 - 10/07 06:00",
];

function single(label, text, { start, end, address }) {
  const p = parseStopPaste(text, NOW);
  expect(`${label}: address`, p?.address === address, show(p?.address));
  expect(`${label}: open ${start}`, wall(p?.start) === start, wall(p?.start));
  expect(`${label}: close ${end}`, wall(p?.end) === end, wall(p?.end));
  expect(`${label}: is a window`, p?.window === true, show(p?.window));
  expect(`${label}: one stop (usedFirst false)`, p?.usedFirst === false, show(p?.usedFirst));
  expect(`${label}: hadWhen`, p?.hadWhen === true, show(p?.hadWhen));
  const note = p ? pasteNote(p) : "";
  expect(`${label}: note does not say "Filled the first stop"`, !/Filled the first stop/.test(note), show(note));
  expect(`${label}: note says times are set`, /Times are set\./.test(note), show(note));
}

function first(label, text, { start, end, address }) {
  const p = parseStopPaste(text, NOW);
  expect(`${label}: first stop address`, p?.address === address, show(p?.address));
  expect(`${label}: open ${start}`, wall(p?.start) === start, wall(p?.start));
  expect(`${label}: close ${end}`, wall(p?.end) === end, wall(p?.end));
  expect(`${label}: is a window`, p?.window === true, show(p?.window));
  expect(`${label}: usedFirst true`, p?.usedFirst === true, show(p?.usedFirst));
  const note = p ? pasteNote(p) : "";
  expect(`${label}: note says "Filled the first stop"`, /Filled the first stop/.test(note), show(note));
}

// a. The exact shipper block: one stop, the APPT window is kept.
single("a. SHIPPER PHONE#/CONTACT + PICKUP APPT", ACME.join("\n"), {
  start: "2026-10-06 08:00", end: "2026-10-06 14:00", address: ACME_ADDRESS,
});

// b. Same block as a consignee: CONSIGN PHONE#/CONTACT + DELIVRY APPT.
single("b. CONSIGN PHONE#/CONTACT + DELIVRY APPT", [
  ...ACME.slice(0, 3),
  "CONSIGN PHONE#: 937-555-0142          ",
  "CONSIGN CONTACT: DOCK OFFICE          ",
  ...ACME.slice(5, 8),
  "DELIVRY APPT 10/06 08:00 - 10/06 14:00",
].join("\n"), { start: "2026-10-06 08:00", end: "2026-10-06 14:00", address: ACME_ADDRESS });

// c. LOAD AT PHONE#/CONTACT + PICKUP APPT.
single("c. LOAD AT PHONE#/CONTACT + PICKUP APPT", [
  ...ACME.slice(0, 3),
  "LOAD AT PHONE#: 937-555-0142          ",
  "LOAD AT CONTACT: DOCK OFFICE          ",
  ...ACME.slice(5),
].join("\n"), { start: "2026-10-06 08:00", end: "2026-10-06 14:00", address: ACME_ADDRESS });

// d. Other who/what pairs: none of these start a new stop.
single("d. PICKUP PHONE / DELIVERY CONTACT / RECEIVER FAX / CONSIGNEE CONTACT / SHIPPER EMAIL", [
  ...ACME.slice(0, 3),
  "PICKUP PHONE 937-555-0142",
  "DELIVERY CONTACT: DOCK OFFICE",
  "RECEIVER FAX 937-555-0143",
  "CONSIGNEE CONTACT: JOE",
  "SHIPPER EMAIL: dock@acme.example",
  "PICKUP APPT  10/06 08:00 - 10/06 14:00",
].join("\n"), { start: "2026-10-06 08:00", end: "2026-10-06 14:00", address: ACME_ADDRESS });

// e. PU APPT / DEL APPT lines stay with the stop.
single("e. PU APPT", [...ACME.slice(0, 8), "PU APPT 10/06 08:00 - 10/06 14:00"].join("\n"), {
  start: "2026-10-06 08:00", end: "2026-10-06 14:00", address: ACME_ADDRESS,
});
single("e. DEL APPT", [...ACME.slice(0, 8), "DEL APPT 10/06 08:00 - 10/06 14:00"].join("\n"), {
  start: "2026-10-06 08:00", end: "2026-10-06 14:00", address: ACME_ADDRESS,
});

// f. Header-first two-stop paste (3a).
first("f. PICKUP / DELIVERY headers", [
  "PICKUP",
  "ACME PACKAGING CO",
  "1200 INDUSTRIAL PKWY",
  "DAYTON, OH 45414",
  "APPT 10/06 08:00 - 10/06 14:00",
  "DELIVERY",
  "BIG BOX DC",
  "500 COMMERCE DR",
  "COLUMBUS, OH 43215",
  "APPT 10/07 06:00",
].join("\n"), { start: "2026-10-06 08:00", end: "2026-10-06 14:00", address: ACME_ADDRESS });

// g. Label style and Stop 1 / Stop 2 style (3b).
first("g. Pickup: / Delivery: labels", [
  "Pickup: ACME PACKAGING CO",
  "1200 INDUSTRIAL PKWY",
  "DAYTON, OH 45414",
  "10/06 08:00 - 14:00",
  "Delivery: BIG BOX DC",
  "500 COMMERCE DR",
  "COLUMBUS, OH 43215",
  "10/07 06:00",
].join("\n"), { start: "2026-10-06 08:00", end: "2026-10-06 14:00", address: ACME_ADDRESS });

first("g. Pickup: / Pickup appointment: / Delivery: / Delivery appointment:", [
  "Pickup: ACME PACKAGING CO, 1200 INDUSTRIAL PKWY, DAYTON, OH 45414",
  "Pickup appointment: 10/06 08:00 - 14:00",
  "Delivery: BIG BOX DC, 500 COMMERCE DR, COLUMBUS, OH 43215",
  "Delivery appointment: 10/07 06:00",
].join("\n"), { start: "2026-10-06 08:00", end: "2026-10-06 14:00", address: ACME_ADDRESS });

first("g. Stop 1 - Pickup / Stop 2 - Delivery", [
  "Stop 1 - Pickup",
  "ACME PACKAGING CO",
  "1200 INDUSTRIAL PKWY",
  "DAYTON, OH 45414",
  "10/06 08:00 - 14:00",
  "Stop 2 - Delivery",
  "BIG BOX DC",
  "500 COMMERCE DR",
  "COLUMBUS, OH 43215",
  "10/07 06:00",
].join("\n"), { start: "2026-10-06 08:00", end: "2026-10-06 14:00", address: ACME_ADDRESS });

// h. Two dispatch blocks back to back (3c): the first block, nothing from the second.
{
  const text = [...ACME, ...BIG_BOX].join("\n");
  first("h. shipper block then consignee block", text, {
    start: "2026-10-06 08:00", end: "2026-10-06 14:00", address: ACME_ADDRESS,
  });
  const p = parseStopPaste(text, NOW);
  expect("h. nothing from the second block in the address", !/BIG BOX|COMMERCE|COLUMBUS/.test(p?.address || ""), show(p?.address));
}

// i. SWFT COLUMBUS and FRANK B FUHRER still parse as in #611.
{
  const columbus = parseStopPaste([
    "SWFT COLUMBUS                ",
    "         4141 PARKWEST DR             ",
    "                                               COLUMBUS               OH    ",
    "LOAD AT PHONE#: 380-210-6200          ",
    "LOAD AT CONTACT:                      ",
    "**************************************",
    "*PRE-LOADED                          *",
    "**************************************",
    "PICKUP APPT  10/02 16:41 - 10/05 10:59",
  ].join("\n"), NOW);
  expect("i. SWFT address", columbus?.address === "SWFT COLUMBUS, 4141 PARKWEST DR, COLUMBUS OH", show(columbus?.address));
  expect("i. SWFT window 10/02 16:41 - 10/05 10:59", wall(columbus?.start) === "2026-10-02 16:41" && wall(columbus?.end) === "2026-10-05 10:59" && columbus?.window === true, `${wall(columbus?.start)} .. ${wall(columbus?.end)}`);
  expect("i. SWFT usedFirst false", columbus?.usedFirst === false, show(columbus?.usedFirst));

  const frank = parseStopPaste([
    "FRANK B FUHRER WHOLESALE    ",
    "          3100 E CARSON ST            ",
    "                                                PITTSBURGH ,PA 15203        ",
    "CONSIGN PHONE#: 800-837-8845          ",
    "CONSIGN CONTACT: ONLINE               ",
    "**************************************",
    "*LIVE UNLOAD                         *",
    "**************************************",
    "DELIVRY APPT 10/05 11:00 - 10/05 11:00",
  ].join("\n"), NOW);
  expect("i. FRANK address", frank?.address === "FRANK B FUHRER WHOLESALE, 3100 E CARSON ST, PITTSBURGH, PA 15203", show(frank?.address));
  expect("i. FRANK open = close = 10/05 11:00", wall(frank?.start) === "2026-10-05 11:00" && wall(frank?.end) === "2026-10-05 11:00" && frank?.window === true, `${wall(frank?.start)} .. ${wall(frank?.end)}`);
  expect("i. FRANK usedFirst false", frank?.usedFirst === false, show(frank?.usedFirst));
}

// j. A single stop with notes after its APPT line is still one stop.
{
  const p = parseStopPaste([...ACME, "WEIGHT: 40000", "PO# 12345", "NOTES: CHECK IN AT GUARD SHACK"].join("\n"), NOW);
  expect("j. notes after APPT: one stop", p?.usedFirst === false, show(p?.usedFirst));
  expect("j. notes after APPT: window kept", wall(p?.start) === "2026-10-06 08:00" && wall(p?.end) === "2026-10-06 14:00", `${wall(p?.start)} .. ${wall(p?.end)}`);
  expect("j. notes after APPT: address", p?.address === ACME_ADDRESS, show(p?.address));
}

process.exit(failures ? 1 : 0);
