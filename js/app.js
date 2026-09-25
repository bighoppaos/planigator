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
} from "./hos.js?v=128";
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
  planPlainText,
} from "./plan.js?v=134";
import { TRUCK_PROFILE } from "./here.js";
import { EXAMPLE_TRIP } from "./example-trip.js?v=3";
import { creditsMe, fetchCalls, suggestAddresses, truckRoute, whereCity, spotAddress, nextTruckStop, startCheckout, startCardSetup, loginWith, fetchTrips, putTrips, createShare, fetchShare, clearSession, logoutRemote, pulseActivity, clearCardWelcome, clearPackWelcome, removeSavedCard, saveBoxFont, noteVisit, redeemGift } from "./api.js";

const STORAGE = "planigator.web.v1";

let plannerRoot = null;
let writingHash = false;
let boxFontTimer = 0;
let boxFontDirty = false;
const lookupOpen = new Set();
const usingDismissed = new Set();
const usingTimers = new Map();
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
  return [defaultStop({ name: "Stop 1" })];
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
      startAnytime: false,
      endAnytime: false,
      hoursOfEleven: LEGAL_MAX_DRIVE_HOURS,
      hoursBeforeThirty: DEFAULT_HOURS_BEFORE_THIRTY,
      military: false,
      kilometers: false,
      arrival: "earliest",
      routeMode: "fast",
    },
    stops: defaultStops(),
    tripName: "",
    activeTripId: null,
    plan: null,
    error: "",
    notice: "",
    picker: "",
    pickerTarget: null,
    confirmRemoveId: null,
    confirmDeleteId: null,
    speedNote: "",
    boxFont: 13,
    darkMode: false,
    signupNote: "",
    idleNote: "",
    locationError: "",
    locationNotice: "",
    chooseStart: false,
    arrivalBusy: false,
    lookupMessage: "",
    lookupStopId: "",
    lookupOk: false,
    openLookupStopId: "",
    trips: [],
    origin: null,
    locating: false,
    estimating: false,
    looking: "",
    buying: false,
    savingCard: false,
    credits: null,
    calls: [],
    signedIn: false,
    unlimited: false,
    email: "",
    emailRevealed: false,
    checkoutReady: false,
    googleClientId: "",
    cardOnFile: false,
    cardBrand: "",
    cardLast4: "",
    cardNote: "",
    cardGrantUsed: false,
    cardSavedNote: false,
    packPriceCents: 149,
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
    delete state.settings.sleepHours;
    delete state.settings.readyMinutes;
    state.origin = saved.origin || null;
    if (Array.isArray(saved.stops) && saved.stops.length) state.stops = saved.stops;
    const gps = state.stops.find((stop) => stop.useCurrentLocation);
    if (!state.origin && gps && Number.isFinite(Number(gps.lat)) && Number.isFinite(Number(gps.lon))) {
      state.origin = { lat: Number(gps.lat), lon: Number(gps.lon) };
    }
    if (state.stops[0]?.useCurrentLocation && !state.origin) state.stops.shift();
    state.tripName = saved.tripName || "";
    state.activeTripId = saved.activeTripId || null;
    state.trips = Array.isArray(saved.trips) ? saved.trips : [];
    if (saved.plan && Array.isArray(saved.plan.events)) state.plan = saved.plan;
    const boxFont = Number(saved.boxFont);
    if (boxFont >= 13 && boxFont <= 28) state.boxFont = Math.round(boxFont);
    state.darkMode = saved.darkMode === true;
  } catch {
    return state;
  }
  return state;
}

const state = loadState();
applyDarkMode();
settleLoadedStops(state.stops);

function settleLoadedStops(stops) {
  for (const stop of stops || []) {
    if (!stop?.id || stop.useCurrentLocation) continue;
    if (!Number.isFinite(Number(stop.lat)) || !Number.isFinite(Number(stop.lon))) continue;
    usingDismissed.add(stop.id);
    const timer = usingTimers.get(stop.id);
    if (timer) window.clearTimeout(timer);
    usingTimers.delete(stop.id);
  }
}

function settingsForSave() {
  const settings = { ...state.settings };
  delete settings.sleepHours;
  delete settings.readyMinutes;
  return settings;
}

let tripSettingsTimer = null;

function saveActiveTripSettings() {
  const trip = state.trips.find((item) => item.id === state.activeTripId);
  if (!trip || !state.plan) return;
  trip.settings = settingsForSave();
  trip.savedAt = Date.now();
  trip.pendingUpload = true;
  persist();
  if (!state.signedIn) return;
  clearTimeout(tripSettingsTimer);
  tripSettingsTimer = setTimeout(async () => {
    try {
      await putTrips(state.trips);
      markTripsUploaded();
      persist();
    } catch {
      // The trip still has the new settings on this device.
    }
  }, 400);
}

function applyDarkMode() {
  document.documentElement.classList.toggle("force-dark", state.darkMode === true);
}

function toggleDarkMode() {
  state.darkMode = state.darkMode !== true;
  applyDarkMode();
  const button = document.getElementById("darkMode");
  if (button) button.classList.toggle("on", state.darkMode);
  persist();
}

function persist() {
  localStorage.setItem(STORAGE, JSON.stringify({
    settings: settingsForSave(),
    stops: state.stops,
    tripName: state.tripName,
    activeTripId: state.activeTripId,
    trips: state.trips,
    origin: state.origin,
    plan: slimPlan(state.plan),
    boxFont: state.boxFont,
    darkMode: state.darkMode === true,
  }));
}

function slimPlan(plan) {
  if (!plan || !Array.isArray(plan.events)) return null;
  return {
    events: plan.events,
    rollAt: plan.rollAt,
    arriveAt: plan.arriveAt,
    late: Boolean(plan.late),
    lastTimedTitle: plan.lastTimedTitle || "",
    lastDeadline: plan.lastDeadline || null,
    breakCount: plan.breakCount || 0,
    restCount: plan.restCount || 0,
    driveHours: plan.driveHours || 0,
    miles: plan.miles || 0,
  };
}

function originPoint() {
  if (state.origin && Number.isFinite(Number(state.origin.lat)) && Number.isFinite(Number(state.origin.lon))) {
    return { lat: Number(state.origin.lat), lon: Number(state.origin.lon) };
  }
  const stop = state.stops.find((item) => item.useCurrentLocation);
  if (stop && Number.isFinite(Number(stop.lat)) && Number.isFinite(Number(stop.lon))) {
    return { lat: Number(stop.lat), lon: Number(stop.lon) };
  }
  return null;
}

function rememberOrigin() {
  const point = originPoint();
  if (!point) return null;
  state.origin = point;
  const stop = state.stops.find((item) => item.useCurrentLocation);
  if (stop) {
    stop.lat = point.lat;
    stop.lon = point.lon;
  }
  return point;
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
  return stamp(ms, state.settings.military);
}

function formatShort(ms) {
  return shortStamp(ms, state.settings.military);
}

function formatClockMinutes(minutes) {
  const mins = Math.max(0, Number(minutes) || 0);
  const hour = Math.trunc(mins / 60);
  const minute = mins % 60;
  if (state.settings.military) return `${pad(hour)}:${pad(minute)}`;
  const suffix = hour >= 12 ? "PM" : "AM";
  return `${hour % 12 || 12}:${pad(minute)} ${suffix}`;
}

function clockFields(minutes, disabled = false) {
  const military = state.settings.military;
  const hour24 = Math.trunc(Math.max(0, minutes) / 60) % 24;
  const minute = Math.max(0, minutes) % 60;
  const hour = military ? hour24 : (hour24 % 12 || 12);
  const ap = hour24 >= 12 ? "PM" : "AM";
  const dis = disabled ? " disabled" : "";
  const hours = military
    ? Array.from({ length: 24 }, (_, i) => i)
    : Array.from({ length: 12 }, (_, i) => i + 1);
  const hourOptions = hours.map((value) => {
    const label = military ? pad(value) : String(value);
    return `<option value="${value}"${value === hour ? " selected" : ""}>${label}</option>`;
  }).join("");
  const minuteOptions = Array.from({ length: 60 }, (_, value) => (
    `<option value="${value}"${value === minute ? " selected" : ""}>${pad(value)}</option>`
  )).join("");
  const ampm = military ? "" : `
    <select data-part="ampm" aria-label="AM or PM"${dis}>
      <option value="AM"${ap === "AM" ? " selected" : ""}>AM</option>
      <option value="PM"${ap === "PM" ? " selected" : ""}>PM</option>
    </select>`;
  return `
    <select data-part="hour" aria-label="Hour"${dis}>${hourOptions}</select>
    <select data-part="minute" aria-label="Minute"${dis}>${minuteOptions}</select>
    ${ampm}`;
}

function whenBox(stop, field, ms) {
  return `<button type="button" class="flag-box" data-stop-when="${escapeAttr(stop.id)}" data-stop-field="${field}">${escapeAttr(formatShort(ms))}</button>`;
}

function whenRow(label, stop, field, ms) {
  const windowWhen = label === "Opens" || label === "Closes" ? " window-when" : "";
  return `<div class="when-row${windowWhen}"><span class="flag-box">${escapeAttr(label)}</span><span class="when-arrow" aria-hidden="true"></span>${whenBox(stop, field, ms)}</div>`;
}

function dateChip({ id = "", field = "", ms, disabled = false }) {
  const d = new Date(ms);
  const dateValue = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const minutes = d.getHours() * 60 + d.getMinutes();
  const key = id || field || "when";
  return `<span class="when" data-when="${key}" ${field ? `data-stop-field="${field}"` : ""}>
    <input type="date" data-part="date" value="${dateValue}" aria-label="Date"${disabled ? " disabled" : ""}>
    <span class="time-picks">${clockFields(minutes, disabled)}</span>
  </span>`;
}

function timeChip(id, minutes) {
  return `<span class="time-picks" data-clock="${id}">${clockFields(minutes)}</span>`;
}

function pointReady(stop) {
  if (stop.useCurrentLocation) return Boolean(state.origin);
  return Number.isFinite(Number(stop.lat)) && Number.isFinite(Number(stop.lon));
}

function markGovernedStale() {
  if (!state.plan) return;
  state.speedNote = "Recalculate to update the HERE miles for this governed speed.";
}

function calculateButtonLabel() {
  if (state.estimating) return "Asking HERE<sup>©</sup>…";
  const count = Math.max(0, state.stops.length - 1);
  const use = count > 0 ? `${count} credit${count === 1 ? "" : "s"}` : "";
  const left = state.unlimited
    ? "unlimited credits left"
    : (state.signedIn || state.cardOnFile) && state.credits != null
      ? `${state.credits} left`
      : "";
  return [state.plan ? "Recalculate" : "Calculate", use, left].filter(Boolean).join(" · ");
}

const HOS_ELEVEN = Array.from({ length: 11 }, (_, i) => i + 1);
const HOS_THIRTY = Array.from({ length: 16 }, (_, i) => (i + 1) / 2);
const MPH_CHOICES = Array.from({ length: 21 }, (_, i) => 55 + i);

function thirtyLabel(value) {
  const n = Number(value);
  return Math.abs(n - Math.round(n)) < 0.05 ? String(Math.round(n)) : n.toFixed(1);
}

function settingToggle(id, label, on) {
  return `<button type="button" class="set-box${on ? " on" : ""}" data-toggle="${id}">${escapeAttr(label)}</button>`;
}

function settingValue(id, label, value, fill = false) {
  return `<button type="button" class="set-box${fill ? " set-fill" : ""}" data-pick="${id}"><span class="set-name">${escapeAttr(label)}</span><strong class="set-value">${escapeAttr(value)}</strong></button>`;
}

function wheelChip(id, value, values, labelFn = String) {
  const options = values.map((item) => {
    const selected = Number(item) === Number(value) ? " selected" : "";
    return `<option value="${item}"${selected}>${labelFn(item)}</option>`;
  }).join("");
  return `<span class="wheel-chip"><span class="wheel-chip-text">${escapeAttr(labelFn(value))}</span><select id="${id}">${options}</select></span>`;
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
  state.origin = data.origin || null;
  const gps = state.stops.find((stop) => stop.useCurrentLocation);
  if (!state.origin && gps && Number.isFinite(Number(gps.lat)) && Number.isFinite(Number(gps.lon))) {
    state.origin = { lat: Number(gps.lat), lon: Number(gps.lon) };
  }
  state.plan = data.plan && Array.isArray(data.plan.events) ? data.plan : null;
  state.notice = notice || "This trip was shared with you.";
  settleLoadedStops(state.stops);
  persist();
  if (!state.plan) calculate({ silent: true, skipHash: true });
  else render();
}

async function loadSharedCode(code) {
  try {
    applySharedTrip(await fetchShare(code), {
      notice: "This trip was shared with you.",
    });
  } catch (error) {
    state.error = error.message || "That share link could not be opened.";
    render();
  }
}

function hasRouteLine(stops) {
  return (stops || []).some((stop) => Array.isArray(stop.path) && stop.path.length > 1);
}

function shareTokenFor(trip) {
  return encodeTripShare({
    settings: trip?.settings || {},
    stops: trip?.stops || [],
    tripName: trip?.tripName || "",
  });
}

function copyRouteLine(onto, fromStops) {
  if (!Array.isArray(onto) || !hasRouteLine(fromStops)) return onto;
  return onto.map((stop, index) => {
    if (hasRouteLine([stop])) return stop;
    const from = fromStops.find((item) => item.id === stop.id) || fromStops[index];
    if (!from?.path) return stop;
    return { ...stop, path: from.path };
  });
}

function applyShareFromLocation() {
  const raw = decodeURIComponent((location.hash || "").replace(/^#/, ""));
  if (!raw.startsWith("t=")) return false;
  const token = raw.slice(2);
  let shared;
  try {
    shared = decodeTripShare(token);
  } catch {
    state.error = "That share link could not be read.";
    render();
    return false;
  }
  const saved = state.trips.find((trip) => {
    try { return shareTokenFor(trip) === token; } catch { return false; }
  });
  if (saved && (saved.plan || hasRouteLine(saved.stops))) {
    if (state.activeTripId !== saved.id || !hasRouteLine(state.stops)) loadTrip(saved.id);
    return true;
  }
  if (state.plan && state.activeTripId && shareToken() === token) return false;
  applySharedTrip(shared, {
    notice: "This trip was shared with you. Calculate again after you change anything.",
  });
  return true;
}

function needsStartChoice() {
  if (state.stops.some((stop) => stop.useCurrentLocation)) return false;
  const places = state.stops.filter((stop) => !stop.useCurrentLocation);
  if (places.length >= 2) return false;
  return (places[0]?.name || "").trim().toLowerCase() !== "start";
}

async function calculate({ silent = false, skipHash = false } = {}) {
  if (!silent && needsStartChoice()) {
    state.chooseStart = true;
    state.error = "";
    state.notice = "";
    render();
    return;
  }
  state.chooseStart = false;
  if (!silent && !state.unlimited && state.credits === 0) {
    state.error = state.cardOnFile
      ? "You are out of credits. Buy a pack of 124. The card on file is not charged."
      : state.signedIn
        ? "Those 40 free credits are used. Save a card for 40 more. That card is not charged when they run out."
        : "Sign in with Google for 40 free credits. Save a card for 40 more. That card is not charged when they run out.";
    render();
    return;
  }
  if (!silent) {
    state.estimating = true;
    state.error = "";
    state.notice = "Asking HERE© for a truck-legal route…";
    render();
    try {
      await fillHereLegs();
    } catch (error) {
      if (error.credits != null) state.credits = error.credits;
      state.error = error.message || "Could not get a HERE© truck route.";
      state.estimating = false;
      render();
      return;
    }
    state.estimating = false;
    rememberOrigin();
  }
  const result = buildPlan({
    stops: state.stops.map(normalizeStop),
    settings: {
      ...state.settings,
      leaveAt: leaveAtNow(),
    },
    now: Date.now(),
  });
  if (result.error) {
    state.arrivalBusy = false;
    state.plan = silent ? state.plan : null;
    state.error = result.error;
    if (!silent) state.notice = "";
    render();
    persist();
    return;
  }
  state.plan = result;
  state.error = "";
  state.arrivalBusy = false;
  if (!silent) state.speedNote = "";
  if (!skipHash && state.signedIn) {
    saveTrip();
    if (silent) {
      render();
      persist();
      putTrips(state.trips).then(() => {
        markTripsUploaded();
        persist();
      }).catch(() => {});
      return;
    }
    try {
      await putTrips(state.trips);
      markTripsUploaded();
      if (!silent) state.notice = `HERE© truck route (${TRUCK_PROFILE.summary}). Trip saved to your account.`;
    } catch (error) {
      if (!silent) state.notice = error.message || "Saved on this device. The account copy did not update.";
    }
  } else if (!silent) {
    state.notice = `HERE© truck route (${TRUCK_PROFILE.summary}).`;
  }
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
    origin: originPoint(),
    plan: slimPlan(state.plan),
    summary: {
      miles: state.plan.miles,
      driveHours: state.plan.driveHours,
      rollAt: state.plan.rollAt,
      arriveAt: state.plan.arriveAt,
    },
    pendingUpload: true,
  };
  state.trips = [trip, ...state.trips.filter((item) => item.id !== id)].slice(0, 40);
  state.activeTripId = id;
}

function loadTrip(id) {
  const trip = state.trips.find((item) => item.id === id);
  if (!trip) return;
  state.settings = { ...state.settings, ...(trip.settings || {}) };
  delete state.settings.sleepHours;
  delete state.settings.readyMinutes;
  state.stops = trip.stops.map((stop) => ({ ...stop }));
  state.tripName = trip.tripName || trip.name || "";
  state.activeTripId = trip.id;
  state.origin = trip.origin || null;
  const gps = state.stops.find((stop) => stop.useCurrentLocation);
  if (!state.origin && gps && Number.isFinite(Number(gps.lat)) && Number.isFinite(Number(gps.lon))) {
    state.origin = { lat: Number(gps.lat), lon: Number(gps.lon) };
  }
  state.plan = trip.plan && Array.isArray(trip.plan.events) ? trip.plan : null;
  state.notice = `Opened ${trip.name}.`;
  settleLoadedStops(state.stops);
  if (!state.plan) calculate({ silent: true, skipHash: true });
  else {
    render();
    persist();
  }
}

function exampleWeeksAhead(now = Date.now()) {
  const anchor = new Date(2026, 8, 24);
  anchor.setHours(0, 0, 0, 0);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  if (today < anchor) return 0;
  const days = Math.round((today.getTime() - anchor.getTime()) / 86400000);
  return Math.floor(days / 7) + 1;
}

function addLocalDays(ms, days) {
  const date = new Date(ms);
  date.setDate(date.getDate() + days);
  return date.getTime();
}

const EXAMPLE_STAMP_KEYS = new Set(["leaveAt", "start", "end", "rollAt", "arriveAt", "earliestArrive"]);

function shiftExampleStamps(value, days) {
  if (!days) return value;
  if (Array.isArray(value)) return value.map((item) => shiftExampleStamps(item, days));
  if (!value || typeof value !== "object") return value;
  const copy = {};
  for (const [key, item] of Object.entries(value)) {
    const stamp = Number(item);
    if (EXAMPLE_STAMP_KEYS.has(key) && Number.isFinite(stamp) && stamp > 1e11) copy[key] = addLocalDays(stamp, days);
    else copy[key] = shiftExampleStamps(item, days);
  }
  return copy;
}

function storedExampleWeek(stops) {
  const base = (EXAMPLE_TRIP.stops || []).find((stop) => !stop.useCurrentLocation);
  const live = (stops || []).find((stop) => !stop.useCurrentLocation);
  if (!base || !live) return null;
  const delta = Math.round((Number(live.start) - Number(base.start)) / 86400000);
  if (!Number.isFinite(delta) || delta < 0 || delta % 7 !== 0) return null;
  return delta / 7;
}

function exampleStillStock() {
  if (state.activeTripId) return false;
  const baseStops = EXAMPLE_TRIP.stops || [];
  if (state.stops.length !== baseStops.length) return false;
  return baseStops.every((stop, index) => state.stops[index]?.id === stop.id);
}

function rollOpenExample() {
  if (!exampleStillStock()) return;
  const stored = storedExampleWeek(state.stops);
  if (stored != null && stored < exampleWeeksAhead()) {
    loadExample();
    return;
  }
  calculate({ silent: true, skipHash: true });
}

function loadExample() {
  const trip = shiftExampleStamps(JSON.parse(JSON.stringify(EXAMPLE_TRIP)), exampleWeeksAhead() * 7);
  state.settings = { ...state.settings, ...(trip.settings || {}) };
  delete state.settings.sleepHours;
  delete state.settings.readyMinutes;
  state.stops = Array.isArray(trip.stops) ? trip.stops : [];
  state.tripName = trip.tripName || trip.name || "";
  state.activeTripId = null;
  state.origin = trip.origin || null;
  const gps = state.stops.find((stop) => stop.useCurrentLocation);
  if (!state.origin && gps && Number.isFinite(Number(gps.lat)) && Number.isFinite(Number(gps.lon))) {
    state.origin = { lat: Number(gps.lat), lon: Number(gps.lon) };
  }
  state.plan = trip.plan && Array.isArray(trip.plan.events) ? trip.plan : null;
  state.speedNote = "";
  state.error = "";
  state.notice = `Opened ${trip.name}.`;
  settleLoadedStops(state.stops);
  calculate({ silent: true, skipHash: true });
}

async function deleteTrip(id) {
  state.trips = state.trips.filter((trip) => trip.id !== id);
  if (state.activeTripId === id) state.activeTripId = null;
  persist();
  if (state.signedIn) {
    try {
      await putTrips(state.trips);
      markTripsUploaded();
      persist();
    } catch (error) {
      state.error = error.message || "Removed here. The account copy did not update.";
    }
  }
  render();
}

function markTripsUploaded() {
  state.trips = state.trips.map((trip) => ({ ...trip, pendingUpload: false }));
}

async function pullAccountTrips() {
  if (!state.signedIn) {
    const kept = state.trips.filter((trip) => trip && !trip.pendingUpload);
    if (kept.length !== state.trips.length) {
      state.trips = kept;
      if (state.activeTripId && !state.trips.some((trip) => trip.id === state.activeTripId)) state.activeTripId = null;
      persist();
    }
    return;
  }
  try {
    const data = await fetchTrips();
    const remote = Array.isArray(data.trips) ? data.trips : [];
    const byId = new Map();
    for (const trip of remote) {
      if (!trip?.id) continue;
      const local = state.trips.find((item) => item.id === trip.id);
      if (local && (local.savedAt || 0) > (trip.savedAt || 0)) byId.set(trip.id, { ...local, pendingUpload: true });
      else {
        const kept = { ...trip, pendingUpload: false };
        kept.stops = copyRouteLine(kept.stops, local?.stops);
        byId.set(trip.id, kept);
      }
    }
    state.trips = [...byId.values()].sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0)).slice(0, 40);
    if (state.activeTripId && !byId.has(state.activeTripId)) state.activeTripId = null;
    const donor = state.trips.find((trip) => trip.id === state.activeTripId) || state.trips.find((trip) => hasRouteLine(trip.stops));
    if (donor && !hasRouteLine(state.stops)) {
      state.stops = copyRouteLine(state.stops, donor.stops);
      if (!state.activeTripId) state.activeTripId = donor.id;
    }
    persist();
    if (state.trips.some((trip) => trip.pendingUpload)) {
      await putTrips(state.trips);
      markTripsUploaded();
      persist();
    }
  } catch {
    // Keep the trips already on this device.
  }
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

