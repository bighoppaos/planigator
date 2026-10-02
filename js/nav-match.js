// Where the truck is on a route that uses the same road more than once.
// The closest point on the whole line can be a later pass. Stay near the
// part already being driven. If that part is far behind the truck (the app
// was in the background), catch up instead of sticking on the old point.

const LOCK_BACK_M = 400;
const LOCK_AHEAD_M = 4000;
const SAME_ROAD_M = 45;
// app.js moves the along-lock only inside this distance.
export const ON_ROAD_M = 180;
const SNAP_BACK_M = 80;

export function metersBetween(a, b) {
  const lat = ((a[0] + b[0]) / 2) * Math.PI / 180;
  const y = (b[0] - a[0]) * 111320;
  const x = (b[1] - a[1]) * 111320 * Math.cos(lat);
  return Math.hypot(x, y);
}

function projectT(a, b, lat, lon) {
  const lat0 = ((a[0] + b[0]) / 2) * Math.PI / 180;
  const bx = (b[1] - a[1]) * 111320 * Math.cos(lat0);
  const by = (b[0] - a[0]) * 111320;
  const px = (lon - a[1]) * 111320 * Math.cos(lat0);
  const py = (lat - a[0]) * 111320;
  const len2 = bx * bx + by * by;
  if (len2 < 1) return 0;
  return Math.max(0, Math.min(1, (px * bx + py * by) / len2));
}

