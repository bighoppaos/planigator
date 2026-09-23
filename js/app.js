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
} from "./hos.js?v=121";
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
} from "./plan.js?v=121";
import { TRUCK_PROFILE } from "./here.js";
import { creditsMe, fetchCalls, suggestAddresses, truckRoute, startCheckout, startCardSetup, loginWith, fetchTrips, putTrips, createShare, fetchShare, clearSession, logoutRemote, pulseActivity, clearCardWelcome, clearPackWelcome, removeSavedCard } from "./api.js";

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
      startAnytime: false,
      endAnytime: false,
      hoursOfEleven: LEGAL_MAX_DRIVE_HOURS,
      hoursBeforeThirty: DEFAULT_HOURS_BEFORE_THIRTY,
      military: false,
      kilometers: false,
      arrival: "earliest",
    },
    stops: defaultStops(),
    tripName: "",
    activeTripId: null,
    plan: null,
    error: "",
    notice: "",
    signupNote: "",
    idleNote: "",
    locationError: "",
    locationNotice: "",
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
  } catch {
    return state;
  }
  return state;
}

const state = loadState();

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

function persist() {
  localStorage.setItem(STORAGE, JSON.stringify({
    settings: settingsForSave(),
    stops: state.stops,
    tripName: state.tripName,
    activeTripId: state.activeTripId,
    trips: state.trips,
    origin: state.origin,
    plan: slimPlan(state.plan),
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

function calculateButtonLabel() {
  if (state.estimating) return "Asking HERE<sup>©</sup>…";
  const count = Math.max(0, state.stops.length - 1);
  const use = count > 0 ? `${count} credit${count === 1 ? "" : "s"}` : "";
  const left = state.unlimited
    ? "unlimited credits left"
    : (state.signedIn || state.cardOnFile) && state.credits != null
      ? `${state.credits} left`
      : "";
  return ["Calculate", use, left].filter(Boolean).join(" · ");
}

const HOS_ELEVEN = Array.from({ length: 11 }, (_, i) => i + 1);
const HOS_THIRTY = Array.from({ length: 16 }, (_, i) => (i + 1) / 2);
const MPH_CHOICES = Array.from({ length: 21 }, (_, i) => 55 + i);

function thirtyLabel(value) {
  const n = Number(value);
  return Math.abs(n - Math.round(n)) < 0.05 ? String(Math.round(n)) : n.toFixed(1);
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
  state.notice = notice || "Opened a shared trip. Nothing was uploaded.";
  persist();
  if (!state.plan) calculate({ silent: true, skipHash: true });
  else render();
}

async function loadSharedCode(code) {
  try {
    applySharedTrip(await fetchShare(code), {
      notice: "Opened a shared trip. It is not saved to an account.",
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
    notice: "Opened a shared trip. Calculate again after you change anything.",
  });
  return true;
}

async function calculate({ silent = false, skipHash = false } = {}) {
  if (!silent && !state.unlimited && state.credits === 0) {
    state.error = state.cardOnFile
      ? "You are out of credits. Buy a pack of 124. The card on file is not charged."
      : state.signedIn
        ? "Those 5 free credits are used. Save a card for 10 more. That card is not charged when they run out."
        : "Sign in with Google for 5 free credits. Save a card for 10 more. That card is not charged when they run out.";
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
    state.plan = silent ? state.plan : null;
    state.error = result.error;
    if (!silent) state.notice = "";
    render();
    persist();
    return;
  }
  state.plan = result;
  state.error = "";
  if (!skipHash) saveTrip();
  if (state.signedIn && !skipHash) {
    try {
      await putTrips(state.trips);
      markTripsUploaded();
      if (!silent) state.notice = `HERE© truck route (${TRUCK_PROFILE.summary}). Trip saved to your account.`;
    } catch (error) {
      if (!silent) state.notice = error.message || "Saved on this device. The account copy did not update.";
    }
  } else if (!silent) {
    state.notice = `HERE© truck route (${TRUCK_PROFILE.summary}). Trip saved in this browser.`;
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
  if (!state.plan) calculate({ silent: true, skipHash: true });
  else {
    render();
    persist();
  }
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
  if (!state.signedIn) return;
  try {
    const data = await fetchTrips();
    const remote = Array.isArray(data.trips) ? data.trips : [];
    const remoteIds = new Set(remote.map((trip) => trip?.id).filter(Boolean));
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
    for (const trip of state.trips) {
      if (!trip?.id || remoteIds.has(trip.id)) continue;
      if (trip.pendingUpload) byId.set(trip.id, trip);
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
  if ("address" in patch) {
    const typed = String(patch.address || "").trim();
    if (typed !== (stop.verifiedLabel || "")) {
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
  };
  Object.assign(state, defaultState());
  Object.assign(state, keep);
  state.notice = "";
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
  state.signupNote = "10 free credits are yours.";
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
  setLookupMessage(id, "Using that address.", { ok: true });
  persist();
  render();
}

async function fillHereLegs() {
  const points = [];
  for (const stop of state.stops) {
    if (stop.useCurrentLocation) {
      const here = originPoint();
      if (!here) throw new Error("Allow location first, then Calculate.");
      points.push(here);
      continue;
    }
    if (!pointReady(stop)) {
      const title = cardTitle(state.stops.indexOf(stop), state.stops);
      throw new Error(`Look up ${title} and tap a verified address. A lookup that finds nothing is not charged.`);
    }
    points.push({ lat: Number(stop.lat), lon: Number(stop.lon) });
  }
  const departAt = leaveAtNow();
  const speedCapMph = state.settings.governed ? mph() : null;
  for (let i = 1; i < state.stops.length; i += 1) {
    if (!points[i - 1] || !points[i]) continue;
    const leg = await truckRoute(points[i - 1], points[i], {
      speedCapMph,
      departAt,
    });
    state.stops[i].miles = String(Math.round(leg.miles * 10) / 10);
    state.stops[i].hours = String(Math.round(leg.hours * 100) / 100);
    state.stops[i].path = Array.isArray(leg.points) ? leg.points : [];
    state.stops[i].directions = Array.isArray(leg.directions) ? leg.directions : [];
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

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if ([...document.scripts].some((script) => script.src === src)) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Could not load sign-in."));
    document.head.appendChild(script);
  });
}

async function logout() {
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
  resetEditor();
  persist();
  await refreshCredits();
  render();
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
  const me = await loginWith("google", credential);
  state.idleNote = "";
  applyAccount(me);
  if (me.signupCredits) {
    state.signupNote = "5 free credits are yours.";
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
  if (googleBox && state.googleClientId) {
    const start = () => {
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
      googleBox.innerHTML = "";
      window.google.accounts.id.renderButton(googleBox, { theme: "outline", size: "large", width: 280 });
    };
    if (window.google?.accounts?.id) start();
    else loadScript("https://accounts.google.com/gsi/client").then(start).catch((error) => {
      state.error = error.message;
      render();
    });
  }
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
  if (point) return `<p>Routing from ${point.lat.toFixed(4)}, ${point.lon.toFixed(4)}</p>`;
  if (originStop) return `<p>Waiting for location. Allow Planigator, or type an address.</p>`;
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
  return `<section class="card trips">
    <h2>Saved trips</h2>
    <ul>
      ${state.trips.map((trip) => `<li class="${trip.id === state.activeTripId ? "active" : ""}">
        <button type="button" data-load="${escapeAttr(trip.id)}">
          ${escapeAttr(trip.name || trip.tripName || "Trip")}
          <span>${formatShort(trip.savedAt)}</span>
        </button>
        <button type="button" class="secondary" data-delete="${escapeAttr(trip.id)}">${state.confirmDeleteId === trip.id ? "Confirm delete" : "Delete"}</button>
      </li>`).join("")}
    </ul>
  </section>`;
}

function directionsBlock() {
  const groups = [];
  for (const stop of state.stops) {
    if (!Array.isArray(stop.directions) || !stop.directions.length) continue;
    const title = stop.useCurrentLocation ? "Current location" : (stop.name || "Stop");
    groups.push({ title, steps: stop.directions });
  }
  if (!groups.length) return "";
  const items = groups.map((group) => `
    <li class="dir-leg">${escapeAttr(group.title)}</li>
    ${group.steps.map((step) => `<li>${escapeAttr(step.text)}${Number(step.miles) > 0.05 ? ` <span>${formatMiles(step.miles)}</span>` : ""}</li>`).join("")}
  `).join("");
  return `<details class="directions call-log-box">
    <summary>Directions</summary>
    <ol>${items}</ol>
  </details>`;
}

function planBox() {
  const plan = state.plan;
  if (!plan) return "";
  return `<section class="card result">
    <div id="routeMap" class="route-map"></div>
    ${directionsBlock()}
    ${plan.late && plan.lastDeadline ? `<p class="error">That is after ${escapeAttr(plan.lastTimedTitle)}’s be-there-by (${formatShort(plan.lastDeadline)}).</p>` : ""}
    <dl>
      <div><dt>Leave by</dt><dd>${formatTime(plan.rollAt)}</dd></div>
      <div><dt>Arrive</dt><dd>${formatTime(plan.arriveAt)}</dd></div>
      <div><dt>Driving</dt><dd>${hoursLabel(plan.driveHours)} · ${formatMiles(plan.miles)}</dd></div>
      <div><dt>HOS on this path</dt><dd>${plan.breakCount} × 30-min · ${plan.restCount} × 10-hour</dd></div>
    </dl>
    <p class="muted">Total trip-time including 10's and 30's: ${durationLabel((plan.arriveAt - plan.rollAt) / 3600 / 1000)}.</p>
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

function lookupMapSheet() {
  const stop = state.stops.find((item) => item.id === state.openLookupStopId);
  if (!stop || !lookupPins(stop).length) return "";
  return `<div class="lookup-sheet" role="dialog" aria-modal="true" aria-label="Choose a stop">
    <div class="lookup-sheet-bar">
      <strong>Choose a stop</strong>
      <button type="button" class="secondary" id="closeLookupMap">Close</button>
    </div>
    <div class="lookup-map is-live" data-lookup-map="${escapeAttr(stop.id)}" data-live="1"></div>
    <p class="fine">Move around, then tap a pin.</p>
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

function mountLookupMaps() {
  lookupMaps.forEach((map) => map.remove());
  lookupMaps = [];
  const maplibre = window.maplibregl;
  if (!maplibre) return;
  document.querySelectorAll("[data-lookup-map]").forEach((el) => {
    const stop = state.stops.find((item) => item.id === el.getAttribute("data-lookup-map"));
    const pins = lookupPins(stop);
    if (!pins.length) return;
    const live = el.getAttribute("data-live") === "1";
    const map = new maplibre.Map({
      container: el,
      style: satelliteStyle,
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
      map.fitBounds(bounds, { padding: live ? 64 : 28, maxZoom: pins.length === 1 ? 14 : 12, animate: false });
      map.resize();
    });
    lookupMaps.push(map);
  });
}

function pinLabel(label) {
  const text = String(label || "").split(",")[0].trim();
  return text.length > 28 ? `${text.slice(0, 28)}…` : text;
}

function mountMap() {
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
    map.addControl(new maplibre.AttributionControl({ compact: false }), "bottom-right");
    map.on("load", () => {
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
      map.fitBounds(bounds, { padding: 48, maxZoom: 8, animate: false });
      map.once("idle", () => {
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

function chip(event) {
  const ink = stopInk(event.rgb);
  const miles = event.miles != null && event.miles > 0.05 ? formatMiles(event.miles) : "";
  const hours = event.tripHours != null ? hoursLabel(event.tripHours) : "";
  return `
    <div class="chip ${event.kind}" style="background:${cssRGB(event.rgb)};color:${ink.color}">
      <div class="chip-top">
        <strong>${escapeAttr(event.timePhrase || "")}</strong>
        <span>${escapeAttr(hours)}${miles ? ` · ${escapeAttr(miles)}` : ""}</span>
      </div>
      <div class="chip-time">${formatShort(event.start)}${event.end && event.end !== event.start ? ` – ${formatShort(event.end)}` : ""}</div>
      ${event.arrivalPhrase && event.earliestArrive ? `<div class="chip-arrive ${event.late ? "late" : ""}">${escapeAttr(event.arrivalPhrase)} ${formatShort(event.earliestArrive)}</div>` : ""}
      ${event.title && event.kind !== "stop" ? `<div class="chip-time">Toward ${escapeAttr(event.title)}</div>` : ""}
    </div>
  `;
}

function eventsAround(stopId) {
  const events = state.plan?.events || [];
  const self = events.find((event) => event.id === stopId);
  const mine = events.filter((event) => event.stopID === stopId && event.id !== stopId && event.kind !== "leeway");
  return {
    before: mine.filter((event) => !self || event.start < self.start).sort((a, b) => a.start - b.start),
    self,
    following: mine.filter((event) => self && event.start >= self.start).sort((a, b) => a.start - b.start),
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
        <input data-field="address" value="${escapeAttr(stop.address)}" placeholder="${escapeAttr(`${title} address`)}" autocomplete="off">
      </label>
      <button type="button" class="add-inline" data-act="lookup" ${state.looking === stop.id ? "disabled" : ""}>${state.looking === stop.id ? "Looking up…" : state.signedIn ? "Look up this address · 1 credit" : "Look up this address"}</button>
      ${lookupMapPreview(stop)}
      ${(stop.suggestions || []).map((item, index) => `<button type="button" class="suggest" data-pick="${index}">${escapeAttr(item.label)}</button>`).join("")}
      ${state.lookupStopId === stop.id && state.lookupMessage
        ? `<p class="${state.lookupOk ? "ok" : "error"}">${escapeAttr(state.lookupMessage)}</p>`
        : ""}
      ${pointReady(stop) && !(state.lookupStopId === stop.id && state.lookupOk)
        ? `<p class="here-leg">Using this address.</p>`
        : ""}
      ${originStop ? "" : hereLeg(stop)}
      ${originStop && (stop.name || "").trim().toLowerCase() === "start" ? "" : `
      <label class="setting">
        <span>Anytime</span>
        <input type="checkbox" data-field="anytime" ${stop.anytime ? "checked" : ""}>
      </label>
      ${stop.anytime ? "" : `
        <label class="setting">
          <span>Window</span>
          <input type="checkbox" data-field="window" ${stop.window ? "checked" : ""}>
        </label>
        ${stop.window ? `<label class="setting"><span>Opens</span>${dateChip({ field: "start", ms: stop.start })}</label>` : ""}
        <label class="setting"><span>Be there by</span>${dateChip({ field: stop.window ? "end" : "start", ms: stop.window ? stop.end : stop.start })}</label>
      `}`}
    </article>
    ${around.following.map(chip).join("")}
    ${destIndex >= 0 && destIndex < dests.length - 1 ? `<button type="button" class="add-inline" data-after="${stop.id}">Add a stop after ${escapeAttr(title)}</button>` : ""}
    ${around.after.map(chip).join("")}
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
    return `<p class="here-leg">${escapeAttr(formatMiles(miles))} · ${escapeAttr(hoursLabel(hours))} from HERE<sup>©</sup></p>`;
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

function authBlock() {
  const shownEmail = state.emailRevealed ? state.email : maskEmail(state.email);
  const google = state.signedIn
    ? `<div class="auth-row"><p class="fine">Signed in${state.email ? ` as <button type="button" class="text-button" id="revealEmail" aria-pressed="${state.emailRevealed ? "true" : "false"}">${escapeAttr(shownEmail)}</button>` : ""}. Trips save to this account.</p><button type="button" class="secondary" id="logout">Log out</button></div>`
    : state.googleClientId
      ? `<div class="auth-row"><div id="googleBtn"></div><p class="fine">Sign in with Google for 5 free credits, enough to try a trip.</p></div>`
      : `<p class="fine">Google sign-in keeps trips on your account once that client ID is connected.</p>`;
  const card = !state.signedIn
    ? ""
    : state.cardOnFile
      ? `<p class="fine">Card on file · ${escapeAttr(state.cardBrand)} •••• ${escapeAttr(state.cardLast4)}</p><button type="button" class="secondary" id="deleteCard">Delete card</button>`
      : state.unlimited
        ? ""
        : `<button type="button" class="secondary" id="saveCard" ${state.savingCard ? "disabled" : ""}>${state.savingCard ? "Opening the card form…" : state.cardGrantUsed ? "Save a card" : "Save a card for 10 more free credits"}</button><p class="fine">${state.cardGrantUsed ? "Adding another card does not add another 10. " : ""}We do not charge that card when the free credits run out.</p>`;
  const cardSaved = state.cardSavedNote
    ? `<p class="fine">Card saved. Free credits show up after Stripe confirms that card has not been used.</p>`
    : "";
  const idle = state.idleNote ? `<p class="ok">${escapeAttr(state.idleNote)}</p>` : "";
  return `<div class="auth-block">${idle}${google}${card}${cardSaved}${state.cardNote ? `<p class="error">${escapeAttr(state.cardNote)}</p>` : ""}</div>`;
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
        state.signupNote = "5 free credits are yours.";
        state.notice = "";
        popConfetti();
      }
    }
    if (state.idleSignOut) {
      state.calls = [];
      state.notice = "";
      resetEditor();
      state.idleNote = "Signed out after an hour away.";
      persist();
    } else if (!maybeCelebratePack() && !maybeCelebrateCard() && state.signedIn) {
      pulseActivity();
    }
    await pullAccountTrips();
    if (!state.locating) render();
    if (state.idleNote) document.querySelector(".auth-block")?.scrollIntoView({ behavior: "smooth", block: "start" });
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
    resetEditor();
    if (state.idleSignOut) state.idleNote = "Signed out after an hour away.";
    persist();
    render();
    if (state.idleNote) document.querySelector(".auth-block")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
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
  root.innerHTML = `
    ${state.signupNote ? `<p class="ok signup-note">${escapeAttr(state.signupNote)}</p>` : ""}
    <section class="hero card hero-mark">
      <div class="hero-copy">
      <h1>Planigator.help</h1>
      <ul class="pitch">
        <li>Get a HERE<sup>©</sup> truck-legal route</li>
        <li>Know how much leeway time you have</li>
        <li>Know when to leave</li>
        <li>Know when to take your 30 and your 10</li>
        <li>Share the trip link with anyone</li>
      </ul>
      </div>
    </section>

    ${authBlock()}

    <section class="card hos">
      <h2>Trip Settings</h2>
        <div class="setting">
          <label for="governed">Governed</label>
          <span class="setting-control">
            <input type="checkbox" id="governed" ${s.governed ? "checked" : ""}>
            ${s.governed ? wheelChip("mph", s.governedMph, MPH_CHOICES) : ""}
          </span>
        </div>
        <label class="setting">
          <span>Hours I’ll drive out of the 11</span>
          ${wheelChip("hoursOfEleven", s.hoursOfEleven, HOS_ELEVEN)}
        </label>
        <label class="setting">
          <span>Hours into driving before 30-minute break</span>
          ${wheelChip("hoursBeforeThirty", s.hoursBeforeThirty, HOS_THIRTY, thirtyLabel)}
        </label>
        ${s.leaveNow ? "" : `<label class="setting"><span>Leave at</span>${dateChip({ id: "leaveAt", ms: s.leaveAt })}</label>`}
        <label class="setting">
          <span>Leave now</span>
          <input type="checkbox" id="leaveNow" ${s.leaveNow ? "checked" : ""}>
        </label>
        ${s.startAnytime ? "" : `<label class="setting"><span>Start time each day</span>${timeChip("startTime", s.startMinutes)}</label>`}
        <label class="setting">
          <span>Start the day anytime</span>
          <input type="checkbox" id="startAnytime" ${s.startAnytime ? "checked" : ""}>
        </label>
        ${s.endAnytime ? "" : `<label class="setting"><span>End time each day</span>${timeChip("endTime", s.endMinutes)}</label>`}
        <label class="setting">
          <span>End the day anytime</span>
          <input type="checkbox" id="endAnytime" ${s.endAnytime ? "checked" : ""}>
        </label>
        <label class="setting">
          <span>Military time</span>
          <input type="checkbox" id="military" ${s.military ? "checked" : ""}>
        </label>
        <label class="setting">
          <span>Kilometers</span>
          <input type="checkbox" id="kilometers" ${s.kilometers ? "checked" : ""}>
        </label>
        <label class="setting">
          <span>Arrival</span>
          <select id="arrival">
            <option value="earliest" ${s.arrival === "latest" ? "" : "selected"}>Earliest</option>
            <option value="latest" ${s.arrival === "latest" ? "selected" : ""}>Latest</option>
          </select>
        </label>
        ${routeFromLine(origin)}
        <div class="stack">
          <button type="button" class="secondary" id="locate" ${state.locating ? "disabled" : ""}>${state.locating ? "Waiting for permission…" : "Start from my location"}</button>
          <button type="button" class="secondary" id="fromAddress">Start from an address</button>
          <button type="button" class="secondary" id="newTrip">new/clear trip</button>
          ${state.plan ? `<button type="button" class="secondary" id="updateTimes">Update times</button>` : ""}
        </div>
        <p id="locate-status" class="${state.locationError ? "error" : state.locationNotice ? "ok" : ""}">${escapeAttr(state.locationError || state.locationNotice || "")}</p>
    </section>

    ${planBox()}

    <section class="card stops">
      ${destCards}
      <button type="button" class="add" id="addStop">Add a stop</button>
    </section>

    <section class="card actions" id="actions">
      <label>Trip name
        <input id="tripName" value="${escapeAttr(state.tripName)}" placeholder="Optional — Dallas to Atlanta">
      </label>
      <div class="stack">
        <button type="button" class="primary" id="calculate" ${state.estimating || (!state.unlimited && state.credits === 0) ? "disabled" : ""}>${calculateButtonLabel()}</button>
        ${plan ? `<button type="button" class="secondary" id="shareTrip">Share trip link</button>` : ""}
        ${plan && showInstallButton() ? `<button type="button" class="secondary" id="installApp">Add Planigator to your home screen</button>` : ""}
        ${state.cardOnFile ? `<button type="button" class="secondary" id="buyPack" ${state.buying ? "disabled" : ""}>${state.buying ? "Opening checkout…" : "If you need more credits, buy 124 credits for $1.49"}</button>` : ""}
      </div>
      ${state.installHint ? `<p class="fine">${escapeAttr(state.installHint)}</p>` : ""}
      <p class="fine">${state.unlimited ? "Unlimited credits on this account. " : (state.signedIn || state.cardOnFile) && state.credits != null ? `${state.credits} credit${state.credits === 1 ? "" : "s"} left. ` : ""}Calculate asks HERE<sup>©</sup> for truck miles and drive hours. Each address and each leg uses 1 credit. Google sign-in gives 5. The first saved card gives 10 more, once per account. We do not charge that card when they run out. Truck only — not car, bike, or walk.</p>
      ${state.signedIn ? `<details class="call-log-box"><summary>HERE calls</summary>${state.calls.length ? `<ul class="call-log">${state.calls.map((call) => `<li><span>${escapeAttr(formatShort(call.at))}</span> ${escapeAttr(call.kind)} · ${escapeAttr(call.detail)} ${call.ok ? escapeAttr(call.result || "") : "not charged"}</li>`).join("")}</ul>` : `<p class="fine">No HERE calls on this account yet.</p>`}</details>` : ""}
      ${state.error ? `<p class="error">${escapeAttr(state.error)}</p>` : ""}
      ${state.notice ? `<p class="ok">${escapeAttr(state.notice)}</p>` : ""}
    </section>

    ${savedTripsBlock()}
    ${lookupMapSheet()}

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

function bind() {
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
  $("#revealEmail")?.addEventListener("click", () => {
    state.emailRevealed = !state.emailRevealed;
    render();
  });
  $("#calculate")?.addEventListener("click", () => calculate());
  $("#updateTimes")?.addEventListener("click", () => calculate({ silent: true }));
  mountMap();
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
    render();
  });
  mountLookupMaps();
  $("#shareTrip")?.addEventListener("click", () => shareTrip());
  $("#installApp")?.addEventListener("click", () => installApp());
  $("#copyPlan")?.addEventListener("click", () => copyPlan());
  $("#locate")?.addEventListener("click", () => locate());
  $("#fromAddress")?.addEventListener("click", () => startFromAddress());
  $("#newTrip")?.addEventListener("click", () => newTrip());
  $("#addStop")?.addEventListener("click", () => addStop());
  document.querySelectorAll("[data-load]").forEach((button) => {
    button.addEventListener("click", () => loadTrip(button.getAttribute("data-load")));
  });
  document.querySelectorAll("[data-delete]").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.getAttribute("data-delete");
      if (state.confirmDeleteId !== id) {
        state.confirmDeleteId = id;
        render();
        return;
      }
      state.confirmDeleteId = null;
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
      if (field === "address") {
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
          persist();
        });
      }
    });
    card.querySelector("[data-act=up]")?.addEventListener("click", () => moveStop(id, -1));
    card.querySelector("[data-act=down]")?.addEventListener("click", () => moveStop(id, 1));
    card.querySelector("[data-act=remove]")?.addEventListener("click", () => removeStop(id));
    card.querySelector("[data-act=lookup]")?.addEventListener("click", () => lookupAddress(id));
    card.querySelectorAll("[data-pick]").forEach((button) => {
      button.addEventListener("click", () => chooseSuggestion(id, Number(button.getAttribute("data-pick"))));
    });
  });
  document.querySelectorAll("[data-after]").forEach((button) => {
    button.addEventListener("click", () => addStop(button.getAttribute("data-after")));
  });
}

if (document.body.classList.contains("planner-only")) {
  window.addEventListener("hashchange", () => {
    if (writingHash) return;
    applyShareFromLocation();
  });
  initPlanner(document.getElementById("app"));
}