function stopCanRemove(index) {
  if (isOriginStop(state.stops, index)) return false;
  const addressCount = state.stops.filter((stop) => !stop.useCurrentLocation).length;
  return addressCount > 1 || state.stops.some((stop) => stop.useCurrentLocation);
}

function removeStop(id) {
  const index = state.stops.findIndex((stop) => stop.id === id);
  if (index < 0 || !stopCanRemove(index)) return;
  const next = state.stops.filter((stop) => stop.id !== id);
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
  if ("address" in patch) {
    const typed = String(patch.address || "").trim();
    if (typed !== (stop.verifiedLabel || "")) {
      lookupOpen.add(id);
      clearUsingNote(id);
      stop.miles = "";
      stop.hours = "";
      stop.verifiedLabel = "";
      stop.suggestions = [];
      delete stop.lat;
      delete stop.lon;
    }
    const index = state.stops.findIndex((item) => item.id === id);
    const next = state.stops[index + 1];
    if (next) {
      next.miles = "";
      next.hours = "";
    }
    state.plan = null;
    persist();
    render();
    return;
  }
  persist();
  if (state.plan) calculate({ silent: true });
  else render();
}

function startFromAddress() {
  state.chooseStart = false;
  state.origin = null;
  state.locationError = "";
  state.locationNotice = "";
  if (state.stops[0]?.useCurrentLocation) {
    state.stops[0] = defaultStop({
      name: "Start",
      anytime: true,
      start: Date.now(),
      end: Date.now(),
    });
  } else if ((state.stops[0]?.name || "").trim().toLowerCase() !== "start") {
    state.stops.unshift(defaultStop({
      name: "Start",
      anytime: true,
      start: Date.now(),
      end: Date.now(),
    }));
  }
  state.notice = "";
  persist();
  render();
}

function addStartBefore() {
  if (state.stops[0]?.useCurrentLocation) return;
  state.stops.unshift(defaultStop({
    name: "Start",
    anytime: true,
    start: Date.now(),
    end: Date.now(),
  }));
  state.notice = "";
  persist();
  render();
}

function resetEditor() {
  const keep = {
    settings: { ...state.settings },
    credits: state.credits,
    calls: state.calls,
    signedIn: state.signedIn,
    unlimited: state.unlimited,
    email: state.email,
    checkoutReady: state.checkoutReady,
    googleClientId: state.googleClientId,
    cardOnFile: state.cardOnFile,
    cardBrand: state.cardBrand,
    cardLast4: state.cardLast4,
    cardNote: state.cardNote,
    cardGrantUsed: state.cardGrantUsed,
    cardSavedNote: state.cardSavedNote,
    savingCard: state.savingCard,
    buying: state.buying,
    packPriceCents: state.packPriceCents,
    notice: state.notice,
    boxFont: state.boxFont,
  };
  Object.assign(state, defaultState());
  Object.assign(state, keep);
  writingHash = true;
  history.replaceState(null, "", location.pathname + location.search);
  queueMicrotask(() => { writingHash = false; });
}

function newTrip() {
  const keep = {
    trips: state.trips,
    settings: { ...state.settings },
    credits: state.credits,
    calls: state.calls,
    signedIn: state.signedIn,
    unlimited: state.unlimited,
    email: state.email,
    checkoutReady: state.checkoutReady,
    googleClientId: state.googleClientId,
    cardOnFile: state.cardOnFile,
    cardBrand: state.cardBrand,
    cardLast4: state.cardLast4,
    cardNote: state.cardNote,
    cardGrantUsed: state.cardGrantUsed,
    cardSavedNote: state.cardSavedNote,
    savingCard: state.savingCard,
    packPriceCents: state.packPriceCents,
    boxFont: state.boxFont,
  };
  Object.assign(state, defaultState());
  Object.assign(state, keep);
  state.notice = "";
  lookupOpen.clear();
  writingHash = true;
  history.replaceState(null, "", location.pathname + location.search);
  queueMicrotask(() => { writingHash = false; });
  persist();
  render();
}

const LOCATE_PRECISE = { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 };
const LOCATE_COARSE = { enableHighAccuracy: false, timeout: 20000, maximumAge: 120000 };

let locateWatchId = null;
let locateWatchTimer = null;
let locateAnswerTimer = null;
// Raised when a tap starts, and again when that tap finishes. A reply from
// getCurrentPosition cannot be cancelled, so a late one must not fail or
// restart a newer tap.
let locateAttempt = 0;

function endLocateWatch() {
  if (locateWatchId !== null) {
    navigator.geolocation.clearWatch(locateWatchId);
    locateWatchId = null;
  }
  if (locateWatchTimer !== null) {
    clearTimeout(locateWatchTimer);
    locateWatchTimer = null;
  }
  if (locateAnswerTimer !== null) {
    clearTimeout(locateAnswerTimer);
    locateAnswerTimer = null;
  }
}

function locateMessage(code) {
  if (code === 1) {
    return "Location is turned off for this site. Allow it for Planigator, then tap again. On iPhone check Settings, Privacy & Security, Location Services, Safari Websites.";
  }
  if (code === 2) {
    return "This page did not get a position (error 2). Tap Start from my location again, or type an address.";
  }
  if (code === 3) {
    return "Location took too long (error 3). Tap Start from my location again, or type an address.";
  }
  if (code === 4) {
    return "No answer to the location prompt. Tap Start from my location again and choose Allow, or type an address.";
  }
  return "This page did not get a location. Tap Start from my location again, or type an address.";
}

function dropAddressStart() {
  const first = state.stops[0];
  if (!first || first.useCurrentLocation) return false;
  if ((first.name || "").trim().toLowerCase() !== "start") return false;
  state.stops.shift();
  persist();
  return true;
}

function movedEnough(origin, coords) {
  if (!origin) return false;
  const dlat = coords.latitude - origin.lat;
  const dlon = coords.longitude - origin.lon;
  return Math.hypot(dlat, dlon) > 0.00015;
}

function locateSucceeded(pos, attempt) {
  if (attempt !== locateAttempt) return;
  locateAttempt += 1;
  endLocateWatch();
  dropAddressStart();
  const hadOrigin = Boolean(state.origin);
  const moved = movedEnough(state.origin, pos.coords);
  state.origin = { lat: pos.coords.latitude, lon: pos.coords.longitude };
  const heading = pos.coords.heading;
  if (typeof heading === "number" && Number.isFinite(heading) && heading >= 0) state.origin.heading = heading;
  if (!state.stops[0]?.useCurrentLocation) {
    state.stops.unshift(defaultStop({
      useCurrentLocation: true,
      name: "Current location",
      start: Date.now(),
      end: Date.now(),
    }));
  }
  rememberOrigin();
  state.locating = false;
  state.locationError = "";
  state.locationNotice = !hadOrigin
    ? ""
    : moved
      ? (state.plan ? "Location updated. Calculate again to move the route line." : "Location updated.")
      : "That's still the latest location.";
  persist();
  render();
}

function locateFailed(error, attempt) {
  if (attempt !== locateAttempt) return;
  locateAttempt += 1;
  endLocateWatch();
  state.locating = false;
  state.locationNotice = "";
  if (state.stops[0]?.useCurrentLocation && !state.origin) state.stops.shift();
  state.locationError = locateMessage(error?.code);
  render();
}

// WebKit answers a cold first ask with error 2 or 3 while Core Location is still
// warming up. A watch started after that error keeps the same granted permission
// and picks up the fix when it lands. A denial is final, so it is not retried.
function locateRetry(firstError, attempt) {
  if (attempt !== locateAttempt) return;
  if (firstError?.code === 1 || locateWatchId !== null) {
    locateFailed(firstError, attempt);
    return;
  }
  clearTimeout(locateAnswerTimer);
  locateAnswerTimer = null;
  showLocateProgress("Still looking…", "Still looking…");
  locateWatchId = navigator.geolocation.watchPosition(
    (pos) => locateSucceeded(pos, attempt),
    (watchError) => { if (watchError?.code === 1) locateFailed(watchError, attempt); },
    LOCATE_COARSE,
  );
  locateWatchTimer = setTimeout(() => locateFailed(firstError, attempt), LOCATE_COARSE.timeout);
}

// Painted by hand rather than through render(). Replacing the button that was just
// tapped can dismiss Safari's permission sheet before the driver answers it.
function showLocateProgress(label, notice) {
  const button = document.getElementById("locate");
  if (button) {
    button.disabled = true;
    button.textContent = label;
  }
  const status = document.getElementById("locate-status");
  if (status) {
    status.className = "ok";
    status.textContent = notice;
  }
}

function locate() {
  state.chooseStart = false;
  if (!window.isSecureContext) {
    state.locationError = "Location needs HTTPS. Type an address, or open the live site.";
    state.locationNotice = "";
    render();
    return;
  }
  if (!navigator.geolocation) {
    state.locationError = "This browser cannot share a location. Type an address instead.";
    state.locationNotice = "";
    render();
    return;
  }
  const attempt = ++locateAttempt;
  endLocateWatch();
  const refreshing = Boolean(originPoint());
  // First thing in the tap. Anything ahead of it can spend the user gesture that
  // Safari requires before it will prompt. Phone GPS first. If that misses,
  // the same tap asks again for a coarser fix before showing an error.
  // A second tap must not reuse the cached fix.
  if (refreshing) {
    const started = Date.now();
    const previous = { ...state.origin };
    let last = null;
    const options = { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 };
    locateWatchId = navigator.geolocation.watchPosition(
      (pos) => {
        if (attempt !== locateAttempt) return;
        last = pos;
        const age = Date.now() - Number(pos.timestamp || 0);
        if (age < 4000 || movedEnough(previous, pos.coords) || Date.now() - started > 8000) {
          locateSucceeded(pos, attempt);
        }
      },
      (error) => {
        if (attempt !== locateAttempt) return;
        if (error?.code === 1) locateFailed(error, attempt);
      },
      options,
    );
    locateWatchTimer = setTimeout(() => {
      if (attempt !== locateAttempt) return;
      if (last) locateSucceeded(last, attempt);
      else locateFailed({ code: 3 }, attempt);
    }, 12000);
    state.locating = true;
    state.locationError = "";
    state.locationNotice = "Updating your location…";
    showLocateProgress("Updating location…", state.locationNotice);
    locateAnswerTimer = setTimeout(() => {
      locateAnswerTimer = null;
      if (attempt !== locateAttempt) return;
      if (last) locateSucceeded(last, attempt);
      else locateFailed({ code: 4 }, attempt);
    }, 60000);
    return;
  }
  const ask = (options, coarseNext) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => locateSucceeded(pos, attempt),
      (error) => {
        if (attempt !== locateAttempt) return;
        if (error?.code === 1 || !coarseNext) locateRetry(error, attempt);
        else ask(LOCATE_COARSE, false);
      },
      options,
    );
  };
  const mac = /Macintosh/.test(navigator.userAgent) && !/Mobile/.test(navigator.userAgent);
  ask(mac ? LOCATE_COARSE : LOCATE_PRECISE, !mac);
  if (dropAddressStart()) document.querySelector(".stops .stop-card")?.remove();
  state.locating = true;
  state.locationError = "";
  state.locationNotice = "Asking for your location…";
  showLocateProgress("Waiting for permission…", state.locationNotice);
  // The spec only starts the timeout clock once the permission sheet is answered.
  // Left alone, an ignored sheet disables the button until the page is reloaded.
  locateAnswerTimer = setTimeout(() => {
    locateAnswerTimer = null;
    locateFailed({ code: 4 }, attempt);
  }, 60000);
}

let cardCelebrated = false;
let packCelebrated = false;

function maybeCelebratePack() {
  if (packCelebrated || !state.signedIn || !state.packCredits) return false;
  packCelebrated = true;
  state.signupNote = "124 credits are yours.";
  state.notice = "";
  state.packCredits = 0;
  popConfetti();
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
  clearPackWelcome();
  return true;
}

async function watchPackGrant() {
  for (let i = 0; i < 8; i += 1) {
    if (packCelebrated) return;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await refreshCredits();
    if (maybeCelebratePack()) return;
  }
}

function maybeCelebrateCard() {
  if (cardCelebrated || !state.signedIn || !state.cardCredits) return false;
  cardCelebrated = true;
  state.signupNote = "40 free credits are yours.";
  state.notice = "";
  state.cardCredits = 0;
  popConfetti();
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
  clearCardWelcome();
  return true;
}

async function watchCardGrant() {
  for (let i = 0; i < 8; i += 1) {
    if (cardCelebrated) return;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await refreshCredits();
    if (maybeCelebrateCard()) return;
  }
}

function applyAccount(me) {
  if (!me) return;
  state.credits = me.credits;
  state.signedIn = Boolean(me.signedIn);
  state.idleSignOut = Boolean(me.idle);
  state.unlimited = Boolean(me.unlimited);
  state.email = me.email || "";
  state.checkoutReady = Boolean(me.checkoutReady);
  state.googleClientId = me.googleClientId || "";
  state.cardOnFile = Boolean(me.cardOnFile);
  state.cardBrand = me.cardBrand || "";
  state.cardLast4 = me.cardLast4 || "";
  state.cardNote = me.cardNote || "";
  state.cardCredits = Number(me.cardCredits) || 0;
  state.packCredits = Number(me.packCredits) || 0;
  state.cardGrantUsed = Boolean(me.cardGrantUsed);
  state.packPriceCents = me.packPriceCents || 149;
  if (me.signedIn && !boxFontDirty) {
    const next = clampBoxFont(me.boxFont);
    if (state.boxFont !== next) {
      state.boxFont = next;
      paintBoxFont();
      persist();
    }
  }
}

function clampBoxFont(value) {
  const n = Math.round(Number(value));
  return n >= 13 && n <= 28 ? n : 13;
}

function paintBoxFont() {
  document.documentElement.style.setProperty("--box-font", `${state.boxFont}px`);
  const hos = document.querySelector(".hos");
  if (hos) hos.style.setProperty("--box-font", `${state.boxFont}px`);
  const readout = document.getElementById("boxFontReadout");
  if (readout) readout.textContent = String(state.boxFont);
  const input = document.getElementById("boxFont");
  if (input && document.activeElement !== input) input.value = String(state.boxFont);
}

function resetLocalBoxFont() {
  if (boxFontTimer) window.clearTimeout(boxFontTimer);
  boxFontTimer = 0;
  boxFontDirty = false;
  state.boxFont = 13;
}

function queueBoxFontSave() {
  if (!state.signedIn) return;
  boxFontDirty = true;
  if (boxFontTimer) window.clearTimeout(boxFontTimer);
  const size = state.boxFont;
  boxFontTimer = window.setTimeout(() => {
    boxFontTimer = 0;
    saveBoxFont(size).then(() => {
      if (state.boxFont === size && !boxFontTimer) boxFontDirty = false;
    }).catch(() => {});
  }, 300);
}

async function refreshCredits() {
  try {
    applyAccount(await creditsMe());
  } catch {
    if (state.credits == null) state.credits = null;
  }
  state.calls = [];
  if (state.signedIn) {
    try {
      const data = await fetchCalls();
      state.calls = Array.isArray(data.calls) ? data.calls : [];
    } catch {
      state.calls = [];
    }
  }
}

function clearLookupMessage() {
  state.lookupMessage = "";
  state.lookupStopId = "";
  state.lookupOk = false;
}

function setLookupMessage(stopId, message, { ok = false } = {}) {
  state.lookupStopId = stopId;
  state.lookupMessage = message;
  state.lookupOk = ok;
}

function clearUsingNote(id) {
  const timer = usingTimers.get(id);
  if (timer) window.clearTimeout(timer);
  usingTimers.delete(id);
  usingDismissed.delete(id);
}

function dismissUsingNote(id) {
  usingDismissed.add(id);
  usingTimers.delete(id);
  if (state.lookupStopId === id && state.lookupMessage === "Using that address.") clearLookupMessage();
  document.querySelectorAll(`.stop-card[data-stop="${id}"] p`).forEach((note) => {
    const text = note.textContent || "";
    if (text === "Using that address." || text === "Using this address.") note.remove();
  });
}

function armUsingNote(id) {
  if (usingDismissed.has(id) || usingTimers.has(id)) return;
  usingTimers.set(id, window.setTimeout(() => dismissUsingNote(id), 5000));
}

async function lookupAddress(id) {
  const stop = state.stops.find((item) => item.id === id);
  if (!stop) return;
  const query = (stop.address || "").trim();
  if (query !== (stop.verifiedLabel || "")) {
    delete stop.lat;
    delete stop.lon;
    stop.verifiedLabel = "";
  }
  if (!state.signedIn) {
    setLookupMessage(id, "Sign in to look up an address.");
    render();
    return;
  }
  if (query.length < 3) {
    setLookupMessage(id, "Type at least 3 letters, then look up the address.");
    render();
    return;
  }
  lookupOpen.delete(id);
  state.looking = id;
  clearLookupMessage();
  render();
  try {
    const data = await suggestAddresses(query);
    stop.suggestions = data.items || [];
    state.openLookupStopId = "";
    if (data.credits != null) state.credits = data.credits;
    if (stop.suggestions.length) {
      setLookupMessage(id, stop.suggestions.length === 1
        ? "Open the map, then tap the pin to use it."
        : `Showing ${stop.suggestions.length} matches. Open the map, move around, then tap a pin.`, { ok: true });
    }
  } catch (error) {
    stop.suggestions = [];
    if (error.credits != null) state.credits = error.credits;
    setLookupMessage(id, error.message || "Address lookup failed.");
  }
  state.looking = "";
  render();
}

async function pasteAddress(id) {
  const stop = state.stops.find((item) => item.id === id);
  if (!stop) return;
  if (!navigator.clipboard?.readText) {
    setLookupMessage(id, "Paste is not available in this browser.");
    render();
    return;
  }
  let text = "";
  try {
    text = await navigator.clipboard.readText();
  } catch {
    setLookupMessage(id, "Allow paste, then try Paste an address again.");
    render();
    return;
  }
  const address = String(text || "").replace(/\s+/g, " ").trim();
  if (!address) {
    setLookupMessage(id, "Copy an address first.");
    render();
    return;
  }
  if (address === String(stop.address || "").trim()) return;
  updateStop(id, { address });
}

function chooseSuggestion(id, index) {
  const stop = state.stops.find((item) => item.id === id);
  const item = stop?.suggestions?.[index];
  if (!stop || !item) return;
  stop.address = item.label;
  stop.verifiedLabel = item.label;
  stop.lat = item.lat;
  stop.lon = item.lon;
  stop.suggestions = [];
  if (state.openLookupStopId === id) state.openLookupStopId = "";
  stop.miles = "";
  stop.hours = "";
  state.plan = null;
  clearUsingNote(id);
  setLookupMessage(id, "Using that address.", { ok: true });
  persist();
  render();
}

async function fillHereLegs() {
  const departAt = leaveAtNow();
  const speedCapMph = state.settings.governed ? mph() : null;
  const missing = state.stops
    .map((stop, index) => ({ stop, index }))
    .filter(({ stop }) => !stop.useCurrentLocation && !stop.skipRoute && !pointReady(stop));
  if (missing.length) {
    const names = missing.map(({ index }) => cardTitle(index, state.stops));
    const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
    throw new Error(`Press lookup address on ${list} and choose an address before pressing Calculate.`);
  }
  const routed = [];
  for (const stop of state.stops) {
    if (stop.skipRoute) {
      stop.miles = "";
      stop.hours = "";
      stop.path = [];
      stop.directions = [];
      continue;
    }
    routed.push(stop);
  }
  const routedPoints = [];
  for (const stop of routed) {
    if (stop.useCurrentLocation) {
      const here = originPoint();
      if (!here) throw new Error("Allow location first, then Calculate.");
      routedPoints.push(here);
      continue;
    }
    routedPoints.push({ lat: Number(stop.lat), lon: Number(stop.lon) });
  }
  for (let i = 1; i < routed.length; i += 1) {
    if (!routedPoints[i - 1] || !routedPoints[i]) continue;
    const heading = state.origin?.heading;
    const course = routed[i - 1]?.useCurrentLocation && typeof heading === "number" ? heading : undefined;
    const leg = await truckRoute(routedPoints[i - 1], routedPoints[i], {
      speedCapMph,
      departAt,
      course,
      routingMode: state.settings.routeMode === "short" ? "short" : "fast",
    });
    routed[i].miles = String(Math.round(leg.miles * 10) / 10);
    routed[i].hours = String(Math.round(leg.hours * 100) / 100);
    routed[i].path = Array.isArray(leg.points) ? leg.points : [];
    routed[i].directions = Array.isArray(leg.directions) ? leg.directions : [];
    if (leg.credits != null) state.credits = leg.credits;
  }
  persist();
}

