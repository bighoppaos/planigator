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
} from "./plan.js?v=180";
import { TRUCK_PROFILE } from "./here.js";
import { EXAMPLE_TRIP } from "./example-trip.js?v=6";
import { tzlookup } from "./tz-lookup.js?v=1";
import { parseStopPaste } from "./paste-stop.js?v=5";
import { buildNavLine, directionWindow, inLockWindow, matchAlong, matchNear, nearestOnPath, ON_ROAD_M, turnLockShouldAdvance } from "./nav-match.js?v=9";
import { pageSpeech, warmPageVoices } from "./page-voice.js?v=1";
import { api, creditsMe, fetchCalls, suggestAddresses, truckRoute, spotAddress, startCheckout, startCardSetup, loginWith, fetchTrips, putTrips, createShare, fetchShare, clearSession, logoutRemote, pulseActivity, clearCardWelcome, clearPackWelcome, removeSavedCard, saveBoxFont, noteVisit, redeemGift } from "./api.js?v=7";
import { loadTowns, townAt } from "./town.js?v=1";
import { cleanHeroLines, heroTileHtml } from "./hero-tiles.js?v=3";

const STORAGE = "planigator.web.v1";
const TRIP_CACHE = "planigator.web.tripcache";
// Stop-done during navigation. persist() keeps it on the editor copy and
// keepDoneOnSavedTrip() on the saved trip. If the account copy has not taken
// it yet, a signed-in reload fills the page without it. This record is what a
// refresh puts back. Each trip has its own, so opening another trip and coming
// back finds it as it was left. Only the most recently saved trips are kept.
const NAV_PROGRESS_KEY = "planigator.web.navprogress";
const NAV_PROGRESS_TRIPS = 20;
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
/** After a share link opens, keep scrolling to the first stop through init re-renders. */
let pendingShareStopScroll = false;
let shareScrollUntil = 0;

function markShareStopScroll() {
  pendingShareStopScroll = true;
  shareScrollUntil = Date.now() + 2500;
}
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
      transportMode: "truck",
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

const TRANSPORT_MODES = ["truck", "car", "bicycle", "pedestrian"];

function normalizeTransportMode(raw) {
  return TRANSPORT_MODES.includes(raw) ? raw : "truck";
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
    state.settings.transportMode = normalizeTransportMode(state.settings.transportMode);
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
  settings.transportMode = normalizeTransportMode(settings.transportMode);
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
  syncStreetTheme();
  const button = document.getElementById("darkMode");
  if (button) {
    button.classList.toggle("on", state.darkMode === true);
    button.textContent = themeButtonLabel();
  }
  persist();
}

function activeTransportMode() {
  if (!state.unlimited) return "truck";
  return normalizeTransportMode(state.settings.transportMode);
}

function transportModeTitle(mode = activeTransportMode()) {
  if (mode === "car") return "Car";
  if (mode === "bicycle") return "Bike";
  if (mode === "pedestrian") return "Walk";
  return "Truck";
}

function transportButtonLabel(mode = activeTransportMode()) {
  return `${transportModeTitle(mode)} mode`;
}

function transportRouteNote(mode = activeTransportMode()) {
  if (mode === "car") return "HERE© car route.";
  if (mode === "bicycle") return "HERE© bike route.";
  if (mode === "pedestrian") return "HERE© walk route.";
  return `HERE© truck route (${TRUCK_PROFILE.summary}).`;
}

function cycleTransportMode() {
  if (!state.unlimited) return;
  const current = activeTransportMode();
  const at = TRANSPORT_MODES.indexOf(current);
  const next = TRANSPORT_MODES[(at + 1) % TRANSPORT_MODES.length];
  state.settings.transportMode = next;
  const button = document.getElementById("transportMode");
  if (button) {
    button.classList.toggle("on", next !== "truck");
    button.textContent = transportButtonLabel(next);
  }
  state.notice = `${transportModeTitle(next)} mode. Recalculate for a new HERE© route.`;
  const note = document.getElementById("routeStopNote");
  if (note) {
    note.hidden = false;
    note.textContent = state.notice;
  }
  persist();
  saveActiveTripSettings();
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

function tripProgressKey() {
  if (state.activeTripId) return `id:${state.activeTripId}`;
  const ids = (state.stops || []).map((stop) => stop?.id).filter(Boolean);
  return ids.length ? `stops:${ids.join(",")}` : "";
}

function readNavRecord(raw, tripKey = raw?.tripKey) {
  if (!raw || typeof raw !== "object" || !tripKey || !Array.isArray(raw.doneIds)) return null;
  const leftLeg = readLeftLeg(raw.leftLeg);
  return {
    tripKey: String(tripKey),
    doneIds: raw.doneIds.map((id) => String(id || "")).filter(Boolean),
    aimId: String(raw.aimId || ""),
    nav: raw.nav === true,
    spot: readNavSpot(raw.spot),
    leftLeg,
    savedAt: Number(raw.savedAt) || leftLeg?.at || 0,
  };
}

// { [tripKey]: record }. Before Build #604 this key held one trip's record.
function readNavProgressMap() {
  try {
    const raw = JSON.parse(localStorage.getItem(NAV_PROGRESS_KEY) || "null");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    if (typeof raw.tripKey === "string") {
      const one = readNavRecord(raw);
      return one ? { [one.tripKey]: one } : {};
    }
    const all = {};
    for (const [key, value] of Object.entries(raw)) {
      const record = readNavRecord(value, key);
      if (record) all[key] = record;
    }
    return all;
  } catch {
    return {};
  }
}

function writeNavProgressMap(all) {
  const kept = Object.values(all)
    .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0))
    .slice(0, NAV_PROGRESS_TRIPS);
  try {
    if (!kept.length) localStorage.removeItem(NAV_PROGRESS_KEY);
    else localStorage.setItem(NAV_PROGRESS_KEY, JSON.stringify(Object.fromEntries(kept.map((record) => [record.tripKey, record]))));
  } catch {
    // The marks still show on this page if this phone blocked storage.
  }
}

function readNavProgress(tripKey = tripProgressKey()) {
  return (tripKey && readNavProgressMap()[tripKey]) || null;
}

// What was left of the leg being driven when last seen. It stays after End
// navigation and a refresh, until that stop is done or that leg changes.
function readLeftLeg(raw) {
  if (!raw || typeof raw !== "object") return null;
  const stopId = String(raw.stopId || "");
  const legKey = String(raw.legKey || "");
  const remainMiles = Number(raw.remainMiles);
  const remainHours = Number(raw.remainHours);
  const fullMiles = Number(raw.fullMiles);
  if (!stopId || !legKey || !(remainMiles > 0) || !(fullMiles > 0) || !(remainHours >= 0)) return null;
  return { stopId, legKey, remainMiles, remainHours, fullMiles, at: Number(raw.at) || 0 };
}

// Which leg that was: where it starts, its stop, and the stop's saved miles,
// hours, and pin. Moving, removing, re-routing, or editing it changes this.
function leftLegKey(stop) {
  const index = state.stops.indexOf(stop);
  if (index < 0) return "";
  const fixed = (value, digits) => (Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : "");
  return [
    state.stops[index - 1]?.id || "",
    stop.id,
    fixed(stop.miles, 2),
    fixed(stop.hours, 4),
    fixed(stop.lat, 5),
    fixed(stop.lon, 5),
  ].join("|");
}

// The saved left leg, only on its own trip and only while that leg is the same.
function openLeftLeg(saved = readNavProgress()) {
  const left = saved?.leftLeg;
  if (!left || saved.tripKey !== tripProgressKey()) return null;
  const stop = state.stops.find((item) => item.id === left.stopId);
  if (!stop || stop.done || stop.skipRoute || stop.useCurrentLocation) return null;
  return leftLegKey(stop) === left.legKey ? left : null;
}

function saveLeftLeg() {
  if (!liveDrive) return;
  const progress = legProgressFrom(liveDrive);
  const stop = progress && state.stops.find((item) => item.id === progress.stopId);
  const tripKey = tripProgressKey();
  if (!stop || !tripKey) return;
  const leftLeg = {
    stopId: stop.id,
    legKey: leftLegKey(stop),
    remainMiles: progress.remainMiles,
    remainHours: progress.remainHours,
    fullMiles: progress.remainMiles / progress.remainFraction,
    at: Date.now(),
  };
  const saved = readNavProgress();
  if (saved?.tripKey === tripKey) {
    writeNavProgress({ ...saved, leftLeg });
    return;
  }
  writeNavProgress({
    tripKey,
    doneIds: (state.stops || []).filter((item) => item && !item.useCurrentLocation && item.done).map((item) => item.id),
    aimId: navAimStopId || "",
    nav: navOn === true,
    spot: null,
    leftLeg,
  });
}

// Only the trip on the page. Other trips keep theirs.
function forgetLeftLeg() {
  const saved = readNavProgress();
  if (!saved?.leftLeg && !(saved?.spot && !navOn)) return;
  if (!saved.doneIds.length && !saved.nav) clearNavProgress();
  else writeNavProgress({ ...saved, leftLeg: null, spot: navOn ? saved.spot : null });
}

// Where the driver was on the route line, so a refresh resumes there.
function readNavSpot(raw) {
  if (!raw || typeof raw !== "object" || !Number.isFinite(raw.along)) return null;
  return {
    along: Number(raw.along),
    lineKey: String(raw.lineKey || ""),
    stopId: String(raw.stopId || ""),
    legAlong: Number.isFinite(raw.legAlong) ? Number(raw.legAlong) : null,
    bearing: Number.isFinite(raw.bearing) ? Number(raw.bearing) : null,
  };
}

function writeNavProgress(record) {
  if (!record?.tripKey) return;
  const all = readNavProgressMap();
  all[record.tripKey] = { ...record, savedAt: Date.now() };
  writeNavProgressMap(all);
}

function clearNavProgress(tripKey = tripProgressKey()) {
  const all = readNavProgressMap();
  if (!tripKey || !all[tripKey]) return;
  delete all[tripKey];
  writeNavProgressMap(all);
}

function clearAllNavProgress() {
  try { localStorage.removeItem(NAV_PROGRESS_KEY); } catch {
    // Already gone if this browser blocked storage.
  }
}

function rememberNavProgress() {
  const tripKey = tripProgressKey();
  if (!tripKey) return;
  const doneIds = (state.stops || [])
    .filter((stop) => stop && !stop.useCurrentLocation && stop.done)
    .map((stop) => stop.id);
  const saved = readNavProgress();
  const leftLeg = openLeftLeg(saved);
  if (!doneIds.length && !navOn && !leftLeg) {
    clearNavProgress();
    return;
  }
  writeNavProgress({
    tripKey,
    doneIds,
    aimId: navAimStopId || "",
    nav: navOn === true,
    spot: (navOn || leftLeg) && saved?.tripKey === tripKey ? saved.spot : null,
    leftLeg,
  });
}

let navSpotSavedAlong = null;

function saveNavSpot(along) {
  if (!navOn || !Number.isFinite(along)) return;
  if (Number.isFinite(navSpotSavedAlong) && Math.abs(along - navSpotSavedAlong) < 50) return;
  const saved = readNavProgress();
  if (!saved || saved.tripKey !== tripProgressKey()) return;
  const active = activeNavLeg();
  const leg = active && along >= active.start - 1 && along <= active.end + 1
    ? active
    : navLegs.find((item) => along >= item.start && along <= item.end);
  navSpotSavedAlong = along;
  writeNavProgress({
    ...saved,
    spot: {
      along,
      lineKey: navLineKey,
      stopId: leg?.stop?.id || "",
      legAlong: leg ? along - leg.start : null,
      bearing: Number.isFinite(navTravel) ? navTravel : null,
    },
  });
}

// After a refresh, start the along-lock where the driver was, not on
// whichever pass of the line the first fix happens to be closest to.
function restoreNavSpot() {
  const saved = readNavProgress();
  const spot = saved?.tripKey === tripProgressKey() ? saved.spot : null;
  if (!spot) return false;
  rebuildNavLegs();
  if (navLine.length < 2) return false;
  const leg = spot.stopId ? navLegs.find((item) => item.stop?.id === spot.stopId) : null;
  let along = null;
  if (leg && Number.isFinite(spot.legAlong)) along = leg.start + Math.min(Math.max(0, spot.legAlong), leg.end - leg.start);
  else if (spot.lineKey && spot.lineKey === navLineKey) along = spot.along;
  if (!Number.isFinite(along)) return false;
  // A spot saved on the leg of another stop is not where he is.
  const active = activeNavLeg();
  if (active && (along < active.start - 1 || along > active.end + 1)) return false;
  navAlongLock = along;
  navSpotSavedAlong = along;
  if (spot.bearing != null && navTravel == null) navTravel = spot.bearing;
  navResumeGuard = { fix: "", candidate: null, count: 0 };
  return true;
}

function nextOpenStopId() {
  const aimed = state.stops.find((stop, index) => (
    stop
    && stop.id === navAimStopId
    && !isOriginStop(state.stops, index)
    && !stop.done
    && !stop.skipRoute
    && !stop.useCurrentLocation
  ));
  if (aimed) return aimed.id;
  const next = state.stops.find((stop, index) => (
    !isOriginStop(state.stops, index) && !stop.done && !stop.skipRoute && !stop.useCurrentLocation
  ));
  return next?.id || "";
}

// A trip saved after it was driven: its progress moves from its stops to its id.
function retargetNavProgress() {
  const tripKey = tripProgressKey();
  if (!tripKey) return null;
  const all = readNavProgressMap();
  if (all[tripKey]) return all[tripKey];
  const ids = (state.stops || []).map((stop) => stop?.id).filter(Boolean).join(",");
  const from = ids ? all[`stops:${ids}`] : null;
  if (!from) return null;
  const next = { ...from, tripKey };
  delete all[from.tripKey];
  all[tripKey] = next;
  writeNavProgressMap(all);
  return next;
}

function applyNavProgress() {
  retargetNavProgress();
  const saved = readNavProgress();
  const tripKey = tripProgressKey();
  if (!saved || !tripKey || saved.tripKey !== tripKey) return false;
  // Only a left leg: no marks to put back and no stop to aim at.
  if (!saved.doneIds.length && !saved.nav) return false;
  const ids = new Set(saved.doneIds);
  let changed = false;
  for (const stop of state.stops) {
    if (!stop || stop.useCurrentLocation || !ids.has(stop.id)) continue;
    if (stop.done && stop.skipRoute && stop.switched) continue;
    stop.done = true;
    stop.switched = true;
    stop.skipRoute = true;
    changed = true;
  }
  if (saved.aimId && state.stops.some((stop) => stop.id === saved.aimId && !stop.done && !stop.skipRoute && !stop.useCurrentLocation)) {
    navAimStopId = saved.aimId;
  } else {
    const nextId = nextOpenStopId();
    if (nextId) navAimStopId = nextId;
  }
  const openId = nextOpenStopId();
  const progressStop = state.stops.find((stop) => stop.id === state.driveProgress?.stopId);
  if (openId && (!progressStop || progressStop.done || progressStop.skipRoute)) {
    state.driveProgress = { stopId: openId, remainFraction: 1, leftAt: state.driveProgress?.leftAt || Date.now() };
    changed = true;
  }
  if (saved.nav) navProgressResume = true;
  if (!changed) {
    keepDoneOnSavedTrip();
    return true;
  }
  if (state.plan) {
    const timed = stopsAndLeaveForPlan();
    const result = buildPlan({
      stops: zonedPlanStops(timed.stops),
      settings: { ...state.settings, leaveAt: timed.leaveAt },
      now: planClockNow(timed.leaveAt),
    });
    if (!result.error) state.plan = result;
  }
  persist();
  keepDoneOnSavedTrip();
  return true;
}

// A done stop stays done on its saved trip, on this phone and on the account,
// so it comes back whenever that trip is opened. Marks are only ever added here.
function keepDoneOnSavedTrip() {
  const trip = state.trips.find((item) => item.id === state.activeTripId) || savedTripForEditor();
  if (!trip || !Array.isArray(trip.stops)) return false;
  const done = new Map((state.stops || [])
    .filter((stop) => stop?.id && !stop.useCurrentLocation && stop.done)
    .map((stop) => [stop.id, stop]));
  if (!done.size) return false;
  let changed = false;
  trip.stops = trip.stops.map((stop) => {
    const live = done.get(stop?.id);
    if (!live) return stop;
    const switched = Boolean(stop.switched || live.switched);
    const skipRoute = Boolean(stop.skipRoute || live.skipRoute);
    if (stop.done && Boolean(stop.switched) === switched && Boolean(stop.skipRoute) === skipRoute) return stop;
    changed = true;
    return { ...stop, done: true, switched, skipRoute };
  });
  if (!changed) return false;
  if (trip.id === state.activeTripId) trip.driveProgress = state.driveProgress;
  trip.pendingUpload = true;
  trip.savedAt = Date.now();
  persist();
  // Before the account list merges, an upload would send this phone's older
  // list. pullAccountTrips uploads pending trips once it has merged.
  if (!tripsSynced) return true;
  writeTripCache();
  uploadPendingTrips();
  return true;
}

// Leaving a trip or ending navigation ends the drive, not the done marks.
// Opening that trip again must not start navigating it.
function leaveNavSession() {
  keepDoneOnSavedTrip();
  navAimStopId = "";
  navProgressResume = false;
  const saved = readNavProgress();
  if (saved?.nav && !navOn) writeNavProgress({ ...saved, nav: false, aimId: "" });
}

function endNavProgress() {
  const saved = retargetNavProgress();
  if (!saved || saved.tripKey !== tripProgressKey()) return;
  const doneIds = new Set(saved.doneIds);
  for (const stop of state.stops || []) {
    if (stop?.id && !stop.useCurrentLocation && stop.done) doneIds.add(stop.id);
  }
  const leftLeg = openLeftLeg(saved);
  if (!doneIds.size && !leftLeg) clearNavProgress();
  else writeNavProgress({ ...saved, doneIds: [...doneIds], aimId: "", nav: false, spot: leftLeg ? saved.spot : null, leftLeg });
}

function replanAroundDone() {
  if (!state.plan || !state.stops.some((stop) => stop?.done)) return;
  const timed = stopsAndLeaveForPlan();
  const result = buildPlan({
    stops: zonedPlanStops(timed.stops),
    settings: { ...state.settings, leaveAt: timed.leaveAt },
    now: planClockNow(timed.leaveAt),
  });
  if (!result.error) state.plan = result;
}

