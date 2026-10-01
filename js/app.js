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
  msInZone,
} from "./hos.js?v=136";
import {
  newId,
  cardTitle,
  cssRGB,
  stopInk,
  stopColor,
  buildPlan,
  isOriginStop,
  legsToCalculate,
  encodeTripShare,
  decodeTripShare,
  planPlainText,
} from "./plan.js?v=179";
import { TRUCK_PROFILE } from "./here.js";
import { EXAMPLE_TRIP } from "./example-trip.js?v=6";
import { tzlookup } from "./tz-lookup.js?v=1";
import { parseStopPaste } from "./paste-stop.js?v=3";
import { directionWindow, matchAlong, nearestOnPath, ON_ROAD_M } from "./nav-match.js?v=2";
import { pageSpeech, warmPageVoices } from "./page-voice.js?v=1";
import { api, creditsMe, fetchCalls, suggestAddresses, truckRoute, spotAddress, startCheckout, startCardSetup, loginWith, fetchTrips, putTrips, createShare, fetchShare, clearSession, logoutRemote, pulseActivity, clearCardWelcome, clearPackWelcome, removeSavedCard, saveBoxFont, noteVisit, redeemGift } from "./api.js?v=6";
import { loadTowns, townAt } from "./town.js?v=1";
import { cleanHeroLines, heroTileHtml } from "./hero-tiles.js?v=3";

const STORAGE = "planigator.web.v1";
const TRIP_CACHE = "planigator.web.tripcache";
const DEFAULT_HERO = [
  "Made and maintained by a truck driver that still drives",
  "Know how much time you have to spare",
  "Truck legal GPS navigation on this same page. No app required.",
  "It's not expensive",
  "And it's cooler",
];
let heroLines = DEFAULT_HERO.slice();

function paintHeroLines() {
  const list = $(".hero-mark .pitch");
  if (!list) return;
  list.innerHTML = heroLines.map((line) => heroTileHtml(line)).join("");
}

function loadHeroLines() {
  const apply = api("/v1/hero").then((data) => {
    const lines = cleanHeroLines(data?.lines);
    if (!lines.length) return;
    const previous = [
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
    const saved = lines.join("\n");
    heroLines = previous.some((set) => set.join("\n") === saved) ? DEFAULT_HERO.slice() : lines;
    paintHeroLines();
  }).catch(() => {});
  const timeout = new Promise((resolve) => setTimeout(resolve, 1200));
  return Promise.race([apply, timeout]);
}

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

function deviceOffset() {
  return new Date().getTimezoneOffset();
}

function clockOffset(value) {
  const offset = Number(value);
  return Number.isFinite(offset) ? offset : deviceOffset();
}

function wallParts(ms, offsetMinutes) {
  const offset = clockOffset(offsetMinutes);
  const date = new Date(Number(ms) - offset * 60 * 1000);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth(),
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
  };
}

function msFromWall(year, monthIndex, day, hour, minute, offsetMinutes) {
  const offset = clockOffset(offsetMinutes);
  return Date.UTC(year, monthIndex, day, hour, minute) + offset * 60 * 1000;
}

function offsetZone(offsetMinutes) {
  const hours = clockOffset(offsetMinutes) / 60;
  if (!Number.isInteger(hours)) return "";
  if (hours === 0) return "UTC";
  return `Etc/GMT${hours > 0 ? "+" : "-"}${Math.abs(hours)}`;
}

function formatUserShort(ms, offsetMinutes) {
  const timeZone = offsetZone(offsetMinutes);
  const options = {
    weekday: "short",
    month: "numeric",
    day: "numeric",
    hour: state.settings.military ? "2-digit" : "numeric",
    minute: "2-digit",
    hourCycle: state.settings.military ? "h23" : "h12",
  };
  if (timeZone) options.timeZone = timeZone;
  return new Intl.DateTimeFormat("en-US", options).format(new Date(ms));
}

function enteredOffset(stop, field) {
  return clockOffset(field === "end" ? stop?.endOffset : stop?.startOffset);
}

function pinEnteredClocks() {
  let changed = false;
  const offset = deviceOffset();
  for (const stop of state.stops || []) {
    if (!Number.isFinite(Number(stop.startOffset))) {
      stop.startOffset = offset;
      changed = true;
    }
    if (!Number.isFinite(Number(stop.endOffset))) {
      stop.endOffset = Number(stop.startOffset);
      changed = true;
    }
  }
  if (!state.settings.leaveNow && !Number.isFinite(Number(state.settings.leaveAtOffset))) {
    state.settings.leaveAtOffset = offset;
    changed = true;
  }
  const trip = (state.trips || []).find((item) => item.id === state.activeTripId);
  if (trip) {
    for (const stop of trip.stops || []) {
      const live = (state.stops || []).find((item) => item.id === stop.id);
      if (!live) continue;
      if (!Number.isFinite(Number(stop.startOffset)) && Number.isFinite(Number(live.startOffset))) {
        stop.startOffset = live.startOffset;
        changed = true;
      }
      if (!Number.isFinite(Number(stop.endOffset)) && Number.isFinite(Number(live.endOffset))) {
        stop.endOffset = live.endOffset;
        changed = true;
      }
    }
    if (trip.settings && !trip.settings.leaveNow && !Number.isFinite(Number(trip.settings.leaveAtOffset)) && Number.isFinite(Number(state.settings.leaveAtOffset))) {
      trip.settings.leaveAtOffset = state.settings.leaveAtOffset;
      changed = true;
    }
  }
  if (changed) persist();
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
  const offset = deviceOffset();
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
    startOffset: offset,
    endOffset: offset,
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
    speedFrom: "",
    speedTo: "",
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
    tripsLoading: false,
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
    driveProgress: null,
    updatingTimes: false,
  };
}

let heldAccountTrip = null;
let stripStoredTrip = false;
let addressEditStarted = false;

function storedTripHasWork(saved) {
  if (!saved || typeof saved !== "object") return false;
  if (saved.origin && Number.isFinite(Number(saved.origin.lat)) && Number.isFinite(Number(saved.origin.lon))) return true;
  if ((saved.tripName || "").trim()) return true;
  if (saved.plan && Array.isArray(saved.plan.events) && saved.plan.events.length) return true;
  if (Array.isArray(saved.trips) && saved.trips.length) return true;
  return (Array.isArray(saved.stops) ? saved.stops : []).some((stop) => {
    if (!stop) return false;
    if (stop.useCurrentLocation) return true;
    if ((stop.address || "").trim()) return true;
    if ((stop.name || "").trim() && (stop.name || "").trim() !== "Stop 1") return true;
    if (Number.isFinite(Number(stop.lat)) && Number.isFinite(Number(stop.lon))) return true;
    return (Number(stop.miles) || 0) > 0.05 || (Number(stop.hours) || 0) > 0.0001;
  });
}

function applyStoredTrip(state, saved) {
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
  state.driveProgress = readDriveProgress(saved.driveProgress);
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
    const boxFont = Number(saved.boxFont);
    if (boxFont >= 13 && boxFont <= 28) state.boxFont = Math.round(boxFont);
    state.darkMode = saved.darkMode === true;
    state.speedFrom = String(saved.speedFrom || "");
    state.speedTo = String(saved.speedTo || "");
    const session = localStorage.getItem("planigator.web.session");
    const guestDraft = saved.fromAccount === false;
    if (!storedTripHasWork(saved)) return state;
    if (guestDraft) applyStoredTrip(state, saved);
    else if (session) heldAccountTrip = saved;
    else stripStoredTrip = true;
  } catch {
    return state;
  }
  return state;
}

const state = loadState();
applyDarkMode();
settleLoadedStops(state.stops);
pinEnteredClocks();
if (stripStoredTrip) {
  stripStoredTrip = false;
  persist();
  forgetAccountTripCache();
}

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
  document.documentElement.classList.toggle("force-light", state.darkMode !== true);
}

function themeButtonLabel() {
  return state.darkMode ? "Dark mode" : "Light mode";
}

function toggleDarkMode() {
  state.darkMode = state.darkMode !== true;
  applyDarkMode();
  const button = document.getElementById("darkMode");
  if (button) {
    button.classList.toggle("on", state.darkMode === true);
    button.textContent = themeButtonLabel();
  }
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
    driveProgress: state.driveProgress,
    boxFont: state.boxFont,
    darkMode: state.darkMode === true,
    fromAccount: state.signedIn === true,
    speedFrom: state.speedFrom || "",
    speedTo: state.speedTo || "",
  }));
}

function forgetAccountTripCache() {
  try { localStorage.removeItem(TRIP_CACHE); } catch {
    // The copy is already gone if this browser blocked storage.
  }
}

function restoreHeldAccountTrip() {
  const saved = heldAccountTrip;
  if (!saved || !state.signedIn) return;
  heldAccountTrip = null;
  if (!editorIsUnused()) return;
  applyStoredTrip(state, saved);
  settleLoadedStops(state.stops);
  pinEnteredClocks();
  persist();
}

function discardHeldAccountTrip() {
  heldAccountTrip = null;
  forgetAccountTripCache();
  persist();
}

function readDriveProgress(value) {
  if (!value || typeof value !== "object") return null;
  const stopId = String(value.stopId || "");
  const remainFraction = Number(value.remainFraction);
  const leftAt = Number(value.leftAt);
  if (!stopId || !(remainFraction > 0) || remainFraction > 1 || !Number.isFinite(leftAt)) return null;
  const progress = { stopId, remainFraction, leftAt };
  const remainMiles = Number(value.remainMiles);
  const remainHours = Number(value.remainHours);
  if (Number.isFinite(remainMiles) && remainMiles >= 0) progress.remainMiles = remainMiles;
  if (Number.isFinite(remainHours) && remainHours >= 0) progress.remainHours = remainHours;
  return progress;
}

function clearDriveProgress() {
  state.driveProgress = null;
}

function stopsAndLeaveForPlan() {
  let stops = state.stops.map(normalizeStop);
  const pending = legsToCalculate(stops);
  if (pending.mode === "suffix") {
    const hide = new Set(pending.indexes);
    stops = stops.map((stop, index) => (hide.has(index) ? { ...stop, skipRoute: true } : stop));
  }
  let progress = state.driveProgress;
  if (progress) {
    const held = state.stops.find((stop) => stop.id === progress.stopId);
    // Arriving marks the stop done and leaves the old progress in place.
    // That remainder is already driven, and its leave time is stale.
    if (!held || held.done || held.skipRoute) {
      const next = state.stops.find((stop, index) => (
        !isOriginStop(state.stops, index) && !stop.done && !stop.skipRoute && stopHasSavedLeg(stop)
      ));
      progress = next && state.stops.some((stop) => stop.done)
        ? { stopId: next.id, remainFraction: 1, leftAt: Date.now() }
        : null;
      state.driveProgress = progress;
    }
  }
  if (!progress) return { stops, leaveAt: leaveAtNow() };
  const index = stops.findIndex((stop) => stop.id === progress.stopId);
  if (index < 0) {
    state.driveProgress = null;
    return { stops, leaveAt: leaveAtNow() };
  }
  const fraction = progress.remainFraction;
  const scaled = stops.map((stop, i) => {
    if (stop.skipRoute || i > index) return stop;
    if (i < index) return { ...stop, skipRoute: true };
    const miles = Number.isFinite(progress.remainMiles)
      ? progress.remainMiles
      : Math.max(0, (Number(stop.miles) || 0) * fraction);
    const hours = Number.isFinite(progress.remainHours)
      ? progress.remainHours
      : Math.max(0, (Number(stop.hours) || 0) * fraction);
    return { ...stop, miles, hours };
  });
  const leaveAt = state.settings.leaveNow ? leaveAtNow() : progress.leftAt;
  if (state.settings.leaveNow && state.driveProgress) state.driveProgress.leftAt = leaveAt;
  return { stops: scaled, leaveAt };
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
    lastStopId: plan.lastStopId || "",
    zoned: plan.zoned === true,
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

function zoneForPoint(lat, lon) {
  const latitude = Number(lat);
  const longitude = Number(lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return "";
  try {
    return tzlookup(latitude, longitude) || "";
  } catch {
    return "";
  }
}

function zoneForStop(stop) {
  if (!stop) return "";
  if (stop.useCurrentLocation) return zoneForPoint(state.origin?.lat, state.origin?.lon);
  return zoneForPoint(stop.lat, stop.lon);
}

function originStop() {
  const stops = state.stops || [];
  const index = stops.findIndex((_, i) => isOriginStop(stops, i));
  return index >= 0 ? stops[index] : stops[0];
}

function arriveStop() {
  const stops = state.stops || [];
  const dests = stops.filter((stop, index) => !isOriginStop(stops, index) && !stop.skipRoute && !stop.done);
  return dests[dests.length - 1];
}

function tripUsesMultipleZones() {
  const zones = new Set();
  for (const stop of state.stops || []) {
    const zone = zoneForStop(stop);
    if (zone) zones.add(zone);
  }
  return zones.size > 1;
}

function shownZone(timeZone) {
  return state.plan?.zoned && timeZone ? timeZone : "";
}

function zoneAbbrev(ms, timeZone) {
  const zone = shownZone(timeZone);
  if (!zone || !tripUsesMultipleZones()) return "";
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      timeZoneName: "short",
      hour: "numeric",
    }).formatToParts(new Date(ms));
    return parts.find((part) => part.type === "timeZoneName")?.value || "";
  } catch {
    return "";
  }
}

function formatZoned(ms, timeZone, kind) {
  const zone = shownZone(timeZone);
  const text = zone
    ? (kind === "long" ? stamp(ms, state.settings.military, zone) : shortStamp(ms, state.settings.military, zone))
    : (kind === "long" ? formatTime(ms) : formatShort(ms));
  const abbrev = zoneAbbrev(ms, timeZone);
  return abbrev ? `${text} ${abbrev}` : text;
}

function formatPlanTime(ms, timeZone) {
  return formatZoned(ms, timeZone, "long");
}

function formatPlanShort(ms, timeZone) {
  return formatZoned(ms, timeZone, "short");
}

function formatPlanSpan(start, end, timeZone) {
  const zone = shownZone(timeZone);
  if (!zone) {
    return end && end !== start ? `${formatShort(start)} – ${formatShort(end)}` : formatShort(start);
  }
  const military = state.settings.military;
  const startText = shortStamp(start, military, zone);
  if (!end || end === start) {
    const abbrev = zoneAbbrev(start, timeZone);
    return abbrev ? `${startText} ${abbrev}` : startText;
  }
  const endText = shortStamp(end, military, zone);
  const startAbbrev = zoneAbbrev(start, timeZone);
  const endAbbrev = zoneAbbrev(end, timeZone);
  if (startAbbrev && endAbbrev && startAbbrev !== endAbbrev) {
    return `${startText} ${startAbbrev} – ${endText} ${endAbbrev}`;
  }
  const abbrev = endAbbrev || startAbbrev;
  return abbrev ? `${startText} – ${endText} ${abbrev}` : `${startText} – ${endText}`;
}

function eventZone(event) {
  if (!event) return "";
  if (event.after === -1) return zoneForStop(originStop());
  const stop = (state.stops || []).find((item) => item.id === event.stopID);
  return zoneForStop(stop) || zoneForStop(originStop());
}

function zonedInstant(ms, offsetMinutes, timeZone) {
  if (!timeZone || !Number.isFinite(Number(ms))) return Number(ms);
  const parts = wallParts(ms, offsetMinutes);
  try {
    return msInZone(parts.year, parts.month, parts.day, parts.hour, parts.minute, timeZone);
  } catch {
    return Number(ms);
  }
}

function zonedPlanStops(stops) {
  return (stops || []).map((stop) => {
    const timeZone = zoneForStop(stop);
    if (!timeZone) return { ...stop };
    return {
      ...stop,
      timeZone,
      start: zonedInstant(stop.start, enteredOffset(stop, "start"), timeZone),
      end: zonedInstant(stop.end, enteredOffset(stop, "end"), timeZone),
    };
  });
}

function tripReadyToRecalc(stops = state.stops) {
  const dests = (stops || []).filter((stop, index) => !isOriginStop(stops, index) && !stop.skipRoute && !stop.done);
  if (!dests.length) return false;
  return dests.every((stop) => (Number(stop.miles) || 0) > 0.05 || (Number(stop.hours) || 0) > 0.0001);
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
  return `<button type="button" class="flag-box" data-stop-when="${escapeAttr(stop.id)}" data-stop-field="${field}">${escapeAttr(formatUserShort(ms, enteredOffset(stop, field)))}</button>`;
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

function speedChoiceLabel() {
  if (!state.settings.governed) return "Off";
  return String(state.settings.governedMph || DEFAULT_MPH);
}

function blankSpeedNote() {
  state.speedFrom = "";
  state.speedTo = "";
  state.speedNote = "";
}

function parkSpeedNote() {
  const trip = state.trips.find((item) => item.id === state.activeTripId);
  if (!trip) return;
  if (state.speedFrom && state.speedTo && state.speedFrom !== state.speedTo) {
    trip.speedFrom = state.speedFrom;
    trip.speedTo = state.speedTo;
  } else {
    delete trip.speedFrom;
    delete trip.speedTo;
  }
}

function showTripSpeedNote(trip) {
  const from = String(trip?.speedFrom || "");
  const to = String(trip?.speedTo || "");
  if (from && to && from !== to) {
    state.speedFrom = from;
    state.speedTo = to;
  } else blankSpeedNote();
}

function clearSpeedNote() {
  blankSpeedNote();
  const trip = state.trips.find((item) => item.id === state.activeTripId);
  if (trip) {
    delete trip.speedFrom;
    delete trip.speedTo;
  }
}

function markGovernedStale(fromLabel) {
  if (!state.plan) return;
  const from = String(fromLabel || "");
  const to = speedChoiceLabel();
  if (!state.speedFrom && from && from !== to) state.speedFrom = from;
  if (state.speedFrom) state.speedTo = to;
  if (!state.speedFrom || state.speedFrom === state.speedTo) clearSpeedNote();
  else parkSpeedNote();
  persist();
}

function speedNoteText() {
  if (!state.plan || !state.speedFrom || !state.speedTo || state.speedFrom === state.speedTo) return "";
  return `The clocks stay as they are. Recalculate if you want HERE to figure the drive hours for this speed (${state.speedFrom} to ${state.speedTo}). Fast mode may also pick different roads.`;
}

function billableStops() {
  return state.stops.filter((stop, index) => !isOriginStop(state.stops, index) && !stop.skipRoute && !stop.done);
}

function calculateButtonLabel() {
  if (state.estimating) return "Asking HERE<sup>©</sup>…";
  const work = legsToCalculate(state.stops);
  const count = work.indexes.length;
  const use = count > 0 ? `${count} credit${count === 1 ? "" : "s"}` : "";
  const left = state.unlimited
    ? "unlimited credits left"
    : (state.signedIn || state.cardOnFile) && state.credits != null
      ? `${state.credits} left`
      : "";
  const verb = state.plan ? "Recalculate" : "Calculate";
  const action = work.mode === "suffix"
    ? `${verb} from ${escapeAttr(cardTitle(work.anchor, state.stops))}`
    : verb;
  return [action, use, left].filter(Boolean).join(" · ");
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
  const offset = state.settings.leaveAtOffset;
  const timeZone = !state.settings.leaveNow && Number.isFinite(Number(offset)) ? offsetZone(offset) : "";
  return resolvedLeaveAt({
    leaveNow: state.settings.leaveNow,
    leaveAt: state.settings.leaveAt,
    now: Date.now(),
    startMinutes: state.settings.startMinutes,
    timeZone,
  });
}

function rebuiltPlan() {
  const timed = stopsAndLeaveForPlan();
  return buildPlan({
    stops: zonedPlanStops(timed.stops),
    settings: {
      ...state.settings,
      leaveAt: timed.leaveAt,
    },
    now: timed.leaveAt,
  });
}

function planShape(plan) {
  return (plan?.events || []).map((event) => [
    event.id,
    event.kind,
    event.late ? 1 : 0,
    event.timePhrase || "",
    Math.round(Number(event.miles) * 10) || 0,
  ].join("~")).join("|");
}

function catchUpPlan() {
  if (!state.settings.leaveNow || !state.plan || state.estimating) return;
  try {
    const result = rebuiltPlan();
    if (!result || result.error) return;
    state.plan = result;
  } catch {
    // Keep the plan already on the page.
  }
}

function refreshShownPlan() {
  if (state.estimating) return;
  if (state.plan) {
    try {
      const result = rebuiltPlan();
      if (result && !result.error) state.plan = result;
    } catch {
      // Keep the plan already on the page.
    }
  }
  render();
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
  wantAccountTrip = true;
  settleLoadedStops(state.stops);
  pinEnteredClocks();
  persist();
  if (!state.plan || tripReadyToRecalc()) calculate({ silent: true, skipHash: true });
  else {
    void keepSharedOnAccount({ quiet: true }).then(() => render());
  }
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
  if (!Array.isArray(onto) || !Array.isArray(fromStops)) return onto;
  let changed = false;
  const next = onto.map((stop, index) => {
    const from = fromStops.find((item) => item.id === stop.id) || fromStops[index];
    if (!from) return stop;
    const needPath = !hasRouteLine([stop]) && Array.isArray(from.path) && from.path.length > 1;
    const needDir = (!Array.isArray(stop.directions) || !stop.directions.length) && Array.isArray(from.directions) && from.directions.length;
    if (!needPath && !needDir) return stop;
    changed = true;
    const copy = { ...stop };
    if (needPath) copy.path = from.path;
    if (needDir) copy.directions = from.directions;
    return copy;
  });
  return changed ? next : onto;
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

function creditEmptyMessage() {
  if (state.cardOnFile) return "You are out of credits. Buy a pack of 124. The card on file is not charged.";
  if (state.signedIn) return "Those 40 free credits are used. Save a card for 40 more. That card is not charged when they run out.";
  return "Sign in with Google for 40 free credits. Save a card for 40 more. That card is not charged when they run out.";
}

function legStillCounts(stop, fraction) {
  const miles = (Number(stop.miles) || 0) * fraction;
  const hours = (Number(stop.hours) || 0) * fraction;
  return hours > 0.0001 || miles > 0.05;
}

function nextTimedStop(fromIndex) {
  for (let i = fromIndex + 1; i < state.stops.length; i += 1) {
    const stop = state.stops[i];
    if (!stop || stop.useCurrentLocation || stop.skipRoute || stop.done) continue;
    if ((Number(stop.miles) || 0) > 0.05 || (Number(stop.hours) || 0) > 0.0001) return stop;
  }
  return null;
}

async function updateTimesFromHere() {
  if (state.updatingTimes || state.estimating) return;
  state.updatingTimes = true;
  state.error = "";
  state.notice = "Finding you…";
  render();
  const here = navOn && navFix
    ? { lat: navFix[0], lon: navFix[1] }
    : await currentFix();
  if (!here) {
    state.updatingTimes = false;
    state.notice = "";
    state.error = "Allow location, then update times.";
    render();
    return;
  }
  rebuildNavLegs();
  if (navLine.length < 2 || !navLegs.length) {
    state.updatingTimes = false;
    state.notice = "";
    state.error = "Calculate the trip first.";
    render();
    return;
  }
  const locked = navNearest(here.lat, here.lon, navLine);
  const closest = nearestOnPath(here.lat, here.lon, navLine);
  const hit = closest.dist + 50 < locked.dist ? closest : locked;
  if (hit === closest && closest.dist <= 2 * 1609.344) navAlongLock = closest.along;
  if (hit.dist > 2 * 1609.344) {
    state.updatingTimes = false;
    state.notice = "";
    state.error = "You're not on the saved route. Recalculate the stop you are driving toward.";
    render();
    return;
  }
  let leg = navLegs.find((item) => hit.along >= item.start && hit.along <= item.end) || navLegs[navLegs.length - 1];
  let legMeters = Math.max(1, leg.end - leg.start);
  let into = Math.min(legMeters, Math.max(0, hit.along - leg.start));
  let remaining = Math.max(0, legMeters - into);
  let fraction = remaining / legMeters;
  let stop = leg.stop;
  if (remaining < STOP_ARRIVE_M || !legStillCounts(stop, fraction)) {
    const index = state.stops.findIndex((item) => item.id === stop.id);
    const next = nextTimedStop(index);
    state.updatingTimes = false;
    if (!stop.useCurrentLocation) {
      const at = state.stops.findIndex((item) => item.id === stop.id);
      if (at >= 0 && !isOriginStop(state.stops, at)) {
        markStopDone(stop);
      }
    }
    if (!next) {
      state.notice = "";
      state.error = "You're already at the last stop.";
      render();
      return;
    }
    state.driveProgress = { stopId: next.id, remainFraction: 1, leftAt: Date.now() };
    state.notice = `You're at ${navStopTitle(stop)}. Times start from the next stop. Later stops were not recalculated.`;
    await calculate({ silent: true });
    return;
  }
  const fullMiles = (Number(stop.miles) || 0) > 0.05 ? Number(stop.miles) : legMeters / 1609.344;
  const fullHours = Number(stop.hours) || 0;
  const driven = fullMiles * (into / legMeters);
  const left = fullMiles * fraction;
  state.driveProgress = {
    stopId: stop.id,
    remainFraction: fraction,
    leftAt: Date.now(),
    remainMiles: left,
    remainHours: Math.max(0, fullHours * fraction),
  };
  state.updatingTimes = false;
  state.notice = driven > 0.5
    ? `You're ${formatMiles(driven)} toward ${navStopTitle(stop)}. ${formatMiles(left)} left on that stop. Later stops were not recalculated.`
    : "Times start from where you are now. The saved route was not recalculated.";
  await calculate({ silent: true });
}

async function calculate({ silent = false, skipHash = false, keepScreen = false } = {}) {
  if (!silent && needsStartChoice()) {
    state.chooseStart = true;
    state.error = "";
    state.notice = "";
    render();
    document.getElementById("stepStart")?.scrollIntoView({ block: "start", behavior: "smooth" });
    return;
  }
  state.chooseStart = false;
  if (!silent) {
    const here = await arrivedFix();
    if (here) {
      rebuildNavLegs();
      noteArrivedStops(here.lat, here.lon);
    }
    if (billableStops().length === 0) {
      state.estimating = false;
      state.error = "";
      state.notice = "Those stops are done. Nothing new to calculate.";
      render();
      return;
    }
  }
  if (!silent && !state.unlimited && state.credits === 0) {
    state.error = creditEmptyMessage();
    render();
    return;
  }
  let hereLegs = null;
  if (!silent) {
    if (legsToCalculate(state.stops).mode !== "suffix") clearDriveProgress();
    state.estimating = true;
    state.error = "";
    state.notice = "Asking HERE© for a truck-legal route…";
    render();
    try {
      hereLegs = await fillHereLegs();
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
  if (hereLegs?.from && !state.driveProgress && state.stops.some((stop) => stop?.done)) {
    const next = state.stops.find((stop, index) => (
      !isOriginStop(state.stops, index) && !stop.done && !stop.skipRoute && stopHasSavedLeg(stop)
    ));
    if (next) state.driveProgress = { stopId: next.id, remainFraction: 1, leftAt: Date.now() };
  }
  const timed = stopsAndLeaveForPlan();
  let leaveAt = timed.leaveAt;
  if (hereLegs?.from && !state.driveProgress && state.stops.some((stop) => stop?.done)) leaveAt = Date.now();
  const result = buildPlan({
    stops: zonedPlanStops(timed.stops),
    settings: {
      ...state.settings,
      leaveAt,
    },
    now: leaveAt,
  });
  if (result.error) {
    state.arrivalBusy = false;
    state.plan = silent ? state.plan : null;
    state.error = result.error;
    if (!silent) state.notice = "";
    if (keepScreen && routeFull && document.getElementById("routeStage")) {
      showStopNote(state.error, 8000);
      syncRouteChrome();
      persist();
      return;
    }
    render();
    persist();
    return;
  }
  state.plan = result;
  state.error = "";
  state.arrivalBusy = false;
  if (wantAccountTrip) await keepSharedOnAccount({ quiet: true });
  const routeNote = hereLegs?.from
    ? `HERE© truck route from ${hereLegs.from} (${TRUCK_PROFILE.summary}). Earlier stops were not recalculated.`
    : `HERE© truck route (${TRUCK_PROFILE.summary}).`;
  if (!silent && !hereLegs?.from) clearSpeedNote();
  if (!skipHash && state.signedIn) {
    saveTrip();
    if (silent) {
      presentAfterPlan(keepScreen);
      putTrips(state.trips).then(() => {
        markTripsUploaded();
        persist();
      }).catch(() => {});
      return;
    }
    try {
      await putTrips(state.trips);
      markTripsUploaded();
      if (!silent) state.notice = `${routeNote} Trip saved to your account.`;
    } catch (error) {
      if (!silent) state.notice = error.message || "Saved on this device. The account copy did not update.";
    }
  } else if (!silent) {
    state.notice = routeNote;
  }
  presentAfterPlan(keepScreen);
}

function presentAfterPlan(keepScreen) {
  persist();
  const stage = document.getElementById("routeStage");
  if (keepScreen && routeFull && stage) {
    routePageStale = true;
    if (routeMap) paintLiveRoute();
    syncRouteChrome();
    return;
  }
  render();
}

let wantAccountTrip = false;

function tripOnAccount() {
  if (!state.plan) return false;
  if (state.activeTripId && state.trips.some((trip) => trip.id === state.activeTripId)) return true;
  let token = "";
  try { token = shareToken(); } catch { return false; }
  return state.trips.some((trip) => {
    try { return shareTokenFor(trip) === token; } catch { return false; }
  });
}

async function keepSharedOnAccount({ quiet = false } = {}) {
  if (!state.plan) return;
  if (tripOnAccount()) {
    if (!quiet) state.notice = "This trip is already on your account.";
    wantAccountTrip = false;
    return;
  }
  if (!state.signedIn) {
    state.notice = "Sign in to add this trip to your account.";
    return;
  }
  state.activeTripId = null;
  saveTrip();
  try {
    await putTrips(state.trips);
    markTripsUploaded();
    state.notice = "Added to your account. It is in Saved trips.";
    wantAccountTrip = false;
  } catch {
    state.notice = "Saved on this device. The account copy did not update.";
  }
  persist();
}

function saveTrip() {
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
    summary: state.plan ? {
      miles: state.plan.miles,
      driveHours: state.plan.driveHours,
      rollAt: state.plan.rollAt,
      arriveAt: state.plan.arriveAt,
    } : null,
    driveProgress: state.driveProgress,
    pendingUpload: true,
    ...(state.speedFrom && state.speedTo && state.speedFrom !== state.speedTo
      ? { speedFrom: state.speedFrom, speedTo: state.speedTo }
      : {}),
  };
  state.trips = [trip, ...state.trips.filter((item) => item.id !== id)].slice(0, 40);
  state.activeTripId = id;
}

async function saveNamedTrip() {
  if (navOn) return;
  const field = document.getElementById("tripName");
  if (field) state.tripName = field.value;
  if (!storedTripHasWork({
    stops: state.stops,
    tripName: state.tripName,
    origin: originPoint(),
    plan: state.plan,
    trips: [],
  })) {
    state.saveNote = "Add a stop or a name, then Save.";
    render();
    return;
  }
  saveTrip();
  persist();
  if (state.signedIn) {
    try {
      await putTrips(state.trips);
      markTripsUploaded();
      persist();
      state.saveNote = "Saved to your account.";
    } catch (error) {
      state.saveNote = error.message || "Saved on this device. The account copy did not update.";
    }
  } else {
    state.saveNote = "Saved on this device. Sign in to keep it on your account.";
  }
  render();
}

function paintClearTrip() {
  const slot = document.getElementById("clearTripSlot");
  if (slot) slot.hidden = !addressEditStarted;
}

function clearTripButton() {
  return `<p class="trips-clear" id="clearTripSlot"${addressEditStarted ? "" : " hidden"}><button type="button" class="flag-box" id="newTrip"${navOn ? " disabled" : ""}>Clear trip</button></p>`;
}

function tripNameRow() {
  return `<div class="trip-name-row">
    <label class="flag-box trip-name">Trip name
      <textarea id="tripName" rows="1" placeholder="Optional — Dallas to Atlanta" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">${escapeAttr(state.tripName)}</textarea>
    </label>
    <button type="button" class="flag-box" id="saveTrip"${navOn ? " disabled" : ""}>Save</button>
  </div>${state.saveNote ? `<p class="fine save-note">${escapeAttr(state.saveNote)}</p>` : ""}`;
}

function loadTrip(id) {
  if (navOn) return;
  const trip = state.trips.find((item) => item.id === id);
  if (!trip) return;
  if (trip.id !== state.activeTripId) {
    parkSpeedNote();
    showTripSpeedNote(trip);
  }
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
  state.driveProgress = readDriveProgress(trip.driveProgress);
  state.notice = `Opened ${trip.name}.`;
  addressEditStarted = false;
  settleLoadedStops(state.stops);
  pinEnteredClocks();
  if (!state.plan || tripReadyToRecalc()) calculate({ silent: true, skipHash: true });
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
  if (!exampleStillStock()) {
    if (state.plan && tripReadyToRecalc()) calculate({ silent: true, skipHash: true });
    return;
  }
  const stored = storedExampleWeek(state.stops);
  if (stored != null && stored < exampleWeeksAhead()) {
    loadExample();
    return;
  }
  calculate({ silent: true, skipHash: true });
}

function loadExample() {
  parkSpeedNote();
  const trip = shiftExampleStamps(JSON.parse(JSON.stringify(EXAMPLE_TRIP)), exampleWeeksAhead() * 7);
  state.settings = { ...state.settings, ...(trip.settings || {}) };
  delete state.settings.sleepHours;
  delete state.settings.readyMinutes;
  state.stops = Array.isArray(trip.stops) ? trip.stops : [];
  clearDriveProgress();
  state.tripName = trip.tripName || trip.name || "";
  state.activeTripId = null;
  state.origin = trip.origin || null;
  const gps = state.stops.find((stop) => stop.useCurrentLocation);
  if (!state.origin && gps && Number.isFinite(Number(gps.lat)) && Number.isFinite(Number(gps.lon))) {
    state.origin = { lat: Number(gps.lat), lon: Number(gps.lon) };
  }
  state.plan = trip.plan && Array.isArray(trip.plan.events) ? trip.plan : null;
  blankSpeedNote();
  state.error = "";
  state.notice = `Opened ${trip.name}.`;
  addressEditStarted = false;
  settleLoadedStops(state.stops);
  pinEnteredClocks();
  calculate({ silent: true, skipHash: true });
}

async function deleteTrip(id) {
  if (navOn) return;
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

let tripsSynced = false;

function tripCacheItem(trip) {
  return {
    id: trip.id,
    name: trip.name || "",
    tripName: trip.tripName || "",
    savedAt: Number(trip.savedAt) || 0,
    settings: trip.settings && typeof trip.settings === "object" ? trip.settings : {},
    stops: (Array.isArray(trip.stops) ? trip.stops : []).map((stop) => {
      const copy = { ...stop };
      delete copy.path;
      delete copy.directions;
      delete copy.suggestions;
      return copy;
    }),
    origin: trip.origin || null,
    plan: trip.plan && Array.isArray(trip.plan.events) ? trip.plan : null,
    summary: trip.summary || null,
    driveProgress: readDriveProgress(trip.driveProgress),
    speedFrom: trip.speedFrom || "",
    speedTo: trip.speedTo || "",
  };
}

function writeTripCache() {
  if (!state.signedIn || !state.email) return;
  try {
    localStorage.setItem(TRIP_CACHE, JSON.stringify({
      email: state.email,
      trips: state.trips.map(tripCacheItem),
    }));
  } catch {
    // The account copy is still there if this phone is out of space.
  }
}

function readTripCache(email) {
  try {
    const saved = JSON.parse(localStorage.getItem(TRIP_CACHE) || "null");
    if (!saved || !Array.isArray(saved.trips)) return null;
    if (email && saved.email && saved.email !== email) return null;
    return saved.trips.filter((trip) => trip && trip.id);
  } catch {
    return null;
  }
}

function rememberListedTrips(trips) {
  if (!Array.isArray(trips)) return;
  mergeRemoteTrips(trips, { touchEditor: !editorBusy() });
  persist();
  writeTripCache();
  state.tripsLoading = false;
  tripsSynced = true;
}

function editorBusy() {
  const el = document.activeElement;
  return navOn || routeFull || Boolean(el && el.matches && el.matches("input, textarea, select"));
}

function editorMatchesTrip(trip) {
  const editorIds = (state.stops || []).map((stop) => stop.id);
  const tripIds = (trip?.stops || []).map((stop) => stop.id);
  if (!editorIds.length || editorIds.length !== tripIds.length) return false;
  return editorIds.every((id, index) => id === tripIds[index]);
}

function savedTripForEditor() {
  return state.trips.find((trip) => editorMatchesTrip(trip)) || null;
}

/** The empty Stop 1 left after sign-out. A stolen road line does not count. */
function editorIsUnused() {
  if ((state.tripName || "").trim()) return false;
  if (state.plan && Array.isArray(state.plan.events) && state.plan.events.length) return false;
  const stops = state.stops || [];
  if (!stops.length) return true;
  if (stops.length !== 1) return false;
  const stop = stops[0];
  if (stop.useCurrentLocation) return false;
  const name = (stop.name || "").trim();
  if (name && name !== "Stop 1") return false;
  if ((stop.address || "").trim()) return false;
  if ((Number(stop.miles) || 0) > 0.05 || (Number(stop.hours) || 0) > 0.0001) return false;
  if (Number.isFinite(Number(stop.lat)) && Number.isFinite(Number(stop.lon))) return false;
  return true;
}

function restoreOpenTrip() {
  if (!state.activeTripId) {
    const matched = savedTripForEditor();
    if (matched) state.activeTripId = matched.id;
  }
  const open = state.trips.find((trip) => trip.id === state.activeTripId);
  if (open && !editorMatchesTrip(open)) {
    if (editorIsUnused() && (open.stops || []).length) {
      loadTrip(open.id);
      return;
    }
    state.activeTripId = savedTripForEditor()?.id || null;
  }
  const current = state.trips.find((trip) => trip.id === state.activeTripId);
  if (current && editorMatchesTrip(current) && !hasRouteLine(state.stops)) {
    state.stops = copyRouteLine(state.stops, current.stops);
    return;
  }
  if (!state.activeTripId && editorIsUnused()) {
    const latest = state.trips.find((trip) => (trip.stops || []).length);
    if (latest) loadTrip(latest.id);
  }
}

function mergeRemoteTrips(remote, { touchEditor = true } = {}) {
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
  if (!touchEditor) return;
  restoreOpenTrip();
}

function uploadPendingTrips() {
  if (!state.signedIn || !state.trips.some((trip) => trip.pendingUpload)) return;
  putTrips(state.trips).then(() => {
    markTripsUploaded();
    persist();
    writeTripCache();
  }).catch(() => {});
}

async function fillTripGeometry() {
  try {
    const data = await fetchTrips(true);
    if (!Array.isArray(data.trips) || data.listOnly) return;
    if (!localStorage.getItem("planigator.web.session") && !state.signedIn) return;
    const busy = editorBusy();
    const before = state.stops.map((stop) => `${stop.path?.length || 0}:${stop.directions?.length || 0}`).join("|");
    const namesBefore = state.trips.map((trip) => `${trip.id}:${trip.savedAt}`).join("|");
    mergeRemoteTrips(data.trips, { touchEditor: !busy });
    if (busy && state.activeTripId) {
      const donor = state.trips.find((trip) => trip.id === state.activeTripId);
      if (donor) state.stops = copyRouteLine(state.stops, donor.stops);
    }
    const after = state.stops.map((stop) => `${stop.path?.length || 0}:${stop.directions?.length || 0}`).join("|");
    const namesAfter = state.trips.map((trip) => `${trip.id}:${trip.savedAt}`).join("|");
    persist();
    writeTripCache();
    uploadPendingTrips();
    if (!busy && (before !== after || namesBefore !== namesAfter)) render();
  } catch {
    // Names already on screen stay. The road line fills on the next open.
  }
}

async function pullAccountTrips() {
  const session = localStorage.getItem("planigator.web.session");
  if (!state.signedIn && !session) {
    const kept = state.trips.filter((trip) => trip && !trip.pendingUpload);
    if (kept.length !== state.trips.length) {
      state.trips = kept;
      if (state.activeTripId && !state.trips.some((trip) => trip.id === state.activeTripId)) state.activeTripId = null;
      persist();
    }
    state.tripsLoading = false;
    return;
  }
  if (!state.trips.length && state.email) {
    const cached = readTripCache(state.email);
    if (cached?.length) state.trips = cached;
  }
  state.tripsLoading = state.trips.length === 0;
  try {
    const data = await fetchTrips(false);
    if (!localStorage.getItem("planigator.web.session") && !state.signedIn) return;
    mergeRemoteTrips(Array.isArray(data.trips) ? data.trips : [], { touchEditor: !editorBusy() });
    persist();
    writeTripCache();
    uploadPendingTrips();
    if (data.listOnly) void fillTripGeometry();
  } catch {
    // Keep the trips already on this device.
  } finally {
    state.tripsLoading = false;
    tripsSynced = true;
  }
}

function addStop(afterId) {
  const next = defaultStop();
  let atEnd = true;
  if (afterId) {
    const index = state.stops.findIndex((stop) => stop.id === afterId);
    const previous = state.stops[index];
    if (previous && !previous.useCurrentLocation) {
      next.start = previous.start + 4 * 3600 * 1000;
      next.end = next.start + 4 * 3600 * 1000;
      const offset = clockOffset(previous.startOffset);
      next.startOffset = offset;
      next.endOffset = offset;
    }
    atEnd = index === state.stops.length - 1;
    state.stops.splice(index + 1, 0, next);
  } else {
    state.stops.push(next);
  }
  if (!atEnd) clearDriveProgress();
  persist();
  render();
}

function addStopBefore(beforeId) {
  const next = defaultStop();
  const index = state.stops.findIndex((stop) => stop.id === beforeId);
  const at = index < 0 ? 0 : index;
  const following = state.stops[at];
  if (following && Number.isFinite(Number(following.start))) {
    next.end = following.start;
    next.start = following.start - 4 * 3600 * 1000;
    const offset = clockOffset(following.startOffset);
    next.startOffset = offset;
    next.endOffset = offset;
  }
  state.stops.splice(at, 0, next);
  if (isOriginStop(state.stops, at)) {
    const later = state.stops.slice(at + 1).filter((stop) => !stop.useCurrentLocation && !stop.skipRoute && !stop.done);
    if (later.length && later.every((stop) => stopHasSavedLeg(stop))) {
      later[0].miles = "";
      later[0].hours = "";
      state.plan = null;
    }
  }
  clearDriveProgress();
  persist();
  render();
}

function stopCanRemove(index) {
  if (isOriginStop(state.stops, index)) return false;
  const addressCount = state.stops.filter((stop) => !stop.useCurrentLocation).length;
  return addressCount > 1 || state.stops.some((stop) => stop.useCurrentLocation);
}

function positionForArrival() {
  if (navOn && Array.isArray(navFix)) return Promise.resolve({ lat: navFix[0], lon: navFix[1] });
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      resolve(null);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: true, maximumAge: 15000, timeout: 8000 },
    );
  });
}

