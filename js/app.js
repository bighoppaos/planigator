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
import { TRUCK_PROFILE } from "./here.js";
import { creditsMe, suggestAddresses, truckRoute, startCheckout, loginWith, fetchTrips, putTrips } from "./api.js";

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
    },
    stops: defaultStops(),
    tripName: "",
    activeTripId: null,
    plan: null,
    error: "",
    notice: "",
    locationError: "",
    locationNotice: "",
    lookupMessage: "",
    lookupStopId: "",
    lookupOk: false,
    trips: [],
    origin: null,
    locating: false,
    estimating: false,
    looking: "",
    buying: false,
    credits: null,
    signedIn: false,
    email: "",
    checkoutReady: false,
    googleClientId: "",
    appleClientId: "",
    packPriceCents: 1399,
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
    if (Array.isArray(saved.stops) && saved.stops.length) state.stops = saved.stops;
    if (state.stops[0]?.useCurrentLocation && !state.origin) state.stops.shift();
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

function settingsForSave() {
  const settings = { ...state.settings };
  delete settings.sleepHours;
  delete settings.readyMinutes;
  return settings;
}

function persist() {
  localStorage.setItem(STORAGE, JSON.stringify({
    settings: settingsForSave(),
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

function calculateCreditCount() {
  let legs = 0;
  for (let i = 1; i < state.stops.length; i += 1) {
    if (pointReady(state.stops[i - 1]) && pointReady(state.stops[i])) legs += 1;
  }
  return legs;
}

function calculateButtonLabel() {
  if (state.estimating) return "Asking HERE<sup>©</sup>…";
  const count = calculateCreditCount();
  const left = state.credits == null ? "" : `${state.credits} left`;
  const use = count > 0 ? `uses ${count} credit${count === 1 ? "" : "s"}` : "";
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

async function calculate({ silent = false, skipHash = false } = {}) {
  if (!silent && !state.signedIn) {
    state.error = "Sign in to calculate.";
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
  if (!silent) {
    saveTrip();
    if (state.signedIn) {
      try {
        await putTrips(state.trips);
        state.notice = `HERE© truck route (${TRUCK_PROFILE.summary}). Trip saved to your account.`;
      } catch (error) {
        state.notice = error.message || "Saved on this device. The account copy did not update.";
      }
    } else {
      state.notice = `HERE© truck route (${TRUCK_PROFILE.summary}). Trip saved in this browser.`;
    }
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

async function deleteTrip(id) {
  state.trips = state.trips.filter((trip) => trip.id !== id);
  if (state.activeTripId === id) state.activeTripId = null;
  persist();
  if (state.signedIn) {
    try {
      await putTrips(state.trips);
    } catch (error) {
      state.error = error.message || "Removed here. The account copy did not update.";
    }
  }
  render();
}

async function pullAccountTrips() {
  if (!state.signedIn) return;
  try {
    const data = await fetchTrips();
    const remote = Array.isArray(data.trips) ? data.trips : [];
    const byId = new Map();
    for (const trip of [...remote, ...state.trips]) {
      if (!trip?.id) continue;
      const prev = byId.get(trip.id);
      if (!prev || (trip.savedAt || 0) >= (prev.savedAt || 0)) byId.set(trip.id, trip);
    }
    state.trips = [...byId.values()].sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0)).slice(0, 40);
    persist();
    await putTrips(state.trips);
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
  if (state.stops[0]?.useCurrentLocation) {
    state.stops[0] = defaultStop({
      name: "Start",
      anytime: true,
      start: Date.now(),
      end: Date.now(),
    });
  }
  state.origin = null;
  state.locationError = "";
  state.locationNotice = "";
  state.notice = "First stop is the yard or wherever you roll from. Miles on the next stop are from here.";
  persist();
  if (state.plan) calculate({ silent: true });
  else render();
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
  const keep = {
    trips: state.trips,
    settings: { ...state.settings },
    credits: state.credits,
    signedIn: state.signedIn,
    email: state.email,
    checkoutReady: state.checkoutReady,
    googleClientId: state.googleClientId,
    appleClientId: state.appleClientId,
    packPriceCents: state.packPriceCents,
  };
  Object.assign(state, defaultState());
  Object.assign(state, keep);
  state.notice = "New trip.";
  writingHash = true;
  history.replaceState(null, "", location.pathname + location.search);
  queueMicrotask(() => { writingHash = false; });
  persist();
  render();
}

let locateGeneration = 0;

/** Options that still show the Mac Allow dialog. */
const LOCATE_OPTIONS = { enableHighAccuracy: false, timeout: 15000, maximumAge: 0 };

function dropServiceWorkers() {
  if (!("serviceWorker" in navigator)) return Promise.resolve();
  return navigator.serviceWorker.getRegistrations()
    .then((regs) => Promise.all(regs.map((reg) => reg.unregister())))
    .then(() => (window.caches ? caches.keys() : []))
    .then((keys) => Promise.all((keys || []).map((key) => caches.delete(key))))
    .catch(() => {});
}

function applyLocatedPosition(pos) {
  state.origin = { lat: pos.coords.latitude, lon: pos.coords.longitude };
  if (!state.stops[0]?.useCurrentLocation) {
    state.stops.unshift(defaultStop({
      useCurrentLocation: true,
      name: "Current location",
      start: Date.now(),
      end: Date.now(),
    }));
  }
  state.locating = false;
  state.locationError = "";
  state.locationNotice = "Got your location.";
  persist();
  render();
}

function showLocatePreflightError() {
  if (!window.isSecureContext) {
    state.locationError = "Location needs HTTPS. Type an address, or open the live site.";
  } else {
    state.locationError = "This browser cannot share a location. Type an address instead.";
  }
  state.locationNotice = "";
  state.locating = false;
  render();
}

function showLocateTapError(error) {
  state.locating = false;
  state.locationNotice = "";
  if (state.stops[0]?.useCurrentLocation && !state.origin) state.stops.shift();
  const code = error?.code ?? "?";
  state.locationError = code === 1
    ? "Safari refused location for this page (error 1)."
    : `This page did not get a location (error ${code}). Tap Use my location again.`;
  render();
}

function markLocateButtonWaiting() {
  const button = document.getElementById("locate");
  if (!button) return;
  button.disabled = true;
  button.textContent = "Waiting for permission…";
}

function applyAccount(me) {
  if (!me) return;
  state.credits = me.credits;
  state.signedIn = Boolean(me.signedIn);
  state.email = me.email || "";
  state.checkoutReady = Boolean(me.checkoutReady);
  state.googleClientId = me.googleClientId || "";
  state.appleClientId = me.appleClientId || "";
  state.packPriceCents = me.packPriceCents || 1399;
}

async function refreshCredits() {
  try {
    applyAccount(await creditsMe());
  } catch {
    if (state.credits == null) state.credits = null;
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
    if (data.credits != null) state.credits = data.credits;
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
      if (!state.origin) throw new Error("Allow location first, then Calculate.");
      points.push(state.origin);
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
    if (leg.credits != null) state.credits = leg.credits;
  }
  persist();
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

function mountAuth() {
  const googleBox = document.getElementById("googleBtn");
  if (googleBox && state.googleClientId) {
    const start = () => {
      if (!window.google?.accounts?.id) return;
      window.google.accounts.id.initialize({
        client_id: state.googleClientId,
        callback: async ({ credential }) => {
          try {
            applyAccount(await loginWith("google", credential));
            await pullAccountTrips();
            state.notice = "Signed in with Google.";
            render();
          } catch (error) {
            state.error = error.message || "Google sign-in failed.";
            render();
          }
        },
      });
      googleBox.innerHTML = "";
      window.google.accounts.id.renderButton(googleBox, { theme: "outline", size: "large", width: 280 });
    };
    if (window.google?.accounts?.id) start();
    else loadScript("https://accounts.google.com/gsi/client").then(start).catch((error) => {
      state.error = error.message;
      render();
    });
  }
  document.getElementById("appleSignIn")?.addEventListener("click", async () => {
    try {
      if (!window.AppleID?.auth) {
        await loadScript("https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js");
      }
      window.AppleID.auth.init({
        clientId: state.appleClientId,
        scope: "name email",
        redirectURI: "https://bighoppaos.github.io/planigator/",
        usePopup: true,
      });
      const result = await window.AppleID.auth.signIn();
      const idToken = result?.authorization?.id_token;
      if (!idToken) throw new Error("Apple did not return a sign-in token.");
      applyAccount(await loginWith("apple", idToken));
      await pullAccountTrips();
      state.notice = "Signed in with Apple.";
      render();
    } catch (error) {
      if (error?.error === "popup_closed_by_user") return;
      state.error = error.message || "Apple sign-in failed.";
      render();
    }
  });
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
        <input data-field="address" value="${escapeAttr(stop.address)}" placeholder="${escapeAttr(originStop ? "City, state, or street" : `${title} address`)}" autocomplete="off">
      </label>
      <button type="button" class="add-inline" data-act="lookup" ${state.looking === stop.id ? "disabled" : ""}>${state.looking === stop.id ? "Looking up…" : "Look up this address"}</button>
      ${(stop.suggestions || []).map((item, index) => `<button type="button" class="suggest" data-pick="${index}">${escapeAttr(item.label)}</button>`).join("")}
      ${state.lookupStopId === stop.id && state.lookupMessage
        ? `<p class="${state.lookupOk ? "ok" : "error"}">${escapeAttr(state.lookupMessage)}</p>`
        : ""}
      ${pointReady(stop) && !(state.lookupStopId === stop.id && state.lookupOk)
        ? `<p class="here-leg">Using this address.</p>`
        : ""}
      ${originStop ? `<p class="fine">This is where you roll from. HERE<sup>©</sup> fills miles on the next stop when you Calculate.</p>` : hereLeg(stop)}
      ${originStop && (stop.name || "").trim().toLowerCase() !== "start" ? `
        <button type="button" class="add-inline" data-act="start-before">Drive here from somewhere else</button>
      ` : originStop ? "" : `
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

function hereLeg(stop) {
  const miles = Number(stop.miles) || 0;
  const hours = Number(stop.hours) || 0;
  if (miles > 0.05 || hours > 0.0001) {
    return `<p class="here-leg">${escapeAttr(formatMiles(miles))} · ${escapeAttr(hoursLabel(hours))} from HERE<sup>©</sup></p>`;
  }
  return `<p class="fine">Miles and drive time come from HERE<sup>©</sup> when you Calculate.</p>`;
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

function authBlock() {
  if (state.signedIn) {
    return `<p class="fine">Signed in${state.email ? ` as ${escapeAttr(state.email)}` : ""}.</p>`;
  }
  if (!state.googleClientId && !state.appleClientId) {
    return `<p class="fine">Sign in with Apple or Google for 12 free credits.</p>`;
  }
  return `
    <div class="auth-row">
      ${state.googleClientId ? `<div id="googleBtn"></div>` : ""}
      ${state.appleClientId ? `<button type="button" class="secondary" id="appleSignIn">Sign in with Apple</button>` : ""}
    </div>
  `;
}

export function initPlanner(el) {
  plannerRoot = el;
  const paid = new URLSearchParams(location.search).get("paid");
  if (paid === "1") state.notice = "Payment received. Credits update in a few seconds.";
  if (paid === "0") state.notice = "Checkout canceled. Your credits are unchanged.";
  applyShareFromLocation();
  render();
  // Drop leftover SW/caches only — do not auto-call getCurrentPosition on load.
  // A non-gesture ask set sticky errors and left an in-flight request that
  // made the Use my location tap look broken.
  dropServiceWorkers();
  refreshCredits().then(async () => {
    await pullAccountTrips();
    if (!state.locating) render();
  });
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
    <section class="hero card hero-mark">
      <h1>Planigator</h1>
      <ul class="pitch">
        <li>Get a HERE<sup>©</sup> truck-legal route</li>
        <li>Know how much leeway time you have</li>
        <li>Know when to leave</li>
        <li>Know when to take your 30 and your 10</li>
        <li>Share the trip link with anyone</li>
      </ul>
    </section>

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
    </section>

    <section class="card origin">
      <h2>Start Location</h2>
      ${origin && state.origin
        ? `<p>Routing from ${state.origin.lat.toFixed(4)}, ${state.origin.lon.toFixed(4)}</p>`
        : origin
          ? `<p>Waiting for location. Allow Planigator, or type an address.</p>`
          : ""}
      <div class="stack">
        <button type="button" class="secondary" id="locate" ${state.locating ? "disabled" : ""}>${state.locating ? "Waiting for permission…" : "Use my location"}</button>
        <button type="button" class="secondary" id="fromAddress">Start from an address</button>
        <button type="button" class="secondary" id="newTrip">New trip</button>
      </div>
      ${state.locationError ? `<p class="error">${escapeAttr(state.locationError)}</p>` : ""}
      ${state.locationNotice ? `<p class="ok">${escapeAttr(state.locationNotice)}</p>` : ""}
    </section>

    <section class="card stops">
      ${destCards}
      <button type="button" class="add" id="addStop">Add a stop</button>
    </section>

    <section class="card actions" id="actions">
      <label>Trip name
        <input id="tripName" value="${escapeAttr(state.tripName)}" placeholder="Optional — Dallas to Atlanta">
      </label>
      ${authBlock()}
      <div class="stack">
        <button type="button" class="primary" id="calculate" ${state.estimating || !state.signedIn ? "disabled" : ""}>${calculateButtonLabel()}</button>
        ${state.signedIn ? `<button type="button" class="secondary" id="buyPack" ${state.buying ? "disabled" : ""}>${state.buying ? "Opening checkout…" : "If you need more credits, buy 124 credits for $1.49"}</button>` : ""}
      </div>
      <p class="fine">${state.signedIn ? `${state.credits ?? 0} credit${state.credits === 1 ? "" : "s"} left. ` : ""}Calculate asks HERE<sup>©</sup> for truck miles and hours. Each address and each leg uses 1 credit. Truck only — not car, bike, or walk.</p>
      ${state.error ? `<p class="error">${escapeAttr(state.error)}</p>` : ""}
      ${state.notice ? `<p class="ok">${escapeAttr(state.notice)}</p>` : ""}
    </section>

    ${plan ? `
      <section class="card result">
        <h2>Plan</h2>
        ${plan.late && plan.lastDeadline ? `<p class="error">That is after ${escapeAttr(plan.lastTimedTitle)}’s be-there-by (${formatShort(plan.lastDeadline)}).</p>` : ""}
        <dl>
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
  if (state.plan) calculate({ silent: true });
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
    if (state.plan) calculate({ silent: true });
    else render();
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
  $("#calculate")?.addEventListener("click", () => calculate());
  $("#buyPack")?.addEventListener("click", () => buyPack());
  $("#shareTrip")?.addEventListener("click", () => shareTrip());
  $("#copyPlan")?.addEventListener("click", () => copyPlan());
  $("#locate")?.addEventListener("click", () => {
    const generation = ++locateGeneration;
    let settled = false;
    // One getCurrentPosition per tap — same turn, before render/innerHTML.
    try {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          settled = true;
          if (generation !== locateGeneration) return;
          applyLocatedPosition(pos);
        },
        (error) => {
          settled = true;
          if (generation !== locateGeneration) return;
          showLocateTapError(error);
        },
        LOCATE_OPTIONS,
      );
    } catch {
      showLocatePreflightError();
      return;
    }
    // Label only after the call is registered; never a second geo request.
    queueMicrotask(() => {
      if (settled || generation !== locateGeneration) return;
      state.locating = true;
      state.locationError = "";
      state.locationNotice = "";
      markLocateButtonWaiting();
    });
  });
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
    card.querySelector("[data-act=start-before]")?.addEventListener("click", () => addStartBefore());
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
  dropServiceWorkers();
  window.addEventListener("hashchange", () => {
    if (writingHash) return;
    applyShareFromLocation();
  });
  initPlanner(document.getElementById("app"));
}
