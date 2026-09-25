/** Port of Pulsebox/Features/Trucker/TruckerHOS.swift and TruckerMath time helpers. */

export const LEGAL_MAX_DRIVE_HOURS = 11;
export const DEFAULT_START_MINUTES = 6 * 60;
export const DEFAULT_END_MINUTES = 20 * 60;
export const DEFAULT_HOURS_BEFORE_THIRTY = 8;
export const ANYTIME_END_MINUTES = -1;
export const ANYTIME_START_MINUTES = -1;
export const DEFAULT_MPH = 65;
export const SLEEP_HOURS = 8;
export const PERSONAL_PREP_HOURS = 1;

export function clampedMaxHours(hours) {
  return Math.min(LEGAL_MAX_DRIVE_HOURS, Math.max(1, hours));
}

export function clampedHoursBeforeThirty(hours) {
  return Math.min(DEFAULT_HOURS_BEFORE_THIRTY, Math.max(0.5, hours));
}

export function clampedClockMinutes(minutes) {
  return Math.min(23 * 60 + 59, Math.max(0, minutes));
}

export function isAnytimeEnd(minutes) {
  return minutes < 0;
}

export function isAnytimeStart(minutes) {
  return minutes < 0;
}

export function hoursLabel(hours) {
  const totalMinutes = Math.round(hours * 60);
  const h = Math.trunc(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return `${m} min`;
  if (m === 0) return `${h} hr`;
  return `${h} hr ${m} min`;
}

export function durationLabel(hours) {
  if (hours < 0) return "None";
  const totalMinutes = Math.round(hours * 60);
  if (totalMinutes === 0) return "0 min";
  const days = Math.trunc(totalMinutes / (24 * 60));
  const rest = totalMinutes % (24 * 60);
  const h = Math.trunc(rest / 60);
  const m = rest % 60;
  const parts = [];
  if (days > 0) parts.push(days === 1 ? "1 day" : `${days} days`);
  if (h > 0) parts.push(`${h} hr`);
  if (m > 0) parts.push(`${m} min`);
  return parts.join(" ");
}

export function stamp(ms, military = false) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: military ? "2-digit" : "numeric",
    minute: "2-digit",
    hourCycle: military ? "h23" : "h12",
  });
  return formatter.format(new Date(ms));
}

export function shortStamp(ms, military = false) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "numeric",
    day: "numeric",
    hour: military ? "2-digit" : "numeric",
    minute: "2-digit",
    hourCycle: military ? "h23" : "h12",
  });
  return formatter.format(new Date(ms));
}

export function sleepBy(leavePickupBy, hoursOfSleep = SLEEP_HOURS, hoursToGetReady = PERSONAL_PREP_HOURS) {
  return leavePickupBy - (hoursOfSleep + hoursToGetReady) * 3600 * 1000;
}

export function wakeToGetReady(leavePickupBy, hoursToGetReady = PERSONAL_PREP_HOURS) {
  return leavePickupBy - hoursToGetReady * 3600 * 1000;
}

function clockOnDay(minutes, dateMs) {
  const date = new Date(dateMs);
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  return start + minutes * 60 * 1000;
}

export function nextClock(minutes, atOrAfter) {
  const mins = clampedClockMinutes(minutes);
  const start = clockOnDay(mins, atOrAfter);
  if (start >= atOrAfter - 60 * 1000) return start;
  return start + 24 * 3600 * 1000;
}

export function nextWorkStart(minutes, after) {
  return nextClock(minutes, after);
}

export function nextDailyEnd(minutes, after) {
  const endMins = clampedClockMinutes(minutes);
  const today = clockOnDay(endMins, after);
  if (today > after) return today;
  return today + 24 * 3600 * 1000;
}

export function isInsideDriveWindow(dateMs, startMinutes, endMinutes) {
  if (isAnytimeEnd(endMinutes)) return true;
  const end = clampedClockMinutes(endMinutes);
  const date = new Date(dateMs);
  const mins = date.getHours() * 60 + date.getMinutes();
  if (isAnytimeStart(startMinutes)) {
    if (end === 0) return true;
    return mins < end;
  }
  const start = clampedClockMinutes(startMinutes);
  if (start === end) return true;
  if (start < end) return mins >= start && mins < end;
  return mins >= start || mins < end;
}

