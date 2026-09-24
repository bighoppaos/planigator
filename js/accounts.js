import { api, creditsMe, noteVisit, pulseActivity } from "./api.js";

const status = document.getElementById("status");
const rows = document.getElementById("rows");
const list = document.getElementById("list");
const visits = document.getElementById("visits");
const hereLine = document.getElementById("here");
const ranges = document.getElementById("ranges");
const chart = document.getElementById("chart");

const FRAMES = [
  ["1 hour", 60 * 60 * 1000, 5 * 60 * 1000],
  ["4 hours", 4 * 60 * 60 * 1000, 30 * 60 * 1000],
  ["8 hours", 8 * 60 * 60 * 1000, 60 * 60 * 1000],
  ["16 hours", 16 * 60 * 60 * 1000, 60 * 60 * 1000],
  ["24 hours", 24 * 60 * 60 * 1000, 60 * 60 * 1000],
  ["7 days", 7 * 24 * 60 * 60 * 1000, 24 * 60 * 60 * 1000],
  ["14 days", 14 * 24 * 60 * 60 * 1000, 24 * 60 * 60 * 1000],
  ["28 days", 28 * 24 * 60 * 60 * 1000, 24 * 60 * 60 * 1000],
];

let visitHits = [];
let frameIndex = 0;

function bucketStart(now, span, size) {
  const start = now - span;
  if (size >= 24 * 60 * 60 * 1000) {
    const day = new Date(start);
    day.setHours(0, 0, 0, 0);
    return day.getTime();
  }
  return start - (start % size);
}

function frameLabel(start, size) {
  const date = new Date(start);
  if (size >= 24 * 60 * 60 * 1000) {
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: size < 60 * 60 * 1000 ? "2-digit" : undefined });
}

function drawVisits() {
  const [name, span, size] = FRAMES[frameIndex];
  const now = Date.now();
  const first = bucketStart(now, span, size);
  const bars = [];
  for (let start = first; start < now; start += size) {
    const end = start + size;
    const count = visitHits.filter((stamp) => stamp >= start && stamp < end && stamp >= now - span).length;
    bars.push({ start, count });
  }
  const peak = Math.max(1, ...bars.map((bar) => bar.count));
  const total = bars.reduce((sum, bar) => sum + bar.count, 0);
  chart.replaceChildren();
  chart.setAttribute("aria-label", `${total} visits in the last ${name}`);
  for (const bar of bars) {
    const column = document.createElement("div");
    column.className = "visit-col";
    const fill = document.createElement("span");
    fill.className = "visit-bar";
    fill.style.height = `${Math.max(2, Math.round((bar.count / peak) * 100))}%`;
    const label = document.createElement("span");
    label.className = "visit-label";
    label.textContent = frameLabel(bar.start, size);
    column.title = `${frameLabel(bar.start, size)} · ${bar.count}`;
    column.append(fill, label);
    chart.append(column);
  }
  const note = document.createElement("p");
  note.className = "muted";
  note.textContent = `${total} ${total === 1 ? "visit" : "visits"} in the last ${name}.`;
  chart.append(note);
}

function drawRanges() {
  ranges.replaceChildren();
  FRAMES.forEach(([name], index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = index === frameIndex ? "flag-box on" : "flag-box";
    button.textContent = name;
    button.addEventListener("click", () => {
      frameIndex = index;
      drawRanges();
      drawVisits();
    });
    ranges.append(button);
  });
}

function cell(value) {
  const td = document.createElement("td");
  td.textContent = value;
  return td;
}

function cardLabel(account) {
  if (!account.cardLast4) return "No";
  const brand = account.cardBrand ? `${account.cardBrand} ` : "";
  return `${brand}${account.cardLast4}`;
}

function person(account) {
  if (account.name && account.email) return `${account.name} (${account.email})`;
  return account.email || account.name || "Someone";
}

function loggedInLabel(account) {
  if (!account.loggedIn) return "No";
  if (Number(account.browsers) > 1) return `Yes · ${account.browsers} browsers`;
  return "Yes";
}

function render(accounts) {
  rows.replaceChildren();
  const online = accounts.filter((account) => account.loggedIn);
  if (!accounts.length) {
    status.textContent = "No Google sign-ins yet.";
    return;
  }
  status.textContent = online.length
    ? `${online.length} logged in now: ${online.map(person).join(", ")}. ${accounts.length} signed up.`
    : `${accounts.length} signed up. Nobody is logged in right now.`;
  list.hidden = false;
  for (const account of accounts) {
    const tr = document.createElement("tr");
    tr.append(
      cell(account.name || "—"),
      cell(account.email || "—"),
      cell(String(account.used || 0)),
      cell(account.unlimited ? "Unlimited" : String(account.left ?? 0)),
      cell(cardLabel(account)),
      cell(loggedInLabel(account)),
    );
    rows.append(tr);
  }
}

let pulsed = false;

async function load() {
  const me = await creditsMe();
  if (me.idle || !me.signedIn) {
    list.hidden = true;
    status.textContent = me.idle
      ? "Signed out after an hour away. Sign in on the planner with the owner Google account, then reload this page."
      : "Sign in on the planner with the owner Google account, then reload this page.";
    return;
  }
  if (!pulsed) {
    pulsed = true;
    pulseActivity();
    noteVisit(!sessionStorage.getItem("planigator.web.visit"));
    sessionStorage.setItem("planigator.web.visit", "1");
  }
  const data = await api("/v1/admin/accounts");
  const traffic = await api("/v1/admin/visits");
  visits.hidden = false;
  const onPage = Number(traffic.here) || 0;
  hereLine.textContent = onPage === 1 ? "1 person is on the page." : `${onPage} people are on the page.`;
  visitHits = Array.isArray(traffic.hits) ? traffic.hits.map(Number) : [];
  drawRanges();
  drawVisits();
  render(Array.isArray(data.accounts) ? data.accounts : []);
}

try {
  await load();
  setInterval(load, 30000);
  const mark = () => pulseActivity();
  document.addEventListener("pointerdown", mark);
  document.addEventListener("keydown", mark);
} catch {
  status.textContent = "This list is only for the owner account. Sign in on the planner as that Google account, then reload.";
}