async function deleteCard() {
  state.error = "";
  try {
    applyAccount(await removeSavedCard());
    state.cardSavedNote = false;
  } catch (error) {
    state.error = error.message || "Could not delete that card.";
  }
  render();
}

async function saveCard() {
  state.savingCard = true;
  state.error = "";
  state.notice = "Opening the card form…";
  render();
  try {
    const { url } = await startCardSetup();
    location.href = url;
  } catch (error) {
    state.error = error.message || "Card setup is not ready.";
    state.savingCard = false;
    render();
  }
}

async function buyPack() {
  state.buying = true;
  state.error = "";
  state.notice = "Opening checkout…";
  render();
  try {
    const { url } = await startCheckout();
    location.href = url;
  } catch (error) {
    state.error = error.message || "Checkout is not ready.";
    state.buying = false;
    render();
  }
}

const scriptLoads = new Map();

function loadScript(src) {
  const pending = scriptLoads.get(src);
  if (pending) return pending;
  const existing = [...document.scripts].find((script) => script.src === src);
  if (existing?.dataset.loaded === "1") return Promise.resolve();
  existing?.remove();
  const promise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = () => {
      script.dataset.loaded = "1";
      resolve();
    };
    script.onerror = () => {
      scriptLoads.delete(src);
      script.remove();
      reject(new Error("Could not load sign-in."));
    };
    document.head.appendChild(script);
  });
  scriptLoads.set(src, promise);
  return promise;
}

async function redeemCode(code) {
  const trimmed = String(code || "").trim();
  if (!/^[A-Za-z0-9]{8}$/.test(trimmed)) {
    state.error = "That code is not valid.";
    render();
    return;
  }
  try {
    const data = await redeemGift(trimmed);
    if (data.credits != null) state.credits = data.credits;
    state.error = "";
    state.notice = `${data.added} credits added.`;
    render();
    popConfetti();
    return;
  } catch (error) {
    state.error = error.message || "That code is used or not valid.";
  }
  render();
}

async function logout() {
  if (boxFontTimer) {
    window.clearTimeout(boxFontTimer);
    boxFontTimer = 0;
  }
  if (boxFontDirty && state.signedIn) {
    try {
      await saveBoxFont(state.boxFont);
    } catch {
      // Still sign out. The last size stays on the account only if this save landed.
    }
  }
  boxFontDirty = false;
  await logoutRemote();
  clearSession();
  try {
    window.google?.accounts?.id?.disableAutoSelect();
  } catch {
    // Google's script may not be loaded yet.
  }
  state.signedIn = false;
  state.unlimited = false;
  state.email = "";
  state.cardOnFile = false;
  state.cardBrand = "";
  state.cardLast4 = "";
  state.cardNote = "";
  state.cardGrantUsed = false;
  state.cardSavedNote = false;
  state.credits = null;
  state.calls = [];
  state.notice = "Signed out.";
  resetLocalBoxFont();
  resetEditor();
  persist();
  await refreshCredits();
  render();
}

function poofBox(el) {
  if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const rect = el.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return;
  const node = document.createElement("span");
  node.className = "poof";
  node.setAttribute("aria-hidden", "true");
  node.style.left = `${rect.left + rect.width / 2}px`;
  node.style.top = `${rect.top + rect.height / 2}px`;
  const reach = Math.max(16, Math.min(28, Math.min(rect.width, rect.height) * 0.55));
  for (let i = 0; i < 8; i += 1) {
    const bit = document.createElement("i");
    const angle = (Math.PI * 2 * i) / 8 + 0.2;
    const dist = reach * (0.75 + (i % 3) * 0.18);
    bit.style.setProperty("--dx", `${Math.cos(angle) * dist}px`);
    bit.style.setProperty("--dy", `${Math.sin(angle) * dist}px`);
    node.append(bit);
  }
  document.body.append(node);
  el.remove();
  window.setTimeout(() => node.remove(), 420);
}

function poofBig(el) {
  if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const rect = el.getBoundingClientRect();
  const node = document.createElement("span");
  node.className = "poof big";
  node.setAttribute("aria-hidden", "true");
  node.style.left = `${rect.left + rect.width / 2}px`;
  node.style.top = `${rect.top + rect.height / 2}px`;
  const reach = Math.min(220, Math.max(120, Math.min(window.innerWidth, window.innerHeight) * 0.28));
  for (let i = 0; i < 18; i += 1) {
    const bit = document.createElement("i");
    const angle = (Math.PI * 2 * i) / 18;
    const dist = reach * (0.55 + (i % 4) * 0.14);
    bit.style.setProperty("--dx", `${Math.cos(angle) * dist}px`);
    bit.style.setProperty("--dy", `${Math.sin(angle) * dist}px`);
    node.append(bit);
  }
  document.body.append(node);
  window.setTimeout(() => node.remove(), 760);
}

function popConfetti() {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  canvas.style.cssText = "position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:80;";
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    canvas.remove();
    return;
  }
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.width = Math.floor(window.innerWidth * dpr);
  const height = canvas.height = Math.floor(window.innerHeight * dpr);
  const colors = ["#1f8a62", "#3dcaa0", "#f2c14e", "#e07a3d", "#fffdf8", "#2f6fed"];
  const pieces = [];
  const originX = width / 2;
  const originY = height - 12 * dpr;
  for (let i = 0; i < 140; i++) {
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * 1.15;
    const speed = (9 + Math.random() * 11) * dpr;
    pieces.push({
      x: originX,
      y: originY,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      w: (5 + Math.random() * 7) * dpr,
      h: (8 + Math.random() * 10) * dpr,
      color: colors[i % colors.length],
      spin: (Math.random() - 0.5) * 0.28,
      angle: Math.random() * Math.PI,
      life: 80 + Math.random() * 35,
    });
  }
  const started = performance.now();
  const tick = (now) => {
    ctx.clearRect(0, 0, width, height);
    let alive = false;
    for (const piece of pieces) {
      piece.life -= 1;
      if (piece.life <= 0) continue;
      alive = true;
      piece.vy += 0.32 * dpr;
      piece.x += piece.vx;
      piece.y += piece.vy;
      piece.vx *= 0.992;
      piece.angle += piece.spin;
      ctx.save();
      ctx.translate(piece.x, piece.y);
      ctx.rotate(piece.angle);
      ctx.globalAlpha = Math.max(0, Math.min(1, piece.life / 28));
      ctx.fillStyle = piece.color;
      ctx.fillRect(-piece.w / 2, -piece.h / 2, piece.w, piece.h);
      ctx.restore();
    }
    if (alive && now - started < 4500) requestAnimationFrame(tick);
    else canvas.remove();
  };
  requestAnimationFrame(tick);
}

function syncOwnerLink() {
  const nav = document.querySelector("footer nav");
  if (!nav) return;
  const existing = nav.querySelector("[data-accounts]");
  if (state.signedIn && state.unlimited) {
    if (existing) return;
    const link = document.createElement("a");
    link.href = "./accounts.html";
    link.textContent = "Accounts";
    link.setAttribute("data-accounts", "");
    nav.append(link);
    return;
  }
  existing?.remove();
}

function hostedOnPlanigator() {
  return location.hostname === "planigator.help" || location.hostname === "www.planigator.help";
}

function googleNeedsFullPageRedirect() {
  if (!hostedOnPlanigator()) return false;
  if (window.navigator.standalone === true) return true;
  try {
    if (window.matchMedia("(display-mode: standalone)").matches) return true;
    if (window.matchMedia("(display-mode: fullscreen)").matches) return true;
  } catch {
    // Older webviews omit matchMedia.
  }
  return false;
}

async function completeGoogleCredential(credential) {
  const dropSession = localStorage.getItem("planigator.web.session") || "";
  clearSession();
  const me = await loginWith("google", credential, dropSession);
  state.idleNote = "";
  applyAccount(me);
  if (me.signupCredits) {
    state.signupNote = "40 free credits are yours.";
    state.notice = "";
    popConfetti();
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
  } else if (!maybeCelebratePack() && !maybeCelebrateCard()) {
    state.signupNote = "";
    state.notice = "Signed in with Google.";
    render();
  }
  pulseActivity();
  await pullAccountTrips();
  if (!state.locating) render();
}

function mountAuth() {
  const googleBox = document.getElementById("googleBtn");
  if (!googleBox || !state.googleClientId || googleBox.childElementCount) return;
  const start = () => {
    const box = document.getElementById("googleBtn");
    if (!box || !state.googleClientId || box.childElementCount) return;
    if (!window.google?.accounts?.id) return;
    const redirect = googleNeedsFullPageRedirect();
    const settings = {
      client_id: state.googleClientId,
      auto_select: false,
      itp_support: true,
      use_fedcm_for_prompt: false,
      ux_mode: redirect ? "redirect" : "popup",
      callback: async ({ credential }) => {
        try {
          await completeGoogleCredential(credential);
        } catch (error) {
          state.error = error.message || "Google sign-in failed.";
          render();
        }
      },
    };
    if (redirect) settings.login_uri = `${location.origin}/oauth/google`;
    window.google.accounts.id.initialize(settings);
    box.innerHTML = "";
    window.google.accounts.id.renderButton(box, { theme: "outline", size: "large", width: 280 });
  };
  if (window.google?.accounts?.id) start();
  else loadScript("https://accounts.google.com/gsi/client").then(start).catch((error) => {
    state.error = error.message;
    render();
  });
}

function sharePayload() {
  return {
    v: 2,
    tripName: state.tripName,
    settings: settingsForSave(),
    origin: originPoint(),
    plan: slimPlan(state.plan),
    stops: state.stops.map((stop) => {
      const copy = { ...stop };
      delete copy.suggestions;
      return copy;
    }),
  };
}

async function shareTrip() {
  let saved;
  try {
    saved = await createShare(sharePayload());
  } catch (error) {
    state.error = error.message || "Could not make a share link.";
    render();
    return;
  }
  const url = saved.url || `${location.origin}/t/${saved.code}`;
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

async function shareToNav() {
  let saved;
  try {
    saved = await createShare(sharePayload());
  } catch (error) {
    state.error = error.message || "Could not send that trip.";
    render();
    return;
  }
  if (!saved.code) {
    state.error = "Could not send that trip.";
    render();
    return;
  }
  window.location.href = `planigator://nav/${saved.code}`;
  state.notice = "Opening Planigator.";
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

function routeFromLine(originStop) {
  const point = originPoint();
  if (point) return `<span class="flag-box">Routing from ${point.lat.toFixed(4)}, ${point.lon.toFixed(4)}</span>`;
  if (originStop) return `<span class="flag-box">Waiting for location. Allow Planigator, or type an address.</span>`;
  return "";
}

function routePoints() {
  const line = [];
  for (const stop of state.stops) {
    if (!Array.isArray(stop.path)) continue;
    for (const pair of stop.path) {
      const lat = Number(pair?.[0]);
      const lon = Number(pair?.[1]);
      if (Number.isFinite(lat) && Number.isFinite(lon)) line.push([lat, lon]);
    }
  }
  if (line.length >= 2) return line;
  const pins = [];
  const here = originPoint();
  if (here) pins.push([here.lat, here.lon]);
  for (const stop of state.stops) {
    if (stop.useCurrentLocation) continue;
    if (Number.isFinite(Number(stop.lat)) && Number.isFinite(Number(stop.lon))) {
      pins.push([Number(stop.lat), Number(stop.lon)]);
    }
  }
  return pins;
}

function savedTripsBlock() {
  if (!state.trips.length) return "";
  return `<section class="trips">
    <h2>Saved trips</h2>
    <ul>
      ${state.trips.map((trip) => `<li class="${trip.id === state.activeTripId ? "active" : ""}">
        <button type="button" class="flag-box${trip.id === state.activeTripId ? " on" : ""}" data-load="${escapeAttr(trip.id)}">
          ${escapeAttr(trip.name || trip.tripName || "Trip")}
          <span>${formatShort(trip.savedAt)}</span>
        </button>
        <button type="button" class="flag-box" data-delete="${escapeAttr(trip.id)}">${state.confirmDeleteId === trip.id ? "Confirm delete" : "Delete"}</button>
      </li>`).join("")}
    </ul>
  </section>`;
}

function metersBetween(a, b) {
  const lat = ((a[0] + b[0]) / 2) * Math.PI / 180;
  const y = (b[0] - a[0]) * 111320;
  const x = (b[1] - a[1]) * 111320 * Math.cos(lat);
  return Math.hypot(x, y);
}

function polylineMeters(path) {
  let walked = 0;
  for (let i = 1; i < path.length; i += 1) walked += metersBetween(path[i - 1], path[i]);
  return walked;
}

function stepLengthMeters(step) {
  const text = String(step?.text || "");
  const feet = text.match(/Go for\s+([0-9][0-9,]*(?:\.[0-9]+)?)\s*ft\b/i);
  if (feet) return Number(feet[1].replace(/,/g, "")) * 0.3048;
  const miles = Number(step?.miles);
  if (Number.isFinite(miles) && miles > 0) return miles * 1609.344;
  const spoken = text.match(/Go for\s+([0-9][0-9,]*(?:\.[0-9]+)?)\s*mi\b/i);
  if (spoken) return Number(spoken[1].replace(/,/g, "")) * 1609.344;
  return 0;
}

function pointAlong(path, meters) {
  if (!path.length) return null;
  if (meters <= 0) return { lat: path[0][0], lon: path[0][1] };
  let walked = 0;
  for (let i = 1; i < path.length; i += 1) {
    const seg = metersBetween(path[i - 1], path[i]);
    if (walked + seg >= meters || i === path.length - 1) {
      const t = seg > 0 ? Math.min(1, Math.max(0, (meters - walked) / seg)) : 1;
      return {
        lat: path[i - 1][0] + (path[i][0] - path[i - 1][0]) * t,
        lon: path[i - 1][1] + (path[i][1] - path[i - 1][1]) * t,
      };
    }
    walked += seg;
  }
  const last = path[path.length - 1];
  return { lat: last[0], lon: last[1] };
}

function directionFocus(stop, index) {
  const steps = Array.isArray(stop?.directions) ? stop.directions : [];
  const step = steps[index];
  if (!step) return null;
  const path = (Array.isArray(stop?.path) ? stop.path : [])
    .map((pair) => [Number(pair?.[0]), Number(pair?.[1])])
    .filter((pair) => Number.isFinite(pair[0]) && Number.isFinite(pair[1]));
  const storedLat = Number(step.lat);
  const storedLon = Number(step.lon);
  const hasStored = Number.isFinite(storedLat) && Number.isFinite(storedLon);
  if (path.length < 2) {
    if (!hasStored) return null;
    return { lat: storedLat, lon: storedLon, coords: [[storedLat, storedLon]] };
  }
  const lengths = steps.map(stepLengthMeters);
  const sum = lengths.reduce((total, length) => total + length, 0);
  const total = polylineMeters(path);
  const scale = sum > 1 ? total / sum : 1;
  let along = 0;
  for (let i = 0; i < index; i += 1) along += lengths[i] * scale;
  if (lengths[index] === 0 && index === steps.length - 1) along = total;
  const at = pointAlong(path, along);
  if (!at) return null;
  const start = Math.max(0, along - 150);
  const end = along + 450;
  const coords = [];
  const add = (lat, lon) => {
    const prev = coords[coords.length - 1];
    if (prev && Math.abs(prev[0] - lat) < 1e-7 && Math.abs(prev[1] - lon) < 1e-7) return;
    coords.push([lat, lon]);
  };
  const from = pointAlong(path, start);
  const to = pointAlong(path, end);
  if (from) add(from.lat, from.lon);
  let walked = 0;
  for (let i = 1; i < path.length; i += 1) {
    const seg = metersBetween(path[i - 1], path[i]);
    const next = walked + seg;
    if (next > start && walked < end && seg > 0) {
      const t0 = Math.max(0, (start - walked) / seg);
      const t1 = Math.min(1, (end - walked) / seg);
      if (t0 > 0) add(path[i - 1][0] + (path[i][0] - path[i - 1][0]) * t0, path[i - 1][1] + (path[i][1] - path[i - 1][1]) * t0);
      add(path[i - 1][0] + (path[i][0] - path[i - 1][0]) * t1, path[i - 1][1] + (path[i][1] - path[i - 1][1]) * t1);
    }
    walked = next;
    if (walked > end) break;
  }
  add(at.lat, at.lon);
  if (to) add(to.lat, to.lon);
  if (navFix && metersBetween(navFix, [at.lat, at.lon]) < 2000) add(navFix[0], navFix[1]);
  return { lat: at.lat, lon: at.lon, coords };
}

function directionsBlock() {
  const groups = [];
  for (const stop of state.stops) {
    if (!Array.isArray(stop.directions) || !stop.directions.length) continue;
    const title = stop.useCurrentLocation ? "Current location" : (stop.name || "Stop");
    groups.push({ id: stop.id, title, steps: stop.directions });
  }
  if (!groups.length) return "";
  const items = groups.map((group) => `
    <li class="dir-leg">${escapeAttr(group.title)}</li>
    ${group.steps.map((step, index) => {
      const text = String(step.text || "");
      const shown = withoutGo(text);
      const already = /Go for\s+[0-9]/i.test(text);
      const extra = !already && Number(step.miles) > 0.05 ? ` <span class="dir-miles" data-full="${escapeAttr(formatMiles(step.miles))}">${formatMiles(step.miles)}</span>` : "";
      return `<li><button type="button" class="dir-step" data-dir-stop="${escapeAttr(group.id)}" data-dir-index="${index}"><span class="dir-link" data-original="${escapeAttr(text)}">${escapeAttr(shown)}</span>${extra}</button></li>`;
    }).join("")}
  `).join("");
  return `<details class="directions call-log-box" id="routeDirections" open>
    <summary>auto zooming directions</summary>
    <div class="dir-scroll">
      <ol>${items}</ol>
    </div>
  </details>`;
}

function planBox() {
  const plan = state.plan;
  if (!plan) return "";
  return `<section class="result">
    <div class="route-stage" id="routeStage">
      <div id="routeMap" class="route-map">
      <aside class="route-rail route-rail-left">
        <button type="button" id="routeZoomIn" aria-label="Zoom in"><span>Zoom</span><span>in</span></button>
        <button type="button" id="routeZoomOut" aria-label="Zoom out"><span>Zoom</span><span>out</span></button>
      </aside>
      <aside class="route-rail">
        <button type="button" id="routeFull" aria-label="Full screen"><span>Full</span><span>screen</span></button>
        <button type="button" id="routeExit" hidden>Exit</button>
        <button type="button" id="routeWhole">Trip</button>
        <button type="button" id="routeRecalc" aria-label="Recalculate" ${state.estimating || (!state.unlimited && state.credits === 0) ? "disabled" : ""}><span>Recalc</span><span>ulate</span></button>
        <button type="button" id="routeStop" aria-label="Choose stop"><span id="routeStopOrdinal">1st</span><span>stop</span></button>
        <div class="truck-slot">
          <button type="button" id="routeTruckAdd" hidden>Add and recalculate</button>
          <button type="button" id="routeTruck" hidden aria-label="Next truck stop" ${state.estimating || (!state.unlimited && state.credits === 0) ? "disabled" : ""}><span>Truck</span><span>stop</span></button>
        </div>
        <button type="button" id="routeFollow" hidden aria-label="Follow me"><span>Follow</span><span>me</span></button>
      </aside>
      </div>
      <div class="route-bottom">
      <p class="route-stop-miles" id="routeStopMiles" hidden></p>
      <div class="route-place-row" id="routePlaceRow">
        <p class="route-drive" id="routeDrive" hidden></p>
        <p class="route-place" id="routePlace" hidden></p>
      </div>
      </div>
    </div>
    <div id="routeDirectionsHome"></div>
    ${directionsBlock()}
    ${directionsBlock() ? `<div class="nav-actions"><button type="button" class="flag-box" id="nextTruck" ${state.estimating || (!state.unlimited && state.credits === 0) ? "disabled" : ""}>Next truck stop · 1 credit</button><button type="button" class="flag-box${state.darkMode ? " on" : ""}" id="darkMode">Dark mode</button></div><p class="flag-box" id="nextTruckNote"${truckHit ? "" : " hidden"}>${truckHit ? escapeAttr(truckNoteText(truckHit)) : ""}</p><button type="button" class="flag-box" id="addTruckStop"${truckHit ? "" : " hidden"}>Add as next stop</button><div class="nav-actions"><button type="button" class="flag-box" id="startNav" ${navOn ? "disabled" : ""}>${navOn ? "Navigation in progress" : "Start navigation"}</button><button type="button" class="flag-box" id="endNav">End navigation</button></div>` : ""}
    ${plan.late && plan.lastDeadline ? `<p class="error">That is after ${escapeAttr(plan.lastTimedTitle)}’s be-there-by (${formatShort(plan.lastDeadline)}).</p>` : ""}
    <div class="result-lines">
      <p class="flag-box">Leave by ${escapeAttr(formatTime(plan.rollAt))}</p>
      <p class="flag-box">Arrive ${escapeAttr(formatTime(plan.arriveAt))}</p>
      <p class="flag-box">Driving ${escapeAttr(hoursLabel(plan.driveHours))} · ${escapeAttr(formatMiles(plan.miles))}</p>
      <p class="flag-box">HOS on this path ${plan.breakCount} × 30-min · ${plan.restCount} × 10-hour</p>
      <p class="flag-box">Total trip-time including 10's and 30's: ${escapeAttr(durationLabel((plan.arriveAt - plan.rollAt) / 3600 / 1000))}.</p>
    </div>
  </section>`;
}

function lookupPins(stop) {
  return (stop?.suggestions || []).filter((item) => Number.isFinite(Number(item.lat)) && Number.isFinite(Number(item.lon)));
}

function lookupMapPreview(stop) {
  if (!lookupPins(stop).length) return "";
  return `<div class="lookup-preview">
    <div class="lookup-map" data-lookup-map="${escapeAttr(stop.id)}"></div>
    <button type="button" class="lookup-open" data-open-map="${escapeAttr(stop.id)}">Open map</button>
  </div>`;
}

let chooseMap = false;
let mapSpot = null;

function lookupMapSheet() {
  const stop = state.stops.find((item) => item.id === state.openLookupStopId);
  if (!stop || (!chooseMap && !lookupPins(stop).length)) return "";
  return `<div class="lookup-sheet" role="dialog" aria-modal="true" aria-label="Choose from map">
    <div class="lookup-sheet-bar">
      <strong>${chooseMap ? "Choose from map" : "Choose a stop"}</strong>
      <button type="button" class="secondary" id="closeLookupMap">Close</button>
    </div>
    ${chooseMap ? `<div class="map-pick-steps"><p class="flag-box">Step 1: Long press a spot. Step 2: Touch "Use this spot"</p><button type="button" class="flag-box" id="useMapSpot"${mapSpot ? "" : " disabled"}>Use this spot</button></div>` : `<p class="fine">Move around, then tap a pin.</p>`}
    <div class="lookup-map is-live" data-lookup-map="${escapeAttr(stop.id)}" data-live="1"${chooseMap ? ` data-map-pick="1"` : ""}></div>
  </div>`;
}

let lookupMaps = [];

const satelliteStyle = {
  version: 8,
  sources: {
    satellite: {
      type: "raster",
      tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
      tileSize: 256,
      maxzoom: 19,
      attribution: "Esri, Maxar, Earthstar Geographics, and the GIS User Community",
    },
  },
  layers: [{ id: "satellite", type: "raster", source: "satellite" }],
};

function pickMapStyle() {
  const overlay = {
    type: "raster",
    tileSize: 256,
    maxzoom: 19,
    attribution: "Esri, HERE, Garmin, USGS",
  };
  return {
    version: 8,
    sources: {
      satellite: satelliteStyle.sources.satellite,
      streets: {
        ...overlay,
        tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}"],
      },
      places: {
        ...overlay,
        tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places_Alternate/MapServer/tile/{z}/{y}/{x}"],
      },
    },
    layers: [
      { id: "satellite", type: "raster", source: "satellite" },
      { id: "streets", type: "raster", source: "streets" },
      { id: "places", type: "raster", source: "places" },
    ],
  };
}

function mountLookupMaps() {
  lookupMaps.forEach((map) => map.remove());
  lookupMaps = [];
  const maplibre = window.maplibregl;
  if (!maplibre) return;
  document.querySelectorAll("[data-lookup-map]").forEach((el) => {
    const stop = state.stops.find((item) => item.id === el.getAttribute("data-lookup-map"));
    const pins = lookupPins(stop);
    const pick = el.getAttribute("data-map-pick") === "1";
    if (!pins.length && !pick) return;
    const live = el.getAttribute("data-live") === "1";
    const map = new maplibre.Map({
      container: el,
      style: pick ? pickMapStyle() : satelliteStyle,
      attributionControl: false,
      interactive: live,
    });
    map.addControl(new maplibre.AttributionControl({ compact: !live }), "bottom-right");
    if (!live) {
      map.dragPan.disable();
      map.scrollZoom.disable();
      map.boxZoom.disable();
      map.doubleClickZoom.disable();
      map.touchZoomRotate.disable();
      map.keyboard.disable();
    }
    map.on("load", () => {
      const bounds = new maplibre.LngLatBounds();
      pins.forEach((pin, index) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "lookup-pin";
        button.textContent = pinLabel(pin.label);
        if (live) {
          button.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            chooseSuggestion(stop.id, index);
          });
        }
        new maplibre.Marker({ element: button, anchor: "bottom" })
          .setLngLat([Number(pin.lon), Number(pin.lat)])
          .addTo(map);
        bounds.extend([Number(pin.lon), Number(pin.lat)]);
      });
      if (pick && chooseHere) {
        map.jumpTo({ center: [chooseHere.lon, chooseHere.lat], zoom: 16 });
        const dot = document.createElement("span");
        dot.className = "route-you";
        new maplibre.Marker({ element: dot, anchor: "center" }).setLngLat([chooseHere.lon, chooseHere.lat]).addTo(map);
      } else if (pins.length) map.fitBounds(bounds, { padding: live ? 64 : 28, maxZoom: pins.length === 1 ? 14 : 12, animate: false });
      else {
        const center = lookupCenter(stop);
        if (center) map.jumpTo({ center, zoom: pick ? 16 : 14 });
      }
      if (pick) bindMapPick(map, stop.id);
      map.resize();
    });
    lookupMaps.push(map);
  });
}