export function isPastDailyEnd(dateMs, startMinutes, endMinutes) {
  if (isAnytimeEnd(endMinutes)) return false;
  if (isInsideDriveWindow(dateMs, startMinutes, endMinutes)) return false;
  const end = clampedClockMinutes(endMinutes);
  const date = new Date(dateMs);
  const mins = date.getHours() * 60 + date.getMinutes();
  if (isAnytimeStart(startMinutes)) return mins >= end;
  const start = clampedClockMinutes(startMinutes);
  if (start === end) return false;
  if (start < end) return mins >= end;
  return mins >= end && mins < start;
}

export function resumeAfterRest(startMinutes, endMinutes, after) {
  if (isAnytimeStart(startMinutes)) {
    if (isAnytimeEnd(endMinutes)) return after;
    if (isInsideDriveWindow(after, startMinutes, endMinutes)) return after;
    return nextClock(0, after);
  }
  if (isAnytimeEnd(endMinutes)) {
    const start = clampedClockMinutes(startMinutes);
    const date = new Date(after);
    const mins = date.getHours() * 60 + date.getMinutes();
    if (mins < start) return nextClock(start, after);
    return after;
  }
  if (isInsideDriveWindow(after, startMinutes, endMinutes)) return after;
  return nextClock(startMinutes, after);
}

function sitForPiece(piece, hours) {
  return hours[piece] != null ? Math.max(0, hours[piece]) : 0;
}

export class TruckerHOSClock {
  constructor({
    now,
    startMinutes = DEFAULT_START_MINUTES,
    endMinutes = DEFAULT_END_MINUTES,
    hoursBeforeThirty = DEFAULT_HOURS_BEFORE_THIRTY,
  }) {
    this.now = now;
    this.startMinutes = startMinutes;
    this.endMinutes = endMinutes;
    this.hoursBeforeThirty = hoursBeforeThirty;
    this.drivenSinceBreak = 0;
    this.drivenToday = 0;
    this.onDutyToday = 0;
    this.breakCount = 0;
    this.restCount = 0;
  }

  clone() {
    const copy = new TruckerHOSClock(this);
    copy.drivenSinceBreak = this.drivenSinceBreak;
    copy.drivenToday = this.drivenToday;
    copy.onDutyToday = this.onDutyToday;
    copy.breakCount = this.breakCount;
    copy.restCount = this.restCount;
    copy.notBeforeArrival = this.notBeforeArrival || 0;
    return copy;
  }

  takeRest() {
    this.now += 10 * 3600 * 1000;
    this.restCount += 1;
    this.drivenSinceBreak = 0;
    this.drivenToday = 0;
    this.onDutyToday = 0;
    const resume = resumeAfterRest(this.startMinutes, this.endMinutes, this.now);
    if (resume > this.now) this.now = resume;
  }

  waitUntil(dateMs) {
    if (dateMs <= this.now + 60 * 1000) return;
    const wait = (dateMs - this.now) / 3600 / 1000;
    this.now = dateMs;
    if (wait >= 9.95) {
      this.restCount += 1;
      this.drivenSinceBreak = 0;
      this.drivenToday = 0;
      this.onDutyToday = 0;
    }
  }

  /** A 10-hour rest from here still ends inside [open, close], so the short
   *  wait until the window opens should not push the rest later. */
  overnightRestStillMakes(open, close) {
    if (open == null || this.now >= open - 60 * 1000) return false;
    if (isInsideDriveWindow(this.now, this.startMinutes, this.endMinutes)) return false;
    const resumed = resumeAfterRest(this.startMinutes, this.endMinutes, this.now + 10 * 3600 * 1000);
    if (resumed + 60 * 1000 < open) return false;
    if (close != null && resumed > close + 60 * 1000) return false;
    return true;
  }

  sit(hours) {
    if (hours <= 0.001) return;
    this.now += hours * 3600 * 1000;
    this.onDutyToday += hours;
  }

  /** First moment the stop can be used: the window open, or the next driving-day
   *  start when that open is after the driving day has ended. */
  usableAt(open, close) {
    if (open == null) return null;
    if (isAnytimeEnd(this.endMinutes) || isInsideDriveWindow(open, this.startMinutes, this.endMinutes)) return open;
    const morning = nextWorkStart(this.startMinutes, open);
    if (close != null && morning > close + 60 * 1000) return open;
    return morning;
  }

