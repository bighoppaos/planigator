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
  const windowStart = now - span;
  const count = Math.max(1, Math.ceil((now - first) / size));
  const bars = Array.from({ length: count }, (_, index) => ({ start: first + index * size, count: 0 }));
  for (const item of visitHits) {
    const stamp = visitStamp(item);
    if (stamp < windowStart || stamp >= now) continue;
    const index = Math.floor((stamp - first) / size);
    if (index >= 0 && index < bars.length) bars[index].count += 1;
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
  note.textContent = visitNote(name, total, now, span);
  chart.append(note);
}

function visitStamp(item) {
  return typeof item === "number" ? item : Number(item?.t) || 0;
}

function visitNote(name, total, now, span) {
  const inFrame = visitHits.filter((item) => {
    const stamp = visitStamp(item);
    return stamp >= now - span && stamp <= now;
  });
  const you = inFrame.filter((item) => item?.who === "you").length;
  const others = inFrame.filter((item) => item?.who === "account").length;
  const guests = inFrame.filter((item) => item?.who === "guest").length;
  const earlier = inFrame.length - you - others - guests;
  const word = total === 1 ? "visit" : "visits";
  let text = `${total} ${word} in the last ${name}. ${you} were you. ${others} were another account. ${guests} were not signed in.`;
  if (earlier) text += ` ${earlier} are from before this page could tell who.`;
  return text;
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

function localDayKey(ms = Date.now()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(ms));
  const pick = (type) => parts.find((part) => part.type === type)?.value || "";
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}

function dayLabel(iso) {
  const [year, month, day] = String(iso || "").split("-").map(Number);
  if (!year || !month || !day) return iso || "—";
  const date = new Date(year, month - 1, day);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: sameYear ? undefined : "numeric",
  });
}

function renderDays(days) {
  const box = document.getElementById("usage");
  const body = document.getElementById("usageRows");
  const note = document.getElementById("usageNote");
  box.hidden = false;
  const list = Array.isArray(days) ? days : [];
  const today = list.find((day) => day.day === localDayKey());
  const you = Number(today?.you) || 0;
  const others = Number(today?.others) || 0;
  note.textContent = list.length
    ? `Today you used ${you}. Anyone else used ${others}.`
    : "No credits used yet.";
  body.replaceChildren();
  for (const day of list) {
    const yours = Number(day.you) || 0;
    const rest = Number(day.others) || 0;
    const tr = document.createElement("tr");
    tr.append(
      cell(dayLabel(day.day)),
      cell(String(yours)),
      cell(String(rest)),
      cell(String(yours + rest)),
    );
    body.append(tr);
  }
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

function loginLabel(account) {
  const ms = Number(account.lastLogin);
  if (!ms) return "—";
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
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
      cell(loginLabel(account)),
    );
    rows.append(tr);
  }
}

let pulsed = false;

async function load() {
  const me = await creditsMe();
  if (me.idle || !me.signedIn) {
    list.hidden = true;
    visits.hidden = true;
    document.getElementById("usage").hidden = true;
    document.getElementById("hero").hidden = true;
    document.getElementById("gifts").hidden = true;
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
    setInterval(() => {
      if (document.visibilityState === "visible") noteVisit(false);
    }, 30000);
  }
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  await Promise.all([
    loadHeroEditor(),
    loadAccounts(zone),
    loadVisits(),
    loadGifts(),
  ]);
}

async function loadAccounts(zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC") {
  const data = await api(`/v1/admin/accounts?tz=${encodeURIComponent(zone)}`);
  renderDays(data.days);
  render(Array.isArray(data.accounts) ? data.accounts : []);
  if (data.scanDone === false) setTimeout(() => { void loadAccounts(zone); }, 4000);
}

async function loadVisits(hereOnly = false) {
  const traffic = await api(hereOnly ? "/v1/admin/visits?here=1" : "/v1/admin/visits");
  visits.hidden = false;
  const onPage = Number(traffic.here) || 0;
  hereLine.textContent = onPage === 1 ? "1 person is on the page." : `${onPage} people are on the page.`;
  if (hereOnly) return;
  visitHits = Array.isArray(traffic.hits) ? traffic.hits : [];
  drawRanges();
  drawVisits();
}

const HERO_MAX = 6;
const DEFAULT_HERO = [
  "Made and maintained by a truck driver that still drives",
  "Know how much time you have to spare",
  "Truck legal GPS navigation on this same page. No app required.",
  "It's not expensive",
  "And it's cooler",
];

function fitHeroLine(input) {
  if (!input.isConnected) return;
  input.style.height = "auto";
  const next = input.scrollHeight;
  if (next > 0) input.style.height = `${next}px`;
}