let mapPickMarker = null;

let chooseHere = null;

function lookupCenter(stop) {
  if (chooseHere) return [chooseHere.lon, chooseHere.lat];
  if (Number.isFinite(Number(stop?.lat)) && Number.isFinite(Number(stop?.lon))) return [Number(stop.lon), Number(stop.lat)];
  const here = originPoint();
  if (here) return [here.lon, here.lat];
  if (navFix) return [navFix[1], navFix[0]];
  return [-98.35, 39.5];
}

async function openChooseMap(id) {
  const button = document.querySelector(`[data-stop="${id}"] [data-act=map]`);
  if (button) {
    button.disabled = true;
    button.textContent = "Finding you…";
  }
  chooseMap = true;
  mapSpot = null;
  chooseHere = null;
  if (mapPickMarker) {
    mapPickMarker.remove();
    mapPickMarker = null;
  }
  const here = await currentFix();
  if (here) chooseHere = { lat: here.lat, lon: here.lon };
  state.openLookupStopId = id;
  render();
}

function markMapSpot(map, lngLat) {
  const lat = Number(lngLat?.lat);
  const lon = Number(lngLat?.lng);
  if (!map || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
  mapSpot = { lat, lon };
  const maplibre = window.maplibregl;
  if (!maplibre) return;
  if (mapPickMarker) mapPickMarker.remove();
  const pin = document.createElement("span");
  pin.className = "map-spot";
  mapPickMarker = new maplibre.Marker({ element: pin, anchor: "center" }).setLngLat([lon, lat]).addTo(map);
  const button = document.getElementById("useMapSpot");
  if (button) button.disabled = false;
}

function bindMapPick(map) {
  map.getContainer()?.addEventListener("contextmenu", (event) => event.preventDefault());
  map.on("contextmenu", (event) => {
    event.preventDefault?.();
    markMapSpot(map, event.lngLat);
  });
  let timer = 0;
  let start = null;
  map.on("touchstart", (event) => {
    start = event.lngLat;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      if (start) markMapSpot(map, start);
    }, 550);
  });
  map.on("touchmove", () => {
    window.clearTimeout(timer);
    start = null;
  });
  map.on("touchend", () => window.clearTimeout(timer));
}

async function useChosenSpot() {
  const id = state.openLookupStopId;
  const spot = mapSpot;
  const stop = state.stops.find((item) => item.id === id);
  if (!stop || !spot) return;
  let label = "Chosen on the map";
  try {
    const data = await spotAddress(spot.lat, spot.lon);
    if (data?.label) label = String(data.label).trim() || label;
  } catch {
    // The point still works without a street label.
  }
  stop.address = label;
  stop.verifiedLabel = label;
  stop.lat = spot.lat;
  stop.lon = spot.lon;
  stop.suggestions = [];
  stop.miles = "";
  stop.hours = "";
  state.plan = null;
  state.openLookupStopId = "";
  chooseMap = false;
  mapSpot = null;
  if (mapPickMarker) {
    mapPickMarker.remove();
    mapPickMarker = null;
  }
  clearUsingNote(id);
  setLookupMessage(id, "Using that address.", { ok: true });
  persist();
  render();
}

function pinLabel(label) {
  const text = String(label || "").split(",")[0].trim();
  return text.length > 28 ? `${text.slice(0, 28)}…` : text;
}

let routeMap = null;
let truckMarker = null;
let routeMapReady = false;
let turnMarker = null;
let pendingTurn = null;
let routeFull = false;
let navOn = false;
let navFollowing = true;
let navZoom = 15;
let navZoomHold = 0;
let navWatch = null;
let navYou = null;
let navFix = null;
let navMotion = 0;
let navShown = null;
let navAim = null;
let navTravel = null;
let navCompass = null;
let navCompassTimer = 0;
let navReturnTimer = 0;
let navStopCursor = 0;
let truckHit = null;
let navLine = [];
let navLegs = [];

function clearRouteMap() {
  pendingTurn = null;
  routeMapReady = false;
  navYou = null;
  if (turnMarker) {
    turnMarker.remove();
    turnMarker = null;
  }
  if (routeMap) {
    routeMap.remove();
    routeMap = null;
  }
  truckMarker = null;
}

function navStopTitle(stop) {
  if (stop?.useCurrentLocation) return "Current location";
  const name = String(stop?.name || "").trim();
  return name || "Stop";
}

let stopChipLines = [];
let stopChipIndex = 0;
let stopChipTimer = 0;

function hoursForMeters(meters) {
  const totalMiles = Number(state.plan?.miles);
  const totalHours = Number(state.plan?.driveHours);
  const leftMiles = Math.max(0, meters) / 1609.344;
  if (totalMiles > 0 && totalHours > 0) return totalHours * (leftMiles / totalMiles);
  return leftMiles / mph();
}

function etaLabel(ms) {
  const date = new Date(ms);
  const now = new Date();
  const clock = formatClockMinutes(date.getHours() * 60 + date.getMinutes());
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  if (sameDay) return `ETA ${clock}`;
  const day = date.toLocaleDateString("en-US", { weekday: "short" });
  return `ETA ${day} ${clock}`;
}

function paintStopChip() {
  const chip = document.getElementById("routeStopMiles");
  if (!chip) return;
  if (!navOn || !stopChipLines.length) {
    chip.hidden = true;
    chip.textContent = "";
    return;
  }
  chip.hidden = false;
  chip.textContent = stopChipLines[stopChipIndex % stopChipLines.length];
}

function setStopChip(meters, name) {
  if (!(meters >= 0) || !name) {
    stopChipLines = [];
    stopChipIndex = 0;
    if (stopChipTimer) window.clearInterval(stopChipTimer);
    stopChipTimer = 0;
    paintStopChip();
    return;
  }
  const hours = hoursForMeters(meters);
  const lines = [`${navMiles(meters)} to ${name}`];
  if (hours > 0) {
    lines.push(etaLabel(Date.now() + hours * 3600 * 1000));
    lines.push(`${hoursLabel(hours)} to ${name}`);
  }
  if (lines.length !== stopChipLines.length) stopChipIndex = 0;
  stopChipLines = lines;
  paintStopChip();
  if (stopChipTimer || lines.length < 2) return;
  stopChipTimer = window.setInterval(() => {
    if (stopChipLines.length < 2) return;
    stopChipIndex = (stopChipIndex + 1) % stopChipLines.length;
    paintStopChip();
  }, 3000);
}

function navMiles(meters) {
  const miles = meters / 1609.344;
  if (miles < 0.1) return `${Math.max(1, Math.round(meters * 3.28084))} ft`;
  if (miles < 10) return `${miles.toFixed(1)} mi`;
  return `${Math.round(miles)} mi`;
}