  holdForArrival(open, driveHours, hoursOfEleven) {
    const arrivalIfLeaveAt = (startMs) => {
      const probe = this.clone();
      probe.notBeforeArrival = 0;
      if (startMs > probe.now + 60 * 1000) probe.waitUntil(startMs);
      probe.driveReporting(driveHours, hoursOfEleven, [0], [0]);
      return probe.now;
    };
    const natural = arrivalIfLeaveAt(this.now);
    if (natural >= open - 60 * 1000) return;
    if (!isAnytimeEnd(this.endMinutes)) {
      const dayEnd = nextDailyEnd(this.endMinutes, this.now);
      if (dayEnd <= open + 60 * 1000 && natural < open - 60 * 1000) return;
    }
    let lo = this.now;
    let hi = open;
    let best = this.now;
    for (let i = 0; i < 28 && hi - lo > 1000; i += 1) {
      const mid = Math.floor(lo + (hi - lo) / 2);
      if (arrivalIfLeaveAt(mid) <= open) {
        best = mid;
        lo = mid;
      } else {
        hi = mid;
      }
    }
    const earlyArrive = arrivalIfLeaveAt(best);
    if (earlyArrive > open + 60 * 1000) return;
    if (best > this.now + 60 * 1000) this.waitUntil(best);
    if (open - earlyArrive > 1000) this.notBeforeArrival = open;
  }

  /** Latest departure that still arrives at or before `deadline`.
   *  If that lands before the deadline, the fresh driving day slips so the
   *  drive finishes at the deadline or at the end of the driving day,
   *  whichever is earlier. A 7:30 PM appointment after a 5:30 PM day end
   *  means arrive at 5:30 and wait, not finish the 9 hours at 3:00. */
  holdToArriveBy(deadline, driveHours, hoursOfEleven) {
    const arrivalIfLeaveAt = (startMs) => {
      const probe = this.clone();
      probe.notBeforeArrival = 0;
      if (startMs > probe.now + 60 * 1000) probe.waitUntil(startMs);
      probe.driveReporting(driveHours, hoursOfEleven, [0], [0]);
      return probe.now;
    };
    const natural = arrivalIfLeaveAt(this.now);
    if (natural > deadline + 60 * 1000) {
      this.notBeforeArrival = 0;
      return;
    }
    let lo = this.now;
    let hi = deadline;
    let best = this.now;
    for (let i = 0; i < 28 && hi - lo > 60 * 1000; i += 1) {
      const mid = Math.floor(lo + (hi - lo) / 2);
      if (arrivalIfLeaveAt(mid) <= deadline + 60 * 1000) {
        best = mid;
        lo = mid;
      } else {
        hi = mid;
      }
    }
    const arrive = arrivalIfLeaveAt(best);
    if (arrive > deadline + 60 * 1000) {
      this.notBeforeArrival = 0;
      return;
    }
    if (best > this.now + 60 * 1000) this.waitUntil(best);
    this.notBeforeArrival = deadline - arrive > 1000 ? deadline : 0;
  }

  drive(hours, hoursOfEleven, sitHours = 0, delayHours = 0) {
    this.driveReporting(hours, hoursOfEleven, [sitHours], [delayHours]);
  }

