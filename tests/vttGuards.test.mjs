import assert from "node:assert/strict";
import test from "node:test";
import {
  hasMapImage,
  isFoundryVTTData,
  isUniversalVTTData,
} from "../src/vttGuards.ts";

test("format guards reject null and primitive inputs without throwing", () => {
  for (const value of [null, undefined, false, 0, "scene"]) {
    assert.equal(isFoundryVTTData(value), false);
    assert.equal(isUniversalVTTData(value), false);
    assert.equal(hasMapImage(value), false);
  }
});

test("recognizes a minimal Foundry scene", () => {
  assert.equal(
    isFoundryVTTData({
      name: "Scene",
      width: 1000,
      height: 1000,
      grid: { size: 100 },
      walls: [],
      lights: [],
    }),
    true,
  );
});
