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
} from "./hos.js";

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

export function scheduledIndexes(stops) {
  return stops.map((_, index) => index).filter((index) => !isOriginStop(stops, index));
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

export function schedules({
  stops,
  driveHours,
  maxHoursBeforeReset = LEGAL_MAX_DRIVE_HOURS,
  leaveAt,
  startMinutes = DEFAULT_START_MINUTES,
  endMinutes = DEFAULT_END_MINUTES,
  hoursBeforeThirty = DEFAULT_HOURS_BEFORE_THIRTY,
  arriveLatest = false,
}) {
  const result = {};
  const clock = new TruckerHOSClock({
    now: leaveAt,
    startMinutes,
    endMinutes,
    hoursBeforeThirty: clampedHoursBeforeThirty(hoursBeforeThirty),
  });
  const cap = clampedMaxHours(maxHoursBeforeReset);
  stops.forEach((stop, index) => {
    if (isOriginStop(stops, index)) return;
    const drive = inboundDrive(index, driveHours);
    const open = arriveLatest
      ? (stop.anytime ? null : latestArrive(stop))
      : notBefore(stop);
    if (open != null) clock.holdForArrival(open, drive, cap);
    const chipClock = clock.clone();
    const chipEvents = chipClock.driveReporting(drive, cap, [0], [0]);
    const chipRouteHours = chipEvents
      .filter((event) => event.kind === "drive")
      .map((event) => event.routeHours);
    const events = clock.driveReporting(drive, cap, [0], [0]);
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
    const arrive = pieces[pieces.length - 1].end;
    if (open != null && clock.now < open) clock.waitUntil(open);
    result[index] = {
      start: pieces[0].start,
      end: arrive,
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

function leewayGaps({ stops, blocks, now }) {
  const destinations = scheduledIndexes(stops);
  const gaps = [];
  const first = destinations[0];
  if (first != null && blocks[first]) {
    const block = blocks[first];
    const gapEnd = block.leadingPauses[0]?.start ?? block.start;
    const hours = (gapEnd - now) / 3600 / 1000;
    if (hours >= 1 / 60) {
      gaps.push({
        id: `leeway-now-${stops[first].id}`,
        after: -1,
        start: now,
        end: gapEnd,
        hours,
      });
    }
  }
  destinations.forEach((index, position) => {
    const block = blocks[index];
    if (!block) return;
    let gapEnd;
    if (position + 1 < destinations.length && blocks[destinations[position + 1]]) {
      const next = blocks[destinations[position + 1]];
      gapEnd = next.leadingPauses[0]?.start ?? next.start;
    } else if (!stops[index].anytime) {
      gapEnd = Math.max(block.end, latestArrive(stops[index]));
    } else {
      gapEnd = block.end;
    }
    const hours = (gapEnd - block.end) / 3600 / 1000;
    if (hours < 1 / 60) return;
    gaps.push({
      id: `leeway-after-${stops[index].id}`,
      after: index,
      start: block.end,
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
    const late = deadline != null && block.end > deadline + 60 * 1000;
    block.leadingPauses.forEach((rest) => {
      events.push(restEvent(rest, stops[index].id));
    });
    const totalDrive = Math.max(block.pieces.reduce((sum, piece) => sum + piece.routeHours, 0), 0.001);
    let leftoverMiles = stopMiles;
    block.pieces.forEach((piece, pieceIndex) => {
      const isTail = pieceIndex === block.pieces.length - 1;
      let pieceMiles = 0;
      if (isTail) pieceMiles = leftoverMiles;
      else {
        const share = stopMiles * (piece.routeHours / totalDrive);
        leftoverMiles = Math.max(0, leftoverMiles - share);
        pieceMiles = share;
      }
      const chipHours = piece.routeHours;
      if (isTail) {
        events.push({
          id: stops[index].id,
          kind: "stop",
          start: piece.start,
          end: block.end,
          miles: pieceMiles,
          tripHours: chipHours,
          timePhrase: "Drive",
          arrivalPhrase: stops[index].anytime ? "Arrive" : "Earliest",
          title,
          rgb,
          earliestArrive: block.end,
          late,
          stopID: stops[index].id,
          index,
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
        });
      }
      piece.pausesAfter.forEach((rest) => events.push(restEvent(rest, stops[index].id)));
    });
    void order;
  });
  leewayGaps({ stops, blocks, now }).forEach((gap) => {
    const isLastSlack = gap.after >= 0 && destinations[destinations.length - 1] === gap.after;
    events.push({
      id: gap.id,
      kind: "leeway",
      start: gap.start,
      end: gap.end,
      tripHours: gap.hours,
      timePhrase: arriveLatest ? "Leeway for latest arrival" : "Leeway for earliest arrival",
      rgb: LEEWAY_RGB,
      after: gap.after,
      stopID: gap.after >= 0 ? stops[gap.after].id : destinations[0] != null ? stops[destinations[0]].id : null,
    });
  });
  return { events: events.sort((a, b) => a.start - b.start), blocks };
}

function restEvent(rest, stopID) {
  const thirty = rest.kind === "thirty";
  return {
    id: rest.id,
    kind: thirty ? "thirty" : "rest",
    start: rest.start,
    end: rest.end,
    tripHours: Math.max(0, (rest.end - rest.start) / 3600 / 1000),
    timePhrase: thirty ? "30-minute break" : "10-hour rest",
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
  const lastTimed = [...destIndexes].reverse().map((i) => stops[i]).find((stop) => !stop.anytime);
  const late = lastTimed ? lastArrive > latestArrive(lastTimed) + 60 * 1000 : false;
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
    lastTimedTitle: lastTimed ? lastTimed.name?.trim() || "the last timed stop" : "",
    lastDeadline: lastTimed ? latestArrive(lastTimed) : null,
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
}) {
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
      lines.push(`LATE for ${plan.lastTimedTitle} (be there by ${formatShort(plan.lastDeadline)}).`);
    }
    lines.push(`Leave by: ${formatTime(plan.rollAt)}`);
    lines.push(`Arrive: ${formatTime(plan.arriveAt)}`);
    lines.push(`Driving: ${hoursLabel(plan.driveHours)} · ${formatMiles(plan.miles)}`);
    lines.push(`HOS on this path: ${plan.breakCount} × 30-min · ${plan.restCount} × 10-hour`);
    lines.push(`Clock including rests: ${durationLabel((plan.arriveAt - plan.rollAt) / 3600 / 1000)}`);
    lines.push("");
    lines.push("Timeline");
    plan.events.forEach((event) => {
      const when = event.end && event.end !== event.start
        ? `${formatShort(event.start)} → ${formatShort(event.end)}`
        : formatShort(event.start);
      const extra = [];
      if (event.title) extra.push(event.title);
      if (event.miles != null && event.miles > 0.05) extra.push(formatMiles(event.miles));
      if (event.tripHours != null) extra.push(hoursLabel(event.tripHours));
      lines.push(`${event.timePhrase}${extra.length ? ` · ${extra.join(" · ")}` : ""}`);
      lines.push(`  ${when}`);
      if (event.arrivalPhrase && event.earliestArrive) {
        lines.push(`  ${event.arrivalPhrase} ${formatShort(event.earliestArrive)}`);
      }
    });
  }
  lines.push("");
  lines.push("Planning aid only. Not legal advice. Not a substitute for your ELD.");
  return lines.join("\n");
}
