// Where the truck is on a route that uses the same road more than once.
// The closest point on the whole line can be a later pass. Stay near the
// part already being driven.

const LOCK_BACK_M = 400;
const LOCK_AHEAD_M = 4000;
const SAME_ROAD_M = 45;

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
      const best = closest(windowed);
      if (bearing == null) return best;
      const aligned = windowed.filter((hit) => hit.bearing == null || angleDelta(bearing, hit.bearing) <= 100);
      if (!aligned.length) return best;
      const faced = closest(aligned);
      if (faced.dist <= best.dist + 40) return faced;
      return best;
    }
  }
  const pool = bearing == null
    ? hits
    : hits.filter((hit) => hit.bearing == null || angleDelta(bearing, hit.bearing) <= 100);
  const usable = pool.length ? pool : hits;
  const bestDist = closest(usable).dist;
  const near = usable.filter((hit) => hit.dist <= bestDist + SAME_ROAD_M);
  near.sort((a, b) => a.along - b.along);
  return near[0];
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