function navBearing(a, b) {
  const φ1 = a[0] * Math.PI / 180;
  const φ2 = b[0] * Math.PI / 180;
  const λ = (b[1] - a[1]) * Math.PI / 180;
  const y = Math.sin(λ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(λ);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function navProjectT(a, b, lat, lon) {
  const lat0 = ((a[0] + b[0]) / 2) * Math.PI / 180;
  const bx = (b[1] - a[1]) * 111320 * Math.cos(lat0);
  const by = (b[0] - a[0]) * 111320;
  const px = (lon - a[1]) * 111320 * Math.cos(lat0);
  const py = (lat - a[0]) * 111320;
  const len2 = bx * bx + by * by;
  if (len2 < 1) return 0;
  return Math.max(0, Math.min(1, (px * bx + py * by) / len2));
}

function navNearest(lat, lon, path) {
  let bestDist = Infinity;
  let along = 0;
  let walked = 0;
  for (let i = 1; i < path.length; i += 1) {
    const seg = metersBetween(path[i - 1], path[i]);
    const t = navProjectT(path[i - 1], path[i], lat, lon);
    const plat = path[i - 1][0] + (path[i][0] - path[i - 1][0]) * t;
    const plon = path[i - 1][1] + (path[i][1] - path[i - 1][1]) * t;
    const dist = metersBetween([lat, lon], [plat, plon]);
    if (dist < bestDist) {
      bestDist = dist;
      along = walked + seg * t;
    }
    walked += seg;
  }
  return { dist: bestDist, along };
}

function rebuildNavLegs() {
  const next = [];
  let cursor = 0;
  const full = [];
  for (const stop of state.stops) {
    const path = Array.isArray(stop.path)
      ? stop.path.map((pair) => [Number(pair?.[0]), Number(pair?.[1])]).filter((pair) => Number.isFinite(pair[0]) && Number.isFinite(pair[1]))
      : [];
    if (path.length < 2) continue;
    if (full.length && path[0][0] === full[full.length - 1][0] && path[0][1] === full[full.length - 1][1]) full.push(...path.slice(1));
    else full.push(...path);
    const meters = polylineMeters(path);
    next.push({ stop, path, start: cursor, end: cursor + meters });
    cursor += meters;
  }
  navLine = full;
  navLegs = next;
}

function passedManeuver(step) {
  const text = String(step?.text || "");
  if (/\b(continue|head|depart|arrive)\b/i.test(text)) return false;
  return /\b(turn|u-turn|exit|ramp|roundabout|keep)\b/i.test(text);
}

function navStep(leg, alongInLeg) {
  const steps = Array.isArray(leg.stop.directions) ? leg.stop.directions : [];
  if (!steps.length) return null;
  const lengths = steps.map(stepLengthMeters);
  const sum = lengths.reduce((total, length) => total + length, 0);
  const total = polylineMeters(leg.path);
  const scale = sum > 1 ? total / sum : 1;
  let cursor = 0;
  for (let i = 0; i < steps.length; i += 1) {
    const len = lengths[i] * scale;
    if (alongInLeg <= cursor + Math.max(len, 1) || i === steps.length - 1) {
      const index = passedManeuver(steps[i]) && i + 1 < steps.length ? i + 1 : i;
      return { step: steps[index], index };
    }
    cursor += len;
  }
  return { step: steps[0], index: 0 };
}

function navRemaining(fromAlong, toAlong) {
  if (navLine.length < 2 || toAlong <= fromAlong) return [];
  let walked = 0;
  let started = false;
  const coords = [];
  const push = (pair) => {
    const prev = coords[coords.length - 1];
    if (prev && prev[0] === pair[1] && prev[1] === pair[0]) return;
    coords.push([pair[1], pair[0]]);
  };
  for (let i = 1; i < navLine.length; i += 1) {
    const seg = metersBetween(navLine[i - 1], navLine[i]);
    const segEnd = walked + seg;
    const at = (t) => [
      navLine[i - 1][0] + (navLine[i][0] - navLine[i - 1][0]) * t,
      navLine[i - 1][1] + (navLine[i][1] - navLine[i - 1][1]) * t,
    ];
    if (!started && segEnd >= fromAlong) {
      push(at(seg > 0 ? Math.min(1, Math.max(0, (fromAlong - walked) / seg)) : 0));
      started = true;
    }
    if (started) {
      if (segEnd >= toAlong) {
        push(at(seg > 0 ? Math.min(1, Math.max(0, (toAlong - walked) / seg)) : 1));
        break;
      }
      push(navLine[i]);
    }
    walked = segEnd;
  }
  return coords;
}

function paintNavLine(along, until) {
  const source = routeMap?.getSource("left");
  if (!source) return;
  const coordinates = navRemaining(along, until);
  source.setData({
    type: "Feature",
    geometry: { type: "LineString", coordinates: coordinates.length >= 2 ? coordinates : [] },
  });
}

let spokenStepKey = "";
let spokenTurnKey = "";
const spokenMiles = new Set();

function unlockNavVoice() {
  const synth = window.speechSynthesis;
  if (!synth) return;
  synth.resume();
  const utter = new SpeechSynthesisUtterance("Navigation on.");
  utter.lang = "en-US";
  synth.speak(utter);
}

function speakNav(text) {
  const synth = window.speechSynthesis;
  if (!synth || !navOn || !text) return;
  synth.resume();
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = "en-US";
  utter.rate = 1;
  synth.speak(utter);
}

function resetNavVoice() {
  spokenStepKey = "";
  spokenTurnKey = "";
  spokenMiles.clear();
  window.speechSynthesis?.cancel();
}

function spokenGoFor(meters) {
  const miles = meters / 1609.344;
  if (miles < 0.1) {
    const feet = Math.max(1, Math.round(meters * 3.28084));
    return `for ${feet} ${feet === 1 ? "foot" : "feet"}`;
  }
  const rounded = miles >= 100 ? Math.round(miles) : Math.round(miles * 10) / 10;
  const unit = rounded === 1 ? "mile" : "miles";
  return `for ${rounded} ${unit}`;
}

function withoutGo(text) {
  return String(text || "").trim()
    .replace(/\.\s*Go for\b/gi, " for")
    .replace(/\bGo for\b/gi, "for")
    .replace(/\s+/g, " ")
    .trim();
}

function directionWithMilesLeft(text, metersLeft) {
  const phrase = spokenGoFor(metersLeft);
  const body = String(text || "").trim();
  const goFor = /\.\s*Go for\s+[0-9][0-9,]*(?:\.[0-9]+)?\s*(?:mi|ft|feet|mile|miles)\b\.?/i;
  const goForBare = /\bGo for\s+[0-9][0-9,]*(?:\.[0-9]+)?\s*(?:mi|ft|feet|mile|miles)\b\.?/i;
  if (goFor.test(body)) return body.replace(goFor, ` ${phrase}`).replace(/\s+/g, " ").trim();
  if (goForBare.test(body)) return body.replace(goForBare, phrase).replace(/\s+/g, " ").trim();
  const cleaned = body.replace(/\.\s*$/, "");
  return cleaned ? `${cleaned} ${phrase}` : phrase;
}

function speakNavProgress(leg, found, hereAlong) {
  if (!found || !leg?.stop?.id) return;
  const stepKey = `${leg.stop.id}:${found.index}`;
  const leftMeters = metersLeftInStep(leg, hereAlong - leg.start, found.index);
  const miles = leftMeters / 1609.344;
  const text = String(found.step?.text || "").trim();
  const phrase = () => directionWithMilesLeft(text, leftMeters);
  if (stepKey !== spokenStepKey) {
    spokenStepKey = stepKey;
    spokenMiles.clear();
    for (const band of [5, 3, 2, 1]) {
      if (miles < band - 0.15 || (miles <= band && miles > band - 0.4)) spokenMiles.add(band);
    }
    if (text) {
      window.speechSynthesis?.cancel();
      speakNav(phrase());
    }
  }
  for (const band of [5, 3, 2, 1]) {
    if (spokenMiles.has(band) || miles > band || miles <= band - 0.4) continue;
    spokenMiles.add(band);
    speakNav(phrase());
    break;
  }
}

let placeAt = null;
let placeText = "";
let placeBusy = false;

function paintPlace(text) {
  const chip = document.getElementById("routePlace");
  if (!chip) return;
  chip.hidden = !text;
  chip.textContent = text || "";
}

function driveLeftText(alongMeters) {
  const totalMiles = Number(state.plan?.miles);
  const totalHours = Number(state.plan?.driveHours);
  if (!(totalMiles > 0) || !(totalHours > 0)) return "";
  let hours = totalHours;
  if (navOn && navLine.length >= 2 && Number.isFinite(alongMeters)) {
    const leftMiles = Math.max(0, (polylineMeters(navLine) - alongMeters) / 1609.344);
    hours = totalHours * Math.min(1, leftMiles / totalMiles);
  }
  return `${hoursLabel(Math.max(0, hours))} left`;
}

function paintDrive(alongMeters) {
  const chip = document.getElementById("routeDrive");
  if (!chip) return;
  const text = driveLeftText(alongMeters);
  chip.hidden = !text;
  chip.textContent = text;
}

function refreshPlace(lat, lon) {
  if (placeText) paintPlace(placeText);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || placeBusy) return;
  if (placeAt && placeText && metersBetween(placeAt, [lat, lon]) < 8000) return;
  placeBusy = true;
  whereCity(lat, lon).then((data) => {
    const city = String(data?.city || "").trim();
    const state = String(data?.state || "").trim();
    const text = [city, state].filter(Boolean).join(", ");
    if (!text) return;
    placeAt = [lat, lon];
    placeText = text;
    paintPlace(text);
  }).catch(() => {}).finally(() => {
    placeBusy = false;
  });
}

function sayNav(title, sub, note) {
  const head = document.getElementById("routeNavTitle");
  const detail = document.getElementById("routeNavDetail");
  const status = document.getElementById("routeNavNote");
  if (head) head.textContent = title;
  if (detail) detail.textContent = sub;
  if (status) status.textContent = note || "";
}

let directionsAutoKey = "";

function openDirectionsNear(stopId, index, metersLeft) {
  if (!routeFull || metersLeft / 1609.344 > 5) return;
  const list = document.getElementById("routeDirections");
  if (!list || list.open) return;
  const key = `${stopId}:${index}`;
  if (directionsAutoKey === key) return;
  directionsAutoKey = key;
  list.open = true;
}

function placeDirections(full) {
  const list = document.getElementById("routeDirections");
  const home = document.getElementById("routeDirectionsHome");
  const miles = document.getElementById("routeStopMiles");
  if (!list || !home || !miles) return;
  if (full) miles.after(list);
  else home.after(list);
}

function syncRouteChrome() {
  const stage = document.getElementById("routeStage");
  if (stage) stage.classList.toggle("is-full", routeFull);
  document.documentElement.classList.toggle("route-full", routeFull);
  document.body.classList.toggle("route-full", routeFull);
  const full = document.getElementById("routeFull");
  if (full) full.hidden = routeFull;
  const exit = document.getElementById("routeExit");
  if (exit) exit.hidden = !routeFull;
  const truckRail = document.getElementById("routeTruck");
  if (truckRail) {
    truckRail.hidden = !routeFull;
    truckRail.disabled = state.estimating || (!state.unlimited && state.credits === 0);
  }
  const follow = document.getElementById("routeFollow");
  if (follow) {
    follow.hidden = !navOn;
    follow.classList.toggle("on", navOn && navFollowing);
  }
  const ordinal = document.getElementById("routeStopOrdinal");
  const shown = chosenNavStop();
  if (ordinal) ordinal.textContent = ordinalStop(shown ? shown.cursor : navStopCursor);
  placeDirections(routeFull);
  syncTruckAdd();
  const start = document.getElementById("startNav");
  if (start) {
    start.disabled = navOn;
    start.textContent = navOn ? "Navigation in progress" : "Start navigation";
  }
  syncTripFitButton();
  if (navOn) freezeTyping(true);
}

function safeTopPad() {
  const probe = document.createElement("div");
  probe.style.cssText = "position:absolute;visibility:hidden;padding-top:env(safe-area-inset-top);";
  document.documentElement.appendChild(probe);
  const pad = parseFloat(getComputedStyle(probe).paddingTop) || 0;
  probe.remove();
  return pad;
}

function pinRouteFull() {
  const stage = document.getElementById("routeStage");
  if (!stage || routeFull) return;
  stage.style.position = "";
  stage.style.top = "";
  stage.style.left = "";
  stage.style.right = "";
  stage.style.bottom = "";
  stage.style.width = "";
  stage.style.height = "";
  stage.style.transform = "";
  stage.style.margin = "";
  stage.style.zIndex = "";
}

function holdRouteSpace() {
  const stage = document.getElementById("routeStage");
  if (!stage || document.getElementById("routeHold")) return;
  const hold = document.createElement("div");
  hold.id = "routeHold";
  hold.style.height = `${stage.offsetHeight}px`;
  hold.style.margin = "0 12px 14px";
  stage.parentElement?.insertBefore(hold, stage);
}

function fitRouteCover() {
  const stage = document.getElementById("routeStage");
  if (!stage || !routeFull) return;
  const view = window.visualViewport;
  const lift = Math.max(safeTopPad(), view?.offsetTop || 0);
  const top = (window.scrollY || 0) + (view?.offsetTop || 0) - lift;
  const height = (view?.height || window.innerHeight) + lift;
  stage.style.position = "absolute";
  stage.style.top = `${Math.round(top)}px`;
  stage.style.left = "0px";
  stage.style.right = "auto";
  stage.style.bottom = "auto";
  stage.style.width = `${Math.round(view?.width || window.innerWidth)}px`;
  stage.style.height = `${Math.round(height)}px`;
  stage.style.margin = "0";
  stage.style.zIndex = "80";
}

function watchRouteCover(on) {
  const view = window.visualViewport;
  if (!view) return;
  view.removeEventListener("resize", fitRouteCover);
  view.removeEventListener("scroll", fitRouteCover);
  if (on) {
    view.addEventListener("resize", fitRouteCover);
    view.addEventListener("scroll", fitRouteCover);
  }
}

function placeRouteStage() {
  const stage = document.getElementById("routeStage");
  const dialog = document.getElementById("routeDialog");
  if (dialog?.open) dialog.close();
  if (!stage || !routeFull) {
    watchRouteCover(false);
    if (stage && (stage.parentElement === document.body || stage.parentElement === dialog)) {
      const home = document.querySelector(".result");
      if (home) home.insertBefore(stage, home.firstChild);
    }
    pinRouteFull();
    document.getElementById("routeHold")?.remove();
    return;
  }
  holdRouteSpace();
  if (stage.parentElement !== document.body) document.body.appendChild(stage);
  fitRouteCover();
  watchRouteCover(true);
}

function setRouteFull(on) {
  const next = Boolean(on);
  if (next === routeFull) return;
  const native = document.fullscreenElement || document.webkitFullscreenElement;
  if (!next && native) {
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    exit?.call(document)?.catch(() => {});
  }
  routeFull = next;
  placeRouteStage();
  syncRouteChrome();
  requestAnimationFrame(() => {
    if (routeFull) fitRouteCover();
    routeMap?.resize();
  });
}

function navDestList() {
  return state.stops
    .map((stop, index) => ({ stop, index }))
    .filter(({ stop }) => !stop.useCurrentLocation && pointReady(stop));
}

function chosenNavStop() {
  const dests = navDestList();
  if (!dests.length) return null;
  const cursor = ((navStopCursor % dests.length) + dests.length) % dests.length;
  return { ...dests[cursor], cursor };
}

function alongForChosen(chosen) {
  if (!chosen || chosen.stop?.skipRoute) return null;
  const leg = navLegs.find((item) => item.stop.id === chosen.stop.id);
  if (leg) return leg.end;
  const dests = navDestList();
  const pos = dests.findIndex((item) => item.stop.id === chosen.stop.id);
  for (let i = pos + 1; i < dests.length; i += 1) {
    const next = navLegs.find((item) => item.stop.id === dests[i].stop.id);
    if (next) return next.start;
  }
  return 0;
}

function ordinalStop(index) {
  const n = index + 1;
  const mod = n % 100;
  if (mod >= 11 && mod <= 13) return `${n}th`;
  if (n % 10 === 1) return `${n}st`;
  if (n % 10 === 2) return `${n}nd`;
  if (n % 10 === 3) return `${n}rd`;
  return `${n}th`;
}

let navStopTapAt = 0;
let tripFit = "off";

function tripFitWord() {
  if (tripFit === "remaining") return "Left";
  if (tripFit === "nextTurn") return "Turn";
  return "Trip";
}

function syncTripFitButton() {
  const button = document.getElementById("routeWhole");
  if (!button) return;
  button.textContent = tripFitWord();
  button.classList.toggle("on", tripFit !== "off");
}

function fitCoords(coordinates, maxZoom) {
  if (!routeMap || !window.maplibregl || coordinates.length < 2) return;
  const bounds = coordinates.reduce(
    (box, coord) => box.extend(coord),
    new window.maplibregl.LngLatBounds(coordinates[0], coordinates[0]),
  );
  routeMap.stop();
  routeMap.fitBounds(bounds, { padding: routeFull ? 80 : 48, maxZoom, bearing: 0, duration: 600 });
}

let turnFrameAt = null;

function upcomingTurn(hereAlong) {
  let fallback = null;
  for (const leg of navLegs) {
    const steps = Array.isArray(leg.stop?.directions) ? leg.stop.directions : [];
    const lengths = steps.map(stepLengthMeters);
    const sum = lengths.reduce((total, length) => total + length, 0);
    const total = Math.max(0, leg.end - leg.start);
    const scale = sum > 1 ? total / sum : 1;
    let along = leg.start;
    for (let i = 0; i < steps.length; i += 1) {
      if (along > hereAlong + 8) return { along, stop: leg.stop, index: i };
      along += (lengths[i] || 0) * scale;
    }
    if (leg.end > hereAlong + 8) fallback = { along: leg.end, stop: leg.stop, index: Math.max(0, steps.length - 1) };
  }
  if (fallback) return fallback;
  const last = navLegs[navLegs.length - 1];
  return last ? { along: last.end, stop: last.stop, index: 0 } : null;
}

function frameNextTurn() {
  const maplibre = window.maplibregl;
  if (!routeMap || !maplibre) return;
  rebuildNavLegs();
  if (!navFix || navLine.length < 2) return;
  if (turnFrameAt && metersBetween(turnFrameAt, navFix) < 20) return;
  const hit = navNearest(navFix[0], navFix[1], navLine);
  const turn = upcomingTurn(hit.along);
  if (!turn) return;
  const end = Math.min(polylineMeters(navLine), turn.along + 80);
  const coords = navRemaining(Math.min(hit.along, end), end);
  coords.push([navFix[1], navFix[0]]);
  const at = pointAlong(navLine, turn.along);
  if (at) coords.push([at.lon, at.lat]);
  if (coords.length < 2) return;
  turnFrameAt = [navFix[0], navFix[1]];
  if (turnMarker) turnMarker.remove();
  if (at) {
    const pin = document.createElement("span");
    pin.className = "turn-pin";
    turnMarker = new maplibre.Marker({ element: pin, anchor: "center" }).setLngLat([at.lon, at.lat]).addTo(routeMap);
  }
  const bounds = coords.reduce(
    (box, coord) => box.extend(coord),
    new maplibre.LngLatBounds(coords[0], coords[0]),
  );
  const pad = routeFull ? 88 : 56;
  routeMap.stop();
  routeMap.fitBounds(bounds, {
    padding: { top: pad, right: pad + 36, bottom: pad, left: pad },
    maxZoom: 17,
    bearing: navCompass != null ? navCompass : routeMap.getBearing(),
    duration: 700,
  });
}

function changeMapZoom(delta) {
  if (!routeMap) return;
  navZoomHold = Date.now() + 1200;
  routeMap.stop();
  navZoom = Math.min(18, Math.max(3, routeMap.getZoom() + delta * 2));
  const camera = { zoom: navZoom, duration: 200 };
  if (navFollowing && navFix) camera.center = [navFix[1], navFix[0]];
  routeMap.easeTo(camera);
}

function holdUserZoom(event) {
  if (!event.originalEvent || !routeMap) return;
  navZoom = routeMap.getZoom();
  navZoomHold = Date.now() + 1200;
}

function cycleTripFit() {
  window.clearTimeout(navReturnTimer);
  navReturnTimer = 0;
  navFollowing = false;
  syncRouteChrome();
  if (tripFit === "off" || tripFit === "nextTurn") tripFit = "full";
  else if (tripFit === "full") tripFit = "remaining";
  else tripFit = "nextTurn";
  syncTripFitButton();
  if (tripFit === "full") {
    showWholeTrip();
    return;
  }
  rebuildNavLegs();
  if (tripFit === "remaining") {
    const from = navFix && navLine.length >= 2 ? navNearest(navFix[0], navFix[1], navLine).along : 0;
    const until = alongForChosen(chosenNavStop());
    fitCoords(navRemaining(from, until == null ? Infinity : until), 14);
    return;
  }
  turnFrameAt = null;
  frameNextTurn();
}

function liveDirection() {
  if (!navOn || !navFix || navLine.length < 2) {
    const stop = state.stops.find((item) => Array.isArray(item.directions) && item.directions.length);
    return stop ? { stopId: stop.id, index: 0 } : null;
  }
  const hit = navNearest(navFix[0], navFix[1], navLine);
  const leg = navLegs.find((item) => hit.along >= item.start && hit.along <= item.end) || navLegs[navLegs.length - 1];
  const found = leg ? navStep(leg, Math.max(0, hit.along - leg.start)) : null;
  if (!found || !leg?.stop?.id) return null;
  return { stopId: leg.stop.id, index: found.index };
}

function metersLeftInStep(leg, alongInLeg, index) {
  const steps = Array.isArray(leg?.stop?.directions) ? leg.stop.directions : [];
  const lengths = steps.map(stepLengthMeters);
  const sum = lengths.reduce((total, length) => total + length, 0);
  const total = polylineMeters(leg.path);
  const scale = sum > 1 ? total / sum : 1;
  let cursor = 0;
  for (let i = 0; i < index; i += 1) cursor += (lengths[i] || 0) * scale;
  const length = (lengths[index] || 0) * scale;
  return Math.max(0, length - Math.max(0, alongInLeg - cursor));
}

function paintDirectionMiles(stopId, index, meters) {
  document.querySelectorAll("[data-dir-stop]").forEach((button) => {
    const current = button.getAttribute("data-dir-stop") === stopId && button.getAttribute("data-dir-index") === String(index);
    const link = button.querySelector(".dir-link");
    const slot = button.querySelector(".dir-miles");
    const original = link?.getAttribute("data-original") || "";
    if (!current) {
      if (link && original) link.textContent = withoutGo(original);
      if (slot?.getAttribute("data-full")) slot.textContent = slot.getAttribute("data-full");
      return;
    }
    if (link && original) link.textContent = directionWithMilesLeft(original, meters);
    if (slot) slot.textContent = "";
  });
}

function cycleNavStop(event) {
  const now = Date.now();
  if (now - navStopTapAt < 400) return;
  navStopTapAt = now;
  event?.preventDefault();
  event?.stopPropagation();
  const dests = navDestList();
  if (dests.length < 2) return;
  navStopCursor = (navStopCursor + 1) % dests.length;
  syncRouteChrome();
  turnFrameAt = null;
  window.clearTimeout(navReturnTimer);
  navReturnTimer = 0;
  if (tripFit !== "nextTurn") navFollowing = true;
  syncRouteChrome();
  if (!navOn) {
    unlockNavVoice();
    beginRouteNav();
  }
  else if (navFix) onNavFix(navFix[0], navFix[1]);
  else applyChosenStop();
}

function applyChosenStop() {
  rebuildNavLegs();
  const chosen = chosenNavStop();
  if (!chosen) return;
  const until = alongForChosen(chosen);
  const name = navStopTitle(chosen.stop);
  if (chosen.stop?.skipRoute) sayNav(`Head back to ${name}`, "Recalculate to turn around.", "");
  else sayNav(`Head to ${name}`, until == null ? "" : `${navMiles(until)} to ${name}`, "");
  if (until != null) paintNavLine(0, until);
}

function currentFix() {
  if (navFix) return Promise.resolve({ lat: navFix[0], lon: navFix[1] });
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      resolve(null);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const heading = pos.coords.heading;
        resolve({
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          heading: typeof heading === "number" ? heading : undefined,
        });
      },
      () => resolve(null),
      { enableHighAccuracy: true, maximumAge: 4000, timeout: 15000 },
    );
  });
}

async function recalculateFromHere() {
  const here = await currentFix();
  if (!here) {
    state.error = "Allow location first, then Recalculate.";
    state.notice = "";
    render();
    return;
  }
  const chosen = chosenNavStop();
  const kept = state.stops.filter((stop) => !stop.useCurrentLocation);
  const chosenPos = chosen ? kept.findIndex((stop) => stop.id === chosen.stop.id) : 0;
  kept.forEach((stop, index) => {
    stop.skipRoute = chosenPos > 0 && index < chosenPos;
  });
  state.origin = {
    lat: here.lat,
    lon: here.lon,
    ...(typeof here.heading === "number" ? { heading: here.heading } : {}),
  };
  state.stops = [
    defaultStop({
      name: "Current location",
      useCurrentLocation: true,
      lat: here.lat,
      lon: here.lon,
      address: "",
    }),
    ...kept,
  ];
  navStopCursor = Math.max(0, chosenPos);
  await calculate();
}

function thinRoute(points, gap, maxCount) {
  if (points.length <= 2) return points;
  const kept = [points[0]];
  let last = points[0];
  for (let i = 1; i < points.length - 1; i += 1) {
    if (metersBetween(last, points[i]) >= gap) {
      kept.push(points[i]);
      last = points[i];
    }
  }
  kept.push(points[points.length - 1]);
  if (kept.length <= maxCount) return kept;
  const step = Math.ceil(kept.length / maxCount);
  const sampled = kept.filter((_, index) => index % step === 0);
  const end = kept[kept.length - 1];
  if (sampled[sampled.length - 1] !== end) sampled.push(end);
  return sampled;
}

function routeAheadPoints() {
  rebuildNavLegs();
  const line = navLine.length >= 2 ? navLine : routePoints();
  if (line.length < 2) return [];
  const from = navFix ? navNearest(navFix[0], navFix[1], line).along : 0;
  const coords = [];
  let walked = 0;
  const push = (pair) => {
    const prev = coords[coords.length - 1];
    if (prev && prev[0] === pair[0] && prev[1] === pair[1]) return;
    coords.push(pair);
  };
  for (let i = 1; i < line.length; i += 1) {
    const seg = metersBetween(line[i - 1], line[i]);
    const segEnd = walked + seg;
    if (segEnd >= from) {
      if (!coords.length) {
        const t = seg > 0 ? Math.min(1, Math.max(0, (from - walked) / seg)) : 0;
        push([
          line[i - 1][0] + (line[i][0] - line[i - 1][0]) * t,
          line[i - 1][1] + (line[i][1] - line[i - 1][1]) * t,
        ]);
      }
      push(line[i]);
    }
    walked = segEnd;
  }
  return thinRoute(coords, 1609, 300);
}

function truckNoteText(hit) {
  const place = [hit.city, hit.state].filter(Boolean).join(", ");
  const ahead = Number.isFinite(Number(hit.milesAhead)) ? `${formatMiles(hit.milesAhead)} ahead` : "";
  const off = Number.isFinite(Number(hit.milesOff)) ? `${formatMiles(hit.milesOff)} off the route` : "";
  return [hit.name, place, ahead, off].filter(Boolean).join(" · ");
}