function arrivedAtRemovedStop(stop, here) {
  if (!stop || !here || stop.useCurrentLocation || !pointReady(stop)) return false;
  const herePair = [here.lat, here.lon];
  rebuildNavLegs();
  const leg = navLegs.find((item) => item.stop.id === stop.id);
  if (leg && navLine.length >= 2) {
    const hit = navNearest(here.lat, here.lon, navLine);
    if (hit.dist <= STOP_LINE_M) {
      const remaining = leg.end - hit.along;
      if (remaining <= STOP_NEAR_M && remaining >= -STOP_NEAR_M) return true;
    }
  }
  const pinDist = metersBetween(herePair, [Number(stop.lat), Number(stop.lon)]);
  if (pinDist > STOP_NEAR_M) return false;
  for (const other of state.stops) {
    if (!other || other.id === stop.id || other.useCurrentLocation || other.skipRoute || !pointReady(other)) continue;
    if (metersBetween(herePair, [Number(other.lat), Number(other.lon)]) < pinDist) return false;
  }
  return true;
}

function doneStamp() {
  return `<div class="done-mark" aria-hidden="true"><svg viewBox="0 0 200 180" focusable="false"><path d="M20 102 L70 152 L168 40" fill="none" stroke="#083526" stroke-width="34" stroke-linecap="round" stroke-linejoin="round"/><path d="M20 102 L70 152 L168 40" fill="none" stroke="#3dcaa0" stroke-width="24" stroke-linecap="round" stroke-linejoin="round"/><circle cx="112" cy="104" r="34" fill="#3dcaa0" stroke="#083526" stroke-width="5"/><circle cx="100" cy="96" r="4.4" fill="#083526"/><circle cx="126" cy="96" r="4.4" fill="#083526"/><path d="M96 112 Q113 130 130 112" fill="none" stroke="#083526" stroke-width="4.4" stroke-linecap="round"/></svg></div>`;
}

function paintDoneStop(id) {
  const card = document.querySelector(`[data-stop="${id}"]`);
  if (!card || card.classList.contains("is-done")) return;
  card.classList.add("is-done");
  card.inert = false;
  const title = (card.querySelector("textarea[data-field=name]")?.value || "").trim() || "Stop";
  card.setAttribute("aria-label", `${title} done`);
  card.querySelectorAll("label").forEach((node) => { node.inert = true; });
  card.querySelectorAll("textarea, button, select, input").forEach((node) => {
    if (node.getAttribute("data-act") === "remove") return;
    node.disabled = true;
    node.inert = true;
  });
  card.querySelectorAll(".here-leg, .stop-done").forEach((node) => node.remove());
  card.insertAdjacentHTML("beforeend", doneStamp());
}

function donePlanChip(stop, index = state.stops.findIndex((item) => item.id === stop.id)) {
  const at = index >= 0 ? index : 0;
  const rgb = stopColor(at, state.stops);
  const ink = stopInk(rgb);
  const title = cardTitle(at, state.stops);
  return `<div class="chip is-done" data-done-plan="${escapeAttr(stop.id)}" style="background:${cssRGB(rgb)};color:${ink.color}" aria-label="${escapeAttr(title)} done">
    <div class="chip-sec">${escapeAttr(title)}</div>
    ${doneStamp()}
  </div>`;
}

function rebuildPlanAfterDone() {
  if (!state.plan) {
    persist();
    return;
  }
  const timed = stopsAndLeaveForPlan();
  const result = buildPlan({
    stops: zonedPlanStops(timed.stops),
    settings: {
      ...state.settings,
      leaveAt: timed.leaveAt,
    },
    now: timed.leaveAt,
  });
  if (!result.error) state.plan = result;
  persist();
  patchPlanAfterDone();
  routePageStale = true;
  const calc = document.getElementById("calculate");
  if (calc && !state.estimating) calc.innerHTML = calculateButtonLabel();
}

function patchPlanOnCards() {
  if (!pageLayout().planOnCards) return;
  const firstLive = state.stops.findIndex((stop, index) => (
    !isOriginStop(state.stops, index) && !stop.done && !stop.skipRoute
  ));
  state.stops.forEach((stop, index) => {
    if (isOriginStop(state.stops, index) || stop.useCurrentLocation) return;
    const card = document.querySelector(`[data-stop="${stop.id}"]`);
    if (!card) return;
    let node = card.nextElementSibling;
    while (node && !node.matches?.("article.stop-card, button[data-after], button[data-before], section")) {
      const next = node.nextElementSibling;
      if (
        node.matches?.(".chip, .chip-row, [data-done-plan]")
        || node.classList?.contains("late-note")
      ) {
        node.remove();
        node = next;
        continue;
      }
      break;
    }
    let html = "";
    if (stop.done) html = donePlanChip(stop, index);
    else if (!stop.skipRoute) {
      const around = eventsAround(stop.id);
      if (index === firstLive) html += around.now.map(chip).join("");
      html += around.before.map(chip).join("");
      if (around.self) html += chip(around.self);
      html += around.following.map(chip).join("");
    }
    if (html) card.insertAdjacentHTML("afterend", html);
  });
}

function patchPlanAfterDone() {
  const planStep = document.getElementById("planStep");
  if (planStep) {
    const heading = planStep.querySelector("h2")?.textContent || "The plan";
    planStep.outerHTML = planTimeline(heading);
  }
  patchPlanOnCards();
}

function markStopDone(stop, { switched = false } = {}) {
  if (!stop || stop.done) return;
  stop.done = true;
  if (switched) stop.switched = true;
  stop.skipRoute = true;
  paintDoneStop(stop.id);
  const next = state.stops.find((item, index) => (
    !isOriginStop(state.stops, index) && !item.done && !item.skipRoute && stopHasSavedLeg(item)
  ));
  if (next) {
    state.driveProgress = { stopId: next.id, remainFraction: 1, leftAt: Date.now() };
  }
  rebuildPlanAfterDone();
}

function closerLegEnd(leg, hit) {
  const distance = Math.abs(leg.end - hit.along);
  return navLegs.some((other) => {
    if (!other || other === leg) return false;
    const otherDistance = Math.abs(other.end - hit.along);
    if (otherDistance < distance - 1) return true;
    return otherDistance <= distance + 1 && other.end < leg.end;
  });
}

function nearStopEnd(stop, lat, lon, hit) {
  const leg = navLegs.find((item) => item.stop.id === stop.id);
  if (!leg || !hit) return false;
  const remaining = leg.end - hit.along;
  // A mile before the pin is still the drive to this stop. Arrive at the end.
  const onLine = hit.dist <= STOP_LINE_M && remaining <= STOP_ARRIVE_M && remaining >= -STOP_NEAR_M;
  const passed = onLine && remaining <= STOP_PAST_M;
  if (!passed && closerLegEnd(leg, hit)) return false;
  if (onLine) return true;
  const pinDist = metersBetween([lat, lon], [Number(stop.lat), Number(stop.lon)]);
  if (pinDist > STOP_ARRIVE_M || hit.along < leg.end - STOP_ARRIVE_M) return false;
  return !state.stops.some((other) => {
    if (!other || other.id === stop.id || other.useCurrentLocation || other.done || other.skipRoute || !pointReady(other)) return false;
    return metersBetween([lat, lon], [Number(other.lat), Number(other.lon)]) < pinDist;
  });
}

function arrivedFix() {
  if (navOn && Array.isArray(navFix)) return Promise.resolve({ lat: navFix[0], lon: navFix[1] });
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      resolve(null);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: true, maximumAge: 15000, timeout: 4000 },
    );
  });
}

function noteArrivedStops(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || navLine.length < 2) return;
  const hit = navNearest(lat, lon, navLine);
  let changed = false;
  // A stop locks when you tap Switch, not when the truck gets close.
  // Drop a lock that was applied early and that you did not choose.
  state.stops.forEach((stop, index) => {
    if (!stop?.done || stop.switched || stop.skipRoute || isOriginStop(state.stops, index)) return;
    const leg = navLegs.find((item) => item.stop.id === stop.id);
    if (!leg || hit.along > leg.end - STOP_ARRIVE_M) return;
    stop.done = false;
    changed = true;
  });
  if (!changed) return;
  persist();
  const calc = document.getElementById("calculate");
  if (calc && !state.estimating) calc.innerHTML = calculateButtonLabel();
  if (routeFull) routePageStale = true;
}

function stopHasSavedLeg(stop) {
  return (Number(stop?.miles) || 0) > 0.05 || (Number(stop?.hours) || 0) > 0.0001;
}