function bearingOf(a, b) {
  const φ1 = a[0] * Math.PI / 180;
  const φ2 = b[0] * Math.PI / 180;
  const λ = (b[1] - a[1]) * Math.PI / 180;
  const y = Math.sin(λ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(λ);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function angleDelta(a, b) {
  let delta = Math.abs(a - b) % 360;
  if (delta > 180) delta = 360 - delta;
  return delta;
}

function collectHits(lat, lon, path) {
  const hits = [];
  let walked = 0;
  for (let i = 1; i < path.length; i += 1) {
    const seg = metersBetween(path[i - 1], path[i]);
    const t = projectT(path[i - 1], path[i], lat, lon);
    const plat = path[i - 1][0] + (path[i][0] - path[i - 1][0]) * t;
    const plon = path[i - 1][1] + (path[i][1] - path[i - 1][1]) * t;
    hits.push({
      dist: metersBetween([lat, lon], [plat, plon]),
      along: walked + seg * t,
      bearing: seg >= 8 ? bearingOf(path[i - 1], path[i]) : null,
    });
    walked += seg;
  }
  return hits;
}

function closest(hits) {
  return hits.reduce((best, hit) => (hit.dist < best.dist ? hit : best));
}

// `span` is { from, to } on the joined line: the leg of the stop being driven
// to. Another stop's leg can run right beside it (the same turnpike the other
// way), so points outside it are never matched.
function inSpan(hit, span) {
  return !span || (hit.along >= span.from - 1 && hit.along <= span.to + 1);
}

function spanHits(hits, span) {
  return span ? hits.filter((hit) => inSpan(hit, span)) : hits;
}

function sameWay(hit, bearing) {
  return hit.bearing == null || angleDelta(bearing, hit.bearing) <= 100;
}

function preferBearing(hits, bearing) {
  const best = closest(hits);
  if (bearing == null) return best;
  const aligned = hits.filter((hit) => sameWay(hit, bearing));
  if (!aligned.length) return best;
  const faced = closest(aligned);
  if (faced.dist <= best.dist + 40) return faced;
  return best;
}

function earliestNear(hits) {
  const bestDist = closest(hits).dist;
  const near = hits.filter((hit) => hit.dist <= bestDist + SAME_ROAD_M);
  near.sort((a, b) => a.along - b.along);
  return near[0];
}

function lineMeters(path) {
  let walked = 0;
  for (let i = 1; i < path.length; i += 1) walked += metersBetween(path[i - 1], path[i]);
  return walked;
}

// The stops' road lines joined into one line, and each stop's leg on it.
// Leg start/end are measured on that joined line, the same way `along` is,
// so a stop line that does not begin where the one before it ended (a leg
// routed from where the truck was) moves every later leg past the jump.
export function buildNavLine(stops) {
  const line = [];
  const legs = [];
  let cursor = 0;
  for (const stop of stops || []) {
    const path = Array.isArray(stop?.path)
      ? stop.path.map((pair) => [Number(pair?.[0]), Number(pair?.[1])]).filter((pair) => Number.isFinite(pair[0]) && Number.isFinite(pair[1]))
      : [];
    if (path.length < 2) continue;
    const last = line[line.length - 1];
    if (last && path[0][0] === last[0] && path[0][1] === last[1]) {
      line.push(...path.slice(1));
    } else {
      if (last) cursor += metersBetween(last, path[0]);
      line.push(...path);
    }
    const meters = lineMeters(path);
    legs.push({ stop, path, start: cursor, end: cursor + meters });
    cursor += meters;
  }
  return { line, legs };
}

export function nearestOnPath(lat, lon, path, span = null) {
  const hits = spanHits(collectHits(lat, lon, path), span);
  if (!hits.length) return { dist: Infinity, along: 0 };
  return closest(hits);
}

export function matchAlong(lat, lon, path, { along = null, bearing = null, span = null } = {}) {
  const hits = spanHits(collectHits(lat, lon, path), span);
  if (!hits.length) return { dist: Infinity, along: 0 };
  if (along != null) {
    const windowed = hits.filter((hit) => hit.along >= along - LOCK_BACK_M && hit.along <= along + LOCK_AHEAD_M);
    if (windowed.length) {
      const best = preferBearing(windowed, bearing);
      if (best.dist <= ON_ROAD_M) return best;
    }
    // The locked stretch is behind him. Take the earliest on-road point at
    // or just behind the lock, so a later pass of this road still loses.
    const ahead = hits.filter((hit) => hit.along >= along - SNAP_BACK_M && hit.dist <= ON_ROAD_M);
    const aligned = bearing == null ? ahead : ahead.filter((hit) => sameWay(hit, bearing));
    const pool = aligned.length ? aligned : ahead;
    if (pool.length) return earliestNear(pool);
    if (windowed.length) return preferBearing(windowed, bearing);
  }
  // Heading only picks between passes about as close as the nearest one. A
  // parked phone's heading is noise and must not pull the match far away.
  const nearest = closest(hits).dist;
  const pool = bearing == null ? hits : hits.filter((hit) => sameWay(hit, bearing) && hit.dist <= nearest + SAME_ROAD_M);
  return earliestNear(pool.length ? pool : hits);
}

// The best point on the stretch around `along`, even if it is off the road.
// Null when the line has nothing in that stretch.
export function matchNear(lat, lon, path, along, bearing = null, span = null) {
  const hits = collectHits(lat, lon, path)
    .filter((hit) => hit.along >= along - LOCK_BACK_M && hit.along <= along + LOCK_AHEAD_M && inSpan(hit, span));
  return hits.length ? preferBearing(hits, bearing) : null;
}

export function inLockWindow(hitAlong, along) {
  return hitAlong >= along - LOCK_BACK_M && hitAlong <= along + LOCK_AHEAD_M;
}

// One mile. After a turn, the next one takes the top map slot once it is
// under this far from the truck, or once this far has been driven.
export const TURN_SLOT_MILE_M = 1609.344;

// True once the locked maneuver should give the top slot to the next one.
// `nextAlong` is where that next maneuver sits on the route. It is null
// when there is no later maneuver to measure.
export function turnLockShouldAdvance(along, lockAlong, nextAlong) {
  if (!Number.isFinite(along) || !Number.isFinite(lockAlong)) return false;
  if (along < lockAlong - 12) return false;
  if (!Number.isFinite(nextAlong)) return along >= lockAlong + TURN_SLOT_MILE_M;
  const gap = nextAlong - lockAlong;
  const away = nextAlong - along;
  return gap < TURN_SLOT_MILE_M || away < TURN_SLOT_MILE_M || along >= lockAlong + TURN_SLOT_MILE_M;
}

// Three direction rows, always including the current step when the list has them.
export function directionWindow(current, count, size = 3) {
  if (count <= 0 || current < 0) return [];
  const n = Math.min(size, count);
  let start = current - 1;
  if (start < 0) start = 0;
  if (start + n > count) start = Math.max(0, count - n);
  return Array.from({ length: n }, (_, i) => start + i);
}