function frameTruckStop(hit) {
  const maplibre = window.maplibregl;
  const lat = Number(hit?.lat);
  const lon = Number(hit?.lon);
  if (!routeMap || !maplibre || !navFix || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
  navFollowing = false;
  tripFit = "off";
  window.clearTimeout(navReturnTimer);
  navReturnTimer = 0;
  syncRouteChrome();
  if (truckMarker) truckMarker.remove();
  const wrap = document.createElement("span");
  wrap.className = "truck-pin-wrap";
  const label = document.createElement("span");
  label.className = "truck-pin-label";
  const name = document.createElement("span");
  name.textContent = hit.name || "Truck stop";
  const miles = document.createElement("span");
  const ahead = Number(hit.milesAhead);
  const meters = Number.isFinite(ahead)
    ? ahead * 1609.344
    : metersBetween(navFix, [lat, lon]);
  miles.textContent = navMiles(meters);
  label.append(name, miles);
  const pin = document.createElement("span");
  pin.className = "truck-pin";
  wrap.append(label, pin);
  truckMarker = new maplibre.Marker({ element: wrap, anchor: "bottom" }).setLngLat([lon, lat]).addTo(routeMap);
  const coordinates = [[navFix[1], navFix[0]], [lon, lat]];
  const bounds = coordinates.reduce(
    (box, coord) => box.extend(coord),
    new maplibre.LngLatBounds(coordinates[0], coordinates[0]),
  );
  routeMap.stop();
  routeMap.fitBounds(bounds, {
    padding: { top: 120, bottom: 120, left: 88, right: 88 },
    maxZoom: 15,
    bearing: 0,
    duration: 600,
  });
}

function showTruckHit(hit) {
  truckHit = hit;
  const note = document.getElementById("nextTruckNote");
  const add = document.getElementById("addTruckStop");
  if (note) {
    note.hidden = !hit;
    note.textContent = hit ? truckNoteText(hit) : "";
  }
  if (add) add.hidden = !hit;
  syncTruckAdd();
}

function syncTruckAdd() {
  const add = document.getElementById("routeTruckAdd");
  if (add) add.hidden = !(routeFull && truckHit);
}

function addTruckAsNextStop() {
  const hit = truckHit;
  const lat = Number(hit?.lat);
  const lon = Number(hit?.lon);
  if (!hit || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
  const place = [hit.city, hit.state].filter(Boolean).join(", ");
  const label = String(hit.label || [hit.name, place].filter(Boolean).join(", "));
  const chosen = chosenNavStop();
  const index = chosen ? chosen.index : state.stops.length;
  const next = defaultStop({
    name: hit.name || "Truck stop",
    address: label,
    verifiedLabel: label,
    lat,
    lon,
    anytime: true,
    window: false,
  });
  const previous = state.stops[index - 1];
  if (previous && !previous.useCurrentLocation) {
    next.start = previous.start + 4 * 3600 * 1000;
    next.end = next.start;
  }
  state.stops.splice(index, 0, next);
  const cursor = navDestList().findIndex((item) => item.stop.id === next.id);
  if (cursor >= 0) navStopCursor = cursor;
  truckHit = null;
  persist();
  const note = document.getElementById("nextTruckNote");
  const add = document.getElementById("addTruckStop");
  if (note) {
    note.hidden = false;
    note.textContent = "Added as the next stop. Recalculate to put it on the route.";
  }
  if (add) add.hidden = true;
  const calc = document.getElementById("calculate");
  if (calc) calc.innerHTML = calculateButtonLabel();
  const ordinal = document.getElementById("routeStopOrdinal");
  if (ordinal) ordinal.textContent = ordinalStop(navStopCursor);
  syncTruckAdd();
}

async function addTruckAndRecalculate() {
  if (!truckHit) return;
  addTruckAsNextStop();
  await recalculateFromHere();
}

async function findNextTruckStop(options = {}) {
  const button = document.getElementById("nextTruck");
  const rail = document.getElementById("routeTruck");
  const note = document.getElementById("nextTruckNote");
  const add = document.getElementById("addTruckStop");
  if (button) button.disabled = true;
  if (rail) rail.disabled = true;
  if (add) add.hidden = true;
  truckHit = null;
  if (note) {
    note.hidden = false;
    note.textContent = "Looking for the next truck stop…";
  }
  try {
    if (!navFix) {
      const here = await currentFix();
      if (here) navFix = [here.lat, here.lon];
    }
    const points = routeAheadPoints();
    if (points.length < 2) throw new Error("Calculate the trip first.");
    const data = await nextTruckStop(points);
    if (data.credits != null) state.credits = data.credits;
    const calc = document.getElementById("calculate");
    if (calc) calc.innerHTML = calculateButtonLabel();
    const lat = Number(data.lat);
    const lon = Number(data.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error("That truck stop has no map point.");
    showTruckHit({
      name: data.name,
      city: data.city,
      state: data.state,
      label: data.label,
      lat,
      lon,
      milesAhead: data.milesAhead,
      milesOff: data.milesOff,
    });
    if (options.frame) frameTruckStop(truckHit);
  } catch (error) {
    if (error.credits != null) state.credits = error.credits;
    const calc = document.getElementById("calculate");
    if (calc) calc.innerHTML = calculateButtonLabel();
    truckHit = null;
    if (add) add.hidden = true;
    if (note) note.textContent = error.message || "No truck stop within 2 miles of the route.";
  } finally {
    const blocked = state.estimating || (!state.unlimited && state.credits === 0);
    if (button) button.disabled = blocked;
    if (rail) rail.disabled = blocked;
  }
}

function showWholeTrip() {
  navFollowing = false;
  window.clearTimeout(navReturnTimer);
  navReturnTimer = 0;
  if (!routeMap) return;
  const coordinates = routePoints().map(([lat, lon]) => [lon, lat]);
  routePins().forEach((pin) => coordinates.push([pin.lon, pin.lat]));
  if (coordinates.length < 2 || !window.maplibregl) return;
  const bounds = coordinates.reduce(
    (box, coord) => box.extend(coord),
    new window.maplibregl.LngLatBounds(coordinates[0], coordinates[0]),
  );
  routeMap.stop();
  routeMap.fitBounds(bounds, { padding: routeFull ? 80 : 48, maxZoom: 14, bearing: 0, duration: 600 });
}

function stopNavMotion() {
  if (navMotion) cancelAnimationFrame(navMotion);
  navMotion = 0;
  navShown = null;
  navAim = null;
  navTravel = null;
}

function placeNavDot(lat, lon) {
  const maplibre = window.maplibregl;
  if (!routeMap || !maplibre) return;
  if (!navYou) {
    const dot = document.createElement("span");
    dot.className = "route-you";
    navYou = new maplibre.Marker({ element: dot, anchor: "center" }).setLngLat([lon, lat]).addTo(routeMap);
  } else {
    navYou.setLngLat([lon, lat]);
  }
  navShown = { lat, lon };
}

function aimNavDot(lat, lon) {
  const from = navShown;
  if (!from) {
    placeNavDot(lat, lon);
    return;
  }
  if (metersBetween([from.lat, from.lon], [lat, lon]) > 300) {
    navAim = null;
    placeNavDot(lat, lon);
    return;
  }
  const now = performance.now();
  const dur = navAim ? Math.min(1100, Math.max(200, now - navAim.start)) : 1000;
  navAim = { lat, lon, fromLat: from.lat, fromLon: from.lon, start: now, dur };
}

function paintNavMotion(now) {
  if (!navOn) {
    navMotion = 0;
    return;
  }
  if (navAim && navYou) {
    const u = Math.min(1, (now - navAim.start) / navAim.dur);
    const lat = navAim.fromLat + (navAim.lat - navAim.fromLat) * u;
    const lon = navAim.fromLon + (navAim.lon - navAim.fromLon) * u;
    navYou.setLngLat([lon, lat]);
    navShown = { lat, lon };
  }
  if (navFollowing && tripFit !== "nextTurn" && routeMap && navShown && Date.now() >= navZoomHold) {
    const camera = { center: [navShown.lon, navShown.lat], zoom: navZoom };
    if (navCompass != null) camera.bearing = navCompass;
    else if (navTravel != null) camera.bearing = navTravel;
    routeMap.jumpTo(camera);
  }
  navMotion = requestAnimationFrame(paintNavMotion);
}

function startNavMotion() {
  if (navMotion) return;
  navMotion = requestAnimationFrame(paintNavMotion);
}

function onNavFix(lat, lon) {
  const maplibre = window.maplibregl;
  if (!routeMap || !maplibre || !navOn) return;
  aimNavDot(lat, lon);
  startNavMotion();
  let travel = null;
  if (navFix && metersBetween(navFix, [lat, lon]) > 8) travel = navBearing(navFix, [lat, lon]);
  if (travel != null) navTravel = travel;
  navFix = [lat, lon];
  refreshPlace(lat, lon);
  rebuildNavLegs();
  if (navLine.length < 2) {
    paintDrive(null);
    setStopChip(-1, "");
    sayNav("No road line yet", "Calculate the trip, then start navigation again.", "");
  } else {
    const hit = navNearest(lat, lon, navLine);
    paintDrive(hit.along);
    const off = hit.dist > 250;
    const leg = navLegs.find((item) => hit.along >= item.start && hit.along <= item.end) || navLegs[navLegs.length - 1];
    const alongInLeg = leg ? hit.along - leg.start : 0;
    const found = !off && leg ? navStep(leg, alongInLeg) : null;
    const step = found?.step || null;
    const leftOnLeg = leg ? Math.max(0, leg.end - hit.along) : 0;
    const leftOnTrip = Math.max(0, polylineMeters(navLine) - hit.along);
  const chosen = chosenNavStop();
  const targetAlong = alongForChosen(chosen);
  const towardStop = chosen?.stop || leg?.stop;
  const toward = towardStop ? navStopTitle(towardStop) : "the stop";
  const until = targetAlong == null ? Infinity : targetAlong;
  const leftToStop = targetAlong == null ? leftOnLeg : Math.max(0, targetAlong - hit.along);
  if (chosen?.stop?.skipRoute) {
    setStopChip(-1, "");
    sayNav(`Head back to ${toward}`, "Recalculate to turn around.", "");
    paintNavLine(hit.along, Infinity);
  } else if (off) {
    setStopChip(-1, "");
    sayNav("Not on the route yet", `${navMiles(hit.dist)} from the line`, `${navMiles(leftOnTrip)} left in the trip`);
    paintNavLine(0, until);
  } else {
    const leftInStep = found && leg ? metersLeftInStep(leg, alongInLeg, found.index) : 0;
    const title = String(step?.text || "").trim();
    setStopChip(leftToStop, toward);
    sayNav(title ? directionWithMilesLeft(title, leftInStep) : `Continue to ${toward}`, `${navMiles(leftToStop)} to ${toward}`, `${navMiles(leftOnTrip)} left in the trip`);
    paintNavLine(hit.along, until);
      if (found && leg?.stop?.id) {
        markDirection(leg.stop.id, found.index);
        paintDirectionMiles(leg.stop.id, found.index, leftInStep);
        openDirectionsNear(leg.stop.id, found.index, leftInStep);
      }
      speakNavProgress(leg, found, hit.along);
    }
  }
  if (tripFit === "nextTurn") {
    if (Date.now() < navZoomHold) return;
    frameNextTurn();
    return;
  }
}

function onNavCompass(event) {
  let heading = null;
  if (typeof event.webkitCompassHeading === "number" && event.webkitCompassHeading >= 0) {
    heading = event.webkitCompassHeading;
  } else if (event.absolute && typeof event.alpha === "number") {
    heading = (360 - event.alpha) % 360;
  }
  if (heading == null || Number.isNaN(heading)) return;
  navCompass = heading;
  if (!navOn || !routeMap || !navFix) return;
  if (Date.now() < navZoomHold) return;
  const now = Date.now();
  if (now - navCompassTimer < 120) return;
  navCompassTimer = now;
  if (tripFit === "nextTurn") {
    routeMap.easeTo({ bearing: navCompass, duration: 120 });
  }
}

async function enableNavCompass() {
  const orientation = window.DeviceOrientationEvent;
  if (!orientation) return;
  if (typeof orientation.requestPermission === "function") {
    try {
      const result = await orientation.requestPermission();
      if (result !== "granted") return;
    } catch {
      return;
    }
  }
  window.removeEventListener("deviceorientation", onNavCompass);
  window.addEventListener("deviceorientation", onNavCompass);
}

function pauseFollowForDirection() {
  if (!navOn) return;
  navFollowing = false;
  syncRouteChrome();
  window.clearTimeout(navReturnTimer);
  navReturnTimer = window.setTimeout(() => {
    navReturnTimer = 0;
    if (!navOn || tripFit === "nextTurn") return;
    navFollowing = true;
    syncRouteChrome();
    if (navFix) onNavFix(navFix[0], navFix[1]);
  }, 5000);
}

function endRouteNav() {
  navOn = false;
  directionsAutoKey = "";
  setStopChip(-1, "");
  stopNavMotion();
  resetNavVoice();
  navFollowing = false;
  window.clearTimeout(navReturnTimer);
  navReturnTimer = 0;
  freezeTyping(false);
  if (navWatch != null && navigator.geolocation) {
    navigator.geolocation.clearWatch(navWatch);
    navWatch = null;
  }
  if (navYou) {
    navYou.remove();
    navYou = null;
  }
  window.removeEventListener("deviceorientation", onNavCompass);
  const source = routeMap?.getSource("left");
  if (source) {
    source.setData({ type: "Feature", geometry: { type: "LineString", coordinates: [] } });
  }
  if (routeMap) routeMap.easeTo({ bearing: 0, duration: 400 });
  syncRouteChrome();
}

function freezeTyping(freeze) {
  document.querySelectorAll("textarea, input").forEach((el) => {
    if (freeze) {
      if (el.disabled || el.dataset.undoFreeze === "1") return;
      el.dataset.undoFreeze = "1";
      el.disabled = true;
    } else if (el.dataset.undoFreeze === "1") {
      el.disabled = false;
      delete el.dataset.undoFreeze;
    }
  });
  const active = document.activeElement;
  if (active && active !== document.body && active.blur) active.blur();
}

function beginRouteNav() {
  navOn = true;
  navFollowing = true;
  navZoom = 15;
  freezeTyping(true);
  syncRouteChrome();
  document.getElementById("routeStage")?.scrollIntoView({ block: "nearest" });
  sayNav("Finding you…", "Allow location to move along this trip.", "");
  if (navWatch == null && navigator.geolocation) {
    navWatch = navigator.geolocation.watchPosition(
      (pos) => onNavFix(pos.coords.latitude, pos.coords.longitude),
      () => sayNav("Allow location", "Planigator needs location to show you on this trip.", ""),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 },
    );
  } else if (navFix) {
    onNavFix(navFix[0], navFix[1]);
  }
  enableNavCompass();
  startNavMotion();
}

function applyTurnZoom(map, focus) {
  const maplibre = window.maplibregl;
  if (!map || !maplibre || !focus) return;
  if (turnMarker) turnMarker.remove();
  const pin = document.createElement("span");
  pin.className = "turn-pin";
  turnMarker = new maplibre.Marker({ element: pin, anchor: "center" })
    .setLngLat([focus.lon, focus.lat])
    .addTo(map);
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const coords = focus.coords?.length ? focus.coords : [[focus.lat, focus.lon]];
  const bounds = coords.reduce(
    (box, pair) => box.extend([pair[1], pair[0]]),
    new maplibre.LngLatBounds([coords[0][1], coords[0][0]], [coords[0][1], coords[0][0]]),
  );
  const span = Math.max(
    metersBetween([bounds.getSouth(), bounds.getWest()], [bounds.getNorth(), bounds.getWest()]),
    metersBetween([bounds.getSouth(), bounds.getWest()], [bounds.getSouth(), bounds.getEast()]),
  );
  const turnBearing = navCompass != null ? navCompass : map.getBearing();
  if (span < 30) {
    map.easeTo({
      center: [focus.lon, focus.lat],
      zoom: 16,
      bearing: turnBearing,
      duration: reduce ? 0 : 800,
    });
  } else {
    map.fitBounds(bounds, {
      padding: 64,
      maxZoom: 16,
      bearing: turnBearing,
      animate: !reduce,
      duration: reduce ? 0 : 800,
    });
  }
  pendingTurn = null;
}

function markDirection(stopId, index) {
  document.querySelectorAll(".dir-step.on").forEach((button) => {
    button.classList.remove("on");
    button.removeAttribute("aria-pressed");
  });
  const button = [...document.querySelectorAll("[data-dir-stop]")].find((item) => (
    item.getAttribute("data-dir-stop") === stopId && item.getAttribute("data-dir-index") === String(index)
  ));
  if (!button) return null;
  button.classList.add("on");
  button.setAttribute("aria-pressed", "true");
  revealDirection(button);
  return button;
}

function revealDirection(button) {
  const list = button?.closest(".dir-scroll");
  if (!list) return;
  const listBox = list.getBoundingClientRect();
  const buttonBox = button.getBoundingClientRect();
  const delta = (buttonBox.top + buttonBox.height / 2) - (listBox.top + listBox.height / 2);
  list.scrollTop += delta;
}

function zoomToDirection(stopId, index) {
  const stop = state.stops.find((item) => item.id === stopId);
  const focus = directionFocus(stop, Number(index));
  if (!focus) return;
  markDirection(stopId, index);
  const button = [...document.querySelectorAll("[data-dir-stop]")].find((item) => (
    item.getAttribute("data-dir-stop") === stopId && item.getAttribute("data-dir-index") === String(index)
  ));
  revealDirection(button);
  if (!routeMap) return;
  if (routeMapReady) applyTurnZoom(routeMap, focus);
  else pendingTurn = focus;
}

function mountMap() {
  clearRouteMap();
  const el = document.getElementById("routeMap");
  const maplibre = window.maplibregl;
  if (!el || !maplibre) return;
  const line = routePoints();
  if (line.length < 2) {
    el.hidden = true;
    return;
  }
  const map = new maplibre.Map({
    container: el,
    style: satelliteStyle,
    attributionControl: false,
  });
  routeMap = map;
  el.querySelectorAll(".route-rail").forEach((node) => el.appendChild(node));
  map.addControl(new maplibre.AttributionControl({ compact: false }), "bottom-right");
  map.on("load", () => {
    if (routeMap !== map) return;
    const coordinates = line.map(([lat, lon]) => [lon, lat]);
    map.addSource("route", {
      type: "geojson",
      data: { type: "Feature", geometry: { type: "LineString", coordinates } },
    });
    map.addLayer({
      id: "route-casing",
      type: "line",
      source: "route",
      paint: { "line-color": "#ffffff", "line-width": 7 },
    });
    map.addLayer({
      id: "route",
      type: "line",
      source: "route",
      paint: { "line-color": "#1f8a62", "line-width": 4 },
    });
    map.addSource("left", {
      type: "geojson",
      data: { type: "Feature", geometry: { type: "LineString", coordinates: [] } },
    });
    map.addLayer({
      id: "left",
      type: "line",
      source: "left",
      paint: { "line-color": "#3dcaa0", "line-width": 6 },
    });
    map.on("pointerdown", (event) => {
      if (!event.originalEvent) return;
      navZoomHold = Date.now() + 1500;
      map.stop();
    });
    map.on("dragstart", () => {
      navFollowing = false;
      const follow = document.getElementById("routeFollow");
      if (follow) follow.classList.toggle("on", false);
    });
    map.on("zoomstart", holdUserZoom);
    map.on("zoom", holdUserZoom);
    const bounds = coordinates.reduce((box, coord) => box.extend(coord), new maplibre.LngLatBounds(coordinates[0], coordinates[0]));
    const markers = routePins().map((pin) => {
      const ink = stopInk(pin.rgb);
      const button = document.createElement("span");
      button.className = "route-pin";
      button.textContent = pin.label;
      button.style.background = cssRGB(pin.rgb);
      button.style.color = ink.color;
      const marker = new maplibre.Marker({ element: button, anchor: "bottom" })
        .setLngLat([pin.lon, pin.lat])
        .addTo(map);
      bounds.extend([pin.lon, pin.lat]);
      return marker;
    });
    routeMapReady = true;
    if (pendingTurn) applyTurnZoom(map, pendingTurn);
    else map.fitBounds(bounds, { padding: 48, maxZoom: 8, animate: false });
    map.once("idle", () => {
      if (routeMap !== map) return;
      const placed = [];
      markers.forEach((marker) => {
        const point = map.project(marker.getLngLat());
        let lift = 0;
        for (const other of placed) {
          if (Math.abs(other.x - point.x) < 72 && Math.abs(other.y - (point.y - lift)) < 26) lift += 26;
        }
        if (lift) marker.setOffset([0, -lift]);
        placed.push({ x: point.x, y: point.y - lift });
      });
    });
  });
}

function routePins() {
  const pins = [];
  state.stops.forEach((stop, index) => {
    const here = stop.useCurrentLocation ? originPoint() : null;
    const lat = here ? here.lat : Number(stop.lat);
    const lon = here ? here.lon : Number(stop.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    const label = stop.useCurrentLocation ? "Now" : cardTitle(index, state.stops);
    pins.push({ lat, lon, label, rgb: stopColor(index, state.stops) });
  });
  return pins;
}

function leewayDays(hours) {
  const totalMinutes = Math.max(0, Math.round(Number(hours) * 60));
  const days = Math.trunc(totalMinutes / (24 * 60));
  const rest = totalMinutes % (24 * 60);
  const h = Math.trunc(rest / 60);
  const m = rest % 60;
  const dayLabel = days === 1 ? "1 day" : `${days} days`;
  return `${dayLabel} ${h} hr ${m} min`;
}

function chip(event) {
  const ink = stopInk(event.rgb);
  const miles = event.miles != null && event.miles > 0.05 ? formatMiles(event.miles) : "";
  const restMinutes = Math.round(Number(event.tripHours) * 60);
  const hideHours = event.kind === "thirty" || (event.kind === "rest" && state.settings.endAnytime && restMinutes <= 10 * 60);
  const hours = event.tripHours != null && !hideHours ? hoursLabel(event.tripHours) : "";
  const middle = event.kind === "leeway" && hours
    ? `${hours} / ${leewayDays(event.tripHours)}`
    : [hours, miles].filter(Boolean).join(" · ");
  const span = event.end && event.end !== event.start
    ? `${formatShort(event.start)} – ${formatShort(event.end)}`
    : formatShort(event.start);
  const toward = event.title && event.kind !== "stop" ? `Toward ${event.title}` : "";
  const phrase = event.kind === "rest" ? "10-hour reset/Off-duty" : (event.timePhrase || "");
  const label = [phrase, toward].filter(Boolean).join(" · ");
  const arrive = event.arrivalPhrase && event.earliestArrive
    ? `${event.arrivalPhrase} ${formatShort(event.earliestArrive)}`
    : "";
  const section = (text, extra = "") => text
    ? `<div class="chip-sec${extra ? ` ${extra}` : ""}">${escapeAttr(text)}</div>`
    : "";
  return `
    <div class="chip ${event.kind}" style="background:${cssRGB(event.rgb)};color:${ink.color}">
      ${section(label)}
      ${section(middle)}
      ${section(span)}
      ${section(arrive, event.late ? "late" : "")}
    </div>
  `;
}

function eventsAround(stopId) {
  const events = state.plan?.events || [];
  const self = events.find((event) => event.id === stopId);
  const mine = events.filter((event) => event.stopID === stopId && event.id !== stopId && event.kind !== "leeway");
  return {
    before: [
      ...mine.filter((event) => !self || event.start < self.start),
      ...events.filter((event) => event.kind === "leeway" && event.stopID === stopId && event.after !== -1 && self && event.start < self.start),
    ].sort((a, b) => a.start - b.start),
    self,
    following: mine.filter((event) => self && event.start >= self.start).sort((a, b) => a.start - b.start),
    after: events.filter((event) => event.kind === "leeway" && event.stopID === stopId && event.after !== -1 && (!self || event.start >= self.start)),
    now: events.filter((event) => event.kind === "leeway" && event.after === -1),
  };
}

function leewayInto(stopId) {
  const dests = destinations();
  const pos = dests.findIndex((item) => item.id === stopId);
  if (pos <= 0) return [];
  const prevId = dests[pos - 1].id;
  return (state.plan?.events || []).filter((event) => event.kind === "leeway" && event.stopID === prevId && event.after !== -1);
}

function stopCard(stop, index) {
  const dests = destinations();
  const destIndex = dests.findIndex((item) => item.id === stop.id);
  const originStop = isOriginStop(state.stops, index);
  const rgb = stopColor(index, state.stops);
  const ink = stopInk(rgb);
  const around = eventsAround(stop.id);
  const title = cardTitle(index, state.stops);
  const typedAddress = (stop.address || "").trim();
  const lookupFlash = typedAddress && typedAddress !== (stop.verifiedLabel || "").trim();
  const canRemove = stopCanRemove(index);
  return `
    <article class="stop-card" style="background:${cssRGB(rgb)};color:${ink.color}" data-stop="${stop.id}">
      <div class="stop-head">
        <label>
          <span class="sr">Stop name</span>
          <textarea class="plain" data-field="name" rows="1" placeholder="${escapeAttr(title)}" aria-label="Stop name">${escapeAttr(stop.name)}</textarea>
        </label>
        <div class="icon-row">
          <button type="button" class="ghost" data-act="up" ${originStop || destIndex <= 0 ? "disabled" : ""} aria-label="Move stop up">↑</button>
          <button type="button" class="ghost" data-act="down" ${originStop || destIndex >= dests.length - 1 ? "disabled" : ""} aria-label="Move stop down">↓</button>
          <button type="button" class="ghost${state.confirmRemoveId === stop.id ? " armed" : ""}" data-act="remove" ${canRemove ? "" : "disabled"} aria-label="Remove ${escapeAttr(title)}">${state.confirmRemoveId === stop.id ? "Remove" : "−"}</button>
        </div>
      </div>
      <div class="address-row">
        <textarea data-field="address" rows="2" placeholder="${escapeAttr(`${title} address`)}" autocomplete="off" aria-label="Address">${escapeAttr(stop.address)}</textarea>
        <button type="button" class="flag-box" data-act="map">Choose from map</button>
      </div>
      <div class="lookup-row">
        <button type="button" class="flag-box lookup${lookupFlash ? " lookup-flash" : ""}" data-act="lookup"${lookupOpen.has(stop.id) ? "" : " hidden"} ${state.looking === stop.id ? "disabled" : ""}>${state.looking === stop.id ? "Looking up…" : state.signedIn ? "Look up this address · 1 credit" : "Look up this address"}</button>
      </div>
      ${lookupMapPreview(stop)}
      ${(stop.suggestions || []).map((item, index) => `<button type="button" class="suggest" data-suggest="${index}">${escapeAttr(item.label)}</button>`).join("")}
      ${state.lookupStopId === stop.id && state.lookupMessage
        ? `<p class="${state.lookupOk ? "ok" : "error"}">${escapeAttr(state.lookupMessage)}</p>`
        : ""}
      ${pointReady(stop) && !usingDismissed.has(stop.id) && !(state.lookupStopId === stop.id && state.lookupOk)
        ? `<p class="flag-box">Using this address.</p>`
        : ""}
      ${originStop ? "" : hereLeg(stop)}
      ${originStop && (stop.name || "").trim().toLowerCase() === "start" ? "" : `
      <div class="stop-flags">
        <button type="button" class="flag-box${stop.anytime ? " on" : ""}" data-toggle-field="anytime">Anytime</button>
        <button type="button" class="flag-box${stop.window ? " on" : ""}" data-toggle-field="window">Window</button>
      </div>
      ${stop.anytime ? "" : `
        ${stop.window ? whenRow("Opens", stop, "start", stop.start) : ""}
        ${whenRow(stop.window ? "Closes" : "Be there by", stop, stop.window ? "end" : "start", stop.window ? stop.end : stop.start)}
      `}`}
    </article>
    ${destIndex === 0 ? around.now.map(chip).join("") : ""}
    ${around.before.map(chip).join("")}
    ${around.self ? chip(around.self) : ""}
    ${around.after.map(chip).join("")}
    ${around.following.map(chip).join("")}
    <button type="button" class="flag-box" data-after="${stop.id}">Add a stop after ${escapeAttr(title)}</button>
  `;
}

function escapeAttr(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("\"", "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function hereLeg(stop) {
  const miles = Number(stop.miles) || 0;
  const hours = Number(stop.hours) || 0;
  if (miles > 0.05 || hours > 0.0001) {
    const parts = [];
    if (miles > 0.05) parts.push(formatMiles(miles));
    if (hours > 0.0001) parts.push(hoursLabel(hours));
    return `<p class="flag-box">${escapeAttr(parts.join(" · "))} from HERE<sup>©</sup></p>`;
  }
  return "";
}

function hosSummary() {
  const s = state.settings;
  const speed = s.governed ? `${s.governedMph || DEFAULT_MPH} mph` : "ungoverned 65";
  const window = s.startAnytime && s.endAnytime
    ? "anytime"
    : s.startAnytime
      ? `anytime–${formatClockMinutes(s.endMinutes)}`
      : s.endAnytime
        ? `${formatClockMinutes(s.startMinutes)} start`
        : `${formatClockMinutes(s.startMinutes)}–${formatClockMinutes(s.endMinutes)}`;
  return `${speed} · ${s.hoursOfEleven} of 11 · 30 after ${s.hoursBeforeThirty} hr · ${window}`;
}

function maskEmail(email) {
  const text = String(email || "");
  if (text.length <= 2) return text;
  return `${text[0]}${"*".repeat(text.length - 2)}${text[text.length - 1]}`;
}

let installEvent = null;

function phoneKind() {
  const ua = navigator.userAgent || "";
  if (/iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) return "ios";
  if (/Android/i.test(ua)) return "android";
  return "";
}

function showInstallButton() {
  return Boolean(phoneKind() || installEvent);
}

async function installApp() {
  if (installEvent) {
    installEvent.prompt();
    const choice = await installEvent.userChoice;
    installEvent = null;
    state.installHint = choice?.outcome === "accepted" ? "Planigator is on your home screen." : "";
    render();
    return;
  }
  state.installHint = phoneKind() === "ios"
    ? "Tap the Share button, then “Add to Home Screen.”"
    : "Open the browser menu, then tap Install app or Add to Home screen.";
  render();
}

function exampleOpenNote() {
  const text = `Opened ${EXAMPLE_TRIP.name}.`;
  if (state.notice !== text || state.activeTripId) return "";
  return `<p class="ok example-note">${escapeAttr(text)}</p>`;
}

function hereCallsBlock() {
  if (!state.signedIn) return "";
  const rows = state.calls.length
    ? `<ul class="call-log">${state.calls.map((call) => `<li><span>${escapeAttr(formatShort(call.at))}</span> ${escapeAttr(call.kind)} · ${escapeAttr(call.detail)} ${call.ok ? escapeAttr(call.result || "") : "not charged"}</li>`).join("")}</ul>`
    : `<p class="fine">No HERE calls on this account yet.</p>`;
  return `<section class="calls"><details class="call-log-box"><summary>HERE calls</summary>${rows}</details></section>`;
}

function authBlock() {
  const shownEmail = state.emailRevealed ? state.email : maskEmail(state.email);
  const example = `<p class="fine"><button type="button" class="text-button example-load" id="loadExample">Load an example trip<canvas class="example-sparkles" aria-hidden="true"></canvas></button></p>${exampleOpenNote()}`;
  const google = state.signedIn
    ? `<div class="auth-row"><p class="flag-box signed-note">Signed in${state.email ? ` as <button type="button" class="text-button" id="revealEmail" aria-pressed="${state.emailRevealed ? "true" : "false"}">${escapeAttr(shownEmail)}</button>` : ""}. Trips save to this account.</p><button type="button" class="flag-box" id="logout">Log out</button>${example}</div>`
    : state.googleClientId
      ? `<div class="auth-row"><div id="googleBtn"></div><p class="fine">Sign in with Google for 40 free credits, enough to try a trip.</p>${example}</div>`
      : `<div class="auth-row"><p class="fine">Google sign-in keeps trips on your account once that client ID is connected.</p>${example}</div>`;
  const card = !state.signedIn
    ? ""
    : state.cardOnFile
      ? `<p class="fine">Card on file · ${escapeAttr(state.cardBrand)} •••• ${escapeAttr(state.cardLast4)}</p><button type="button" class="secondary" id="deleteCard">Delete card</button>`
      : state.unlimited
        ? ""
        : `<button type="button" class="secondary" id="saveCard" ${state.savingCard ? "disabled" : ""}>${state.savingCard ? "Opening the card form…" : state.cardGrantUsed ? "Save a card" : "Save a card for 40 more free credits"}</button><p class="fine">${state.cardGrantUsed ? "Adding another card does not add another 40. " : ""}We do not charge that card when the free credits run out.</p>`;
  const cardSaved = state.cardSavedNote
    ? `<p class="fine">Card saved. Free credits show up after Stripe confirms that card has not been used.</p>`
    : "";
  const idle = state.idleNote ? `<p class="ok">${escapeAttr(state.idleNote)}</p>` : "";
  const signedOut = state.notice === "Signed out." ? `<p class="ok">Signed out.</p>` : "";
  const gift = state.signedIn && !state.unlimited
    ? `<form class="auth-row" id="giftForm"><label class="flag-box">Credit code <input id="giftCode" maxlength="8" autocomplete="off" spellcheck="false"></label><button type="submit" class="flag-box">Use code</button></form>`
    : "";
  return `<div class="auth-block">${idle}${signedOut}${google}${gift}${card}${cardSaved}${state.cardNote ? `<p class="error">${escapeAttr(state.cardNote)}</p>` : ""}</div>`;
}

export function initPlanner(el) {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    installEvent = event;
    render();
  });
  window.addEventListener("appinstalled", () => {
    installEvent = null;
    state.installHint = "Planigator is on your home screen.";
    render();
  });
  plannerRoot = el;
  noteVisit(!sessionStorage.getItem("planigator.web.visit"));
  sessionStorage.setItem("planigator.web.visit", "1");
  setInterval(() => {
    if (document.visibilityState === "visible") noteVisit(false);
  }, 30000);
  rollOpenExample();
  const paid = new URLSearchParams(location.search).get("paid");
  if (paid === "1") state.notice = "";
  if (paid === "0") state.notice = "Checkout canceled. Your credits are unchanged.";
  const card = new URLSearchParams(location.search).get("card");
  if (card === "1") state.cardSavedNote = true;
  if (card === "0") state.notice = "Card setup canceled. No free credits were added.";
  applyShareFromLocation();
  const shareCode = new URLSearchParams(location.search).get("s");
  if (shareCode) loadSharedCode(shareCode);
  render();
  refreshCredits().then(async () => {
    if (sessionStorage.getItem("planigator.web.signup") === "1") {
      sessionStorage.removeItem("planigator.web.signup");
      if (state.signedIn) {
        state.signupNote = "40 free credits are yours.";
        state.notice = "";
        popConfetti();
      }
    }
    if (state.idleSignOut) {
      state.calls = [];
      state.notice = "";
      resetLocalBoxFont();
      resetEditor();
      state.idleNote = "Signed out after an hour away.";
      persist();
    } else if (!maybeCelebratePack() && !maybeCelebrateCard() && state.signedIn) {
      pulseActivity();
    }
    await pullAccountTrips();
    rollOpenExample();
    if (!state.locating) render();
    if (paid === "1") watchPackGrant();
    if (card === "1") watchCardGrant();
  });
  const mark = () => { if (state.signedIn) pulseActivity(); };
  document.addEventListener("pointerdown", mark);
  document.addEventListener("keydown", mark);
  document.addEventListener("scroll", mark, true);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") watchSignIn();
  });
  setInterval(() => {
    if (state.signedIn) watchSignIn();
  }, 15000);
}

