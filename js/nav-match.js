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

export function nearestOnPath(lat, lon, path) {
  const hits = collectHits(lat, lon, path);
  if (!hits.length) return { dist: Infinity, along: 0 };
  return closest(hits);
}

export function matchAlong(lat, lon, path, { along = null, bearing = null } = {}) {
  const hits = collectHits(lat, lon, path);
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
  const pool = bearing == null ? hits : hits.filter((hit) => sameWay(hit, bearing));
  return earliestNear(pool.length ? pool : hits);
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