  driveReporting(hours, hoursOfEleven, sitHoursByPiece = [0], delayHoursByPiece = [0]) {
    const cap = clampedMaxHours(hoursOfEleven);
    const thirtyAfter = clampedHoursBeforeThirty(this.hoursBeforeThirty);
    let remainingRoute = Math.max(0, hours);
    let piece = 0;
    let remainingSit = sitForPiece(piece, sitHoursByPiece);
    let remainingDelay = sitForPiece(piece, delayHoursByPiece);
    const onDutyCap = 14;
    let restPasses = 0;
    let drivenSinceRest = 0;
    const events = [];
    let driveStart = this.now;
    let driveHours = 0;
    let driveRouteHours = 0;

    const flushDrive = () => {
      if (driveHours <= 0.001) return;
      events.push({
        kind: "drive",
        start: driveStart,
        end: this.now,
        hours: driveHours,
        routeHours: driveRouteHours,
      });
      driveHours = 0;
      driveRouteHours = 0;
      driveStart = this.now;
    };

    const loadPiece = (index) => {
      remainingSit = sitForPiece(index, sitHoursByPiece);
      remainingDelay = sitForPiece(index, delayHoursByPiece);
    };

    const hoursUntilEnd = () => {
      if (isAnytimeEnd(this.endMinutes)) return 24 * 14;
      if (!isInsideDriveWindow(this.now, this.startMinutes, this.endMinutes)) return 0;
      return (nextDailyEnd(this.endMinutes, this.now) - this.now) / 3600 / 1000;
    };

    const thirtyWouldLeaveWindow = () => {
      const breakEnd = this.now + 30 * 60 * 1000;
      return !isInsideDriveWindow(breakEnd, this.startMinutes, this.endMinutes);
    };

    const availableDrive = () => remainingRoute + remainingDelay;

    const parkForTen = () => {
      const allowed = drivenSinceRest > 0.01 || restPasses === 0;
      const room = hoursUntilEnd();
      if (remainingSit > 0.001 && room > 0.01) {
        const chunk = Math.min(remainingSit, room);
        this.sit(chunk);
        remainingSit -= chunk;
      }
      const leftoverSit = remainingSit;
      remainingSit = 0;
      remainingDelay = 0;
      flushDrive();
      const restStart = this.now;
      this.takeRest();
      events.push({ kind: "rest", start: restStart, end: this.now });
      piece += 1;
      restPasses += 1;
      drivenSinceRest = 0;
      loadPiece(piece);
      remainingSit += leftoverSit;
      if (remainingSit > 0.001) {
        this.sit(remainingSit);
        remainingSit = 0;
      }
      driveStart = this.now;
      return allowed;
    };

    const parkForThirty = () => {
      const leftoverSit = remainingSit;
      remainingSit = 0;
      remainingDelay = 0;
      flushDrive();
      const breakStart = this.now;
      this.now += 30 * 60 * 1000;
      this.onDutyToday += 0.5;
      this.breakCount += 1;
      this.drivenSinceBreak = 0;
      events.push({ kind: "thirty", start: breakStart, end: this.now });
      driveStart = this.now;
      piece += 1;
      loadPiece(piece);
      remainingSit += leftoverSit;
    };

    const waitForDailyStartIfNeeded = () => {
      if (isAnytimeStart(this.startMinutes)) return false;
      if (isAnytimeEnd(this.endMinutes)) return false;
      if (isInsideDriveWindow(this.now, this.startMinutes, this.endMinutes)) return false;
      // A 10-hour rest is only after driving. Before the first mile, wait
      // until the next start time even if the day already ended.
      if (this.drivenToday > 0.01 || drivenSinceRest > 0.01) return false;
      const start = nextWorkStart(this.startMinutes, this.now);
      if (start <= this.now + 60 * 1000) return false;
      flushDrive();
      this.waitUntil(start);
      driveStart = this.now;
      return true;
    };

    if (availableDrive() < 0.01) {
      this.sit(remainingSit);
      return events;
    }

    const slipTowardOpen = () => {
      const target = this.notBeforeArrival;
      if (!target || target <= this.now + 60 * 1000) return false;
      if (this.drivenToday > 0.01) return false;
      if (!isInsideDriveWindow(this.now, this.startMinutes, this.endMinutes)) return false;
      const probe = this.clone();
      probe.notBeforeArrival = 0;
      probe.driveReporting(availableDrive(), cap, [0], [0]);
      if (probe.now >= target - 60 * 1000) return false;
      const dayEnd = isAnytimeEnd(this.endMinutes) ? target : nextDailyEnd(this.endMinutes, this.now);
      const latestFinish = Math.min(target, dayEnd);
      if (latestFinish <= probe.now + 60 * 1000) return false;
      const arrivalFrom = (startMs) => {
        const trial = this.clone();
        trial.notBeforeArrival = 0;
        if (startMs > trial.now + 60 * 1000) trial.waitUntil(startMs);
        trial.driveReporting(availableDrive(), cap, [0], [0]);
        return trial.now;
      };
      const startAt = this.now + (latestFinish - probe.now);
      if (!isInsideDriveWindow(startAt, this.startMinutes, this.endMinutes)) return false;
      let slipTo = startAt;
      // A 10-hour rest that ends before the morning start snaps forward.
      // Shifting the departure by the whole gap can jump that snap and
      // arrive after the deadline. Keep the latest start that still makes it.
      if (arrivalFrom(startAt) > latestFinish + 60 * 1000) {
        let lo = this.now;
        let hi = startAt;
        let best = this.now;
        for (let i = 0; i < 24 && hi - lo > 1000; i += 1) {
          const mid = Math.floor(lo + (hi - lo) / 2);
          if (!isInsideDriveWindow(mid, this.startMinutes, this.endMinutes) || arrivalFrom(mid) > latestFinish + 60 * 1000) {
            hi = mid;
          } else {
            best = mid;
            lo = mid;
          }
        }
        if (best <= this.now + 60 * 1000) return false;
        slipTo = best;
      }
      flushDrive();
      this.waitUntil(slipTo);
      driveStart = this.now;
      return true;
    };

    while (availableDrive() > 0.01 && restPasses < 24) {
      if (waitForDailyStartIfNeeded()) continue;
      if (slipTowardOpen()) continue;
      const untilEnd = hoursUntilEnd();
      if (this.drivenToday >= cap - 0.01 || this.onDutyToday >= onDutyCap - 0.01 || untilEnd <= 0.01) {
        if (!parkForTen()) break;
        continue;
      }
      let innerSteps = 0;
      while (this.drivenToday < cap - 0.01 && this.onDutyToday < onDutyCap - 0.01 && availableDrive() > 0.01) {
        innerSteps += 1;
        if (innerSteps > 500) break;
        if (this.drivenSinceBreak >= thirtyAfter - 0.005 && availableDrive() > 0.001 && this.onDutyToday < onDutyCap - 0.5) {
          if (thirtyWouldLeaveWindow()) break;
          parkForThirty();
          continue;
        }
        const until = hoursUntilEnd();
        if (until <= 0.01) break;
        const pool = availableDrive();
        const chunk = Math.min(
          thirtyAfter - this.drivenSinceBreak,
          cap - this.drivenToday,
          pool,
          onDutyCap - this.onDutyToday,
          until
        );
        if (chunk <= 0.01) break;
        this.now += chunk * 3600 * 1000;
        this.drivenToday += chunk;
        this.drivenSinceBreak += chunk;
        this.onDutyToday += chunk;
        driveHours += chunk;
        drivenSinceRest += chunk;
        const fromDelay = Math.min(chunk, remainingDelay);
        remainingDelay -= fromDelay;
        const routed = chunk - fromDelay;
        driveRouteHours += routed;
        remainingRoute = Math.max(0, remainingRoute - routed);
        if (remainingSit > 0.001) {
          const want = remainingSit * (chunk / Math.max(pool, 0.001));
          const room = hoursUntilEnd();
          const sitChunk = Math.min(want, Math.max(0, room));
          this.sit(sitChunk);
          remainingSit = Math.max(0, remainingSit - sitChunk);
          if (room <= 0.01) break;
        }
      }
      if (availableDrive() > 0.01) {
        if (waitForDailyStartIfNeeded()) continue;
        if (!parkForTen()) break;
      }
    }
    this.sit(remainingSit);
    flushDrive();
    return events;
  }
}