function restoreHeldAccountTrip() {
  const saved = heldAccountTrip;
  if (!saved || !state.signedIn) return;
  heldAccountTrip = null;
  if (editorIsUnused()) {
    applyStoredTrip(state, saved);
    settleLoadedStops(state.stops);
    pinEnteredClocks();
    persist();
  }
  applyNavProgress();
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
  forgetLeftLeg();
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
  // The leg being driven starts now with only what is left of it, live while
  // navigating, else as last seen. A saved progress on a later stop (Update
  // times at a stop) still wins.
  const live = liveLegProgress();
  const order = (id) => state.stops.findIndex((stop) => stop.id === id);
  if (live && (!progress || order(progress.stopId) <= order(live.stopId))) progress = live;
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

/** Wall clock for leeway before the first drive when Leave at is set. Leave now
 *  uses the same instant as leaveAt so that chip does not open for no reason. */
function planClockNow(leaveAt) {
  if (state.settings.leaveNow) return leaveAt;
  return Date.now();
}

function rebuiltPlan() {
  const timed = stopsAndLeaveForPlan();
  return buildPlan({
    stops: zonedPlanStops(timed.stops),
    settings: {
      ...state.settings,
      leaveAt: timed.leaveAt,
    },
    now: planClockNow(timed.leaveAt),
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
  if ((!state.settings.leaveNow && !liveLegProgress()) || !state.plan || state.estimating) return;
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
  const incomingIds = (Array.isArray(data.stops) ? data.stops : []).map((stop) => stop?.id).filter(Boolean).join(",");
  const currentIds = (state.stops || []).map((stop) => stop?.id).filter(Boolean).join(",");
  if (incomingIds && incomingIds !== currentIds) {
    if (navOn) endRouteNav({ paint: false });
    else leaveNavSession();
  }
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
  markShareStopScroll();
  settleLoadedStops(state.stops);
  pinEnteredClocks();
  applyNavProgress();
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
    // A stop Recalculate routed past has no leg. Its old line stays off.
    if (stop.skipRoute && !stopHasSavedLeg(stop)) return stop;
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
    markShareStopScroll();
    if (state.activeTripId !== saved.id || !hasRouteLine(state.stops)) loadTrip(saved.id);
    else render();
    return true;
  }
  if (state.plan && state.activeTripId && shareToken() === token) {
    markShareStopScroll();
    render();
    return false;
  }
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
  const leg = activeNavLeg();
  if (!leg) {
    state.updatingTimes = false;
    state.notice = "";
    state.error = "You're already at the last stop.";
    render();
    return;
  }
  // Only the leg of the stop being driven to. The line to the next stop can
  // run right beside it (a turnpike median plaza).
  const span = navMatchSpan();
  const closest = nearestOnPath(here.lat, here.lon, navLine, span);
  const locked = navOn ? navNearest(here.lat, here.lon, navLine) : closest;
  const hit = closest.dist + 50 < locked.dist ? closest : locked;
  if (hit === closest && closest.dist <= 2 * 1609.344) navAlongLock = closest.along;
  if (hit.dist > 2 * 1609.344) {
    state.updatingTimes = false;
    state.notice = "";
    state.error = "You're not on the saved route. Recalculate the stop you are driving toward.";
    render();
    return;
  }
  const legMeters = Math.max(1, leg.end - leg.start);
  const into = Math.min(legMeters, Math.max(0, hit.along - leg.start));
  const remaining = Math.max(0, legMeters - into);
  const fraction = remaining / legMeters;
  const stop = leg.stop;
  if (remaining < STOP_ARRIVE_M || !legStillCounts(stop, fraction)) {
    // At the stop. It stays the stop being driven to until he presses Done.
    const index = state.stops.findIndex((item) => item.id === stop.id);
    const next = nextTimedStop(index);
    state.updatingTimes = false;
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
    const again = Boolean(state.plan);
    const here = again ? await currentFix({ fresh: true }) : await arrivedFix();
    if (here) {
      rebuildNavLegs();
      noteArrivedStops(here.lat, here.lon);
      // "Recalculate from <stop>" routes only the new legs after that stop.
      if (again && legsToCalculate(state.stops).mode !== "suffix") startRecalcHere(here);
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
    const modeAsk = activeTransportMode();
    state.notice = modeAsk === "truck"
      ? "Asking HERE© for a truck-legal route…"
      : `Asking HERE© for a ${transportModeTitle(modeAsk).toLowerCase()} route…`;
    render();
    try {
      hereLegs = await fillHereLegs();
    } catch (error) {
      if (error.credits != null) state.credits = error.credits;
      state.error = error.message || `Could not get a HERE© ${transportModeTitle(modeAsk).toLowerCase()} route.`;
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
    now: planClockNow(leaveAt),
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
  const modeDone = activeTransportMode();
  const routeNote = hereLegs?.from
    ? `${transportRouteNote(modeDone).replace(/\.$/, "")} from ${hereLegs.from}. Earlier stops were not recalculated.`
    : transportRouteNote(modeDone);
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
    if (navBootReady) resumeNavIfNeeded();
    return;
  }
  render();
  if (navBootReady) resumeNavIfNeeded();
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
  retargetNavProgress();
  if (navOn || state.stops.some((stop) => stop?.done)) rememberNavProgress();
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
  return `<p class="trips-clear" id="clearTripSlot"${addressEditStarted ? "" : " hidden"}><button type="button" class="flag-box" id="newTrip"${navOn ? ' disabled data-nav-lock="1" aria-disabled="true" data-nav-aria="1"' : ""}>Clear trip</button></p>`;
}

function tripNameRow() {
  return `<div class="trip-name-row">
    <label class="flag-box trip-name">Trip name
      <textarea id="tripName" rows="1" placeholder="Optional — Dallas to Atlanta" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">${escapeAttr(state.tripName)}</textarea>
    </label>
    <button type="button" class="flag-box" id="saveTrip"${navOn ? ' disabled data-nav-lock="1" aria-disabled="true" data-nav-aria="1"' : ""}>Save</button>
  </div>${state.saveNote ? `<p class="fine save-note">${escapeAttr(state.saveNote)}</p>` : ""}`;
}

function loadTrip(id) {
  if (navOn) return;
  const trip = state.trips.find((item) => item.id === id);
  if (!trip) return;
  leaveNavSession();
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
  applyNavProgress();
  if (!state.plan || tripReadyToRecalc()) calculate({ silent: true, skipHash: true });
  else {
    replanAroundDone();
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
  if (navOn) endRouteNav({ paint: false });
  else leaveNavSession();
  parkSpeedNote();
  const trip = shiftExampleStamps(JSON.parse(JSON.stringify(EXAMPLE_TRIP)), exampleWeeksAhead() * 7);
  state.settings = { ...state.settings, ...(trip.settings || {}) };
  delete state.settings.sleepHours;
  delete state.settings.readyMinutes;
  state.stops = Array.isArray(trip.stops) ? trip.stops : [];
  state.driveProgress = null;
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
  applyNavProgress();
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
    applyNavProgress();
    return;
  }
  if (!state.activeTripId && editorIsUnused()) {
    const latest = state.trips.find((trip) => (trip.stops || []).length);
    if (latest) {
      loadTrip(latest.id);
      return;
    }
  }
  applyNavProgress();
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
  // The open editor is still waiting in heldAccountTrip. Filling it from the
  // account trip here drops stop-done marks that were never saved to the account.
  if (!touchEditor || heldAccountTrip) return;
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
  if (navOn) return;
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
  if (navOn) return;
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
    now: planClockNow(timed.leaveAt),
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
  syncStopCardNavLock();
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
  paintDirectionToward();
  rememberNavProgress();
  keepDoneOnSavedTrip();
  paintDrive();
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
  rememberNavProgress();
  const calc = document.getElementById("calculate");
  if (calc && !state.estimating) calc.innerHTML = calculateButtonLabel();
  if (routeFull) routePageStale = true;
}

function stopHasSavedLeg(stop) {
  return (Number(stop?.miles) || 0) > 0.05 || (Number(stop?.hours) || 0) > 0.0001;
}

async function removeStop(id) {
  if (navOn) return;
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
  if (navOn) return;
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
  if (navOn) return;
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
  clearAllNavProgress();
  navProgressResume = false;
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
  leaveNavSession();
  forgetLeftLeg();
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

// What Start from my location does with a fix.
function startTripAt(fix) {
  const saved = readNavProgress();
  const left = openLeftLeg(saved);
  dropAddressStart();
  const coords = { latitude: fix.lat, longitude: fix.lon };
  const hadOrigin = Boolean(state.origin);
  const moved = movedEnough(state.origin, coords);
  state.origin = { lat: fix.lat, lon: fix.lon };
  const heading = fix.heading;
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
  carryNavProgress(saved, left);
  persist();
}

// A new first stop renames a trip keyed by its stops, and changes the key of
// the leg after it. Its done stops and left leg go with it.
function carryNavProgress(saved, left) {
  if (!saved) return;
  const tripKey = tripProgressKey();
  const stop = left && state.stops.find((item) => item.id === left.stopId);
  const leftLeg = stop ? { ...left, legKey: leftLegKey(stop) } : saved.leftLeg;
  if (tripKey === saved.tripKey && leftLeg?.legKey === saved.leftLeg?.legKey) return;
  if (tripKey !== saved.tripKey) clearNavProgress(saved.tripKey);
  writeNavProgress({ ...saved, tripKey, leftLeg });
}

function locateSucceeded(pos, attempt) {
  if (attempt !== locateAttempt) return;
  locateAttempt += 1;
  endLocateWatch();
  startTripAt({ lat: pos.coords.latitude, lon: pos.coords.longitude, heading: pos.coords.heading });
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
  if (navOn) return;
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
  if (!state.unlimited) state.settings.transportMode = "truck";
  else state.settings.transportMode = normalizeTransportMode(state.settings.transportMode);
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
  if (navOn) return;
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
  const year = parts.year != null && Number.isFinite(Number(parts.year)) ? Number(parts.year) : new Date().getFullYear();
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
  if (navOn) return;
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
  if (navOn) return;
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
  if (navOn) return;
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
  const clearButton = `<p class="trips-clear"><button type="button" class="flag-box" id="newTrip"${navOn ? ' disabled data-nav-lock="1" aria-disabled="true" data-nav-aria="1"' : ""}>Clear trip</button></p>`;
  if (!state.signedIn) return clear ? clearButton : "";
  const loading = state.tripsLoading ? `<p class="fine">Loading saved trips…</p>` : "";
  const list = state.trips.length ? `<ul>
      ${state.trips.map((trip) => `<li class="${trip.id === state.activeTripId ? "active" : ""}">
        <button type="button" class="flag-box${trip.id === state.activeTripId ? " on" : ""}" data-load="${escapeAttr(trip.id)}"${navOn ? ' disabled data-nav-lock="1" aria-disabled="true" data-nav-aria="1"' : ""}>
          ${escapeAttr(trip.name || trip.tripName || "Trip")}
          <span>${formatShort(trip.savedAt)}</span>
        </button>
        <button type="button" class="flag-box" data-delete="${escapeAttr(trip.id)}"${navOn ? ' disabled data-nav-lock="1" aria-disabled="true" data-nav-aria="1"' : ""}>${state.confirmDeleteId === trip.id ? "Confirm delete" : "Delete"}</button>
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

function directionTowardName() {
  if (navAimStopId) {
    const aimed = state.stops.find((stop) => (
      stop.id === navAimStopId && !stop.done && !stop.skipRoute && !stop.useCurrentLocation
    ));
    if (aimed) return navStopTitle(aimed);
  }
  if (navOn && !navLegs.length) rebuildNavLegs();
  if (navOn || navLegs.length) {
    const leg = activeNavLeg();
    if (leg?.stop) return navStopTitle(leg.stop);
  }
  for (let index = 0; index < state.stops.length; index += 1) {
    const stop = state.stops[index];
    if (!stop || stop.useCurrentLocation || stop.done || stop.skipRoute) continue;
    if (isOriginStop(state.stops, index)) continue;
    if (!Array.isArray(stop.directions) || !stop.directions.length) continue;
    return navStopTitle(stop);
  }
  return "";
}

function paintDirectionToward() {
  const name = directionTowardName();
  const node = document.getElementById("dirToward");
  if (!node) return;
  const shown = name ? `(${name})` : "";
  if (node.textContent !== shown) node.textContent = shown;
  node.hidden = !name;
  if (name) node.setAttribute("title", name);
  else node.removeAttribute("title");
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
  const toward = directionTowardName();
  const towardHtml = toward
    ? `<span class="dir-toward" id="dirToward" title="${escapeAttr(toward)}">(${escapeAttr(toward)})</span>`
    : `<span class="dir-toward" id="dirToward" hidden></span>`;
  return `<details class="directions call-log-box" id="routeDirections" open>
    <summary><span class="dir-label">auto zooming directions</span>${towardHtml}</summary>
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
          <button type="button" id="routeStops" aria-expanded="false" aria-label="Stops"><span>Stops</span></button>
          <div class="rail-col-menu" id="railStopsMenu" hidden></div>
        </div>
        <div class="rail-pop" id="railDetourPop">
          <button type="button" id="routeDetour" aria-expanded="false" aria-label="Detours"><span>Detours</span></button>
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
        <button type="button" id="routeExit" hidden aria-label="Exit full screen"><span>Exit</span><span>full</span></button>
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
        <button type="button" class="route-voice-hint" id="routeVoiceHint" hidden>Tap to turn on voice</button>
        <p class="route-place-clear" id="routePlaceStatus" hidden></p>
        <button type="button" id="routePlaceSearch" class="route-place-clear" hidden>Search here</button>
        <button type="button" id="routePlaceClear" class="route-place-clear" hidden>Clear</button>
      </div>
    </div>
    <div id="routeDirectionsHome"></div>
    ${directions}
    ${directions ? `<div class="nav-actions nav-go" id="navGo"><button type="button" class="flag-box" id="startNav" ${navOn ? "disabled" : ""}>${navOn ? "Navigation in progress" : "Start navigation"}</button><button type="button" class="flag-box" id="endNav">End navigation</button>${voiceStepper()}</div><p class="fine">Arrows change the voice. Phone is the voice on this phone and pauses the song. US, Clear, Ann, Cal, Scot, and North talk when you tap them and keep the song playing.</p>` : ""}
    <p class="flag-box" id="routeStopNote" hidden></p>
    ${directions ? `<div class="nav-actions"><button type="button" class="flag-box${state.darkMode ? " on" : ""}" id="darkMode">${themeButtonLabel()}</button>${state.unlimited ? `<button type="button" class="flag-box${activeTransportMode() !== "truck" ? " on" : ""}" id="transportMode">${transportButtonLabel()}</button>` : ""}</div><p class="flag-box" id="nextTruckNote"${placeListMode || !truckHit ? " hidden" : ""}>${placeListMode || !truckHit ? "" : escapeAttr(truckNoteText(truckHit))}</p><div id="nextPlaceList" class="place-list"${placeListMode && truckHits.length ? "" : " hidden"}></div><button type="button" class="flag-box" id="searchPlaces"${placeSeek && placeMapMoved ? "" : " hidden"}>Search here</button><button type="button" class="flag-box" id="clearPlaces"${truckHits.length ? "" : " hidden"}>Clear</button><button type="button" class="flag-box" id="addTruckStop"${truckHit ? "" : " hidden"}>Add as next stop</button>` : ""}
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

// Magenta stays clear of water blue, park green, highway yellow/orange and
// the blue location dot, on light, dark and satellite maps alike.
const ROUTE_CURRENT_COLOR = "#C026D3";
const ROUTE_DRIVEN_COLOR = "#E3A6EC";
const ROUTE_CURRENT_CASING = "#6B0F72";
const ROUTE_LINE_COLOR = ["case", ["==", ["get", "current"], 1], ROUTE_CURRENT_COLOR, "#1f8a62"];
// While "left" is drawn over the current part, what shows of it is already driven.
const ROUTE_DRIVEN_LINE_COLOR = ["case", ["==", ["get", "current"], 1], ROUTE_DRIVEN_COLOR, "#1f8a62"];
const ROUTE_CASING_COLOR = ["case", ["==", ["get", "current"], 1], ROUTE_CURRENT_CASING, "#ffffff"];

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
      paint: { "line-color": ROUTE_CASING_COLOR, "line-width": 7 },
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
      id: "left-casing",
      type: "line",
      source: "left",
      paint: { "line-color": ROUTE_CURRENT_CASING, "line-width": 9 },
    });
    map.addLayer({
      id: "left",
      type: "line",
      source: "left",
      paint: { "line-color": ROUTE_CURRENT_COLOR, "line-width": 6 },
    });
  }
}

function paintRouteColor(driven = false) {
  if (!routeMap?.getLayer("route")) return;
  routeMap.setPaintProperty("route", "line-color", driven ? ROUTE_DRIVEN_LINE_COLOR : ROUTE_LINE_COLOR);
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

const DARK_STREET_TEXT = { "text-color": "#e6ece9", "text-halo-color": "#0b1114" };

// Keys are liberty layer ids; * matches any run of characters, and a later key
// wins over an earlier one for the same property. Shields keep their sprite
// colors and default dark text, which sits on the light shield, not the map.
const DARK_STREET_PAINT = {
  background: { "background-color": "#0e1417" },
  natural_earth: { "raster-opacity": 0.12, "raster-brightness-max": 0.35 },
  park: { "fill-color": "#1a2a20", "fill-outline-color": "#24402c" },
  park_outline: { "line-color": "#24402c" },
  "landuse_*": { "fill-color": "#1d2622" },
  landuse_residential: { "fill-color": "rgba(30, 38, 43, 0.6)" },
  landuse_hospital: { "fill-color": "#2a1e24" },
  landuse_school: { "fill-color": "#25261d" },
  "landcover_*": { "fill-color": "#1c2e22" },
  landcover_ice: { "fill-color": "#263034" },
  landcover_sand: { "fill-color": "#2a2920" },
  landcover_wetland: { "fill-opacity": 0.15 },
  waterway_tunnel: { "line-color": "#1d3a57" },
  waterway_river: { "line-color": "#1d3a57" },
  waterway_other: { "line-color": "#1d3a57" },
  water: { "fill-color": "#13263a" },
  aeroway_fill: { "fill-color": "#1c2226" },
  aeroway_runway: { "line-color": "#363d42" },
  aeroway_taxiway: { "line-color": "#363d42" },
  road_area_pattern: { "fill-opacity": 0.15 },
  "*_minor": { "line-color": "#2b343a" },
  "*_street": { "line-color": "#2b343a" },
  "*_service_track": { "line-color": "#262e33" },
  "*_path_pedestrian": { "line-color": "#2a3237" },
  "*_link": { "line-color": "#3a4349" },
  "*_secondary_tertiary": { "line-color": "#3a4349" },
  "*_trunk_primary": { "line-color": "#5a4a35" },
  "*_motorway": { "line-color": "#7a5a36" },
  "*_motorway_link": { "line-color": "#6a4f31" },
  "*_rail": { "line-color": "#353d42" },
  "*_rail_hatching": { "line-color": "#353d42" },
  "*_casing": { "line-color": "#151c20" },
  "*_trunk_primary_casing": { "line-color": "#2a2219" },
  "*_motorway_casing": { "line-color": "#2a2219" },
  "*_motorway_link_casing": { "line-color": "#2a2219" },
  building: { "fill-color": "#20272b", "fill-outline-color": "#2a3338" },
  "building-3d": { "fill-extrusion-color": "#20272b" },
  "boundary_*": { "line-color": "#5f676b" },
  boundary_3: { "line-color": "#4a5358" },
  waterway_line_label: { "text-color": "#8fb4e0", "text-halo-color": "#0b1114" },
  "water_name_*": { "text-color": "#8fb4e0", "text-halo-color": "#0b1114" },
  "poi_*": DARK_STREET_TEXT,
  poi_transit: { "text-color": "#9cc3e6" },
  airport: DARK_STREET_TEXT,
  "highway-name-*": DARK_STREET_TEXT,
  "highway-name-path": { "text-color": "#b3bab7" },
  "label_*": DARK_STREET_TEXT,
  label_other: { "text-color": "#c9d1cd" },
  label_state: { "text-color": "#c9d1cd" },
  "route-casing": { "line-color": ["case", ["==", ["get", "current"], 1], ROUTE_CURRENT_CASING, "#0b1114"] },
};

const DARK_STREET_RULES = Object.entries(DARK_STREET_PAINT).map(([key, paint]) => [
  new RegExp("^" + key.split("*").map((part) => part.replace(/[^\w]/g, "\\$&")).join(".*") + "$"),
  paint,
]);

const streetThemeSaved = new WeakMap();

function darkStreetPaint(layerId) {
  let paint = null;
  for (const [rule, values] of DARK_STREET_RULES) {
    if (rule.test(layerId)) paint = { ...(paint || {}), ...values };
  }
  return paint;
}

function restoreStreetPaint(map) {
  const saved = streetThemeSaved.get(map);
  streetThemeSaved.delete(map);
  if (!saved) return;
  for (const [id, paint] of saved) {
    if (!map.getLayer(id)) continue;
    for (const [prop, value] of Object.entries(paint)) {
      try { map.setPaintProperty(id, prop, value); } catch {}
    }
  }
}

function darkenStreetPaint(map) {
  let layers = [];
  try { layers = map.getStyle()?.layers || []; } catch { return; }
  let saved = streetThemeSaved.get(map);
  if (!saved) {
    saved = new Map();
    streetThemeSaved.set(map, saved);
  }
  for (const layer of layers) {
    const paint = darkStreetPaint(layer?.id || "");
    if (!paint || !map.getLayer(layer.id)) continue;
    const before = saved.get(layer.id) || {};
    for (const [prop, value] of Object.entries(paint)) {
      try {
        if (!(prop in before)) before[prop] = map.getPaintProperty(layer.id, prop);
        map.setPaintProperty(layer.id, prop, value);
      } catch {}
    }
    saved.set(layer.id, before);
  }
}

// Planigator's own Dark mode decides this, never the phone's setting.
// Paint changes in place, so the route, pins, dots and camera stay put.
// fresh: the style was just (re)loaded, so earlier saved paint is stale.
function syncStreetTheme(fresh = false) {
  const map = routeMap;
  if (!map) return;
  if (fresh) streetThemeSaved.delete(map);
  if (!fresh && !routeMapReady) return;
  let street = false;
  try { street = basemap === "vector" && Boolean(map.getSource("openmaptiles")); } catch {}
  const dark = street && state.darkMode === true;
  if (dark) darkenStreetPaint(map);
  else restoreStreetPaint(map);
  map.getContainer?.()?.classList?.toggle("street-dark", dark);
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
    syncStreetTheme();
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
    syncStreetTheme(true);
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
  if (navOn) return;
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
  if (navOn) return;
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
  if (navOn) return;
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
let navProgressResume = false;
let navBootReady = false;
let navFollowing = true;
let followPinned = false;
let navMapTouch = false;
let navZoom = 15;
let navZoomHold = 0;
let navWatch = null;
let navFixAt = 0;
let navWakeAt = 0;
let navYou = null;
let navFix = null;
// When the GPS took navFix. iOS can hand back its last cached fix after a
// refresh or when the screen comes back on, minutes after it was true.
let navFixTime = 0;
const NAV_FRESH_MS = 5000;
let navMotion = 0;
let navShown = null;
let navAim = null;
let navTravel = null;
let navCompass = null;
let navCompassTimer = 0;
// GPS fixes while navigating, newest last: { lat, lon, at, acc }.
let navTrack = [];
// The last travel heading worth trusting: { bearing, at, lat, lon, source }.
let navHeadingGood = null;
const TRACK_KEEP_MS = 120000;
const TRACK_MAX_FIXES = 40;
const TRACK_MIN_M = 35;
const TRACK_SPAN_M = 50;
const TRACK_FAR_M = 400;
const TRACK_TURN_M = 20;
const TRACK_FRESH_MS = 15000;
const GPS_MOVING_MPS = 2;
const HEADING_KEEP_MS = 600000;
const HEADING_MOVED_M = 300;
const HEADING_TRUST_MS = 60000;
const ROUTE_ON_M = 30;
const ROUTE_AGREE_DEG = 60;
const START_CHECK_M = 150;
const START_BACKWARDS_DEG = 120;
const AHEAD_ORIGIN_M = 150;
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
const PIN_PEEK_MS = 5000;
const PIN_PEEK_M = 805;
let pinPeek = null;
let placeListMode = false;
let placeSeek = "";
let placeSeekFull = false;
let placeMapMoved = false;
let placeHereNote = "";
let navLine = [];
let navLegs = [];
let navAlongLock = null;
let navResumeGuard = null;
let navLineKey = "";
// Consistent on-road fixes needed to move a restored spot outside its stretch.
const RESUME_CONFIRM_FIXES = 3;
const RESUME_AGREE_M = 800;
const RESUME_PARKED_M = 500;
const RESUME_DRIVEN_M = 1000;

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
    button.dataset.stopId = pin.id || "";
    routePinMarkers.push(new maplibre.Marker({ element: button, anchor: "bottom" }).setLngLat([pin.lon, pin.lat]).addTo(routeMap));
    bounds?.extend([pin.lon, pin.lat]);
  });
  routePinsPlain = true;
  hookRoutePinDeclutter();
  declutterRoutePins();
}

let routePinsHooked = null;
let routePinsPlain = true;

function routePinFor(stopId) {
  if (!stopId) return null;
  return routePinMarkers.find((marker) => marker.getElement().dataset.stopId === stopId) || null;
}

// Stop zoom: the stop you are driving to keeps its chip on top, and any chip
// that would cover it is hidden. Every other view shows all chips as before.
function declutterRoutePins() {
  const target = tripFit === "nextStop" && routeMap ? routePinFor(stopTargetId) : null;
  if (!target) {
    if (routePinsPlain) return;
    for (const marker of routePinMarkers) {
      const el = marker.getElement();
      el.classList.remove("is-target");
      el.style.zIndex = "";
      el.style.visibility = "";
    }
    routePinsPlain = true;
    return;
  }
  routePinsPlain = false;
  target.getElement().classList.add("is-target");
  // Read every box before writing any style, so a map frame lays out once.
  const boxes = routePinMarkers.map((marker) => {
    const el = marker.getElement();
    const at = routeMap.project(marker.getLngLat());
    const w = el.offsetWidth || 0;
    const h = el.offsetHeight || 0;
    return { el, left: at.x - w / 2, right: at.x + w / 2, top: at.y - h, bottom: at.y };
  });
  const goal = boxes[routePinMarkers.indexOf(target)];
  const gap = 2;
  for (const box of boxes) {
    if (box === goal) {
      box.el.style.zIndex = "4";
      box.el.style.visibility = "";
      continue;
    }
    const covers = box.left < goal.right + gap && box.right > goal.left - gap
      && box.top < goal.bottom + gap && box.bottom > goal.top - gap;
    box.el.classList.remove("is-target");
    box.el.style.zIndex = "";
    box.el.style.visibility = covers ? "hidden" : "";
  }
}

function hookRoutePinDeclutter() {
  if (!routeMap || routePinsHooked === routeMap || typeof routeMap.on !== "function") return;
  routePinsHooked = routeMap;
  routeMap.on("move", declutterRoutePins);
}

function clearRouteMap() {
  cancelPinPeek();
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
  driveStopMeters = meters >= 0 && name ? meters : null;
  paintDrive();
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
    const span = navMatchSpan();
    let hit = matchAlong(lat, lon, path, { along: navAlongLock, bearing: navTravel, span });
    if (navResumeGuard && navAlongLock != null) hit = guardResumedHit(lat, lon, path, hit, span);
    if (hit.dist <= ON_ROAD_M) {
      navAlongLock = hit.along;
      saveNavSpot(hit.along);
    }
    return hit;
  }
  return nearestOnPath(lat, lon, path);
}

// The truck is matched only on the leg of the stop being driven to. That
// stop changes only when he picks the next one and presses Done, never
// because he drove onto another stop's line or reached this one.
function navMatchSpan() {
  const active = activeNavLeg();
  return active ? { from: active.start, to: active.end } : null;
}

// "Not on the route yet" past this distance. Right after a refresh, a truck
// parked a little way off the saved spot still gets that spot's step.
function navOffRoute(hit) {
  return hit.dist > (navResumeGuard ? RESUME_PARKED_M : 250);
}

// Right after a refresh the lock is only the saved spot. Keep matches on
// that stretch until several on-road fixes agree he is somewhere else.
function guardResumedHit(lat, lon, path, hit, span = null) {
  const guard = navResumeGuard;
  if (hit.dist <= ON_ROAD_M && inLockWindow(hit.along, navAlongLock)) {
    navResumeGuard = null;
    return hit;
  }
  const free = hit.dist <= ON_ROAD_M ? hit : nearestOnPath(lat, lon, path, span);
  // Parked beside the saved spot, not driving on off the line (the other
  // carriageway of the same turnpike).
  if (free.dist > ON_ROAD_M && Math.abs(free.along - navAlongLock) > RESUME_DRIVEN_M) {
    navResumeGuard = null;
    return free;
  }
  const fix = `${lat},${lon}`;
  if (fix !== guard.fix) {
    guard.fix = fix;
    if (free.dist > ON_ROAD_M) {
      guard.candidate = null;
      guard.count = 0;
    } else {
      const agrees = guard.candidate != null && Math.abs(free.along - guard.candidate) <= RESUME_AGREE_M;
      guard.count = agrees ? guard.count + 1 : 1;
      guard.candidate = free.along;
    }
  }
  if (guard.count >= RESUME_CONFIRM_FIXES && free.dist <= ON_ROAD_M) {
    navResumeGuard = null;
    return free;
  }
  return matchNear(lat, lon, path, navAlongLock, navTravel, span) || hit;
}

function rebuildNavLegs() {
  const built = buildNavLine(state.stops);
  navLine = built.line;
  navLegs = built.legs;
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
  paintRouteColor(coordinates.length >= 2);
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

// The page voices' mixer. iOS suspends it, or marks it "interrupted" after a
// call or another app's audio, and it stays quiet until a tap resumes it.
function readyMix() {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return null;
  if (!mixCtx || mixCtx.state === "closed") {
    const ctx = new AudioCtx();
    mixCtx = ctx;
    ctx.onstatechange = () => {
      if (ctx !== mixCtx || !navOn) return;
      if (ctx.state === "running") paintVoiceHint();
      else if ((ctx.state === "suspended" || ctx.state === "interrupted") && navVoiceId() !== "phone") relockNavVoice();
    };
  }
  if (mixCtx.state !== "running") {
    try {
      Promise.resolve(mixCtx.resume()).catch(() => {});
    } catch {
      // Still locked. The next tap tries again.
    }
  }
  return mixCtx;
}

function unlockMix() {
  preferMix();
  if (!readyMix()) return;
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

// Ends the line being spoken now. Its promise settles here too, because iOS
// does not always send onend/onerror after cancel().
let settleSpeech = null;

function stopNavUtterance() {
  if (navVoiceNode) {
    try { navVoiceNode.stop(); } catch { /* already stopped */ }
    navVoiceNode = null;
  }
  phoneUtter = null;
  window.speechSynthesis?.cancel();
  const settle = settleSpeech;
  settleSpeech = null;
  settle?.();
}

// iOS can leave a line that never sends onend (paused synth, audio taken by a
// call, page hidden). Past this, the line is dropped so the next one is not
// stuck behind it and it does not play late.
function speechWatchMs(text) {
  return 6000 + String(text || "").length * 150;
}

function playSamples(samples, rate) {
  return new Promise((resolve) => {
    preferMix();
    const ctx = samples?.length ? readyMix() : null;
    if (!ctx) {
      resolve();
      return;
    }
    const buffer = ctx.createBuffer(1, samples.length, rate);
    buffer.getChannelData(0).set(samples);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    navVoiceNode = source;
    let watch = 0;
    const done = () => {
      window.clearTimeout(watch);
      if (navVoiceNode === source) navVoiceNode = null;
      if (settleSpeech === done) settleSpeech = null;
      resolve();
    };
    settleSpeech = done;
    watch = window.setTimeout(() => {
      try { source.stop(); } catch { /* never started */ }
      done();
    }, (samples.length / rate) * 1000 + 3000);
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
  readyMix();
  const label = navVoiceLabel();
  playChosenVoice(`This is ${label}.`);
}

let phoneUtter = null;
// Kept until checkPhoneVoice reads it. Safari sends no events for an
// utterance that was garbage collected.
let phoneProbe = null;
// Last time the phone voice started or finished a line.
let phoneHeardAt = 0;
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
    clearStuckSpeech(synth);
    const utter = new SpeechSynthesisUtterance(text);
    phoneUtter = utter;
    // Do not set utter.voice. Leaving it alone uses the voice from iPhone
    // Settings, including a premium voice. Picking a localService voice
    // overrides that and sounds like a different person.
    let watch = 0;
    let started = false;
    const done = () => {
      window.clearTimeout(watch);
      if (phoneUtter === utter) phoneUtter = null;
      if (settleSpeech === done) settleSpeech = null;
      resolve();
    };
    settleSpeech = done;
    watch = window.setTimeout(() => {
      if (phoneUtter === utter) synth.cancel();
      done();
      if (!started) phoneVoiceHeld();
    }, speechWatchMs(text));
    utter.onstart = () => {
      started = true;
      phoneHeardAt = Date.now();
    };
    utter.onend = () => {
      phoneHeardAt = Date.now();
      done();
    };
    utter.onerror = (event) => {
      done();
      if (event?.error === "not-allowed") phoneVoiceHeld();
    };
    try {
      synth.speak(utter);
      synth.resume();
    } catch {
      done();
    }
  });
}

// A paused synth, or one holding a line it never finished, keeps a new
// line queued behind it, and the old one plays when iOS lets it go.
function clearStuckSpeech(synth) {
  if (!synth || !(synth.paused || synth.pending || synth.speaking)) return;
  try {
    synth.cancel();
    synth.resume();
  } catch {
    // speak() below still runs.
  }
}

// `text` can be a function. It is read just before the line is spoken.
function playChosenVoice(text, { barge = true } = {}) {
  const lineNow = () => spokenAloud(typeof text === "function" ? text() : text);
  if (typeof text !== "function" && !lineNow()) return Promise.resolve();
  if (barge) {
    speakGen += 1;
    stopNavUtterance();
    speakChain = Promise.resolve();
  }
  const gen = speakGen;
  if (barge && navVoiceId() === "phone") {
    // iOS only lets speak() start inside the tap, not after a promise hop.
    const said = lineNow();
    const job = said ? speakPhone(said, gen) : Promise.resolve();
    speakChain = job;
    return job;
  }
  const job = speakChain.then(async () => {
    if (gen !== speakGen) return;
    if (navVoiceId() === "phone") {
      const said = lineNow();
      if (said) await speakPhone(said, gen);
      return;
    }
    unlockMix();
    try {
      await warmPageVoices();
      if (gen !== speakGen) return;
      const said = lineNow();
      if (!said) return;
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
// iOS keeps a page silent after every load until a tap, and again after he
// leaves the app, takes a call, or the screen locks. The tap listener stays on
// for the whole drive: every tap quietly unlocks the voice. Only the tap that
// turns a held voice back on, or a tap on the direction he is on, says it.
let voiceGestureSeen = false;
let navVoiceMissed = false;
const VOICE_GESTURES = ["pointerdown", "touchend", "click", "keydown"];
// One tap sends pointerdown, touchend, and click. Only one of them speaks.
const VOICE_TAP_MS = 600;
let voiceTapAt = 0;
let voicePress = null;
// These say their own line when tapped.
const VOICE_OWN_LINE = "#voicePrev, #voiceNext, #startNav, #routeSwitch, [data-aim-stop]";
// Tapping the row of the step he is on says it again. Other rows and the rest
// of the directions box stay quiet.
const VOICE_REPEAT = ".dir-step[data-dir-stop]";

function unlockNavVoice() {
  // Unlock audio on this tap, then say the line in the chosen voice. The first
  // direction queues after this so it does not cut in with a different voice.
  unlockMix();
  voiceGestureSeen = true;
  navVoiceIntroPending = true;
  playChosenVoice("Navigation on.", { barge: true }).finally(() => {
    navVoiceIntroPending = false;
  });
}

function navVoiceLocked() {
  if (voiceGestureSeen) return false;
  if (navVoiceId() === "phone") return true;
  return !(mixCtx && mixCtx.state === "running");
}

function warmPhoneVoice() {
  const synth = window.speechSynthesis;
  if (!synth || typeof SpeechSynthesisUtterance !== "function") return;
  try {
    const utter = new SpeechSynthesisUtterance(" ");
    utter.volume = 0;
    synth.speak(utter);
    synth.resume();
  } catch {
    // The next spoken line tries again.
  }
}

// Dragging or pinching the map ends in a touchend too. That is not a tap.
function tapMoved(event) {
  if (event?.type !== "touchend") return false;
  // Another finger is still down: a pinch.
  if (event.touches?.length) return true;
  const press = voicePress;
  voicePress = null;
  const lift = event.changedTouches?.[0];
  if (!press || !lift) return false;
  return Boolean(press.multi) || Math.hypot(lift.clientX - press.x, lift.clientY - press.y) > 12;
}

function repeatTap(target) {
  const row = target?.closest?.(VOICE_REPEAT);
  const at = row ? currentNavStep() : null;
  return Boolean(at)
    && row.getAttribute("data-dir-stop") === at.leg.stop.id
    && Number(row.getAttribute("data-dir-index")) === at.found.index;
}

function onVoiceGesture(event) {
  if (!navOn && !navProgressResume) return;
  // Read before unlockMix: resuming the mixer clears the lock this tap is for.
  const held = navVoiceLocked();
  unlockMix();
  // A finger going down is not a tap to iOS yet. Wait for it to lift.
  if (event?.type === "pointerdown" && event.pointerType !== "mouse") {
    if (event.isPrimary === false) {
      if (voicePress) voicePress.multi = true;
    } else voicePress = { x: event.clientX, y: event.clientY, held };
    return;
  }
  const pressHeld = Boolean(voicePress?.held);
  if (event?.repeat || tapMoved(event)) return;
  const now = Date.now();
  if (now - voiceTapAt < VOICE_TAP_MS) return;
  voiceTapAt = now;
  voicePress = null;
  voiceGestureSeen = true;
  const target = event?.target;
  const ownLine = target?.closest?.(VOICE_OWN_LINE);
  const hint = target?.closest?.("#routeVoiceHint");
  const unlocked = held || pressHeld || Boolean(hint && !hint.hidden);
  if (navOn && !ownLine && (unlocked || repeatTap(target)) && sayTapLine()) {
    navVoiceMissed = false;
  } else {
    if (navVoiceId() === "phone") warmPhoneVoice();
    if (unlocked && navVoiceMissed) {
      // Lines that came due while the page could not talk were never heard.
      // Say the current direction again on the next fresh fix. Only for the
      // tap that turned the voice back on, so other taps stay quiet.
      navVoiceMissed = false;
      spokenStepKey = "";
      spokenMiles.clear();
    }
  }
  paintVoiceHint();
}

// The step the banner shows, from the latest fix even when it is older than
// NAV_FRESH_MS. A tap says it; GPS callouts still wait for a fresh fix.
let navVoiceNow = null;

function currentNavStep() {
  const now = navVoiceNow;
  const inLeg = now ? now.along - now.leg.start : 0;
  const found = now ? navStep(now.leg, Math.max(0, inLeg)) : null;
  if (!found) return null;
  return { leg: now.leg, found, meters: metersLeftInStep(now.leg, inLeg, found.index) };
}

function currentStepLine() {
  const at = currentNavStep();
  return at ? stepLine(at.leg, at.found, at.meters) : "";
}

// Says the current direction on a tap, cutting off anything playing or
// queued. Returns false when there is nothing to say.
function sayTapLine() {
  if (!navVoiceNow) {
    const title = String(document.getElementById("routeNavTitle")?.textContent || "").trim();
    if (!title) return false;
    playChosenVoice(title, { barge: true });
    return true;
  }
  const at = currentNavStep();
  if (!at || !stepLine(at.leg, at.found, at.meters)) return false;
  if (navFixFresh()) {
    // GPS fixes do not say this step again. The next mile mark still speaks.
    holdStepLine(`${at.leg.stop.id}:${at.found.index}`, at.meters / 1609.344);
  } else {
    // Said from an old spot. The next fresh fix says it with the live miles.
    spokenStepKey = "";
    spokenMiles.clear();
  }
  playChosenVoice(currentStepLine, { barge: true });
  return true;
}

function armVoiceGesture() {
  for (const type of VOICE_GESTURES) {
    document.addEventListener(type, onVoiceGesture, { capture: true, passive: true });
  }
}

function relockNavVoice() {
  if (!navOn) return;
  voiceGestureSeen = false;
  armVoiceGesture();
  paintVoiceHint();
}

// Hidden: iOS holds the audio, and whatever was queued would all play when
// he comes back. Drop it; the next line is said from where he is then.
function hushNavVoice() {
  speakGen += 1;
  speakChain = Promise.resolve();
  navVoiceIntroPending = false;
  stopNavUtterance();
}

function rewarmNavVoice() {
  if (!navOn || document.visibilityState !== "visible") return;
  if (navVoiceId() === "phone") {
    checkPhoneVoice();
    return;
  }
  if (!mixCtx) {
    relockNavVoice();
    return;
  }
  if (mixCtx.state === "running") return;
  const ctx = mixCtx;
  try {
    Promise.resolve(ctx.resume()).catch(() => {});
  } catch {
    // Checked below.
  }
  window.setTimeout(() => {
    if (!navOn || ctx !== mixCtx || ctx.state === "running") return;
    relockNavVoice();
  }, 800);
}

// The phone voice has no locked state to read. A real line that iOS refused,
// or that never started before its watchdog, while the page was showing, means
// iOS is holding the voice. Wait for a tap.
function phoneVoiceHeld() {
  if (!navOn || navVoiceId() !== "phone" || document.visibilityState !== "visible") return;
  navVoiceMissed = true;
  relockNavVoice();
}

// Wakes the phone voice on return. iOS often sends no events at all for a
// silent line even when the voice works, so a quiet probe is not proof the
// voice is held: it only drops the probe. phoneVoiceHeld decides that.
function checkPhoneVoice() {
  const synth = window.speechSynthesis;
  if (!synth || typeof SpeechSynthesisUtterance !== "function") return;
  clearStuckSpeech(synth);
  const asked = Date.now();
  try {
    const utter = new SpeechSynthesisUtterance(" ");
    utter.volume = 0;
    utter.onstart = () => { phoneHeardAt = Date.now(); };
    utter.onend = utter.onstart;
    phoneProbe = utter;
    synth.speak(utter);
    synth.resume();
  } catch {
    // Checked below.
  }
  window.setTimeout(() => {
    phoneProbe = null;
    if (!navOn || navVoiceId() !== "phone" || phoneHeardAt >= asked) return;
    if (!phoneUtter) synth.cancel();
  }, 1500);
}

function paintVoiceHint() {
  const hint = document.getElementById("routeVoiceHint");
  if (hint) hint.hidden = !(navOn && navVoiceLocked());
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
  if (navVoiceLocked() || document.visibilityState === "hidden") {
    // A clip started now would sit in the paused mixer and play late.
    navVoiceMissed = true;
    paintVoiceHint();
    return;
  }
  // Queue behind "Navigation on." so Start does not sound like two people.
  // Later turn updates still barge in and replace the line.
  playChosenVoice(text, { barge: !navVoiceIntroPending });
}

function resetNavVoice() {
  spokenStepKey = "";
  spokenTurnKey = "";
  spokenMiles.clear();
  navVoiceMissed = false;
  navVoiceNow = null;
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

function spokenApproach(nextText, metersLeft) {
  if (metersLeft / 1609.344 >= 0.1) return approachPhrase(nextText, metersLeft);
  // The turn is right there. "In 1 foot" or "in 434 feet" is noise.
  const maneuver = maneuverText(nextText);
  return maneuver ? `${maneuver.charAt(0).toUpperCase()}${maneuver.slice(1)}` : "";
}

// The map banner for the highlighted step. Same rules as the voice: under
// 0.1 mi it is just the move, never "In 1 foot".
function bannerDirection(leg, found, leftInStep, toward) {
  const next = found && leg ? upcomingDirection(leg, found.index) : "";
  const approach = next ? spokenApproach(next, leftInStep) : "";
  if (approach) return approach;
  const title = String(found?.step?.text || "").trim();
  if (!title) return `Continue to ${toward}`;
  if (leftInStep / 1609.344 >= 0.1) return directionWithMilesLeft(title, leftInStep);
  const move = maneuverText(title) || title;
  return `${move.charAt(0).toUpperCase()}${move.slice(1)}`;
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

let navVoiceHere = null;

function stepLine(leg, found, meters) {
  const next = upcomingDirection(leg, found.index);
  const text = String(found.step?.text || "").trim();
  // Under 0.1 mi with nothing ahead, this row is a stop already reached.
  return (next && spokenApproach(next, meters))
    || (text && meters / 1609.344 >= 0.1 ? directionWithMilesLeft(text, meters) : "");
}

// This step's line was said. Mile marks it is already inside are not said.
function holdStepLine(stepKey, miles) {
  spokenStepKey = stepKey;
  spokenMiles.clear();
  for (const band of [5, 4, 3, 2, 1, 0.5]) {
    if (miles <= band) spokenMiles.add(band);
  }
}

function speakNavProgress(leg, found, hereAlong) {
  if (!found || !leg?.stop?.id) return;
  navVoiceNow = { leg, along: hereAlong };
  // Not where he is now. The next fresh fix says it.
  if (!navFixFresh()) return;
  navVoiceHere = { stopId: leg.stop.id, along: hereAlong };
  const stepKey = `${leg.stop.id}:${found.index}`;
  const leftMeters = metersLeftInStep(leg, hereAlong - leg.start, found.index);
  const miles = leftMeters / 1609.344;
  const bands = [5, 4, 3, 2, 1, 0.5];
  // Miles left in this step at the latest fresh fix, or null once he is past it.
  const leftNow = () => {
    const here = navVoiceHere?.stopId === leg.stop.id ? navVoiceHere.along : hereAlong;
    if (navStep(leg, Math.max(0, here - leg.start))?.index !== found.index) return null;
    return metersLeftInStep(leg, here - leg.start, found.index);
  };
  if (stepKey !== spokenStepKey) {
    holdStepLine(stepKey, miles);
    // Read when the voice is ready to talk, from the latest fix, so a line
    // that waited on the voice still has the miles from where he is then.
    if (stepLine(leg, found, leftMeters)) speakNav(() => {
      const meters = leftNow();
      return meters == null ? "" : stepLine(leg, found, meters);
    });
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
    // A mark that waited past the next one is old news by then.
    speakNav(() => {
      const meters = leftNow();
      return meters != null && meters / 1609.344 > band - 0.4 ? said : "";
    });
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

// Full screen keeps the whole trip. On the page the chip is the drive time to
// the stop being driven to, the same hours as the ETA chip, with no delays.
// With navigation off it is the time left saved for this trip's leg, the same
// hours the Plan starts that leg with, until that stop is done or the leg changes.
let driveAlong = null;
let driveStopMeters = null;

function stopDriveText(meters) {
  if (!(meters >= 0)) return "";
  if (meters < 1) return "0 min left";
  return `${hoursLabel(hoursForMeters(meters))} left`;
}

function pageDriveText() {
  const left = navOn ? null : openLeftLeg();
  if (left) return `${hoursLabel(left.remainHours)} left`;
  return stopDriveText(nextStopMeters());
}

function nextStopMeters() {
  if (navOn) return driveStopMeters;
  const leg = buildNavLine(state.stops).legs.find(({ stop }) => stop && !stop.done && !stop.skipRoute && !stop.useCurrentLocation);
  return leg ? leg.end - leg.start : null;
}

function paintDrive(alongMeters = driveAlong) {
  driveAlong = alongMeters;
  const chip = document.getElementById("routeDrive");
  if (!chip) return;
  const text = routeFull ? driveLeftText(driveAlong) : pageDriveText();
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
  paintDrive();
  paintCompassRose();
  paintVoiceHint();
  if (state.plan) warmPageVoices();
  if (navOn) freezeTyping(true);
  else freezeTyping(false);
  syncTripNavLocks();
  syncStopCardNavLock();
  syncStepNavLock();
  requestAnimationFrame(seatRails);
}

// A Delete already busy deleting stays disabled when navigation ends.
function syncTripNavLocks() {
  const lock = navOn === true;
  document.querySelectorAll(".trips").forEach((section) => section.classList.toggle("nav-locked", lock));
  navLockControls(document.querySelectorAll("#newTrip, #saveTrip, [data-load], [data-delete]"), lock);
}

// "Choose where the trip starts" and "Set speed, hours, and when you leave",
// whatever Step number the layout gives them. #locate stays disabled while it
// is still waiting for permission.
function syncStepNavLock() {
  const lock = navOn === true;
  const controls = [];
  document.querySelectorAll('[data-block="start"], [data-block="hours"]').forEach((section) => {
    section.classList.toggle("nav-locked", lock);
    section.querySelectorAll("button, select").forEach((el) => controls.push(el));
  });
  navLockControls(controls, lock);
}

function navLockControls(controls, lock) {
  controls.forEach((el) => {
    if (lock) {
      if (!el.disabled) {
        el.disabled = true;
        el.dataset.navLock = "1";
      }
      if (!el.hasAttribute("aria-disabled")) {
        el.setAttribute("aria-disabled", "true");
        el.dataset.navAria = "1";
      }
      return;
    }
    if (el.dataset.navLock === "1") {
      delete el.dataset.navLock;
      if (!el.inert) el.disabled = false;
    }
    if (el.dataset.navAria === "1") {
      delete el.dataset.navAria;
      el.removeAttribute("aria-disabled");
    }
  });
}

// Undoes only its own disables, so a control that was already disabled for
// its own reason (delay − at 0 min, a done stop's arrows) stays disabled.
function syncStopCardNavLock() {
  const lock = navOn === true;
  document.querySelectorAll("section.stops").forEach((section) => section.classList.toggle("nav-locked", lock));
  document.querySelectorAll(".delay-box").forEach((box) => box.classList.toggle("nav-locked", lock));
  if (!lock) {
    document.querySelectorAll("[data-nav-lock], [data-nav-aria]").forEach((el) => {
      if (el.dataset.navLock === "1") {
        delete el.dataset.navLock;
        // A stop marked done mid-drive went inert and stays disabled.
        if (!el.inert) el.disabled = false;
      }
      if (el.dataset.navAria === "1") {
        delete el.dataset.navAria;
        el.removeAttribute("aria-disabled");
      }
    });
    return;
  }
  const controls = new Set();
  document.querySelectorAll(".stop-card").forEach((card) => {
    card.querySelectorAll("button, select").forEach((el) => controls.add(el));
  });
  document.querySelectorAll("[data-after], [data-before], [data-delay]").forEach((el) => controls.add(el));
  controls.forEach((el) => {
    if (!el.disabled) {
      el.disabled = true;
      el.dataset.navLock = "1";
    }
    if (!el.hasAttribute("aria-disabled")) {
      el.setAttribute("aria-disabled", "true");
      el.dataset.navAria = "1";
    }
  });
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
  railSeatObserver = new ResizeObserver(() => {
    seatRails();
    reframeFullscreenTurn();
  });
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
  const full = viewportBox();
  // Stay in the visible screen. Do not pull above the top for the notch —
  // viewport-fit=cover already paints under the status bar at top:0.
  stage.style.position = "fixed";
  stage.style.margin = "0";
  stage.style.right = "0";
  stage.style.bottom = "auto";
  stage.style.zIndex = "80";
  stage.style.left = "0px";
  stage.style.width = `${full.width}px`;
  stage.style.top = "0px";
  stage.style.height = `${Math.round(full.height)}px`;
  const box = stage.getBoundingClientRect();
  const topGap = Math.max(0, box.top);
  const leftGap = Math.max(0, box.left);
  const bottomLimit = Math.max(window.innerHeight, (view?.height || 0) + (view?.offsetTop || 0), full.height);
  const rightLimit = Math.max(window.innerWidth, (view?.width || 0) + (view?.offsetLeft || 0), full.width);
  const bottomGap = Math.max(0, bottomLimit - box.bottom);
  const rightGap = Math.max(0, rightLimit - box.right);
  if (topGap > 1 || leftGap > 1 || bottomGap > 1 || rightGap > 1) {
    stage.style.top = `${Math.round(-topGap)}px`;
    stage.style.left = `${Math.round(-leftGap)}px`;
    stage.style.width = `${Math.round(full.width + leftGap + rightGap)}px`;
    stage.style.height = `${Math.round(full.height + topGap + bottomGap)}px`;
  }
  seatRails();
  const cover = `${stage.style.width}x${stage.style.height}x${stage.style.top}`;
  if (cover !== routeCoverSize) {
    routeCoverSize = cover;
    routeMap?.resize();
    reframeFullscreenTurn();
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
    if (pinPeek) showPinPeek();
    else if (navOn && navFix && routeMap) {
      if (tripFit === "nextTurn") {
        clearTurnFrame();
        frameNextTurn();
      } else if (navFollowing && tripFit === "off") {
        const camera = { center: [navFix[1], navFix[0]], zoom: navZoom };
        const bearing = followBearing();
        if (bearing != null) camera.bearing = bearing;
        routeMap.jumpTo(camera);
      }
    }
    if (navOn && navFix && routeMap) placeNavDot(navFix[0], navFix[1]);
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
  paintDirectionToward();
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
  rememberNavProgress();
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
let stopFrameLayout = "";
let stopTargetId = "";
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
    // Fullscreen: keep a stable band for you above ETA + the open directions
    // sheet so opening the list does not yank Turn zoom.
    pad.top = Math.max(pad.top, Math.round(safeTopPad() + buttonH * 2 + 8));
    pad.bottom = Math.max(pad.bottom, Math.round(mapBox.height * 0.34));
    const minOpen = Math.max(220, Math.round(mapBox.height * 0.38));
    const maxBottom = Math.max(90, mapBox.height - minOpen);
    if (pad.bottom > maxBottom) pad.bottom = maxBottom;
    pad.bottom = Math.max(90, pad.bottom);
    pad.top = Math.min(pad.top, Math.max(48, mapBox.height - pad.bottom - 120));
    return pad;
  }
  // Page Turn zoom padding — leave this path alone.
  if (compass) {
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
  turnPin = null;
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

// MapLibre's world is 512px at zoom 0. The older 256px constant
// (156543) is twice this. Turn zoom uses this one so a screen slot
// and the truck land on the pixels we asked for.
const MERCATOR_MPP0 = 78271.516964;

function mercatorMpp(zoom, lat) {
  const cos = Math.max(0.2, Math.cos((Number(lat) || 0) * Math.PI / 180));
  return (MERCATOR_MPP0 * cos) / (2 ** zoom);
}

function zoomForPixelSpan(meters, pixels, lat) {
  const mpp = Math.max(30, meters) / Math.max(48, pixels);
  const cos = Math.max(0.2, Math.cos((Number(lat) || 0) * Math.PI / 180));
  const zoom = Math.log2((MERCATOR_MPP0 * cos) / mpp);
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

// MapLibre normally paints on requestAnimationFrame. iOS drops that frame
// when the ringer, a banner, or an app switch covers the page, and then
// ignores later paints until the next resume. redraw() paints now and
// clears the dropped frame, so the lock keeps up while the app is open.
function showNavCamera(camera) {
  if (!routeMap || !camera) return;
  routeMap.jumpTo(camera);
  if (typeof routeMap.redraw === "function") routeMap.redraw();
}

function travelBearing(along) {
  const here = pointAlong(navLine, along);
  const ahead = pointAlong(navLine, along + 50);
  if (here && ahead) return navBearing([here.lat, here.lon], [ahead.lat, ahead.lon]);
  if (typeof navTravel === "number") return navTravel;
  return routeMap?.getBearing() || 0;
}

let framingTurn = false;

function reframeFullscreenTurn() {
  if (pinPeek || framingTurn || !routeFull || tripFit !== "nextTurn" || !navOn || !navFix || !routeMap) return;
  frameNextTurn();
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
  const visibleTop = mapBox && mapBox.top < 0 ? Math.round(-mapBox.top) : 0;
  if (routeFull) {
    // Fullscreen Turn zoom: stable slots like the page. Reserve room for ETA
    // + the open directions sheet so the blue dot stays clear. Do not follow
    // rails that seatRails lifts when the sheet opens — that was shifting zoom.
    const reserve = Math.max(Math.round(height * 0.34), Math.max(pad.bottom, 110));
    let userY = height - reserve - 8;
    const safeTop = safeTopPad();
    // The next turn sits about an inch below the top of the screen, and
    // always below the notch.
    let turnY = visibleTop + Math.max(FULL_TURN_TOP_PX, Math.round(safeTop + 24));
    turnY = Math.max(visibleTop + 8, Math.min(height * 0.36, turnY));
    userY = Math.min(userY, height - Math.round(buttonH * 1.1));
    userY = Math.max(turnY + buttonH * 1.8, userY);
    return { width, height, userY, turnY, buttonH, visibleTop, safeTop };
  }
  // Page Turn zoom: the next turn sits mid-way along a line across the tops
  // of Detour and the compass. You sit just above the ETA chip.
  const shown = (el) => {
    const box = el?.getBoundingClientRect();
    return box && box.width > 2 && box.height > 2 ? box : null;
  };
  const hasMap = mapBox && mapBox.height > 10;
  const detourBox = shown(document.getElementById("routeDetour"));
  const compassBox = shown(compass);
  let turnX = width / 2;
  let turnY = Math.round(visibleTop + buttonH * 2);
  if (hasMap) {
    const ends = [detourBox, compassBox].filter(Boolean);
    if (ends.length) turnY = ends.reduce((sum, box) => sum + box.top, 0) / ends.length - mapBox.top;
    if (ends.length === 2) {
      turnX = (detourBox.left + detourBox.width / 2 + compassBox.left + compassBox.width / 2) / 2 - mapBox.left;
    }
  }
  turnY = Math.max(visibleTop + 8, turnY);
  const dotBox = shown(typeof navYou?.getElement === "function" ? navYou.getElement() : null);
  const dotR = (dotBox ? dotBox.height / 2 : 12) + NAV_DOT_HALO_PX;
  let userY = height - Math.max(pad.bottom, 24) - 12;
  if (hasMap) {
    let chip = shown(document.getElementById("routeStopMiles"));
    if (!chip) {
      chip = ["routeDrive", "routePlace"]
        .map((id) => shown(document.getElementById(id)))
        .filter(Boolean)
        .sort((a, b) => a.top - b.top)[0] || null;
    }
    const chipTop = chip ? chip.top - mapBox.top : NaN;
    if (chipTop > 0 && chipTop <= height) userY = chipTop - dotR - NAV_DOT_CHIP_GAP_PX;
  }
  userY = Math.min(userY, height - dotR - 4);
  if (userY - turnY < 48) turnY = Math.max(visibleTop + 8, userY - 48);
  return { width, height, userY, turnY, turnX, buttonH, visibleTop };
}

// The blue dot's box-shadow ring, and the gap it keeps from the ETA chip.
const NAV_DOT_HALO_PX = 6;
const NAV_DOT_CHIP_GAP_PX = 6;

// Meters forward (along bearing) and right of the truck. Coords are [lon, lat].
function stretchMeters(originLat, originLon, bearing, coords) {
  const theta = bearing * Math.PI / 180;
  const sin = Math.sin(theta);
  const cos = Math.cos(theta);
  const cosLat = Math.cos(originLat * Math.PI / 180);
  let minF = 0;
  let maxF = 0;
  let minR = 0;
  let maxR = 0;
  for (const coord of coords) {
    const lon = Number(coord?.[0]);
    const lat = Number(coord?.[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const dNorth = (lat - originLat) * Math.PI / 180 * 6378137;
    const dEast = (lon - originLon) * Math.PI / 180 * 6378137 * cosLat;
    const forward = dEast * sin + dNorth * cos;
    const right = dEast * cos - dNorth * sin;
    if (forward < minF) minF = forward;
    if (forward > maxF) maxF = forward;
    if (right < minR) minR = right;
    if (right > maxR) maxR = right;
  }
  return { minF, maxF, minR, maxR };
}

// Zoom so every point of the stretch sits above the truck, between the side
// buttons and above the directions. The truck stays on the bottom slot.
// On the page, a turn ahead is pinned to the turn slot. Road past the turn
// may use the room above it, and the zoom only goes out past the pin when
// some of the road would leave the map.
function cameraForStretch(bearing, coords, slots, turn) {
  const clear = railClearance();
  const margin = 12;
  const left = clear.left + margin;
  const rightEdge = Math.max(left + 48, slots.width - clear.right - margin);
  const pin = !routeFull && Array.isArray(turn) && Number.isFinite(slots.turnX);
  const top = pin
    ? Math.max(margin, (slots.visibleTop || 0) + margin)
    : Math.max(margin, slots.turnY);
  const aheadPx = Math.max(72, slots.userY - top - margin);
  const widePx = Math.max(48, rightEdge - left);
  const belowPx = Math.max(20, slots.height - slots.userY - margin);
  const frame = stretchMeters(navFix[0], navFix[1], bearing, coords);
  const floor = routeFull ? 70 : 110;
  const aheadM = Math.max(floor, frame.maxF);
  const behindM = Math.max(0, -frame.minF);
  const sideM = Math.max(0, frame.maxR - frame.minR);
  let mppNeed = aheadM / aheadPx;
  if (sideM > 1) mppNeed = Math.max(mppNeed, sideM / widePx);
  if (behindM > 1) mppNeed = Math.max(mppNeed, behindM / belowPx);
  if (pin) {
    const turnM = stretchMeters(navFix[0], navFix[1], bearing, [turn]).maxF;
    if (turnM > 1) mppNeed = Math.max(mppNeed, turnM / Math.max(48, slots.userY - slots.turnY));
  }
  const cos = Math.max(0.2, Math.cos(navFix[0] * Math.PI / 180));
  let zoom = Math.log2((MERCATOR_MPP0 * cos) / mppNeed);
  zoom = Math.max(3, Math.min(routeFull ? 17.2 : 16.4, zoom));
  const place = (useZoom) => {
    const mpp = mercatorMpp(useZoom, navFix[0]);
    const minTruckX = left - frame.minR / mpp;
    const maxTruckX = rightEdge - frame.maxR / mpp;
    const prefer = pin ? slots.turnX : (left + rightEdge) / 2;
    let truckX = prefer;
    if (minTruckX <= maxTruckX) truckX = Math.min(maxTruckX, Math.max(minTruckX, prefer));
    const upM = (slots.userY - slots.height / 2) * mpp;
    const rightM = (slots.width / 2 - truckX) * mpp;
    const raised = pointAhead(navFix[0], navFix[1], bearing, upM);
    const center = pointAhead(raised[0], raised[1], bearing + 90, rightM);
    return { center: [center[1], center[0]], zoom: useZoom, bearing };
  };
  let camera = place(zoom);
  // The flat-earth fit is a first guess. One real projection pass zooms out
  // if a curve still crosses a button or the top of the map.
  showNavCamera(camera);
  const box = { left, right: rightEdge, top, bottom: slots.userY + 14 };
  let overflow = 0;
  const step = Math.max(1, Math.floor(coords.length / 80));
  for (let i = 0; i < coords.length; i += step) {
    const coord = coords[i];
    if (!coord) continue;
    const p = routeMap.project(coord);
    overflow = Math.max(overflow, box.left - p.x, p.x - box.right, box.top - p.y, p.y - box.bottom);
  }
  const last = coords[coords.length - 1];
  if (last) {
    const p = routeMap.project(last);
    overflow = Math.max(overflow, box.left - p.x, p.x - box.right, box.top - p.y, p.y - box.bottom);
  }
  if (overflow > 2 && zoom > 3) {
    const shrink = aheadPx / (aheadPx + overflow);
    zoom = Math.max(3, zoom + Math.log2(Math.min(0.92, Math.max(0.45, shrink))));
    camera = place(zoom);
  }
  return camera;
}

const FULL_TURN_TOP_PX = 96;
const FULL_TURN_MAX_ZOOM = 18.5;

// Fullscreen Turn zoom. The truck stays on the bottom slot and the next turn
// lands on the top slot. The zoom only goes out past that when some of the
// road between them would leave the screen, never in.
function cameraForFullTurn(bearing, coords, turn, slots) {
  const clear = railClearance();
  const margin = 12;
  const left = clear.left + margin;
  const rightEdge = Math.max(left + 48, slots.width - clear.right - margin);
  const top = slots.visibleTop + Math.max(8, Math.round(slots.safeTop + 4));
  const roomPx = Math.max(72, slots.userY - top);
  const slotPx = Math.max(48, slots.userY - slots.turnY);
  const widePx = Math.max(48, rightEdge - left);
  const belowPx = Math.max(20, slots.height - slots.userY - margin);
  const frame = stretchMeters(navFix[0], navFix[1], bearing, coords);
  const turnM = turn ? stretchMeters(navFix[0], navFix[1], bearing, [turn]).maxF : 0;
  const aheadM = Math.max(70, frame.maxF);
  const behindM = Math.max(0, -frame.minF);
  const sideM = Math.max(0, frame.maxR - frame.minR);
  let mppNeed = aheadM / roomPx;
  if (sideM > 1) mppNeed = Math.max(mppNeed, sideM / widePx);
  if (behindM > 1) mppNeed = Math.max(mppNeed, behindM / belowPx);
  const mpp = Math.max(mppNeed, turnM / slotPx);
  const cos = Math.max(0.2, Math.cos(navFix[0] * Math.PI / 180));
  let zoom = Math.log2((MERCATOR_MPP0 * cos) / mpp);
  zoom = Math.max(3, Math.min(FULL_TURN_MAX_ZOOM, zoom));
  const place = (useZoom) => {
    const at = mercatorMpp(useZoom, navFix[0]);
    const minTruckX = left - frame.minR / at;
    const maxTruckX = rightEdge - frame.maxR / at;
    const prefer = (left + rightEdge) / 2;
    let truckX = prefer;
    if (minTruckX <= maxTruckX) truckX = Math.min(maxTruckX, Math.max(minTruckX, prefer));
    const upM = (slots.userY - slots.height / 2) * at;
    const rightM = (slots.width / 2 - truckX) * at;
    const raised = pointAhead(navFix[0], navFix[1], bearing, upM);
    const center = pointAhead(raised[0], raised[1], bearing + 90, rightM);
    return { center: [center[1], center[0]], zoom: useZoom, bearing };
  };
  let camera = place(zoom);
  // The flat-earth fit is a first guess. Real projection passes zoom out
  // only as far as a curve that still crosses a button or the screen top needs.
  const box = { left, right: rightEdge, top, bottom: slots.height - margin };
  const step = Math.max(1, Math.floor(coords.length / 80));
  for (let pass = 0; pass < 3 && zoom > 3; pass += 1) {
    routeMap.jumpTo(camera);
    const truck = routeMap.project([navFix[1], navFix[0]]);
    let scale = 1;
    // Zooming out pulls every point toward the truck by the same factor.
    const fit = (edge, from, to) => {
      if (Math.abs(to - from) < 1) return;
      const s = (edge - from) / (to - from);
      if (s > 0 && s < scale) scale = s;
    };
    const check = (coord) => {
      if (!coord) return;
      const p = routeMap.project(coord);
      if (p.y < box.top - 2) fit(box.top, truck.y, p.y);
      if (p.y > box.bottom + 2) fit(box.bottom, truck.y, p.y);
      if (p.x < box.left - 2) fit(box.left, truck.x, p.x);
      if (p.x > box.right + 2) fit(box.right, truck.x, p.x);
    };
    for (let i = 0; i < coords.length; i += step) check(coords[i]);
    check(coords[coords.length - 1]);
    if (scale >= 1) break;
    zoom = Math.max(3, zoom + Math.log2(Math.max(0.45, scale * 0.98)));
    camera = place(zoom);
  }
  return camera;
}

// Turn zoom pins two spots on the screen: your dot and the next turn. It
// stops at street level: closer in, one cloverleaf fills the screen and the
// way the turn goes is off it. Past this zoom the turn dot leaves its spot.
const TURN_PIN_MAX_ZOOM = 17;
// Road past the turn kept on screen, so the way it goes is plain: at least
// a quarter mile (an interchange ramp to its merge), half the distance to
// the turn when that is more, never over half a mile.
const TURN_PIN_AFTER_MIN_M = 400;
const TURN_PIN_AFTER_MAX_M = 800;
// Under this far from the turn, a few meters of GPS wobble would spin the
// map and send the zoom up fast. Hold the last zoom and bearing instead,
// and only let go again past TURN_PIN_HOLD_OUT_M.
const TURN_PIN_HOLD_M = 20;
const TURN_PIN_HOLD_OUT_M = 28;
// Once the turn is this far behind you, the map turns to the road you are on.
const TURN_PIN_PAST_M = 15;
// Moving the map to a new turn.
const TURN_PIN_EASE_MS = 700;

let turnPin = null;
let turnPinHooked = null;

// MapLibre's world is 512px wide at zoom 0, y grows to the south.
function mercatorWorld(lon, lat) {
  const sin = Math.sin(Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI / 180);
  return {
    x: (lon + 180) / 360 * 512,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * 512,
  };
}

function mercatorLngLat(x, y) {
  const n = Math.PI * (1 - y / 256);
  return [x / 512 * 360 - 180, Math.atan(Math.sinh(n)) * 180 / Math.PI];
}

function wrapBearing(bearing) {
  return ((((bearing + 180) % 360) + 360) % 360) - 180;
}

// Camera with `here` ([lon, lat]) on the screen spot `you` at this zoom and bearing.
function cameraAtSpot(here, you, zoom, bearing, size) {
  const world = mercatorWorld(here[0], here[1]);
  const scale = 2 ** zoom;
  const theta = bearing * Math.PI / 180;
  const dx = you.x - size.width / 2;
  const dy = you.y - size.height / 2;
  const center = mercatorLngLat(
    world.x - (dx * Math.cos(theta) - dy * Math.sin(theta)) / scale,
    world.y - (dx * Math.sin(theta) + dy * Math.cos(theta)) / scale,
  );
  return { center, zoom, bearing: wrapBearing(bearing) };
}

// Where a [lon, lat] lands on the screen under `camera`.
function spotOnCamera(camera, coord, size) {
  const at = mercatorWorld(coord[0], coord[1]);
  const mid = mercatorWorld(camera.center[0], camera.center[1]);
  const scale = 2 ** camera.zoom;
  const theta = camera.bearing * Math.PI / 180;
  const wx = (at.x - mid.x) * scale;
  const wy = (at.y - mid.y) * scale;
  return {
    x: size.width / 2 + wx * Math.cos(theta) + wy * Math.sin(theta),
    y: size.height / 2 - wx * Math.sin(theta) + wy * Math.cos(theta),
  };
}

// The one camera that puts `here` on `you` and `turn` on `spot`. The bearing
// is the map direction from you to the turn less the screen direction from
// your spot to the turn spot. The zoom makes the map distance fill the
// screen distance. Web Mercator keeps both exact at any distance or latitude.
function pinTwoPoints(here, turn, you, spot, size) {
  const a = mercatorWorld(here[0], here[1]);
  const b = mercatorWorld(turn[0], turn[1]);
  const world = Math.hypot(b.x - a.x, b.y - a.y);
  const screen = Math.hypot(spot.x - you.x, spot.y - you.y);
  if (!(world > 0) || !(screen > 0)) return null;
  const bearing = (Math.atan2(b.x - a.x, a.y - b.y) - Math.atan2(spot.x - you.x, you.y - spot.y)) * 180 / Math.PI;
  return cameraAtSpot(here, you, Math.log2(screen / world), bearing, size);
}

// How far to zoom out about your spot (1 = not at all) so every point fits the box.
function roadRoom(camera, coords, you, box, size) {
  let room = 1;
  const fit = (edge, from, to) => {
    const s = (edge - from) / (to - from);
    if (s > 0 && s < room) room = s;
  };
  for (const coord of coords) {
    if (!coord) continue;
    const p = spotOnCamera(camera, coord, size);
    if (p.y < box.top - 0.5) fit(box.top, you.y, p.y);
    if (p.y > box.bottom + 0.5) fit(box.bottom, you.y, p.y);
    if (p.x < box.left - 0.5) fit(box.left, you.x, p.x);
    if (p.x > box.right + 0.5) fit(box.right, you.x, p.x);
  }
  return Math.max(1e-4, room);
}

// Your spot, the turn spot, and the box the road must stay in, per view.
function turnPinFrame(slots) {
  const clear = railClearance();
  const margin = 12;
  const left = clear.left + margin;
  const right = Math.max(left + 48, slots.width - clear.right - margin);
  const x = routeFull ? (left + right) / 2 : (Number.isFinite(slots.turnX) ? slots.turnX : slots.width / 2);
  const box = routeFull
    ? { left, right, top: slots.visibleTop + Math.max(8, Math.round((slots.safeTop || 0) + 4)), bottom: slots.height - margin }
    : { left, right, top: Math.max(margin, (slots.visibleTop || 0) + margin), bottom: slots.userY + 14 };
  return {
    size: { width: slots.width, height: slots.height },
    you: { x, y: slots.userY },
    spot: { x, y: slots.turnY },
    box,
  };
}

// While the map moves to a new turn, the turn dot waits on its spot.
function hookTurnPinGlide() {
  if (turnPinHooked === routeMap || typeof routeMap.on !== "function") return;
  turnPinHooked = routeMap;
  routeMap.on("move", () => {
    if (!turnPin?.glide || !turnMarker || tripFit !== "nextTurn") return;
    turnMarker.setLngLat(routeMap.unproject([turnPin.glide.x, turnPin.glide.y]));
  });
  routeMap.on("moveend", () => {
    if (!turnPin?.glide) return;
    turnPin.glide = null;
    if (tripFit === "nextTurn") placeTurnPin(turnPin.target);
  });
}

// The closed form is exact for MapLibre. If the real map still lands off
// (a clamp, or a different container size), measure and fix it once.
function settleTurnPin(here, turn, you, spot) {
  const off = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);
  let p = routeMap.project(here);
  let q = turn ? routeMap.project(turn) : null;
  if (off(p, you) <= 2 && (!q || off(q, spot) <= 2)) return;
  if (q) {
    const got = Math.hypot(q.x - p.x, q.y - p.y);
    const want = Math.hypot(spot.x - you.x, spot.y - you.y);
    if (got > 0.5 && want > 0.5) {
      const turnBy = (Math.atan2(q.x - p.x, p.y - q.y) - Math.atan2(spot.x - you.x, you.y - spot.y)) * 180 / Math.PI;
      routeMap.jumpTo({ zoom: routeMap.getZoom() + Math.log2(want / got), bearing: routeMap.getBearing() + turnBy });
    }
  }
  p = routeMap.project(here);
  const canvas = routeMap.getContainer?.();
  const width = canvas?.clientWidth || 0;
  const height = canvas?.clientHeight || 0;
  if (width < 2 || height < 2) return;
  const center = routeMap.unproject([width / 2 + p.x - you.x, height / 2 + p.y - you.y]);
  routeMap.jumpTo({ center });
}

// Turn zoom: your dot and the next turn stay on their screen spots. The map
// turns, pans and zooms under them. Near the turn the zoom and bearing hold.
// After the turn, until the next one takes the spot, the map turns to the
// road you are on with your dot still on its spot.
function framePinnedTurn(along, target, at, slots) {
  const frame = turnPinFrame(slots);
  const { size, you, box } = frame;
  const here = [navFix[1], navFix[0]];
  const turn = [at.lon, at.lat];
  const left = target - along;
  // A ramp that loops back (a cloverleaf) can pass right beside the turn
  // with most of a mile still to drive. The straight line only counts once
  // the road to the turn is short too.
  const straight = metersBetween(navFix, [at.lat, at.lon]);
  const gap = left < 4 * TURN_PIN_HOLD_OUT_M ? Math.min(left, straight) : left;
  const last = turnPin && turnPin.target === target ? turnPin : null;
  const holdUnder = last?.mode === "hold" ? TURN_PIN_HOLD_OUT_M : TURN_PIN_HOLD_M;
  let mode = "pin";
  if (left < -TURN_PIN_PAST_M) mode = "past";
  else if (gap < holdUnder) mode = "hold";
  let camera = null;
  let spot = frame.spot;
  // The road to the turn and on past it, to the end of this leg.
  const afterM = Math.max(TURN_PIN_AFTER_MIN_M, Math.min(TURN_PIN_AFTER_MAX_M, 0.5 * Math.max(0, left)));
  const legEnd = activeNavLeg()?.end;
  const roadTo = Math.max(target, Math.min(Number.isFinite(legEnd) ? legEnd : Infinity, target + afterM));
  const road = () => {
    const coords = navRemaining(along, roadTo);
    coords.push(here, turn);
    return coords;
  };
  // No zoom or bearing to go on: aim at a point just ahead, then fit the road.
  const standCamera = () => {
    const toward = gap > 3 && straight > 3 ? navBearing(navFix, [at.lat, at.lon]) : travelBearing(along);
    const stand = pointAhead(navFix[0], navFix[1], Number.isFinite(toward) ? toward : 0, TURN_PIN_HOLD_M);
    const guess = pinTwoPoints(here, [stand[1], stand[0]], you, frame.spot, size);
    if (!guess) return null;
    const room = roadRoom(guess, road(), you, box, size);
    return room < 1 ? cameraAtSpot(here, you, guess.zoom + Math.log2(room), guess.bearing, size) : guess;
  };
  if (mode === "pin") {
    camera = pinTwoPoints(here, turn, you, spot, size);
    // Both dots pinned leaves nothing free. If the road to the turn, or the
    // stretch past it, would leave the box, the only give is to zoom out
    // about your dot, keeping the turn in the same direction: the turn dot
    // slides down that line toward you, just as far as the road needs, and
    // goes back once it fits. A road that runs roughly along the line and
    // fits above the turn moves neither dot.
    const room = camera ? roadRoom(camera, road(), you, box, size) : 1;
    if (camera && room < 1) {
      camera = cameraAtSpot(here, you, camera.zoom + Math.log2(room), camera.bearing, size);
      spot = { x: you.x + (spot.x - you.x) * room, y: you.y + (spot.y - you.y) * room };
    }
    if (!camera) {
      camera = standCamera();
      mode = "hold";
    }
  } else if (mode === "hold") {
    camera = last && Number.isFinite(last.zoom) && Number.isFinite(last.bearing)
      ? cameraAtSpot(here, you, last.zoom, last.bearing, size)
      : standCamera();
  } else {
    const bearing = travelBearing(along);
    const floor = routeFull ? 70 : 110;
    const coords = navRemaining(target, along + floor);
    coords.push(here, turn);
    const zoom = last && Number.isFinite(last.zoom) ? last.zoom : 17;
    camera = cameraAtSpot(here, you, zoom, Number.isFinite(bearing) ? bearing : 0, size);
    const room = roadRoom(camera, coords, you, { ...box, bottom: size.height - 12 }, size);
    if (room < 1) camera = cameraAtSpot(here, you, zoom + Math.log2(room), camera.bearing, size);
  }
  if (!camera) return null;
  let pinned = mode === "pin";
  if (camera.zoom > TURN_PIN_MAX_ZOOM) {
    camera = cameraAtSpot(here, you, TURN_PIN_MAX_ZOOM, camera.bearing, size);
    pinned = false;
  }
  // Unpinned, the turn dot shows (and waits during an ease) where the turn really is.
  if (!pinned) spot = spotOnCamera(camera, turn, size);
  // A new turn, or the map turning to the road after one: ease there with
  // your dot held on its spot. Pin and hold flow into each other, no ease.
  const now = Date.now();
  const moved = turnPin && (turnPin.target !== target || (turnPin.mode === "past") !== (mode === "past"));
  const easeUntil = moved ? now + TURN_PIN_EASE_MS : (turnPin?.easeUntil || 0);
  const newTurn = moved ? turnPin.target !== target && mode !== "past" : Boolean(turnPin?.newTurn);
  turnPin = { target, mode, zoom: camera.zoom, bearing: camera.bearing, easeUntil, newTurn, glide: null };
  return { camera, here, turn: pinned ? turn : null, you, spot, size, ease: now < easeUntil ? easeUntil - now : 0 };
}

function showPinnedTurn(shot) {
  const { camera, here, turn, you, spot, size, ease } = shot;
  if (!(ease > 0) || typeof routeMap.easeTo !== "function") {
    showNavCamera(camera);
    settleTurnPin(here, turn, you, spot);
    return;
  }
  hookTurnPinGlide();
  routeMap.stop?.();
  // Start from the zoom and bearing on screen with your dot on its spot,
  // then ease around your dot so it never leaves the spot.
  routeMap.jumpTo(cameraAtSpot(here, you, routeMap.getZoom(), routeMap.getBearing(), size));
  if (turnPin.newTurn) turnPin.glide = { x: spot.x, y: spot.y };
  routeMap.easeTo({ zoom: camera.zoom, bearing: camera.bearing, around: here, duration: ease, easing: (x) => x * (2 - x) });
}

function frameNextTurn() {
  if (!routeMap || framingTurn) return;
  framingTurn = true;
  try {
  rebuildNavLegs();
  if (!navFix || navLine.length < 2) return;
  // Seat rails above the live ETA / directions stack before reading slots.
  if (routeFull) seatRails();
  const along = turnGuideAlong();
  if (turnLockAlong == null) turnLockAlong = currentDirectionEnd(along);
  const nextAtLock = turnLockAlong == null ? null : currentDirectionEnd(turnLockAlong + 35);
  if (turnLockShouldAdvance(along, turnLockAlong, nextAtLock)) {
    const jumped = nextAtLock != null && nextAtLock > along + 20 ? nextAtLock : currentDirectionEnd(along + 20);
    if (jumped != null) turnLockAlong = jumped;
  } else if (turnLockAlong != null && along < turnLockAlong - 12) {
    const sooner = currentDirectionEnd(along);
    // Not back to a turn that would hand over again on the next fix.
    if (sooner != null && sooner + 30 < turnLockAlong
      && !turnLockShouldAdvance(along, sooner, currentDirectionEnd(sooner + 35))) turnLockAlong = sooner;
  }
  const target = turnLockAlong;
  if (target == null) return;
  const at = pointAlong(navLine, target);
  if (!at) return;
  const slots = noHandsSlots();
  if (!northLock) {
    const shot = framePinnedTurn(along, target, at, slots);
    if (!shot) return;
    placeTurnPin(target);
    turnShownAlong = target;
    placeNavDot(navFix[0], navFix[1]);
    // The camera puts this fix on your spot. Sliding the dot over from the
    // last fix would pull it off the spot for a second after every fix.
    navAim = null;
    showPinnedTurn(shot);
    return;
  }
  const ahead = target >= along - 15;
  // North lock: the map cannot turn, so only you stay on your spot.
  // Point the stretch up the screen: the line from you to the next turn,
  // not the few feet of road under the truck. A long curve aimed only at
  // the local heading runs off the side before the turn.
  let bearing = routeMap.getBearing() || 0;
  if (northLock) bearing = 0;
  else if (ahead && metersBetween(navFix, [at.lat, at.lon]) > 30) bearing = navBearing(navFix, [at.lat, at.lon]);
  else {
    const travel = travelBearing(along);
    if (Number.isFinite(travel)) bearing = travel;
  }
  if (!Number.isFinite(bearing)) bearing = 0;
  const from = Math.min(along, target);
  const to = Math.max(along, target);
  const coords = navRemaining(from, to);
  coords.push([navFix[1], navFix[0]], [at.lon, at.lat]);
  const camera = routeFull && ahead
    ? cameraForFullTurn(bearing, coords, [at.lon, at.lat], slots)
    : cameraForStretch(bearing, coords, slots, ahead ? [at.lon, at.lat] : null);
  placeTurnPin(target);
  turnShownAlong = target;
  placeNavDot(navFix[0], navFix[1]);
  navAim = null;
  // Jump, do not ease. The ease waits on a frame iOS drops when a banner
  // or an app switch covers the page, and the map then stays on the old
  // north-up view until he comes back.
  showNavCamera(camera);
  } finally {
    framingTurn = false;
  }
}

// The fit only places pins. The target's chip stands above its pin and half
// its width to each side, and your dot has a ring: both have to land inside
// the clear area between the rails, under the top bar, above ETA/directions.
// North up, the chip only reaches past the edges the target is nearest to.
function stopZoomPadding(stopId, bounds, lat, lon) {
  const base = paddingForTurnZoom(turnViewPadding(), 0).padding;
  const chip = routePinFor(stopId)?.getElement();
  const chipW = chip?.offsetWidth || 0;
  const chipH = chip?.offsetHeight || 0;
  const dot = typeof navYou?.getElement === "function" ? navYou.getElement() : null;
  const dotR = (dot?.offsetHeight || 24) / 2 + NAV_DOT_HALO_PX;
  const ring = Math.ceil(dotR) + 4;
  const wide = Math.ceil(Math.max(chipW / 2, dotR)) + 4;
  const tall = Math.ceil(Math.max(chipH, dotR)) + 4;
  const nearWest = lon - bounds.getWest() <= bounds.getEast() - lon;
  const nearNorth = bounds.getNorth() - lat <= lat - bounds.getSouth();
  const pad = {
    top: base.top + (nearNorth ? tall : ring),
    right: base.right + (nearWest ? ring : wide),
    bottom: base.bottom + ring,
    left: base.left + (nearWest ? wide : ring),
  };
  // MapLibre skips a fit whose padding leaves no room at all.
  const map = routeMap?.getContainer?.() || document.getElementById("routeMap");
  const fit = (a, b, size) => {
    const room = size - 40;
    if (!(size > 0) || pad[a] + pad[b] <= room) return;
    const k = Math.max(0, room) / (pad[a] + pad[b]);
    pad[a] = Math.floor(pad[a] * k);
    pad[b] = Math.floor(pad[b] * k);
  };
  fit("left", "right", map?.clientWidth || 0);
  fit("top", "bottom", map?.clientHeight || 0);
  return pad;
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
  const found = Boolean(stop) && Number.isFinite(lat) && Number.isFinite(lon);
  stopTargetId = found ? stop.id : "";
  declutterRoutePins();
  if (!found) return;
  const from = hit ? hit.along : 0;
  const until = Number.isFinite(leg?.end) ? leg.end : from;
  const coords = navLine.length >= 2 ? navRemaining(Math.min(from, until), until) : [];
  coords.push([here[1], here[0]], [lon, lat]);
  if (coords.length < 2) return;
  const bounds = coords.reduce(
    (box, coord) => box.extend(coord),
    new maplibre.LngLatBounds(coords[0], coords[0]),
  );
  const padding = stopZoomPadding(stop.id, bounds, lat, lon);
  const layout = [padding.top, padding.right, padding.bottom, padding.left].join(",");
  // Parked, he does not move 150 m: a new layout (full screen, directions
  // opened) still has to reframe.
  if (stopFrameAt && stopFrameId === stop.id && stopFrameLayout === layout && metersBetween(stopFrameAt, here) < 150) return;
  stopFrameAt = [here[0], here[1]];
  stopFrameId = stop.id;
  stopFrameLayout = layout;
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
  sayNav(bannerDirection(leg, found, leftInStep, targetName), `${navMiles(leftToEnd)} to ${targetName}`, "");
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

function headingGap(a, b) {
  const d = (((a - b) % 360) + 360) % 360;
  return d > 180 ? 360 - d : d;
}

// The phone's GPS heading is noise when the truck is stopped or creeping.
function movingGpsHeading(heading, speed) {
  if (typeof heading !== "number" || !Number.isFinite(heading) || heading < 0 || heading > 360) return null;
  if (typeof speed !== "number" || !Number.isFinite(speed) || speed <= GPS_MOVING_MPS) return null;
  return heading % 360;
}

function fixMotion(pos) {
  const coords = pos?.coords || {};
  return { heading: coords.heading, speed: coords.speed, accuracy: coords.accuracy };
}

// Bearing from the nearest fix 50 m or more back on the track to the newest
// fix. Jitter while parked never spans that far; fixes whose error is large
// next to the span are skipped. A stretch where he went past where he is now
// and came back is a turnaround, not a heading.
function trackHeading(track = navTrack) {
  const newest = track[track.length - 1];
  if (!newest) return null;
  const at = [newest.lat, newest.lon];
  const east = 111320 * Math.cos(newest.lat * Math.PI / 180);
  const xy = (fix) => [(fix.lon - newest.lon) * east, (fix.lat - newest.lat) * 111320];
  const turnM = Math.max(TRACK_TURN_M, newest.acc || 0);
  let near = null;
  for (let i = track.length - 2; i >= 0; i -= 1) {
    const older = track[i];
    const [ax, ay] = xy(older);
    const span = Math.hypot(ax, ay);
    if (span > TRACK_FAR_M) break;
    if (span < TRACK_MIN_M) continue;
    if ((older.acc || 0) + (newest.acc || 0) > span * 0.5) continue;
    const ux = -ax / span;
    const uy = -ay / span;
    let overshoot = 0;
    for (let j = i + 1; j < track.length - 1; j += 1) {
      const [x, y] = xy(track[j]);
      overshoot = Math.max(overshoot, (x - ax) * ux + (y - ay) * uy - span);
    }
    if (overshoot > turnM) return near || { bearing: null, turned: true };
    const bearing = navBearing([older.lat, older.lon], at);
    if (span >= TRACK_SPAN_M) return { bearing };
    near ||= { bearing };
  }
  return near;
}

function noteNavTrack(lat, lon, at = Date.now(), motion = null) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
  const last = navTrack[navTrack.length - 1];
  if (last && at <= last.at) return;
  const acc = Number(motion?.accuracy);
  navTrack.push({ lat, lon, at, acc: Number.isFinite(acc) && acc > 0 ? acc : 0 });
  while (navTrack.length > TRACK_MAX_FIXES || (navTrack.length > 1 && at - navTrack[0].at > TRACK_KEEP_MS)) navTrack.shift();
  const seen = trackHeading(navTrack);
  const gps = movingGpsHeading(motion?.heading, motion?.speed);
  if (seen?.bearing != null) navHeadingGood = { bearing: seen.bearing, at, lat, lon, source: "track" };
  else if (gps != null) navHeadingGood = { bearing: gps, at, lat, lon, source: "gps" };
  else if (seen?.turned) navHeadingGood = null;
}

// Which way he is driving: his last stretch of track, then a moving GPS
// heading, then the last good heading if it is recent and near. Never the
// compass; that is which way the phone faces.
function travelHeading(here, now = Date.now()) {
  const point = [here.lat, here.lon];
  const newest = navTrack[navTrack.length - 1];
  if (newest && now - newest.at <= TRACK_FRESH_MS && metersBetween([newest.lat, newest.lon], point) <= TRACK_MIN_M) {
    const seen = trackHeading(navTrack);
    if (seen?.bearing != null) return { bearing: seen.bearing, source: "track", reliable: true };
  }
  const gps = movingGpsHeading(here.gpsHeading, here.speed);
  if (gps != null) return { bearing: gps, source: "gps", reliable: true };
  const good = navHeadingGood;
  if (good && now - good.at <= HEADING_KEEP_MS && metersBetween([good.lat, good.lon], point) <= HEADING_MOVED_M) {
    return { bearing: good.bearing, source: "last", reliable: now - good.at <= HEADING_TRUST_MS };
  }
  return null;
}

// The saved line's bearing under him, only when he is on it, on the leg of
// the stop being driven to.
function routeBearingUnder(lat, lon) {
  if (navLine.length < 2 || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const hit = navNearest(lat, lon, navLine);
  if (!(hit.dist <= ROUTE_ON_M)) return null;
  const span = navMatchSpan();
  if (span && (hit.along < span.from - 1 || hit.along > span.to + 1)) return null;
  const at = pointAlong(navLine, hit.along);
  const ahead = pointAlong(navLine, hit.along + 50);
  if (!at || !ahead || metersBetween([at.lat, at.lon], [ahead.lat, ahead.lon]) < 5) return null;
  return { bearing: navBearing([at.lat, at.lon], [ahead.lat, ahead.lon]), along: hit.along, span };
}

// No track heading yet: an earlier fix on the same line further back means
// he is going the way it runs.
function forwardOnRoute(here, under) {
  for (let i = navTrack.length - 1; i >= 0; i -= 1) {
    const fix = navTrack[i];
    if (metersBetween([fix.lat, fix.lon], [here.lat, here.lon]) < 10) continue;
    const hit = nearestOnPath(fix.lat, fix.lon, navLine, under.span);
    return hit.dist <= ROUTE_ON_M && hit.along < under.along - 5;
  }
  return false;
}

// The course for a route from where he is. No course beats a wrong one.
function travelCourse(here, now = Date.now()) {
  const heading = travelHeading(here, now);
  const under = routeBearingUnder(here.lat, here.lon);
  if (under && heading && headingGap(under.bearing, heading.bearing) <= ROUTE_AGREE_DEG) {
    return { course: under.bearing, travel: heading.bearing, reliable: heading.reliable, source: "route" };
  }
  if (heading) return { course: heading.bearing, travel: heading.bearing, reliable: heading.reliable, source: heading.source };
  if (under && forwardOnRoute(here, under)) {
    return { course: under.bearing, travel: under.bearing, reliable: false, source: "route" };
  }
  return { course: undefined, travel: undefined, reliable: false, source: "none" };
}

function askPosition(maximumAge, timeout) {
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      resolve(null);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        at: fixTime(pos),
        gpsHeading: pos.coords.heading,
        speed: pos.coords.speed,
        accuracy: pos.coords.accuracy,
      }),
      () => resolve(null),
      { enableHighAccuracy: true, maximumAge, timeout },
    );
  });
}

// `fresh`: a route from here must not start from a fix taken a minute ago.
async function currentFix({ fresh = false } = {}) {
  if (navFix && (!fresh || navFixFresh())) return { lat: navFix[0], lon: navFix[1] };
  const got = await askPosition(fresh ? 2000 : 4000, fresh ? 10000 : 15000);
  if (got) {
    if (fresh) noteNavTrack(got.lat, got.lon, got.at, { heading: got.gpsHeading, speed: got.speed, accuracy: got.accuracy });
    return got;
  }
  return navFix ? { lat: navFix[0], lon: navFix[1] } : null;
}

// Where the first stretch of a returned path heads.
function pathStartBearing(points) {
  const path = (Array.isArray(points) ? points : [])
    .map((pair) => [Number(pair?.[0]), Number(pair?.[1])])
    .filter((pair) => Number.isFinite(pair[0]) && Number.isFinite(pair[1]));
  if (path.length < 2) return null;
  const length = polylineMeters(path);
  if (length < 30) return null;
  const end = pointAlong(path, Math.min(START_CHECK_M, length));
  return navBearing(path[0], [end.lat, end.lon]);
}

function startsBackwards(leg, travel) {
  const start = pathStartBearing(leg?.points);
  return start != null && headingGap(start, travel) > START_BACKWARDS_DEG;
}

// A leg routed from a point ahead of him, joined back to where he is: the
// line starts at him, and the gap is added to the miles, time and first row.
function joinLegFrom(here, leg) {
  const points = Array.isArray(leg?.points) ? leg.points : [];
  if (!points.length) return leg;
  const gap = metersBetween([here.lat, here.lon], points[0]);
  if (!(gap > 1)) return leg;
  const gapMiles = gap / 1609.344;
  const miles = Number(leg.miles) || 0;
  const hours = Number(leg.hours) || 0;
  const mph = miles > 0 && hours > 0 ? miles / hours : 25;
  const directions = Array.isArray(leg.directions)
    ? leg.directions.map((step, index) => (index === 0 && Number.isFinite(Number(step?.miles))
      ? { ...step, miles: Math.round((Number(step.miles) + gapMiles) * 10) / 10 }
      : step))
    : leg.directions;
  return { ...leg, points: [[here.lat, here.lon], ...points], miles: miles + gapMiles, hours: hours + gapMiles / mph, directions };
}

// One request. Only when it starts back the way he came, and his heading is
// sure, one more from a point ahead of him on that heading.
async function routeFromHere(here, to) {
  const pick = travelCourse(here);
  const from = { lat: here.lat, lon: here.lon };
  const leg = await routeTruckLeg(from, to, pick.course, { avoidUTurns: true });
  if (typeof pick.course !== "number" || !pick.reliable || !startsBackwards(leg, pick.travel)) return { leg, pick };
  if (!state.unlimited && leg?.credits != null && Number(leg.credits) <= 0) return { leg, pick };
  const [aheadLat, aheadLon] = pointAhead(here.lat, here.lon, pick.travel, AHEAD_ORIGIN_M);
  try {
    const retry = await routeTruckLeg({ lat: aheadLat, lon: aheadLon }, to, pick.course, { avoidUTurns: true });
    if (!startsBackwards(retry, pick.travel)) return { leg: joinLegFrom(here, retry), pick };
    return { leg: retry?.credits != null ? { ...leg, credits: retry.credits } : leg, pick };
  } catch (error) {
    return { leg: error?.credits != null ? { ...leg, credits: error.credits } : leg, pick };
  }
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

// Added since the last route: no leg on the map and no saved miles.
function stopUnrouted(stop) {
  return !stopHasSavedLeg(stop) && !(Array.isArray(stop?.path) && stop.path.length >= 2);
}

// Recalculate drives to the first stop still ahead. A stop added since the
// last route has no leg yet, so it is never passed over on the way to a later one.
function recalcTarget() {
  const routed = upcomingRoutedStop();
  const end = routed ? state.stops.indexOf(routed) : state.stops.length;
  const added = state.stops.slice(0, end).filter((stop, index) => (
    !stop.useCurrentLocation && !stop.done && !stop.skipRoute && !isOriginStop(state.stops, index) && stopUnrouted(stop)
  ));
  const unready = added.find((stop) => !pointReady(stop));
  if (unready) return { unready };
  return { stop: added[0] || routed };
}

// After a stop that had no route, the legs start at it: each one up to and
// including the first stop that was already routed.
function legsOnFrom(stop) {
  const legs = [];
  let from = stopPoint(stop);
  for (let i = state.stops.indexOf(stop) + 1; from && i < state.stops.length; i += 1) {
    const next = state.stops[i];
    if (next.useCurrentLocation || next.skipRoute || next.done) continue;
    const to = stopPoint(next);
    if (!to) break;
    legs.push({ stop: next, from, to });
    if (!stopUnrouted(next)) break;
    from = to;
  }
  return legs;
}

// The page's Recalculate starts where he is, as the map's Recalculate does: a
// Current location start, and the stops before the first one still ahead are
// behind him.
function startRecalcHere(here) {
  const saved = readNavProgress();
  const kept = state.stops.filter((stop) => !stop.useCurrentLocation);
  const ahead = kept.findIndex((stop) => (
    !stop.skipRoute && !stop.done && !isOriginStop(state.stops, state.stops.indexOf(stop))
  ));
  if (ahead < 0) return;
  kept.slice(0, ahead).forEach(passStop);
  state.origin = { lat: here.lat, lon: here.lon };
  if (!state.stops[0]?.useCurrentLocation) {
    state.stops = [
      defaultStop({ name: "Current location", useCurrentLocation: true, lat: here.lat, lon: here.lon, address: "" }),
      ...kept,
    ];
  }
  rememberOrigin();
  carryNavProgress(saved, null);
  persist();
}

function passStop(stop) {
  stop.skipRoute = true;
  stop.miles = "";
  stop.hours = "";
  stop.path = [];
  stop.directions = [];
}

function applyAheadLeg(here, stopId, leg) {
  const kept = state.stops.filter((stop) => !stop.useCurrentLocation);
  const chosenPos = kept.findIndex((stop) => stop.id === stopId);
  if (chosenPos < 0) return false;
  kept.forEach((stop, index) => {
    const behind = index < chosenPos && (stop.done || stop.skipRoute
      || isOriginStop(state.stops, state.stops.indexOf(stop)) || !stopUnrouted(stop));
    if (behind) passStop(stop);
    else stop.skipRoute = false;
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
  const here = await currentFix({ fresh: true });
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
  const { stop: target, unready } = recalcTarget();
  if (unready) {
    abortRecalc(`Press lookup address on ${cardTitle(state.stops.indexOf(unready), state.stops)} and choose an address before pressing Recalculate.`);
    return;
  }
  if (!target) {
    abortRecalc("No stop ahead to recalculate.");
    return;
  }
  if (!state.unlimited && state.credits === 0) {
    abortRecalc(creditEmptyMessage());
    return;
  }
  const added = stopUnrouted(target);
  const onward = added ? legsOnFrom(target) : [];
  if (onward.length && !state.unlimited && Number.isFinite(Number(state.credits)) && state.credits < 1 + onward.length) {
    abortRecalc("Not enough credits to put the stop you added on the route.");
    return;
  }
  const name = navStopTitle(target);
  let leg;
  const onwardLegs = [];
  try {
    const routed = await routeFromHere(here, { lat: Number(target.lat), lon: Number(target.lon) });
    leg = routed.leg;
    here.heading = routed.pick.course;
    for (const step of onward) onwardLegs.push(await routeTruckLeg(step.from, step.to, undefined, { avoidUTurns: true }));
  } catch (error) {
    if (error.credits != null) state.credits = error.credits;
    abortRecalc(error.message || `Could not get a HERE© ${transportModeTitle().toLowerCase()} route.`);
    return;
  }
  if (!applyAheadLeg(here, target.id, leg)) {
    abortRecalc("No stop ahead to recalculate.");
    return;
  }
  onward.forEach((step, index) => writeRoutedLeg(step.stop, onwardLegs[index]));
  if (added && navAimStopId && navAimStopId !== target.id) {
    navAimStopId = target.id;
    rememberNavProgress();
  }
  clearDriveProgress();
  clearDirectionPin();
  directionsAutoKey = "";
  spokenStepKey = "";
  spokenMiles.clear();
  state.estimating = false;
  state.notice = `${transportRouteNote().replace(/\.$/, "")} to ${name}.`;
  await calculate({ silent: true, keepScreen: true });
  // keepScreen can skip a full redraw — force the new line + live direction.
  if (routeMap) paintLiveRoute();
  else refillDirections();
  if (navOn && navFix) paintLiveDirections();
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
  const transportMode = activeTransportMode();
  const run = (routingMode) => truckRoute(from, to, {
    speedCapMph: transportMode === "truck" && state.settings.governed ? mph() : null,
    departAt: leaveAtNow(),
    ...(typeof course === "number" ? { course } : {}),
    ...(options.avoidUTurns ? { avoidUTurns: true } : {}),
    transportMode,
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

// Name · miles ahead · miles off the route. No city or state.
function truckLabelParts(hit) {
  const ahead = Number.isFinite(Number(hit.milesAhead)) ? `${formatMiles(hit.milesAhead)} ahead` : "";
  const off = Number.isFinite(Number(hit.milesOff)) ? `${formatMiles(hit.milesOff)} off the route` : "";
  return [hit.name || "Place", ahead, off].filter(Boolean);
}

function truckNoteText(hit) {
  return truckLabelParts(hit).join(" · ");
}

function clearTruckPins() {
  for (const marker of truckMarkers) marker.remove();
  truckMarkers = [];
  truckMarker = null;
}

// Only the chosen place gets the box; the others are numbered dots, so boxes never pile up.
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
    if (chosen) {
      const label = document.createElement("span");
      label.className = "truck-pin-label";
      const text = document.createElement("span");
      text.className = "truck-pin-text";
      truckLabelParts(hit).forEach((part, at) => {
        if (at) text.append(" · ");
        const piece = document.createElement("span");
        piece.textContent = at === 0 && many ? `${index + 1}. ${part}` : part;
        text.append(piece);
      });
      label.append(text);
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
      wrap.append(label);
    }
    const pin = document.createElement("span");
    pin.className = many ? "truck-pin is-num" : "truck-pin";
    if (many) pin.textContent = String(index + 1);
    wrap.append(pin);
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
  seatTruckLabel();
}

// The chosen box flips under its pin when above it would run under Search here / Clear or off the map.
function seatTruckLabel() {
  const wrap = document.querySelector(".truck-pin-wrap.is-chosen");
  const label = wrap?.querySelector(".truck-pin-label");
  const map = document.getElementById("routeMap");
  if (!wrap || !label || !map) return;
  const tools = document.getElementById("routePlaceTools")?.getBoundingClientRect();
  const mapTop = map.getBoundingClientRect().top;
  const ceiling = tools && tools.height > 0 ? Math.max(mapTop, tools.bottom) : mapTop;
  const pinTop = wrap.getBoundingClientRect().top;
  wrap.classList.toggle("is-below", pinTop - label.offsetHeight - 4 < ceiling + 8);
}

// The page list only. Full screen shows the places on the pins, never in a list.
function fillPagePlaceList() {
  const list = document.getElementById("nextPlaceList");
  if (!list) return;
  list.replaceChildren();
  const show = placeListMode && truckHits.length > 0;
  list.hidden = !show;
  if (!show) return;
  truckHits.forEach((hit, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `flag-box${hit === truckHit ? " on" : ""}`;
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
  fillPagePlaceList();
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
  cancelPinPeek();
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

// Capture phase on the map, before the pin's own tap handler chooses the place.
// Only map pins get here; the page list under the map does not zoom.
function onRouteMapClick(event) {
  const wrap = event.target?.closest?.(".truck-pin-wrap");
  if (!wrap) return;
  if (event.target.closest(".truck-pin-add")) {
    cancelPinPeek();
    return;
  }
  const at = truckMarkers.findIndex((marker) => marker.getElement() === wrap);
  const pinned = truckHits.filter((hit) => Number.isFinite(Number(hit.lat)) && Number.isFinite(Number(hit.lon)));
  if (pinned[at]) peekTruckHit(pinned[at]);
}

// A tapped result pin: about half a mile around it for 5 s, then back to the
// zoom mode he was in. navZoomHold keeps GPS fixes off the camera meanwhile.
function peekTruckHit(hit) {
  if (!routeMap || state.estimating) return;
  if (!pinPeek) {
    const center = routeMap.getCenter();
    pinPeek = {
      map: routeMap,
      navOn,
      tripFit,
      navFollowing,
      camera: {
        center: [center.lng, center.lat],
        zoom: routeMap.getZoom(),
        bearing: routeMap.getBearing(),
        pitch: typeof routeMap.getPitch === "function" ? routeMap.getPitch() : 0,
      },
    };
  }
  window.clearTimeout(pinPeek.timer);
  // A direction tap's return would reframe Turn zoom in the middle of the 5 s.
  if (dirPinTimer) clearDirectionPin();
  pinPeek.hit = hit;
  pinPeek.until = Date.now() + PIN_PEEK_MS;
  navZoomHold = pinPeek.until;
  pinPeek.timer = window.setTimeout(endPinPeek, PIN_PEEK_MS);
  showPinPeek();
}

// The clear area Turn and Stop zoom use, also below Search here / Clear.
function pinPeekPadding() {
  const pad = { ...paddingForTurnZoom(turnViewPadding(), 0).padding };
  const map = routeMap?.getContainer?.() || document.getElementById("routeMap");
  const mapTop = map?.getBoundingClientRect?.().top || 0;
  const tools = document.getElementById("routePlaceTools")?.getBoundingClientRect();
  if (tools && tools.height > 0) pad.top = Math.max(pad.top, Math.round(tools.bottom - mapTop + 8));
  // MapLibre skips a fit whose padding leaves no room at all.
  const fit = (a, b, size) => {
    const room = size - 40;
    if (!(size > 0) || pad[a] + pad[b] <= room) return;
    const k = Math.max(0, room) / (pad[a] + pad[b]);
    pad[a] = Math.floor(pad[a] * k);
    pad[b] = Math.floor(pad[b] * k);
  };
  fit("left", "right", map?.clientWidth || 0);
  fit("top", "bottom", map?.clientHeight || 0);
  return pad;
}

function showPinPeek() {
  const maplibre = window.maplibregl;
  const lat = Number(pinPeek?.hit?.lat);
  const lon = Number(pinPeek?.hit?.lon);
  if (!routeMap || !maplibre || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
  const dLat = PIN_PEEK_M / 111320;
  const dLon = PIN_PEEK_M / (111320 * Math.max(0.2, Math.cos(lat * Math.PI / 180)));
  const bounds = new maplibre.LngLatBounds([lon - dLon, lat - dLat], [lon + dLon, lat + dLat]);
  routeMap.stop();
  routeMap.fitBounds(bounds, { padding: pinPeekPadding(), bearing: 0, duration: 600 });
}

function cancelPinPeek() {
  if (!pinPeek) return;
  window.clearTimeout(pinPeek.timer);
  if (navZoomHold === pinPeek.until) navZoomHold = 0;
  pinPeek = null;
}

function endPinPeek() {
  const peek = pinPeek;
  if (!peek) return;
  pinPeek = null;
  // A drag, a zoom, or a stop pick moved the hold: that action owns the map now.
  if (navZoomHold !== peek.until) return;
  navZoomHold = 0;
  if (!routeMap || routeMap !== peek.map || navOn !== peek.navOn || tripFit !== peek.tripFit
    || navFollowing !== peek.navFollowing || state.estimating || !truckHits.includes(peek.hit)) return;
  routeMap.stop();
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
  if (tripFit === "nextTurn") {
    clearTurnFrame();
    if (navFix) frameNextTurn();
    return;
  }
  if (navFollowing && navFix) {
    routeMap.jumpTo({ center: [navFix[1], navFix[0]], zoom: navZoom, bearing: followBearing() ?? peek.camera.bearing });
    return;
  }
  routeMap.jumpTo(peek.camera);
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
  cancelPinPeek();
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
  const here = await currentFix({ fresh: true });
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
  const course = travelCourse(here).course;
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
  navTrack = [];
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

function fixTime(pos) {
  const at = Number(pos?.timestamp);
  const now = Date.now();
  // A fix stamped by a wrong clock must not keep the voice quiet.
  return Number.isFinite(at) && at <= now + 60000 && now - at < 86400000 ? at : now;
}

function navFixFresh() {
  return Date.now() - navFixTime <= NAV_FRESH_MS;
}

// `at` is when the GPS took this fix. Repaints of the fix already shown pass none.
function onNavFix(lat, lon, at = null) {
  const maplibre = window.maplibregl;
  if (!routeMap || !maplibre || !navOn) return;
  if (at != null) {
    // Older than the fix on screen: a cached one. It would pull him back.
    if (at <= navFixTime) return;
    navFixTime = at;
  }
  navFixAt = Date.now();
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
  navVoiceNow = null;
  if (navLine.length < 2) {
    paintDrive(null);
    setStopChip(-1, "");
    paintSwitchOffer(null);
    sayNav("No road line yet", "Calculate the trip, then start navigation again.", "");
  } else {
    const hit = navNearest(lat, lon, navLine);
    paintDrive(hit.along);
    const off = navOffRoute(hit);
    const raw = navLegs.find((item) => hit.along >= item.start && hit.along <= item.end) || navLegs[navLegs.length - 1];
    const leg = activeNavLeg(hit);
    const gap = leg ? Math.max(0, leg.start - hit.along) : 0;
    const alongInLeg = leg ? Math.max(0, hit.along - leg.start) : 0;
    const found = leg && (!off || raw?.stop?.done) ? navStep(leg, alongInLeg) : null;
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
      const away = Math.min(hit.dist, nearestOnPath(lat, lon, navLine, navMatchSpan()).dist);
      setStopChip(-1, "");
      sayNav("Not on the route yet", `${navMiles(away)} from the line`, `${navMiles(leftOnTrip)} left in the trip`);
      paintNavLine(0, until);
      clearStopNote(true);
    } else {
      const leftInStep = (found && leg ? metersLeftInStep(leg, alongInLeg, found.index) : 0) + gap;
      setStopChip(leftOnLeg, toward);
      trackLiveDrive(hit, leg);
      sayNav(bannerDirection(leg, found, leftInStep, toward), towardPhrase, `${navMiles(leftOnTrip)} left in the trip`);
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
  paintDirectionToward();
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
  armDirectionReturn();
}

function resumeNavIfNeeded() {
  if (!navBootReady || navOn || !navProgressResume) return;
  const saved = readNavProgress();
  if (!saved?.nav || saved.tripKey !== tripProgressKey()) {
    navProgressResume = false;
    return;
  }
  const routed = (state.stops || []).some((stop) => (
    (Array.isArray(stop?.path) && stop.path.length > 1)
    || (Array.isArray(stop?.directions) && stop.directions.length)
  ));
  if (!routed) return;
  navProgressResume = false;
  void beginRouteNav({ resume: true });
}

function endRouteNav({ paint = true } = {}) {
  saveLeftLeg();
  navOn = false;
  leaveNavSession();
  endNavProgress();
  followPinned = false;
  navAimStopId = "";
  clearDirectionPin();
  railMenu = "";
  northLock = false;
  compassAim = false;
  navAlongLock = null;
  navResumeGuard = null;
  navSpotSavedAlong = null;
  navLineKey = "";
  navStopPicked = false;
  navGuideFromId = "";
  navStopAnnounce = false;
  navStopAwaitNear = false;
  navStopSpeakKey = "";
  clearStopNote(true);
  directionsAutoKey = "";
  setStopChip(-1, "");
  clearLiveDrive();
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
    paintRouteColor();
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
  syncTripNavLocks();
  focusDirectionWindow(null, null);
  document.querySelectorAll("[data-dir-stop]").forEach((button) => {
    const stopId = button.getAttribute("data-dir-stop");
    const index = Number(button.getAttribute("data-dir-index"));
    const link = button.querySelector(".dir-link");
    if (link) link.textContent = shownDirection(directionStep(stopId, index), { text: nextManeuverText(stopId, index) });
  });
  if (!paint) return;
  if (routeFull) routePageStale = true;
  else render();
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
  box.addEventListener("toggle", () => {
    if (!routeFull) return;
    requestAnimationFrame(() => reframeFullscreenTurn());
  });
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

async function beginRouteNav({ resume = false } = {}) {
  navOn = true;
  rememberNavProgress();
  navPulseAt = 0;
  void keepNavSignedIn();
  navAlongLock = null;
  navResumeGuard = null;
  navSpotSavedAlong = null;
  navLineKey = routeProgressKey(routePoints());
  if (resume) restoreNavSpot();
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

function snapNavLock() {
  if (!navOn || !routeMap || !navFix || document.visibilityState === "hidden") return;
  if (Date.now() < navZoomHold) return;
  if (tripFit === "nextTurn") {
    frameNextTurn();
    return;
  }
  if (navFollowing && tripFit === "off" && !navMapTouch) {
    const camera = { center: [navFix[1], navFix[0]], zoom: routeMap.getZoom() };
    const bearing = followBearing();
    if (bearing != null) camera.bearing = bearing;
    showNavCamera(camera);
  }
}

function restartNavWatch() {
  if (!navigator.geolocation || !navOn) return;
  if (navWatch != null) {
    navigator.geolocation.clearWatch(navWatch);
    navWatch = null;
  }
  startNavWatch();
}

function pokeNavFix() {
  if (!navigator.geolocation || !navOn) return;
  const asked = Date.now();
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      if (!navOn) return;
      if (navFixAt > asked + 500) return;
      noteNavTrack(pos.coords.latitude, pos.coords.longitude, fixTime(pos), fixMotion(pos));
      onNavFix(pos.coords.latitude, pos.coords.longitude, fixTime(pos));
    },
    () => {},
    { enableHighAccuracy: true, maximumAge: 1500, timeout: 4000 },
  );
}

// iOS delivers the caught-up map only after the app is shown again, because
// the camera ease was waiting on a frame that never ran. Wake the lock on
// resume, and also while the page stays visible, so it does not sit there.
function wakeNavLock() {
  if (!navOn || document.visibilityState === "hidden") return;
  const now = Date.now();
  if (now - navWakeAt < 400) return;
  navWakeAt = now;
  if (!navFixAt || now - navFixAt > 2000) {
    restartNavWatch();
    pokeNavFix();
  }
  if (routeFull) fitRouteCover();
  else routeMap?.resize();
  snapNavLock();
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
      noteNavTrack(pos.coords.latitude, pos.coords.longitude, fixTime(pos), fixMotion(pos));
      onNavFix(pos.coords.latitude, pos.coords.longitude, fixTime(pos));
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
    navResumeGuard = null;
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
  paintDirectionToward();
  const leftOnLeg = Math.max(0, leg.end - hit.along);
  setStopChip(leftOnLeg, navStopTitle(leg.stop));
  paintSwitchOffer(hit);
}

const DIR_RETURN_MS = 5000;

function returnFromDirectionTap() {
  dirPinTimer = 0;
  navReturnTimer = 0;
  dirPinned = null;
  navZoomHold = 0;
  navMapTouch = false;
  if (!navOn || !navFix) return;
  onNavFix(navFix[0], navFix[1]);
}

function armDirectionReturn() {
  window.clearTimeout(dirPinTimer);
  navZoomHold = Date.now() + DIR_RETURN_MS;
  dirPinTimer = window.setTimeout(returnFromDirectionTap, DIR_RETURN_MS);
}

function clearDirectionPin() {
  dirPinned = null;
  window.clearTimeout(dirPinTimer);
  dirPinTimer = 0;
  window.clearTimeout(navReturnTimer);
  navReturnTimer = 0;
}

function pinDirection(stopId, index) {
  dirPinned = { stopId, index: Number(index) };
  armDirectionReturn();
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
      paint: { "line-color": ROUTE_CASING_COLOR, "line-width": 7 },
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
      id: "left-casing",
      type: "line",
      source: "left",
      paint: { "line-color": ROUTE_CURRENT_CASING, "line-width": 9 },
    });
    map.addLayer({
      id: "left",
      type: "line",
      source: "left",
      paint: { "line-color": ROUTE_CURRENT_COLOR, "line-width": 6 },
    });
    syncStreetTheme(true);
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
    el.addEventListener("click", onRouteMapClick, { capture: true });
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
    map.on("move", seatTruckLabel);
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
    pins.push({ id: stop.id, lat, lon, label, rgb: stopColor(index, state.stops) });
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
  paintLiveDriveChips();
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
  if ((!state.settings.leaveNow && !liveLegProgress()) || !state.plan || state.estimating) return;
  const before = planShape(state.plan);
  const result = rebuiltPlan();
  if (!result || result.error) return;
  const shapeChanged = planShape(result) !== before;
  state.plan = result;
  const typing = Boolean(state.picker) || Boolean(document.activeElement?.matches?.("input, textarea, select"));
  if (!shapeChanged && paintPlanClocks()) return;
  if (routeFull || navOn || typing) {
    if (shapeChanged && (routeFull || navOn)) routePageStale = true;
    // Navigating on the page: swap in the plan's cards without touching the map.
    if (!paintPlanClocks() && navOn && !routeFull && !typing) patchPlanAfterDone();
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

// Where the truck is on the leg it is driving now, as a share of that leg.
let liveDrive = null;
let liveDrivePaintAt = 0;
let liveDrivePaintAlong = NaN;
const LIVE_DRIVE_MS = 30000;
const LIVE_DRIVE_M = 1609.344;

function isDriveChip(event) {
  return event?.kind === "lead" || event?.kind === "stop";
}

function trackLiveDrive(hit, leg) {
  const stop = leg?.stop;
  if (!stop?.id || stop.skipRoute || stop.done || !Number.isFinite(hit?.along)) return;
  const span = Math.max(1, leg.end - leg.start);
  const fraction = Math.min(1, Math.max(0, (hit.along - leg.start) / span));
  const switched = liveDrive?.stopId !== stop.id;
  liveDrive = {
    stopId: stop.id,
    fraction,
    legMiles: span / 1609.344,
    stopMiles: Number(stop.miles) || 0,
    stopHours: Number(stop.hours) || 0,
  };
  if (switched) tickLeaveNow();
  const now = Date.now();
  if (!switched && now - liveDrivePaintAt < LIVE_DRIVE_MS && Math.abs(hit.along - liveDrivePaintAlong) < LIVE_DRIVE_M) return;
  liveDrivePaintAt = now;
  liveDrivePaintAlong = hit.along;
  saveLeftLeg();
  paintLiveDriveChips();
}

function clearLiveDrive() {
  if (!liveDrive) return;
  liveDrive = null;
  liveDrivePaintAt = 0;
  liveDrivePaintAlong = NaN;
  if (state.plan && !state.estimating) {
    const result = rebuiltPlan();
    if (result && !result.error) state.plan = result;
  }
  paintLiveDriveChips();
}

// The leg being driven: the live position while navigating, else the left leg
// saved for this trip, shaped like liveDrive. Null when there is neither.
function legDrive() {
  if (navOn && liveDrive) return liveDrive;
  const left = openLeftLeg();
  const stop = left && state.stops.find((item) => item.id === left.stopId);
  if (!stop) return null;
  const stopMiles = Number(stop.miles) || 0;
  const full = stopMiles > 0.05 ? stopMiles : left.fullMiles;
  return {
    stopId: stop.id,
    fraction: Math.min(1, Math.max(0, 1 - left.remainMiles / full)),
    legMiles: left.fullMiles,
    stopMiles,
    stopHours: Number(stop.hours) || 0,
  };
}

// What is left of the leg being driven, as a drive progress for the plan.
// Null when no leg is under way, so the plan uses the whole saved legs.
function liveLegProgress() {
  return legProgressFrom(legDrive());
}

function legProgressFrom(drive) {
  if (!drive) return null;
  const stop = state.stops.find((item) => item.id === drive.stopId);
  if (!stop || stop.done || stop.skipRoute) return null;
  const full = drive.stopMiles > 0.05 ? drive.stopMiles : drive.legMiles;
  if (!(full > 0)) return null;
  const left = Math.min(1, Math.max(0, 1 - drive.fraction));
  // At the stop the plan still needs a sliver of the leg to place it.
  const remainMiles = Math.min(full, Math.max(0.1, full * left));
  const remainFraction = remainMiles / full;
  return {
    stopId: stop.id,
    remainFraction,
    leftAt: Date.now(),
    remainMiles,
    remainHours: drive.stopHours * remainFraction,
  };
}

// { done: true } for a drive chip already driven, { miles, hours } for the one
// being driven now, null for chips still ahead or not on the leg under way.
function liveChipState(event) {
  const drive = legDrive();
  if (!drive || !isDriveChip(event) || event.stopID !== drive.stopId) return null;
  const stop = state.stops.find((item) => item.id === event.stopID);
  if (!stop || stop.skipRoute) return null;
  const pieces = (state.plan?.events || [])
    .filter((item) => isDriveChip(item) && item.stopID === event.stopID)
    .sort((a, b) => a.start - b.start);
  const planned = pieces.reduce((sum, item) => sum + Math.max(0, Number(item.miles) || 0), 0);
  if (!(planned > 0.05)) return null;
  const full = Number(stop.miles) > 0.05 ? Number(stop.miles) : drive.legMiles;
  // A plan made partway into the leg covers only its last `planned` miles.
  const driven = drive.fraction * full - Math.max(0, full - planned);
  // That plan starts where the truck was, so its first piece is under way.
  const partway = full - planned > 0.05;
  let from = 0;
  for (const item of pieces) {
    const miles = Math.max(0, Number(item.miles) || 0);
    const to = from + miles;
    if (item.id === event.id) {
      if (driven >= to - 0.05) return { done: true };
      if (driven <= from && !(partway && from === 0)) return null;
      const left = to - Math.max(from, driven);
      const hours = (Number(item.tripHours) || 0) * (miles > 0 ? left / miles : 0);
      return { done: false, miles: left, hours };
    }
    from = to;
  }
  return null;
}

function liveLeftLine(event, live) {
  if (!live || live.done) return "";
  const stats = chipStatLine(event, live.hours, live.miles);
  return stats ? `${stats} left` : "";
}

function paintLiveDriveChips() {
  const events = state.plan?.events || [];
  document.querySelectorAll("[data-chip]").forEach((node) => {
    const id = node.getAttribute("data-chip");
    const event = events.find((item) => String(item.id) === id);
    if (!isDriveChip(event)) return;
    const live = liveChipState(event);
    const done = Boolean(live?.done);
    node.classList.toggle("is-done", done);
    const mark = node.querySelector(":scope > .done-mark");
    if (done && !mark) node.insertAdjacentHTML("beforeend", doneStamp());
    if (!done && mark) mark.remove();
    const text = liveLeftLine(event, live);
    let left = node.querySelector(".chip-left");
    if (!text) left?.remove();
    else {
      if (!left) {
        left = document.createElement("div");
        left.className = "chip-sec chip-left";
        const first = node.querySelector(".chip-sec");
        if (first) first.after(left);
        else node.prepend(left);
      }
      left.textContent = text;
    }
    const { middle } = chipParts(event);
    let mid = node.querySelector(".chip-mid");
    if (!middle) mid?.remove();
    else if (!mid) {
      mid = document.createElement("div");
      mid.className = "chip-sec chip-mid";
      const above = node.querySelector(".chip-left") || node.querySelector(".chip-sec");
      if (above) above.after(mid);
      else node.prepend(mid);
    }
    if (mid) mid.textContent = middle;
  });
}

function chipParts(event) {
  const effect = event.delayEffect;
  const live = liveChipState(event);
  // The leg being driven shows only its left row. Other drive chips keep the
  // original time/miles on top; delay row shows after.
  const middle = live && !live.done
    ? ""
    : effect && !effect.finishDelay && effect.beforeHours != null
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
  const live = liveChipState(event);
  const section = (text, extra = "") => text
    ? `<div class="chip-sec${extra ? ` ${extra}` : ""}">${escapeAttr(text)}</div>`
    : "";
  // Finish stop: when first, then delay under it. Other chips keep delay above when.
  const delayThenWhen = finishDelay
    ? `${section(span, "chip-when")}${section(delayLine, "chip-delay")}`
    : `${section(delayLine, "chip-delay")}${section(span, "chip-when")}`;
  const body = `
    <div class="chip ${event.kind}${live?.done ? " is-done" : ""}" data-chip="${escapeAttr(event.id)}" style="background:${cssRGB(event.rgb)};color:${ink.color}">
      ${section(label)}
      ${section(liveLeftLine(event, live), "chip-left")}
      ${section(middle, "chip-mid")}
      ${delayThenWhen}
      ${live?.done ? doneStamp() : ""}
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

function delaySum(list) {
  return list.reduce((sum, value) => sum + Math.max(0, Math.round(Number(value) || 0)), 0);
}

// Drive cards run in state.stops order: each stop's drive pieces, then its
// finish card. A changed delay makes every later card's delay a guess, so
// those go back to 0. Earlier cards keep theirs.
function clearLaterDelays(stop, piece, finish) {
  if (!finish) {
    if (Array.isArray(stop.driveDelays)) {
      for (let k = piece + 1; k < stop.driveDelays.length; k += 1) stop.driveDelays[k] = 0;
      stop.delayMinutes = delaySum(stop.driveDelays);
    }
    if (stop.finishDelayMinutes) stop.finishDelayMinutes = 0;
  }
  const at = state.stops.indexOf(stop);
  if (at < 0) return;
  state.stops.forEach((later, index) => {
    if (index <= at || isOriginStop(state.stops, index)) return;
    if (Array.isArray(later.driveDelays)) later.driveDelays = later.driveDelays.map(() => 0);
    if (later.delayMinutes) later.delayMinutes = 0;
    if (later.finishDelayMinutes) later.finishDelayMinutes = 0;
  });
}

function changeDelay(id, pieceIndex, delta, finish = false) {
  if (state.estimating || navOn) return;
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
    clearLaterDelays(stop, 0, true);
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
  stop.delayMinutes = delaySum(stop.driveDelays);
  clearLaterDelays(stop, piece, false);
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
    const text = leg.left ? `${parts.join(" · ")} left` : parts.join(" · ");
    return `<p class="flag-box here-leg">${escapeAttr(text)}</p>`;
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
    applyNavProgress();
    if (!state.locating) render();
    navBootReady = true;
    resumeNavIfNeeded();
    if (paid === "1") watchPackGrant();
    if (card === "1") watchCardGrant();
  });
  });
  const mark = () => { if (state.signedIn) pulseActivity(); };
  document.addEventListener("pointerdown", mark);
  document.addEventListener("keydown", mark);
  document.addEventListener("scroll", mark, true);
  armVoiceGesture();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") {
      hushNavVoice();
      return;
    }
    watchSignIn();
    tickLeaveNow();
    wakeNavLock();
    rewarmNavVoice();
  });
  window.addEventListener("pageshow", () => {
    wakeNavLock();
    rewarmNavVoice();
  });
  window.addEventListener("focus", () => wakeNavLock());
  window.addEventListener("resize", () => {
    if (navOn && document.visibilityState === "visible") snapNavLock();
  });
  window.setInterval(() => {
    if (!navOn || document.visibilityState === "hidden") return;
    if (!navFixAt || Date.now() - navFixAt > 3000) {
      restartNavWatch();
      pokeNavFix();
    }
    snapNavLock();
  }, 1000);
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
    start: () => `<section class="hos step" id="stepStart" data-block="start" style="--box-font: ${state.boxFont}px">
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
    hours: () => `<section class="hos step" data-block="hours" style="--box-font: ${state.boxFont}px">
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
  finishShareStopScroll();
}