async function removeStop(id) {
  const index = state.stops.findIndex((stop) => stop.id === id);
  if (index < 0 || !stopCanRemove(index)) return;
  const removed = state.stops[index];
  let next = null;
  for (let i = index + 1; i < state.stops.length; i += 1) {
    const stop = state.stops[i];
    if (!stop || stop.useCurrentLocation || stop.skipRoute || stop.done) continue;
    next = stop;
    break;
  }
  const here = state.plan && next && stopHasSavedLeg(next) ? await positionForArrival() : null;
  const arrived = Boolean(here && arrivedAtRemovedStop(removed, here));
  if (Array.isArray(removed?.directions)) {
    for (const stop of state.stops) {
      if (stop.id !== removed.id && stop.directions === removed.directions) stop.directions = [];
    }
  }
  state.stops = state.stops.filter((stop) => stop.id !== id);
  refreshAfterStopRemoved();
  if (arrived) {
    state.driveProgress = { stopId: next.id, remainFraction: 1, leftAt: Date.now() };
    state.error = "";
    state.notice = `Removed ${navStopTitle(removed)}. Times start from the next stop. The saved route was not recalculated.`;
    await calculate({ silent: true });
    if (state.error) {
      state.notice = "";
      render();
    }
    return;
  }
  clearDriveProgress();
  persist();
  if (state.plan) await calculate({ silent: true });
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
  clearDriveProgress();
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
    const index = state.stops.findIndex((item) => item.id === id);
    const next = state.stops[index + 1];
    const wipedSaved = stopHasSavedLeg(stop) || stopHasSavedLeg(next);
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
    if (next) {
      next.miles = "";
      next.hours = "";
    }
    if (wipedSaved) {
      state.plan = null;
      clearDriveProgress();
    }
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
  if (navOn) return;
  parkSpeedNote();
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
  addressEditStarted = false;
  blankSpeedNote();
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
  document.querySelectorAll(".hos").forEach((hos) => {
    hos.style.setProperty("--box-font", `${state.boxFont}px`);
  });
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

async function refreshCalls() {
  state.calls = [];
  if (!state.signedIn) return;
  try {
    const data = await fetchCalls();
    state.calls = Array.isArray(data.calls) ? data.calls : [];
  } catch {
    state.calls = [];
  }
}

async function refreshCredits({ calls = true } = {}) {
  let me = null;
  try {
    me = await creditsMe();
    applyAccount(me);
  } catch {
    if (state.credits == null) state.credits = null;
  }
  if (calls) await refreshCalls();
  else state.calls = [];
  return me;
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
    stop.done = false;
    stop.skipRoute = false;
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

function placeholderStopName(name) {
  const text = String(name || "").trim();
  return !text || /^stop(?:\s+\d+)?$/i.test(text);
}

function pastedInstant(parts, stop, field) {
  const offset = deviceOffset();
  const kept = wallParts(field === "end" ? stop.end : stop.start, enteredOffset(stop, field));
  const hour = parts.hour == null ? kept.hour : parts.hour;
  const minute = parts.minute == null ? kept.minute : parts.minute;
  const now = new Date();
  const yNow = now.getFullYear();
  const today = new Date(yNow, now.getMonth(), now.getDate()).getTime();
  let year = Number(parts.year);
  if (!Number.isFinite(year) || year < yNow) year = yNow;
  let dayMs = new Date(year, parts.monthIndex, parts.day).getTime();
  if (dayMs < today) {
    year = yNow + 1;
    dayMs = new Date(year, parts.monthIndex, parts.day).getTime();
  }
  return {
    ms: msFromWall(year, parts.monthIndex, parts.day, hour, minute, offset),
    offset,
  };
}

function pasteNote(parsed) {
  const lines = [];
  if (parsed.usedFirst) lines.push("Filled the first stop in that paste.");
  if (parsed.timed) lines.push("Times are set.");
  else if (parsed.hadWhen) lines.push("The date is set.");
  else if (parsed.anytime) lines.push("Anytime is set.");
  else lines.push("No date or time was in that paste.");
  if (parsed.address) lines.push("Look up this address and pick one.");
  return lines.join(" ");
}

function applyStopPaste(id, text) {
  const stop = state.stops.find((item) => item.id === id);
  if (!stop) return;
  const parsed = parseStopPaste(text, Date.now());
  if (!parsed || (!parsed.address && !parsed.hadWhen && !parsed.anytime)) {
    setLookupMessage(id, "Copy an address first.");
    render();
    return;
  }
  const patch = {};
  if (parsed.address) patch.address = parsed.address;
  if (parsed.name && placeholderStopName(stop.name)) {
    const name = clipStopName(parsed.name);
    if (name) patch.name = name;
  }
  if (parsed.hadWhen && parsed.start) {
    const start = pastedInstant(parsed.start, stop, "start");
    patch.anytime = false;
    patch.start = start.ms;
    patch.startOffset = start.offset;
    if (parsed.window && parsed.end) {
      const end = pastedInstant(parsed.end, stop, "end");
      patch.window = true;
      patch.end = end.ms;
      patch.endOffset = end.offset;
    } else {
      patch.window = false;
      patch.end = start.ms;
      patch.endOffset = start.offset;
    }
  } else if (parsed.anytime) {
    patch.anytime = true;
    patch.window = false;
  }
  setLookupMessage(id, pasteNote(parsed), { ok: true });
  updateStop(id, patch);
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
    setLookupMessage(id, "Allow paste, then try Paste again.");
    render();
    return;
  }
  applyStopPaste(id, text);
}

function chooseSuggestion(id, index) {
  const stop = state.stops.find((item) => item.id === id);
  const item = stop?.suggestions?.[index];
  if (!stop || !item) return;
  const hadLeg = stopHasSavedLeg(stop);
  stop.address = item.label;
  stop.verifiedLabel = item.label;
  stop.lat = item.lat;
  stop.lon = item.lon;
  stop.done = false;
  stop.skipRoute = false;
  stop.suggestions = [];
  if (state.openLookupStopId === id) state.openLookupStopId = "";
  stop.miles = "";
  stop.hours = "";
  if (hadLeg) {
    state.plan = null;
    clearDriveProgress();
  }
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
    .filter(({ stop }) => !stop.useCurrentLocation && !stop.skipRoute && !stop.done && !pointReady(stop));
  if (missing.length) {
    const names = missing.map(({ index }) => cardTitle(index, state.stops));
    const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
    throw new Error(`Press lookup address on ${list} and choose an address before pressing Calculate.`);
  }
  const work = legsToCalculate(state.stops);
  if (work.mode === "suffix") {
    const anchorName = cardTitle(work.anchor, state.stops);
    let previous = stopPoint(state.stops[work.anchor]);
    if (!previous) {
      throw new Error(`Press lookup address on ${anchorName} and choose an address before pressing Calculate.`);
    }
    for (const index of work.indexes) {
      const stop = state.stops[index];
      const point = stopPoint(stop);
      if (!point) {
        throw new Error(`Press lookup address on ${cardTitle(index, state.stops)} and choose an address before pressing Calculate.`);
      }
      const leg = await routeTruckLeg(previous, point);
      writeRoutedLeg(stop, leg);
      previous = point;
      persist();
    }
    // Done stops stay on the map so directions can leave them. The clock starts at the stop still ahead.
    for (const stop of state.stops) {
      if (!stop?.done || stop.skipRoute) continue;
      stop.skipRoute = true;
    }
    persist();
    return { from: anchorName };
  }
  const routed = [];
  const skipped = [];
  for (const stop of state.stops) {
    if (stop.skipRoute || stop.done) {
      skipped.push(stop);
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
    const leg = await routeTruckLeg(routedPoints[i - 1], routedPoints[i], course);
    routed[i].miles = String(Math.round(leg.miles * 10) / 10);
    routed[i].hours = String(Math.round(leg.hours * 100) / 100);
    routed[i].path = Array.isArray(leg.points) ? leg.points : [];
    routed[i].directions = Array.isArray(leg.directions) ? leg.directions : [];
    if (leg.credits != null) state.credits = leg.credits;
  }
  for (const stop of skipped) {
    stop.skipRoute = true;
    stop.miles = "";
    stop.hours = "";
    stop.path = [];
    stop.directions = [];
  }
  persist();
  return null;
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
  state.tripsLoading = false;
  resetLocalBoxFont();
  resetEditor();
  heldAccountTrip = null;
  persist();
  forgetAccountTripCache();
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
  if (Array.isArray(me.trips)) rememberListedTrips(me.trips);
  else {
    const cached = readTripCache(state.email);
    if (cached?.length && !state.trips.length) state.trips = cached;
    state.tripsLoading = state.trips.length === 0;
  }
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
  if (Array.isArray(me.trips)) {
    if (me.tripsListOnly !== false) void fillTripGeometry();
    uploadPendingTrips();
  } else await pullAccountTrips();
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
        state.tripsLoading = true;
        render();
        try {
          await completeGoogleCredential(credential);
        } catch (error) {
          state.tripsLoading = false;
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
    formatWhen: (ms, hint, length) => {
      const zone = hint === "leave"
        ? zoneForStop(originStop())
        : hint === "arrive"
          ? zoneForStop(arriveStop())
          : hint === "deadline"
            ? zoneForStop((state.stops || []).find((item) => item.id === state.plan?.lastStopId))
            : eventZone(hint);
      return length === "long" ? formatPlanTime(ms, zone) : formatPlanShort(ms, zone);
    },
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

function routeFeatureCollection() {
  let currentId = "";
  if (navLegs.length) currentId = activeNavLeg()?.stop?.id || "";
  if (!currentId) {
    for (const stop of state.stops || []) {
      if (!stop || stop.useCurrentLocation || stop.done || stop.skipRoute) continue;
      if (Array.isArray(stop.path) && stop.path.length >= 2) {
        currentId = stop.id;
        break;
      }
    }
  }
  const features = [];
  for (const stop of state.stops || []) {
    if (!Array.isArray(stop.path)) continue;
    const coordinates = [];
    for (const pair of stop.path) {
      const lat = Number(pair?.[0]);
      const lon = Number(pair?.[1]);
      if (Number.isFinite(lat) && Number.isFinite(lon)) coordinates.push([lon, lat]);
    }
    if (coordinates.length < 2) continue;
    features.push({
      type: "Feature",
      properties: { current: stop.id === currentId ? 1 : 0 },
      geometry: { type: "LineString", coordinates },
    });
  }
  return { type: "FeatureCollection", features };
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

function openedTripNote() {
  const notice = String(state.notice || "");
  if (!notice.startsWith("Opened ") || !notice.endsWith(".")) return "";
  if (notice === `Opened ${EXAMPLE_TRIP.name}.` && !state.activeTripId) return "";
  return `<p class="ok opened-note">${escapeAttr(notice)}</p>`;
}

function savedTripsBlock({ clear = true } = {}) {
  const clearButton = `<p class="trips-clear"><button type="button" class="flag-box" id="newTrip"${navOn ? " disabled" : ""}>Clear trip</button></p>`;
  if (!state.signedIn) return clear ? clearButton : "";
  const loading = state.tripsLoading ? `<p class="fine">Loading saved trips…</p>` : "";
  const list = state.trips.length ? `<ul>
      ${state.trips.map((trip) => `<li class="${trip.id === state.activeTripId ? "active" : ""}">
        <button type="button" class="flag-box${trip.id === state.activeTripId ? " on" : ""}" data-load="${escapeAttr(trip.id)}"${navOn ? " disabled" : ""}>
          ${escapeAttr(trip.name || trip.tripName || "Trip")}
          <span>${formatShort(trip.savedAt)}</span>
        </button>
        <button type="button" class="flag-box" data-delete="${escapeAttr(trip.id)}"${navOn ? " disabled" : ""}>${state.confirmDeleteId === trip.id ? "Confirm delete" : "Delete"}</button>
      </li>`).join("")}
    </ul>` : "";
  return `<section class="trips">
    ${clear ? clearButton : ""}
    <h2>Saved trips</h2>
    ${openedTripNote()}
    ${loading}
    ${list}
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
  const number = "([0-9][0-9,]*(?:\\.[0-9]+)?)";
  const feet = text.match(new RegExp(`(?:Go\\s+)?for\\s+${number}\\s*(?:ft|feet|foot)\\b`, "i"));
  const spokenMi = text.match(new RegExp(`(?:Go\\s+)?for\\s+${number}\\s*(?:mi|mile|miles)\\b`, "i"));
  const spokenFeet = feet ? Number(feet[1].replace(/,/g, "")) * 0.3048 : 0;
  const spokenMiles = spokenMi ? Number(spokenMi[1].replace(/,/g, "")) * 1609.344 : 0;
  const miles = Number(step?.miles);
  const stored = Number.isFinite(miles) && miles > 0 ? miles * 1609.344 : 0;
  return Math.max(spokenFeet, spokenMiles, stored);
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
  const scale = sum > 1 ? Math.max(1, total / sum) : 1;
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
  const flat = [];
  for (const group of groups) {
    group.steps.forEach((step, index) => flat.push({ group, step, index }));
  }
  const items = flat.map((item, flatIndex) => {
    const text = String(item.step.text || "");
    const shown = shownDirection(item.step, flat[flatIndex + 1]?.step);
    const leg = item.index === 0 ? `<li class="dir-leg">${escapeAttr(item.group.title)}</li>` : "";
    return `${leg}<li value="${item.index + 1}"><button type="button" class="dir-step" data-dir-stop="${escapeAttr(item.group.id)}" data-dir-index="${item.index}"><span class="dir-link" data-original="${escapeAttr(text)}">${escapeAttr(shown)}</span></button></li>`;
  }).join("");
  return `<details class="directions call-log-box" id="routeDirections" open>
    <summary>auto zooming directions</summary>
    <div class="dir-scroll">
      <ol>${items}</ol>
    </div>
  </details>`;
}

function planBox(heading = "Step 6. Read the plan and navigate") {
  const plan = state.plan;
  if (!plan) {
    return `<section class="result step">
      <h2>${heading}</h2>
      <p class="fine">After Calculate, the map, directions, and next stops show here.</p>
    </section>`;
  }
  const directions = directionsBlock();
  return `<section class="result step">
    <h2>${heading}</h2>
    <div class="route-stage" id="routeStage">
      <div id="routeMap" class="route-map">
      <aside class="route-rail route-rail-left">
        <div class="rail-pop" id="railStopsPop">
          <button type="button" id="routeStops" aria-expanded="false" aria-label="Stops"><span>Stop</span></button>
          <div class="rail-col-menu" id="railStopsMenu" hidden></div>
        </div>
        <div class="rail-pop" id="railDetourPop">
          <button type="button" id="routeDetour" aria-expanded="false" aria-label="Detour"><span>Detour</span></button>
          <div class="rail-col-menu" id="railDetourMenu" hidden>
            <button type="button" data-detour="truck">Truck stop</button>
            <button type="button" data-detour="swift">Swift terminals</button>
            <button type="button" data-detour="cat">Cat scale</button>
            <button type="button" data-detour="loves">Love's</button>
            <button type="button" data-detour="walmart">Walmart</button>
          </div>
        </div>
        <button type="button" id="routeBasemap" class="on" aria-pressed="true" aria-label="${basemap === "satellite" ? "Satellite" : "Street map"}">${basemap === "satellite" ? "<span>Satel</span><span>lite</span>" : "<span>Street</span><span>map</span>"}</button>
        <button type="button" id="routeZoomIn" aria-label="Zoom in"><span>Zoom</span><span>in</span></button>
        <button type="button" id="routeZoomOut" aria-label="Zoom out"><span>Zoom</span><span>out</span></button>
      </aside>
      <aside class="route-rail">
        <button type="button" id="routeFull" aria-label="Full screen"><span>Full</span><span>screen</span></button>
        <button type="button" id="routeExit" hidden>Exit</button>
        <button type="button" id="routeCompass" aria-label="Lock map to true north" aria-pressed="false">
          <span class="compass-rose" aria-hidden="true"><span class="compass-n">N</span><span class="compass-e">E</span><span class="compass-s">S</span><span class="compass-w">W</span></span>
          <svg class="compass-needle compass-fill" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2.2 17.8 20.2 12 16.2 6.2 20.2Z"/></svg>
          <svg class="compass-needle compass-line" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" d="M12 3 17.2 19.6 12 16.1 6.8 19.6Z"/></svg>
        </button>
        <button type="button" id="routeWhole" aria-label="Trip zoom"><span>Trip</span><span>zoom</span></button>
        <button type="button" id="routeRecalc" aria-label="Recalculate" ${state.estimating || (!state.unlimited && state.credits === 0) ? "disabled" : ""}><span>Recalc</span><span>ulate</span></button>
        <button type="button" id="routeFollow" hidden aria-label="Follow me"><span>Follow</span><span>me</span></button>
      </aside>
      </div>
      <div class="route-bottom">
      <div class="route-ask" id="routeSwitchRow" hidden>
        <button type="button" class="route-switch" id="routeSwitch"></button>
        <button type="button" class="route-switch route-switch-no" id="routeSwitchNo">No</button>
      </div>
      <p class="route-stop-miles" id="routeStopMiles" hidden></p>
      <div class="route-place-row" id="routePlaceRow">
        <p class="route-drive" id="routeDrive" hidden></p>
        <p class="route-place" id="routePlace" hidden></p>
      </div>
      </div>
      <div class="route-place-tools" id="routePlaceTools">
        <p class="route-place-clear" id="routePlaceStatus" hidden></p>
        <button type="button" id="routePlaceSearch" class="route-place-clear" hidden>Search here</button>
        <button type="button" id="routePlaceClear" class="route-place-clear" hidden>Clear</button>
      </div>
      <div id="routePlaceList" class="route-place-list" hidden></div>
    </div>
    <div id="routeDirectionsHome"></div>
    ${directions}
    ${directions ? `<div class="nav-actions nav-go" id="navGo"><button type="button" class="flag-box" id="startNav" ${navOn ? "disabled" : ""}>${navOn ? "Navigation in progress" : "Start navigation"}</button><button type="button" class="flag-box" id="endNav">End navigation</button>${voiceStepper()}</div><p class="fine">Arrows change the voice. Phone is the voice on this phone and pauses the song. US, Clear, Ann, Cal, Scot, and North talk when you tap them and keep the song playing.</p>` : ""}
    <p class="flag-box" id="routeStopNote" hidden></p>
    ${directions ? `<div class="nav-actions"><button type="button" class="flag-box${state.darkMode ? " on" : ""}" id="darkMode">${themeButtonLabel()}</button></div><p class="flag-box" id="nextTruckNote"${placeListMode || !truckHit ? " hidden" : ""}>${placeListMode || !truckHit ? "" : escapeAttr(truckNoteText(truckHit))}</p><div id="nextPlaceList" class="place-list"${placeListMode && truckHits.length ? "" : " hidden"}></div><button type="button" class="flag-box" id="searchPlaces"${placeSeek && placeMapMoved ? "" : " hidden"}>Search here</button><button type="button" class="flag-box" id="clearPlaces"${truckHits.length ? "" : " hidden"}>Clear</button><button type="button" class="flag-box" id="addTruckStop"${truckHit ? "" : " hidden"}>Add as next stop</button>` : ""}
    ${summaryLivesOnPlan() ? "" : planSummary()}
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
let mapChosenHit = null;
let mapQuery = "";
let mapSearchHits = [];
let mapSearchNote = "";
let mapSearching = false;
let mapPickMap = null;
let mapSearchMarkers = [];

function lookupMapSheet() {
  const stop = state.stops.find((item) => item.id === state.openLookupStopId);
  if (!stop || (!chooseMap && !lookupPins(stop).length)) return "";
  return `<div class="lookup-sheet" role="dialog" aria-modal="true" aria-label="${chooseMap ? "search/choose from map" : "Choose a stop"}">
    <div class="lookup-sheet-bar">
      <strong>${chooseMap ? "search/choose from map" : "Choose a stop"}</strong>
      <button type="button" class="secondary" id="closeLookupMap">Close</button>
    </div>
    ${chooseMap ? `<form class="map-search" id="mapSearch"><label class="sr" for="mapSearchQuery">Search the map</label><input id="mapSearchQuery" type="search" enterkeyhint="search" placeholder="Search for a place" autocomplete="off" value="${escapeAttr(mapQuery)}"><button type="submit" class="flag-box" id="mapSearchGo"${!state.unlimited && state.credits === 0 ? " disabled" : ""}>${mapSearching ? "Searching…" : state.signedIn ? "Search · 1 credit" : "Search"}</button></form><div class="map-place-row"><button type="button" class="flag-box" id="mapLoves">Love's</button><button type="button" class="flag-box" id="mapWalmart">Walmart</button><button type="button" class="flag-box" id="mapCat">Cat scale</button><button type="button" class="flag-box" id="mapSwift">Swift terminals</button><button type="button" class="flag-box" id="mapTruck">Truck stop</button></div><p class="fine map-search-note" id="mapSearchNote">${escapeAttr(mapSearchNote || "Search, then tap a pin or press Use this address. Love's, Walmart, Cat scale, and Swift terminals use the map you are looking at.")}</p><div class="map-pick-steps"><p class="fine">Or long-press the map and then press Use this spot. Signed in, that is 1 credit.</p><button type="button" class="flag-box" id="useMapSpot"${useMapButtonEnabled() ? "" : " disabled"}>${escapeAttr(useMapButtonLabel())}</button></div>` : `<p class="fine">Move around, then tap a pin.</p>`}
    <div class="lookup-map is-live" data-lookup-map="${escapeAttr(stop.id)}" data-live="1"${chooseMap ? ` data-map-pick="1"` : ""}></div>
  </div>`;
}

let lookupMaps = [];

let basemap = "satellite";
try {
  const saved = localStorage.getItem("planigator.basemap");
  if (saved === "vector" || saved === "satellite") basemap = saved;
  else if (localStorage.getItem("planigator.satellite") === "0") basemap = "vector";
} catch {}

const satelliteSource = {
  type: "raster",
  // Without blankTile=false, a missing level comes back as a repeated "not available" stamp.
  tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}?blankTile=false"],
  tileSize: 256,
  maxzoom: 19,
  attribution: "Esri, Maxar, Earthstar Geographics, and the GIS User Community",
};

const placesSource = {
  type: "raster",
  tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}"],
  tileSize: 256,
  maxzoom: 19,
  attribution: "Esri, HERE, Garmin, © OpenStreetMap contributors, and the GIS user community",
};

const vectorStyleUrl = "https://tiles.openfreemap.org/styles/liberty";

function rasterSpec(source) {
  return { ...source, tiles: [...source.tiles] };
}

function satelliteMapStyle() {
  return {
    version: 8,
    sources: {
      satellite: rasterSpec(satelliteSource),
      places: rasterSpec(placesSource),
    },
    layers: [
      { id: "satellite", type: "raster", source: "satellite" },
      { id: "places", type: "raster", source: "places" },
    ],
  };
}

function routeStyle() {
  if (basemap === "vector") return vectorStyleUrl;
  return satelliteMapStyle();
}

function styleIsBasemap(map) {
  try {
    if (!map?.isStyleLoaded?.()) return false;
    if (basemap === "vector") return Boolean(map.getSource("openmaptiles"));
    return Boolean(map.getLayer("satellite"));
  } catch {
    return false;
  }
}

const ROUTE_LINE_COLOR = ["case", ["==", ["get", "current"], 1], "#2f6fed", "#1f8a62"];

function ensureRouteLayers(map) {
  if (!map.getSource("route")) {
    map.addSource("route", {
      type: "geojson",
      data: routeFeatureCollection(),
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
      paint: { "line-color": ROUTE_LINE_COLOR, "line-width": 4 },
    });
  }
  if (!map.getSource("left")) {
    map.addSource("left", {
      type: "geojson",
      data: { type: "Feature", geometry: { type: "LineString", coordinates: [] } },
    });
    map.addLayer({
      id: "left",
      type: "line",
      source: "left",
      paint: { "line-color": "#9ec5ff", "line-width": 6 },
    });
  }
}

function paintRouteLines() {
  const map = routeMap;
  const source = map?.getSource("route");
  if (!source) return;
  source.setData(routeFeatureCollection());
  if (map.getLayer("route")) map.setPaintProperty("route", "line-color", ROUTE_LINE_COLOR);
}

function restoreRouteLine() {
  const map = routeMap;
  if (!map?.getSource("route")) return;
  paintRouteLines();
  if (!(navOn && navFix && navLine.length >= 2)) return;
  const hit = navNearest(navFix[0], navFix[1], navLine);
  const leg = legUnderFix(navFix[0], navFix[1]);
  paintNavLine(hit.along, leg ? leg.end : Infinity);
}

let basemapTimer = 0;

function queueBasemap() {
  if (basemapTimer) return;
  basemapTimer = window.setTimeout(() => {
    basemapTimer = 0;
    applyBasemap();
  }, 2000);
}

function applyBasemap() {
  const map = routeMap;
  if (!map) return;
  if (!map.isStyleLoaded?.()) {
    queueBasemap();
    return;
  }
  if (styleIsBasemap(map)) {
    ensureRouteLayers(map);
    restoreRouteLine();
    return;
  }
  const next = basemap;
  try {
    map.setStyle(next === "vector" ? vectorStyleUrl : satelliteMapStyle(), { diff: false });
  } catch {
    queueBasemap();
    return;
  }
  const giveUp = window.setTimeout(() => {
    if (routeMap === map && basemap === next && !styleIsBasemap(map)) queueBasemap();
  }, 4000);
  map.once("style.load", () => {
    window.clearTimeout(giveUp);
    if (routeMap !== map) return;
    if (basemap !== next || !styleIsBasemap(map)) {
      queueBasemap();
      return;
    }
    ensureRouteLayers(map);
    restoreRouteLine();
    addRoutePins();
    if (navOn && navFix) placeNavDot(navFix[0], navFix[1]);
    if (navOn && turnShownAlong != null) placeTurnPin(turnShownAlong);
    paintBasemapButtons();
  });
}

window.addEventListener("online", () => {
  if (routeMap && !styleIsBasemap(routeMap)) applyBasemap();
});

function paintBasemapButtons() {
  const button = document.getElementById("routeBasemap");
  if (!button) return;
  const satellite = basemap === "satellite";
  button.classList.add("on");
  button.setAttribute("aria-pressed", "true");
  button.setAttribute("aria-label", satellite ? "Satellite" : "Street map");
  button.replaceChildren();
  const top = document.createElement("span");
  const bottom = document.createElement("span");
  top.textContent = satellite ? "Satel" : "Street";
  bottom.textContent = satellite ? "lite" : "map";
  button.append(top, bottom);
}

function selectBasemap(next) {
  if (next !== "satellite" && next !== "vector") return;
  if (next === basemap) return;
  basemap = next;
  try { localStorage.setItem("planigator.basemap", basemap); } catch {}
  applyBasemap();
  paintBasemapButtons();
}

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
      satellite: rasterSpec(satelliteSource),
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

function clearMapSearchMarkers() {
  mapSearchMarkers.forEach((marker) => marker.remove());
  mapSearchMarkers = [];
}

function applePinButton(item) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "apple-pin";
  const name = document.createElement("span");
  name.className = "apple-pin-name";
  const title = document.createElement("span");
  title.textContent = pinLabel(item.title || item.label);
  name.append(title);
  if (item.hereLabel) {
    const dist = document.createElement("span");
    dist.className = "apple-pin-dist";
    dist.textContent = item.hereLabel;
    name.append(dist);
  }
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 32 42");
  svg.setAttribute("width", "28");
  svg.setAttribute("height", "36");
  svg.setAttribute("aria-hidden", "true");
  const shape = document.createElementNS("http://www.w3.org/2000/svg", "path");
  shape.setAttribute("fill", "#ff3b30");
  shape.setAttribute("stroke", "#fff");
  shape.setAttribute("stroke-width", "2");
  shape.setAttribute("d", "M16 2C8.3 2 2 8.4 2 16.3 2 27 16 40 16 40s14-13 14-23.7C30 8.4 23.7 2 16 2z");
  const hole = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  hole.setAttribute("cx", "16");
  hole.setAttribute("cy", "16");
  hole.setAttribute("r", "5.2");
  hole.setAttribute("fill", "#fff");
  svg.append(shape, hole);
  button.append(name, svg);
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    applyMapHit(item);
  });
  return button;
}

function firstMapHit() {
  return mapSearchHits.find((item) => Number.isFinite(Number(item?.lat)) && Number.isFinite(Number(item?.lon))) || null;
}

function useMapButtonEnabled() {
  if (mapChosenHit) return true;
  if (!mapSpot) return false;
  return !state.signedIn || state.unlimited || state.credits > 0;
}

function useMapButtonLabel() {
  if (mapChosenHit) return "Use this address";
  return state.signedIn ? "Use this spot · 1 credit" : "Use this spot";
}

function syncUseMapButton() {
  const button = document.getElementById("useMapSpot");
  if (!button) return;
  button.disabled = !useMapButtonEnabled();
  button.textContent = useMapButtonLabel();
}

function chooseMapHit(item) {
  const lat = Number(item?.lat);
  const lon = Number(item?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
  mapChosenHit = item;
  mapSpot = null;
  if (mapPickMarker) {
    mapPickMarker.remove();
    mapPickMarker = null;
  }
  syncUseMapButton();
}

function paintMapSearchPins() {
  const maplibre = window.maplibregl;
  clearMapSearchMarkers();
  if (!mapPickMap || !maplibre || !mapSearchHits.length) return;
  const bounds = new maplibre.LngLatBounds();
  for (const item of mapSearchHits) {
    const lat = Number(item.lat);
    const lon = Number(item.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const marker = new maplibre.Marker({ element: applePinButton(item), anchor: "bottom" })
      .setLngLat([lon, lat])
      .addTo(mapPickMap);
    mapSearchMarkers.push(marker);
    bounds.extend([lon, lat]);
  }
  if (!mapSearchMarkers.length) return;
  if (!mapChosenHit) chooseMapHit(firstMapHit());
  else syncUseMapButton();
  if (mapSearchMarkers.length === 1) {
    const only = firstMapHit();
    if (only) mapPickMap.flyTo({ center: [Number(only.lon), Number(only.lat)], zoom: 15, duration: 500 });
    return;
  }
  mapPickMap.fitBounds(bounds, { padding: { top: 72, bottom: 48, left: 48, right: 48 }, maxZoom: 15, duration: 500 });
}

function applyMapHit(item) {
  const id = state.openLookupStopId;
  const stop = state.stops.find((entry) => entry.id === id);
  const lat = Number(item?.lat);
  const lon = Number(item?.lon);
  const label = String(item?.label || "").trim();
  if (!stop || !label || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
  const hadLeg = stopHasSavedLeg(stop);
  if (!(stop.name || "").trim()) stop.name = pinLabel(item.title || label);
  stop.address = label;
  stop.verifiedLabel = label;
  stop.lat = lat;
  stop.lon = lon;
  stop.done = false;
  stop.skipRoute = false;
  stop.suggestions = [];
  stop.miles = "";
  stop.hours = "";
  if (hadLeg) {
    state.plan = null;
    clearDriveProgress();
  }
  state.openLookupStopId = "";
  chooseMap = false;
  mapSpot = null;
  mapChosenHit = null;
  mapQuery = "";
  mapSearchHits = [];
  mapSearchNote = "";
  mapSearching = false;
  clearMapSearchMarkers();
  if (mapPickMarker) {
    mapPickMarker.remove();
    mapPickMarker = null;
  }
  clearUsingNote(id);
  setLookupMessage(id, "Using that address.", { ok: true });
  persist();
  render();
}

async function searchMapPlaces(raw) {
  const query = String(raw || "").trim();
  mapQuery = query;
  const note = document.getElementById("mapSearchNote");
  const button = document.getElementById("mapSearchGo");
  if (!state.signedIn) {
    mapSearchNote = "Sign in to search the map.";
    if (note) note.textContent = mapSearchNote;
    return;
  }
  if (query.length < 3) {
    mapSearchNote = "Type at least 3 letters.";
    if (note) note.textContent = mapSearchNote;
    return;
  }
  if (!state.unlimited && state.credits === 0) {
    mapSearchNote = "You need a credit to search.";
    if (note) note.textContent = mapSearchNote;
    return;
  }
  mapSearching = true;
  if (button) {
    button.disabled = true;
    button.textContent = "Searching…";
  }
  mapSearchNote = "Searching…";
  if (note) note.textContent = mapSearchNote;
  const center = mapPickMap?.getCenter();
  const at = center ? { lat: center.lat, lon: center.lng } : chooseHere;
  try {
    const data = await suggestAddresses(query, at);
    if (data.credits != null) state.credits = data.credits;
    const calc = document.getElementById("calculate");
    if (calc) calc.innerHTML = calculateButtonLabel();
    mapSearchHits = Array.isArray(data.items) ? data.items : [];
    mapChosenHit = null;
    paintMapSearchPins();
    mapSearchNote = mapSearchHits.length === 1
      ? "Tap the pin or press Use this address."
      : "Tap a pin or press Use this address for the selected place.";
  } catch (error) {
    if (error.credits != null) state.credits = error.credits;
    const calc = document.getElementById("calculate");
    if (calc) calc.innerHTML = calculateButtonLabel();
    mapSearchHits = [];
    mapChosenHit = null;
    clearMapSearchMarkers();
    syncUseMapButton();
    mapSearchNote = error.message || "Nothing matched that search.";
  }
  mapSearching = false;
  if (note) note.textContent = mapSearchNote;
  if (button) {
    button.disabled = !state.unlimited && state.credits === 0;
    button.textContent = state.signedIn ? "Search · 1 credit" : "Search";
  }
}

function placeAsMapHit(hit) {
  const name = String(hit?.name || "").trim();
  const label = String(hit?.label || name).trim();
  return {
    title: name || label,
    label,
    lat: hit?.lat,
    lon: hit?.lon,
  };
}

function distanceFromHere(lat, lon) {
  if (!chooseHere) return "";
  const meters = metersBetween([chooseHere.lat, chooseHere.lon], [Number(lat), Number(lon)]);
  if (!Number.isFinite(meters)) return "";
  const miles = meters / 1609.344;
  if (state.settings.kilometers) {
    const km = meters / 1000;
    if (km < 0.1) return `${Math.max(1, Math.round(meters))} m`;
    return `${km.toFixed(1)} km`;
  }
  if (miles < 0.1) return `${Math.max(1, Math.round(meters * 3.28084))} ft`;
  return `${miles.toFixed(1)} miles`;
}

function stampHereDistance(item) {
  const hereLabel = distanceFromHere(item?.lat, item?.lon);
  return hereLabel ? { ...item, hereLabel } : item;
}

async function searchPickPlace(place) {
  const note = document.getElementById("mapSearchNote");
  const word = placeWord(place);
  if (!mapPickMap) {
    mapSearchNote = "The map is not ready.";
    if (note) note.textContent = mapSearchNote;
    return;
  }
  mapSearchNote = `Looking for ${word}…`;
  if (note) note.textContent = mapSearchNote;
  if (!chooseHere) {
    const fresh = await currentFix();
    if (fresh) chooseHere = { lat: fresh.lat, lon: fresh.lon };
  }
  try {
    const hits = (await localPlacesInView(place, mapPickMap)).map(placeAsMapHit)
      .filter((item) => Number.isFinite(Number(item.lat)) && Number.isFinite(Number(item.lon)) && item.label);
    mapSearchHits = hits.map(stampHereDistance);
    mapChosenHit = null;
    paintMapSearchPins();
    mapSearchNote = hits.length
      ? (hits.length === 1 ? "Tap the pin or press Use this address." : "Tap a pin or press Use this address for the selected place.")
      : `No ${word} in this part of the map.`;
    if (!hits.length) syncUseMapButton();
  } catch (error) {
    if (error.credits != null) state.credits = error.credits;
    const said = String(error.message || "");
    mapSearchHits = [];
    mapChosenHit = null;
    clearMapSearchMarkers();
    syncUseMapButton();
    mapSearchNote = /route line/i.test(said) ? `No ${word} in this part of the map.` : (said || `No ${word} in this part of the map.`);
  }
  if (note) note.textContent = mapSearchNote;
}

function mountLookupMaps() {
  lookupMaps.forEach((map) => map.remove());
  lookupMaps = [];
  mapPickMap = null;
  clearMapSearchMarkers();
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
      style: pick ? pickMapStyle() : satelliteMapStyle(),
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
      if (pick) {
        mapPickMap = map;
        bindMapPick(map, stop.id);
        if (mapSearchHits.length) paintMapSearchPins();
      }
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
  mapChosenHit = null;
  mapQuery = "";
  mapSearchHits = [];
  mapSearchNote = "";
  mapSearching = false;
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
  mapChosenHit = null;
  const maplibre = window.maplibregl;
  if (!maplibre) return;
  if (mapPickMarker) mapPickMarker.remove();
  const pin = document.createElement("span");
  pin.className = "map-spot";
  mapPickMarker = new maplibre.Marker({ element: pin, anchor: "center" }).setLngLat([lon, lat]).addTo(map);
  syncUseMapButton();
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
    if (event.originalEvent?.target?.closest?.(".apple-pin")) return;
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
  if (mapChosenHit) {
    applyMapHit(mapChosenHit);
    return;
  }
  const id = state.openLookupStopId;
  const spot = mapSpot;
  const stop = state.stops.find((item) => item.id === id);
  if (!stop || !spot) return;
  const hadLeg = stopHasSavedLeg(stop);
  let label = "Chosen on the map";
  let note = "Using that address.";
  if (state.signedIn) {
    if (!state.unlimited && state.credits === 0) return;
    try {
      const data = await spotAddress(spot.lat, spot.lon);
      if (data.credits != null) state.credits = data.credits;
      if (data?.label) label = String(data.label).trim() || label;
    } catch (error) {
      if (error.credits != null) state.credits = error.credits;
      note = error.message || "Using this point. The address did not load.";
    }
  }
  stop.address = label;
  stop.verifiedLabel = label;
  stop.lat = spot.lat;
  stop.lon = spot.lon;
  stop.done = false;
  stop.skipRoute = false;
  stop.suggestions = [];
  stop.miles = "";
  stop.hours = "";
  if (hadLeg) {
    state.plan = null;
    clearDriveProgress();
  }
  state.openLookupStopId = "";
  chooseMap = false;
  mapSpot = null;
  mapChosenHit = null;
  if (mapPickMarker) {
    mapPickMarker.remove();
    mapPickMarker = null;
  }
  clearUsingNote(id);
  setLookupMessage(id, note, { ok: true });
  persist();
  render();
}

function pinLabel(label) {
  const text = String(label || "").split(",")[0].trim();
  return text.length > 28 ? `${text.slice(0, 28)}…` : text;
}

let routeMap = null;
let truckMarker = null;
let truckMarkers = [];
let routeMapReady = false;
let turnMarker = null;
let pendingTurn = null;
let routeFull = false;
let routePageStale = false;
let routeLivePaint = false;
let routePinMarkers = [];
let navOn = false;
let navFollowing = true;
let followPinned = false;
let navMapTouch = false;
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
let northLock = false;
let compassAim = false;
let navReturnTimer = 0;
let navStopCursor = 0;
let navStopPicked = false;
let navGuideFromId = "";
let navStopAnnounce = false;
let navStopAwaitNear = false;
let navStopSpeakKey = "";
let navStopNoteText = "";
let navStopNoteUntil = 0;
let truckHit = null;
let truckHits = [];
let placeListMode = false;
let placeSeek = "";
let placeSeekFull = false;
let placeMapMoved = false;
let placeHereNote = "";
let navLine = [];
let navLegs = [];
let navAlongLock = null;
let navLineKey = "";

function clearRoutePins() {
  for (const marker of routePinMarkers) marker.remove();
  routePinMarkers = [];
}

function addRoutePins(bounds) {
  const maplibre = window.maplibregl;
  clearRoutePins();
  if (!routeMap || !maplibre) return;
  routePins().forEach((pin) => {
    const ink = stopInk(pin.rgb);
    const button = document.createElement("span");
    button.className = "route-pin";
    button.textContent = pin.label;
    button.style.background = cssRGB(pin.rgb);
    button.style.color = ink.color;
    routePinMarkers.push(new maplibre.Marker({ element: button, anchor: "bottom" }).setLngLat([pin.lon, pin.lat]).addTo(routeMap));
    bounds?.extend([pin.lon, pin.lat]);
  });
}

function clearRouteMap() {
  pendingTurn = null;
  routeMapReady = false;
  if (navYou) {
    try { navYou.remove(); } catch {}
  }
  navYou = null;
  navShown = null;
  clearRoutePins();
  if (turnMarker) {
    turnMarker.remove();
    turnMarker = null;
  }
  clearTruckPins();
  if (routeMap) {
    routeMap.remove();
    routeMap = null;
  }
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

function paintStopNote() {
  const note = document.getElementById("routeStopNote");
  if (!note) return;
  note.hidden = !navStopNoteText;
  note.textContent = navStopNoteText;
}

function showStopNote(text, holdMs = 0) {
  navStopNoteText = String(text || "");
  navStopNoteUntil = holdMs > 0 ? Date.now() + holdMs : 0;
  paintStopNote();
  paintStopChip();
}

function clearStopNote(force) {
  if (!force && navStopNoteUntil > Date.now()) return;
  if (!force && navStopNoteText && navStopNoteUntil === 0) return;
  navStopNoteText = "";
  navStopNoteUntil = 0;
  paintStopNote();
  paintStopChip();
}

function paintStopChip() {
  const chip = document.getElementById("routeStopMiles");
  if (!chip) return;
  if (navOn && navStopNoteText) {
    chip.hidden = false;
    chip.textContent = navStopNoteText;
    return;
  }
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
  if (meters < 1) {
    stopChipLines = [`At ${name}`];
    stopChipIndex = 0;
    paintStopChip();
    if (stopChipTimer) window.clearInterval(stopChipTimer);
    stopChipTimer = 0;
    return;
  }
  const hours = hoursForMeters(meters);
  const eta = etaLabel(Date.now() + hours * 3600 * 1000);
  stopChipLines = [`${eta} · ${navMiles(meters)} · ${hoursLabel(hours)}`];
  stopChipIndex = 0;
  paintStopChip();
  if (stopChipTimer) window.clearInterval(stopChipTimer);
  stopChipTimer = 0;
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

function navNearest(lat, lon, path) {
  if (!path || path.length < 2) return { dist: Infinity, along: 0 };
  if (navOn && path === navLine) {
    const hit = matchAlong(lat, lon, path, { along: navAlongLock, bearing: navTravel });
    if (hit.dist <= ON_ROAD_M) navAlongLock = hit.along;
    return hit;
  }
  return nearestOnPath(lat, lon, path);
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

function scaledStepLengths(steps, path) {
  const lengths = (steps || []).map(stepLengthMeters);
  const sum = lengths.reduce((total, length) => total + length, 0);
  const total = polylineMeters(path || []);
  const scale = sum > 1 ? Math.max(1, total / sum) : 1;
  return lengths.map((length) => (length || 0) * scale);
}

function navStep(leg, alongInLeg) {
  const steps = Array.isArray(leg.stop.directions) ? leg.stop.directions : [];
  if (!steps.length) return null;
  const lengths = scaledStepLengths(steps, leg.path);
  let cursor = 0;
  for (let i = 0; i < steps.length; i += 1) {
    const len = Math.max(lengths[i] || 0, 1);
    // The row names the maneuver at the end of this span. Leave it when
    // that maneuver is reached, so the next turn is the one counting down.
    if (alongInLeg < cursor + len || i === steps.length - 1) return { step: steps[i], index: i };
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

let mixCtx = null;
let navVoiceNode = null;
const PAGE_VOICE = {
  us: { voice: "en/en-us", speed: 150, pitch: 50 },
  clear: { voice: "en/en-rp", speed: 138, pitch: 46 },
  ann: { voice: "en/en-us", variant: "f2", speed: 156, pitch: 64 },
  cal: { voice: "en/en-us", variant: "m3", speed: 146, pitch: 38 },
  scot: { voice: "en/en-sc", speed: 150, pitch: 48 },
  north: { voice: "en/en-n", speed: 148, pitch: 44 },
};

function preferMix() {
  try {
    if (navigator.audioSession && navigator.audioSession.type !== "ambient") {
      navigator.audioSession.type = "ambient";
    }
  } catch {
    // This phone does not let a page mix with other audio.
  }
}

function unlockMix() {
  preferMix();
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return;
  if (!mixCtx) mixCtx = new AudioCtx();
  if (mixCtx.state === "suspended") mixCtx.resume();
  try {
    const buf = mixCtx.createBuffer(1, 1, 22050);
    const src = mixCtx.createBufferSource();
    src.buffer = buf;
    src.connect(mixCtx.destination);
    src.start();
  } catch {
    // The next spoken line still uses this same mixer.
  }
}

function stopNavUtterance() {
  if (navVoiceNode) {
    try { navVoiceNode.stop(); } catch { /* already stopped */ }
    navVoiceNode = null;
  }
  phoneUtter = null;
  window.speechSynthesis?.cancel();
}

function playSamples(samples, rate) {
  return new Promise((resolve) => {
    preferMix();
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx || !samples?.length) {
      resolve();
      return;
    }
    if (!mixCtx) mixCtx = new AudioCtx();
    if (mixCtx.state === "suspended") mixCtx.resume();
    const buffer = mixCtx.createBuffer(1, samples.length, rate);
    buffer.getChannelData(0).set(samples);
    const source = mixCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(mixCtx.destination);
    navVoiceNode = source;
    const done = () => {
      if (navVoiceNode === source) navVoiceNode = null;
      resolve();
    };
    source.onended = done;
    try {
      source.start();
    } catch {
      done();
    }
  });
}

function playNavSpeech(text) {
  playChosenVoice(text);
}

let voiceBusy = false;
let voicePct = -1;

function voiceLoadText() {
  if (!voiceBusy) return "";
  if (voicePct < 0) return "Starting";
  return `${voicePct}%`;
}

function voiceStepper() {
  return `<span class="voice-step"><button type="button" class="flag-box" id="voicePrev" aria-label="Previous voice">‹</button><span class="voice-now flag-box" id="voiceNow"><span id="voiceName">${escapeAttr(navVoiceLabel())}</span></span><button type="button" class="flag-box" id="voiceNext" aria-label="Next voice">›</button></span>`;
}

function paintVoiceLoad() {
  const spin = document.getElementById("voiceSpin");
  const pct = document.getElementById("voicePct");
  const now = document.getElementById("voiceNow");
  if (spin) spin.classList.toggle("on", voiceBusy);
  if (pct) pct.textContent = voiceLoadText();
  if (now) now.setAttribute("aria-busy", voiceBusy ? "true" : "false");
}

function showVoiceLoad(ratio) {
  voiceBusy = true;
  voicePct = ratio == null || ratio >= 1 ? -1 : Math.min(99, Math.round(Math.max(0, ratio) * 100));
  paintVoiceLoad();
}

function clearVoiceLoad() {
  voiceBusy = false;
  voicePct = -1;
  paintVoiceLoad();
}

function previewChosenVoice() {
  preferMix();
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (AudioCtx && !mixCtx) {
    mixCtx = new AudioCtx();
    mixCtx.resume();
  }
  const label = navVoiceLabel();
  playChosenVoice(`This is ${label}.`);
}

let phoneUtter = null;
let speakChain = Promise.resolve();
let speakGen = 0;

function speakPhone(text, gen) {
  const synth = window.speechSynthesis;
  if (!synth || typeof SpeechSynthesisUtterance !== "function") {
    showStopNote("This phone has no voice for that.", 4000);
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    if (gen != null && gen !== speakGen) {
      resolve();
      return;
    }
    const utter = new SpeechSynthesisUtterance(text);
    phoneUtter = utter;
    // Do not set utter.voice. Leaving it alone uses the voice from iPhone
    // Settings, including a premium voice. Picking a localService voice
    // overrides that and sounds like a different person.
    const done = () => {
      if (phoneUtter === utter) phoneUtter = null;
      resolve();
    };
    utter.onend = done;
    utter.onerror = done;
    try {
      synth.speak(utter);
      synth.resume();
    } catch {
      done();
    }
  });
}

function playChosenVoice(text, { barge = true } = {}) {
  const said = spokenAloud(text);
  if (!said) return Promise.resolve();
  if (barge) {
    speakGen += 1;
    stopNavUtterance();
    speakChain = Promise.resolve();
  }
  const gen = speakGen;
  const job = speakChain.then(async () => {
    if (gen !== speakGen) return;
    if (navVoiceId() === "phone") {
      await speakPhone(said, gen);
      return;
    }
    unlockMix();
    try {
      await warmPageVoices();
      if (gen !== speakGen) return;
      const spec = PAGE_VOICE[navVoiceId()] || PAGE_VOICE.us;
      const clip = await pageSpeech(said, spec);
      if (gen !== speakGen) return;
      await playSamples(clip.samples, clip.rate);
    } catch {
      if (gen !== speakGen) return;
      showStopNote("That voice did not talk. Try the next one.", 4000);
    }
  });
  speakChain = job.catch(() => {});
  return job;
}

function stepNavVoice(dir) {
  const list = NAV_VOICES;
  let index = list.findIndex(([id]) => id === navVoiceId());
  if (index < 0) index = 0;
  index = (index + dir + list.length) % list.length;
  state.settings.navVoice = list[index][0];
  persist();
  saveActiveTripSettings();
  const name = document.getElementById("voiceName");
  if (name) name.textContent = list[index][1];
  previewChosenVoice();
}

function stopMixNavVoice() {
  stopNavUtterance();
  const ctx = mixCtx;
  mixCtx = null;
  if (!ctx) return;
  try { ctx.close(); } catch { /* already closed */ }
}

const NAV_VOICES = [
  ["phone", "Phone"],
  ["us", "US"],
  ["clear", "Clear"],
  ["ann", "Ann"],
  ["cal", "Cal"],
  ["scot", "Scot"],
  ["north", "North"],
];

function navVoiceId() {
  const id = state.settings.navVoice;
  if (NAV_VOICES.some(([value]) => value === id)) return id;
  return "us";
}

function navVoiceLabel() {
  const id = navVoiceId();
  return NAV_VOICES.find(([value]) => value === id)?.[1] || "US";
}

let navVoiceIntroPending = false;

function unlockNavVoice() {
  // Unlock audio on this tap, then say the line in the chosen voice. The first
  // direction queues after this so it does not cut in with a different voice.
  unlockMix();
  navVoiceIntroPending = true;
  playChosenVoice("Navigation on.", { barge: true }).finally(() => {
    navVoiceIntroPending = false;
  });
}

const STATE_NAMES = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia",
  HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri",
  MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
  NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio",
  OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina",
  SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont",
  VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
  DC: "District of Columbia",
};

function spokenAloud(text) {
  let said = String(text || "");
  said = said.replace(/[()]/g, " ");
  // "E/US-35" and "N/Fort" were glued to the slash, so the next word was spelled letter by letter.
  said = said.replace(/([A-Za-z0-9])\/+(?=[A-Za-z])/g, "$1 and ");
  said = said.replace(/\bI-(\d+)([A-Z])?\b/g, (_, num, letter) => (
    `Interstate ${num}${letter || ""}`
  ));
  // Uppercase only, so "in 0.4 miles" stays. Route shields (IN-25) and ", IN" are states.
  said = said.replace(/\b([A-Z]{2})-(\d+)([A-Z])?\b/g, (match, code, num, letter) => (
    STATE_NAMES[code] ? `${STATE_NAMES[code]} ${num}${letter || ""}` : match
  ));
  said = said.replace(/,\s*([A-Z]{2})\b/g, (match, code) => (
    STATE_NAMES[code] ? `, ${STATE_NAMES[code]}` : match
  ));
  const swaps = [
    ["NE", "Northeast"],
    ["NW", "Northwest"],
    ["SE", "Southeast"],
    ["SW", "Southwest"],
    ["N", "North"],
    ["S", "South"],
    ["E", "East"],
    ["W", "West"],
    ["Ft", "Fort"],
    ["Aly", "Alley"],
    ["Ave", "Avenue"],
    ["Blvd", "Boulevard"],
    ["Boul", "Boulevard"],
    ["Cir", "Circle"],
    ["Ct", "Court"],
    ["Cres", "Crescent"],
    ["Dr", "Drive"],
    ["Expy", "Expressway"],
    ["Expwy", "Expressway"],
    ["Fwy", "Freeway"],
    ["Hwy", "Highway"],
    ["Ln", "Lane"],
    ["Pkwy", "Parkway"],
    ["Pky", "Parkway"],
    ["Tpke", "Turnpike"],
    ["Tnpk", "Turnpike"],
    ["Tpk", "Turnpike"],
    ["Plz", "Plaza"],
    ["Pl", "Place"],
    ["Rd", "Road"],
    ["Rte", "Route"],
    ["Sq", "Square"],
    ["St", "Street"],
    ["Ter", "Terrace"],
    ["Terr", "Terrace"],
    ["Trl", "Trail"],
    ["Xing", "Crossing"],
  ];
  for (const [abbr, word] of swaps) {
    said = said.replace(new RegExp(`\\b${abbr}\\.?(?!\\w)`, "gi"), word);
  }
  // After the compass words, so the S in U.S. is not said as South.
  // The letter on US-220A has to stay in the match, or the hyphen is left
  // and the phone says "negative".
  said = said.replace(/\bUS-(\d+)([A-Z])?\b/g, (_, num, letter) => (
    `U.S. ${num}${letter || ""}`
  ));
  said = said.replace(/\bUS\b/g, "U.S.");
  said = said.replace(/\s*[-–—−]\s*/g, " ");
  return said.replace(/\s+/g, " ").trim();
}

function speakNav(text) {
  if (!navOn || !text) return;
  // Queue behind "Navigation on." so Start does not sound like two people.
  // Later turn updates still barge in and replace the line.
  playChosenVoice(text, { barge: !navVoiceIntroPending });
}

function resetNavVoice() {
  spokenStepKey = "";
  spokenTurnKey = "";
  spokenMiles.clear();
  stopNavUtterance();
}

function withoutGo(text) {
  return String(text || "").trim()
    .replace(/\.\s*Go for\b/gi, " for")
    .replace(/\bGo for\b/gi, "for")
    .replace(/\s+/g, " ")
    .trim();
}

function directionWithMilesLeft(text, metersLeft) {
  const lead = inDistance(metersLeft);
  const maneuver = maneuverText(text);
  if (maneuver) return `${lead.charAt(0).toUpperCase()}${lead.slice(1)}, ${maneuver}`;
  const body = withoutGo(text).replace(/\.\s*$/, "");
  return body ? `${lead.charAt(0).toUpperCase()}${lead.slice(1)}, ${body}` : lead;
}

function maneuverText(text) {
  return withoutGo(text)
    .replace(/\s+for\s+[0-9][0-9,]*(?:\.[0-9]+)?\s*(?:mi|ft|feet|foot|mile|miles)\b\.?/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function inDistance(meters) {
  const miles = meters / 1609.344;
  if (miles < 0.1) {
    const feet = Math.max(1, Math.round(meters * 3.28084));
    return `in ${feet} ${feet === 1 ? "foot" : "feet"}`;
  }
  const tenth = Math.round(miles * 10) / 10;
  if (Math.abs(tenth - Math.round(tenth)) < 0.05) {
    const whole = Math.round(tenth);
    return `in ${whole} ${whole === 1 ? "mile" : "miles"}`;
  }
  return `in ${tenth.toFixed(1)} miles`;
}

function approachPhrase(nextText, metersLeft) {
  const maneuver = maneuverText(nextText);
  if (!maneuver || !(metersLeft > 0)) return "";
  const distance = inDistance(metersLeft);
  return `${distance.charAt(0).toUpperCase()}${distance.slice(1)}, ${maneuver}`;
}

function shownDirection(step, nextStep, meters) {
  const distance = Number.isFinite(meters) ? meters : stepLengthMeters(step);
  const approach = approachPhrase(String(nextStep?.text || ""), distance);
  if (approach) return approach;
  return withoutGo(String(step?.text || ""));
}

function upcomingDirection(leg, index) {
  const steps = Array.isArray(leg?.stop?.directions) ? leg.stop.directions : [];
  const next = steps[index + 1];
  if (next?.text) return withoutGo(String(next.text).trim());
  const at = navLegs.indexOf(leg);
  const follow = at >= 0 ? navLegs[at + 1] : null;
  const first = follow?.stop?.directions?.[0];
  if (first?.text) return withoutGo(String(first.text).trim());
  return "";
}

function speakNavProgress(leg, found, hereAlong) {
  if (!found || !leg?.stop?.id) return;
  const stepKey = `${leg.stop.id}:${found.index}`;
  const leftMeters = metersLeftInStep(leg, hereAlong - leg.start, found.index);
  const miles = leftMeters / 1609.344;
  const text = String(found.step?.text || "").trim();
  const phrase = () => directionWithMilesLeft(text, leftMeters);
  const bands = [5, 4, 3, 2, 1, 0.5];
  if (stepKey !== spokenStepKey) {
    spokenStepKey = stepKey;
    spokenMiles.clear();
    for (const band of bands) {
      if (miles <= band) spokenMiles.add(band);
    }
    const next = upcomingDirection(leg, found.index);
    const said = (next && approachPhrase(next, leftMeters)) || (text ? phrase() : "");
    if (said) speakNav(said);
  }
  for (const band of bands) {
    if (spokenMiles.has(band) || miles > band) continue;
    if (miles <= band - 0.4) {
      spokenMiles.add(band);
      continue;
    }
    spokenMiles.add(band);
    const next = upcomingDirection(leg, found.index);
    if (!next) break;
    const said = approachPhrase(next, band * 1609.344);
    if (!said) break;
    speakNav(said);
    break;
  }
}

let placeAt = null;
let placeText = "";

function paintPlace(text) {
  const chip = document.getElementById("routePlace");
  if (!chip) return;
  chip.hidden = !text;
  chip.textContent = text || "";
}

function driveLeftText(alongMeters) {
  const totalMiles = Number(state.plan?.miles);
  const totalHours = Number(state.plan?.driveHours);
  const pace = totalMiles > 0 && totalHours > 0 ? totalMiles / totalHours : mph();
  let leftMiles = null;
  if (navOn && navLine.length >= 2 && Number.isFinite(alongMeters)) {
    leftMiles = Math.max(0, (polylineMeters(navLine) - alongMeters) / 1609.344);
  } else if (totalMiles > 0) leftMiles = totalMiles;
  if (leftMiles == null || !(pace > 0)) return "";
  if (leftMiles < 0.05) return "0 min left";
  const minutes = Math.max(1, Math.round((leftMiles / pace) * 60));
  return `${hoursLabel(minutes / 60)} left`;
}

function paintDrive(alongMeters) {
  const chip = document.getElementById("routeDrive");
  if (!chip) return;
  const text = driveLeftText(alongMeters);
  chip.hidden = !text;
  chip.textContent = text;
}

function refreshPlace(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
  if (placeAt && placeText && metersBetween(placeAt, [lat, lon]) < 300) {
    paintPlace(placeText);
    return;
  }
  loadTowns().then(() => {
    const hit = townAt(lat, lon);
    if (!hit) return;
    const text = `${hit.name}, ${hit.state}`;
    placeAt = [lat, lon];
    if (text === placeText) return;
    placeText = text;
    paintPlace(text);
  }).catch(() => {});
}

function armPlaceClock() {
  window.setInterval(() => {
    if (!navOn || !navFix) return;
    refreshPlace(navFix[0], navFix[1]);
  }, 60000);
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
  const go = document.getElementById("navGo");
  if (!list || !home || !miles) return;
  if (full) miles.after(list);
  else {
    home.after(list);
    if (go) list.after(go);
  }
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
  const navBlocked = !navOn || state.estimating;
  const creditBlocked = navBlocked || (!state.unlimited && state.credits === 0);
  for (const id of ["nextCat", "nextLoves", "nextWalmart"]) {
    const button = document.getElementById(id);
    if (button) button.disabled = navBlocked;
  }
  const nextTruck = document.getElementById("nextTruck");
  if (nextTruck) nextTruck.disabled = creditBlocked;
  for (const id of ["routeLoves", "routeWalmart", "routeCat"]) {
    const button = document.getElementById(id);
    if (!button) continue;
    button.hidden = !(routeFull && navOn);
    button.disabled = navBlocked;
  }
  const routeTruck = document.getElementById("routeTruck");
  if (routeTruck) {
    routeTruck.hidden = !(routeFull && navOn);
    routeTruck.disabled = creditBlocked;
  }
  const follow = document.getElementById("routeFollow");
  if (follow) {
    follow.hidden = !navOn;
    follow.classList.toggle("on", navOn && navFollowing);
  }
  paintStopButton();
  paintRailMenus();
  placeDirections(routeFull);
  syncTruckAdd();
  const start = document.getElementById("startNav");
  if (start) {
    start.disabled = navOn;
    start.textContent = navOn ? "Navigation in progress" : "Start navigation";
  }
  syncTripFitButton();
  paintStopNote();
  paintCompassRose();
  if (state.plan) warmPageVoices();
  if (navOn) freezeTyping(true);
  requestAnimationFrame(seatRails);
}

let railSeatObserver = null;
let railSeatBox = null;

function railButtonShown(el) {
  if (!el || el.hidden) return false;
  if (el.classList.contains("truck-slot")) {
    const main = [...el.querySelectorAll("button")].find((button) => !button.classList.contains("route-add"));
    return Boolean(main && !main.hidden);
  }
  return true;
}

function railSignature(rail, wide) {
  const names = railItemsInOrder(rail).map((el) => `${el.id || el.className}:${railButtonShown(el) ? 1 : 0}`);
  return `${wide ? "wide" : "tall"}|${names.join(",")}`;
}

function unwrapRail(rail) {
  rail.querySelectorAll(":scope > .rail-col").forEach((col) => {
    while (col.firstChild) rail.insertBefore(col.firstChild, col);
    col.remove();
  });
}

function railItemsInOrder(rail) {
  const items = [];
  const walk = (node) => {
    [...node.children].forEach((el) => {
      if (el.classList.contains("rail-col")) walk(el);
      else items.push(el);
    });
  };
  walk(rail);
  items.forEach((el, index) => {
    if (!el.dataset.railOrder) el.dataset.railOrder = String(index);
  });
  return items.sort((a, b) => Number(a.dataset.railOrder) - Number(b.dataset.railOrder));
}

function layoutWideRails() {
  const stage = document.getElementById("routeStage");
  const wide = Boolean(routeFull && window.matchMedia("(orientation: landscape)").matches);
  stage?.classList.toggle("is-wide", wide);
  document.querySelectorAll(".route-stage .route-rail").forEach((rail) => {
    const signature = railSignature(rail, wide);
    if (rail.dataset.railSig === signature) return;
    rail.dataset.railSig = signature;
    const ordered = railItemsInOrder(rail);
    unwrapRail(rail);
    ordered.forEach((el) => rail.appendChild(el));
    if (!wide) return;
    const visible = ordered.filter((el) => railButtonShown(el) && el.id !== "routeExit");
    const hidden = ordered.filter((el) => !visible.includes(el));
    const cols = [];
    const queue = visible.slice();
    while (queue.length) cols.unshift(queue.splice(-3));
    while (cols.length > 2) {
      const extra = cols.shift();
      cols[0].unshift(...extra);
    }
    hidden.forEach((el) => rail.appendChild(el));
    cols.forEach((group) => {
      const col = document.createElement("div");
      col.className = "rail-col";
      group.forEach((el) => col.appendChild(el));
      rail.appendChild(col);
    });
  });
}

function seatRails() {
  layoutWideRails();
  const stage = document.getElementById("routeStage");
  const rails = document.querySelectorAll(".route-stage .route-rail");
  const wide = Boolean(stage?.classList.contains("is-wide"));
  if (!routeFull) {
    rails.forEach((rail) => {
      rail.style.bottom = "";
      rail.style.top = "";
    });
    stage?.style.removeProperty("--rail-left");
    stage?.style.removeProperty("--rail-right");
    railSeatObserver?.disconnect();
    railSeatObserver = null;
    railSeatBox = null;
    requestAnimationFrame(placeOpenRailMenus);
    return;
  }
  const map = document.getElementById("routeMap");
  // Lift above the whole bottom stack (ETA chip + directions + place), not
  // only the directions list. The ETA sits above the list in fullscreen.
  const stack = document.querySelector("#routeStage .route-bottom");
  const box = stack || document.getElementById("routeDirections");
  if (!map || !box) {
    requestAnimationFrame(placeOpenRailMenus);
    return;
  }
  const mapBox = map.getBoundingClientRect();
  if (wide) {
    let left = 8;
    let right = 8;
    rails.forEach((rail) => {
      rail.style.top = "auto";
      rail.style.bottom = "";
      const railBox = rail.getBoundingClientRect();
      if (railBox.width < 2) return;
      if (railBox.left + railBox.width / 2 < mapBox.left + mapBox.width / 2) {
        left = Math.max(left, Math.round(railBox.right - mapBox.left + 8));
      } else {
        right = Math.max(right, Math.round(mapBox.right - railBox.left + 8));
      }
    });
    stage.style.setProperty("--rail-left", `${left}px`);
    stage.style.setProperty("--rail-right", `${right}px`);
  } else {
    stage?.style.removeProperty("--rail-left");
    stage?.style.removeProperty("--rail-right");
    const lift = mapBox.bottom - box.getBoundingClientRect().top + 8;
    const tallest = Math.max(0, ...[...rails].map((rail) => rail.getBoundingClientRect().height));
    const maxLift = Math.max(8, mapBox.height - tallest - 8);
    const bottom = `${Math.max(8, Math.min(Math.round(lift), Math.round(maxLift)))}px`;
    rails.forEach((rail) => {
      rail.style.top = "auto";
      rail.style.bottom = bottom;
    });
  }
  requestAnimationFrame(placeOpenRailMenus);
  if (typeof ResizeObserver === "undefined" || railSeatBox === box) return;
  railSeatObserver?.disconnect();
  railSeatBox = box;
  railSeatObserver = new ResizeObserver(() => seatRails());
  railSeatObserver.observe(box);
}

function safeTopPad() {
  let probe = document.getElementById("safeTopProbe");
  if (!probe) {
    probe = document.createElement("div");
    probe.id = "safeTopProbe";
    probe.style.cssText = "position:fixed;left:0;top:0;visibility:hidden;pointer-events:none;padding-top:constant(safe-area-inset-top);padding-top:env(safe-area-inset-top);";
    document.documentElement.appendChild(probe);
  }
  return parseFloat(getComputedStyle(probe).paddingTop) || 0;
}

function viewportBox() {
  const view = window.visualViewport;
  let probe = document.getElementById("dvhProbe");
  if (!probe) {
    probe = document.createElement("div");
    probe.id = "dvhProbe";
    probe.style.cssText = "position:fixed;left:0;top:0;width:100vw;height:100dvh;visibility:hidden;pointer-events:none;";
    document.documentElement.appendChild(probe);
  }
  const box = probe.getBoundingClientRect();
  return {
    width: Math.round(Math.max(window.innerWidth, document.documentElement.clientWidth || 0, view?.width || 0, box.width || 0)),
    height: Math.round(Math.max(window.innerHeight, document.documentElement.clientHeight || 0, (view?.height || 0) + (view?.offsetTop || 0), box.height || 0)),
  };
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
  const safeTop = safeTopPad();
  const full = viewportBox();
  stage.style.position = "fixed";
  stage.style.margin = "0";
  stage.style.right = "0";
  stage.style.bottom = "auto";
  stage.style.zIndex = "80";
  stage.style.left = "0px";
  stage.style.width = `${full.width}px`;
  stage.style.top = `${Math.round(-safeTop)}px`;
  stage.style.height = `${Math.round(full.height + safeTop)}px`;
  const box = stage.getBoundingClientRect();
  const topGap = Math.max(0, box.top);
  const leftGap = Math.max(0, box.left);
  const bottomLimit = Math.max(window.innerHeight, (view?.height || 0) + (view?.offsetTop || 0), full.height);
  const rightLimit = Math.max(window.innerWidth, (view?.width || 0) + (view?.offsetLeft || 0), full.width);
  const bottomGap = Math.max(0, bottomLimit - box.bottom);
  const rightGap = Math.max(0, rightLimit - box.right);
  if (topGap > 1 || leftGap > 1 || bottomGap > 1 || rightGap > 1) {
    stage.style.top = `${Math.round(-safeTop - topGap)}px`;
    stage.style.left = `${Math.round(-leftGap)}px`;
    stage.style.width = `${Math.round(full.width + leftGap + rightGap)}px`;
    stage.style.height = `${Math.round(full.height + safeTop + topGap + bottomGap)}px`;
  }
  seatRails();
  const cover = `${stage.style.width}x${stage.style.height}x${stage.style.top}`;
  if (cover !== routeCoverSize) {
    routeCoverSize = cover;
    routeMap?.resize();
  }
}

function watchRouteCover(on) {
  const view = window.visualViewport;
  view?.removeEventListener("resize", fitRouteCover);
  view?.removeEventListener("scroll", fitRouteCover);
  window.removeEventListener("resize", fitRouteCover);
  window.removeEventListener("orientationchange", fitRouteCover);
  if (!on) return;
  view?.addEventListener("resize", fitRouteCover);
  view?.addEventListener("scroll", fitRouteCover);
  window.addEventListener("resize", fitRouteCover);
  window.addEventListener("orientationchange", fitRouteCover);
}

function placeRouteStage() {
  const stage = document.getElementById("routeStage");
  const dialog = document.getElementById("routeDialog");
  if (dialog?.open) dialog.close();
  if (!stage || !routeFull) {
    watchRouteCover(false);
    if (stage && (stage.parentElement === document.body || stage.parentElement === dialog)) {
      const home = document.querySelector(".result");
      const heading = home?.querySelector(":scope > h2");
      if (home && heading) heading.after(stage);
      else if (home) home.insertBefore(stage, home.firstChild);
    }
    pinRouteFull();
    document.getElementById("routeHold")?.remove();
    document.getElementById("dvhProbe")?.remove();
    document.getElementById("safeTopProbe")?.remove();
    return;
  }
  holdRouteSpace();
  if (stage.parentElement !== document.body) document.body.appendChild(stage);
  fitRouteCover();
  watchRouteCover(true);
}

let navAlt = null;
let navAltFeet = null;
let navAltTrend = "";
let windMph = null;
let windAt = 0;
let windFix = null;
let windToken = 0;

function noteAltitude(alt) {
  if (!Number.isFinite(alt)) return;
  navAlt = alt;
  const feet = Math.round(alt * 3.28084);
  if (navAltFeet == null) {
    navAltFeet = feet;
    paintElevWind();
    return;
  }
  if (feet < navAltFeet) navAltTrend = "Down";
  else if (feet > navAltFeet) navAltTrend = "Up";
  navAltFeet = feet;
  paintElevWind();
}

function paintElevWind() {
  const elev = document.getElementById("routeElev");
  const wind = document.getElementById("routeWind");
  if (elev) {
    elev.hidden = !routeFull;
    if (!routeFull || navAlt == null) {
      elev.innerHTML = "<span>Elev</span><span>—</span>";
      elev.setAttribute("aria-label", "Elevation");
    } else {
      const feet = Math.round(navAlt * 3.28084);
      const trend = navAltTrend || "—";
      elev.innerHTML = `<span>${feet}</span><span>${trend}</span>`;
      elev.setAttribute("aria-label", navAltTrend ? `${feet} feet, ${navAltTrend}` : `${feet} feet`);
    }
  }
  if (wind) {
    wind.hidden = !routeFull;
    if (!routeFull || windMph == null) {
      wind.innerHTML = "<span>Wind</span><span>—</span>";
      wind.setAttribute("aria-label", "Wind speed");
    } else {
      wind.innerHTML = `<span>${windMph}</span><span>mph</span>`;
      wind.setAttribute("aria-label", `Wind ${windMph} miles per hour`);
    }
  }
}

async function refreshWind(lat, lon, force) {
  if (!routeFull || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
  if (!force && windFix && Date.now() - windAt < 600000 && metersBetween(windFix, [lat, lon]) < 8047) return;
  const token = windToken + 1;
  windToken = token;
  windAt = Date.now();
  windFix = [lat, lon];
  try {
    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.searchParams.set("latitude", String(Math.round(lat * 100) / 100));
    url.searchParams.set("longitude", String(Math.round(lon * 100) / 100));
    url.searchParams.set("current", "wind_speed_10m");
    url.searchParams.set("wind_speed_unit", "mph");
    const response = await fetch(url);
    if (!response.ok) throw new Error("wind");
    const data = await response.json();
    if (token !== windToken) return;
    const speed = Number(data.current?.wind_speed_10m);
    if (!Number.isFinite(speed)) throw new Error("wind");
    windMph = Math.round(speed);
  } catch {
    if (token !== windToken) return;
    windAt = Date.now() - 540000;
  }
  paintElevWind();
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
  if (routeFull) scheduleTypingUndoClear();
  placeRouteStage();
  syncRouteChrome();
  paintPlaceList();
  requestAnimationFrame(() => {
    if (routeFull) fitRouteCover();
    routeMap?.resize();
    // Page and fullscreen use different slot heights. Reframe after resize
    // or Turn zoom keeps the old wide camera on the tall screen.
    if (navOn && navFix && routeMap) {
      if (tripFit === "nextTurn") {
        clearTurnFrame();
        frameNextTurn();
      } else if (navFollowing && tripFit === "off") {
        const camera = { center: [navFix[1], navFix[0]], zoom: navZoom };
        const bearing = followBearing();
        if (bearing != null) camera.bearing = bearing;
        routeMap.jumpTo(camera);
      }
      placeNavDot(navFix[0], navFix[1]);
    }
  });
  if (!routeFull && routePageStale) {
    routePageStale = false;
    window.setTimeout(() => {
      if (!routeFull) render();
    }, 0);
  }
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

const STOP_NEAR_M = 1609;
const STOP_LINE_M = 402;
const STOP_PAST_M = 80;
const STOP_ARRIVE_M = 161;

function legForStopId(stopId) {
  return navLegs.find((item) => item.stop.id === stopId) || null;
}

function legLeavingStop(chosen) {
  if (!chosen?.stop?.id) return null;
  const dests = navDestList();
  const pos = dests.findIndex((item) => item.stop.id === chosen.stop.id);
  if (pos < 0) return null;
  for (let i = pos + 1; i < dests.length; i += 1) {
    const leg = legForStopId(dests[i].stop.id);
    if (leg) return leg;
  }
  return null;
}

function stopRouteAlong(chosen) {
  const arrive = legForStopId(chosen?.stop?.id);
  if (arrive) return arrive.end;
  const leaving = legLeavingStop(chosen);
  if (leaving) return leaving.start;
  return null;
}

function nearChosenStop(chosen, lat, lon, hit) {
  if (!chosen || !Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  const pinLat = Number(chosen.stop.lat);
  const pinLon = Number(chosen.stop.lon);
  const pinNear = Number.isFinite(pinLat) && Number.isFinite(pinLon)
    && metersBetween([lat, lon], [pinLat, pinLon]) <= STOP_NEAR_M;
  const along = stopRouteAlong(chosen);
  const onLine = Boolean(hit) && hit.dist <= STOP_LINE_M && along != null;
  const routeNear = onLine && Math.abs(hit.along - along) <= STOP_NEAR_M;
  if (!pinNear && !routeNear) return false;
  if (onLine && hit.along > along + STOP_PAST_M) {
    const leaving = legLeavingStop(chosen);
    return Boolean(leaving && hit.along >= leaving.start && hit.along <= leaving.end + STOP_PAST_M);
  }
  return true;
}

function guideLegFor(chosen) {
  return legLeavingStop(chosen) || legForStopId(chosen?.stop?.id);
}

function guideChoice() {
  if (navGuideFromId) {
    const dests = navDestList();
    const found = dests.find((item) => item.stop.id === navGuideFromId);
    if (found) return found;
  }
  if (navStopPicked && navStopAwaitNear) return chosenNavStop();
  return null;
}

function nearestNearStop(lat, lon, hit) {
  let best = null;
  let bestDist = Infinity;
  for (const dest of navDestList()) {
    if (!nearChosenStop(dest, lat, lon, hit)) continue;
    const along = stopRouteAlong(dest);
    const dist = along == null ? 0 : Math.abs(hit.along - along);
    if (dist < bestDist) {
      best = dest;
      bestDist = dist;
    }
  }
  return best;
}

const STOP_NAME_LIMIT = 8;

function clipStopName(value) {
  return String(value ?? "").slice(0, STOP_NAME_LIMIT);
}

function stopButtonLines(stop) {
  const name = clipStopName(navStopTitle(stop).replace(/\s+/g, " ").trim()) || "Stop";
  const space = name.indexOf(" ");
  const rest = space > 0 ? name.length - space - 1 : 0;
  if (space > 0 && space <= 4 && rest <= 4 && rest > 0) {
    return [name.slice(0, space), name.slice(space + 1)];
  }
  if (name.length <= 5) return [name, ""];
  return [name.slice(0, 4), name.slice(4)];
}

function stopButtonMarkup(stop) {
  const [top, bottom] = stopButtonLines(stop);
  return `<span id="routeStopLine1">${escapeAttr(top)}</span><span id="routeStopLine2"${bottom ? "" : " hidden"}>${escapeAttr(bottom)}</span>`;
}

function paintStopButton() {
  const button = document.getElementById("routeStop");
  const line1 = document.getElementById("routeStopLine1");
  const line2 = document.getElementById("routeStopLine2");
  if (!line1 || !line2) return;
  const shown = chosenNavStop();
  const [top, bottom] = stopButtonLines(shown?.stop);
  line1.textContent = top;
  line2.textContent = bottom;
  line2.hidden = !bottom;
  if (button) button.setAttribute("aria-label", navStopTitle(shown?.stop));
}

function placeRailMenu(menu) {
  if (!menu || menu.hidden) return;
  const pop = menu.parentElement;
  const stage = menu.closest(".route-stage");
  if (!pop || !stage) return;
  menu.style.top = "0px";
  const limit = stage.getBoundingClientRect();
  const popBox = pop.getBoundingClientRect();
  const height = menu.getBoundingClientRect().height;
  let top = 0;
  if (popBox.top + height > limit.bottom - 8) top = (limit.bottom - 8) - height - popBox.top;
  if (popBox.top + top < limit.top + 8) top = (limit.top + 8) - popBox.top;
  menu.style.top = `${Math.round(top)}px`;
}

function placeOpenRailMenus() {
  if (railMenu === "detour") placeRailMenu(document.getElementById("railDetourMenu"));
  if (railMenu === "stops") placeRailMenu(document.getElementById("railStopsMenu"));
}

function paintRailMenus() {
  const stopsBtn = document.getElementById("routeStops");
  const detourBtn = document.getElementById("routeDetour");
  const stopsMenu = document.getElementById("railStopsMenu");
  const detourMenu = document.getElementById("railDetourMenu");
  if (stopsBtn) {
    stopsBtn.classList.toggle("on", railMenu === "stops");
    stopsBtn.setAttribute("aria-expanded", railMenu === "stops" ? "true" : "false");
  }
  if (detourBtn) {
    detourBtn.classList.toggle("on", railMenu === "detour");
    detourBtn.setAttribute("aria-expanded", railMenu === "detour" ? "true" : "false");
  }
  if (detourMenu) detourMenu.hidden = railMenu !== "detour";
  if (!stopsMenu) return;
  stopsMenu.hidden = railMenu !== "stops";
  if (railMenu === "stops") {
    const dests = navDestList();
    stopsMenu.innerHTML = dests.length
      ? dests.map(({ stop }) => `<button type="button" data-aim-stop="${escapeAttr(stop.id)}">${escapeAttr(navStopTitle(stop))}</button>`).join("")
      : `<button type="button" disabled>No stops</button>`;
  }
  if (railMenu) requestAnimationFrame(placeOpenRailMenus);
}

function toggleRailMenu(which) {
  railMenu = railMenu === which ? "" : which;
  paintRailMenus();
}

function aimNavAtStop(stopId, confirmed) {
  const dests = navDestList();
  const pos = dests.findIndex((item) => item.stop.id === stopId);
  if (pos < 0) return;
  if (!confirmed && navOn) {
    const held = activeNavLeg();
    if (held?.stop && held.stop.id !== stopId && !held.stop.done) {
      pendingAimId = stopId;
      railMenu = "";
      paintRailMenus();
      const name = navStopTitle(held.stop);
      const yes = document.getElementById("routeSwitch");
      const row = document.getElementById("routeSwitchRow");
      if (yes) yes.textContent = `Is ${name} done?`;
      if (row) row.hidden = false;
      speakNav(`Is ${name} done?`);
      return;
    }
  }
  pendingAimId = "";
  const row = document.getElementById("routeSwitchRow");
  if (row) row.hidden = true;
  railMenu = "";
  paintRailMenus();
  navStopCursor = pos;
  navAimStopId = stopId;
  navStopPicked = true;
  navGuideFromId = "";
  navStopAwaitNear = false;
  navStopAnnounce = false;
  clearDirectionPin();
  clearTurnFrame();
  const name = navStopTitle(dests[pos].stop);
  showStopNote(`Head to ${name}`, 4000);
  if (!navOn) {
    unlockMix();
    beginRouteNav();
    return;
  }
  followPinned = false;
  tripFit = "nextTurn";
  navFollowing = false;
  navZoomHold = 0;
  window.clearTimeout(navReturnTimer);
  navReturnTimer = 0;
  if (navFix) onNavFix(navFix[0], navFix[1]);
  syncRouteChrome();
}

let navStopTapAt = 0;
let navAimStopId = "";
let pendingAimId = "";
let railMenu = "";
let dirPinned = null;
let dirPinTimer = 0;
// Trip zoom before navigation. Turn zoom when navigation starts.
let tripFit = "full";

function tripFitLines() {
  if (tripFit === "remaining") return ["Left", "zoom"];
  if (tripFit === "nextTurn") return ["Turn", "zoom"];
  if (tripFit === "nextStop") return ["Stop", "zoom"];
  return ["Trip", "zoom"];
}

function syncTripFitButton() {
  const button = document.getElementById("routeWhole");
  if (!button) return;
  const [top, bottom] = tripFitLines();
  button.innerHTML = `<span>${top}</span><span>${bottom}</span>`;
  button.setAttribute("aria-label", `${top} ${bottom}`);
  button.classList.toggle("on", tripFit !== "off");
}

function tripViewPadding() {
  const map = document.getElementById("routeMap");
  const pad = { top: 88, right: 72, bottom: 120, left: 72 };
  if (!map) return pad;
  const mapBox = map.getBoundingClientRect();
  if (mapBox.height < 2 || mapBox.width < 2) return pad;
  const stack = document.querySelector("#routeStage .route-bottom");
  if (stack) {
    const box = stack.getBoundingClientRect();
    if (box.height > 2 && box.top < mapBox.bottom) {
      // Keep the whole trip above the directions / ETA stack (9:46).
      pad.bottom = Math.round(mapBox.bottom - box.top + 40);
    }
  }
  const clear = railClearance();
  pad.left = Math.max(pad.left, clear.left + 10);
  pad.right = Math.max(pad.right, clear.right + 10);
  pad.top = Math.max(pad.top, routeFull ? 72 : 52);
  const maxY = Math.max(40, Math.floor(mapBox.height / 2) - 20);
  const maxX = Math.max(40, Math.floor(mapBox.width / 2) - 20);
  pad.top = Math.min(pad.top, maxY);
  pad.bottom = Math.min(pad.bottom, maxY);
  pad.left = Math.min(pad.left, maxX);
  pad.right = Math.min(pad.right, maxX);
  return pad;
}

function fitCoords(coordinates, maxZoom) {
  if (!routeMap || !window.maplibregl || coordinates.length < 2) return;
  const bounds = coordinates.reduce(
    (box, coord) => box.extend(coord),
    new window.maplibregl.LngLatBounds(coordinates[0], coordinates[0]),
  );
  routeMap.stop();
  routeMap.fitBounds(bounds, { padding: tripViewPadding(), maxZoom, bearing: 0, duration: 600 });
}

let turnFrameAt = null;
let turnFrameTarget = null;
let turnFrameBearing = null;
let turnShownKey = "";
let turnShownAlong = null;
let turnOpenAlong = null;
let turnBehind = null;
let turnKeepAlong = null;
let turnLockAlong = null;
let turnPhase = "approach";
let turnWidenAt = 0;
let turnZoomOut = null;
let turnZoomOutTimer = 0;
let stopFrameAt = null;
let stopFrameId = "";
let routeCoverSize = "";

function currentDirectionEnd(hereAlong) {
  const leg = activeNavLeg({ along: hereAlong });
  if (!leg) return null;
  const gap = Math.max(0, leg.start - hereAlong);
  const alongInLeg = Math.max(0, hereAlong - leg.start);
  const found = navStep(leg, alongInLeg);
  if (!found) return null;
  const left = metersLeftInStep(leg, alongInLeg, found.index) + gap;
  return hereAlong + Math.max(0, left);
}

function turnViewPadding() {
  const map = document.getElementById("routeMap");
  const sheet = document.getElementById("routeDirections");
  const pad = { top: 72, right: 64, bottom: 110, left: 64 };
  if (!map) return pad;
  const mapBox = map.getBoundingClientRect();
  if (mapBox.height < 2) return pad;
  const stack = document.querySelector("#routeStage .route-bottom");
  // On the page, directions live below the map. Only clear chips that sit
  // on the map (ETA / place). In fullscreen the directions are in the stack.
  const block = routeFull
    ? (stack && stack.getBoundingClientRect().height > 2 ? stack : sheet)
    : stack;
  if (block && !block.hidden) {
    const box = block.getBoundingClientRect();
    if (box.height > 2 && box.top < mapBox.bottom && box.top > mapBox.top) {
      pad.bottom = Math.round(mapBox.bottom - box.top + 16);
    }
  }
  const buttonH = document.getElementById("routeRecalc")?.getBoundingClientRect().height || 60;
  const compass = document.getElementById("routeCompass");
  if (routeFull) {
    // Fullscreen: next turn two button-heights below the top (under the notch).
    pad.top = Math.max(pad.top, Math.round(safeTopPad() + buttonH * 2 + 8));
  } else if (compass) {
    // Page: next turn at compass height.
    const box = compass.getBoundingClientRect();
    if (box.height > 10) pad.top = Math.max(48, Math.round(box.top + box.height / 2 - mapBox.top));
  }
  const minOpen = Math.max(160, Math.round(mapBox.height * 0.28));
  const maxBottom = Math.max(90, mapBox.height - minOpen);
  if (pad.bottom > maxBottom) pad.bottom = maxBottom;
  pad.bottom = Math.max(90, pad.bottom);
  pad.top = Math.min(pad.top, Math.max(48, mapBox.height - pad.bottom - 120));
  return pad;
}

// The side buttons sit on top of the map. This is how far the route has to
// stay from each edge so it does not run under them.
function railClearance() {
  const map = document.getElementById("routeMap");
  const clear = { left: 78, right: 78 };
  if (!map) return clear;
  const mapBox = map.getBoundingClientRect();
  if (mapBox.width < 2) return clear;
  document.querySelectorAll(".route-stage .route-rail").forEach((rail) => {
    const box = rail.getBoundingClientRect();
    if (box.width < 2 || box.height < 2) return;
    const onLeft = box.left + box.width / 2 < mapBox.left + mapBox.width / 2;
    const cover = onLeft
      ? box.right - mapBox.left + 16
      : mapBox.right - box.left + 16;
    if (cover > 0) {
      if (onLeft) clear.left = Math.max(clear.left, Math.round(cover));
      else clear.right = Math.max(clear.right, Math.round(cover));
    }
  });
  return clear;
}

// Extra zoom keeps the same center, so it crops the padded edges. Widen the
// side padding first so the route still clears the buttons after that zoom.
function paddingForTurnZoom(basePad, deeper) {
  const clear = railClearance();
  const padding = {
    top: basePad.top,
    bottom: basePad.bottom,
    left: Math.max(basePad.left, clear.left),
    right: Math.max(basePad.right, clear.right),
  };
  if (!(deeper > 0)) return { padding, zoomIn: 0 };
  const width = document.getElementById("routeMap")?.getBoundingClientRect().width || 0;
  if (width < 160) return { padding, zoomIn: 0 };
  const scale = 2 ** deeper;
  const widen = (side) => Math.ceil(side / scale + (width / 2) * (1 - 1 / scale));
  const left = widen(padding.left);
  const right = widen(padding.right);
  if (left + right > width - 72) return { padding, zoomIn: 0 };
  return { padding: { ...padding, left, right }, zoomIn: deeper };
}

const TURN_HOLD_MS = 60000;
const TURN_OPEN_MS = 6000;

function clearTurnFrame() {
  turnFrameAt = null;
  turnFrameTarget = null;
  turnFrameBearing = null;
  turnShownKey = "";
  turnShownAlong = null;
  turnKeepAlong = null;
  turnLockAlong = null;
  turnPhase = "approach";
  turnWidenAt = 0;
  stopTurnZoomOut();
}

function stopTurnZoomOut() {
  window.clearTimeout(turnZoomOutTimer);
  turnZoomOutTimer = 0;
  turnZoomOut = null;
}

function turnGuideAlong() {
  const hit = navNearest(navFix[0], navFix[1], navLine);
  let along = hit.along;
  if (navStopPicked) {
    const chosen = guideChoice();
    const guide = chosen && nearChosenStop(chosen, navFix[0], navFix[1], hit) ? guideLegFor(chosen) : null;
    if (guide && along < guide.start) along = Math.max(0, guide.start - 10);
  }
  return along;
}

function turnSpan(along) {
  const lineEnd = polylineMeters(navLine);
  const quarter = 0.25 * 1609.344;
  const mile = 1609.344;
  const turnAlong = currentDirectionEnd(along);
  const stepKey = turnStepKey(along);
  if (turnOpenAlong == null) turnOpenAlong = along;
  if (
    turnShownKey
    && stepKey
    && turnShownKey !== stepKey
    && Number.isFinite(turnShownAlong)
    && turnShownAlong <= along + 30
  ) {
    turnBehind = { along: turnShownAlong };
  }
  if (turnBehind && along - turnBehind.along >= mile) turnBehind = null;
  let fromAlong = along;
  let farAlong = along;
  if (turnBehind && along - turnBehind.along < mile) {
    fromAlong = Math.min(along, turnBehind.along);
    farAlong = Math.min(lineEnd, along + quarter);
  } else {
    const driven = Math.max(0, along - turnOpenAlong);
    const opening = Math.min(mile, quarter + driven);
    const opened = driven >= mile - quarter;
    if (opened && turnAlong != null && turnAlong > along + 40) farAlong = Math.min(lineEnd, turnAlong);
    else farAlong = Math.min(lineEnd, along + Math.max(40, opening));
  }
  const far = pointAlong(navLine, farAlong);
  const aim = pointAlong(navLine, Math.min(lineEnd, along + quarter)) || far;
  let bearing = 0;
  if (!northLock) {
    bearing = aim && navFix
      ? navBearing(navFix, [aim.lat, aim.lon])
      : (navCompass != null ? navCompass : 0);
  }
  return { turnAlong, ahead: Math.max(0, farAlong - along), farAlong, fromAlong, far, bearing, deeper: 0 };
}

function turnStepKey(along) {
  const leg = activeNavLeg({ along });
  if (!leg?.stop?.id) return "";
  const found = navStep(leg, Math.max(0, along - leg.start));
  if (!found) return "";
  return `${leg.stop.id}:${found.index}`;
}

function turnNearAlong(along, ahead) {
  const halfMile = 804.672;
  if (!Number.isFinite(turnKeepAlong)) return along;
  if (ahead <= halfMile || along - turnKeepAlong > halfMile) {
    turnKeepAlong = null;
    return along;
  }
  return Math.min(along, turnKeepAlong);
}

function boundsForTurn(fromAlong, toAlong) {
  const maplibre = window.maplibregl;
  const from = Math.min(fromAlong, toAlong);
  const to = Math.max(fromAlong, toAlong);
  const coords = navRemaining(from, to);
  const near = pointAlong(navLine, from);
  const far = pointAlong(navLine, to);
  if (navFix) coords.push([navFix[1], navFix[0]]);
  if (near) coords.push([near.lon, near.lat]);
  if (far) coords.push([far.lon, far.lat]);
  if (!maplibre || coords.length < 2) return null;
  const box = coords.reduce(
    (bounds, coord) => bounds.extend(coord),
    new maplibre.LngLatBounds(coords[0], coords[0]),
  );
  // A straight road is only a few meters wide. Fitting that width zooms
  // into the pavement and leaves the turn off the screen.
  const span = Math.max(80, Math.abs(to - from));
  const side = Math.max(90, span * 0.45);
  const mid = pointAlong(navLine, (from + to) / 2) || (navFix ? { lat: navFix[0], lon: navFix[1] } : null);
  if (mid) {
    const dLat = side / 111320;
    const dLon = side / (111320 * Math.max(0.2, Math.cos(mid.lat * Math.PI / 180)));
    box.extend([mid.lon - dLon, mid.lat - dLat]);
    box.extend([mid.lon + dLon, mid.lat + dLat]);
  }
  return box;
}

function turnZoomCap(metersAhead) {
  if (metersAhead >= 1600) return 14;
  if (metersAhead >= 800) return 15;
  if (metersAhead >= 300) return 16;
  return 17;
}

function aimTurnZoom(zoom, metersAhead) {
  const cap = turnZoomCap(metersAhead);
  if (!Number.isFinite(zoom)) return cap;
  return Math.min(cap, zoom);
}

function fitTurnCamera(bounds, bearing, deeper) {
  let framed = paddingForTurnZoom(turnViewPadding(), 0);
  let fitted = null;
  try {
    fitted = routeMap.cameraForBounds(bounds, { padding: framed.padding, bearing: 0 });
  } catch {
    fitted = null;
  }
  if (deeper > 0 && fitted && Number.isFinite(fitted.zoom)) {
    const room = Math.min(deeper, Math.max(0, 18 - fitted.zoom));
    if (room > 0.01) {
      const closer = paddingForTurnZoom(turnViewPadding(), room);
      const again = closer.zoomIn > 0
        ? routeMap.cameraForBounds(bounds, { padding: closer.padding, bearing })
        : null;
      if (again && Number.isFinite(again.zoom)) {
        framed = closer;
        fitted = again;
      }
    }
  }
  if (!fitted || !Number.isFinite(fitted.zoom)) return { padding: framed.padding, camera: null };
  return {
    padding: framed.padding,
    camera: {
      center: fitted.center,
      zoom: Math.min(18, fitted.zoom + framed.zoomIn),
      bearing,
    },
  };
}

function heldBearing(desired) {
  if (!routeMap || !Number.isFinite(desired)) return Number.isFinite(desired) ? desired : 0;
  let delta = Math.abs(desired - routeMap.getBearing()) % 360;
  if (delta > 180) delta = 360 - delta;
  if (delta < 12) return routeMap.getBearing();
  return desired;
}

function placeTurnPin(turnAlong) {
  const maplibre = window.maplibregl;
  if (!routeMap || !maplibre || turnAlong == null) {
    if (turnMarker) {
      try { turnMarker.remove(); } catch {}
      turnMarker = null;
    }
    return;
  }
  const at = pointAlong(navLine, turnAlong);
  if (!at) return;
  const el = typeof turnMarker?.getElement === "function" ? turnMarker.getElement() : null;
  const orphan = !turnMarker || !el?.isConnected || (routeMap.getContainer?.() && !routeMap.getContainer().contains(el));
  if (orphan) {
    try { turnMarker?.remove(); } catch {}
    const pin = document.createElement("span");
    pin.className = "turn-pin";
    turnMarker = new maplibre.Marker({ element: pin, anchor: "center" }).setLngLat([at.lon, at.lat]).addTo(routeMap);
    return;
  }
  turnMarker.setLngLat([at.lon, at.lat]);
}

function scheduleTurnZoomOut() {
  if (!turnZoomOut || turnZoomOutTimer) return;
  turnZoomOutTimer = window.setTimeout(paintTurnZoomOut, 250);
}

function beginTurnHold(lastAlong, stepKey, nextTurnAlong) {
  window.clearTimeout(turnZoomOutTimer);
  turnZoomOutTimer = 0;
  turnKeepAlong = null;
  turnShownKey = stepKey;
  turnShownAlong = nextTurnAlong;
  turnZoomOut = {
    phase: "hold",
    started: Date.now(),
    elapsed: 0,
    paused: false,
    lastAlong,
    stepKey,
  };
  routeMap.stop();
  scheduleTurnZoomOut();
}

function paintTurnZoomOut() {
  turnZoomOutTimer = 0;
  if (!turnZoomOut || !routeMap || !navOn || !navFix || tripFit !== "nextTurn" || navLine.length < 2) {
    turnZoomOut = null;
    return;
  }
  if (turnZoomOut.paused || navMapTouch) {
    turnZoomOut.started = Date.now() - turnZoomOut.elapsed;
    scheduleTurnZoomOut();
    return;
  }
  turnZoomOut.elapsed = Date.now() - turnZoomOut.started;
  if (turnZoomOut.phase !== "open") {
    moveTurnZoomOut(0);
    if (turnZoomOut.elapsed < TURN_HOLD_MS) {
      scheduleTurnZoomOut();
      return;
    }
    turnZoomOut.phase = "open";
    turnZoomOut.started = Date.now();
    turnZoomOut.elapsed = 0;
  }
  const t = Math.min(1, turnZoomOut.elapsed / TURN_OPEN_MS);
  const moved = moveTurnZoomOut(t);
  if (t < 1) {
    scheduleTurnZoomOut();
    return;
  }
  if (moved && navFix) {
    turnFrameAt = [navFix[0], navFix[1]];
    turnFrameTarget = moved.farAlong;
    turnFrameBearing = moved.bearing;
  }
  turnZoomOut = null;
}

function moveTurnZoomOut(t) {
  rebuildNavLegs();
  if (!navFix || navLine.length < 2 || !turnZoomOut) return null;
  const along = turnGuideAlong();
  const span = turnSpan(along);
  if (!span.far) return null;
  const lastAlong = Number.isFinite(turnZoomOut.lastAlong) ? turnZoomOut.lastAlong : along;
  const opening = turnZoomOut.phase === "open";
  const farAlong = opening
    ? Math.max(along + 40, lastAlong + (span.farAlong - lastAlong) * t)
    : Math.max(along + 40, lastAlong, along);
  const from = !opening || t < 1 ? Math.min(along, lastAlong) : along;
  const bounds = boundsForTurn(from, farAlong);
  if (!bounds) return null;
  const bearing = heldBearing(span.bearing);
  const fit = fitTurnCamera(bounds, bearing, 0);
  if (!fit.camera) return null;
  fit.camera.zoom = aimTurnZoom(fit.camera.zoom, Math.abs(farAlong - along));
  routeMap.easeTo({
    center: fit.camera.center,
    zoom: fit.camera.zoom,
    bearing: fit.camera.bearing,
    duration: opening ? 280 : 400,
    easing: (x) => x,
  });
  placeTurnPin(opening ? span.turnAlong : lastAlong);
  return { farAlong: span.farAlong, bearing };
}

function zoomForCenterToTop(meters, lat, height) {
  const pixels = Math.max(80, height / 2);
  const mpp = Math.max(8, meters) / pixels;
  const cos = Math.max(0.2, Math.cos((Number(lat) || 0) * Math.PI / 180));
  const zoom = Math.log2((156543.03392 * cos) / mpp);
  return Math.max(3, Math.min(17.5, zoom));
}

function zoomForPixelSpan(meters, pixels, lat) {
  const mpp = Math.max(30, meters) / Math.max(48, pixels);
  const cos = Math.max(0.2, Math.cos((Number(lat) || 0) * Math.PI / 180));
  const zoom = Math.log2((156543.03392 * cos) / mpp);
  return Math.max(3, Math.min(18, zoom));
}

function pointAhead(lat, lon, bearingDeg, meters) {
  const delta = meters / 6378137;
  const theta = bearingDeg * Math.PI / 180;
  const phi1 = lat * Math.PI / 180;
  const lambda1 = lon * Math.PI / 180;
  const phi2 = Math.asin(Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(theta));
  const lambda2 = lambda1 + Math.atan2(
    Math.sin(theta) * Math.sin(delta) * Math.cos(phi1),
    Math.cos(delta) - Math.sin(phi1) * Math.sin(phi2),
  );
  return [phi2 * 180 / Math.PI, ((lambda2 * 180 / Math.PI + 540) % 360) - 180];
}

function travelBearing(along) {
  const here = pointAlong(navLine, along);
  const ahead = pointAlong(navLine, along + 50);
  if (here && ahead) return navBearing([here.lat, here.lon], [ahead.lat, ahead.lon]);
  if (typeof navTravel === "number") return navTravel;
  return routeMap?.getBearing() || 0;
}

function noHandsSlots() {
  const map = routeMap?.getContainer() || document.getElementById("routeMap");
  const height = map?.clientHeight || 640;
  const width = map?.clientWidth || 360;
  const mapBox = map?.getBoundingClientRect();
  const pad = turnViewPadding();
  const recalc = document.getElementById("routeRecalc");
  const compass = document.getElementById("routeCompass");
  let buttonH = 60;
  if (recalc) {
    const box = recalc.getBoundingClientRect();
    if (box.height > 10) buttonH = box.height;
  }
  // Map can extend above the visible screen in fullscreen (notch pad).
  // Slot Y values are in map pixels; keep the turn in the visible band.
  const visibleTop = mapBox && mapBox.top < 0 ? Math.round(-mapBox.top) : 0;
  // Next turn: fullscreen = two button-heights below the visible top; page = compass.
  let turnY = Math.max(visibleTop + 8, Math.round(visibleTop + buttonH * 2));
  if (!routeFull && compass && mapBox && mapBox.height > 10) {
    const box = compass.getBoundingClientRect();
    if (box.height > 10) turnY = box.top + box.height / 2 - mapBox.top;
  }
  turnY = Math.max(visibleTop + 8, Math.min(height * 0.42, turnY));
  // You: Recalculate height — never under the place chips / ETA stack.
  let userY = height - Math.max(pad.bottom, 24) - 12;
  if (recalc && mapBox && mapBox.height > 10) {
    const box = recalc.getBoundingClientRect();
    if (box.height > 10) userY = box.top + box.height / 2 - mapBox.top;
  }
  const clearBottom = height - Math.max(pad.bottom, 24) - 12;
  userY = Math.min(userY, clearBottom);
  userY = Math.max(turnY + buttonH * 1.8, userY);
  return { width, height, userY, turnY, buttonH };
}

function frameNextTurn() {
  if (!routeMap) return;
  rebuildNavLegs();
  if (!navFix || navLine.length < 2) return;
  // Seat rails above the live ETA / directions stack before reading slots.
  if (routeFull) seatRails();
  const along = turnGuideAlong();
  const mile = 1609.344;
  if (turnLockAlong == null) turnLockAlong = currentDirectionEnd(along);
  if (turnLockAlong != null && along >= turnLockAlong - 12) {
    const next = currentDirectionEnd(turnLockAlong + 35);
    const gap = next == null ? Infinity : next - turnLockAlong;
    if (gap < mile || along >= turnLockAlong + mile) {
      const jumped = next != null && next > along + 20 ? next : currentDirectionEnd(along + 20);
      if (jumped != null) turnLockAlong = jumped;
    }
  } else if (turnLockAlong != null) {
    const sooner = currentDirectionEnd(along);
    if (sooner != null && sooner + 30 < turnLockAlong) turnLockAlong = sooner;
  }
  const target = turnLockAlong;
  if (target == null) return;
  const at = pointAlong(navLine, target);
  if (!at) return;
  const slots = noHandsSlots();
  const ahead = target >= along - 15;
  // Keep the map pointed down the road under you. Aiming at a side turn
  // would swing the locked slots off center.
  let bearing = northLock ? 0 : travelBearing(along);
  if (!Number.isFinite(bearing)) {
    bearing = ahead ? navBearing(navFix, [at.lat, at.lon]) : (routeMap.getBearing() || 0);
  }
  if (!Number.isFinite(bearing)) bearing = routeMap.getBearing() || 0;
  const dist = metersBetween(navFix, [at.lat, at.lon]);
  const pixels = Math.max(72, slots.userY - slots.turnY);
  // Lock you and the turn on those screen slots. Zoom to fit the real
  // distance (a floor keeps a close turn from burying the pavement).
  const floor = routeFull ? 70 : 110;
  const span = Math.max(floor, ahead ? dist : Math.max(dist, floor));
  let zoom = zoomForPixelSpan(span, pixels, navFix[0]);
  zoom = Math.min(zoom, routeFull ? 17.2 : 16.4);
  const cos = Math.max(0.2, Math.cos(navFix[0] * Math.PI / 180));
  const mpp = (156543.03392 * cos) / (2 ** zoom);
  const center = pointAhead(navFix[0], navFix[1], bearing, (slots.userY - slots.height / 2) * mpp);
  placeTurnPin(target);
  turnShownAlong = target;
  placeNavDot(navFix[0], navFix[1]);
  routeMap.stop();
  routeMap.easeTo({
    center: [center[1], center[0]],
    zoom,
    bearing,
    duration: 450,
    easing: (x) => x,
  });
}

function frameNextStop() {
  const maplibre = window.maplibregl;
  const origin = originPoint();
  const here = navFix || (origin ? [origin.lat, origin.lon] : null);
  if (!routeMap || !maplibre || !here) return;
  rebuildNavLegs();
  const hit = navLine.length >= 2 ? navNearest(here[0], here[1], navLine) : null;
  const leg = activeNavLeg(hit || { along: 0 });
  const stop = leg?.stop;
  const lat = Number(stop?.lat);
  const lon = Number(stop?.lon);
  if (!stop || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
  if (stopFrameAt && stopFrameId === stop.id && metersBetween(stopFrameAt, here) < 150) return;
  const from = hit ? hit.along : 0;
  const until = Number.isFinite(leg?.end) ? leg.end : from;
  const coords = navLine.length >= 2 ? navRemaining(Math.min(from, until), until) : [];
  coords.push([here[1], here[0]], [lon, lat]);
  if (coords.length < 2) return;
  const bounds = coords.reduce(
    (box, coord) => box.extend(coord),
    new maplibre.LngLatBounds(coords[0], coords[0]),
  );
  const padding = paddingForTurnZoom(turnViewPadding(), 0).padding;
  stopFrameAt = [here[0], here[1]];
  stopFrameId = stop.id;
  if (turnMarker) {
    turnMarker.remove();
    turnMarker = null;
  }
  navZoomHold = Date.now() + 700;
  routeMap.stop();
  routeMap.fitBounds(bounds, {
    padding,
    bearing: 0,
    maxZoom: 15,
    duration: 600,
  });
}

function changeMapZoom(delta) {
  if (!routeMap) return;
  stopTurnZoomOut();
  navZoomHold = Date.now() + 1200;
  routeMap.stop();
  navZoom = Math.min(18, Math.max(3, routeMap.getZoom() + delta * 2));
  const camera = { zoom: navZoom, duration: 200 };
  if (navFollowing && navFix) camera.center = [navFix[1], navFix[0]];
  routeMap.easeTo(camera);
}

function holdUserZoom(event) {
  if (!event.originalEvent || !routeMap) return;
  stopTurnZoomOut();
  navZoom = routeMap.getZoom();
  navZoomHold = Date.now() + 1200;
}

function cycleTripFit() {
  window.clearTimeout(navReturnTimer);
  navReturnTimer = 0;
  followPinned = false;
  navFollowing = false;
  syncRouteChrome();
  if (tripFit === "off" || tripFit === "nextStop") tripFit = "full";
  else if (tripFit === "full") tripFit = "remaining";
  else if (tripFit === "remaining") tripFit = "nextTurn";
  else tripFit = "nextStop";
  syncTripFitButton();
  if (tripFit === "full") {
    showWholeTrip();
    return;
  }
  rebuildNavLegs();
  if (tripFit === "remaining") {
    const from = navFix && navLine.length >= 2 ? navNearest(navFix[0], navFix[1], navLine).along : 0;
    fitCoords(navRemaining(from, Infinity), 14);
    return;
  }
  if (tripFit === "nextStop") {
    stopFrameAt = null;
    stopFrameId = "";
    frameNextStop();
    return;
  }
  clearTurnFrame();
  frameNextTurn();
}

function liveDirection() {
  if (!navOn || !navFix || navLine.length < 2) {
    const stop = state.stops.find((item) => Array.isArray(item.directions) && item.directions.length);
    return stop ? { stopId: stop.id, index: 0 } : null;
  }
  const hit = navNearest(navFix[0], navFix[1], navLine);
  const leg = activeNavLeg(hit);
  const found = leg ? navStep(leg, Math.max(0, hit.along - leg.start)) : null;
  if (!found || !leg?.stop?.id) return null;
  return { stopId: leg.stop.id, index: found.index };
}

function metersLeftInStep(leg, alongInLeg, index) {
  const steps = Array.isArray(leg?.stop?.directions) ? leg.stop.directions : [];
  const lengths = scaledStepLengths(steps, leg?.path);
  if (!lengths.length) return 0;
  const into = Math.max(0, alongInLeg);
  if (index >= lengths.length - 1) return Math.max(0, polylineMeters(leg?.path || []) - into);
  let cursor = 0;
  for (let i = 0; i < index; i += 1) cursor += lengths[i] || 0;
  return Math.max(0, (lengths[index] || 0) - Math.max(0, into - cursor));
}

function maneuverEndAlong(stopId, index) {
  const leg = navLegs.find((item) => item.stop?.id === stopId);
  if (!leg || index < 0) return null;
  const steps = Array.isArray(leg.stop.directions) ? leg.stop.directions : [];
  const lengths = scaledStepLengths(steps, leg.path);
  if (!lengths.length) return null;
  if (index >= lengths.length - 1) return leg.end;
  let end = leg.start;
  for (let i = 0; i <= index; i += 1) end += lengths[i] || 0;
  return end;
}

function directionStep(stopId, index) {
  const at = state.stops.findIndex((item) => item.id === stopId);
  const stop = at >= 0 ? state.stops[at] : null;
  const steps = Array.isArray(stop?.directions) ? stop.directions : [];
  if (steps[index]) return steps[index];
  const follow = at >= 0 ? state.stops[at + 1] : null;
  return follow?.directions?.[0] || null;
}

function nextManeuverText(stopId, index) {
  const at = state.stops.findIndex((item) => item.id === stopId);
  const stop = at >= 0 ? state.stops[at] : null;
  const steps = Array.isArray(stop?.directions) ? stop.directions : [];
  if (steps[index + 1]?.text) return String(steps[index + 1].text);
  const follow = at >= 0 ? state.stops[at + 1] : null;
  return String(follow?.directions?.[0]?.text || "");
}

function stepSpanMeters(stopId, index) {
  const step = directionStep(stopId, index);
  const leg = navLegs.find((item) => item.stop?.id === stopId);
  if (!leg) return stepLengthMeters(step);
  const steps = Array.isArray(leg.stop.directions) ? leg.stop.directions : [];
  const lengths = scaledStepLengths(steps, leg.path);
  if (index >= 0 && index < lengths.length && lengths[index] > 0) return lengths[index];
  return stepLengthMeters(step);
}

function directionPlace(stopId, index, live) {
  if (!live?.stopId) return 0;
  const here = state.stops.findIndex((item) => item.id === stopId);
  const current = state.stops.findIndex((item) => item.id === live.stopId);
  if (here < 0 || current < 0) return 0;
  if (here !== current) return here - current;
  return index - live.index;
}

function paintDirectionMiles(truckAlong, current) {
  const ids = new Set(state.stops.map((stop) => stop.id));
  const live = current?.stopId ? current : liveDirection();
  document.querySelectorAll("[data-dir-stop]").forEach((button) => {
    const stopId = button.getAttribute("data-dir-stop");
    if (!ids.has(stopId)) {
      const li = button.closest("li");
      const prev = li?.previousElementSibling;
      li?.remove();
      if (prev?.classList.contains("dir-leg")) prev.remove();
      return;
    }
    const index = Number(button.getAttribute("data-dir-index"));
    const link = button.querySelector(".dir-link");
    const slot = button.querySelector(".dir-miles");
    if (!link) return;
    const end = maneuverEndAlong(stopId, index);
    const nextText = nextManeuverText(stopId, index);
    const step = directionStep(stopId, index);
    const ahead = end == null || !Number.isFinite(truckAlong) ? NaN : end - truckAlong;
    const place = directionPlace(stopId, index, live);
    // Later lines stay at the miles they will show when they become current.
    const meters = place > 0 ? stepSpanMeters(stopId, index) : ahead;
    if (place >= 0 && meters > 1) {
      const approach = approachPhrase(nextText, meters);
      link.textContent = approach || directionWithMilesLeft(link.getAttribute("data-original") || step?.text || "", meters);
    } else {
      const name = maneuverText(nextText) || maneuverText(String(step?.text || ""));
      link.textContent = name || withoutGo(String(step?.text || ""));
    }
    if (slot) slot.textContent = "";
  });
}

function armStopSwitch() {
  clearTurnFrame();
  window.clearTimeout(navReturnTimer);
  navReturnTimer = 0;
  if (tripFit !== "nextTurn") navFollowing = true;
  syncRouteChrome();
}

function refreshStopGuidance() {
  if (!navOn) {
    unlockNavVoice();
    beginRouteNav();
    return;
  }
  if (navFix) onNavFix(navFix[0], navFix[1]);
  else applyChosenStop();
}

function speakStopNote(text) {
  if (!navOn || !text) return;
  playChosenVoice(text, { barge: true });
}

function beginGuideFrom(chosen) {
  const leaving = legLeavingStop(chosen);
  const dests = navDestList();
  const pos = dests.findIndex((item) => item.stop.id === chosen.stop.id);
  navStopPicked = true;
  if (!leaving) {
    navGuideFromId = "";
    navStopAwaitNear = false;
    navStopAnnounce = false;
    if (pos >= 0 && dests.length > 1) navStopCursor = (pos + 1) % dests.length;
    showStopNote("That's the last stop", 6000);
    armStopSwitch();
    speakStopNote("That's the last stop");
    return;
  }
  navGuideFromId = chosen.stop.id;
  navStopAwaitNear = false;
  navStopAnnounce = true;
  navStopSpeakKey = "";
  if (pos >= 0) navStopCursor = (pos + 1) % dests.length;
  armStopSwitch();
  refreshStopGuidance();
}

function cycleNavStop(event) {
  const now = Date.now();
  if (now - navStopTapAt < 400) return;
  navStopTapAt = now;
  event?.preventDefault();
  event?.stopPropagation();
  const dests = navDestList();
  if (dests.length < 2) {
    const text = dests.length ? "Only one stop" : "No stop to switch";
    showStopNote(text, 6000);
    speakStopNote(text);
    return;
  }
  rebuildNavLegs();
  const hit = navFix && navLine.length >= 2 ? navNearest(navFix[0], navFix[1], navLine) : null;
  if (!navStopPicked && hit) {
    const here = nearestNearStop(navFix[0], navFix[1], hit);
    if (here) {
      beginGuideFrom(here);
      return;
    }
  }
  const shown = chosenNavStop();
  if (shown && hit && nearChosenStop(shown, navFix[0], navFix[1], hit)) {
    beginGuideFrom(shown);
    return;
  }
  navStopCursor = (navStopCursor + 1) % dests.length;
  navStopPicked = true;
  navGuideFromId = "";
  navStopAwaitNear = true;
  navStopAnnounce = true;
  navStopSpeakKey = "";
  armStopSwitch();
  if (!navFix) {
    const chosen = chosenNavStop();
    if (chosen) showStopNote(`Not near ${navStopTitle(chosen.stop)}`);
  }
  refreshStopGuidance();
}

function applyChosenStop() {
  rebuildNavLegs();
  const chosen = chosenNavStop();
  if (!chosen) return;
  const until = alongForChosen(chosen);
  const name = navStopTitle(chosen.stop);
  if (!navStopNoteText) showStopNote(`Head to ${name}`);
  if (chosen.stop?.skipRoute) sayNav(`Head back to ${name}`, "Recalculate to turn around.", "");
  else sayNav(`Head to ${name}`, until == null ? "" : `${navMiles(until)} to ${name}`, "");
  if (until != null) paintNavLine(0, until);
}

function guideFromChosenStop(chosen, lat, lon, hit) {
  if (!chosen) return null;
  const name = navStopTitle(chosen.stop);
  if (!nearChosenStop(chosen, lat, lon, hit)) {
    if (!navStopAwaitNear) {
      navGuideFromId = "";
      clearStopNote(true);
      return null;
    }
    showStopNote(`Not near ${name}`);
    const key = `${chosen.stop.id}:away`;
    if (navStopSpeakKey !== key) {
      navStopSpeakKey = key;
      if (navStopAnnounce) {
        navStopAnnounce = false;
        stopNavUtterance();
        speakNav(`Not near ${name}`);
      }
    }
    return "away";
  }
  navGuideFromId = chosen.stop.id;
  navStopAwaitNear = false;
  clearStopNote(true);
  const leg = guideLegFor(chosen);
  if (!leg?.stop?.id) return null;
  const onLeg = hit.along >= leg.start - 20 && hit.along <= leg.end + 20;
  const alongInLeg = onLeg ? Math.max(0, hit.along - leg.start) : 0;
  const steps = Array.isArray(leg.stop.directions) ? leg.stop.directions : [];
  const found = onLeg ? navStep(leg, alongInLeg) : { step: steps[0] || null, index: 0 };
  const targetName = navStopTitle(leg.stop);
  const leftToEnd = Math.max(0, leg.end - hit.along);
  if (!found?.step || !steps[found.index]) {
    showStopNote(`Head to ${targetName}`, 4000);
    paintNavLine(Math.min(hit.along, leg.end), leg.end);
    setStopChip(leftToEnd, targetName);
    return "near";
  }
  const leftInStep = metersLeftInStep(leg, alongInLeg, found.index);
  const marked = markDirection(leg.stop.id, found.index);
  if (!marked) showStopNote(`Head to ${targetName}`, 4000);
  paintDirectionMiles(hit.along, { stopId: leg.stop.id, index: found.index });
  openDirectionsNear(leg.stop.id, found.index, leftInStep);
  paintNavLine(Math.min(hit.along, leg.end), leg.end);
  setStopChip(leftToEnd, targetName);
  const title = String(found.step.text || "").trim();
  const nextTitle = approachPhrase(upcomingDirection(leg, found.index), leftInStep);
  sayNav(
    nextTitle || (title ? directionWithMilesLeft(title, leftInStep) : `Continue to ${targetName}`),
    `${navMiles(leftToEnd)} to ${targetName}`,
    "",
  );
  const key = `${chosen.stop.id}:near`;
  if (navStopSpeakKey !== key) {
    navStopSpeakKey = key;
    navStopAnnounce = false;
    spokenStepKey = "";
    spokenMiles.clear();
  }
  speakNavProgress(leg, found, onLeg ? hit.along : leg.start);
  return "near";
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

function activeNavLeg() {
  if (!navLegs.length) return null;
  if (navAimStopId) {
    const aimed = navLegs.find((leg) => leg.stop?.id === navAimStopId && leg.stop && !leg.stop.skipRoute && !leg.stop.done);
    if (aimed) return aimed;
  }
  for (const leg of navLegs) {
    const stop = leg.stop;
    if (!stop || stop.skipRoute || stop.done || stop.useCurrentLocation) continue;
    return leg;
  }
  return null;
}

function nextRoutedLeg(after) {
  const start = after ? navLegs.indexOf(after) + 1 : 0;
  for (let i = Math.max(0, start); i < navLegs.length; i += 1) {
    const stop = navLegs[i].stop;
    if (!stop || stop.useCurrentLocation || stop.skipRoute || stop.done || !pointReady(stop)) continue;
    return navLegs[i];
  }
  return null;
}

let switchSpokenFor = "";

function paintSwitchOffer() {
  if (pendingAimId) return;
  const row = document.getElementById("routeSwitchRow");
  if (row) row.hidden = true;
}

function confirmStopSwitch() {
  const nextId = pendingAimId;
  const held = activeNavLeg();
  pendingAimId = "";
  const row = document.getElementById("routeSwitchRow");
  if (row) row.hidden = true;
  if (held?.stop && !held.stop.done) {
    markStopDone(held.stop, { switched: true });
  }
  if (nextId) aimNavAtStop(nextId, true);
}

function declineStopSwitch() {
  pendingAimId = "";
  const row = document.getElementById("routeSwitchRow");
  if (row) row.hidden = true;
  if (navFix) onNavFix(navFix[0], navFix[1]);
}

function legUnderFix(lat, lon) {
  rebuildNavLegs();
  if (navLine.length < 2 || !navLegs.length) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const hit = navNearest(lat, lon, navLine);
  return navLegs.find((item) => hit.along >= item.start && hit.along <= item.end) || navLegs[navLegs.length - 1];
}

function upcomingRoutedStop() {
  rebuildNavLegs();
  const leg = activeNavLeg();
  return leg?.stop || null;
}

function applyAheadLeg(here, stopId, leg) {
  const kept = state.stops.filter((stop) => !stop.useCurrentLocation);
  const chosenPos = kept.findIndex((stop) => stop.id === stopId);
  if (chosenPos < 0) return false;
  kept.forEach((stop, index) => {
    const passed = index < chosenPos;
    stop.skipRoute = passed;
    if (!passed) return;
    stop.miles = "";
    stop.hours = "";
    stop.path = [];
    stop.directions = [];
  });
  const targetStop = kept[chosenPos];
  targetStop.skipRoute = false;
  targetStop.miles = String(Math.round(leg.miles * 10) / 10);
  targetStop.hours = String(Math.round(leg.hours * 100) / 100);
  targetStop.path = Array.isArray(leg.points) ? leg.points : [];
  targetStop.directions = Array.isArray(leg.directions) ? leg.directions : [];
  if (leg.credits != null) state.credits = leg.credits;
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
  const cursor = navDestList().findIndex((item) => item.stop.id === stopId);
  if (cursor >= 0) navStopCursor = cursor;
  navStopPicked = false;
  navGuideFromId = "";
  navStopAwaitNear = false;
  navStopAnnounce = false;
  navStopSpeakKey = "";
  clearStopNote(true);
  rememberOrigin();
  persist();
  return true;
}

function abortRecalc(message) {
  state.estimating = false;
  state.error = message;
  state.notice = "";
  if (routeFull && document.getElementById("routeStage")) {
    showStopNote(message, 8000);
    syncRouteChrome();
    return;
  }
  render();
}

async function recalculateFromHere() {
  if (state.estimating) return;
  state.estimating = true;
  state.error = "";
  // Do not move or replace the rail while this tap is finishing, and do not
  // rebuild the full-screen map when the route comes back. A new map covers
  // Exit and zoom until the page is force-closed.
  const calc = document.getElementById("calculate");
  if (calc) {
    calc.disabled = true;
    calc.innerHTML = calculateButtonLabel();
  }
  const here = await currentFix();
  if (!here) {
    abortRecalc("Allow location first, then Recalculate.");
    return;
  }
  rebuildNavLegs();
  if (navLine.length < 2) {
    abortRecalc("Calculate the trip first.");
    return;
  }
  noteArrivedStops(here.lat, here.lon);
  const target = upcomingRoutedStop(here.lat, here.lon);
  if (!target) {
    abortRecalc("No stop ahead to recalculate.");
    return;
  }
  if (!state.unlimited && state.credits === 0) {
    abortRecalc(creditEmptyMessage());
    return;
  }
  const name = navStopTitle(target);
  let leg;
  try {
    const heading = here.heading;
    leg = await routeTruckLeg(
      { lat: here.lat, lon: here.lon },
      { lat: Number(target.lat), lon: Number(target.lon) },
      typeof heading === "number" ? heading : undefined,
      { avoidUTurns: true },
    );
  } catch (error) {
    if (error.credits != null) state.credits = error.credits;
    abortRecalc(error.message || "Could not get a HERE© truck route.");
    return;
  }
  if (!applyAheadLeg(here, target.id, leg)) {
    abortRecalc("No stop ahead to recalculate.");
    return;
  }
  clearDriveProgress();
  state.estimating = false;
  state.notice = `HERE© truck route to ${name} (${TRUCK_PROFILE.summary}).`;
  await calculate({ silent: true, keepScreen: true });
}

function stopPoint(stop) {
  if (!stop) return null;
  if (stop.useCurrentLocation) {
    const here = originPoint();
    return here ? { lat: here.lat, lon: here.lon } : null;
  }
  const lat = Number(stop.lat);
  const lon = Number(stop.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

function routeTruckLeg(from, to, course, options = {}) {
  const mode = state.settings.routeMode === "short" ? "short" : "fast";
  const run = (routingMode) => truckRoute(from, to, {
    speedCapMph: state.settings.governed ? mph() : null,
    departAt: leaveAtNow(),
    ...(typeof course === "number" ? { course } : {}),
    ...(options.avoidUTurns ? { avoidUTurns: true } : {}),
    routingMode,
  });
  if (mode !== "short") return run(mode);
  return run("short").then((leg) => {
    if (leg?.routingMode === "fast") state.notice = "Short mode did not load. Showing the fast road.";
    return leg;
  }).catch(() => {
    state.notice = "Short mode did not load. Showing the fast road.";
    return run("fast");
  });
}

function writeRoutedLeg(stop, leg) {
  stop.miles = String(Math.round(leg.miles * 10) / 10);
  stop.hours = String(Math.round(leg.hours * 100) / 100);
  stop.path = Array.isArray(leg.points) ? leg.points : [];
  stop.directions = Array.isArray(leg.directions) ? leg.directions : [];
  if (leg.credits != null) state.credits = leg.credits;
}

function prepareRouteMapBox() {
  const stage = document.getElementById("routeStage");
  const el = document.getElementById("routeMap");
  if (!el) return;
  if (routeFull && stage) {
    stage.classList.add("is-full");
    document.documentElement.classList.add("route-full");
    document.body.classList.add("route-full");
    fitRouteCover();
  }
  void el.offsetHeight;
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
  return thinRoute(coords, 800, 1800);
}

function truckNoteText(hit) {
  const place = [hit.city, hit.state].filter(Boolean).join(", ");
  const ahead = Number.isFinite(Number(hit.milesAhead)) ? `${formatMiles(hit.milesAhead)} ahead` : "";
  const off = Number.isFinite(Number(hit.milesOff)) ? `${formatMiles(hit.milesOff)} off the route` : "";
  return [hit.name, place, ahead, off].filter(Boolean).join(" · ");
}

function clearTruckPins() {
  for (const marker of truckMarkers) marker.remove();
  truckMarkers = [];
  truckMarker = null;
}

function pinDetailLines(hit, index, many) {
  const place = [hit.city, hit.state].filter(Boolean).join(", ");
  const ahead = Number.isFinite(Number(hit.milesAhead)) ? `${formatMiles(hit.milesAhead)} ahead` : "";
  const off = Number.isFinite(Number(hit.milesOff)) ? `${formatMiles(hit.milesOff)} off the route` : "";
  const title = `${many ? `${index + 1}. ` : ""}${hit.name || "Place"}`;
  return [title, place, ahead, off].filter(Boolean);
}

function paintTruckPins() {
  const maplibre = window.maplibregl;
  clearTruckPins();
  if (!routeMap || !maplibre) return;
  const many = truckHits.length > 1;
  truckHits.forEach((hit, index) => {
    const lat = Number(hit.lat);
    const lon = Number(hit.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    const chosen = hit === truckHit;
    const wrap = document.createElement("span");
    wrap.className = `truck-pin-wrap is-pick${chosen ? " is-chosen" : ""}`;
    wrap.style.zIndex = chosen ? "4" : "1";
    const label = document.createElement("span");
    label.className = "truck-pin-label";
    for (const text of pinDetailLines(hit, index, many)) {
      const line = document.createElement("span");
      line.textContent = text;
      label.append(line);
    }
    if (chosen) {
      const add = document.createElement("button");
      add.type = "button";
      add.className = "truck-pin-add";
      add.textContent = "Add and recalculate";
      add.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        truckHit = hit;
        addTruckAndRecalculate();
      });
      label.append(add);
    }
    const pin = document.createElement("span");
    pin.className = "truck-pin";
    wrap.append(label, pin);
    wrap.addEventListener("click", (event) => {
      if (event.target.closest(".truck-pin-add")) return;
      event.preventDefault();
      event.stopPropagation();
      selectTruckHit(index);
    });
    const marker = new maplibre.Marker({ element: wrap, anchor: "bottom" }).setLngLat([lon, lat]).addTo(routeMap);
    truckMarkers.push(marker);
  });
  truckMarker = truckMarkers[0] || null;
}

function fillPlaceChoices(list, compact) {
  if (!list) return;
  list.replaceChildren();
  const show = placeListMode && truckHits.length > 0;
  list.hidden = !show;
  if (!show) return;
  truckHits.forEach((hit, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = compact ? (hit === truckHit ? "on" : "") : `flag-box${hit === truckHit ? " on" : ""}`;
    button.textContent = `${index + 1}. ${truckNoteText(hit)}`;
    button.addEventListener("click", () => selectTruckHit(index));
    list.append(button);
  });
}

function paintPlaceList() {
  const note = document.getElementById("nextTruckNote");
  const add = document.getElementById("addTruckStop");
  const many = placeListMode && truckHits.length > 0;
  if (note && many) {
    note.hidden = true;
    note.textContent = "";
  } else if (note && placeHereNote) {
    note.hidden = false;
    note.textContent = placeHereNote;
  } else if (note) {
    note.hidden = !truckHit;
    note.textContent = truckHit ? truckNoteText(truckHit) : "";
  }
  fillPlaceChoices(document.getElementById("nextPlaceList"), false);
  const routeList = document.getElementById("routePlaceList");
  if (routeList) {
    fillPlaceChoices(routeList, true);
    if (!routeFull) routeList.hidden = true;
  }
  const searchLabel = "Search here";
  const soughtHere = Boolean(placeSeek) && routeFull === placeSeekFull;
  const mapSearch = document.getElementById("routePlaceSearch");
  if (mapSearch) {
    mapSearch.hidden = !soughtHere;
    mapSearch.textContent = searchLabel;
  }
  const clear = document.getElementById("routePlaceClear");
  if (clear) clear.hidden = !(soughtHere || truckHits.length > 0);
  const pageClear = document.getElementById("clearPlaces");
  if (pageClear) pageClear.hidden = !(placeSeek || truckHits.length > 0);
  const pageSearch = document.getElementById("searchPlaces");
  if (pageSearch) {
    pageSearch.hidden = !(placeSeek && !routeFull);
    pageSearch.textContent = searchLabel;
  }
  const status = document.getElementById("routePlaceStatus");
  if (status) {
    status.hidden = !placeHereNote || !soughtHere;
    status.textContent = placeHereNote;
  }
  if (add) add.hidden = !truckHit;
}

function resumeTurnZoom() {
  if (!navOn) return;
  // User picked Follow me on purpose. Do not yank them into Turn zoom.
  if (followPinned && navFollowing && tripFit === "off") return;
  window.clearTimeout(navReturnTimer);
  navReturnTimer = 0;
  followPinned = false;
  navFollowing = false;
  navZoomHold = 0;
  tripFit = "nextTurn";
  clearTurnFrame();
  syncTripFitButton();
  if (routeMap && navFix) frameNextTurn();
}

function clearPlacePins() {
  placeSeek = "";
  placeSeekFull = false;
  placeMapMoved = false;
  placeHereNote = "";
  forgetTruckChoice();
  syncTruckAdd();
  resumeTurnZoom();
}

function selectTruckHit(index) {
  const hit = truckHits[index];
  if (!hit || state.estimating) return;
  truckHit = hit;
  paintPlaceList();
  paintTruckPins();
  syncTruckAdd();
}

function showTruckHits(hits, list) {
  truckHits = hits.slice();
  truckHit = truckHits[0] || null;
  placeListMode = list && truckHits.length > 0;
  paintPlaceList();
  paintTruckPins();
  syncTruckAdd();
}

function forgetTruckChoice() {
  truckHit = null;
  truckHits = [];
  placeListMode = false;
  clearTruckPins();
  paintPlaceList();
}

function frameTruckStop() {
  const maplibre = window.maplibregl;
  const hits = truckHits.filter((hit) => Number.isFinite(Number(hit.lat)) && Number.isFinite(Number(hit.lon)));
  if (!routeMap || !maplibre || !hits.length) return;
  navFollowing = false;
  tripFit = "off";
  window.clearTimeout(navReturnTimer);
  navReturnTimer = 0;
  syncRouteChrome();
  paintTruckPins();
  const coordinates = [];
  if (navFix) coordinates.push([navFix[1], navFix[0]]);
  for (const hit of hits) coordinates.push([Number(hit.lon), Number(hit.lat)]);
  routeMap.stop();
  if (coordinates.length === 1) {
    routeMap.flyTo({ center: coordinates[0], zoom: 14, bearing: 0, duration: 600 });
    return;
  }
  const bounds = coordinates.reduce(
    (box, coord) => box.extend(coord),
    new maplibre.LngLatBounds(coordinates[0], coordinates[0]),
  );
  const canvas = routeMap.getCanvas();
  const width = canvas?.clientWidth || 0;
  const height = canvas?.clientHeight || 0;
  // A 280px navigate map cannot take 150px of padding on both sides.
  // MapLibre then skips the move, and the pins stay off the turn view.
  const roomY = Math.max(16, Math.floor(height / 2) - 16);
  const roomX = Math.max(16, Math.floor(width / 2) - 16);
  const padY = Math.min(hits.length > 1 ? 150 : 120, roomY);
  const padX = Math.min(88, roomX);
  routeMap.fitBounds(bounds, {
    padding: { top: padY, bottom: padY, left: padX, right: padX },
    maxZoom: hits.length > 1 ? 12 : 15,
    bearing: 0,
    duration: 600,
  });
}

function syncTruckAdd() {
  for (const id of ["routeTruckAdd", "routeLovesAdd", "routeWalmartAdd", "routeCatAdd"]) {
    const add = document.getElementById(id);
    if (add) add.hidden = true;
  }
}

function addTruckAsNextStop() {
  const hit = truckHit;
  const lat = Number(hit?.lat);
  const lon = Number(hit?.lon);
  if (!hit || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
  const place = [hit.city, hit.state].filter(Boolean).join(", ");
  const label = String(hit.label || [hit.name, place].filter(Boolean).join(", "));
  const ahead = navFix ? upcomingRoutedStop(navFix[0], navFix[1]) : null;
  const aheadIndex = ahead ? state.stops.findIndex((stop) => stop.id === ahead.id) : -1;
  const chosen = chosenNavStop();
  const index = aheadIndex >= 0 ? aheadIndex : (chosen ? chosen.index : state.stops.length);
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
    const offset = clockOffset(previous.startOffset);
    next.startOffset = offset;
    next.endOffset = offset;
  }
  state.stops.splice(index, 0, next);
  const cursor = navDestList().findIndex((item) => item.stop.id === next.id);
  if (cursor >= 0) navStopCursor = cursor;
  forgetTruckChoice();
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
  paintStopButton();
  syncTruckAdd();
}

function addTruckAndRecalculate() {
  if (!truckHit || state.estimating) return;
  const hit = truckHit;
  state.estimating = true;
  truckHit = null;
  // Let the tap finish before any map rebuild. Removing the button under
  // the finger makes iOS swallow Exit and zoom until a refresh.
  window.setTimeout(() => {
    truckHits = [];
    placeListMode = false;
    clearTruckPins();
    paintPlaceList();
    void addPlaceAsNextStop(hit);
  }, 0);
}

async function addPlaceAsNextStop(hit) {
  syncTruckAdd();
  syncRouteChrome();
  const calc = document.getElementById("calculate");
  if (calc) {
    calc.disabled = true;
    calc.innerHTML = calculateButtonLabel();
  }
  const lat = Number(hit?.lat);
  const lon = Number(hit?.lon);
  if (!hit || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    state.estimating = false;
    if (calc) {
      calc.disabled = false;
      calc.innerHTML = calculateButtonLabel();
    }
    syncRouteChrome();
    return;
  }
  const here = navFix ? { lat: navFix[0], lon: navFix[1] } : await currentFix();
  if (!here) {
    state.estimating = false;
    state.error = "Allow location first, then Recalculate.";
    state.notice = "";
    render();
    return;
  }
  if (!navFix) navFix = [here.lat, here.lon];
  rebuildNavLegs();
  if (navLine.length < 2) {
    state.estimating = false;
    state.error = "Calculate the trip first.";
    render();
    return;
  }
  const toward = upcomingRoutedStop(here.lat, here.lon);
  const towardIndex = toward ? state.stops.findIndex((stop) => stop.id === toward.id) : -1;
  const towardPoint = stopPoint(toward);
  if (!toward || towardIndex < 0 || !towardPoint) {
    state.estimating = false;
    state.error = "No stop ahead to add this to.";
    render();
    return;
  }
  if (!state.unlimited && state.credits === 0) {
    state.estimating = false;
    state.error = creditEmptyMessage();
    render();
    return;
  }
  if (!state.unlimited && Number.isFinite(Number(state.credits)) && state.credits < 2) {
    state.estimating = false;
    state.error = "Not enough credits to add that stop on the route.";
    render();
    return;
  }
  const place = [hit.city, hit.state].filter(Boolean).join(", ");
  const label = String(hit.label || [hit.name, place].filter(Boolean).join(", "));
  const next = defaultStop({
    name: clipStopName(hit.name || "Truck stop").trim() || "Stop",
    address: label,
    verifiedLabel: label,
    lat,
    lon,
    anytime: true,
    window: false,
  });
  const previous = state.stops[towardIndex - 1];
  if (previous && !previous.useCurrentLocation && Number.isFinite(Number(previous.start))) {
    next.start = previous.start + 4 * 3600 * 1000;
    next.end = next.start;
    const offset = clockOffset(previous.startOffset);
    next.startOffset = offset;
    next.endOffset = offset;
  }
  const towardSnap = {
    miles: toward.miles,
    hours: toward.hours,
    path: Array.isArray(toward.path) ? toward.path.slice() : toward.path,
    directions: Array.isArray(toward.directions) ? toward.directions.slice() : toward.directions,
  };
  state.stops.splice(towardIndex, 0, next);
  const course = typeof navCompass === "number" ? navCompass : (typeof navTravel === "number" ? navTravel : here.heading);
  try {
    const into = await routeTruckLeg({ lat: here.lat, lon: here.lon }, { lat, lon }, course, { avoidUTurns: true });
    const onward = await routeTruckLeg({ lat, lon }, towardPoint, undefined, { avoidUTurns: true });
    writeRoutedLeg(next, into);
    writeRoutedLeg(toward, onward);
  } catch (error) {
    state.stops = state.stops.filter((stop) => stop.id !== next.id);
    toward.miles = towardSnap.miles;
    toward.hours = towardSnap.hours;
    toward.path = towardSnap.path;
    toward.directions = towardSnap.directions;
    if (error.credits != null) state.credits = error.credits;
    state.estimating = false;
    state.error = error.message || "Could not get a HERE© truck route.";
    state.notice = "";
    render();
    return;
  }
  const cursor = navDestList().findIndex((item) => item.stop.id === next.id);
  if (cursor >= 0) navStopCursor = cursor;
  clearDriveProgress();
  state.estimating = false;
  state.notice = `Added ${navStopTitle(next)} as the next stop.`;
  if (navOn) {
    window.clearTimeout(navReturnTimer);
    navReturnTimer = 0;
    navFollowing = false;
    navZoomHold = 0;
    tripFit = "nextTurn";
    clearTurnFrame();
  }
  await calculate({ silent: true });
}

function placeSearchButtons() {
  return ["nextTruck", "nextCat", "nextLoves", "nextWalmart", "routeTruck", "routeLoves", "routeWalmart", "routeCat"]
    .map((id) => document.getElementById(id))
    .filter(Boolean);
}

// Love's, Walmart, Cat scale, Swift terminals, and truck stops stay on this phone.
const PLACE_OFF_METERS = 8047;
let placeListsPromise = null;
let placeGrids = null;

function loadPlaceLists() {
  if (placeGrids) return Promise.resolve(placeGrids);
  if (!placeListsPromise) {
    placeListsPromise = fetch("./data/places.json?v=3")
      .then((res) => {
        if (!res.ok) throw new Error("The place list did not load.");
        return res.json();
      })
      .then((data) => {
        const grids = {};
        for (const place of ["loves", "walmart", "cat", "swift", "truck"]) {
          const grid = new Map();
          const rows = Array.isArray(data?.[place]) ? data[place] : [];
          for (const row of rows) {
            const lat = Number(row?.[0]);
            const lon = Number(row?.[1]);
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
            const key = `${Math.floor(lat)}:${Math.floor(lon)}`;
            const list = grid.get(key);
            if (list) list.push(row);
            else grid.set(key, [row]);
          }
          grids[place] = grid;
        }
        placeGrids = grids;
        return grids;
      })
      .catch((error) => {
        placeListsPromise = null;
        throw error;
      });
  }
  return placeListsPromise;
}

function nextLocalPlace(points, place, options = {}) {
  const allowEmpty = options.allowEmpty === true;
  return loadPlaceLists().then((grids) => {
    const grid = grids[place];
    if (!grid || !grid.size) throw new Error("The place list did not load.");
    const seenCells = new Set();
    const candidates = [];
    for (const pair of points) {
      const lat = Number(pair?.[0]);
      const lon = Number(pair?.[1]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const latPad = 5 / 69;
      const lonPad = 5 / (69 * Math.max(0.2, Math.cos(lat * Math.PI / 180)));
      const lat0 = Math.floor(lat - latPad);
      const lat1 = Math.floor(lat + latPad);
      const lon0 = Math.floor(lon - lonPad);
      const lon1 = Math.floor(lon + lonPad);
      for (let a = lat0; a <= lat1; a += 1) {
        for (let b = lon0; b <= lon1; b += 1) {
          const key = `${a}:${b}`;
          if (seenCells.has(key)) continue;
          seenCells.add(key);
          const bucket = grid.get(key);
          if (bucket) candidates.push(...bucket);
        }
      }
    }
    const found = [];
    for (const row of candidates) {
      const lat = Number(row[0]);
      const lon = Number(row[1]);
      const name = String(row[2] || "").trim();
      if (!name) continue;
      // A one-degree cell is wider than the corridor. Skip a store that is
      // nowhere near the line before measuring the real offset.
      const latSlack = 0.25;
      let close = false;
      for (let i = 0; i < points.length; i += 1) {
        const dlat = lat - points[i][0];
        if (Math.abs(dlat) > latSlack) continue;
        const dlon = (lon - points[i][1]) * Math.max(0.2, Math.cos(lat * Math.PI / 180));
        if (dlat * dlat + dlon * dlon <= latSlack * latSlack) {
          close = true;
          break;
        }
      }
      if (!close) continue;
      const spot = nearestOnPath(lat, lon, points);
      if (spot.dist > PLACE_OFF_METERS) continue;
      if (spot.along < 30 && spot.dist > 200) continue;
      const milesAhead = spot.along / 1609.344;
      const city = String(row[3] || "").trim();
      const stateName = String(row[4] || "").trim();
      const where = [city, stateName].filter(Boolean).join(", ");
      const stored = String(row[5] || "").trim();
      found.push({
        name,
        city,
        state: stateName,
        label: stored || [name, where].filter(Boolean).join(", "),
        lat,
        lon,
        milesAhead: Math.round(milesAhead * 10) / 10,
        milesOff: Math.round((spot.dist / 1609.344) * 10) / 10,
      });
    }
    found.sort((a, b) => a.milesAhead - b.milesAhead || a.milesOff - b.milesOff);
    const chosen = place === "swift" ? found : found.slice(0, 5);
    if (!chosen.length) {
      if (allowEmpty) return [];
      const miss = {
        loves: "No Love's within 5 miles of the route line.",
        walmart: "No Walmart within 5 miles of the route line.",
        cat: "No Cat Scale within 5 miles of the route line.",
        swift: "No Swift terminal within 5 miles of the route line.",
        truck: "No truck stop within 5 miles of the route line.",
      };
      throw new Error(miss[place] || "No place within 5 miles of the route line.");
    }
    return chosen;
  });
}

function placeWord(place) {
  if (place === "loves") return "Love's";
  if (place === "walmart") return "Walmart";
  if (place === "cat") return "Cat Scale";
  if (place === "swift") return "Swift terminal";
  return "truck stop";
}

function placeHitFromRow(row, points) {
  const lat = Number(row[0]);
  const lon = Number(row[1]);
  const name = String(row[2] || "").trim();
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const city = String(row[3] || "").trim();
  const stateName = String(row[4] || "").trim();
  const where = [city, stateName].filter(Boolean).join(", ");
  const stored = String(row[5] || "").trim();
  const hit = {
    name,
    city,
    state: stateName,
    label: stored || [name, where].filter(Boolean).join(", "),
    lat,
    lon,
    milesAhead: null,
    milesOff: null,
  };
  if (points.length >= 2) {
    const spot = nearestOnPath(lat, lon, points);
    hit.milesAhead = Math.round((spot.along / 1609.344) * 10) / 10;
    hit.milesOff = Math.round((spot.dist / 1609.344) * 10) / 10;
  }
  return hit;
}

function localPlacesInView(place, map = routeMap) {
  return loadPlaceLists().then((grids) => {
    const grid = grids[place];
    const bounds = map?.getBounds();
    const center = map?.getCenter();
    if (!grid || !bounds || !center) throw new Error("The map is not ready.");
    const south = bounds.getSouth();
    const north = bounds.getNorth();
    const west = bounds.getWest();
    const east = bounds.getEast();
    const points = routeAheadPoints();
    const found = [];
    for (let latCell = Math.floor(south); latCell <= Math.floor(north); latCell += 1) {
      for (let lonCell = Math.floor(west); lonCell <= Math.floor(east); lonCell += 1) {
        const bucket = grid.get(`${latCell}:${lonCell}`);
        if (!bucket) continue;
        for (const row of bucket) {
          const lat = Number(row?.[0]);
          const lon = Number(row?.[1]);
          if (lat < south || lat > north || lon < west || lon > east) continue;
          const hit = placeHitFromRow(row, points);
          if (!hit) continue;
          hit.milesFromCenter = metersBetween([lat, lon], [center.lat, center.lng]);
          found.push(hit);
        }
      }
    }
    found.sort((a, b) => a.milesFromCenter - b.milesFromCenter);
    if (place === "swift") return found;
    return found.slice(0, 5);
  });
}

async function searchPlacesHere() {
  if (!navOn || state.estimating || !placeSeek || !routeMap) return;
  const place = placeSeek;
  const word = placeWord(place);
  const note = document.getElementById("nextTruckNote");
  placeHereNote = "";
  paintPlaceList();
  try {
    const hits = (await localPlacesInView(place)).map((hit) => ({ ...hit, place }));
    if (!hits.length) {
      placeHereNote = `No ${word} in this part of the map.`;
      if (note) {
        note.hidden = false;
        note.textContent = placeHereNote;
      }
      paintPlaceList();
      return;
    }
    showTruckHits(hits, true);
    placeMapMoved = false;
    placeHereNote = "";
    paintPlaceList();
  } catch (error) {
    placeHereNote = error.message || `No ${word} in this part of the map.`;
    if (note) {
      note.hidden = false;
      note.textContent = placeHereNote;
    }
    paintPlaceList();
  }
}

function samePlaceSpot(a, b) {
  return Math.abs(Number(a?.lat) - Number(b?.lat)) < 0.00015
    && Math.abs(Number(a?.lon) - Number(b?.lon)) < 0.00015;
}

function mergePlaceHits(first, second) {
  const merged = [];
  for (const hit of [...first, ...second]) {
    if (!hit || merged.some((item) => samePlaceSpot(item, hit))) continue;
    merged.push(hit);
  }
  return merged;
}

async function findNextTruckStop(options = {}) {
  if (!navOn || state.estimating) return;
  const place = options.place === "loves" || options.place === "walmart" || options.place === "cat" || options.place === "swift" ? options.place : "truck";
  placeSeek = place;
  placeSeekFull = routeFull;
  placeMapMoved = false;
  placeHereNote = "";
  const word = placeWord(place);
  const buttons = placeSearchButtons();
  const add = document.getElementById("addTruckStop");
  for (const button of buttons) button.disabled = true;
  if (add) add.hidden = true;
  forgetTruckChoice();
  syncTruckAdd();
  placeHereNote = `Looking for the next ${word}…`;
  paintPlaceList();
  let framed = false;
  try {
    if (!navFix) {
      const here = await currentFix();
      if (here) navFix = [here.lat, here.lon];
    }
    const points = routeAheadPoints();
    if (points.length < 2) throw new Error("Calculate the trip first.");
    let hits;
    if (place === "swift") {
      // Same view search as the choose map, plus terminals within 5 miles of the route.
      const along = await nextLocalPlace(points, place, { allowEmpty: true });
      let viewed = [];
      try {
        viewed = await localPlacesInView(place);
      } catch (error) {
        if (!along.length) throw error;
      }
      const merged = mergePlaceHits(viewed, along);
      if (!merged.length) throw new Error(`No ${word} in this part of the map or within 5 miles of the route line.`);
      hits = merged.map((hit) => ({ ...hit, place }));
    } else {
      hits = (await nextLocalPlace(points, place)).map((hit) => ({ ...hit, place }));
      if (!hits.length) throw new Error(`No ${word} within 5 miles of the route line.`);
    }
    const calc = document.getElementById("calculate");
    if (calc) calc.innerHTML = calculateButtonLabel();
    placeHereNote = "";
    showTruckHits(hits, true);
    framed = Boolean(options.frame);
  } catch (error) {
    if (error.credits != null) state.credits = error.credits;
    const calc = document.getElementById("calculate");
    if (calc) calc.innerHTML = calculateButtonLabel();
    placeHereNote = error.message || `No ${word} within 5 miles of the route line.`;
    forgetTruckChoice();
    if (add) add.hidden = true;
    syncTruckAdd();
  } finally {
    syncRouteChrome();
  }
  if (framed) frameTruckStop();
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
  routeMap.fitBounds(bounds, { padding: tripViewPadding(), maxZoom: 14, bearing: 0, duration: 600 });
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
  const el = typeof navYou?.getElement === "function" ? navYou.getElement() : null;
  // Only rebuild when the marker is actually gone from the page.
  if (!navYou || !el || !el.isConnected) {
    try { navYou?.remove(); } catch {}
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
  if (navAim && routeMapReady) {
    if (!navYou) placeNavDot(navAim.fromLat, navAim.fromLon);
    if (navYou) {
      const u = Math.min(1, (now - navAim.start) / navAim.dur);
      const lat = navAim.fromLat + (navAim.lat - navAim.fromLat) * u;
      const lon = navAim.fromLon + (navAim.lon - navAim.fromLon) * u;
      navYou.setLngLat([lon, lat]);
      navShown = { lat, lon };
    }
  }
  if (!navMapTouch && navFollowing && tripFit !== "nextTurn" && routeMap && routeMapReady && navShown && Date.now() >= navZoomHold) {
    const camera = { center: [navShown.lon, navShown.lat], zoom: navZoom };
    const bearing = followBearing();
    if (bearing != null) camera.bearing = bearing;
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
  // Always keep the blue circle on the map when GPS updates.
  if (!navYou) placeNavDot(lat, lon);
  else aimNavDot(lat, lon);
  startNavMotion();
  let travel = null;
  if (navFix && metersBetween(navFix, [lat, lon]) > 8) travel = navBearing(navFix, [lat, lon]);
  if (travel != null) navTravel = travel;
  navFix = [lat, lon];
  // Place search turns Turn zoom off. If the pins are gone and the map is
  // not following, Turn zoom had been left off.
  if (tripFit === "off" && !navFollowing && !navMapTouch && !placeSeek && !truckHits.length && Date.now() >= navZoomHold) {
    resumeTurnZoom();
  }
  paintCompassRose();
  if (routeMap && !styleIsBasemap(routeMap)) queueBasemap();
  refreshPlace(lat, lon);
  rebuildNavLegs();
  paintRouteLines();
  noteArrivedStops(lat, lon);
  if (navLine.length < 2) {
    paintDrive(null);
    setStopChip(-1, "");
    paintSwitchOffer(null);
    sayNav("No road line yet", "Calculate the trip, then start navigation again.", "");
  } else {
    const hit = navNearest(lat, lon, navLine);
    paintDrive(hit.along);
    const off = hit.dist > 250;
    const raw = navLegs.find((item) => hit.along >= item.start && hit.along <= item.end) || navLegs[navLegs.length - 1];
    const leg = activeNavLeg(hit);
    const gap = leg ? Math.max(0, leg.start - hit.along) : 0;
    const alongInLeg = leg ? Math.max(0, hit.along - leg.start) : 0;
    const found = leg && (!off || raw?.stop?.done) ? navStep(leg, alongInLeg) : null;
    const step = found?.step || null;
    const leftOnLeg = leg ? Math.max(0, leg.end - hit.along) : 0;
    const leftOnTrip = Math.max(0, polylineMeters(navLine) - hit.along);
    const towardStop = leg?.stop;
    const toward = towardStop ? navStopTitle(towardStop) : "the stop";
    const towardPhrase = leftOnLeg < 1 ? `At ${toward}` : `${navMiles(leftOnLeg)} to ${toward}`;
    const until = leg ? leg.end : Infinity;
    paintSwitchOffer(hit);
    if (!leg) {
      setStopChip(-1, "");
      sayNav("You're at the last stop.", "", "");
      paintNavLine(hit.along, hit.along);
      clearStopNote(true);
    } else if (towardStop?.skipRoute) {
      setStopChip(-1, "");
      sayNav(`Head back to ${toward}`, "Recalculate to turn around.", "");
      paintNavLine(hit.along, Infinity);
    } else if (off && !raw?.stop?.done) {
      setStopChip(-1, "");
      sayNav("Not on the route yet", `${navMiles(hit.dist)} from the line`, `${navMiles(leftOnTrip)} left in the trip`);
      paintNavLine(0, until);
      clearStopNote(true);
    } else {
      const leftInStep = (found && leg ? metersLeftInStep(leg, alongInLeg, found.index) : 0) + gap;
      const title = String(step?.text || "").trim();
      const nextTitle = found && leg ? approachPhrase(upcomingDirection(leg, found.index), leftInStep) : "";
      setStopChip(leftOnLeg, toward);
      sayNav(nextTitle || (title ? directionWithMilesLeft(title, leftInStep) : `Continue to ${toward}`), towardPhrase, `${navMiles(leftOnTrip)} left in the trip`);
      paintNavLine(hit.along, until);
      if (found && leg?.stop?.id) {
        markDirection(leg.stop.id, found.index);
        paintDirectionMiles(hit.along, { stopId: leg.stop.id, index: found.index });
        openDirectionsNear(leg.stop.id, found.index, leftInStep);
      }
      clearStopNote(true);
      speakNavProgress(leg, found, hit.along);
    }
  }
  if (tripFit === "nextTurn") {
    if (Date.now() < navZoomHold) return;
    frameNextTurn();
    return;
  }
  if (tripFit === "nextStop") {
    if (Date.now() < navZoomHold) return;
    frameNextStop();
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
  if (northLock) {
    compassAim = false;
    return;
  }
  if (tripFit === "nextTurn" || tripFit === "nextStop" || tripFit === "full" || tripFit === "remaining" || (navFollowing && navFix && !navMapTouch)) {
    compassAim = false;
  } else if (compassAim && routeMap) {
    compassAim = false;
    routeMap.easeTo({ bearing: heading, duration: 350 });
  }
  if (!navOn || !routeMap || !navFix) return;
  if (Date.now() < navZoomHold) return;
  const now = Date.now();
  if (now - navCompassTimer < 120) return;
  navCompassTimer = now;
  if (tripFit === "nextTurn") {
    let delta = Math.abs(navCompass - routeMap.getBearing()) % 360;
    if (delta > 180) delta = 360 - delta;
    if (delta < 12) return;
    frameNextTurn();
  }
}

function followBearing() {
  if (northLock) return 0;
  if (navCompass != null) return navCompass;
  if (navTravel != null) return navTravel;
  return null;
}

function routeHeading() {
  const here = navFix;
  if (here && navLine.length >= 2) {
    const hit = navNearest(here[0], here[1], navLine);
    if (hit.dist <= 250) {
      const ahead = pointAlong(navLine, Math.min(polylineMeters(navLine), hit.along + 150));
      if (ahead && metersBetween(here, [ahead.lat, ahead.lon]) > 20) {
        const bearing = navBearing(here, [ahead.lat, ahead.lon]);
        if (Number.isFinite(bearing)) return bearing;
      }
    }
  }
  if (navTravel != null) return navTravel;
  if (navCompass != null) return navCompass;
  return null;
}

function paintCompassRose() {
  const button = document.getElementById("routeCompass");
  if (!button) return;
  const raw = routeMap && typeof routeMap.getBearing === "function" ? routeMap.getBearing() : 0;
  const bearing = ((raw % 360) + 360) % 360;
  const shown = String(Math.round(bearing * 10) / 10);
  const headingRaw = routeHeading();
  const heading = headingRaw == null ? bearing : ((headingRaw % 360) + 360) % 360;
  const headShown = String(Math.round(heading * 10) / 10);
  if (button.dataset.bearing !== shown || button.dataset.heading !== headShown) {
    button.dataset.bearing = shown;
    button.dataset.heading = headShown;
    button.style.setProperty("--compass", shown);
    button.style.setProperty("--heading", headShown);
  }
  button.classList.toggle("on", northLock);
  button.setAttribute("aria-pressed", northLock ? "true" : "false");
  button.setAttribute("aria-label", northLock ? "Unlock heading-up" : "Lock map to true north");
}

function applyNorthLockCamera() {
  if (!routeMap) return;
  if (tripFit === "full" || tripFit === "remaining" || tripFit === "nextStop") return;
  if (tripFit === "nextTurn" && navOn && navFix) {
    clearTurnFrame();
    frameNextTurn();
    return;
  }
  const bearing = northLock ? 0 : (navCompass != null ? navCompass : (navTravel != null ? navTravel : 0));
  routeMap.stop();
  if (navFollowing && navFix && !navMapTouch) {
    routeMap.jumpTo({ center: [navFix[1], navFix[0]], zoom: routeMap.getZoom(), bearing });
    return;
  }
  routeMap.easeTo({ bearing, duration: 350 });
}

async function toggleNorthLock() {
  northLock = !northLock;
  compassAim = !northLock && navCompass == null && tripFit !== "full" && tripFit !== "remaining" && tripFit !== "nextStop";
  paintCompassRose();
  await enableNavCompass();
  applyNorthLockCamera();
  paintCompassRose();
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
  navReturnTimer = 0;
  navZoomHold = Date.now() + 12000;
}

function endRouteNav() {
  navOn = false;
  followPinned = false;
  navAimStopId = "";
  clearDirectionPin();
  railMenu = "";
  northLock = false;
  compassAim = false;
  navAlongLock = null;
  navLineKey = "";
  navStopPicked = false;
  navGuideFromId = "";
  navStopAnnounce = false;
  navStopAwaitNear = false;
  navStopSpeakKey = "";
  clearStopNote(true);
  directionsAutoKey = "";
  setStopChip(-1, "");
  switchSpokenFor = "";
  pendingAimId = "";
  const switchRow = document.getElementById("routeSwitchRow");
  if (switchRow) switchRow.hidden = true;
  stopNavMotion();
  resetNavVoice();
  stopMixNavVoice();
  navFollowing = false;
  followPinned = false;
  tripFit = "full";
  clearTurnFrame();
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
  syncTripFitButton();
  if (routeMap) {
    routeMap.easeTo({ bearing: 0, duration: 400 });
    showWholeTrip();
  }
  window.clearTimeout(dirBrowseTimer);
  dirBrowseTimer = 0;
  document.getElementById("routeDirections")?.classList.remove("dir-browse");
  syncRouteChrome();
  focusDirectionWindow(null, null);
  document.querySelectorAll("[data-dir-stop]").forEach((button) => {
    const stopId = button.getAttribute("data-dir-stop");
    const index = Number(button.getAttribute("data-dir-index"));
    const link = button.querySelector(".dir-link");
    if (link) link.textContent = shownDirection(directionStep(stopId, index), { text: nextManeuverText(stopId, index) });
  });
}

let dirBrowseTimer = 0;
let dirBrowseLock = false;

function armDirectionBrowse() {
  if (!navOn || dirBrowseLock) return;
  const box = document.getElementById("routeDirections");
  const scrolling = box?.querySelector(".dir-scroll");
  if (!box || !scrolling) return;
  const open = box.classList.contains("dir-browse");
  if (!open) {
    const button = scrolling.querySelector(".dir-step.on");
    const before = button ? button.getBoundingClientRect().top : null;
    box.classList.add("dir-browse");
    scrolling.querySelectorAll("li.dir-far").forEach((li) => li.classList.remove("dir-far"));
    if (button && before != null) {
      const after = button.getBoundingClientRect().top;
      dirBrowseLock = true;
      scrolling.scrollTop += after - before;
      dirBrowseLock = false;
    }
  }
  window.clearTimeout(dirBrowseTimer);
  dirBrowseTimer = window.setTimeout(snapDirectionBrowse, 5000);
}

function snapDirectionBrowse() {
  window.clearTimeout(dirBrowseTimer);
  dirBrowseTimer = 0;
  const box = document.getElementById("routeDirections");
  const scrolling = box?.querySelector(".dir-scroll");
  if (!box) return;
  dirBrowseLock = true;
  box.classList.remove("dir-browse");
  const button = scrolling?.querySelector(".dir-step.on");
  if (button && navOn) {
    focusDirectionWindow(button.getAttribute("data-dir-stop"), Number(button.getAttribute("data-dir-index")));
    revealDirection(button);
  } else focusDirectionWindow(null, null);
  dirBrowseLock = false;
}

function bindDirectionBrowse() {
  const box = document.getElementById("routeDirections");
  const scrolling = box?.querySelector(".dir-scroll");
  if (!box || !scrolling || box.dataset.browseBound === "1") return;
  box.dataset.browseBound = "1";
  let touchY = null;
  box.addEventListener("touchstart", (event) => {
    touchY = event.touches?.[0]?.clientY ?? null;
  }, { passive: true });
  box.addEventListener("wheel", (event) => {
    if (!navOn) return;
    if (!box.classList.contains("dir-browse")) event.preventDefault();
    armDirectionBrowse();
    event.stopPropagation();
  }, { passive: false });
  box.addEventListener("touchmove", (event) => {
    if (!navOn) return;
    const y = event.touches?.[0]?.clientY;
    if (touchY != null && y != null && Math.abs(y - touchY) < 8) return;
    armDirectionBrowse();
    event.stopPropagation();
  }, { passive: true });
  scrolling.addEventListener("scroll", () => {
    if (dirBrowseLock || !navOn || !box.classList.contains("dir-browse")) return;
    armDirectionBrowse();
  }, { passive: true });
}

function focusDirectionWindow(stopId, index) {
  const scrolling = document.querySelector("#routeDirections .dir-scroll");
  const box = document.getElementById("routeDirections");
  if (!scrolling) return;
  if (dirPinned) {
    box?.classList.remove("dir-three");
    scrolling.querySelectorAll("li.dir-far").forEach((li) => li.classList.remove("dir-far"));
    return;
  }
  const browsing = Boolean(box?.classList.contains("dir-browse"));
  const hide = navOn && Number.isFinite(index) && !browsing;
  box?.classList.toggle("dir-three", Boolean(navOn && Number.isFinite(index)));
  if (browsing) {
    scrolling.querySelectorAll("li.dir-far").forEach((li) => li.classList.remove("dir-far"));
    return;
  }
  const steps = [...scrolling.querySelectorAll("[data-dir-stop]")].filter((button) => {
    const stop = state.stops.find((item) => item.id === button.getAttribute("data-dir-stop"));
    return stop && !stop.done && !stop.skipRoute;
  });
  const current = steps.findIndex((button) => (
    button.getAttribute("data-dir-stop") === stopId
    && Number(button.getAttribute("data-dir-index")) === index
  ));
  const shown = new Set(directionWindow(current >= 0 ? current : 0, steps.length).map((at) => steps[at]));
  scrolling.querySelectorAll("li").forEach((li) => {
    const button = li.querySelector("[data-dir-stop]");
    if (!hide) {
      li.classList.remove("dir-far");
      return;
    }
    if (!button) {
      li.classList.add("dir-far");
      return;
    }
    const rowStop = state.stops.find((item) => item.id === button.getAttribute("data-dir-stop"));
    if (rowStop?.done || rowStop?.skipRoute) {
      li.classList.add("dir-far");
      return;
    }
    li.classList.toggle("dir-far", !shown.has(button));
  });
}

let undoClearTimer = 0;

function isTypedField(el) {
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return false;
  if (el.disabled || el.readOnly || el.dataset.undoFreeze === "1") return false;
  const type = (el.type || "text").toLowerCase();
  // Native pickers / steppers keep their own UI — do not rewrite those.
  if (
    type === "checkbox" || type === "radio" || type === "range" || type === "file"
    || type === "button" || type === "submit" || type === "reset" || type === "hidden"
    || type === "datetime-local" || type === "date" || type === "time" || type === "month"
    || type === "week" || type === "color" || type === "number"
  ) {
    return false;
  }
  return true;
}

function fieldMaxLength(el) {
  const max = Number(el.maxLength);
  return Number.isFinite(max) && max >= 0 && max < 1000000 ? max : null;
}

function writeTypedValue(el, value, caret) {
  const max = fieldMaxLength(el);
  let next = String(value ?? "");
  let pos = Math.max(0, caret ?? next.length);
  if (max != null && next.length > max) {
    next = next.slice(0, max);
    pos = Math.min(pos, max);
  }
  el.value = next;
  try { el.setSelectionRange(pos, pos); } catch (_) {}
  el.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true }));
}

function applyTypedInsert(el, text) {
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? start;
  const piece = String(text ?? "");
  writeTypedValue(el, el.value.slice(0, start) + piece + el.value.slice(end), start + piece.length);
}

function applyTypedDelete(el, forward) {
  let start = el.selectionStart ?? 0;
  let end = el.selectionEnd ?? start;
  if (start === end) {
    if (forward) end = Math.min(el.value.length, end + 1);
    else start = Math.max(0, start - 1);
  }
  writeTypedValue(el, el.value.slice(0, start) + el.value.slice(end), start);
}

// iPhone only builds shake-to-undo history from real keyboard edits.
// Block those, write .value ourselves, and shake has nothing to undo.
function handleTypedBeforeInput(event) {
  const type = event.inputType || "";
  if (type === "historyUndo" || type === "historyRedo") {
    event.preventDefault();
    return;
  }
  const el = event.target;
  if (!isTypedField(el)) return;
  if (type === "insertText" || type === "insertReplacementText" || type === "insertCompositionText" || type === "insertFromComposition") {
    event.preventDefault();
    applyTypedInsert(el, event.data ?? "");
    return;
  }
  if (type === "insertFromPaste" || type === "insertFromDrop" || type === "insertFromYank") {
    event.preventDefault();
    const pasted = event.dataTransfer?.getData("text/plain") || event.data || "";
    applyTypedInsert(el, pasted);
    return;
  }
  if (type === "insertLineBreak" || type === "insertParagraph") {
    event.preventDefault();
    applyTypedInsert(el, "\n");
    return;
  }
  if (
    type === "deleteContent" || type === "deleteContentBackward" || type === "deleteByCut"
    || type === "deleteSoftLineBackward" || type === "deleteHardLineBackward"
    || type === "deleteWordBackward"
  ) {
    event.preventDefault();
    applyTypedDelete(el, false);
    return;
  }
  if (
    type === "deleteContentForward" || type === "deleteByDrag"
    || type === "deleteSoftLineForward" || type === "deleteHardLineForward"
    || type === "deleteWordForward"
  ) {
    event.preventDefault();
    applyTypedDelete(el, true);
  }
}

function scheduleTypingUndoClear() {
  clearTypingUndo();
  window.clearTimeout(undoClearTimer);
  undoClearTimer = window.setTimeout(clearTypingUndo, 400);
}

function clearTypingUndo() {
  const active = document.activeElement;
  if (active && active !== document.body && active.blur) active.blur();
  window.getSelection()?.removeAllRanges();
  document.querySelectorAll("input, textarea").forEach((el) => {
    if (!isTypedField(el) && !(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return;
    if (!el.isConnected) return;
    const clone = el.cloneNode(true);
    if ("value" in el) clone.value = el.value;
    if ("checked" in el) clone.checked = el.checked;
    clone.disabled = el.disabled;
    clone.readOnly = el.readOnly;
    el.replaceWith(clone);
  });
  document.querySelectorAll("textarea[data-field=address], textarea[data-field=name]").forEach(fitAddressField);
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
  if (freeze) scheduleTypingUndoClear();
}

document.addEventListener("beforeinput", handleTypedBeforeInput, true);

function routeProgressKey(line) {
  const mid = line[Math.floor(line.length / 2)] || [];
  return `${line.length}:${Math.round(polylineMeters(line))}:${line[0]?.join(",")}:${mid.join(",")}:${line[line.length - 1]?.join(",")}`;
}

let navPulseAt = 0;

function keepNavSignedIn() {
  if (!navOn || !state.signedIn) return Promise.resolve();
  const now = Date.now();
  if (now - navPulseAt < 5 * 60 * 1000) return Promise.resolve();
  navPulseAt = now;
  return pulseActivity();
}

async function beginRouteNav() {
  navOn = true;
  navPulseAt = 0;
  void keepNavSignedIn();
  navAlongLock = null;
  navLineKey = routeProgressKey(routePoints());
  followPinned = false;
  navFollowing = false;
  tripFit = "nextTurn";
  clearTurnFrame();
  turnOpenAlong = null;
  turnBehind = null;
  navZoom = 15;
  freezeTyping(true);
  syncRouteChrome();
  document.getElementById("routeStage")?.scrollIntoView({ block: "nearest" });
  placeText = "";
  placeAt = null;
  paintPlace("");
  sayNav("Finding you…", "Allow location to move along this trip.", "");
  startNavWatch();
  if (navFix) onNavFix(navFix[0], navFix[1]);
  // Motion permission is only asked here — not again in the Start click handler.
  await enableNavCompass();
  startNavMotion();
}

function startNavWatch() {
  if (!navigator.geolocation) {
    sayNav("Allow location", "Planigator needs location to show you on this trip.", "");
    return;
  }
  if (navWatch != null) return;
  navWatch = navigator.geolocation.watchPosition(
    (pos) => {
      if (!navOn) return;
      onNavFix(pos.coords.latitude, pos.coords.longitude, pos.coords.altitude);
    },
    (err) => {
      if (!navOn) return;
      // Timeout / temporary GPS gaps should not strip the blue dot. Only a
      // real permission denial needs the allow-location message.
      if (err && err.code === 1) {
        sayNav("Allow location", "Planigator needs location to show you on this trip.", "");
      }
    },
    // No timeout on watch — a timeout fires errors while the bike is moving
    // under trees / between buildings and can stall updates.
    { enableHighAccuracy: true, maximumAge: 1000 },
  );
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
  const turnBearing = northLock ? 0 : (navCompass != null ? navCompass : map.getBearing());
  if (span < 30) {
    map.easeTo({
      center: [focus.lon, focus.lat],
      zoom: 16,
      bearing: turnBearing,
      duration: reduce ? 0 : 800,
    });
  } else {
    map.fitBounds(bounds, {
      padding: paddingForTurnZoom({ top: 64, right: 64, bottom: 64, left: 64 }, 0).padding,
      maxZoom: 16,
      bearing: turnBearing,
      animate: !reduce,
      duration: reduce ? 0 : 800,
    });
  }
  pendingTurn = null;
}

function bindDirectionSteps(root) {
  (root || document).querySelectorAll("[data-dir-stop]").forEach((button) => {
    if (button.dataset.dirBound === "1") return;
    button.dataset.dirBound = "1";
    button.addEventListener("click", () => {
      const stopId = button.getAttribute("data-dir-stop");
      const index = Number(button.getAttribute("data-dir-index"));
      pinDirection(stopId, index);
      pauseFollowForDirection();
      zoomToDirection(stopId, index);
    });
  });
}

function refillDirections() {
  const html = directionsBlock();
  document.querySelectorAll("#routeDirections").forEach((node) => node.remove());
  if (!html) return;
  const host = document.createElement("template");
  host.innerHTML = html.trim();
  const next = host.content.firstElementChild;
  if (!next) return;
  const miles = document.getElementById("routeStopMiles");
  const home = document.getElementById("routeDirectionsHome");
  if (routeFull && miles) miles.after(next);
  else if (home) home.after(next);
  else miles?.after(next);
  const go = document.getElementById("navGo");
  if (go && next && !routeFull) next.after(go);
  bindDirectionSteps(next);
  bindDirectionBrowse();
}

function refreshAfterStopRemoved() {
  rebuildNavLegs();
  navLineKey = routeProgressKey(routePoints());
  const coordinates = routePoints().map(([lat, lon]) => [lon, lat]);
  const source = routeMap?.getSource("route");
  if (source && coordinates.length >= 2) {
    source.setData({
      type: "Feature",
      geometry: { type: "LineString", coordinates },
    });
  }
  if (routeMapReady) addRoutePins();
  clearTurnFrame();
  refillDirections();
  if (navOn && navFix && routeMap) onNavFix(navFix[0], navFix[1]);
  syncRouteChrome();
}

function paintLiveRoute() {
  const line = routePoints();
  const key = routeProgressKey(line);
  if (key !== navLineKey) {
    navLineKey = key;
    navAlongLock = null;
  }
  const coordinates = line.map(([lat, lon]) => [lon, lat]);
  const source = routeMap?.getSource("route");
  if (source && coordinates.length >= 2) {
    source.setData({
      type: "Feature",
      geometry: { type: "LineString", coordinates },
    });
  }
  if (routeMapReady) addRoutePins();
  clearTurnFrame();
  rebuildNavLegs();
  refillDirections();
  spokenStepKey = "";
  spokenMiles.clear();
  paintLiveDirections();
  const box = document.getElementById("routeDirections");
  if (navOn && box && !box.classList.contains("dir-three")) {
    const button = box.querySelector("[data-dir-stop]");
    if (button) focusDirectionWindow(button.getAttribute("data-dir-stop"), Number(button.getAttribute("data-dir-index")));
  }
  if (navOn && navFix && routeMap) {
    placeNavDot(navFix[0], navFix[1]);
    onNavFix(navFix[0], navFix[1]);
  }
}

function paintLiveDirections() {
  if (!navOn || !navFix) return;
  rebuildNavLegs();
  if (navLine.length < 2 || !navLegs.length) return;
  const hit = navNearest(navFix[0], navFix[1], navLine);
  const leg = activeNavLeg(hit);
  if (!leg?.stop?.id || leg.stop.skipRoute) return;
  const gap = Math.max(0, leg.start - hit.along);
  const alongInLeg = Math.max(0, hit.along - leg.start);
  const found = navStep(leg, alongInLeg);
  if (!found?.step) return;
  const leftInStep = metersLeftInStep(leg, alongInLeg, found.index) + gap;
  markDirection(leg.stop.id, found.index);
  paintDirectionMiles(hit.along, { stopId: leg.stop.id, index: found.index });
  const leftOnLeg = Math.max(0, leg.end - hit.along);
  setStopChip(leftOnLeg, navStopTitle(leg.stop));
  paintSwitchOffer(hit);
}

function clearDirectionPin() {
  dirPinned = null;
  window.clearTimeout(dirPinTimer);
  dirPinTimer = 0;
}

function pinDirection(stopId, index) {
  dirPinned = { stopId, index: Number(index) };
  window.clearTimeout(dirPinTimer);
  dirPinTimer = window.setTimeout(() => {
    dirPinned = null;
    dirPinTimer = 0;
  }, 12000);
  navZoomHold = Date.now() + 12000;
  window.clearTimeout(navReturnTimer);
  navReturnTimer = 0;
}

function markDirection(stopId, index, fromUser = false) {
  if (dirPinned && !fromUser) {
    stopId = dirPinned.stopId;
    index = dirPinned.index;
  }
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
  if (dirPinned && !fromUser) return button;
  focusDirectionWindow(stopId, index);
  revealDirection(button);
  return button;
}

function revealDirection(button) {
  const list = button?.closest(".dir-scroll");
  if (!list || list.closest(".dir-browse")) return;
  if (list.closest(".dir-three")) {
    list.scrollTop = 0;
    return;
  }
  const listBox = list.getBoundingClientRect();
  const buttonBox = button.getBoundingClientRect();
  const delta = (buttonBox.top + buttonBox.height / 2) - (listBox.top + listBox.height / 2);
  list.scrollTop += delta;
}

function zoomToDirection(stopId, index) {
  const stop = state.stops.find((item) => item.id === stopId);
  const focus = directionFocus(stop, Number(index));
  if (!focus) return;
  markDirection(stopId, index, true);
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
  // Full screen used to build the map at the 280px box, then add .is-full.
  // The canvas stayed short and the empty map area ate Exit and zoom.
  prepareRouteMapBox();
  const map = new maplibre.Map({
    container: el,
    style: routeStyle(),
    attributionControl: false,
    renderWorldCopies: false,
    fadeDuration: 0,
  });
  routeMap = map;
  map.on("rotate", paintCompassRose);
  map.addControl(new maplibre.AttributionControl({ compact: false }), "bottom-right");
  // Keep the rail on the stage, above the directions box. Inside the map,
  // a tall directions list can sit on top of Exit and zoom.
  const stage = el.closest(".route-stage") || el;
  el.querySelectorAll(".route-rail").forEach((node) => stage.appendChild(node));
  map.on("load", () => {
    if (routeMap !== map) return;
    map.resize();
    const coordinates = line.map(([lat, lon]) => [lon, lat]);
    map.addSource("route", {
      type: "geojson",
      data: routeFeatureCollection(),
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
      paint: { "line-color": ROUTE_LINE_COLOR, "line-width": 4 },
    });
    map.addSource("left", {
      type: "geojson",
      data: { type: "Feature", geometry: { type: "LineString", coordinates: [] } },
    });
    map.addLayer({
      id: "left",
      type: "line",
      source: "left",
      paint: { "line-color": "#9ec5ff", "line-width": 6 },
    });
    const holdCamera = () => { navMapTouch = true; };
    const releaseCamera = () => {
      navMapTouch = false;
      navFollowing = false;
      navZoomHold = Date.now() + 1500;
      const follow = document.getElementById("routeFollow");
      if (follow) follow.classList.remove("on");
    };
    el.addEventListener("touchstart", (event) => {
      if (event.target.closest("button, a, summary, .truck-pin-wrap")) return;
      holdCamera();
    }, { capture: true, passive: true });
    const liftMapTouch = () => {
      navMapTouch = false;
      if (turnZoomOut?.paused) {
        turnZoomOut.paused = false;
        turnZoomOut.started = Date.now() - (turnZoomOut.elapsed || 0);
      }
    };
    el.addEventListener("touchend", liftMapTouch, { capture: true });
    el.addEventListener("touchcancel", liftMapTouch, { capture: true });
    el.addEventListener("pointerup", liftMapTouch, { capture: true });
    el.addEventListener("pointercancel", liftMapTouch, { capture: true });
    map.on("pointerdown", (event) => {
      if (event.originalEvent?.target?.closest?.("button, a, summary, .truck-pin-wrap")) return;
      holdCamera();
    });
    map.on("dragstart", () => {
      if (turnZoomOut) {
        turnZoomOut.paused = true;
        turnZoomOut.started = Date.now() - (turnZoomOut.elapsed || 0);
      }
      releaseCamera();
      if (placeSeek && !placeMapMoved) {
        placeMapMoved = true;
        placeHereNote = "";
        paintPlaceList();
      }
    });
    map.on("zoomstart", holdUserZoom);
    map.on("zoom", holdUserZoom);
    const bounds = coordinates.reduce((box, coord) => box.extend(coord), new maplibre.LngLatBounds(coordinates[0], coordinates[0]));
    addRoutePins(bounds);
    routeMapReady = true;
    applyBasemap();
    if (navOn && navFix && tripFit !== "full") {
      onNavFix(navFix[0], navFix[1]);
      if (tripFit === "remaining") {
        const from = navLine.length >= 2 ? navNearest(navFix[0], navFix[1], navLine).along : 0;
        fitCoords(navRemaining(from, Infinity), 14);
      } else if (navFollowing && tripFit !== "nextTurn") {
        const camera = { center: [navFix[1], navFix[0]], zoom: navZoom };
        const bearing = followBearing();
        if (bearing != null) camera.bearing = bearing;
        map.jumpTo(camera);
      }
    } else if (pendingTurn) applyTurnZoom(map, pendingTurn);
    else if (tripFit === "full" || !navOn) {
      map.fitBounds(bounds, { padding: tripViewPadding(), maxZoom: 14, animate: false });
    } else map.fitBounds(bounds, { padding: routeFull ? 80 : 48, maxZoom: 8, animate: false });
    syncTripFitButton();
    paintCompassRose();
    if (truckHits.length) paintTruckPins();
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

function driveTowardName(event) {
  if (event?.timePhrase !== "Drive") return "";
  const named = (event.title || "").trim();
  if (named) return named;
  const index = state.stops.findIndex((stop) => stop.id === event.stopID);
  if (index < 0) return "";
  return cardTitle(index, state.stops);
}

function paintPlanClocks() {
  const plan = state.plan;
  const chips = document.querySelectorAll("[data-chip]");
  const sums = document.querySelectorAll("[data-plan-summary]");
  if (!plan || !chips.length || !sums.length) return false;
  const byId = new Map();
  chips.forEach((node) => {
    const id = node.getAttribute("data-chip");
    const list = byId.get(id) || [];
    list.push(node);
    byId.set(id, list);
  });
  for (const event of plan.events || []) {
    const nodes = byId.get(String(event.id));
    if (!nodes?.length) return false;
    const parts = chipParts(event);
    for (const node of nodes) {
      const mid = node.querySelector(".chip-mid");
      const delay = node.querySelector(".chip-delay");
      const when = node.querySelector(".chip-when");
      if (!when || Boolean(parts.middle) !== Boolean(mid)) return false;
      if (Boolean(parts.delayLine) !== Boolean(delay)) return false;
      if (mid) mid.textContent = parts.middle;
      if (delay) delay.textContent = parts.delayLine;
      when.textContent = parts.span;
    }
  }
  const leave = `Leave by ${formatPlanTime(plan.rollAt, zoneForStop(originStop()))}`;
  const arrive = `Arrive by ${formatPlanTime(plan.arriveAt, zoneForStop(arriveStop()))}`;
  const driving = `Driving: ${hoursLabel(plan.driveHours)} · ${formatMiles(plan.miles)}`;
  const hos = `HOS on this path: ${plan.breakCount} × 30-min · ${plan.restCount} × Off-duty/Sleeper Berth`;
  const total = `Total trip-time including 10's and 30's: ${durationLabel((plan.arriveAt - plan.rollAt) / 3600 / 1000)}.`;
  let complete = true;
  sums.forEach((box) => {
    const set = (key, text) => {
      const el = box.querySelector(`[data-sum="${key}"]`);
      if (!el) complete = false;
      else el.textContent = text;
    };
    set("leave", leave);
    set("arrive", arrive);
    set("driving", driving);
    set("hos", hos);
    set("total", total);
  });
  return complete;
}

function tickLeaveNow() {
  if (document.visibilityState === "hidden") return;
  if (!state.settings.leaveNow || !state.plan || state.estimating) return;
  const before = planShape(state.plan);
  const result = rebuiltPlan();
  if (!result || result.error) return;
  const shapeChanged = planShape(result) !== before;
  state.plan = result;
  const typing = Boolean(state.picker) || Boolean(document.activeElement?.matches?.("input, textarea, select"));
  if (!shapeChanged && paintPlanClocks()) return;
  if (routeFull || navOn || typing) {
    if (shapeChanged && (routeFull || navOn)) routePageStale = true;
    paintPlanClocks();
    return;
  }
  render();
}

function armLeaveNowClock() {
  const delay = 60000 - (Date.now() % 60000) + 250;
  window.setTimeout(() => {
    tickLeaveNow();
    window.setInterval(tickLeaveNow, 60000);
  }, delay);
}

function chipStatLine(event, hours, miles, { hoursOnly = false, milesOnly = false } = {}) {
  const restMinutes = Math.round(Number(hours) * 60);
  const hideHours = event.kind === "thirty" || (event.kind === "rest" && state.settings.endAnytime && restMinutes <= 10 * 60);
  if (event.kind === "leeway" && hours != null) return leewayDays(hours);
  const hourText = !milesOnly && hours != null && !hideHours ? hoursLabel(hours) : "";
  const mileText = !hoursOnly && miles != null && miles > 0.05 ? formatMiles(miles) : "";
  return [hourText, mileText].filter(Boolean).join(" · ");
}

function formatPlanClock(ms, timeZone) {
  const zone = shownZone(timeZone);
  const military = state.settings.military;
  const options = {
    hour: military ? "2-digit" : "numeric",
    minute: "2-digit",
    hourCycle: military ? "h23" : "h12",
  };
  if (zone) options.timeZone = zone;
  return new Intl.DateTimeFormat("en-US", options).format(new Date(ms));
}

function chipDelayLine(event) {
  const effect = event.delayEffect;
  if (!effect) return "";
  const amount = Math.max(0, Math.round(Number(effect.pieceMinutes ?? effect.minutes) || 0));
  if (amount < 1) return "";
  // Finish stop: "+ 1 hr → 5:00 PM"
  if (effect.finishDelay && effect.afterTime) {
    return `+ ${delayLabel(amount)} → ${formatPlanClock(effect.afterTime, eventZone(event))}`;
  }
  // Every drive chip: "+ 15 min delay → 6 hr 45 min · 382.9 miles"
  const after = chipStatLine(
    event,
    effect.afterHours ?? event.tripHours,
    effect.afterMiles ?? event.miles,
  );
  if (!after) return "";
  return `+ ${delayLabel(amount)} delay → ${after}`;
}

function chipParts(event) {
  const effect = event.delayEffect;
  // Drive chips keep the original time/miles on top; delay row shows after.
  const middle = effect && !effect.finishDelay && effect.beforeHours != null
    ? chipStatLine(event, effect.beforeHours, effect.beforeMiles)
    : chipStatLine(event, event.tripHours, event.miles);
  const delayLine = chipDelayLine(event);
  const span = formatPlanSpan(event.start, event.end, eventZone(event));
  const towardName = driveTowardName(event);
  const toward = towardName ? `Toward ${towardName}` : "";
  const phrase = event.kind === "rest" ? "Off-duty/Sleeper Berth" : (event.timePhrase || "");
  const label = [phrase, toward].filter(Boolean).join(" · ");
  return { label, middle, delayLine, span, finishDelay: Boolean(effect?.finishDelay) };
}

function chip(event) {
  const ink = stopInk(event.rgb);
  const { label, middle, delayLine, span, finishDelay } = chipParts(event);
  const section = (text, extra = "") => text
    ? `<div class="chip-sec${extra ? ` ${extra}` : ""}">${escapeAttr(text)}</div>`
    : "";
  // Finish stop: when first, then delay under it. Other chips keep delay above when.
  const delayThenWhen = finishDelay
    ? `${section(span, "chip-when")}${section(delayLine, "chip-delay")}`
    : `${section(delayLine, "chip-delay")}${section(span, "chip-when")}`;
  const body = `
    <div class="chip ${event.kind}" data-chip="${escapeAttr(event.id)}" style="background:${cssRGB(event.rgb)};color:${ink.color}">
      ${section(label)}
      ${section(middle, "chip-mid")}
      ${delayThenWhen}
    </div>
  `;
  const delay = driveDelayTarget(event);
  const row = delay ? `<div class="chip-row">${body}${delayBox(delay.stop, delay.pieceIndex, delay.finish)}</div>` : body;
  return `${row}${lateNote(event)}`;
}

function lateNote(event) {
  if (!event?.late) return "";
  const stop = state.stops.find((item) => item.id === event.stopID);
  if (!stop || stop.anytime) return "";
  const deadline = stop.window ? stop.end : stop.start;
  if (!deadline) return "";
  const title = (stop.name || "").trim() || event.title || "this stop";
  return `<p class="error late-note">That is after ${escapeAttr(title)}’s be-there-by (${formatPlanShort(deadline, zoneForStop(stop))}).</p>`;
}

function drivePieceIndex(event) {
  if (Number.isInteger(event.pieceIndex)) return event.pieceIndex;
  if (event.kind === "lead") {
    const match = /-(\d+)$/.exec(String(event.id || ""));
    if (match) return Number(match[1]);
  }
  if (event.kind === "stop") {
    const leads = (state.plan?.events || []).filter((item) => item.kind === "lead" && item.stopID === event.stopID);
    return leads.length;
  }
  return 0;
}

function driveDelayTarget(event) {
  if (event.kind !== "lead" && event.kind !== "stop" && event.kind !== "finish") return null;
  const stop = state.stops.find((item) => item.id === event.stopID);
  if (!stop || stop.skipRoute) return null;
  if (event.kind === "finish") return { stop, finish: true };
  return { stop, pieceIndex: drivePieceIndex(event) };
}

function driveDelayAt(stop, pieceIndex) {
  if (Array.isArray(stop.driveDelays)) return Math.max(0, Math.round(Number(stop.driveDelays[pieceIndex]) || 0));
  if (pieceIndex === 0) return Math.max(0, Math.round(Number(stop.delayMinutes) || 0));
  return 0;
}

function eventsAround(stopId) {
  const events = state.plan?.events || [];
  const self = events.find((event) => event.id === stopId);
  const mine = events.filter((event) => event.stopID === stopId && event.id !== stopId && event.kind !== "leeway");
  const leeway = events.filter((event) => event.kind === "leeway" && event.stopID === stopId && event.after !== -1);
  return {
    before: [
      ...mine.filter((event) => !self || event.start < self.start),
      ...leeway.filter((event) => self && event.start < self.start),
    ].sort((a, b) => a.start - b.start),
    self,
    following: [
      ...mine.filter((event) => self && event.start >= self.start),
      ...leeway.filter((event) => !self || event.start >= self.start),
    ].sort((a, b) => a.start - b.start),
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

function delayLabel(minutes) {
  const mins = Math.max(0, Math.round(Number(minutes) || 0));
  const hours = Math.trunc(mins / 60);
  const remain = mins % 60;
  if (hours <= 0) return `${remain} min`;
  if (remain === 0) return hours === 1 ? "1 hr" : `${hours} hr`;
  return `${hours} hr ${remain} min`;
}

function delayBox(stop, pieceIndex, finish = false) {
  const minutes = finish
    ? Math.max(0, Math.round(Number(stop.finishDelayMinutes) || 0))
    : driveDelayAt(stop, pieceIndex);
  const finishAttr = finish ? ` data-delay-finish="1"` : "";
  return `
    <div class="delay-slot">
      <div class="delay-box">
        <span class="delay-name">Possible delay time</span>
        <span class="delay-controls">
          <button type="button" data-delay="${stop.id}"${finishAttr} data-delay-piece="${pieceIndex || 0}" data-delay-by="-15" ${minutes <= 0 ? "disabled" : ""} aria-label="Less possible delay time">−</button>
          <span class="delay-read">${delayLabel(minutes)}</span>
          <button type="button" data-delay="${stop.id}"${finishAttr} data-delay-piece="${pieceIndex || 0}" data-delay-by="15" ${minutes >= 24 * 60 ? "disabled" : ""} aria-label="More possible delay time">+</button>
        </span>
      </div>
    </div>
  `;
}

function changeDelay(id, pieceIndex, delta, finish = false) {
  if (state.estimating) return;
  const stop = state.stops.find((item) => item.id === id);
  if (!stop) return;
  // iPhone Safari zooms when a control under the finger is replaced mid-tap.
  // Blur and keep the scroll put so a fast stepper mash does not jump/zoom.
  const active = document.activeElement;
  if (active && active !== document.body && active.blur) active.blur();
  const scrollX = window.scrollX || window.pageXOffset || 0;
  const scrollY = window.scrollY || window.pageYOffset || 0;
  const restoreScroll = () => {
    window.scrollTo(scrollX, scrollY);
    requestAnimationFrame(() => window.scrollTo(scrollX, scrollY));
  };
  if (finish) {
    const current = Math.max(0, Math.round(Number(stop.finishDelayMinutes) || 0));
    const next = Math.max(0, Math.min(24 * 60, current + delta));
    if (next === current) return;
    stop.finishDelayMinutes = next;
    persist();
    if (state.plan) calculate({ silent: true }).finally(restoreScroll);
    else {
      render();
      restoreScroll();
    }
    return;
  }
  const piece = Math.max(0, Number(pieceIndex) || 0);
  if (!Array.isArray(stop.driveDelays)) {
    stop.driveDelays = [];
    const legacy = Math.max(0, Math.round(Number(stop.delayMinutes) || 0));
    if (legacy) stop.driveDelays[0] = legacy;
  }
  const current = Math.max(0, Math.round(Number(stop.driveDelays[piece]) || 0));
  const next = Math.max(0, Math.min(24 * 60, current + delta));
  if (next === current) return;
  stop.driveDelays[piece] = next;
  stop.delayMinutes = stop.driveDelays.reduce((sum, value) => sum + Math.max(0, Math.round(Number(value) || 0)), 0);
  persist();
  if (state.plan) calculate({ silent: true }).finally(restoreScroll);
  else {
    render();
    restoreScroll();
  }
}

function stopCard(stop, index, showPlan = true) {
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
  const locked = stop.done && !originStop;
  const firstLive = !locked && state.stops.findIndex((item, at) => (
    !isOriginStop(state.stops, at) && !item.done && !item.skipRoute
  )) === index;
  const firstAddress = state.stops.findIndex((item) => !item.useCurrentLocation) === index;
  const beforeButton = firstAddress
    ? `<button type="button" class="flag-box" data-before="${stop.id}">Add a stop before ${escapeAttr(title)}</button>`
    : "";
  const planBits = !showPlan
    ? ""
    : locked
      ? donePlanChip(stop, index)
      : `${firstLive ? around.now.map(chip).join("") : ""}
    ${around.before.map(chip).join("")}
    ${around.self ? chip(around.self) : ""}
    ${around.following.map(chip).join("")}`;
  return `
    ${beforeButton}
    <article class="stop-card${locked ? " is-done" : ""}" style="background:${cssRGB(rgb)};color:${ink.color}" data-stop="${stop.id}"${locked ? ` aria-label="${escapeAttr(title)} done"` : ""}>
      <div class="stop-head">
        <label${locked ? " inert" : ""}>
          <span class="sr">Stop name</span>
          <textarea class="plain" data-field="name" rows="1" maxlength="8" placeholder="${escapeAttr(title)}" aria-label="Stop name" autocomplete="off" autocorrect="off" autocapitalize="characters" spellcheck="false">${escapeAttr(stop.name)}</textarea>
        </label>
        <div class="icon-row">
          <button type="button" class="ghost" data-act="up" ${originStop || destIndex <= 0 || locked ? "disabled" : ""} aria-label="Move stop up">↑</button>
          <button type="button" class="ghost" data-act="down" ${originStop || destIndex >= dests.length - 1 || locked ? "disabled" : ""} aria-label="Move stop down">↓</button>
          <button type="button" class="ghost${state.confirmRemoveId === stop.id ? " armed" : ""}" data-act="remove" ${canRemove ? "" : "disabled"} aria-label="Remove ${escapeAttr(title)}">${state.confirmRemoveId === stop.id ? "Remove" : "−"}</button>
        </div>
      </div>
      <div class="stop-body"${locked ? " inert" : ""}>
      <div class="address-row">
        <textarea data-field="address" rows="2" placeholder="${escapeAttr(`${title} address`)}" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" aria-label="Address">${escapeAttr(stop.address)}</textarea>
        <button type="button" class="flag-box" data-act="paste" aria-label="Paste an address and times">Paste</button>
        <button type="button" class="flag-box" data-act="map">search/choose from map</button>
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
      ${originStop || stop.done ? "" : hereLeg(stop)}
      ${originStop && (stop.name || "").trim().toLowerCase() === "start" ? "" : `
      <div class="stop-flags">
        <button type="button" class="flag-box${stop.anytime ? " on" : ""}" data-toggle-field="anytime">Anytime</button>
        <button type="button" class="flag-box${stop.window ? " on" : ""}" data-toggle-field="window">Window</button>
        <button type="button" class="flag-box${state.settings.military ? " on" : ""}" data-toggle-field="military">Military</button>
      </div>
      ${stop.anytime ? "" : `
        ${stop.window ? whenRow("Opens", stop, "start", stop.start) : ""}
        ${whenRow(stop.window ? "Closes" : "Be there by", stop, stop.window ? "end" : "start", stop.window ? stop.end : stop.start)}
      `}`}
      </div>
      ${locked ? doneStamp() : ""}
    </article>
    ${planBits}
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

function progressLeg(stop) {
  const storedMiles = Number(stop.miles) || 0;
  const storedHours = Number(stop.hours) || 0;
  const progress = state.driveProgress;
  const partial = Boolean(progress && progress.stopId === stop.id && progress.remainFraction > 0 && progress.remainFraction < 1);
  if (!partial) return { miles: storedMiles, hours: storedHours, left: false };
  return {
    miles: Number.isFinite(progress.remainMiles) ? progress.remainMiles : storedMiles * progress.remainFraction,
    hours: Number.isFinite(progress.remainHours) ? progress.remainHours : storedHours * progress.remainFraction,
    left: true,
  };
}

function hereLeg(stop) {
  const leg = progressLeg(stop);
  if (leg.miles > 0.05 || leg.hours > 0.0001) {
    const parts = [];
    if (leg.miles > 0.05) parts.push(formatMiles(leg.miles));
    if (leg.hours > 0.0001) parts.push(hoursLabel(leg.hours));
    const tail = leg.left ? "left" : "from HERE";
    const mark = leg.left ? "" : "<sup>©</sup>";
    return `<p class="flag-box here-leg">${escapeAttr(parts.join(" · "))} ${tail}${mark}</p>`;
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

function exampleBlock() {
  return `<p class="fine example-slot"><button type="button" class="text-button example-load" id="loadExample">Load an example trip<canvas class="example-sparkles" aria-hidden="true"></canvas></button></p>${exampleOpenNote()}`;
}

function authBlock() {
  const shownEmail = state.emailRevealed ? state.email : maskEmail(state.email);
  const google = state.signedIn
    ? `<div class="auth-row"><p class="flag-box signed-note">Signed in${state.email ? ` as <button type="button" class="text-button" id="revealEmail" aria-pressed="${state.emailRevealed ? "true" : "false"}">${escapeAttr(shownEmail)}</button>` : ""}.</p><button type="button" class="flag-box" id="logout">Log out</button></div>`
    : state.googleClientId
      ? `<div class="auth-row"><div id="googleBtn"></div></div>`
      : `<div class="auth-row"><p class="fine">Google sign-in keeps trips on your account once that client ID is connected.</p></div>`;
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
  const session = localStorage.getItem("planigator.web.session");
  if (sessionStorage.getItem("planigator.web.showtrips") === "1") {
    sessionStorage.removeItem("planigator.web.showtrips");
    const cached = readTripCache();
    if (cached?.length) state.trips = cached;
  }
  if (session && !state.trips.length) state.tripsLoading = true;
  const tripsPromise = session ? pullAccountTrips() : Promise.resolve();
  loadHeroLines().finally(() => {
  render();
  refreshCredits({ calls: false }).then(async (me) => {
    if (state.signedIn) restoreHeldAccountTrip();
    else if ((me && me.signedIn === false) || !localStorage.getItem("planigator.web.session")) discardHeldAccountTrip();
    if (sessionStorage.getItem("planigator.web.signup") === "1") {
      sessionStorage.removeItem("planigator.web.signup");
      if (state.signedIn) {
        state.signupNote = "40 free credits are yours.";
        state.notice = "";
        popConfetti();
      }
    }
    if (state.signedIn && !tripsSynced && !state.trips.length) {
      const cached = readTripCache(state.email);
      if (cached?.length) state.trips = cached;
    }
    if (!state.signedIn) state.tripsLoading = false;
    else if (!state.trips.length && !tripsSynced) state.tripsLoading = true;
    else state.tripsLoading = false;
    if (state.idleSignOut) {
      state.calls = [];
      state.notice = "";
      state.tripsLoading = false;
      resetLocalBoxFont();
      resetEditor();
      heldAccountTrip = null;
      state.idleNote = "Signed out after an hour away.";
      persist();
      forgetAccountTripCache();
    } else if (!maybeCelebratePack() && !maybeCelebrateCard() && state.signedIn) {
      pulseActivity();
    }
    if (state.signedIn) {
      void refreshCalls().then(() => {
        if (state.calls.length && !editorBusy() && !state.locating) render();
      });
    }
    if (!state.locating) render();
    await tripsPromise;
    if (wantAccountTrip && state.signedIn && state.plan) await keepSharedOnAccount({ quiet: true });
    rollOpenExample();
    if (!state.locating) render();
    if (paid === "1") watchPackGrant();
    if (card === "1") watchCardGrant();
  });
  });
  const mark = () => { if (state.signedIn) pulseActivity(); };
  document.addEventListener("pointerdown", mark);
  document.addEventListener("keydown", mark);
  document.addEventListener("scroll", mark, true);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    watchSignIn();
    tickLeaveNow();
  });
  setInterval(() => {
    if (state.signedIn) watchSignIn();
  }, 15000);
  armLeaveNowClock();
  armPlaceClock();
}

async function watchSignIn() {
  if (navOn) await keepNavSignedIn();
  const was = state.signedIn;
  await refreshCredits();
  if (maybeCelebratePack() || maybeCelebrateCard()) return;
  if (was && !state.signedIn) {
    if (navOn) return;
    state.calls = [];
    state.notice = state.idleSignOut ? "" : "Signed out.";
    resetLocalBoxFont();
    resetEditor();
    heldAccountTrip = null;
    if (state.idleSignOut) state.idleNote = "Signed out after an hour away.";
    persist();
    forgetAccountTripCache();
    render();
  }
}

const ARRANGEMENTS = [
  null,
  { name: "Sign in, then the trip. The plan stays on each stop.", planOnCards: true, order: ["example", "sign", "start", "hours", "stops", "calculate", "map", "trips"] },
  { name: "Build the trip before you sign in. The plan stays on each stop.", planOnCards: true, order: ["example", "start", "hours", "stops", "calculate", "map", "sign", "trips"] },
  { name: "The plan is its own step, after Calculate and before the map.", planOnCards: false, order: ["example", "sign", "start", "hours", "stops", "calculate", "plan", "map", "trips"] },
  { name: "Calculate, then the map, then the plan.", planOnCards: false, order: ["example", "sign", "start", "hours", "stops", "calculate", "map", "plan", "trips"] },
  { name: "Saved trips first, so you open a trip and then change it.", planOnCards: true, order: ["example", "trips", "sign", "start", "hours", "stops", "calculate", "map"] },
  { name: "Stops first. The plan is its own step after Calculate.", planOnCards: false, order: ["example", "stops", "start", "hours", "calculate", "plan", "map", "sign", "trips"] },
  { name: "Hours, then where you start, then the stops. The plan follows Calculate.", planOnCards: false, order: ["example", "hours", "start", "stops", "sign", "calculate", "plan", "map", "trips"] },
  { name: "The map first, then the plan, then the stops.", planOnCards: false, order: ["example", "map", "plan", "stops", "calculate", "hours", "start", "sign", "trips"] },
  { name: "Where you start, the stops and their plan, then the hours.", planOnCards: true, order: ["example", "start", "stops", "hours", "sign", "calculate", "map", "trips"] },
  { name: "Sign in, the stops and their plan, then where you start.", planOnCards: true, order: ["example", "sign", "stops", "start", "hours", "calculate", "map", "trips"] },
];

function arrangementId() {
  const n = Number(window.PLAN_ARRANGE);
  return n >= 1 && n <= 10 ? n : 0;
}

function arrangeBar(id, spec) {
  const links = ARRANGEMENTS.slice(1).map((item, index) => {
    const n = index + 1;
    return `<a href="./arrange-${n}.html"${n === id ? " aria-current=\"page\"" : ""}>${n}</a>`;
  }).join(" ");
  return `<p class="arrange-bar"><a href="./">Home</a> ${links}<br>${escapeAttr(spec.name)}</p>`;
}

const HOME_LAYOUT = {
  planOnCards: false,
  order: ["example", "hours", "start", "sign", "trips", "stops", "calculate", "plan", "map"],
};

function pageLayout() {
  const id = arrangementId();
  return id ? ARRANGEMENTS[id] : HOME_LAYOUT;
}

function summaryLivesOnPlan() {
  return pageLayout().order.includes("plan");
}

function planSummary() {
  const plan = state.plan;
  if (!plan) return "";
  const leave = formatPlanTime(plan.rollAt, zoneForStop(originStop()));
  const arrive = formatPlanTime(plan.arriveAt, zoneForStop(arriveStop()));
  const driving = `${hoursLabel(plan.driveHours)} · ${formatMiles(plan.miles)}`;
  const hos = `${plan.breakCount} × 30-min · ${plan.restCount} × Off-duty/Sleeper Berth`;
  const total = durationLabel((plan.arriveAt - plan.rollAt) / 3600 / 1000);
  return `<div class="result-lines" data-plan-summary="1">
    <p class="flag-box" data-sum="leave">Leave by ${escapeAttr(leave)}</p>
    <p class="flag-box" data-sum="arrive">Arrive by ${escapeAttr(arrive)}</p>
    <p class="flag-box" data-sum="driving">Driving: ${escapeAttr(driving)}</p>
    <p class="flag-box" data-sum="hos">HOS on this path: ${escapeAttr(hos)}</p>
    <p class="flag-box" data-sum="total">Total trip-time including 10's and 30's: ${escapeAttr(total)}.</p>
  </div>`;
}

function planTimeline(heading) {
  if (!state.plan) {
    return `<section class="step"><h2>${heading}</h2><p class="fine">After Calculate, the drives, breaks, and leeway show here.</p></section>`;
  }
  const parts = [];
  const firstLive = state.stops.findIndex((stop, index) => (
    !isOriginStop(state.stops, index) && !stop.done && !stop.skipRoute
  ));
  state.stops.forEach((stop, index) => {
    if (isOriginStop(state.stops, index)) return;
    if (stop.done) {
      parts.push(donePlanChip(stop, index));
      return;
    }
    if (stop.skipRoute) return;
    const around = eventsAround(stop.id);
    if (index === firstLive) parts.push(around.now.map(chip).join(""));
    parts.push(around.before.map(chip).join(""));
    if (around.self) parts.push(chip(around.self));
    parts.push(around.following.map(chip).join(""));
  });
  return `<section class="step" id="planStep"><h2>${heading}</h2>${planSummary()}${parts.join("") || `<p class="fine">Calculate to fill the plan.</p>`}${planEndButtons()}</section>`;
}

function planEndButtons() {
  if (!state.plan) return "";
  const install = showInstallButton()
    ? `<button type="button" class="flag-box" id="installApp">Add Planigator to your home screen</button>`
    : "";
  const hint = state.installHint ? `<p class="fine">${escapeAttr(state.installHint)}</p>` : "";
  return `<div class="stack plan-end"><button type="button" class="flag-box" id="shareTrip">Share trip link</button>${install}</div>${hint}`;
}

function arrangedPage({ s, routeFrom, id }) {
  const spec = id ? ARRANGEMENTS[id] : HOME_LAYOUT;
  let step = 0;
  const h = (name) => {
    step += 1;
    return `Step ${step}. ${name}`;
  };
  const cards = state.stops
    .map((stop, index) => (stop.useCurrentLocation ? "" : stopCard(stop, index, spec.planOnCards)))
    .join("");
  const shared = state.notice === "This trip was shared with you." ? `<p class="ok shared-note">${escapeAttr(state.notice)}</p>` : "";
  const blocks = {
    example: () => exampleBlock(),
    sign: () => `<section class="step"><h2>${h("Sign in")}</h2>${authBlock()}</section>`,
    start: () => `<section class="hos step" id="stepStart" style="--box-font: ${state.boxFont}px">
      <h2>${h("Choose where the trip starts")}</h2>
      <div class="settings-grid action-grid">
        <button type="button" class="set-box${state.stops[0]?.useCurrentLocation ? " on" : ""}${state.chooseStart ? " choose-start" : ""}" id="locate" ${state.locating ? "disabled" : ""}>${state.locating ? "Waiting for permission…" : "Start from my location"}</button>
        <button type="button" class="set-box${!state.stops[0]?.useCurrentLocation && (state.stops[0]?.name || "").trim().toLowerCase() === "start" ? " on" : ""}${state.chooseStart ? " choose-start" : ""}" id="fromAddress">Start from an address</button>
        ${state.chooseStart ? `<p class="fine start-choice-note">Choose Start from my location or Start from an address.</p>` : ""}
        ${routeFrom ? `<div class="route-line"><span class="when-arrow" aria-hidden="true"></span>${routeFrom}</div>` : ""}
        ${state.locationNotice === "That's still the latest location." ? `<div class="route-line"><span class="flag-box">That's still the latest location.</span></div>` : ""}
      </div>
      <p id="locate-status" class="${state.locationError ? "error" : state.locationNotice && state.locationNotice !== "That's still the latest location." ? "ok" : ""}">${escapeAttr(state.locationError || (state.locationNotice === "That's still the latest location." ? "" : state.locationNotice) || "")}</p>
    </section>`,
    hours: () => `<section class="hos step" style="--box-font: ${state.boxFont}px">
      <h2>${h("Set speed, hours, and when you leave")}</h2>
      <div class="settings-pairs">
        <div class="set-pair">
          <div class="set-box${s.governed ? " on" : ""}">
            <button type="button" class="set-name" data-toggle="governed">Governed speed</button>
            <button type="button" class="set-value" data-pick="mph">${s.governed ? s.governedMph : "Off"}</button>
          </div>
          ${speedNoteText() ? `<p class="fine speed-note">${escapeAttr(speedNoteText())}</p>` : ""}
        </div>
        <div class="set-pair">
          ${settingToggle("leaveNow", "Leave now", s.leaveNow)}
          ${s.leaveNow ? "" : settingValue("leaveAt", "Leave at", formatUserShort(s.leaveAt, s.leaveAtOffset))}
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
        </div>
      </div>
    </section>`,
    stops: () => `${shared}<section class="stops step"><h2>${h("Add each stop")}</h2>${clearTripButton()}${cards}${tripNameRow()}</section>`,
    plan: () => planTimeline(h("The plan")),
    calculate: () => `<section class="actions step" id="actions">
      <h2>${h("Calculate the truck route")}</h2>
      <div class="route-choices">
        <button type="button" class="flag-box choice-lg${s.routeMode === "short" ? " on" : ""}" id="routeMode" data-toggle="routeMode">${s.routeMode === "short" ? "Short mode" : "Fast mode"}</button>
        <button type="button" class="flag-box choice-lg on" id="calculate" ${state.estimating || (!state.unlimited && state.credits === 0) ? "disabled" : ""}>${calculateButtonLabel()}</button>
      </div>
      <div class="stack">
        ${state.plan && !tripOnAccount() ? `<button type="button" class="flag-box" id="addTripAccount">${state.signedIn ? "Add this trip to my account" : "Sign in to add this trip to your account"}</button>` : ""}
        ${summaryLivesOnPlan() ? "" : planEndButtons()}
        ${state.cardOnFile ? `<button type="button" class="secondary" id="buyPack" ${state.buying ? "disabled" : ""}>${state.buying ? "Opening checkout…" : "If you need more credits, buy 124 credits for $1.49"}</button>` : ""}
      </div>
      <p class="fine">${state.unlimited ? "Unlimited credits on this account. " : (state.signedIn || state.cardOnFile) && state.credits != null ? `${state.credits} credit${state.credits === 1 ? "" : "s"} left. ` : ""}Calculate asks HERE<sup>©</sup> for truck miles and drive hours. Each HERE answer uses 1 credit. A short leg can ask again, and that answer costs another credit. Fast mode picks the least time, and Short mode picks the least distance.</p>
      ${state.error ? `<p class="error">${escapeAttr(state.error)}</p>` : ""}
      ${state.notice && state.notice !== "Signed out." && state.notice !== "This trip was shared with you." && !exampleOpenNote() && !openedTripNote() ? `<p class="ok">${escapeAttr(state.notice)}</p>` : ""}
    </section>`,
    map: () => planBox(h("Navigate")),
    trips: () => savedTripsBlock({ clear: false }),
    clear: () => clearTripButton(),
  };
  const body = spec.order.map((key) => blocks[key]()).join("\n");
  return id ? `${arrangeBar(id, spec)}${body}` : body;
}

function render() {
  const root = plannerRoot || document.getElementById("app");
  if (!root) return;
  catchUpPlan();
  const liveStage = document.getElementById("routeStage");
  // A new map on this screen covers Exit and zoom until the page is force-closed.
  if (routeFull && routeMap && liveStage?.isConnected) {
    routePageStale = true;
    if (!routeLivePaint) {
      routeLivePaint = true;
      try {
        paintLiveRoute();
        syncRouteChrome();
        if (state.error) showStopNote(state.error, 8000);
      } finally {
        routeLivePaint = false;
      }
    }
    return;
  }
  routePageStale = false;
  // Full screen moves the map onto document.body, and the directions list
  // moves into that screen. A recalculate renders again. Drop both copies or
  // the directions box stacks and the rail is pushed off the screen.
  clearRouteMap();
  railSeatObserver?.disconnect();
  railSeatObserver = null;
  railSeatBox = null;
  document.querySelectorAll("#routeDirections").forEach((node) => {
    if (!root.contains(node)) node.remove();
  });
  document.querySelectorAll("#routeStage").forEach((stage) => {
    if (!root.contains(stage)) stage.remove();
  });
  const googleLive = document.getElementById("googleBtn");
  const keepGoogle = googleLive && googleLive.childElementCount ? googleLive : null;
  if (keepGoogle) keepGoogle.remove();
  document.documentElement.style.setProperty("--box-font", `${state.boxFont}px`);
  const s = state.settings;
  const origin = state.stops.find((stop) => stop.useCurrentLocation);
  const routeFrom = routeFromLine(origin);
  const arranged = arrangementId();
  root.innerHTML = `
    ${state.signupNote ? `<p class="ok signup-note">${escapeAttr(state.signupNote)}</p>` : ""}
    <div class="hero-lift"><section class="hero card hero-mark">
      <img class="hero-anim" src="./icons/planigator-clip.gif?v=2" alt="" width="360" height="360">
      <div class="hero-copy">
      <h1>www.planigator.help</h1>
      <ul class="pitch">
        ${heroLines.map((line) => heroTileHtml(line)).join("")}
      </ul>
      </div>
    </section></div>
    ${arrangedPage({ s, routeFrom, id: arranged })}
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

function leaveDateValue(ms, offsetMinutes) {
  const parts = wallParts(ms, offsetMinutes);
  return `${parts.year}-${pad(parts.month + 1)}-${pad(parts.day)}`;
}

function todayDateValue(offsetMinutes) {
  return leaveDateValue(Date.now(), offsetMinutes);
}

function clampDateValue(value, offsetMinutes) {
  const min = todayDateValue(offsetMinutes);
  if (!value || value < min) return min;
  return value;
}

function wallMinutes(ms, offsetMinutes) {
  const parts = wallParts(ms, offsetMinutes);
  return parts.hour * 60 + parts.minute;
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
      ? wallMinutes(state.settings.leaveAt, state.settings.leaveAtOffset)
      : id === "stopTime"
        ? wallMinutes(pickerStopMs(), enteredOffset(pickerStop(), state.pickerTarget?.field))
        : id === "startTime" ? state.settings.startMinutes : state.settings.endMinutes;
    wheels = clockWheels(minutes);
  }
  return `<div class="time-sheet" id="pickerSheet">
    <div class="time-sheet-card">
      <p class="picker-title">${escapeAttr(title)}</p>
      ${step ? `<p class="fine picker-step">${escapeAttr(step)}</p>` : ""}
      ${id === "leaveAt" || id === "stopDate"
        ? (() => {
          const offset = id === "stopDate" ? enteredOffset(pickerStop(), state.pickerTarget?.field) : state.settings.leaveAtOffset;
          const min = todayDateValue(offset);
          const value = clampDateValue(leaveDateValue(id === "stopDate" ? pickerStopMs() : state.settings.leaveAt, offset), offset);
          return `<input class="picker-date" type="date" data-part="date" min="${min}" value="${value}" aria-label="Date">`;
        })()
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

function readDatedMs(previousMs, offsetMinutes) {
  const raw = document.querySelector("#pickerSheet [data-part=date]")?.value || "";
  const date = clampDateValue(raw, offsetMinutes);
  const [year, month, day] = date.split("-").map((part) => Number(part));
  const prev = wallParts(previousMs, offsetMinutes);
  if (!year || !month || !day) return previousMs;
  return msFromWall(year, month - 1, day, prev.hour, prev.minute, offsetMinutes);
}

function readLeaveDate() {
  return readDatedMs(state.settings.leaveAt, state.settings.leaveAtOffset);
}

function writeStopWhen(ms) {
  const target = state.pickerTarget;
  const stop = pickerStop();
  if (!target || !stop) return;
  const offset = enteredOffset(stop, target.field);
  const patch = { [target.field]: ms };
  if (target.field === "end") patch.endOffset = offset;
  else {
    patch.startOffset = offset;
    if (!stop.window) {
      patch.end = ms;
      patch.endOffset = offset;
    }
  }
  updateStop(target.id, patch);
}

function commitPicker() {
  const id = state.picker;
  if (id === "leaveAt") {
    state.settings.leaveAtOffset = clockOffset(state.settings.leaveAtOffset);
    state.settings.leaveAt = readLeaveDate();
    state.picker = "leaveAtTime";
    persist();
    saveActiveTripSettings();
    render();
    return;
  }
  if (id === "stopDate") {
    const offset = enteredOffset(pickerStop(), state.pickerTarget?.field);
    const ms = readDatedMs(pickerStopMs(), offset);
    state.picker = "stopTime";
    writeStopWhen(ms);
    return;
  }
  if (id === "stopTime") {
    const offset = enteredOffset(pickerStop(), state.pickerTarget?.field);
    const parts = wallParts(pickerStopMs(), offset);
    const minutes = minutesFromSheet();
    const ms = msFromWall(parts.year, parts.month, parts.day, Math.trunc(minutes / 60), minutes % 60, offset);
    state.picker = "";
    writeStopWhen(ms);
    state.pickerTarget = null;
    return;
  }
  if (id === "mph") {
    const before = speedChoiceLabel();
    const raw = chosenWheel("mph");
    if (raw === "off" || raw === "off2") state.settings.governed = false;
    else {
      state.settings.governed = true;
      state.settings.governedMph = Number(raw) || DEFAULT_MPH;
    }
    markGovernedStale(before);
  }
  if (id === "hoursOfEleven") state.settings.hoursOfEleven = Math.min(11, Math.max(1, Number(chosenWheel("hoursOfEleven")) || 11));
  if (id === "hoursBeforeThirty") state.settings.hoursBeforeThirty = Math.min(8, Math.max(0.5, Number(chosenWheel("hoursBeforeThirty")) || 8));
  if (id === "startTime") state.settings.startMinutes = minutesFromSheet();
  if (id === "endTime") state.settings.endMinutes = minutesFromSheet();
  if (id === "leaveAtTime") {
    const offset = clockOffset(state.settings.leaveAtOffset);
    const parts = wallParts(state.settings.leaveAt, offset);
    const minutes = minutesFromSheet();
    state.settings.leaveAtOffset = offset;
    state.settings.leaveAt = msFromWall(parts.year, parts.month, parts.day, Math.trunc(minutes / 60), minutes % 60, offset);
  }
  state.picker = "";
  persist();
  saveActiveTripSettings();
  const shiftsClock = id === "hoursOfEleven" || id === "hoursBeforeThirty" || id === "startTime" || id === "endTime" || id === "leaveAtTime";
  if (shiftsClock && state.plan) refreshShownPlan();
  else render();
}

const settingsApply = {
  governed: (el) => { state.settings.governed = el.checked; },
  mph: (el) => { state.settings.governedMph = Number(el.value) || DEFAULT_MPH; },
  hoursOfEleven: (el) => { state.settings.hoursOfEleven = Math.min(11, Math.max(1, Number(el.value) || 11)); },
  hoursBeforeThirty: (el) => { state.settings.hoursBeforeThirty = Math.min(8, Math.max(0.5, Number(el.value) || 8)); },
  leaveNow: (el) => { state.settings.leaveNow = el.checked; },
  leaveAt: (el) => { state.settings.leaveAt = fromDateTimeLocal(el.value); },
  endAnytime: (el) => { state.settings.endAnytime = el.checked; },
  startAnytime: (el) => { state.settings.startAnytime = el.checked; },
  military: (el) => { state.settings.military = el.checked; },
  kilometers: (el) => { state.settings.kilometers = el.checked; },
  arrival: (el) => { state.settings.arrival = el.value === "latest" ? "latest" : "earliest"; },
  tripName: (el) => { state.tripName = el.value; persist(); },
};

function onSettingsChange(el) {
  const apply = settingsApply[el.id];
  if (!apply) return false;
  apply(el);
  persist();
  if (el.id !== "tripName") saveActiveTripSettings();
  if (el.id === "arrival" && state.plan) calculate({ silent: true });
  else if (el.id !== "tripName") render();
  return true;
}

function onSettingsInput(el) {
  const apply = settingsApply[el.id];
  if (!apply || el.type === "checkbox") return false;
  apply(el);
  persist();
  if (el.id !== "tripName") saveActiveTripSettings();
  return true;
}

function onStopFieldChange(input) {
  const card = input.closest(".stop-card");
  const id = card?.getAttribute("data-stop");
  const field = input.getAttribute("data-field");
  if (!id || !field) return false;
  let value = input.type === "checkbox" ? input.checked : input.value;
  if (field === "name") value = clipStopName(value);
  if (field === "start" || field === "end") value = fromDateTimeLocal(input.value);
  const patch = { [field]: value };
  if (field === "start" && !state.stops.find((stop) => stop.id === id)?.window) patch.end = value;
  updateStop(id, patch);
  return true;
}

function onStopFieldInput(input) {
  const card = input.closest(".stop-card");
  const id = card?.getAttribute("data-stop");
  const field = input.getAttribute("data-field");
  if (!id || !field || input.type === "checkbox" || input.type === "datetime-local") return false;
  const stop = state.stops.find((item) => item.id === id);
  if (!stop) return false;
  if (field === "name") {
    const clipped = clipStopName(input.value);
    if (input.value !== clipped) input.value = clipped;
    stop.name = clipped;
    paintStopButton();
  } else stop[field] = input.value;
  if (field === "address") {
    addressEditStarted = true;
    paintClearTrip();
    const button = card.querySelector("[data-act=lookup]");
    const typed = input.value.trim();
    const verified = String(stop.verifiedLabel || "").trim();
    if (button && typed && typed !== verified) {
      lookupOpen.add(id);
      button.hidden = false;
      button.classList.add("lookup-flash");
    } else if (button) button.classList.remove("lookup-flash");
  }
  if (field === "address" || field === "name") fitAddressField(input);
  persist();
  return true;
}

let typingBound = false;

function bindTypingFields() {
  if (typingBound) return;
  typingBound = true;
  document.addEventListener("input", (event) => {
    const el = event.target;
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) return;
    if (el.id === "boxFont") {
      const next = Number(el.value);
      if (!Number.isFinite(next)) return;
      state.boxFont = Math.min(28, Math.max(13, Math.round(next)));
      paintBoxFont();
      persist();
      queueBoxFontSave();
      return;
    }
    if (onSettingsInput(el)) {
      if (el.id === "tripName") fitTripName(el);
      return;
    }
    if (el.matches("[data-field]")) onStopFieldInput(el);
  });
  document.addEventListener("change", (event) => {
    const el = event.target;
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) return;
    if (el.matches("#pickerSheet [data-part=date]")) {
      commitPicker();
      return;
    }
    const when = el.closest("[data-when]");
    if (when && el.matches("input")) {
      applyWhen(when);
      return;
    }
    if (onSettingsChange(el)) return;
    if (el.matches("[data-field]")) onStopFieldChange(el);
  });
  document.addEventListener("keydown", (event) => {
    const el = event.target;
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return;
    if (event.key !== "Enter") return;
    if (el.id === "tripName" || el.matches("[data-field=name]")) {
      event.preventDefault();
      return;
    }
    if (el.matches("[data-field=address]")) {
      event.preventDefault();
      const card = el.closest(".stop-card");
      const id = card?.getAttribute("data-stop");
      const stop = state.stops.find((item) => item.id === id);
      if (stop) stop.address = el.value;
      if (id) lookupAddress(id);
    }
  });
  document.addEventListener("focusin", (event) => {
    const el = event.target;
    if (!(el instanceof HTMLElement)) return;
    if ((routeFull || navOn) && el.matches("input, textarea, select")) {
      el.blur();
      return;
    }
    if (!el.matches("[data-field=address]")) return;
    const card = el.closest(".stop-card");
    const id = card?.getAttribute("data-stop");
    if (!id || lookupOpen.has(id)) return;
    lookupOpen.add(id);
    card.querySelector("[data-act=lookup]")?.removeAttribute("hidden");
  });
  document.addEventListener("paste", (event) => {
    const el = event.target;
    if (!(el instanceof HTMLTextAreaElement) || !el.matches("[data-field=address]")) return;
    const text = event.clipboardData?.getData("text") || "";
    const parsed = parseStopPaste(text, Date.now());
    if (!parsed || (!parsed.hadWhen && !parsed.anytime)) return;
    event.preventDefault();
    const id = el.closest("[data-stop]")?.getAttribute("data-stop");
    if (id) applyStopPaste(id, text);
  });
}

function bindSettings() {
  document.querySelectorAll("[data-toggle]").forEach((el) => {
    el.addEventListener("click", () => {
      const id = el.getAttribute("data-toggle");
      if (id === "governed") {
        const before = speedChoiceLabel();
        state.settings.governed = !state.settings.governed;
        markGovernedStale(before);
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
      const shiftsClock = id === "leaveNow" || id === "startAnytime" || id === "endAnytime";
      if (shiftsClock && state.plan) refreshShownPlan();
      else render();
    });
  });
  document.getElementById("voicePrev")?.addEventListener("click", () => stepNavVoice(-1));
  document.getElementById("voiceNext")?.addEventListener("click", () => stepNavVoice(1));
  document.querySelectorAll("button[data-pick]").forEach((el) => {
    el.addEventListener("click", () => {
      const id = el.getAttribute("data-pick");
      if (id === "mph") {
        const before = speedChoiceLabel();
        const wasOn = state.settings.governed;
        state.settings.governed = true;
        if (!wasOn) markGovernedStale(before);
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
  if (state.plan) refreshShownPlan();
  else render();
}

function applyWhen(wrap) {
  const offsetHint = wrap.getAttribute("data-when") === "leaveAt"
    ? state.settings.leaveAtOffset
    : enteredOffset(
      state.stops.find((item) => item.id === wrap.closest("[data-stop]")?.getAttribute("data-stop")),
      wrap.getAttribute("data-stop-field"),
    );
  const date = clampDateValue(wrap.querySelector("[data-part=date]")?.value || "", offsetHint);
  const [year, month, day] = date.split("-").map((part) => Number(part));
  if (!year || !month || !day) return;
  const minutes = minutesFromWrap(wrap);
  const hour = Math.trunc(minutes / 60);
  const minute = minutes % 60;
  if (wrap.getAttribute("data-when") === "leaveAt") {
    const offset = clockOffset(state.settings.leaveAtOffset);
    state.settings.leaveAtOffset = offset;
    state.settings.leaveAt = msFromWall(year, month - 1, day, hour, minute, offset);
    persist();
    saveActiveTripSettings();
    if (state.plan) refreshShownPlan();
    else render();
    return;
  }
  const field = wrap.getAttribute("data-stop-field");
  const id = wrap.closest("[data-stop]")?.getAttribute("data-stop");
  if (!field || !id) return;
  const stop = state.stops.find((item) => item.id === id);
  const offset = enteredOffset(stop, field);
  const ms = msFromWall(year, month - 1, day, hour, minute, offset);
  const patch = { [field]: ms };
  if (field === "end") patch.endOffset = offset;
  else {
    patch.startOffset = offset;
    if (field === "start" && !stop?.window) {
      patch.end = ms;
      patch.endOffset = offset;
    }
  }
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
  bindTypingFields();
  bindSettings();
  document.querySelectorAll("[data-clock]").forEach((wrap) => {
    wrap.querySelectorAll("select").forEach((select) => {
      select.addEventListener("change", () => applyClock(wrap));
    });
  });
  document.querySelectorAll("[data-when]").forEach((wrap) => {
    wrap.querySelectorAll("select").forEach((control) => {
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
  $("#saveTrip")?.addEventListener("click", () => { void saveNamedTrip(); });
  const tripName = document.getElementById("tripName");
  if (tripName) fitTripName(tripName);
  mountMap();
  paintDrive(navOn && navFix && navLine.length >= 2 ? navNearest(navFix[0], navFix[1], navLine).along : null);
  if (navOn && navFix) refreshPlace(navFix[0], navFix[1]);
  else if (!navOn && Number.isFinite(Number(state.origin?.lat)) && Number.isFinite(Number(state.origin?.lon))) refreshPlace(Number(state.origin.lat), Number(state.origin.lon));
  bindDirectionSteps(document);
  bindDirectionBrowse();
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
    mapChosenHit = null;
    render();
  });
  document.getElementById("useMapSpot")?.addEventListener("click", () => { void useChosenSpot(); });
  document.getElementById("mapSearch")?.addEventListener("submit", (event) => {
    event.preventDefault();
    searchMapPlaces(document.getElementById("mapSearchQuery")?.value || "");
  });
  document.getElementById("mapLoves")?.addEventListener("click", () => searchPickPlace("loves"));
  document.getElementById("mapWalmart")?.addEventListener("click", () => searchPickPlace("walmart"));
  document.getElementById("mapCat")?.addEventListener("click", () => searchPickPlace("cat"));
  document.getElementById("mapSwift")?.addEventListener("click", () => searchPickPlace("swift"));
  document.getElementById("mapTruck")?.addEventListener("click", () => searchPickPlace("truck"));
  document.getElementById("mapSearchQuery")?.addEventListener("input", (event) => {
    mapQuery = event.target.value;
  });
  mountLookupMaps();
  $("#shareTrip")?.addEventListener("click", () => shareTrip());
  $("#addTripAccount")?.addEventListener("click", () => {
    void keepSharedOnAccount().then(() => render());
  });
  syncRouteChrome();
  paintPlaceList();
  $("#nextTruck")?.addEventListener("click", () => findNextTruckStop());
  $("#nextCat")?.addEventListener("click", () => findNextTruckStop({ place: "cat" }));
  $("#nextLoves")?.addEventListener("click", () => findNextTruckStop({ place: "loves" }));
  $("#nextWalmart")?.addEventListener("click", () => findNextTruckStop({ place: "walmart" }));
  $("#darkMode")?.addEventListener("click", () => toggleDarkMode());
  $("#routeTruck")?.addEventListener("click", () => findNextTruckStop({ frame: true }));
  $("#routeLoves")?.addEventListener("click", () => findNextTruckStop({ place: "loves", frame: true }));
  $("#routeWalmart")?.addEventListener("click", () => findNextTruckStop({ place: "walmart", frame: true }));
  $("#routeCat")?.addEventListener("click", () => findNextTruckStop({ place: "cat", frame: true }));
  $("#addTruckStop")?.addEventListener("click", () => addTruckAsNextStop());
  $("#clearPlaces")?.addEventListener("click", () => clearPlacePins());
  $("#routePlaceClear")?.addEventListener("click", () => clearPlacePins());
  $("#searchPlaces")?.addEventListener("click", () => searchPlacesHere());
  $("#routePlaceSearch")?.addEventListener("click", () => searchPlacesHere());
  $("#routeTruckAdd")?.addEventListener("click", () => addTruckAndRecalculate());
  $("#routeLovesAdd")?.addEventListener("click", () => addTruckAndRecalculate());
  $("#routeWalmartAdd")?.addEventListener("click", () => addTruckAndRecalculate());
  $("#routeCatAdd")?.addEventListener("click", () => addTruckAndRecalculate());
  $("#startNav")?.addEventListener("click", () => {
    unlockNavVoice();
    void beginRouteNav();
  });
  $("#endNav")?.addEventListener("click", () => endRouteNav());
  $("#routeWhole")?.addEventListener("click", () => cycleTripFit());
  $("#routeSwitch")?.addEventListener("click", () => confirmStopSwitch());
  $("#routeSwitchNo")?.addEventListener("click", () => declineStopSwitch());
  $("#routeRecalc")?.addEventListener("click", () => {
    // Let the tap finish before the map is rebuilt. Changing the rail under
    // the finger makes iOS swallow Exit and zoom until a force close.
    window.setTimeout(() => { void recalculateFromHere(); }, 0);
  });
  $("#routeStops")?.addEventListener("click", () => toggleRailMenu("stops"));
  $("#routeDetour")?.addEventListener("click", () => toggleRailMenu("detour"));
  $("#railStopsMenu")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-aim-stop]");
    if (!button) return;
    aimNavAtStop(button.getAttribute("data-aim-stop"));
  });
  $("#railDetourMenu")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-detour]");
    if (!button) return;
    railMenu = "";
    paintRailMenus();
    if (!navOn) {
      showStopNote("Start navigation first.", 4000);
      return;
    }
    const place = button.getAttribute("data-detour");
    findNextTruckStop({ place: place === "truck" ? undefined : place, frame: true });
  });
  $("#routeZoomIn")?.addEventListener("click", () => changeMapZoom(1));
  $("#routeZoomOut")?.addEventListener("click", () => changeMapZoom(-1));
  $("#routeFull")?.addEventListener("click", () => setRouteFull(true));
  $("#routeExit")?.addEventListener("click", () => setRouteFull(false));
  $("#routeCompass")?.addEventListener("click", () => { void toggleNorthLock(); });
  $("#routeBasemap")?.addEventListener("click", () => selectBasemap(basemap === "satellite" ? "vector" : "satellite"));
  $("#routeFollow")?.addEventListener("click", async () => {
    window.clearTimeout(navReturnTimer);
    navReturnTimer = 0;
    // Follow me is only the close view on you. Turn zoom stays separate.
    stopTurnZoomOut();
    clearTurnFrame();
    tripFit = "off";
    followPinned = true;
    syncTripFitButton();
    await enableNavCompass();
    navFollowing = true;
    navZoom = 15;
    navZoomHold = 0;
    syncRouteChrome();
    if (routeMap && navFix) {
      routeMap.stop();
      const camera = { center: [navFix[1], navFix[0]], zoom: navZoom };
      const bearing = followBearing();
      if (bearing != null) camera.bearing = bearing;
      routeMap.jumpTo(camera);
    }
    if (navFix) onNavFix(navFix[0], navFix[1]);
  });
  paintLiveDirections();
  requestAnimationFrame(() => {
    if (routeFull) fitRouteCover();
    routeMap?.resize();
  });
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
          return;
        }
        if (field === "military") {
          state.settings.military = !state.settings.military;
          persist();
          saveActiveTripSettings();
          render();
        }
      });
    });
    card.querySelector("[data-act=lookup]")?.addEventListener("click", () => lookupAddress(id));
    card.querySelector("[data-act=paste]")?.addEventListener("click", () => pasteAddress(id));
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
  document.querySelectorAll("[data-before]").forEach((button) => {
    button.addEventListener("click", () => addStopBefore(button.getAttribute("data-before")));
  });
  document.querySelectorAll("[data-after]").forEach((button) => {
    button.addEventListener("click", () => addStop(button.getAttribute("data-after")));
  });
  document.querySelectorAll("[data-delay]").forEach((button) => {
    button.addEventListener("click", () => {
      changeDelay(
        button.getAttribute("data-delay"),
        Number(button.getAttribute("data-delay-piece")) || 0,
        Number(button.getAttribute("data-delay-by")) || 0,
        button.getAttribute("data-delay-finish") === "1",
      );
    });
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

function fitTripName(field) {
  const style = getComputedStyle(field);
  const line = parseFloat(style.lineHeight) || 21;
  const pad = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
  const one = line + pad;
  if (!field.value) {
    field.style.height = `${one}px`;
    return;
  }
  field.style.minHeight = "0px";
  field.style.height = "0px";
  const next = Math.max(one, field.scrollHeight);
  field.style.minHeight = "";
  field.style.height = `${next}px`;
}

if (document.body.classList.contains("planner-only")) {
  window.addEventListener("hashchange", () => {
    if (writingHash) return;
    applyShareFromLocation();
  });
  initPlanner(document.getElementById("app"));
}
