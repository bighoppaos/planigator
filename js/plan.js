/** Port of sequential schedule / timeline from TruckerPlanStop.swift. */

import {
  LEGAL_MAX_DRIVE_HOURS,
  DEFAULT_START_MINUTES,
  DEFAULT_END_MINUTES,
  DEFAULT_HOURS_BEFORE_THIRTY,
  DEFAULT_MPH,
  clampedMaxHours,
  clampedHoursBeforeThirty,
  TruckerHOSClock,
  nextDailyEnd,
  resumeAfterRest,
  isAnytimeEnd,
  isInsideDriveWindow,
  isPastDailyEnd,
} from "./hos.js?v=133";

export const STOP_RGB = [
  [0.38, 0.7, 1],
  [0.32, 0.86, 0.7],
  [1, 0.62, 0.22],
  [0.72, 0.56, 1],
];
export const LAST_STOP_RGB = [1, 0.48, 0.4];
export const ANYTIME_RGB = [
  [1, 0.8, 0.08],
  [0.98, 0.9, 0.32],
  [0.94, 0.58, 0.1],
  [0.82, 0.72, 0.16],
  [1, 0.7, 0.4],
  [0.72, 0.62, 0.08],
];
export const LEEWAY_RGB = [0.8, 0.82, 0.74];
export const REST_RGB = [0.52, 0.48, 0.72];
export const THIRTY_RGB = [0.18, 0.62, 0.7];

export function newId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const n = Math.random() * 16 | 0;
    return (ch === "x" ? n : (n & 0x3) | 0x8).toString(16);
  });
}

export function isOriginStop(stops, index) {
  const stop = stops[index];
  if (!stop) return false;
  if (stop.useCurrentLocation) return true;
  return !stops.some((item) => item.useCurrentLocation)
    && stops.findIndex((item) => !item.useCurrentLocation) === index;
}

function savedTruckLeg(stop) {
  return (Number(stop?.miles) || 0) > 0.05 || (Number(stop?.hours) || 0) > 0.0001;
}

// indexes.length is the number of HERE legs Calculate will request.
// New stops after the last saved leg route from that stop only.
// A stop with no leg before a later saved leg still recalculates every remaining stop.
export function legsToCalculate(stops) {
  const list = Array.isArray(stops) ? stops : [];
  let lastRouted = -1;
  for (let index = 0; index < list.length; index += 1) {
    if (isOriginStop(list, index)) continue;
    if (savedTruckLeg(list[index])) lastRouted = index;
  }
  const needs = [];
  const full = [];
  list.forEach((stop, index) => {
    if (!stop || isOriginStop(list, index) || stop.skipRoute || stop.done) return;
    full.push(index);
    if (!savedTruckLeg(stop)) needs.push(index);
  });
  if (needs.length > 0 && lastRouted >= 0 && needs.every((index) => index > lastRouted)) {
    return { mode: "suffix", anchor: lastRouted, indexes: needs };
  }
  return { mode: "full", anchor: -1, indexes: full };
}

export function scheduledIndexes(stops) {
  return stops.map((_, index) => index).filter((index) => !isOriginStop(stops, index) && !stops[index]?.skipRoute);
}

export function cardTitle(index, stops) {
  const originIsCurrent = stops[0]?.useCurrentLocation === true;
  if (originIsCurrent && index === 0) return "Current location";
  const named = (stops[index]?.name || "").trim();
  if (named) return named;
  const number = originIsCurrent ? index : index + 1;
  return `Stop ${number}`;
}

export function stopInk(rgb) {
  const luma = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  if (luma >= 0.54) {
    return { color: "#141414", muted: "rgba(20,20,20,0.72)", light: true };
  }
  return { color: "#fff", muted: "rgba(255,255,255,0.84)", light: false };
}

export function cssRGB(rgb) {
  return `rgb(${Math.round(rgb[0] * 255)}, ${Math.round(rgb[1] * 255)}, ${Math.round(rgb[2] * 255)})`;
}

export function anytimeShade(index, stops) {
  const anytimeStops = stops
    .map((stop, i) => i)
    .filter((i) => !isOriginStop(stops, i) && stops[i].anytime);
  const order = Math.max(0, anytimeStops.indexOf(index));
  return ANYTIME_RGB[order % ANYTIME_RGB.length];
}

export function stopColor(index, stops) {
  const destinations = scheduledIndexes(stops);
  const order = destinations.indexOf(index);
  const isLast = index === destinations[destinations.length - 1];
  if (stops[index].anytime) return anytimeShade(index, stops);
  if (isLast) return LAST_STOP_RGB;
  return STOP_RGB[Math.max(0, order) % STOP_RGB.length];
}

function inboundDrive(index, driveHours) {
  return driveHours[index] != null ? Math.max(0, driveHours[index]) : 0;
}

function pauseID(kind, stopID, piece, leading) {
  if (leading) return kind === "thirty" ? `thirty-lead-${stopID}` : `rest-lead-${stopID}`;
  const index = piece ?? 0;
  return kind === "thirty" ? `thirty-${stopID}-${index}` : `rest-${stopID}-${index}`;
}

export function latestArrive(stop) {
  return stop.window ? stop.end : stop.start;
}

export function notBefore(stop) {
  return stop.window && !stop.anytime ? stop.start : null;
}

function arrivalIfDepart(clock, startMs, drive, cap) {
  const probe = clock.clone();
  probe.notBeforeArrival = 0;
  if (startMs > probe.now + 60 * 1000) probe.waitUntil(startMs);
  probe.driveReporting(drive, cap, [0], [0]);
  return probe.now;
}

