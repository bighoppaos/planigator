import {
  DEFAULT_START_MINUTES,
  DEFAULT_END_MINUTES,
  DEFAULT_HOURS_BEFORE_THIRTY,
  DEFAULT_MPH,
  LEGAL_MAX_DRIVE_HOURS,
  hoursLabel,
  durationLabel,
  stamp,
  shortStamp,
  resolvedLeaveAt,
} from "./hos.js";
import {
  newId,
  cardTitle,
  cssRGB,
  stopInk,
  stopColor,
  buildPlan,
  isOriginStop,
  encodeTripShare,
  decodeTripShare,
  truckWeGoUrl,
  planPlainText,
} from "./plan.js";
import { HERE_API_KEY } from "./here-key.js";
import { geocodeAddress, truckRoute, TRUCK_PROFILE } from "./here.js";

const STORAGE = "planigator.web.v1";

let plannerRoot = null;
let writingHash = false;
const $ = (sel) => (plannerRoot || document).querySelector(sel);

function pad(n) {
  return String(n).padStart(2, "0");
}

function toDateTimeLocal(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromDateTimeLocal(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? Date.now() : d.getTime();
}

function minutesToTime(minutes) {
  const mins = Math.max(0, minutes);
  return `${pad(Math.trunc(mins / 60))}:${pad(mins % 60)}`;
}

function timeToMinutes(value) {
  const [h, m] = (value || "00:00").split(":").map((part) => Number(part) || 0);
  return h * 60 + m;
}

function tomorrowWindow() {
  const start = Date.now() + 24 * 3600 * 1000;
  return { start, end: start + 4 * 3600 * 1000 };
}

function defaultStop(overrides = {}) {
  const window = tomorrowWindow();
  return {
    id: newId(),
    name: "",
    address: "",
    miles: "",
    hours: "",
    anytime: false,
    window: false,
    start: window.start,
    end: window.end,
    useCurrentLocation: false,
    ...overrides,
  };
}

function defaultStops() {
  const pickup = defaultStop({ name: "Pickup" });
  const dropStart = pickup.start + 8 * 3600 * 1000;
  return [
    pickup,
    defaultStop({
      name: "Drop",
      start: dropStart,
      end: dropStart + 4 * 3600 * 1000,
    }),
  ];
}

function defaultState() {
  const leave = resolvedLeaveAt({
    leaveNow: false,
    leaveAt: Date.now(),
    now: Date.now(),
    startMinutes: DEFAULT_START_MINUTES,
  });
  return {
    settings: {
      governed: true,
      governedMph: DEFAULT_MPH,
      leaveNow: false,
      leaveAt: leave,
      startMinutes: DEFAULT_START_MINUTES,
      endMinutes: DEFAULT_END_MINUTES,
      endAnytime: false,
      hoursOfEleven: LEGAL_MAX_DRIVE_HOURS,
      hoursBeforeThirty: DEFAULT_HOURS_BEFORE_THIRTY,
      sleepHours: 8,
      readyMinutes: 60,
      military: false,
      kilometers: false,
    },
    stops: defaultStops(),
    tripName: "",
    activeTripId: null,
    plan: null,
    error: "",
    notice: "",
    trips: [],
    origin: null,
    locating: false,
    estimating: false,
    copiedText: "",
  };
}

function loadState() {
  const state = defaultState();
  try {
    const raw = localStorage.getItem(STORAGE);
    if (!raw) return state;
    const saved = JSON.parse(raw);
    state.settings = { ...state.settings, ...(saved.settings || {}) };
    if (Array.isArray(saved.stops) && saved.stops.length) state.stops = saved.stops;
    state.tripName = saved.tripName || "";
    state.activeTripId = saved.activeTripId || null;
    state.trips = Array.isArray(saved.trips) ? saved.trips : [];
    state.origin = saved.origin || null;
  } catch {
    return state;
  }
  return state;
}

const state = loadState();

function persist() {
  localStorage.setItem(STORAGE, JSON.stringify({
    settings: state.settings,
    stops: state.stops,
    tripName: state.tripName,
    activeTripId: state.activeTripId,
    trips: state.trips,
    origin: state.origin,
  }));
}

function destinations() {
  return state.stops.filter((_, index) => !isOriginStop(state.stops, index));
}

function stopLabel(stop) {
  if (stop.useCurrentLocation) return "Current location";
  const name = (stop.name || "").trim();
  const address = (stop.address || "").trim();
  if (address && (!name || name === "Pickup" || name === "Drop" || name === "Start")) return address;
  return name || address || "Stop";
}

function tripLabel() {
  const named = state.tripName.trim();
  if (named) return named;
  return state.stops.map(stopLabel).filter(Boolean).join(" → ");
}

function mph() {
  return state.settings.governed ? Math.max(1, Number(state.settings.governedMph) || DEFAULT_MPH) : DEFAULT_MPH;
}

function formatMiles(miles) {
  if (state.settings.kilometers) return `${(miles * 1.609344).toFixed(1)} km`;
  return `${miles.toFixed(1)} miles`;
}

function formatTime(ms) {
  return state.settings.military ? stamp(ms, true) : stamp(ms, false);
}

function formatShort(ms) {
  return shortStamp(ms, state.settings.military);
}

function leaveAtNow() {
  return resolvedLeaveAt({
    leaveNow: state.settings.leaveNow,
    leaveAt: state.settings.leaveAt,
    now: Date.now(),
    startMinutes: state.settings.startMinutes,
  });
}

function normalizeStop(stop) {
  return {
    ...stop,
    miles: Number(stop.miles) || 0,
    hours: Number(stop.hours) || 0,
  };
}

function shareToken() {
  return encodeTripShare({
    settings: state.settings,
    stops: state.stops,
    tripName: state.tripName,
  });
}

function writeShareHash() {
  const url = new URL(location.href);
  url.hash = `t=${shareToken()}`;
  writingHash = true;
  history.replaceState(null, "", url.pathname + url.search + url.hash);
  queueMicrotask(() => { writingHash = false; });
  return url.toString();
}

function applySharedTrip(data, { notice } = {}) {
  state.settings = { ...state.settings, ...(data.settings || {}) };
  if (Array.isArray(data.stops) && data.stops.length) state.stops = data.stops.map((stop) => ({ ...stop }));
  state.tripName = data.tripName || "";
  state.activeTripId = null;
  state.origin = null;
  state.notice = notice || "Opened a shared trip. Nothing was uploaded.";
  persist();
  calculate({ silent: true, skipHash: true });
}

function applyShareFromLocation() {
  const raw = decodeURIComponent((location.hash || "").replace(/^#/, ""));
  if (!raw.startsWith("t=")) return false;
  try {
    applySharedTrip(decodeTripShare(raw.slice(2)), {
      notice: "Opened a shared trip. Calculate again after you change anything.",
    });
    return true;
  } catch {
    state.error = "That share link could not be read.";
    render();
    return false;
  }
}

function calculate({ silent = false, skipHash = false } = {}) {
  const result = buildPlan({
    stops: state.stops.map(normalizeStop),
    settings: {
      ...state.settings,
      leaveAt: leaveAtNow(),
    },
    now: Date.now(),
  });
  if (result.error) {
    state.plan = silent ? state.plan : null;
    state.error = result.error;
    if (!silent) state.notice = "";
    render();
    persist();
    return;
  }
  state.plan = result;
  state.error = "";
  if (!silent) {
    saveTrip();
    state.notice = "Trip saved in this browser.";
  }
  if (!skipHash) writeShareHash();
  render();
  persist();
}

function saveTrip() {
  if (!state.plan) return;
  const named = state.tripName.trim();
  let id = state.activeTripId;
  const existing = state.trips.find((trip) => trip.id === id);
  const existingName = (existing?.tripName || existing?.name || "").trim();
  if (!existing) {
    id = newId();
  } else if (named && named.toLowerCase() !== existingName.toLowerCase()) {
    id = newId();
  }
  const trip = {
    id,
    name: tripLabel(),
    savedAt: Date.now(),
    settings: { ...state.settings },
    stops: state.stops.map((stop) => ({ ...stop })),
    tripName: named,
    summary: {
      miles: state.plan.miles,
      driveHours: state.plan.driveHours,
      rollAt: state.plan.rollAt,
      arriveAt: state.plan.arriveAt,
    },
  };
  state.trips = [trip, ...state.trips.filter((item) => item.id !== id)].slice(0, 40);
  state.activeTripId = id;
}

function loadTrip(id) {
  const trip = state.trips.find((item) => item.id === id);
  if (!trip) return;
  state.settings = { ...state.settings, ...trip.settings };
  state.stops = trip.stops.map((stop) => ({ ...stop }));
  state.tripName = trip.tripName || trip.name || "";
  state.activeTripId = trip.id;
  state.notice = `Opened ${trip.name}.`;
  calculate({ silent: true });
}

function deleteTrip(id) {
  state.trips = state.trips.filter((trip) => trip.id !== id);
  if (state.activeTripId === id) state.activeTripId = null;
  persist();
  render();
}

function addStop(afterId) {
  const next = defaultStop();
  if (afterId) {
    const index = state.stops.findIndex((stop) => stop.id === afterId);
    const previous = state.stops[index];
    if (previous && !previous.useCurrentLocation) {
      next.start = previous.start + 4 * 3600 * 1000;
      next.end = next.start + 4 * 3600 * 1000;
    }
    state.stops.splice(index + 1, 0, next);
  } else {
    state.stops.push(next);
  }
  persist();
  render();
}

function removeStop(id) {
  const next = state.stops.filter((stop) => stop.id !== id);
  if (next.filter((_, index) => !isOriginStop(next, index)).length < 1) return;
  state.stops = next;
  persist();
  if (state.plan) calculate({ silent: true });
  else render();
}

function moveStop(id, delta) {
  const dest = state.stops.map((stop, i) => i).filter((i) => !state.stops[i].useCurrentLocation);
  const position = dest.findIndex((i) => state.stops[i].id === id);
  const next = position + delta;
  if (position < 0 || next < 0 || next >= dest.length) return;
  const a = dest[position];
  const b = dest[next];
  [state.stops[a], state.stops[b]] = [state.stops[b], state.stops[a]];
  persist();
  if (state.plan) calculate({ silent: true });
  else render();
}

function updateStop(id, patch) {
  const stop = state.stops.find((item) => item.id === id);
  if (!stop) return;
  Object.assign(stop, patch);
  if (patch.window === false) stop.end = stop.start;
  if (patch.anytime === true) stop.window = false;
  persist();
  if (state.plan) calculate({ silent: true });
  else render();
}

function startFromAddress() {
  if (state.stops[0]?.useCurrentLocation) {
    state.stops[0] = defaultStop({
      name: "Start",
      anytime: true,
      start: Date.now(),
      end: Date.now(),
    });
  }
  state.origin = null;
  state.notice = "First stop is the yard or wherever you roll from. Miles on the next stop are from here.";
  persist();
  if (state.plan) calculate({ silent: true });
  else render();
}

function startFromHere() {
  if (!state.stops[0]?.useCurrentLocation) {
    state.stops.unshift(defaultStop({
      useCurrentLocation: true,
      name: "Current location",
      start: Date.now(),
      end: Date.now(),
    }));
    persist();
  }
  locate();
}

function addStartBefore() {
  if (state.stops[0]?.useCurrentLocation) return;
  state.stops.unshift(defaultStop({
    name: "Start",
    anytime: true,
    start: Date.now(),
    end: Date.now(),
  }));
  state.notice = "First card is where you roll from. Pickup below now has miles and a be-there-by.";
  persist();
  render();
}

function newTrip() {
  const trips = state.trips;
  const settings = { ...state.settings };
  Object.assign(state, defaultState());
  state.trips = trips;
  state.settings = settings;
  state.notice = "New trip. Old ones stay in the list below.";
  writingHash = true;
  history.replaceState(null, "", location.pathname + location.search);
  queueMicrotask(() => { writingHash = false; });
  persist();
  render();
}

function locate() {
  if (!window.isSecureContext) {
    state.error = "Location needs HTTPS. Type an address, or open the live site.";
    render();
    return;
  }
  if (!navigator.geolocation) {
    state.error = "This browser cannot share a location. Type an address instead.";
    render();
    return;
  }
  state.locating = true;
  state.error = "";
  state.notice = "The browser will ask this site for your location. Allow it to truck-route from where you are.";
  render();
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      state.origin = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      state.locating = false;
      state.notice = "Got your location. Tap Estimate truck miles when the stops have addresses.";
      persist();
      render();
    },
    (error) => {
      state.locating = false;
      if (error?.code === 1) {
        state.error = "Location was blocked. In the browser, allow Planigator to use your location, or type an address.";
      } else {
        state.error = "Could not get a location. Type an address instead.";
      }
      render();
    },
    { enableHighAccuracy: true, timeout: 12000 }
  );
}

async function estimateMiles() {
  if (!HERE_API_KEY) {
    state.error = "This site is missing a HERE key, so it cannot request a truck route.";
    render();
    return;
  }
  state.estimating = true;
  state.error = "";
  state.notice = "Asking HERE for a truck-legal route…";
  render();
  try {
    const points = [];
    for (const stop of state.stops) {
      if (stop.useCurrentLocation) {
        if (!state.origin) throw new Error("Allow location first, or type miles to the first stop.");
        points.push(state.origin);
        continue;
      }
      const line = (stop.address || stop.name || "").trim();
      if (!line) throw new Error(`Add an address for ${cardTitle(state.stops.indexOf(stop), state.stops)}.`);
      const point = await geocodeAddress(line, HERE_API_KEY);
      stop.lat = point.lat;
      stop.lon = point.lon;
      if (!stop.address) stop.address = point.label;
      points.push(point);
    }
    const departAt = leaveAtNow();
    const speedCapMph = state.settings.governed ? mph() : null;
    for (let i = 1; i < state.stops.length; i += 1) {
      if (!points[i - 1] || !points[i]) continue;
      const leg = await truckRoute(points[i - 1], points[i], HERE_API_KEY, {
        speedCapMph,
        departAt,
      });
      state.stops[i].miles = String(Math.round(leg.miles * 10) / 10);
      state.stops[i].hours = String(Math.round(leg.hours * 100) / 100);
    }
    state.notice = `Filled miles from a HERE truck route (${TRUCK_PROFILE.summary}).`;
    persist();
    calculate({ silent: true });
  } catch (error) {
    state.error = error.message || "Could not estimate truck miles.";
    render();
  } finally {
    state.estimating = false;
    render();
  }
}

function currentShareUrl() {
  if (location.hash.startsWith("#t=")) return location.href;
  return writeShareHash();
}

async function shareTrip() {
  const url = currentShareUrl();
  const title = state.tripName.trim() || "Planigator trip";
  try {
    if (navigator.share) {
      await navigator.share({ title, text: "Open this Planigator trip", url });
      state.notice = "Share sheet opened.";
      render();
      return;
    }
  } catch (error) {
    if (error && error.name === "AbortError") return;
  }
  try {
    await navigator.clipboard.writeText(url);
    state.notice = "Link copied. Anyone with it can open the same trip.";
  } catch {
    state.notice = url;
  }
  render();
}

async function copyPlan() {
  if (!state.plan) {
    state.error = "Calculate the trip first.";
    render();
    return;
  }
  const text = planPlainText({
    tripName: state.tripName,
    stops: state.stops,
    plan: state.plan,
    formatTime,
    formatShort,
    formatMiles,
    hoursLabel,
    durationLabel,
  });
  try {
    await navigator.clipboard.writeText(text);
    state.copiedText = "";
    state.notice = "Plan copied. Paste it into a text.";
  } catch {
    state.copiedText = text;
    state.notice = "Clipboard is blocked here. Copy the plan from the box below.";
  }
  render();
}

function directionsUrl() {
  return truckWeGoUrl(state.stops, state.origin);
}

function chip(event) {
  const ink = stopInk(event.rgb);
  const miles = event.miles != null && event.miles > 0.05 ? formatMiles(event.miles) : "";
  const hours = event.tripHours != null ? hoursLabel(event.tripHours) : "";
  return `
    <div class="chip ${event.kind}" style="background:${cssRGB(event.rgb)};color:${ink.color}">
      <div class="chip-top">
        <strong>${event.timePhrase}</strong>
        <span>${hours}${miles ? ` · ${miles}` : ""}</span>
      </div>
      <div class="chip-time">${formatShort(event.start)}${event.end && event.end !== event.start ? ` → ${formatShort(event.end)}` : ""}</div>
      ${event.arrivalPhrase && event.earliestArrive ? `<div class="chip-arrive ${event.late ? "late" : ""}">${event.arrivalPhrase} ${formatShort(event.earliestArrive)}</div>` : ""}
    </div>
  `;
}

function eventsAround(stopId) {
  const events = state.plan?.events || [];
  const self = events.find((event) => event.id === stopId);
  return {
    before: events.filter((event) => (
      event.stopID === stopId
      && event.id !== stopId
      && event.kind !== "leeway"
      && (!self || event.start < self.start)
    )),
    self,
    after: events.filter((event) => event.kind === "leeway" && event.stopID === stopId && event.after !== -1),
    now: events.filter((event) => event.kind === "leeway" && event.after === -1),
  };
}

function stopCard(stop, index) {
  const dests = destinations();
  const destIndex = dests.findIndex((item) => item.id === stop.id);
  const originStop = isOriginStop(state.stops, index);
  const rgb = stopColor(index, state.stops);
  const ink = stopInk(rgb);
  const around = eventsAround(stop.id);
  const title = cardTitle(index, state.stops);
  const canRemove = !originStop && dests.length > 1;
  return `
    ${destIndex === 0 ? around.now.map(chip).join("") : ""}
    ${around.before.map(chip).join("")}
    <article class="stop-card" style="background:${cssRGB(rgb)};color:${ink.color}" data-stop="${stop.id}">
      ${around.self ? chip(around.self) : ""}
      <div class="stop-head">
        <label>
          <span class="sr">Stop name</span>
          <input class="plain" data-field="name" value="${escapeAttr(stop.name)}" placeholder="${escapeAttr(title)}">
        </label>
        <div class="icon-row">
          <button type="button" class="ghost" data-act="up" ${originStop || destIndex <= 0 ? "disabled" : ""} aria-label="Move stop up">↑</button>
          <button type="button" class="ghost" data-act="down" ${originStop || destIndex >= dests.length - 1 ? "disabled" : ""} aria-label="Move stop down">↓</button>
          <button type="button" class="ghost" data-act="remove" ${canRemove ? "" : "disabled"} aria-label="Remove ${escapeAttr(title)}">−</button>
        </div>
      </div>
      <label>Address
        <input data-field="address" value="${escapeAttr(stop.address)}" placeholder="${escapeAttr(originStop ? "City, state, or street" : `${title} address`)}">
      </label>
      ${originStop ? `<p class="fine">This is where you roll from. Miles on the next stop are from here.</p>` : `
      <div class="pair">
        <label>Miles from previous
          <input data-field="miles" inputmode="decimal" value="${escapeAttr(stop.miles)}" placeholder="0">
        </label>
        <label>Drive hours
          <input data-field="hours" inputmode="decimal" value="${escapeAttr(stop.hours)}" placeholder="from miles">
        </label>
      </div>`}
      ${originStop && (stop.name || "").trim().toLowerCase() !== "start" ? `
        <button type="button" class="add-inline" data-act="start-before">Drive here from somewhere else</button>
      ` : originStop ? "" : `
      <div class="toggles">
        <label class="check"><input type="checkbox" data-field="anytime" ${stop.anytime ? "checked" : ""}> Anytime</label>
        ${stop.anytime ? "" : `
          <label class="check"><input type="checkbox" data-field="window" ${stop.window ? "checked" : ""}> Window</label>
        `}
      </div>
      ${stop.anytime ? "" : `
        ${stop.window ? `<label>Opens<input type="datetime-local" data-field="start" value="${toDateTimeLocal(stop.start)}"></label>` : ""}
        <label>Be there by<input type="datetime-local" data-field="${stop.window ? "end" : "start"}" value="${toDateTimeLocal(stop.window ? stop.end : stop.start)}"></label>
      `}`}
    </article>
    ${around.after.map(chip).join("")}
    ${destIndex >= 0 && destIndex < dests.length - 1 ? `<button type="button" class="add-inline" data-after="${stop.id}">Add a stop after ${escapeAttr(title)}</button>` : ""}
  `;
}

function escapeAttr(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("\"", "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function hosSummary() {
  const s = state.settings;
  const speed = s.governed ? `${s.governedMph || DEFAULT_MPH} mph` : "ungoverned 65";
  const window = s.endAnytime
    ? `${minutesToTime(s.startMinutes)} start`
    : `${minutesToTime(s.startMinutes)}–${minutesToTime(s.endMinutes)}`;
  return `${speed} · ${s.hoursOfEleven} of 11 · 30 after ${s.hoursBeforeThirty} hr · ${window}`;
}

export function initPlanner(el) {
  plannerRoot = el;
  applyShareFromLocation();
  render();
}

function render() {
  const root = plannerRoot || document.getElementById("app");
  if (!root) return;
  const s = state.settings;
  const origin = state.stops.find((stop) => stop.useCurrentLocation);
  const destCards = state.stops
    .map((stop, index) => (stop.useCurrentLocation ? "" : stopCard(stop, index)))
    .join("");
  const plan = state.plan;
  const maps = directionsUrl();
  root.innerHTML = `
    <section class="hero card">
      <p class="eyebrow">Truck trip clock</p>
      <h1>Planigator</h1>
      <p>Type pickup and drop. Get a HERE truck-legal route, leave-by, 30s, 10-hour rests, and bedtime. It stays in this browser. Share the link with anyone — iPhone or Android.</p>
    </section>

    <section class="card hos">
      <details>
        <summary>HOS <span class="muted">${escapeAttr(hosSummary())}</span></summary>
        <div class="row">
          <label class="check"><input type="checkbox" id="governed" ${s.governed ? "checked" : ""}> Governed</label>
          ${s.governed ? `<label class="inline">mph <input id="mph" inputmode="decimal" value="${escapeAttr(s.governedMph)}"></label>` : ""}
        </div>
        <label>Hours I’ll drive out of the 11
          <input id="hoursOfEleven" type="number" min="1" max="11" step="1" value="${s.hoursOfEleven}">
        </label>
        <label>Hours into driving before 30-minute break
          <input id="hoursBeforeThirty" type="number" min="0.5" max="8" step="0.5" value="${s.hoursBeforeThirty}">
        </label>
        <label class="check"><input type="checkbox" id="leaveNow" ${s.leaveNow ? "checked" : ""}> Leave now</label>
        ${s.leaveNow ? "" : `<label>Leave at<input id="leaveAt" type="datetime-local" value="${toDateTimeLocal(s.leaveAt)}"></label>`}
        <label>Start time each day<input id="startTime" type="time" value="${minutesToTime(s.startMinutes)}"></label>
        ${s.endAnytime ? "" : `<label>End time each day<input id="endTime" type="time" value="${minutesToTime(s.endMinutes)}"></label>`}
        <label class="check"><input type="checkbox" id="endAnytime" ${s.endAnytime ? "checked" : ""}> End the day anytime</label>
        <div class="pair">
          <label>Sleep hours<input id="sleepHours" type="number" min="1" max="14" step="0.5" value="${s.sleepHours}"></label>
          <label>Ready minutes<input id="readyMinutes" type="number" min="15" max="180" step="15" value="${s.readyMinutes}"></label>
        </div>
        <div class="row">
          <label class="check"><input type="checkbox" id="military" ${s.military ? "checked" : ""}> Military time</label>
          <label class="check"><input type="checkbox" id="kilometers" ${s.kilometers ? "checked" : ""}> Kilometers</label>
        </div>
      </details>
    </section>

    <section class="card origin">
      <h2>Start</h2>
      <p class="muted">Default is pickup → drop. To route from where you are, tap Use my location and allow this site when the browser asks.</p>
      <p>${origin && state.origin
        ? `Routing from your location ${state.origin.lat.toFixed(4)}, ${state.origin.lon.toFixed(4)}`
        : origin
          ? "Waiting for location. Allow Planigator when the browser asks, or type an address."
          : "First card is where you roll from. Type that city, or use your location."}</p>
      <div class="row">
        <button type="button" class="secondary" id="locate" ${state.locating ? "disabled" : ""}>${state.locating ? "Waiting for permission…" : "Use my location"}</button>
        ${origin ? `<button type="button" class="secondary" id="fromAddress">Start from an address</button>` : ""}
        <button type="button" class="secondary" id="newTrip">New trip</button>
      </div>
    </section>

    <section class="stops">
      ${destCards}
      <button type="button" class="add" id="addStop">Add a stop</button>
    </section>

    <section class="card actions" id="actions">
      <label>Trip name
        <input id="tripName" value="${escapeAttr(state.tripName)}" placeholder="Optional — Dallas to Atlanta">
      </label>
      <div class="row">
        <button type="button" class="primary" id="calculate">Calculate</button>
        <button type="button" class="secondary" id="estimate" ${state.estimating ? "disabled" : ""}>${state.estimating ? "Asking HERE…" : "Estimate truck miles"}</button>
      </div>
      <p class="fine">Estimate truck miles uses HERE truck routing for a ${escapeAttr(TRUCK_PROFILE.summary)}. Truck only — not car, bike, or walk. Or type the miles yourself.</p>
      ${state.error ? `<p class="error">${escapeAttr(state.error)}</p>` : ""}
      ${state.notice ? `<p class="ok">${escapeAttr(state.notice)}</p>` : ""}
    </section>

    ${plan ? `
      <section class="card result">
        <h2>Plan</h2>
        ${plan.late && plan.lastDeadline ? `<p class="error">That is after ${escapeAttr(plan.lastTimedTitle)}’s be-there-by (${formatShort(plan.lastDeadline)}).</p>` : ""}
        <dl>
          <div><dt>In bed by</dt><dd>${formatTime(plan.bedtime)}</dd></div>
          <div><dt>Wake up to get ready</dt><dd>${formatTime(plan.wakeAt)}</dd></div>
          <div><dt>Leave by</dt><dd>${formatTime(plan.rollAt)}</dd></div>
          <div><dt>Arrive</dt><dd>${formatTime(plan.arriveAt)}</dd></div>
          <div><dt>Driving</dt><dd>${hoursLabel(plan.driveHours)} · ${formatMiles(plan.miles)}</dd></div>
          <div><dt>HOS on this path</dt><dd>${plan.breakCount} × 30-min · ${plan.restCount} × 10-hour</dd></div>
        </dl>
        <p class="muted">Total clock including rests: ${durationLabel((plan.arriveAt - plan.rollAt) / 3600 / 1000)}.</p>
        <div class="row">
          <button type="button" class="primary" id="shareTrip">Share trip link</button>
          <button type="button" class="secondary" id="copyPlan">Copy plan text</button>
          ${maps ? `<a class="secondary" id="openMaps" href="${escapeAttr(maps)}" target="_blank" rel="noopener">Open truck directions</a>` : ""}
        </div>
        ${state.copiedText ? `<textarea id="copiedPlan" readonly rows="14">${escapeAttr(state.copiedText)}</textarea>` : ""}
      </section>
    ` : ""}

    <section class="card trips">
      <h2>Trips on this device</h2>
      ${state.trips.length === 0 ? `<p class="muted">Calculate saves the trip here. Clearing site data deletes them. Nothing is uploaded. A share link puts the trip in the URL so the other person does not need your browser.</p>` : ""}
      <ul>
        ${state.trips.map((trip) => `
          <li class="${trip.id === state.activeTripId ? "active" : ""}">
            <button type="button" data-load="${trip.id}">
              <strong>${escapeAttr(trip.name)}</strong>
              <span>${trip.summary ? `${formatMiles(trip.summary.miles)} · leave ${formatShort(trip.summary.rollAt)}` : ""}</span>
            </button>
            <button type="button" class="ghost" data-delete="${trip.id}" aria-label="Delete ${escapeAttr(trip.name)}">Delete</button>
          </li>
        `).join("")}
      </ul>
    </section>
  `;
  bind();
}

function bindSettings() {
  const map = [
    ["governed", (el) => { state.settings.governed = el.checked; }],
    ["mph", (el) => { state.settings.governedMph = Number(el.value) || DEFAULT_MPH; }],
    ["hoursOfEleven", (el) => { state.settings.hoursOfEleven = Math.min(11, Math.max(1, Number(el.value) || 11)); }],
    ["hoursBeforeThirty", (el) => { state.settings.hoursBeforeThirty = Math.min(8, Math.max(0.5, Number(el.value) || 8)); }],
    ["leaveNow", (el) => { state.settings.leaveNow = el.checked; }],
    ["leaveAt", (el) => { state.settings.leaveAt = fromDateTimeLocal(el.value); }],
    ["startTime", (el) => { state.settings.startMinutes = timeToMinutes(el.value); }],
    ["endTime", (el) => { state.settings.endMinutes = timeToMinutes(el.value); }],
    ["endAnytime", (el) => { state.settings.endAnytime = el.checked; }],
    ["sleepHours", (el) => { state.settings.sleepHours = Number(el.value) || 8; }],
    ["readyMinutes", (el) => { state.settings.readyMinutes = Number(el.value) || 60; }],
    ["military", (el) => { state.settings.military = el.checked; }],
    ["kilometers", (el) => { state.settings.kilometers = el.checked; }],
    ["tripName", (el) => { state.tripName = el.value; persist(); }],
  ];
  map.forEach(([id, apply]) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("change", () => {
      apply(el);
      persist();
      if (id === "tripName") return;
      if (state.plan) calculate({ silent: true });
      else render();
    });
    if (el.type !== "checkbox") {
      el.addEventListener("input", () => {
        apply(el);
        persist();
      });
    }
  });
}

function bind() {
  bindSettings();
  $("#calculate")?.addEventListener("click", () => calculate());
  $("#estimate")?.addEventListener("click", () => estimateMiles());
  $("#shareTrip")?.addEventListener("click", () => shareTrip());
  $("#copyPlan")?.addEventListener("click", () => copyPlan());
  $("#locate")?.addEventListener("click", () => (
    state.stops[0]?.useCurrentLocation ? locate() : startFromHere()
  ));
  $("#fromAddress")?.addEventListener("click", () => startFromAddress());
  $("#newTrip")?.addEventListener("click", () => newTrip());
  $("#addStop")?.addEventListener("click", () => addStop());
  document.querySelectorAll("[data-load]").forEach((button) => {
    button.addEventListener("click", () => loadTrip(button.getAttribute("data-load")));
  });
  document.querySelectorAll("[data-delete]").forEach((button) => {
    button.addEventListener("click", () => deleteTrip(button.getAttribute("data-delete")));
  });
  document.querySelectorAll(".stop-card").forEach((card) => {
    const id = card.getAttribute("data-stop");
    card.querySelectorAll("[data-field]").forEach((input) => {
      const field = input.getAttribute("data-field");
      const apply = () => {
        let value = input.type === "checkbox" ? input.checked : input.value;
        if (field === "start" || field === "end") value = fromDateTimeLocal(input.value);
        const patch = { [field]: value };
        if (field === "start" && !state.stops.find((stop) => stop.id === id)?.window) {
          patch.end = value;
        }
        updateStop(id, patch);
      };
      input.addEventListener("change", apply);
      if (input.type !== "checkbox" && input.type !== "datetime-local") {
        input.addEventListener("input", () => {
          const stop = state.stops.find((item) => item.id === id);
          if (!stop) return;
          stop[field] = input.value;
          persist();
        });
      }
    });
    card.querySelector("[data-act=up]")?.addEventListener("click", () => moveStop(id, -1));
    card.querySelector("[data-act=down]")?.addEventListener("click", () => moveStop(id, 1));
    card.querySelector("[data-act=remove]")?.addEventListener("click", () => removeStop(id));
    card.querySelector("[data-act=start-before]")?.addEventListener("click", () => addStartBefore());
  });
  document.querySelectorAll("[data-after]").forEach((button) => {
    button.addEventListener("click", () => addStop(button.getAttribute("data-after")));
  });
}

if (document.body.classList.contains("planner-only")) {
  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1")) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
  window.addEventListener("hashchange", () => {
    if (writingHash) return;
    applyShareFromLocation();
  });
  initPlanner(document.getElementById("app"));
}