async function watchSignIn() {
  const was = state.signedIn;
  await refreshCredits();
  if (maybeCelebratePack() || maybeCelebrateCard()) return;
  if (was && !state.signedIn) {
    state.calls = [];
    state.notice = state.idleSignOut ? "" : "Signed out.";
    resetLocalBoxFont();
    resetEditor();
    if (state.idleSignOut) state.idleNote = "Signed out after an hour away.";
    persist();
    render();
  }
}

function render() {
  const root = plannerRoot || document.getElementById("app");
  if (!root) return;
  const googleLive = document.getElementById("googleBtn");
  const keepGoogle = googleLive && googleLive.childElementCount ? googleLive : null;
  if (keepGoogle) keepGoogle.remove();
  document.documentElement.style.setProperty("--box-font", `${state.boxFont}px`);
  const s = state.settings;
  const origin = state.stops.find((stop) => stop.useCurrentLocation);
  const routeFrom = routeFromLine(origin);
  const destCards = state.stops
    .map((stop, index) => (stop.useCurrentLocation ? "" : stopCard(stop, index)))
    .join("");
  const plan = state.plan;
  root.innerHTML = `
    ${state.signupNote ? `<p class="ok signup-note">${escapeAttr(state.signupNote)}</p>` : ""}
    <div class="hero-lift"><section class="hero card hero-mark">
      <img class="hero-anim" src="./icons/planigator-clip.gif?v=2" alt="" width="360" height="360">
      <div class="hero-copy">
      <h1>www.planigator.help</h1>
      <ul class="pitch">
        <li>The only truck navigator in the web browser. No app to install. Plan it, turn by turn, and drive it from the same page.</li>
        <li>One page for the truck-legal plan, the auto-zooming turn list, and navigation</li>
        <li>See how much leeway time you have</li>
        <li>See when to leave</li>
        <li>See when to take your 30 and your 10</li>
        <li>Share the trip link with anyone</li>
        <li>Pick governed speed</li>
        <li>And more</li>
      </ul>
      </div>
    </section></div>

    ${authBlock()}

    <section class="hos" style="--box-font: ${state.boxFont}px">
      <div class="box-stepper">
        <label class="box-stepper">
          <span class="sr">Box size</span>
          <input type="range" id="boxFont" min="13" max="28" value="${state.boxFont}">
          <span class="flag-box" id="boxFontReadout">${state.boxFont}</span>
        </label>
      </div>
        <div class="settings-grid action-grid">
          <button type="button" class="set-box${state.stops[0]?.useCurrentLocation ? " on" : ""}${state.chooseStart ? " choose-start" : ""}" id="locate" ${state.locating ? "disabled" : ""}>${state.locating ? "Waiting for permission…" : "Start from my location"}</button>
          <button type="button" class="set-box${!state.stops[0]?.useCurrentLocation && (state.stops[0]?.name || "").trim().toLowerCase() === "start" ? " on" : ""}${state.chooseStart ? " choose-start" : ""}" id="fromAddress">Start from an address</button>
          <button type="button" class="set-box" id="newTrip">new/clear trip</button>
          ${state.chooseStart ? `<p class="fine start-choice-note">Choose Start from my location or Start from an address.</p>` : ""}
          ${routeFrom ? `<div class="route-line"><span class="when-arrow" aria-hidden="true"></span>${routeFrom}</div>` : ""}
          ${state.locationNotice === "That's still the latest location." ? `<div class="route-line"><span class="flag-box">That's still the latest location.</span></div>` : ""}
        </div>
        <div class="settings-pairs">
          <div class="set-pair">
            <div class="set-box${s.governed ? " on" : ""}">
              <button type="button" class="set-name" data-toggle="governed">Governed speed</button>
              <button type="button" class="set-value" data-pick="mph">${s.governed ? s.governedMph : "Off"}</button>
            </div>
          </div>
          <div class="set-pair">
            ${settingToggle("leaveNow", "Leave now", s.leaveNow)}
            ${s.leaveNow ? "" : settingValue("leaveAt", "Leave at", formatShort(s.leaveAt))}
          </div>
          <div class="set-pair">
            ${settingToggle("startAnytime", "Start anytime", s.startAnytime)}
            ${s.startAnytime ? "" : settingValue("startTime", "Day start", formatClockMinutes(s.startMinutes))}
          </div>
          <div class="set-pair">
            ${settingToggle("endAnytime", "End anytime", s.endAnytime)}
            ${s.endAnytime ? "" : settingValue("endTime", "Day end", formatClockMinutes(s.endMinutes))}
          </div>
          <div class="set-pair">
            ${settingToggle("military", "Military time", s.military)}
            ${settingToggle("kilometers", "Kilometers", s.kilometers)}
          </div>
          <div class="set-pair">
            ${settingValue("hoursOfEleven", "Hours I’ll drive out of the 11", String(s.hoursOfEleven), true)}
            ${settingValue("hoursBeforeThirty", "Hours into driving before 30-minute break", thirtyLabel(s.hoursBeforeThirty), true)}
            ${state.plan ? `<button type="button" class="flag-box" id="updateTimes">Update times</button>` : ""}
          </div>
        </div>
        ${state.plan && state.speedNote ? `<p class="fine speed-note">${escapeAttr(state.speedNote)}</p>` : ""}
        <p id="locate-status" class="${state.locationError ? "error" : state.locationNotice && state.locationNotice !== "That's still the latest location." ? "ok" : ""}">${escapeAttr(state.locationError || (state.locationNotice === "That's still the latest location." ? "" : state.locationNotice) || "")}</p>
    </section>

    ${state.notice === "This trip was shared with you." ? `<p class="ok shared-note">${escapeAttr(state.notice)}</p>` : ""}

    <section class="stops">
      ${destCards}
    </section>

    ${planBox()}

    <section class="actions" id="actions">
      <label class="flag-box trip-name">Trip name
        <textarea id="tripName" rows="2" placeholder="Optional — Dallas to Atlanta">${escapeAttr(state.tripName)}</textarea>
      </label>
      <button type="button" class="flag-box${s.routeMode === "short" ? " on" : ""}" data-toggle="routeMode">${s.routeMode === "short" ? "Short mode" : "Fast mode"}</button>
      <button type="button" class="flag-box on" id="calculate" ${state.estimating || (!state.unlimited && state.credits === 0) ? "disabled" : ""}>${calculateButtonLabel()}</button>
      <div class="stack">
        ${plan ? `<button type="button" class="flag-box" id="shareTrip">Share trip link</button>` : ""}
        ${plan && state.unlimited ? `<button type="button" class="flag-box" id="shareNav">Share to Planigator Nav</button>` : ""}
        ${plan && showInstallButton() ? `<button type="button" class="flag-box" id="installApp">Add Planigator to your home screen</button>` : ""}
        ${state.cardOnFile ? `<button type="button" class="secondary" id="buyPack" ${state.buying ? "disabled" : ""}>${state.buying ? "Opening checkout…" : "If you need more credits, buy 124 credits for $1.49"}</button>` : ""}
      </div>
      ${state.installHint ? `<p class="fine">${escapeAttr(state.installHint)}</p>` : ""}
      <p class="fine">${state.unlimited ? "Unlimited credits on this account. " : (state.signedIn || state.cardOnFile) && state.credits != null ? `${state.credits} credit${state.credits === 1 ? "" : "s"} left. ` : ""}Calculate asks HERE<sup>©</sup> for truck miles and drive hours. Each address and each leg uses 1 credit. Google sign-in gives 40. The first saved card gives 40 more, once per account. We do not charge that card when they run out. Truck only — not car, bike, or walk.</p>
      ${state.error ? `<p class="error">${escapeAttr(state.error)}</p>` : ""}
      ${state.notice && state.notice !== "Signed out." && state.notice !== "This trip was shared with you." && !exampleOpenNote() ? `<p class="ok">${escapeAttr(state.notice)}</p>` : ""}
    </section>

    ${savedTripsBlock()}
    ${hereCallsBlock()}
    ${lookupMapSheet()}
    ${pickerSheet()}

  `;
  const slot = document.getElementById("googleBtn");
  if (keepGoogle && slot) slot.replaceWith(keepGoogle);
  bind();
}

function mphWheel() {
  const current = state.settings.governed ? String(state.settings.governedMph) : "off";
  const rows = [
    { value: "off", label: "Off" },
    ...MPH_CHOICES.map((mph) => ({ value: String(mph), label: String(mph) })),
    { value: "off2", label: "Off" },
  ];
  return rows.map((row) => {
    const on = row.value === current ? " on" : "";
    return `<button type="button" class="time-opt${on}" data-part="mph" data-value="${row.value}">${row.label}</button>`;
  }).join("");
}

function pickerOptions(values, current, part, labelFn = String) {
  return values.map((value) => {
    const on = String(value) === String(current) ? " on" : "";
    return `<button type="button" class="time-opt${on}" data-part="${part}" data-value="${escapeAttr(value)}">${escapeAttr(labelFn(value))}</button>`;
  }).join("");
}

function clockWheels(totalMinutes) {
  const minutes = Math.max(0, Number(totalMinutes) || 0);
  const hour24 = Math.trunc(minutes / 60) % 24;
  const minute = minutes % 60;
  const hour = state.settings.military ? hour24 : (hour24 % 12 || 12);
  const ap = hour24 >= 12 ? "PM" : "AM";
  const hours = state.settings.military
    ? Array.from({ length: 24 }, (_, i) => i)
    : Array.from({ length: 12 }, (_, i) => i + 1);
  const hourLabel = (value) => state.settings.military ? pad(value) : String(value);
  return `<div class="time-col">${pickerOptions(hours, hour, "hour", hourLabel)}</div>
    <div class="time-col">${pickerOptions(Array.from({ length: 60 }, (_, i) => i), minute, "minute", pad)}</div>
    ${state.settings.military ? "" : `<div class="time-col">${pickerOptions(["AM", "PM"], ap, "ampm")}</div>`}`;
}

function pickerStop() {
  const id = state.pickerTarget?.id;
  return state.stops.find((stop) => stop.id === id);
}

function pickerStopMs() {
  const stop = pickerStop();
  if (!stop) return Date.now();
  return state.pickerTarget.field === "end" ? stop.end : stop.start;
}

function stopWhenTitle() {
  const stop = pickerStop();
  if (state.pickerTarget?.field === "start" && stop?.window) return "Opens";
  if (state.pickerTarget?.field === "end" && stop?.window) return "Closes";
  return "Be there by";
}

function leaveDateValue(ms) {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function pickerSheet() {
  const id = state.picker;
  if (!id) return "";
  let title = "Setting";
  let step = "";
  let wheels = "";
  let action = "Done";
  if (id === "mph") {
    title = "Governed speed";
    wheels = `<div class="time-col">${mphWheel()}</div>`;
  } else if (id === "hoursOfEleven") {
    title = "Hours I’ll drive out of the 11";
    wheels = `<div class="time-col">${pickerOptions(HOS_ELEVEN, state.settings.hoursOfEleven, "hoursOfEleven")}</div>`;
  } else if (id === "hoursBeforeThirty") {
    title = "Hours into driving before 30-minute break";
    wheels = `<div class="time-col">${pickerOptions(HOS_THIRTY, state.settings.hoursBeforeThirty, "hoursBeforeThirty", thirtyLabel)}</div>`;
  } else if (id === "leaveAt" || id === "stopDate") {
    title = id === "stopDate" ? stopWhenTitle() : "Leave at";
    step = "Date";
    action = "Set the time";
  } else if (id === "leaveAtTime" || id === "stopTime" || id === "startTime" || id === "endTime") {
    title = id === "leaveAtTime" ? "Leave at" : id === "stopTime" ? stopWhenTitle() : id === "startTime" ? "Day start" : "Day end";
    step = id === "leaveAtTime" || id === "stopTime" ? "Time" : "";
    const minutes = id === "leaveAtTime"
      ? new Date(state.settings.leaveAt).getHours() * 60 + new Date(state.settings.leaveAt).getMinutes()
      : id === "stopTime"
        ? new Date(pickerStopMs()).getHours() * 60 + new Date(pickerStopMs()).getMinutes()
        : id === "startTime" ? state.settings.startMinutes : state.settings.endMinutes;
    wheels = clockWheels(minutes);
  }
  return `<div class="time-sheet" id="pickerSheet">
    <div class="time-sheet-card">
      <p class="picker-title">${escapeAttr(title)}</p>
      ${step ? `<p class="fine picker-step">${escapeAttr(step)}</p>` : ""}
      ${id === "leaveAt" || id === "stopDate"
        ? `<input class="picker-date" type="date" data-part="date" value="${leaveDateValue(id === "stopDate" ? pickerStopMs() : state.settings.leaveAt)}" aria-label="Date">`
        : `<div class="time-wheels">${wheels}</div>`}
      <button type="button" class="primary" id="pickerDone">${escapeAttr(action)}</button>
    </div>
  </div>`;
}

function chosenWheel(part) {
  return document.querySelector(`#pickerSheet [data-part="${part}"].on`)?.getAttribute("data-value");
}