export function planHOS({
  driveHours,
  addedLeewayHours = 0,
  hoursOfEleven,
  startMinutes = DEFAULT_START_MINUTES,
  endMinutes = DEFAULT_END_MINUTES,
  hoursBeforeThirty = DEFAULT_HOURS_BEFORE_THIRTY,
  leaveAt,
}) {
  const cap = clampedMaxHours(hoursOfEleven);
  const startMins = isAnytimeStart(startMinutes) ? ANYTIME_START_MINUTES : clampedClockMinutes(startMinutes);
  const endMins = isAnytimeEnd(endMinutes) ? ANYTIME_END_MINUTES : clampedClockMinutes(endMinutes);
  const thirtyAfter = clampedHoursBeforeThirty(hoursBeforeThirty);
  const firstStart = leaveAt;
  const clock = new TruckerHOSClock({
    now: firstStart,
    startMinutes: startMins,
    endMinutes: endMins,
    hoursBeforeThirty: thirtyAfter,
  });
  clock.drive(Math.max(0, driveHours), cap, Math.max(0, addedLeewayHours), 0);
  return {
    hoursOfEleven: cap,
    startMinutes: startMins,
    endMinutes: endMins,
    hoursBeforeThirty: thirtyAfter,
    breakCount: clock.breakCount,
    restCount: clock.restCount,
    arrival: clock.now,
    totalHours: (clock.now - firstStart) / 3600 / 1000,
    firstStart,
  };
}

export function hosNeed(hours, maxHoursBeforeReset = LEGAL_MAX_DRIVE_HOURS, hoursBeforeThirty = DEFAULT_HOURS_BEFORE_THIRTY) {
  const plan = planHOS({
    driveHours: hours,
    hoursOfEleven: maxHoursBeforeReset,
    endMinutes: DEFAULT_END_MINUTES,
    hoursBeforeThirty,
    leaveAt: Date.now(),
  });
  return {
    thirtyMinuteBreaks: plan.breakCount,
    tenHourResets: plan.restCount,
    extraHours: plan.breakCount * 0.5 + plan.restCount * 10,
  };
}

export function resolvedLeaveAt({ leaveNow, leaveAt, now, startMinutes }) {
  if (leaveNow) return now;
  if (leaveAt > now - 30 * 60 * 1000) return leaveAt;
  const date = new Date(leaveAt);
  const minutes = date.getHours() * 60 + date.getMinutes();
  return nextClock(minutes, now);
}
