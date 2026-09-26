import assert from "node:assert/strict";
import test from "node:test";
import { directionWindow, matchAlong, metersBetween, nearestOnPath } from "./nav-match.js";

// Eastbound, then a jog north, then the same road westbound a few meters beside it.
const outA = [39.1, -84.5];
const outB = [39.1, -84.4];
const backA = [39.1002, -84.4];
const backB = [39.1002, -84.5];
const path = [outA, outB, backA, backB];

test("closest point on a repeated road is the later pass", () => {
  const lat = 39.10014;
  const lon = -84.45;
  const hit = nearestOnPath(lat, lon, path);
  const outbound = nearestOnPath(lat, lon, [outA, outB]);
  assert.ok(hit.along > outbound.along + 1000);
});

test("driving east stays on the first pass when that road comes back later", () => {
  const lat = 39.10014;
  const lon = -84.45;
  const outbound = nearestOnPath(lat, lon, [outA, outB]);
  const hit = matchAlong(lat, lon, path, { bearing: 90 });
  assert.ok(Math.abs(hit.along - outbound.along) < 50);
});

test("a lock on the first pass does not jump to the return trip", () => {
  const lat = 39.10014;
  const lon = -84.45;
  const outbound = nearestOnPath(lat, lon, [outA, outB]);
  const hit = matchAlong(lat, lon, path, { along: outbound.along });
  assert.ok(Math.abs(hit.along - outbound.along) < 50);
});

test("a lock on the return pass stays on the return pass", () => {
  const lat = 39.10008;
  const lon = -84.45;
  const outbound = nearestOnPath(lat, lon, [outA, outB]);
  const back = nearestOnPath(lat, lon, [backA, backB]);
  const along = metersBetween(outA, outB) + metersBetween(outB, backA) + back.along;
  const hit = matchAlong(lat, lon, path, { along, bearing: 270 });
  assert.ok(Math.abs(hit.along - along) < 80);
  assert.ok(hit.along > outbound.along + 1000);
});

test("the first direction step still leaves three rows when three exist", () => {
  assert.deepEqual(directionWindow(0, 8), [0, 1, 2]);
  assert.deepEqual(directionWindow(4, 8), [3, 4, 5]);
  assert.deepEqual(directionWindow(7, 8), [5, 6, 7]);
  assert.deepEqual(directionWindow(0, 2), [0, 1]);
});