function heroRow(value) {
  const row = document.createElement("div");
  row.className = "hero-edit";
  const input = document.createElement("textarea");
  input.rows = 1;
  input.maxLength = 140;
  input.value = value;
  input.autocomplete = "off";
  input.setAttribute("aria-label", "Hero bullet");
  input.addEventListener("input", () => fitHeroLine(input));
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "hero-remove";
  remove.textContent = "Remove";
  remove.addEventListener("click", () => {
    const box = document.getElementById("heroLines");
    if (box.children.length <= 1) {
      input.value = "";
      fitHeroLine(input);
      input.focus();
      return;
    }
    row.remove();
  });
  row.append(input, remove);
  requestAnimationFrame(() => fitHeroLine(input));
  return row;
}

const OLD_HERO = [
  [
    "Know how much time you have to spare",
    "Truck legal GPS navigation on this same page. No app required.",
    "It's not expensive",
    "And it's cooler",
  ],
  [
    "Know how much time you have to spare",
    "Truck legal GPS navigation on this same page. No app required.",
    "It's not expensive",
    "And it's cooler",
    "Made by a driver that still drives",
  ],
];

function fillHero(lines) {
  const cleaned = (Array.isArray(lines) ? lines : []).map((line) => String(line ?? "").trim()).filter(Boolean);
  const saved = cleaned.join("\n");
  const next = (OLD_HERO.some((set) => set.join("\n") === saved) || !cleaned.length ? DEFAULT_HERO : cleaned).slice(0, HERO_MAX);
  const box = document.getElementById("heroLines");
  box.replaceChildren(...next.map((line) => heroRow(String(line))));
  requestAnimationFrame(() => {
    box.querySelectorAll("textarea").forEach(fitHeroLine);
  });
}

let heroEditorPromise = null;

function loadHeroEditor() {
  if (heroEditorPromise) return heroEditorPromise;
  const box = document.getElementById("hero");
  heroEditorPromise = api("/v1/hero").then((data) => {
    box.hidden = false;
    fillHero(data.lines);
  }).catch((error) => {
    box.hidden = false;
    fillHero(DEFAULT_HERO);
    document.getElementById("heroNote").textContent = error.message || "Could not load the bullets.";
  });
  return heroEditorPromise;
}

function drawGift(gift) {
  const item = document.createElement("li");
  item.textContent = gift.used
    ? `${gift.code} · ${gift.credits} credits · used`
    : `${gift.code} · ${gift.credits} credits`;
  return item;
}

async function loadGifts() {
  const box = document.getElementById("gifts");
  const giftRows = document.getElementById("giftList");
  const data = await api("/v1/admin/gifts");
  box.hidden = false;
  giftRows.replaceChildren(...(Array.isArray(data.gifts) ? data.gifts : []).map(drawGift));
}

try {
  document.getElementById("heroAdd")?.addEventListener("click", () => {
    const box = document.getElementById("heroLines");
    const note = document.getElementById("heroNote");
    if (box.children.length >= HERO_MAX) {
      note.textContent = "Six lines is the most.";
      return;
    }
    const row = heroRow("");
    box.append(row);
    row.querySelector("textarea")?.focus();
    note.textContent = "";
  });
  document.getElementById("heroForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const note = document.getElementById("heroNote");
    const lines = [...document.querySelectorAll("#heroLines textarea")]
      .map((input) => input.value.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(0, HERO_MAX);
    if (!lines.length) {
      note.textContent = "Add at least one line.";
      return;
    }
    note.textContent = "Saving…";
    try {
      const saved = await api("/v1/admin/hero", { method: "POST", body: JSON.stringify({ lines }) });
      fillHero(saved.lines);
      note.textContent = "Saved. Refresh the front page to see them.";
    } catch (error) {
      note.textContent = error.message || "Could not save.";
    }
  });
  await load();
  setInterval(() => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    void loadAccounts(zone);
    void loadVisits(true);
  }, 30000);
  document.getElementById("giftForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const note = document.getElementById("giftNote");
    const credits = Math.round(Number(document.getElementById("giftCredits")?.value));
    note.textContent = "Making the code…";
    try {
      const made = await api("/v1/admin/gifts", { method: "POST", body: JSON.stringify({ credits }) });
      note.textContent = `${made.code} is worth ${made.credits} credits.`;
      await loadGifts();
    } catch (error) {
      note.textContent = error.message || "Could not make a code.";
    }
  });
  const mark = () => pulseActivity();
  document.addEventListener("pointerdown", mark);
  document.addEventListener("keydown", mark);
} catch {
  document.getElementById("hero").hidden = true;
  status.textContent = "This list is only for the owner account. Sign in on the planner as that Google account, then reload.";
}