function minutesFromSheet() {
  const hour = Number(chosenWheel("hour"));
  const minute = Number(chosenWheel("minute"));
  const ap = chosenWheel("ampm");
  if (state.settings.military) return hour * 60 + minute;
  let h = hour % 12;
  if (ap === "PM") h += 12;
  return h * 60 + minute;
}

function readDatedMs(previousMs) {
  const date = document.querySelector("#pickerSheet [data-part=date]")?.value || "";
  const [year, month, day] = date.split("-").map((part) => Number(part));
  const prev = new Date(previousMs);
  if (!year || !month || !day) return previousMs;
  return new Date(year, month - 1, day, prev.getHours(), prev.getMinutes()).getTime();
}

function readLeaveDate() {
  return readDatedMs(state.settings.leaveAt);
}

function writeStopWhen(ms) {
  const target = state.pickerTarget;
  const stop = pickerStop();
  if (!target || !stop) return;
  const patch = { [target.field]: ms };
  if (target.field === "start" && !stop.window) patch.end = ms;
  updateStop(target.id, patch);
}

function commitPicker() {
  const id = state.picker;
  if (id === "leaveAt") {
    state.settings.leaveAt = readLeaveDate();
    state.picker = "leaveAtTime";
    persist();
    saveActiveTripSettings();
    render();
    return;
  }
  if (id === "stopDate") {
    const ms = readDatedMs(pickerStopMs());
    state.picker = "stopTime";
    writeStopWhen(ms);
    return;
  }
  if (id === "stopTime") {
    const date = new Date(pickerStopMs());
    const minutes = minutesFromSheet();
    const ms = new Date(date.getFullYear(), date.getMonth(), date.getDate(), Math.trunc(minutes / 60), minutes % 60).getTime();
    state.picker = "";
    writeStopWhen(ms);
    state.pickerTarget = null;
    return;
  }
  if (id === "mph") {
    const raw = chosenWheel("mph");
    if (raw === "off" || raw === "off2") {
      if (state.settings.governed) markGovernedStale();
      state.settings.governed = false;
    } else {
      const next = Number(raw) || DEFAULT_MPH;
      if (next !== Number(state.settings.governedMph)) markGovernedStale();
      state.settings.governed = true;
      state.settings.governedMph = next;
    }
  }
  if (id === "hoursOfEleven") state.settings.hoursOfEleven = Math.min(11, Math.max(1, Number(chosenWheel("hoursOfEleven")) || 11));
  if (id === "hoursBeforeThirty") state.settings.hoursBeforeThirty = Math.min(8, Math.max(0.5, Number(chosenWheel("hoursBeforeThirty")) || 8));
  if (id === "startTime") state.settings.startMinutes = minutesFromSheet();
  if (id === "endTime") state.settings.endMinutes = minutesFromSheet();
  if (id === "leaveAtTime") {
    const date = new Date(state.settings.leaveAt);
    const minutes = minutesFromSheet();
    state.settings.leaveAt = new Date(date.getFullYear(), date.getMonth(), date.getDate(), Math.trunc(minutes / 60), minutes % 60).getTime();
  }
  state.picker = "";
  persist();
  saveActiveTripSettings();
  render();
}

function bindSettings() {
  const map = [
    ["governed", (el) => { state.settings.governed = el.checked; }],
    ["mph", (el) => { state.settings.governedMph = Number(el.value) || DEFAULT_MPH; }],
    ["hoursOfEleven", (el) => { state.settings.hoursOfEleven = Math.min(11, Math.max(1, Number(el.value) || 11)); }],
    ["hoursBeforeThirty", (el) => { state.settings.hoursBeforeThirty = Math.min(8, Math.max(0.5, Number(el.value) || 8)); }],
    ["leaveNow", (el) => { state.settings.leaveNow = el.checked; }],
    ["leaveAt", (el) => { state.settings.leaveAt = fromDateTimeLocal(el.value); }],
    ["endAnytime", (el) => { state.settings.endAnytime = el.checked; }],
    ["startAnytime", (el) => { state.settings.startAnytime = el.checked; }],
    ["military", (el) => { state.settings.military = el.checked; }],
    ["kilometers", (el) => { state.settings.kilometers = el.checked; }],
    ["arrival", (el) => { state.settings.arrival = el.value === "latest" ? "latest" : "earliest"; }],
    ["tripName", (el) => { state.tripName = el.value; persist(); }],
  ];
  map.forEach(([id, apply]) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("change", () => {
      apply(el);
      persist();
      if (id !== "tripName") saveActiveTripSettings();
      if (id === "arrival" && state.plan) calculate({ silent: true });
      else if (id !== "tripName") render();
    });
    if (el.type !== "checkbox") {
      el.addEventListener("input", () => {
        apply(el);
        persist();
        if (id !== "tripName") saveActiveTripSettings();
      });
    }
    if (id === "tripName") {
      el.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
      });
    }
  });
  document.querySelectorAll("[data-toggle]").forEach((el) => {
    el.addEventListener("click", () => {
      const id = el.getAttribute("data-toggle");
      if (id === "governed") {
        state.settings.governed = !state.settings.governed;
        markGovernedStale();
      }
      if (id === "leaveNow") {
        if (!state.settings.leaveNow) poofBox(document.querySelector('[data-pick="leaveAt"]'));
        state.settings.leaveNow = !state.settings.leaveNow;
      }
      if (id === "startAnytime") {
        if (!state.settings.startAnytime) poofBox(document.querySelector('[data-pick="startTime"]'));
        state.settings.startAnytime = !state.settings.startAnytime;
      }
      if (id === "endAnytime") {
        if (!state.settings.endAnytime) poofBox(document.querySelector('[data-pick="endTime"]'));
        state.settings.endAnytime = !state.settings.endAnytime;
      }
      if (id === "military") state.settings.military = !state.settings.military;
      if (id === "kilometers") state.settings.kilometers = !state.settings.kilometers;
      if (id === "routeMode") state.settings.routeMode = state.settings.routeMode === "short" ? "fast" : "short";
      persist();
      saveActiveTripSettings();
      render();
    });
  });
  document.querySelectorAll("button[data-pick]").forEach((el) => {
    el.addEventListener("click", () => {
      const id = el.getAttribute("data-pick");
      if (id === "mph") {
        const wasOn = state.settings.governed;
        state.settings.governed = true;
        if (!wasOn) markGovernedStale();
      }
      state.picker = id;
      render();
    });
  });
  document.querySelectorAll("#pickerSheet .time-opt").forEach((button) => {
    button.addEventListener("click", () => {
      button.parentElement.querySelectorAll(".time-opt").forEach((item) => item.classList.remove("on"));
      button.classList.add("on");
    });
  });
  document.querySelectorAll("#pickerSheet .time-opt.on").forEach((button) => {
    button.scrollIntoView({ block: "center" });
  });
  document.getElementById("pickerDone")?.addEventListener("click", () => commitPicker());
  document.querySelector("#pickerSheet [data-part=date]")?.addEventListener("change", () => commitPicker());
  document.getElementById("pickerSheet")?.addEventListener("click", (event) => {
    if (event.target.id !== "pickerSheet") return;
    state.picker = "";
    state.pickerTarget = null;
    render();
  });
}

function minutesFromWrap(wrap) {
  const hour = Number(wrap.querySelector("[data-part=hour]")?.value);
  const minute = Number(wrap.querySelector("[data-part=minute]")?.value);
  const ap = wrap.querySelector("[data-part=ampm]")?.value;
  if (state.settings.military) return hour * 60 + minute;
  let h = hour % 12;
  if (ap === "PM") h += 12;
  return h * 60 + minute;
}

function applyClock(wrap) {
  const total = minutesFromWrap(wrap);
  const id = wrap.getAttribute("data-clock");
  if (id === "startTime") state.settings.startMinutes = total;
  if (id === "endTime") state.settings.endMinutes = total;
  persist();
  saveActiveTripSettings();
  render();
}

function applyWhen(wrap) {
  const date = wrap.querySelector("[data-part=date]")?.value || "";
  const [year, month, day] = date.split("-").map((part) => Number(part));
  if (!year || !month || !day) return;
  const minutes = minutesFromWrap(wrap);
  const ms = new Date(year, month - 1, day, Math.trunc(minutes / 60), minutes % 60).getTime();
  if (wrap.getAttribute("data-when") === "leaveAt") {
    state.settings.leaveAt = ms;
    persist();
    saveActiveTripSettings();
    render();
    return;
  }
  const field = wrap.getAttribute("data-stop-field");
  const id = wrap.closest("[data-stop]")?.getAttribute("data-stop");
  if (!field || !id) return;
  const patch = { [field]: ms };
  if (field === "start" && !state.stops.find((stop) => stop.id === id)?.window) patch.end = ms;
  updateStop(id, patch);
}

let removeArmTimer = 0;
let deleteArmTimer = 0;

function paintRemoveArm(id, armed) {
  const button = document.querySelector(`[data-stop="${id}"] [data-act="remove"]`);
  if (!button) return;
  button.classList.toggle("armed", armed);
  button.textContent = armed ? "Remove" : "−";
}

function paintDeleteArm(id, armed) {
  const button = document.querySelector(`[data-delete="${id}"]`);
  if (!button) return;
  button.textContent = armed ? "Confirm delete" : "Delete";
}

function armRemove(id) {
  if (state.confirmRemoveId && state.confirmRemoveId !== id) paintRemoveArm(state.confirmRemoveId, false);
  state.confirmRemoveId = id;
  paintRemoveArm(id, true);
  window.clearTimeout(removeArmTimer);
  removeArmTimer = window.setTimeout(() => {
    if (state.confirmRemoveId !== id) return;
    state.confirmRemoveId = null;
    paintRemoveArm(id, false);
  }, 1000);
}

function armDelete(id) {
  if (state.confirmDeleteId && state.confirmDeleteId !== id) paintDeleteArm(state.confirmDeleteId, false);
  state.confirmDeleteId = id;
  paintDeleteArm(id, true);
  window.clearTimeout(deleteArmTimer);
  deleteArmTimer = window.setTimeout(() => {
    if (state.confirmDeleteId !== id) return;
    state.confirmDeleteId = null;
    paintDeleteArm(id, false);
  }, 1000);
}

function bind() {
  placeRouteStage();
  bindSettings();
  document.querySelectorAll("[data-clock]").forEach((wrap) => {
    wrap.querySelectorAll("select").forEach((select) => {
      select.addEventListener("change", () => applyClock(wrap));
    });
  });
  document.querySelectorAll("[data-when]").forEach((wrap) => {
    wrap.querySelectorAll("input, select").forEach((control) => {
      control.addEventListener("change", () => applyWhen(wrap));
    });
  });
  mountAuth();
  syncOwnerLink();
  $("#logout")?.addEventListener("click", () => logout());
  $("#giftForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const code = $("#giftCode")?.value || "";
    redeemCode(code);
  });
  $("#loadExample")?.addEventListener("click", (event) => {
    poofBig(event.currentTarget);
    loadExample();
  });
  $("#revealEmail")?.addEventListener("click", () => {
    state.emailRevealed = !state.emailRevealed;
    render();
  });
  $("#calculate")?.addEventListener("click", () => calculate());
  $("#updateTimes")?.addEventListener("click", () => calculate({ silent: true }));
  $("#boxFont")?.addEventListener("input", () => {
    const next = Number($("#boxFont").value);
    if (!Number.isFinite(next)) return;
    state.boxFont = Math.min(28, Math.max(13, Math.round(next)));
    document.documentElement.style.setProperty("--box-font", `${state.boxFont}px`);
    const hos = document.querySelector(".hos");
    if (hos) hos.style.setProperty("--box-font", `${state.boxFont}px`);
    const readout = document.getElementById("boxFontReadout");
    if (readout) readout.textContent = String(state.boxFont);
    persist();
    queueBoxFontSave();
  });
  mountMap();
  paintDrive(navOn && navFix && navLine.length >= 2 ? navNearest(navFix[0], navFix[1], navLine).along : null);
  if (navFix) refreshPlace(navFix[0], navFix[1]);
  else if (Number.isFinite(Number(state.origin?.lat)) && Number.isFinite(Number(state.origin?.lon))) refreshPlace(Number(state.origin.lat), Number(state.origin.lon));
  document.querySelectorAll("[data-dir-stop]").forEach((button) => {
    button.addEventListener("click", () => {
      pauseFollowForDirection();
      zoomToDirection(button.getAttribute("data-dir-stop"), button.getAttribute("data-dir-index"));
    });
  });
  $("#saveCard")?.addEventListener("click", () => saveCard());
  $("#deleteCard")?.addEventListener("click", () => deleteCard());
  $("#buyPack")?.addEventListener("click", () => buyPack());
  document.querySelectorAll("[data-open-map]").forEach((button) => {
    button.addEventListener("click", () => {
      state.openLookupStopId = button.getAttribute("data-open-map") || "";
      render();
    });
  });
  document.getElementById("closeLookupMap")?.addEventListener("click", () => {
    state.openLookupStopId = "";
    chooseMap = false;
    mapSpot = null;
    render();
  });
  document.getElementById("useMapSpot")?.addEventListener("click", () => useChosenSpot());
  mountLookupMaps();
  $("#shareTrip")?.addEventListener("click", () => shareTrip());
  syncRouteChrome();
  $("#nextTruck")?.addEventListener("click", () => findNextTruckStop());
  $("#darkMode")?.addEventListener("click", () => toggleDarkMode());
  $("#routeTruck")?.addEventListener("click", () => findNextTruckStop({ frame: true }));
  $("#addTruckStop")?.addEventListener("click", () => addTruckAsNextStop());
  $("#routeTruckAdd")?.addEventListener("click", () => addTruckAndRecalculate());
  $("#startNav")?.addEventListener("click", async () => {
    unlockNavVoice();
    const orientation = window.DeviceOrientationEvent;
    if (orientation && typeof orientation.requestPermission === "function") {
      try {
        await orientation.requestPermission();
      } catch {
        // The first tap on the map can ask again.
      }
    }
    beginRouteNav();
  });
  $("#endNav")?.addEventListener("click", () => endRouteNav());
  $("#routeWhole")?.addEventListener("click", () => cycleTripFit());
  $("#routeRecalc")?.addEventListener("click", () => recalculateFromHere());
  $("#routeStop")?.addEventListener("click", (event) => cycleNavStop(event));
  $("#routeZoomIn")?.addEventListener("click", () => changeMapZoom(1));
  $("#routeZoomOut")?.addEventListener("click", () => changeMapZoom(-1));
  $("#routeFull")?.addEventListener("click", () => setRouteFull(true));
  $("#routeExit")?.addEventListener("click", () => setRouteFull(false));
  $("#routeFollow")?.addEventListener("click", async () => {
    window.clearTimeout(navReturnTimer);
    navReturnTimer = 0;
    tripFit = "off";
    syncTripFitButton();
    await enableNavCompass();
    navFollowing = true;
    syncRouteChrome();
    if (navFix) onNavFix(navFix[0], navFix[1]);
  });
  $("#shareNav")?.addEventListener("click", () => shareToNav());
  $("#installApp")?.addEventListener("click", () => installApp());
  $("#copyPlan")?.addEventListener("click", () => copyPlan());
  $("#locate")?.addEventListener("click", () => locate());
  $("#fromAddress")?.addEventListener("click", () => startFromAddress());
  $("#newTrip")?.addEventListener("click", () => newTrip());
  document.querySelectorAll("[data-load]").forEach((button) => {
    button.addEventListener("click", () => loadTrip(button.getAttribute("data-load")));
  });
  document.querySelectorAll("[data-delete]").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.getAttribute("data-delete");
      if (state.confirmDeleteId !== id) {
        armDelete(id);
        return;
      }
      window.clearTimeout(deleteArmTimer);
      state.confirmDeleteId = null;
      button.disabled = true;
      button.innerHTML = `<span class="arrival-spin" aria-hidden="true"></span>Confirm delete`;
      deleteTrip(id);
    });
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
      if (field === "name") {
        input.addEventListener("keydown", (event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
        });
      }
      if (field === "address") {
        input.addEventListener("focus", () => {
          if (lookupOpen.has(id)) return;
          lookupOpen.add(id);
          card.querySelector("[data-act=lookup]")?.removeAttribute("hidden");
        });
        input.addEventListener("keydown", (event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          const stop = state.stops.find((item) => item.id === id);
          if (stop) stop.address = input.value;
          lookupAddress(id);
        });
      }
      if (input.type !== "checkbox" && input.type !== "datetime-local") {
        input.addEventListener("input", () => {
          const stop = state.stops.find((item) => item.id === id);
          if (!stop) return;
          stop[field] = input.value;
          if (field === "address") {
            const button = card.querySelector("[data-act=lookup]");
            const typed = input.value.trim();
            const verified = String(stop.verifiedLabel || "").trim();
            if (button && typed && typed !== verified) {
              lookupOpen.add(id);
              button.hidden = false;
              button.classList.add("lookup-flash");
            } else if (button) {
              button.classList.remove("lookup-flash");
            }
          }
          if (field === "address" || field === "name") fitAddressField(input);
          persist();
        });
      }
    });
    card.querySelector("[data-act=up]")?.addEventListener("click", () => moveStop(id, -1));
    card.querySelector("[data-act=down]")?.addEventListener("click", () => moveStop(id, 1));
    card.querySelector("[data-act=remove]")?.addEventListener("click", () => {
      if (state.confirmRemoveId !== id) {
        armRemove(id);
        return;
      }
      window.clearTimeout(removeArmTimer);
      state.confirmRemoveId = null;
      poofBox(card);
      removeStop(id);
    });
    card.querySelectorAll("[data-stop-when]").forEach((button) => {
      button.addEventListener("click", () => {
        state.pickerTarget = { id, field: button.getAttribute("data-stop-field") };
        state.picker = "stopDate";
        render();
      });
    });
    card.querySelectorAll("[data-toggle-field]").forEach((button) => {
      button.addEventListener("click", () => {
        const field = button.getAttribute("data-toggle-field");
        const stop = state.stops.find((item) => item.id === id);
        if (!stop) return;
        if (field === "anytime") {
          const anytime = !stop.anytime;
          if (anytime) card.querySelectorAll(".when-row").forEach((row) => poofBox(row));
          updateStop(id, anytime ? { anytime: true, window: false } : { anytime: false });
          return;
        }
        if (field === "window") {
          const open = !stop.window;
          if (!open) {
            const opens = [...card.querySelectorAll(".when-row")].find((row) => row.querySelector(".flag-box")?.textContent === "Opens");
            poofBox(opens);
          }
          updateStop(id, open ? { window: true, anytime: false } : { window: false });
        }
      });
    });
    card.querySelector("[data-act=lookup]")?.addEventListener("click", () => lookupAddress(id));
    const usingNote = [...card.querySelectorAll("p")].some((note) => {
      const text = note.textContent || "";
      return text === "Using that address." || text === "Using this address.";
    });
    if (usingNote) armUsingNote(id);
    card.querySelector("[data-act=map]")?.addEventListener("click", () => openChooseMap(id));
    card.querySelectorAll("[data-suggest]").forEach((button) => {
      button.addEventListener("click", () => chooseSuggestion(id, Number(button.getAttribute("data-suggest"))));
    });
  });
  document.querySelectorAll("[data-after]").forEach((button) => {
    button.addEventListener("click", () => addStop(button.getAttribute("data-after")));
  });
  document.querySelectorAll("textarea[data-field=address], textarea[data-field=name]").forEach(fitAddressField);
  mountExampleSparkle();
}

function mountExampleSparkle() {
  const canvas = document.querySelector(".example-sparkles");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const speed = 2.6;
  const count = 22;
  const draw = (now) => {
    if (!canvas.isConnected) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, rect.width);
    const h = Math.max(1, rect.height);
    const pxW = Math.round(w * dpr);
    const pxH = Math.round(h * dpr);
    if (canvas.width !== pxW || canvas.height !== pxH) {
      canvas.width = pxW;
      canvas.height = pxH;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const t = reduce ? 1.2 : (now / 1000) * speed;
    for (let index = 0; index < count; index += 1) {
      const seed = (index + 1) * 1.618;
      const radius = 1.1 + (index % 3) * 0.5;
      const reach = radius * 2.2 + 1;
      const spanX = Math.max(1, w - reach * 2);
      const spanY = Math.max(1, h - reach * 2);
      const x = Math.min(w - reach, Math.max(reach, reach + (Math.sin(seed * 4.2) * 0.5 + 0.5) * spanX + Math.sin(t + seed) * 2.5));
      const y = Math.min(h - reach, Math.max(reach, reach + (Math.cos(seed * 3.3) * 0.5 + 0.5) * spanY + Math.cos(t * 0.8 + seed) * 2));
      const twinkle = reduce ? 0.9 : 0.12 + 0.88 * Math.abs(Math.sin(t * Math.PI + seed * 2.1));
      const hue = (seed * 47 + t * 36) % 360;
      ctx.globalAlpha = twinkle * 0.72;
      ctx.strokeStyle = `hsl(${hue} 70% 28%)`;
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.moveTo(x, y - radius * 2.2);
      ctx.lineTo(x, y + radius * 2.2);
      ctx.moveTo(x - radius * 2.2, y);
      ctx.lineTo(x + radius * 2.2, y);
      ctx.stroke();
      ctx.fillStyle = `hsl(${hue} 75% 58%)`;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = `hsl(${(hue + 40) % 360} 80% 72%)`;
      ctx.lineWidth = 0.6;
      ctx.beginPath();
      ctx.moveTo(x, y - radius * 2.2);
      ctx.lineTo(x, y + radius * 2.2);
      ctx.moveTo(x - radius * 2.2, y);
      ctx.lineTo(x + radius * 2.2, y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    if (!reduce) requestAnimationFrame(draw);
  };
  requestAnimationFrame(draw);
}

function fitAddressField(field) {
  field.style.height = "0px";
  field.style.height = `${field.scrollHeight}px`;
}

if (document.body.classList.contains("planner-only")) {
  window.addEventListener("hashchange", () => {
    if (writingHash) return;
    applyShareFromLocation();
  });
  initPlanner(document.getElementById("app"));
}