function firstStopCard() {
  const first = (state.stops || [])[0];
  if (first?.id) {
    const card = document.querySelector(`.stops .stop-card[data-stop="${first.id}"]`);
    if (card) return card;
  }
  return document.querySelector(".stops .stop-card");
}

function finishShareStopScroll() {
  if (!pendingShareStopScroll) return;
  if (Date.now() > shareScrollUntil) {
    pendingShareStopScroll = false;
    return;
  }
  // Wait a frame so layout has the stop cards after innerHTML + bind.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (!pendingShareStopScroll || Date.now() > shareScrollUntil) {
        pendingShareStopScroll = false;
        return;
      }
      const card = firstStopCard();
      if (!card) return;
      card.scrollIntoView({ block: "start", behavior: "smooth" });
    });
  });
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

const STOP_DATE_DAYS_BACK = 30;

function todayDateValue(offsetMinutes, daysBack = 0) {
  return leaveDateValue(Date.now() - daysBack * 24 * 3600 * 1000, offsetMinutes);
}

function clampDateValue(value, offsetMinutes, daysBack = 0) {
  const min = todayDateValue(offsetMinutes, daysBack);
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
          const daysBack = id === "stopDate" ? STOP_DATE_DAYS_BACK : 0;
          const min = todayDateValue(offset, daysBack);
          const value = clampDateValue(leaveDateValue(id === "stopDate" ? pickerStopMs() : state.settings.leaveAt, offset), offset, daysBack);
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

function readDatedMs(previousMs, offsetMinutes, daysBack = 0) {
  const raw = document.querySelector("#pickerSheet [data-part=date]")?.value || "";
  const date = clampDateValue(raw, offsetMinutes, daysBack);
  const [year, month, day] = date.split("-").map((part) => Number(part));
  const prev = wallParts(previousMs, offsetMinutes);
  if (!year || !month || !day) return previousMs;
  return msFromWall(year, month - 1, day, prev.hour, prev.minute, offsetMinutes);
}

function readLeaveDate() {
  return readDatedMs(state.settings.leaveAt, state.settings.leaveAtOffset);
}

function writeStopWhen(ms) {
  if (navOn) {
    state.picker = "";
    state.pickerTarget = null;
    render();
    return;
  }
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
  if (navOn) {
    state.picker = "";
    state.pickerTarget = null;
    render();
    return;
  }
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
    const ms = readDatedMs(pickerStopMs(), offset, STOP_DATE_DAYS_BACK);
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
      if (navOn && el.closest("[data-block]")) return;
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
      if (navOn && el.closest("[data-block]")) return;
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
  const isLeave = wrap.getAttribute("data-when") === "leaveAt";
  const offsetHint = isLeave
    ? state.settings.leaveAtOffset
    : enteredOffset(
      state.stops.find((item) => item.id === wrap.closest("[data-stop]")?.getAttribute("data-stop")),
      wrap.getAttribute("data-stop-field"),
    );
  const date = clampDateValue(wrap.querySelector("[data-part=date]")?.value || "", offsetHint, isLeave ? 0 : STOP_DATE_DAYS_BACK);
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
      if (navOn) return;
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
  $("#transportMode")?.addEventListener("click", () => cycleTransportMode());
  $("#routeTruck")?.addEventListener("click", () => findNextTruckStop({ frame: true }));
  $("#routeLoves")?.addEventListener("click", () => findNextTruckStop({ place: "loves", frame: true }));
  $("#routeWalmart")?.addEventListener("click", () => findNextTruckStop({ place: "walmart", frame: true }));
  $("#routeCat")?.addEventListener("click", () => findNextTruckStop({ place: "cat", frame: true }));
  $("#addTruckStop")?.addEventListener("click", () => {
    cancelPinPeek();
    addTruckAsNextStop();
  });
  $("#clearPlaces")?.addEventListener("click", () => clearPlacePins());
  $("#routePlaceClear")?.addEventListener("click", () => clearPlacePins());
  $("#searchPlaces")?.addEventListener("click", () => searchPlacesHere());
  $("#routePlaceSearch")?.addEventListener("click", () => searchPlacesHere());
  $("#routeTruckAdd")?.addEventListener("click", () => addTruckAndRecalculate());
  $("#routeLovesAdd")?.addEventListener("click", () => addTruckAndRecalculate());
  $("#routeWalmartAdd")?.addEventListener("click", () => addTruckAndRecalculate());
  $("#routeCatAdd")?.addEventListener("click", () => addTruckAndRecalculate());
  $("#startNav")?.addEventListener("click", () => {
    cancelPinPeek();
    unlockNavVoice();
    void beginRouteNav();
  });
  $("#endNav")?.addEventListener("click", () => {
    cancelPinPeek();
    endRouteNav();
  });
  $("#routeWhole")?.addEventListener("click", () => {
    cancelPinPeek();
    cycleTripFit();
  });
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
    cancelPinPeek();
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
      if (navOn) return;
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
      if (navOn) return;
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
        if (navOn) return;
        state.pickerTarget = { id, field: button.getAttribute("data-stop-field") };
        state.picker = "stopDate";
        render();
      });
    });
    card.querySelectorAll("[data-toggle-field]").forEach((button) => {
      button.addEventListener("click", () => {
        if (navOn) return;
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
