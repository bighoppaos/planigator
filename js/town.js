// Town from the phone's coordinates. The list stays in the browser.
const METRO_METERS = 25 * 1609.344;
const FAR_METERS = 75 * 1609.344;
let grid = null;
let loading = null;

function meters(lat1, lon1, lat2, lon2) {
  const lat = ((lat1 + lat2) / 2) * Math.PI / 180;
  const y = (lat2 - lat1) * 111320;
  const x = (lon2 - lon1) * 111320 * Math.cos(lat);
  return Math.hypot(x, y);
}

export function buildTownGrid(rows) {
  const next = new Map();
  for (const row of rows) {
    const lat = Number(row[2]);
    const lon = Number(row[3]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const key = `${Math.floor(lat)}:${Math.floor(lon)}`;
    const list = next.get(key);
    if (list) list.push(row);
    else next.set(key, [row]);
  }
  return next;
}

function consider(found, row, distance) {
  found.push({
    name: String(row[0]),
    state: String(row[1]),
    meters: distance,
    pop: Number(row[4]) || 0,
  });
}

export function nearestTown(townGrid, lat, lon) {
  if (!townGrid) return null;
  const lat0 = Math.floor(lat);
  const lon0 = Math.floor(lon);
  const found = [];
  for (let a = lat0 - 1; a <= lat0 + 1; a += 1) {
    for (let b = lon0 - 1; b <= lon0 + 1; b += 1) {
      const bucket = townGrid.get(`${a}:${b}`);
      if (!bucket) continue;
      for (const row of bucket) {
        consider(found, row, meters(lat, lon, Number(row[2]), Number(row[3])));
      }
    }
  }
  if (!found.length) return null;
  found.sort((a, b) => a.meters - b.meters);
  const nearest = found[0];
  const mile = 1609.344;
  const around = found.filter((item) => item.meters <= 6 * mile);
  const big = around.find((item) => item.pop >= 100000 && item.pop >= nearest.pop * 8);
  if (nearest.meters <= 3 * mile && !big) return nearest;
  const metro = found.filter((item) => item.meters <= METRO_METERS);
  if (metro.length) {
    metro.sort((a, b) => b.pop - a.pop || a.meters - b.meters);
    if (metro[0].pop > 0) return metro[0];
  }
  if (nearest.meters <= FAR_METERS) return nearest;
  return null;
}

export function loadTowns() {
  if (grid) return Promise.resolve(grid);
  if (!loading) {
    loading = fetch(new URL("../data/us-cities.json?v=1", import.meta.url))
      .then((res) => {
        if (!res.ok) throw new Error("The town list did not load.");
        return res.json();
      })
      .then((rows) => {
        grid = buildTownGrid(rows);
        return grid;
      })
      .catch((error) => {
        loading = null;
        throw error;
      });
  }
  return loading;
}

export function townAt(lat, lon) {
  return nearestTown(grid, lat, lon);
}
