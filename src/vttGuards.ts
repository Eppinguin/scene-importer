import type {
  FoundryVTTData,
  FoundryVTTLight,
  FoundryVTTWall,
  UniversalVTT,
} from "./vttTypes";

export function isFoundryVTTData(data: unknown): data is FoundryVTTData {
  if (!data || typeof data !== "object") return false;

  const scene = data as Partial<FoundryVTTData>;
  const hasNumericGrid = typeof scene.grid === "number";
  const hasGridObject =
    typeof scene.grid === "object" &&
    scene.grid !== null &&
    "size" in scene.grid;
  const isSceneReferenceId = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;
  const isWallObject = (value: unknown): value is Partial<FoundryVTTWall> =>
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as Partial<FoundryVTTWall>).c) &&
    (value as Partial<FoundryVTTWall>).c?.length === 4;
  const isLightObject = (value: unknown): value is Partial<FoundryVTTLight> =>
    typeof value === "object" && value !== null;
  const hasValidWalls =
    scene.walls === undefined ||
    (Array.isArray(scene.walls) &&
      scene.walls.every(
        (wall: unknown) => isSceneReferenceId(wall) || isWallObject(wall),
      ));
  const hasValidLights =
    scene.lights === undefined ||
    (Array.isArray(scene.lights) &&
      scene.lights.every(
        (light: unknown) =>
          isSceneReferenceId(light) || isLightObject(light),
      ));

  return (
    typeof scene.width === "number" &&
    typeof scene.height === "number" &&
    (hasNumericGrid || hasGridObject) &&
    hasValidWalls &&
    hasValidLights
  );
}

export function isUniversalVTTData(data: unknown): data is UniversalVTT {
  if (!data || typeof data !== "object") return false;

  const vtt = data as Partial<UniversalVTT>;
  return (
    typeof vtt.format === "number" &&
    !!vtt.resolution &&
    (Array.isArray(vtt.line_of_sight) ||
      Array.isArray(vtt.objects_line_of_sight) ||
      Array.isArray(vtt.lights))
  );
}

export function hasMapImage(data: unknown): boolean {
  return !!(
    data &&
    typeof data === "object" &&
    "image" in data &&
    (data as { image?: string }).image
  );
}
