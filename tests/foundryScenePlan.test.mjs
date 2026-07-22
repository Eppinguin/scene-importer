import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFoundryScenePlan,
  selectFoundryLogicalMapFeatures,
} from "../src/foundryScenePlan.ts";

const tile = (id, x, y, width, height, path, extra = {}) => ({
  _id: id,
  x,
  y,
  width,
  height,
  texture: { src: path },
  ...extra,
});

const wall = (x1, y1, x2, y2, door = 0) => ({
  c: [x1, y1, x2, y2],
  door,
  ds: 0,
});

const scene = (overrides = {}) => ({
  _id: "test-scene",
  name: "Test Scene",
  width: 5000,
  height: 1000,
  padding: 0,
  grid: { size: 100, distance: 5, units: "ft" },
  walls: [],
  lights: [],
  drawings: [],
  tiles: [],
  ...overrides,
});

test("groups contained overlays and assigns each map's features spatially", () => {
  const tiles = [];
  const walls = [];
  for (let index = 0; index < 5; index++) {
    const x = index * 1000;
    tiles.push(tile(`base-${index}`, x, 0, 1000, 1000, `base-${index}.webp`));
    tiles.push(
      tile(`overlay-${index}`, x + 300, 300, 300, 300, `overlay-${index}.webp`),
    );
    walls.push(wall(x + 100, 100, x + 900, 100));
  }
  tiles.push(tile("decoration", 5600, 0, 100, 100, "sign.webp"));

  const plan = buildFoundryScenePlan(scene({ width: 6000, tiles, walls }));

  assert.equal(plan.maps.length, 5);
  assert.deepEqual(
    plan.maps.map((map) => map.layers.length),
    [2, 2, 2, 2, 2],
  );
  assert.deepEqual(
    plan.maps.map((map) => map.wallIndexes.length),
    [1, 1, 1, 1, 1],
  );
  assert.deepEqual(plan.ignoredLayers.map((layer) => layer.id), ["decoration"]);
  assert.deepEqual(plan.ambiguousWallIndexes, []);
  assert.deepEqual(plan.unassignedWallIndexes, []);

  const selected = selectFoundryLogicalMapFeatures(
    scene({ width: 6000, tiles, walls }),
    plan.maps[3],
    "selected-map",
  );
  assert.deepEqual(selected.walls, [walls[3]]);
});

test("treats full-size image stacks as one composition and chooses the top layer", () => {
  const plan = buildFoundryScenePlan(
    scene({
      width: 1000,
      tiles: [
        tile("floor-one", 0, 0, 1000, 1000, "floor-one.webp", { z: 1 }),
        tile("floor-two", 0, 0, 1000, 1000, "floor-two.webp", { z: 2 }),
      ],
      walls: [wall(100, 100, 900, 100)],
    }),
  );

  assert.equal(plan.maps.length, 1);
  assert.equal(plan.maps[0].layers.length, 2);
  assert.equal(plan.maps[0].primaryLayer.id, "floor-two");
});

test("keeps a small feature-bearing map while ignoring a decorative outlier", () => {
  const cellarWalls = [wall(1210, 20, 1290, 20)];
  const plan = buildFoundryScenePlan(
    scene({
      width: 1600,
      tiles: [
        tile("main", 0, 0, 1000, 1000, "main.webp"),
        tile("cellar", 1200, 0, 100, 100, "cellar.webp"),
        tile("sign", 1500, 0, 100, 100, "sign.webp"),
      ],
      walls: [wall(100, 100, 900, 100), ...cellarWalls],
    }),
  );

  assert.deepEqual(
    plan.maps.map((map) => map.primaryLayer.id),
    ["main", "cellar"],
  );
  assert.deepEqual(plan.maps.map((map) => map.wallIndexes.length), [1, 1]);
  assert.deepEqual(plan.ignoredLayers.map((layer) => layer.id), ["sign"]);
});

test("reports genuinely overlapping map ownership as ambiguous", () => {
  const plan = buildFoundryScenePlan(
    scene({
      width: 1800,
      tiles: [
        tile("left", 0, 0, 1000, 1000, "left.webp"),
        tile("right", 800, 0, 1000, 1000, "right.webp"),
      ],
      walls: [wall(850, 100, 950, 100)],
    }),
  );

  assert.equal(plan.maps.length, 2);
  assert.deepEqual(plan.ambiguousWallIndexes, [0]);
  assert.deepEqual(plan.maps.map((map) => map.wallIndexes.length), [0, 0]);
  assert.deepEqual(
    plan.maps.map((map) => map.ambiguousWallIndexes),
    [[0], [0]],
  );
});

test("assigns a shared-edge feature deterministically to the right-hand map", () => {
  const plan = buildFoundryScenePlan(
    scene({
      width: 2000,
      tiles: [
        tile("left", 0, 0, 1000, 1000, "left.webp"),
        tile("right", 1000, 0, 1000, 1000, "right.webp"),
      ],
      walls: [wall(1000, 100, 1000, 900)],
    }),
  );

  assert.deepEqual(plan.ambiguousWallIndexes, []);
  assert.deepEqual(plan.maps.map((map) => map.wallIndexes.length), [0, 1]);
});

test("uses rotated image footprints when classifying features", () => {
  const plan = buildFoundryScenePlan(
    scene({
      width: 600,
      height: 500,
      tiles: [
        tile("rotated", 100, 100, 400, 200, "rotated.webp", {
          rotation: 90,
        }),
      ],
      // This point is outside the unrotated rectangle but inside its rotated footprint.
      walls: [wall(290, 20, 310, 20)],
    }),
  );

  assert.deepEqual(plan.maps[0].wallIndexes, [0]);
});
