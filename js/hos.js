/** Port of Pulsebox/Features/Trucker/TruckerHOS.swift and TruckerMath time helpers. */

export const LEGAL_MAX_DRIVE_HOURS = 11;
export const DEFAULT_START_MINUTES = 6 * 60;
export const DEFAULT_END_MINUTES = 20 * 60;
export const DEFAULT_HOURS_BEFORE_THIRTY = 8;
export const ANYTIME_END_MINUTES = -1;
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
  const start = clampedClockMinutes(startMinutes);
  const end = clampedClockMinutes(endMinutes);
  if (start === end) return true;
  const date = new Date(dateMs);
  const mins = date.getHours() * 60 + date.getMinutes();
  if (start < end) return mins >= start && mins < end;
  return mins >= start || mins < end;
}

export function isPastDailyEnd(dateMs, startMinutes, endMinutes) {
  if (isAnytimeEnd(endMinutes)) return false;
  if (isInsideDriveWindow(dateMs, startMinutes, endMinutes)) return false;
  const start = clampedClockMinutes(startMinutes);
  const end = clampedClockMinutes(endMinutes);
  if (start === end) return false;
  const date = new Date(dateMs);
  const mins = date.getHours() * 60 + date.getMinutes();
  if (start < end) return mins >= end;
  return mins >= end && mins < start;
}

export function resumeAfterRest(startMinutes, endMinutes, after) {
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

  sit(hours) {
    if (hours <= 0.001) return;
    this.now += hours * 3600 * 1000;
    this.onDutyToday += hours;
  }

  holdForArrival(open, driveHours, hoursOfEleven) {
    for (let i = 0; i < 12; i += 1) {
      const probe = this.clone();
      probe.driveReporting(driveHours, hoursOfEleven, [0], [0]);
      const early = open - probe.now;
      if (early <= 60 * 1000) return;
      this.waitUntil(this.now + early);
    }
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
      if (isAnytimeEnd(this.endMinutes)) return false;
      if (isInsideDriveWindow(this.now, this.startMinutes, this.endMinutes)) return false;
      if (isPastDailyEnd(this.now, this.startMinutes, this.endMinutes)) return false;
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

    while (availableDrive() > 0.01 && restPasses < 24) {
      if (waitForDailyStartIfNeeded()) continue;
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
  const startMins = clampedClockMinutes(startMinutes);
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