/** Latest moment we can be at this stop and still reach the next deadline. */
function latestStay(clock, drive, cap, nextDeadline, ownLatest) {
  const earliest = clock.now;
  let hi = ownLatest == null ? nextDeadline : ownLatest;
  if (nextDeadline != null) hi = Math.min(hi, nextDeadline);
  if (!(hi > earliest + 60 * 1000)) return earliest;
  const can = (arriveAt) => arrivalIfDepart(clock, arriveAt, drive, cap) <= nextDeadline + 60 * 1000;
  if (!can(earliest)) return earliest;
  let lo = earliest;
  let best = earliest;
  for (let i = 0; i < 28 && hi - lo > 60 * 1000; i += 1) {
    const mid = Math.floor(lo + (hi - lo) / 2);
    if (can(mid)) {
      best = mid;
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return best;
}

function downstreamLimits({ stops, driveHours, clocks, cap }) {
  const dest = scheduledIndexes(stops);
  const limits = new Map();
  let nextIndex = null;
  let nextDeadline = null;
  for (let position = dest.length - 1; position >= 0; position -= 1) {
    const index = dest[position];
    const own = stops[index].anytime ? null : latestArrive(stops[index]);
    const floor = notBefore(stops[index]);
    let limit = own;
    if (nextIndex != null && nextDeadline != null) {
      const clock = clocks.get(index);
      if (clock) {
        clock.timeZone = stops[nextIndex]?.timeZone || "";
        const latest = latestStay(clock, inboundDrive(nextIndex, driveHours), cap, nextDeadline, own);
        limit = own == null ? latest : Math.min(own, latest);
      }
    }
    if (floor != null && limit != null && limit < floor) limit = floor;
    limits.set(index, limit);
    nextIndex = index;
    nextDeadline = limit;
  }
  return limits;
}

export function schedules({
  stops,
  driveHours,
  maxHoursBeforeReset = LEGAL_MAX_DRIVE_HOURS,
  leaveAt,
  startMinutes = DEFAULT_START_MINUTES,
  endMinutes = DEFAULT_END_MINUTES,
  hoursBeforeThirty = DEFAULT_HOURS_BEFORE_THIRTY,
  arriveLatest = false,
  deadlineFor = null,
  captureClocks = null,
}) {
  if (arriveLatest && !deadlineFor) {
    const clocks = new Map();
    schedules({
      stops,
      driveHours,
      maxHoursBeforeReset,
      leaveAt,
      startMinutes,
      endMinutes,
      hoursBeforeThirty,
      arriveLatest: false,
      captureClocks: clocks,
    });
    const limits = downstreamLimits({
      stops,
      driveHours,
      clocks,
      cap: clampedMaxHours(maxHoursBeforeReset),
    });
    return schedules({
      stops,
      driveHours,
      maxHoursBeforeReset,
      leaveAt,
      startMinutes,
      endMinutes,
      hoursBeforeThirty,
      arriveLatest: true,
      deadlineFor: limits,
    });
  }
  const result = {};
  const clock = new TruckerHOSClock({
    now: leaveAt,
    startMinutes,
    endMinutes,
    hoursBeforeThirty: clampedHoursBeforeThirty(hoursBeforeThirty),
  });
  const cap = clampedMaxHours(maxHoursBeforeReset);
  stops.forEach((stop, index) => {
    // Passed stops stay on the trip, but the clock starts at the one still ahead.
    if (isOriginStop(stops, index) || stop.skipRoute) return;
    clock.timeZone = stop.timeZone || "";
    const drive = inboundDrive(index, driveHours);
    const limited = deadlineFor?.get(index);
    const open = arriveLatest
      ? (stop.anytime ? null : (limited != null ? limited : latestArrive(stop)))
      : notBefore(stop);
    if (open != null) {
      if (arriveLatest) clock.holdToArriveBy(open, drive, cap);
      else clock.holdForArrival(open, drive, cap);
    }
    const beforeDrive = clock.clone();
    const chipClock = clock.clone();
    const chipEvents = chipClock.driveReporting(drive, cap, [0], [0]);
    const chipRouteHours = chipEvents
      .filter((event) => event.kind === "drive")
      .map((event) => event.routeHours);
    const reported = clock.driveReporting(drive, cap, [0], [0]);
    const laid = applyDrivePieceDelays(stop, reported, beforeDrive, cap);
    copyClock(clock, laid.sim);
    const events = laid.events;
    const leading = [];
    const pieces = [];
    let pending = null;

    const attachPause = (start, end, kind) => {
      if (pending) {
        pieces.push({
          start: pending.start,
          end: pending.end,
          driveHours: pending.hours,
          routeHours: pending.routeHours,
          pausesAfter: [{ id: pauseID(kind, stop.id, pieces.length, false), start, end, kind }],
        });
        pending = null;
        return;
      }
      if (pieces.length === 0) {
        const last = leading[leading.length - 1];
        if (last && last.kind === kind) {
          leading[leading.length - 1] = { ...last, end };
        } else {
          leading.push({
            id: pauseID(kind, stop.id, null, true),
            start,
            end,
            kind,
          });
        }
        return;
      }
      pieces[pieces.length - 1].pausesAfter.push({
        id: pauseID(kind, stop.id, pieces.length - 1, false),
        start,
        end,
        kind,
      });
    };

    events.forEach((event) => {
      if (event.kind === "rest") attachPause(event.start, event.end, "rest");
      else if (event.kind === "thirty") attachPause(event.start, event.end, "thirty");
      else pending = event;
    });
    if (pending) {
      pieces.push({
        start: pending.start,
        end: pending.end,
        driveHours: pending.hours,
        routeHours: pending.routeHours,
        pausesAfter: [],
      });
    }
    if (pieces.length === 0) {
      const t = clock.now;
      pieces.push({
        start: t,
        end: t + 15 * 60 * 1000,
        driveHours: 0,
        routeHours: 0,
        pausesAfter: [],
      });
    }
    // A delay on this drive sits before the window wait, so spare time until
    // the window absorbs it. The next drive still leaves when the window
    // opens. On the last drive there is no next leave, so the arrival itself
    // moves and the leeway below opens then. The minutes also come out of the
    // daily drive limit. They stop at the end of the driving day. The 10-hour
    // reset still starts then. Delay that does not fit waits until after it.
    const tailDelayMinutes = stop.skipRoute || laid.tailIndex < 0
      ? 0
      : pieceDelayMinutes(stop, laid.tailIndex);
    const nextStop = stops[index + 1];
    const nextVisible = Boolean(nextStop) && !isOriginStop(stops, index + 1) && !nextStop.skipRoute;
    const laterVisible = stops.slice(index + 1).some((item, offset) => !isOriginStop(stops, index + 1 + offset) && !item.skipRoute);
    const applyTail = tailDelayMinutes >= 1 && (nextVisible || !laterVisible);
    const inDay = !isAnytimeEnd(clock.endMinutes)
      && isInsideDriveWindow(clock.now, clock.startMinutes, clock.endMinutes, clock.timeZone);
    const savedDayEnd = inDay ? nextDailyEnd(clock.endMinutes, clock.now, clock.timeZone) : 0;
    const delayMs = applyTail ? tailDelayMinutes * 60 * 1000 : 0;
    const delayBefore = savedDayEnd ? Math.min(delayMs, Math.max(0, savedDayEnd - clock.now)) : delayMs;
    const delayAfter = delayMs - delayBefore;
    const last = pieces[pieces.length - 1];
    if (delayBefore >= 60 * 1000) {
      const started = clock.now;
      const spent = clock.spendDriveTime(delayBefore, cap);
      spent.rests.forEach((rest, restIndex) => {
        last.pausesAfter.push({
          id: `rest-delay-${stop.id}-${pieces.length - 1}-${restIndex}`,
          start: rest.start,
          end: rest.end,
          kind: "rest",
        });
      });
      if (!nextVisible && !laterVisible && spent.rests.length === 0) last.end += clock.now - started;
    }
    const arrive = last.end;
    const close = stop.anytime ? null : latestArrive(stop);
    const usable = open == null ? null : clock.usableAt(open, close);
    const leaveAfterDelay = nextVisible ? arrive + tailDelayMinutes * 60 * 1000 : arrive;
    if (usable != null && clock.now + 60 * 1000 < usable) {
      const dayEnd = savedDayEnd || (isAnytimeEnd(clock.endMinutes) ? usable : nextDailyEnd(clock.endMinutes, clock.now, clock.timeZone));
      const restFrom = isInsideDriveWindow(clock.now, clock.startMinutes, clock.endMinutes, clock.timeZone) ? dayEnd : clock.now;
      const oneNight = isAnytimeEnd(clock.endMinutes)
        ? usable
        : resumeAfterRest(clock.startMinutes, clock.endMinutes, restFrom + 10 * 3600 * 1000, clock.timeZone);
      const horizon = isAnytimeEnd(clock.endMinutes)
        ? usable
        : nextDailyEnd(clock.endMinutes, oneNight + 60 * 1000, clock.timeZone);
      const sameNextDay = !isAnytimeEnd(clock.endMinutes) && savedDayEnd && usable <= horizon + 60 * 1000;
      const drove = clock.drivenToday > 0.01 || clock.drivenSinceBreak > 0.01;
      const gap = savedDayEnd ? savedDayEnd - clock.now : 0;
      const alreadyRested = last.pausesAfter.some((pause) => pause.kind === "rest");
      if (usable > oneNight + 60 * 1000 && sameNextDay && !alreadyRested && drove && gap < 10 * 3600 * 1000 - 60 * 1000 && gap > -60 * 1000) {
        if (gap > 60 * 1000) clock.now = savedDayEnd;
        const restStart = clock.now;
        clock.takeRest();
        last.pausesAfter.push({
          id: `rest-day-${stop.id}`,
          start: restStart,
          end: clock.now,
          kind: "rest",
        });
        if (delayAfter >= 60 * 1000) clock.spendDriveTime(delayAfter, cap);
        if (clock.now + 60 * 1000 < usable) clock.waitUntil(usable);
      } else if (usable > oneNight + 60 * 1000) {
        if (delayAfter >= 60 * 1000) clock.spendDriveTime(delayAfter, cap);
        clock.waitUntil(usable);
      } else if (!isPastDailyEnd(clock.now, clock.startMinutes, clock.endMinutes, clock.timeZone)) {
        if (delayAfter >= 60 * 1000) clock.spendDriveTime(delayAfter, cap);
        if (isInsideDriveWindow(clock.now, clock.startMinutes, clock.endMinutes, clock.timeZone) && dayEnd + 60 * 1000 < usable) {
          clock.waitUntil(dayEnd);
        } else {
          const restCovers = clock.overnightRestStillMakes(open, close);
          if (!restCovers || usable > open + 60 * 1000) clock.waitUntil(usable);
        }
      } else if (delayAfter >= 60 * 1000) {
        clock.spendDriveTime(delayAfter, cap);
      }
    } else if (delayAfter >= 60 * 1000) {
      const started = clock.now;
      const spent = clock.spendDriveTime(delayAfter, cap);
      spent.rests.forEach((rest, restIndex) => {
        last.pausesAfter.push({
          id: `rest-delay-after-${stop.id}-${restIndex}`,
          start: rest.start,
          end: rest.end,
          kind: "rest",
        });
      });
      if (!nextVisible && !laterVisible && spent.rests.length === 0) last.end += clock.now - started;
    }
    const finishAt = usable != null && usable > leaveAfterDelay + 60 * 1000 ? usable : 0;
    const liveMinutes = finishDelayMinutes(stop);
    // Loading is not driving. These minutes come out of the 14-hour day only.
    if (finishAt && liveMinutes >= 1 && clock.now + 60 * 1000 >= finishAt) {
      const spent = clock.spendOnDutyTime(liveMinutes * 60 * 1000);
      spent.rests.forEach((rest, restIndex) => {
        last.pausesAfter.push({
          id: `rest-finish-${stop.id}-${restIndex}`,
          start: rest.start,
          end: rest.end,
          kind: "rest",
        });
      });
    }
    if (captureClocks) captureClocks.set(index, clock.clone());
    result[index] = {
      start: pieces[0].start,
      end: arrive,
      finishAt,
      tripHours: drive,
      leadingPauses: leading,
      pieces,
      chipRouteHours,
      breakCount: leading.filter((p) => p.kind === "thirty").length
        + pieces.reduce((sum, piece) => sum + piece.pausesAfter.filter((p) => p.kind === "thirty").length, 0),
      restCount: leading.filter((p) => p.kind === "rest").length
        + pieces.reduce((sum, piece) => sum + piece.pausesAfter.filter((p) => p.kind === "rest").length, 0),
    };
  });
  return result;
}

export function driveHoursForStops(stops, mph) {
  return stops.map((stop, index) => {
    if (isOriginStop(stops, index)) return 0;
    if (stop.hours > 0.0001) return stop.hours;
    if (stop.miles > 0.05) return stop.miles / Math.max(1, mph);
    return 0;
  });
}

export function milesForStops(stops, mph) {
  return stops.map((stop, index) => {
    if (isOriginStop(stops, index)) return 0;
    if (stop.miles > 0.05) return stop.miles;
    if (stop.hours > 0.0001) return stop.hours * Math.max(1, mph);
    return 0;
  });
}

function leewayPhrase() {
  return "Leeway";
}

function laterPieceDelayHours(stop, fromPiece) {
  const list = Array.isArray(stop?.driveDelays) ? stop.driveDelays : [];
  const hours = [];
  for (let index = Math.max(0, fromPiece); index < list.length; index += 1) {
    hours.push(Math.max(0, Number(list[index]) || 0) / 60);
  }
  while (hours.length && hours[hours.length - 1] === 0) hours.pop();
  return hours;
}

function delayReplayedDrives(events, delayHours) {
  const result = events.map((event) => ({ ...event }));
  if (!delayHours.length) return { events: result, overflowMs: 0 };
  let overflowMs = 0;
  let driveIndex = -1;
  for (let i = 0; i < result.length; i += 1) {
    if (result[i].kind !== "drive") continue;
    driveIndex += 1;
    const delayMs = (delayHours[driveIndex] || 0) * 3600 * 1000;
    if (delayMs < 60 * 1000) continue;
    const restIndex = result.findIndex((event, index) => index > i && event.kind === "rest");
    if (restIndex < 0) {
      for (let j = i + 1; j < result.length; j += 1) {
        result[j] = { ...result[j], start: result[j].start + delayMs, end: result[j].end + delayMs };
      }
      overflowMs += delayMs;
      continue;
    }
    const rest = result[restIndex];
    const slack = Math.max(0, rest.end - rest.start - 10 * 3600 * 1000);
    const overflow = Math.max(0, delayMs - slack);
    for (let j = i + 1; j < result.length; j += 1) {
      if (j < restIndex) {
        result[j] = { ...result[j], start: result[j].start + delayMs, end: result[j].end + delayMs };
      } else if (j === restIndex) {
        result[j] = { ...result[j], start: result[j].start + delayMs, end: result[j].end + overflow };
      } else {
        result[j] = { ...result[j], start: result[j].start + overflow, end: result[j].end + overflow };
      }
    }
    overflowMs += overflow;
  }
  return { events: result, overflowMs };
}

function pieceDelayMinutes(stop, pieceIndex) {
  if (!stop || pieceIndex < 0) return 0;
  if (Array.isArray(stop.driveDelays)) return Math.max(0, Number(stop.driveDelays[pieceIndex]) || 0);
  if (pieceIndex === 0) return Math.max(0, Number(stop.delayMinutes) || 0);
  return 0;
}

function finishDelayMinutes(stop) {
  return Math.max(0, Math.round(Number(stop?.finishDelayMinutes) || 0));
}

function copyClock(target, source) {
  target.now = source.now;
  target.drivenSinceBreak = source.drivenSinceBreak;
  target.drivenToday = source.drivenToday;
  target.onDutyToday = source.onDutyToday;
  target.breakCount = source.breakCount;
  target.restCount = source.restCount;
  target.notBeforeArrival = source.notBeforeArrival || 0;
}

function routeHoursUntilRest(events, fromIndex) {
  let hours = 0;
  for (let i = fromIndex; i < events.length; i += 1) {
    if (events[i].kind === "rest") break;
    if (events[i].kind === "drive") hours += Math.max(0, Number(events[i].hours) || 0);
  }
  return hours;
}

function routeHoursAfter(events, fromIndex) {
  let hours = 0;
  for (let i = fromIndex; i < events.length; i += 1) {
    if (events[i].kind === "drive") hours += Math.max(0, Number(events[i].hours) || 0);
  }
  return hours;
}

function applyDrivePieceDelays(stop, events, before, cap) {
  const sim = before.clone();
  const driveCount = events.filter((event) => event.kind === "drive").length;
  let carry = 0;
  let restCut = 0;
  let drivePiece = 0;
  const shifted = [];
  let i = 0;
  while (i < events.length) {
    const event = events[i];
    if (event.kind === "rest") {
      const start = event.start + carry + restCut;
      restCut = 0;
      const tenEnd = start + 10 * 3600 * 1000;
      const resume = resumeAfterRest(sim.startMinutes, sim.endMinutes, tenEnd, sim.timeZone || "");
      const end = Math.max(tenEnd, resume);
      if (end + 1000 < sim.now) {
        carry = sim.now - event.end;
        i += 1;
        continue;
      }
      carry = end - event.end;
      shifted.push({ ...event, start, end });
      sim.now = end;
      sim.drivenSinceBreak = 0;
      sim.drivenToday = 0;
      sim.onDutyToday = 0;
      sim.restCount += 1;
      i += 1;
      continue;
    }
    const next = { ...event, start: event.start + carry, end: event.end + carry };
    shifted.push(next);
    if (event.kind === "drive") {
      sim.now = Math.max(sim.now, next.end);
      const hours = Math.max(0, Number(event.hours) || 0);
      sim.drivenToday += hours;
      sim.drivenSinceBreak += hours;
      sim.onDutyToday += hours;
      const isLast = drivePiece >= driveCount - 1;
      const askedMs = isLast ? 0 : pieceDelayMinutes(stop, drivePiece) * 60 * 1000;
      drivePiece += 1;
      const delayMs = delayThatFitsBeforeDayEnd(sim, askedMs);
      const dayEnd = dayEndAt(sim);
      // The next thing is already the 10-hour rest. This delay is not another
      // drive. It starts that rest later. Minutes past the day end still come
      // out of the 10. The morning stays put until the rest would be under 10 hours.
      if (askedMs >= 60 * 1000 && events[i + 1]?.kind === "rest") {
        carry += askedMs;
      } else if (delayMs >= 60 * 1000 && laterWouldPassDayEnd(events, i + 1, carry + delayMs, dayEnd)) {
        // Keep the 30-minute break in the day. The delay then moves the
        // drives under that break. Drives that would pass the day end are
        // laid out again after the reset.
        let nextIndex = i + 1;
        if (events[nextIndex]?.kind === "thirty") {
          const brk = events[nextIndex];
          const placed = { ...brk, start: brk.start + carry, end: brk.end + carry };
          shifted.push(placed);
          sim.now = Math.max(sim.now, placed.end);
          sim.onDutyToday += 0.5;
          sim.breakCount += 1;
          sim.drivenSinceBreak = 0;
          nextIndex += 1;
        }
        const fitted = delayThatFitsBeforeDayEnd(sim, askedMs);
        if (fitted >= 60 * 1000) {
          const spent = sim.spendDriveTime(fitted, cap);
          carry += fitted;
          spent.rests.forEach((rest, restIndex) => {
            carry += rest.end - rest.start;
            shifted.push({
              kind: "rest",
              start: rest.start,
              end: rest.end,
              id: `rest-delay-${stop.id}-${drivePiece}-${restIndex}`,
            });
          });
        }
        if (laterWouldPassDayEnd(events, nextIndex, carry, dayEndAt(sim))) {
          // Delay past the end of the day comes out of the 10-hour rest.
          // The morning start stays put until that rest would be under 10 hours.
          const overflow = Math.max(0, askedMs - fitted);
          if (overflow >= 60 * 1000) sim.now += overflow;
          const leftover = routeHoursAfter(events, nextIndex);
          if (leftover > 0.01) {
            const replayed = delayReplayedDrives(
              sim.driveReporting(leftover, cap, [0], [0]),
              laterPieceDelayHours(stop, drivePiece),
            );
            sim.now += replayed.overflowMs;
            shifted.push(...replayed.events);
          }
          break;
        }
        const overflow = Math.max(0, askedMs - fitted);
        if (overflow >= 60 * 1000) restCut += overflow;
        i = nextIndex;
        continue;
      } else if (delayMs >= 60 * 1000) {
        const spent = sim.spendDriveTime(delayMs, cap);
        carry += delayMs;
        spent.rests.forEach((rest, restIndex) => {
          carry += rest.end - rest.start;
          shifted.push({
            kind: "rest",
            start: rest.start,
            end: rest.end,
            id: `rest-delay-${stop.id}-${drivePiece}-${restIndex}`,
          });
        });
        const overflow = Math.max(0, askedMs - delayMs);
        if (overflow >= 60 * 1000 && spent.rests.length === 0) restCut += overflow;
        const untilRest = routeHoursUntilRest(events, i + 1);
        const room = cap - sim.drivenToday;
        if (spent.rests.length || untilRest > room + 0.02) {
          if (restCut >= 60 * 1000) sim.now += restCut;
          restCut = 0;
          const leftover = routeHoursAfter(events, i + 1);
          if (leftover > 0.01) {
            const replayed = delayReplayedDrives(
              sim.driveReporting(leftover, cap, [0], [0]),
              laterPieceDelayHours(stop, drivePiece),
            );
            sim.now += replayed.overflowMs;
            shifted.push(...replayed.events);
          }
          break;
        }
      }
    } else if (event.kind === "thirty") {
      sim.now = Math.max(sim.now, next.end);
      sim.onDutyToday += 0.5;
      sim.breakCount += 1;
      sim.drivenSinceBreak = 0;
    }
    i += 1;
  }
  // The last chip on the plan is the last drive still showing. A delay on
  // an earlier drive can remove a later piece, so that chip is not the
  // original last drive.
  let kept = 0;
  for (const event of shifted) if (event.kind === "drive") kept += 1;
  return { events: shifted, sim, tailIndex: kept - 1 };
}

function dayEndAt(sim) {
  if (isAnytimeEnd(sim.endMinutes)) return Infinity;
  if (!isInsideDriveWindow(sim.now, sim.startMinutes, sim.endMinutes, sim.timeZone)) return sim.now;
  return nextDailyEnd(sim.endMinutes, sim.now, sim.timeZone);
}

function laterWouldPassDayEnd(events, fromIndex, carry, dayEnd) {
  if (!Number.isFinite(dayEnd)) return false;
  for (let j = fromIndex; j < events.length; j += 1) {
    const event = events[j];
    if (event.kind === "rest") break;
    if (event.kind !== "drive" && event.kind !== "thirty") continue;
    if (event.end + carry > dayEnd + 1000) return true;
  }
  return false;
}

/** A delay can fill the time left in the driving day. It does not push a
 *  drive or a 30-minute break past that end. Drives after a 30-minute break
 *  move instead, including onto the next morning when they no longer fit.
 *  Delay past the end of the day comes out of the 10-hour rest. The morning
 *  drive still starts on time until that rest would be shorter than 10 hours.
 *  Then the morning drive starts later. */
function delayThatFitsBeforeDayEnd(sim, delayMs) {
  if (delayMs < 60 * 1000) return 0;
  if (isAnytimeEnd(sim.endMinutes)) return delayMs;
  if (!isInsideDriveWindow(sim.now, sim.startMinutes, sim.endMinutes, sim.timeZone)) return delayMs;
  return Math.min(delayMs, Math.max(0, dayEndAt(sim) - sim.now));
}

function delayRestMs(block) {
  if (!block?.pieces?.length) return 0;
  return block.pieces.reduce((sum, piece) => (
    sum + (piece.pausesAfter || []).reduce((inner, pause) => {
      if (pause.kind !== "rest" || pause.start + 1000 < block.end) return inner;
      return inner + Math.max(0, pause.end - pause.start);
    }, 0)
  ), 0);
}

function delaySatBefore(stops, index, blocks) {
  if (index <= 0) return 0;
  const stop = stops[index];
  const prev = stops[index - 1];
  if (!stop || stop.skipRoute || !prev || prev.skipRoute) return 0;
  const pieceCount = blocks?.[index - 1]?.pieces?.length || 1;
  const minutes = pieceDelayMinutes(prev, pieceCount - 1);
  if (minutes < 1) return 0;
  return minutes * 60 * 1000;
}

function leewayGaps({ stops, blocks, now, endMinutes }) {
  const destinations = scheduledIndexes(stops);
  const gaps = [];
  const first = destinations[0];
  if (first != null && blocks[first]) {
    const block = blocks[first];
    const gapStart = now + delaySatBefore(stops, first, blocks);
    const gapEnd = block.leadingPauses[0]?.start ?? block.start;
    const hours = (gapEnd - gapStart) / 3600 / 1000;
    if (hours >= 1 / 60) {
      gaps.push({
        id: `leeway-now-${stops[first].id}`,
        after: -1,
        start: gapStart,
        end: gapEnd,
        hours,
      });
    }
  }
  destinations.forEach((index, position) => {
    const block = blocks[index];
    if (!block) return;
    let gapStart = block.end;
    let gapEnd;
    if (position + 1 < destinations.length && blocks[destinations[position + 1]]) {
      const nextIndex = destinations[position + 1];
      const next = blocks[nextIndex];
      const lead = next.leadingPauses[0];
      const open = notBefore(stops[index]);
      const close = stops[index].anytime ? null : latestArrive(stops[index]);
      const arrivedInside = open == null || block.end + 60 * 1000 >= open;
      const delayMs = nextIndex === index + 1 ? delaySatBefore(stops, nextIndex, blocks) : 0;
      const restMs = delayRestMs(block);
      const rawLeave = lead?.start ?? next.start;
      const departure = block.finishAt && rawLeave > block.finishAt + 60 * 1000 ? block.finishAt : rawLeave;
      const reset = (block.pieces || []).flatMap((piece) => piece.pausesAfter || []).find((pause) => (
        pause.kind === "rest" && pause.start + 1000 >= block.end
      ));
      if (reset) {
        const beforeRoom = Math.max(0, reset.start - block.end);
        const delayBefore = Math.min(delayMs, beforeRoom);
        const delayAfter = Math.max(0, delayMs - delayBefore);
        const beforeStart = block.end + delayBefore;
        if (reset.start - beforeStart >= 60 * 1000) {
          gaps.push({
            id: `leeway-after-${stops[index].id}`,
            after: index,
            start: beforeStart,
            end: reset.start,
            hours: (reset.start - beforeStart) / 3600 / 1000,
          });
        }
        const afterStart = reset.end + delayAfter;
        if (departure - afterStart >= 60 * 1000) {
          gaps.push({
            id: `leeway-after-${stops[index].id}-morn`,
            after: index,
            start: afterStart,
            end: departure,
            hours: (departure - afterStart) / 3600 / 1000,
          });
        }
        return;
      }
      // An anytime stop is left as soon as this one is done. Stretching the
      // gap to the end of the driving day overlaps that drive. A delay that
      // still fits before the window only moves this leeway's open.
      if (arrivedInside && close != null && !isAnytimeEnd(endMinutes) && !stops[nextIndex]?.anytime) {
        const dayEnd = nextDailyEnd(endMinutes, block.end, stops[index].timeZone || "");
        const latest = Math.min(close, dayEnd);
        if (latest > block.end + 60 * 1000) {
          gapStart = block.end + delayMs + restMs;
          gapEnd = latest;
        } else {
          gapEnd = departure - delayMs - restMs;
        }
      } else {
        gapStart = block.end + delayMs + restMs;
        gapEnd = departure;
      }
    } else if (!stops[index].anytime) {
      const close = latestArrive(stops[index]);
      const open = notBefore(stops[index]);
      const arrivedInside = open == null || block.end + 60 * 1000 >= open;
      gapEnd = arrivedInside && !isAnytimeEnd(endMinutes)
        ? Math.min(close, nextDailyEnd(endMinutes, block.end, stops[index].timeZone || ""))
        : Math.max(block.end, close);
    } else {
      gapEnd = block.end;
    }
    const hours = (gapEnd - gapStart) / 3600 / 1000;
    if (hours < 1 / 60) return;
    gaps.push({
      id: `leeway-after-${stops[index].id}`,
      after: index,
      start: gapStart,
      end: gapEnd,
      hours,
    });
  });
  return gaps;
}

export function timeline({
  stops,
  driveHours,
  miles,
  leaveAt,
  now,
  startMinutes,
  endMinutes,
  hoursOfEleven,
  hoursBeforeThirty,
  arriveLatest = false,
}) {
  const blocks = schedules({
    stops,
    driveHours,
    maxHoursBeforeReset: hoursOfEleven,
    leaveAt,
    startMinutes,
    endMinutes,
    hoursBeforeThirty,
    arriveLatest,
  });
  const destinations = scheduledIndexes(stops);
  const events = [];
  destinations.forEach((index, order) => {
    const block = blocks[index];
    if (!block) return;
    const stopMiles = miles[index] ?? 0;
    const rgb = stopColor(index, stops);
    const title = cardTitle(index, stops);
    const deadline = stops[index].anytime ? null : latestArrive(stops[index]);
    const late = deadline != null && block.end >= deadline + 60 * 1000;
    const prevIndex = order > 0 ? destinations[order - 1] : null;
    block.leadingPauses.forEach((rest) => {
      const owner = rest.kind === "rest" && prevIndex != null ? stops[prevIndex].id : stops[index].id;
      events.push(restEvent(rest, owner));
    });
    if (block.finishAt) {
      events.push({
        id: `finish-${stops[index].id}`,
        kind: "finish",
        start: block.finishAt,
        end: block.finishAt,
        timePhrase: "Finish stop",
        rgb: LEEWAY_RGB,
        stopID: stops[index].id,
      });
    }
    const totalDrive = Math.max(block.pieces.reduce((sum, piece) => sum + piece.routeHours, 0), 0.001);
    let leftoverMiles = stopMiles;
    block.pieces.forEach((piece, pieceIndex) => {
      if (pieceIndex > 0) {
        const prev = block.pieces[pieceIndex - 1];
        const pauses = prev.pausesAfter || [];
        const afterEnd = pauses.length ? pauses[pauses.length - 1].end : prev.end;
        const gap = piece.start - afterEnd;
        if (gap >= 60 * 1000) {
          events.push({
            id: `leeway-gap-${stops[index].id}-${pieceIndex}`,
            kind: "leeway",
            start: afterEnd,
            end: piece.start,
            tripHours: gap / 3600 / 1000,
            timePhrase: leewayPhrase(arriveLatest, afterEnd, piece.start, stops[index], endMinutes),
            rgb: LEEWAY_RGB,
            after: index,
            stopID: stops[index].id,
          });
        }
      }
      const isTail = pieceIndex === block.pieces.length - 1;
      let pieceMiles = 0;
      if (isTail) pieceMiles = leftoverMiles;
      else {
        const share = stopMiles * (piece.routeHours / totalDrive);
        leftoverMiles = Math.max(0, leftoverMiles - share);
        pieceMiles = share;
      }
      const chipHours = piece.routeHours;
      const delayRest = isTail
        ? (piece.pausesAfter || []).find((pause) => pause.kind === "rest" && pause.start > piece.start + 60 * 1000 && pause.start < block.end - 60 * 1000)
        : null;
      if (isTail) {
        events.push({
          id: stops[index].id,
          kind: "stop",
          start: piece.start,
          end: delayRest ? delayRest.start : block.end,
          miles: pieceMiles,
          tripHours: chipHours,
          timePhrase: "Drive",
          arrivalPhrase: stops[index].anytime ? "Arrive" : (arriveLatest ? "Latest" : "Earliest"),
          title,
          rgb,
          earliestArrive: block.end,
          late,
          stopID: stops[index].id,
          index,
          pieceIndex,
        });
      } else {
        events.push({
          id: `lead-${stops[index].id}-${pieceIndex}`,
          kind: "lead",
          start: piece.start,
          end: piece.end,
          miles: pieceMiles,
          tripHours: chipHours,
          timePhrase: "Drive",
          title,
          rgb,
          stopID: stops[index].id,
          index,
          pieceIndex,
        });
      }
      piece.pausesAfter.forEach((rest) => events.push(restEvent(rest, stops[index].id)));
    });
    void order;
  });
  leewayGaps({ stops, blocks, now, endMinutes }).forEach((gap) => {
    events.push({
      id: gap.id,
      kind: "leeway",
      start: gap.start,
      end: gap.end,
      tripHours: gap.hours,
      timePhrase: leewayPhrase(arriveLatest, gap.start, gap.end, gap.after >= 0 ? stops[gap.after] : null, endMinutes),
      rgb: LEEWAY_RGB,
      after: gap.after,
      stopID: gap.after >= 0 ? stops[gap.after].id : destinations[0] != null ? stops[destinations[0]].id : null,
    });
  });
  const shown = events.filter((event) => {
    if (event.kind !== "finish") return true;
    const past = events.some((gap) => gap.kind === "leeway"
      && gap.stopID === event.stopID
      && gap.after !== -1
      && gap.end > event.start + 60 * 1000);
    return !past;
  });
  return { events: shown.sort((a, b) => a.start - b.start), blocks };
}

function restEvent(rest, stopID) {
  const thirty = rest.kind === "thirty";
  return {
    id: rest.id,
    kind: thirty ? "thirty" : "rest",
    start: rest.start,
    end: rest.end,
    tripHours: Math.max(0, (rest.end - rest.start) / 3600 / 1000),
    timePhrase: thirty ? "30-minute break" : "Off-duty/Sleeper Berth",
    rgb: thirty ? THIRTY_RGB : REST_RGB,
    stopID,
  };
}

export function buildPlan({
  stops,
  settings,
  now = Date.now(),
}) {
  const mph = settings.governed
    ? Math.max(1, settings.governedMph || DEFAULT_MPH)
    : DEFAULT_MPH;
  const destIndexes = scheduledIndexes(stops);
  if (destIndexes.length < 1) {
    return { error: "Add at least one stop." };
  }
  for (const i of destIndexes) {
    const stop = stops[i];
    if ((stop.hours || 0) <= 0.0001 && (stop.miles || 0) <= 0.05) {
      return { error: `Calculate to get HERE© truck miles for ${cardTitle(i, stops)}.` };
    }
  }
  const leaveAt = settings.leaveAt;
  const driveHours = driveHoursForStops(stops, mph);
  const miles = milesForStops(stops, mph);
  const { events, blocks } = timeline({
    stops,
    driveHours,
    miles,
    leaveAt,
    now,
    startMinutes: settings.startAnytime ? -1 : settings.startMinutes,
    endMinutes: settings.endAnytime ? -1 : settings.endMinutes,
    hoursOfEleven: settings.hoursOfEleven,
    hoursBeforeThirty: settings.hoursBeforeThirty,
    arriveLatest: settings.arrival === "latest",
  });
  const firstDest = destIndexes[0];
  const lastDest = destIndexes[destIndexes.length - 1];
  const rollAt = firstDest != null && blocks[firstDest] ? blocks[firstDest].start : leaveAt;
  const lastArrive = lastDest != null && blocks[lastDest] ? blocks[lastDest].end : leaveAt;
  let lateStop = null;
  for (const index of destIndexes) {
    const stop = stops[index];
    if (stop.anytime) continue;
    const arrive = blocks[index]?.end;
    const deadline = latestArrive(stop);
    if (arrive != null && deadline != null && arrive >= deadline + 60 * 1000) {
      lateStop = stop;
      break;
    }
  }
  const late = Boolean(lateStop);
  const breakCount = Object.values(blocks).reduce((sum, block) => sum + block.breakCount, 0);
  const restCount = Object.values(blocks).reduce((sum, block) => sum + block.restCount, 0);
  const totalDrive = destIndexes.reduce((sum, i) => sum + driveHours[i], 0);
  const totalMiles = destIndexes.reduce((sum, i) => sum + miles[i], 0);
  return {
    events,
    blocks,
    rollAt,
    arriveAt: lastArrive,
    late,
    lastTimedTitle: lateStop ? lateStop.name?.trim() || "the last timed stop" : "",
    lastDeadline: lateStop ? latestArrive(lateStop) : null,
    lastStopId: lateStop ? lateStop.id : "",
    zoned: true,
    breakCount,
    restCount,
    driveHours: totalDrive,
    miles: totalMiles,
    mph,
  };
}

export function tripSharePayload({ settings, stops, tripName }) {
  const clean = { ...settings };
  delete clean.sleepHours;
  delete clean.readyMinutes;
  return {
    v: 1,
    tripName: tripName || "",
    settings: clean,
    stops: stops.map((stop) => {
      const copy = { ...stop };
      delete copy.path;
      delete copy.directions;
      return copy;
    }),
  };
}

function bytesToBase64Url(bytes) {
  let bin = "";
  bytes.forEach((byte) => {
    bin += String.fromCharCode(byte);
  });
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function base64UrlToBytes(token) {
  const padded = token.replaceAll("-", "+").replaceAll("_", "/");
  const b64 = padded + "=".repeat((4 - (padded.length % 4)) % 4);
  const bin = atob(b64);
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}

export function encodeTripShare(trip) {
  const json = JSON.stringify(tripSharePayload(trip));
  return bytesToBase64Url(new TextEncoder().encode(json));
}

export function decodeTripShare(token) {
  const json = new TextDecoder().decode(base64UrlToBytes(token));
  const data = JSON.parse(json);
  if (!data || typeof data !== "object" || !Array.isArray(data.stops) || !data.settings) {
    throw new Error("That link is not a Planigator trip.");
  }
  return data;
}

export function stopPointLabel(stop, origin) {
  if (stop.useCurrentLocation) {
    if (origin && Number.isFinite(origin.lat) && Number.isFinite(origin.lon)) {
      return `${origin.lat},${origin.lon}`;
    }
    return "";
  }
  if (Number.isFinite(stop.lat) && Number.isFinite(stop.lon)) {
    return `${stop.lat},${stop.lon}`;
  }
  return (stop.address || stop.name || "").trim();
}

export function truckWeGoUrl(stops, origin) {
  const points = [];
  for (const stop of stops) {
    if (stop.useCurrentLocation) {
      if (origin && Number.isFinite(origin.lat) && Number.isFinite(origin.lon)) {
        points.push({ lat: origin.lat, lon: origin.lon, name: "Here" });
      }
      continue;
    }
    if (Number.isFinite(stop.lat) && Number.isFinite(stop.lon)) {
      points.push({
        lat: stop.lat,
        lon: stop.lon,
        name: (stop.name || stop.address || "Stop").trim() || "Stop",
      });
    }
  }
  if (points.length < 2) return "";
  const path = points
    .map((point) => `${encodeURIComponent(point.name)}:${point.lat},${point.lon}`)
    .join("/");
  return `https://wego.here.com/directions/truck/${path}`;
}

export function planPlainText({
  tripName,
  stops,
  plan,
  formatTime,
  formatShort,
  formatMiles,
  hoursLabel,
  durationLabel,
  formatWhen = null,
}) {
  const shortOf = (ms, hint) => (formatWhen ? formatWhen(ms, hint, "short") : formatShort(ms));
  const longOf = (ms, hint) => (formatWhen ? formatWhen(ms, hint, "long") : formatTime(ms));
  const lines = ["Planigator"];
  const named = (tripName || "").trim();
  if (named) lines.push(named);
  const route = stops
    .map((stop, index) => (stop.useCurrentLocation ? "Current location" : (stop.name || stop.address || cardTitle(index, stops)).trim()))
    .filter(Boolean)
    .join(" → ");
  if (route) lines.push(route);
  lines.push("");
  if (plan) {
    if (plan.late && plan.lastDeadline) {
      lines.push(`LATE for ${plan.lastTimedTitle} (be there by ${shortOf(plan.lastDeadline, "deadline")}).`);
    }
    lines.push(`Leave by: ${longOf(plan.rollAt, "leave")}`);
    lines.push(`Arrive: ${longOf(plan.arriveAt, "arrive")}`);
    lines.push(`Driving: ${hoursLabel(plan.driveHours)} · ${formatMiles(plan.miles)}`);
    lines.push(`HOS on this path: ${plan.breakCount} × 30-min · ${plan.restCount} × Off-duty/Sleeper Berth`);
    lines.push(`Clock including rests: ${durationLabel((plan.arriveAt - plan.rollAt) / 3600 / 1000)}`);
    lines.push("");
    lines.push("Timeline");
    plan.events.forEach((event) => {
      const when = event.end && event.end !== event.start
        ? `${shortOf(event.start, event)} → ${shortOf(event.end, event)}`
        : shortOf(event.start, event);
      const extra = [];
      if (event.title) extra.push(event.title);
      if (event.miles != null && event.miles > 0.05) extra.push(formatMiles(event.miles));
      if (event.tripHours != null) extra.push(hoursLabel(event.tripHours));
      lines.push(`${event.timePhrase}${extra.length ? ` · ${extra.join(" · ")}` : ""}`);
      lines.push(`  ${when}`);
      if (event.arrivalPhrase && event.earliestArrive) {
        lines.push(`  ${event.arrivalPhrase}: ${shortOf(event.earliestArrive, event)}`);
      }
    });
  }
  lines.push("");
  lines.push("Planning aid only. Not legal advice. Not a substitute for your ELD.");
  return lines.join("\n");
}
