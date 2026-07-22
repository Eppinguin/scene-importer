import type {
  FoundryVTTData,
  FoundryVTTDrawing,
  FoundryVTTLight,
  FoundryVTTTile,
  FoundryVTTWall,
} from "./vttTypes";

export type FoundryPoint = { x: number; y: number };

export type FoundryMapFootprint = {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  polygon: FoundryPoint[];
};

export type FoundryVisualLayer = {
  id: string;
  sourceIndex: number;
  kind: "background" | "tile";
  path: string;
  footprint: FoundryMapFootprint;
  hidden: boolean;
  elevation: number;
  z: number;
  sort: number;
  orderIndex: number;
};

export type FoundryLogicalMap = {
  id: string;
  label: string;
  footprint: FoundryMapFootprint;
  layers: FoundryVisualLayer[];
  primaryLayer: FoundryVisualLayer;
  wallIndexes: number[];
  lightIndexes: number[];
  drawingIndexes: number[];
  ambiguousWallIndexes: number[];
  ambiguousLightIndexes: number[];
  ambiguousDrawingIndexes: number[];
  matchTerms: string[];
};

export type FoundryScenePlan = {
  sceneId: string;
  maps: FoundryLogicalMap[];
  ignoredLayers: FoundryVisualLayer[];
  ambiguousWallIndexes: number[];
  ambiguousLightIndexes: number[];
  ambiguousDrawingIndexes: number[];
  unassignedWallIndexes: number[];
  unassignedLightIndexes: number[];
  unassignedDrawingIndexes: number[];
};

type LogicalMapDraft = Omit<
  FoundryLogicalMap,
  | "label"
  | "wallIndexes"
  | "lightIndexes"
  | "drawingIndexes"
  | "ambiguousWallIndexes"
  | "ambiguousLightIndexes"
  | "ambiguousDrawingIndexes"
  | "matchTerms"
> & {
  featureSupport: number;
};

const EPSILON = 0.0001;
const COMPOSITION_OVERLAP_RATIO = 0.9;
const SMALL_LAYER_AREA_RATIO = 0.12;

const finiteNumber = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const getGridSize = (scene: FoundryVTTData): number => {
  const value =
    typeof scene.grid === "object" ? scene.grid.size : Number(scene.grid);
  return Number.isFinite(value) && value > 0 ? value : 100;
};

const rotatePoint = (
  point: FoundryPoint,
  center: FoundryPoint,
  degrees: number,
): FoundryPoint => {
  if (!Number.isFinite(degrees) || degrees % 360 === 0) return point;
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  return {
    x: center.x + dx * cos - dy * sin,
    y: center.y + dx * sin + dy * cos,
  };
};

const buildFootprint = (
  x: number,
  y: number,
  width: number,
  height: number,
  rotation: number,
): FoundryMapFootprint => {
  const center = { x: x + width / 2, y: y + height / 2 };
  const polygon = [
    { x, y },
    { x: x + width, y },
    { x: x + width, y: y + height },
    { x, y: y + height },
  ].map((point) => rotatePoint(point, center, rotation));
  return { x, y, width, height, rotation, polygon };
};

const signedPolygonArea = (polygon: FoundryPoint[]): number => {
  let area = 0;
  for (let index = 0; index < polygon.length; index++) {
    const current = polygon[index];
    const next = polygon[(index + 1) % polygon.length];
    area += current.x * next.y - next.x * current.y;
  }
  return area / 2;
};

const polygonArea = (polygon: FoundryPoint[]): number =>
  Math.abs(signedPolygonArea(polygon));

const cross = (a: FoundryPoint, b: FoundryPoint, c: FoundryPoint): number =>
  (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);

const lineIntersection = (
  start: FoundryPoint,
  end: FoundryPoint,
  clipStart: FoundryPoint,
  clipEnd: FoundryPoint,
): FoundryPoint => {
  const x1 = start.x;
  const y1 = start.y;
  const x2 = end.x;
  const y2 = end.y;
  const x3 = clipStart.x;
  const y3 = clipStart.y;
  const x4 = clipEnd.x;
  const y4 = clipEnd.y;
  const denominator = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(denominator) <= EPSILON) return end;
  return {
    x:
      ((x1 * y2 - y1 * x2) * (x3 - x4) -
        (x1 - x2) * (x3 * y4 - y3 * x4)) /
      denominator,
    y:
      ((x1 * y2 - y1 * x2) * (y3 - y4) -
        (y1 - y2) * (x3 * y4 - y3 * x4)) /
      denominator,
  };
};

const intersectConvexPolygons = (
  subject: FoundryPoint[],
  clip: FoundryPoint[],
): FoundryPoint[] => {
  let output = [...subject];
  const orientation = signedPolygonArea(clip) >= 0 ? 1 : -1;
  for (let index = 0; index < clip.length; index++) {
    const clipStart = clip[index];
    const clipEnd = clip[(index + 1) % clip.length];
    const input = output;
    output = [];
    if (input.length === 0) break;
    let previous = input[input.length - 1];
    for (const current of input) {
      const currentInside =
        orientation * cross(clipStart, clipEnd, current) >= -EPSILON;
      const previousInside =
        orientation * cross(clipStart, clipEnd, previous) >= -EPSILON;
      if (currentInside) {
        if (!previousInside) {
          output.push(
            lineIntersection(previous, current, clipStart, clipEnd),
          );
        }
        output.push(current);
      } else if (previousInside) {
        output.push(lineIntersection(previous, current, clipStart, clipEnd));
      }
      previous = current;
    }
  }
  return output;
};

const intersectionArea = (
  left: FoundryMapFootprint,
  right: FoundryMapFootprint,
): number => polygonArea(intersectConvexPolygons(left.polygon, right.polygon));

const pointOnSegment = (
  point: FoundryPoint,
  start: FoundryPoint,
  end: FoundryPoint,
): boolean => {
  if (Math.abs(cross(start, end, point)) > EPSILON) return false;
  return (
    point.x >= Math.min(start.x, end.x) - EPSILON &&
    point.x <= Math.max(start.x, end.x) + EPSILON &&
    point.y >= Math.min(start.y, end.y) - EPSILON &&
    point.y <= Math.max(start.y, end.y) + EPSILON
  );
};

const pointInPolygon = (point: FoundryPoint, polygon: FoundryPoint[]): boolean => {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const currentPoint = polygon[index];
    const previousPoint = polygon[previous];
    if (pointOnSegment(point, previousPoint, currentPoint)) return true;
    const crosses =
      currentPoint.y > point.y !== previousPoint.y > point.y &&
      point.x <
        ((previousPoint.x - currentPoint.x) *
          (point.y - currentPoint.y)) /
          (previousPoint.y - currentPoint.y) +
          currentPoint.x;
    if (crosses) inside = !inside;
  }
  return inside;
};

const basename = (path: string): string => {
  const segments = path.trim().split("/");
  return (segments[segments.length - 1] || path)
    .replace(/\.[^/.]+$/, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
};

const getTilePath = (tile: FoundryVTTTile): string =>
  (tile.texture?.src || tile.img || "").trim();

const buildVisualLayers = (scene: FoundryVTTData): FoundryVisualLayer[] => {
  const layers: FoundryVisualLayer[] = [];
  const gridSize = getGridSize(scene);
  const padX = Math.ceil((scene.width * finiteNumber(scene.padding)) / gridSize) * gridSize;
  const padY = Math.ceil((scene.height * finiteNumber(scene.padding)) / gridSize) * gridSize;
  const backgroundPath = (scene.img || scene.background?.src || "").trim();
  if (backgroundPath && scene.width > 0 && scene.height > 0) {
    const shiftX = finiteNumber(scene.shiftX, finiteNumber(scene.background?.offsetX));
    const shiftY = finiteNumber(scene.shiftY, finiteNumber(scene.background?.offsetY));
    const rotation = finiteNumber(scene.background?.rotation);
    layers.push({
      id: `background:${backgroundPath}`,
      sourceIndex: -1,
      kind: "background",
      path: backgroundPath,
      footprint: buildFootprint(
        padX + shiftX,
        padY + shiftY,
        scene.width,
        scene.height,
        rotation,
      ),
      hidden: false,
      elevation: 0,
      z: 0,
      sort: 0,
      orderIndex: -1,
    });
  }

  const tiles = Array.isArray(scene.tiles) ? scene.tiles : [];
  tiles.forEach((tile, index) => {
    if (!tile || typeof tile !== "object") return;
    const path = getTilePath(tile);
    const width = finiteNumber(tile.width);
    const height = finiteNumber(tile.height);
    const alpha = finiteNumber(tile.alpha, 1);
    if (!path || width <= 0 || height <= 0 || alpha <= 0.001) return;
    const x = finiteNumber(tile.x);
    const y = finiteNumber(tile.y);
    const rotation = finiteNumber(tile.rotation);
    layers.push({
      id: tile._id?.trim() || `tile:${index}:${path}`,
      sourceIndex: index,
      kind: "tile",
      path,
      footprint: buildFootprint(x, y, width, height, rotation),
      hidden: tile.hidden === true,
      elevation: finiteNumber(tile.elevation),
      z: finiteNumber(tile.z),
      sort: finiteNumber(tile.sort),
      orderIndex: index,
    });
  });
  return layers;
};

const shouldCompose = (
  left: FoundryVisualLayer,
  right: FoundryVisualLayer,
): boolean => {
  const leftArea = polygonArea(left.footprint.polygon);
  const rightArea = polygonArea(right.footprint.polygon);
  const smallerArea = Math.min(leftArea, rightArea);
  if (smallerArea <= EPSILON) return false;
  const overlap = intersectionArea(left.footprint, right.footprint);
  return overlap / smallerArea >= COMPOSITION_OVERLAP_RATIO;
};

const buildLayerGroups = (
  layers: FoundryVisualLayer[],
): FoundryVisualLayer[][] => {
  const parent = layers.map((_, index) => index);
  const find = (value: number): number => {
    let current = value;
    while (parent[current] !== current) {
      parent[current] = parent[parent[current]];
      current = parent[current];
    }
    return current;
  };
  const union = (left: number, right: number) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
  };
  for (let left = 0; left < layers.length; left++) {
    for (let right = left + 1; right < layers.length; right++) {
      if (shouldCompose(layers[left], layers[right])) union(left, right);
    }
  }
  const groups = new Map<number, FoundryVisualLayer[]>();
  layers.forEach((layer, index) => {
    const root = find(index);
    const group = groups.get(root) ?? [];
    group.push(layer);
    groups.set(root, group);
  });
  return Array.from(groups.values());
};

const layerOrder = (layer: FoundryVisualLayer): number =>
  layer.elevation * 1_000_000 +
  layer.z * 1_000 +
  layer.sort * 10 +
  layer.orderIndex;

const choosePrimaryLayer = (
  layers: FoundryVisualLayer[],
): FoundryVisualLayer =>
  [...layers].sort((left, right) => {
    const areaDifference =
      polygonArea(right.footprint.polygon) - polygonArea(left.footprint.polygon);
    if (Math.abs(areaDifference) > EPSILON) return areaDifference;
    return layerOrder(right) - layerOrder(left);
  })[0];

const wallMidpoint = (wall: FoundryVTTWall): FoundryPoint | null => {
  if (!Array.isArray(wall.c) || wall.c.length < 4) return null;
  const [x1, y1, x2, y2] = wall.c.map(Number);
  if (![x1, y1, x2, y2].every(Number.isFinite)) return null;
  return { x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
};

const lightPoint = (light: FoundryVTTLight): FoundryPoint | null =>
  Number.isFinite(light.x) && Number.isFinite(light.y)
    ? { x: light.x, y: light.y }
    : null;

const drawingPoint = (drawing: FoundryVTTDrawing): FoundryPoint | null => {
  const x = finiteNumber(drawing.x, Number.NaN);
  const y = finiteNumber(drawing.y, Number.NaN);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const width = finiteNumber(drawing.shape?.width ?? drawing.width);
  const height = finiteNumber(drawing.shape?.height ?? drawing.height);
  return { x: x + width / 2, y: y + height / 2 };
};

const countFeatureSupport = (
  scene: FoundryVTTData,
  footprint: FoundryMapFootprint,
  competingFootprints: FoundryMapFootprint[],
): number => {
  const walls = Array.isArray(scene.walls) ? scene.walls : [];
  const lights = Array.isArray(scene.lights) ? scene.lights : [];
  const drawings = Array.isArray(scene.drawings) ? scene.drawings : [];
  const wallCount = walls.filter((wall) => {
    if (!wall || typeof wall !== "object") return false;
    const point = wallMidpoint(wall);
    return (
      !!point &&
      pointInPolygon(point, footprint.polygon) &&
      !competingFootprints.some((candidate) =>
        pointInPolygon(point, candidate.polygon),
      )
    );
  }).length;
  const lightCount = lights.filter((light) => {
    if (!light || typeof light !== "object") return false;
    const point = lightPoint(light);
    return (
      !!point &&
      pointInPolygon(point, footprint.polygon) &&
      !competingFootprints.some((candidate) =>
        pointInPolygon(point, candidate.polygon),
      )
    );
  }).length;
  const drawingCount = drawings.filter((drawing) => {
    if (!drawing || typeof drawing !== "object" || drawing.interface === true) {
      return false;
    }
    const point = drawingPoint(drawing);
    return (
      !!point &&
      pointInPolygon(point, footprint.polygon) &&
      !competingFootprints.some((candidate) =>
        pointInPolygon(point, candidate.polygon),
      )
    );
  }).length;
  return wallCount + lightCount * 2 + drawingCount * 2;
};

const buildDraftMaps = (
  scene: FoundryVTTData,
  groups: FoundryVisualLayer[][],
): LogicalMapDraft[] => {
  const drafts = groups.map((layers) => {
    const primaryLayer = choosePrimaryLayer(layers);
    const sortedLayerIds = layers.map((layer) => layer.id).sort().join("|");
    const sceneId = scene._id?.trim() || scene.name.trim() || "scene";
    return {
      id: `${sceneId}::logical-map::${sortedLayerIds}`,
      footprint: primaryLayer.footprint,
      layers: [...layers].sort((left, right) => layerOrder(left) - layerOrder(right)),
      primaryLayer,
      featureSupport: 0,
    };
  });
  return drafts.map((draft, index) => ({
    ...draft,
    featureSupport: countFeatureSupport(
      scene,
      draft.footprint,
      drafts
        .filter((_, candidateIndex) => candidateIndex !== index)
        .map((candidate) => candidate.footprint),
    ),
  }));
};

const filterMapDrafts = (
  drafts: LogicalMapDraft[],
): { maps: LogicalMapDraft[]; ignored: LogicalMapDraft[] } => {
  if (drafts.length <= 1) return { maps: drafts, ignored: [] };
  const maxArea = Math.max(
    ...drafts.map((draft) => polygonArea(draft.footprint.polygon)),
  );
  const maps = drafts.filter((draft) => {
    const area = polygonArea(draft.footprint.polygon);
    return (
      area >= maxArea * SMALL_LAYER_AREA_RATIO ||
      draft.featureSupport > 0
    );
  });
  if (maps.length === 0) return { maps: drafts, ignored: [] };
  const mapIds = new Set(maps.map((draft) => draft.id));
  return {
    maps,
    ignored: drafts.filter((draft) => !mapIds.has(draft.id)),
  };
};

const assignPointToMap = (
  point: FoundryPoint,
  maps: LogicalMapDraft[],
): { mapIndex?: number; ambiguousMapIndexes: number[] } => {
  const candidates = maps
    .map((map, index) => ({ map, index }))
    .filter(({ map }) => pointInPolygon(point, map.footprint.polygon));
  if (candidates.length === 0) return { ambiguousMapIndexes: [] };
  if (candidates.length === 1) {
    return { mapIndex: candidates[0].index, ambiguousMapIndexes: [] };
  }

  const hasPositiveOverlap = candidates.some((candidate, index) =>
    candidates.slice(index + 1).some(
      (other) =>
        intersectionArea(candidate.map.footprint, other.map.footprint) > EPSILON,
    ),
  );
  if (hasPositiveOverlap) {
    return {
      ambiguousMapIndexes: candidates.map((candidate) => candidate.index),
    };
  }

  // Adjacent map footprints may both include a feature exactly on their shared edge.
  // Prefer the right-most/lower footprint, matching half-open rectangle ownership.
  const selected = [...candidates].sort((left, right) => {
    const xDifference = right.map.footprint.x - left.map.footprint.x;
    if (Math.abs(xDifference) > EPSILON) return xDifference;
    return right.map.footprint.y - left.map.footprint.y;
  })[0];
  return { mapIndex: selected.index, ambiguousMapIndexes: [] };
};

const getInterfaceLabels = (
  scene: FoundryVTTData,
  maps: LogicalMapDraft[],
): string[][] => {
  const labels = maps.map(() => [] as string[]);
  const drawings = Array.isArray(scene.drawings) ? scene.drawings : [];
  const gridSize = getGridSize(scene);
  for (const drawing of drawings) {
    if (!drawing || typeof drawing !== "object" || drawing.interface !== true) {
      continue;
    }
    const text = typeof drawing.text === "string" ? drawing.text.trim() : "";
    const point = drawingPoint(drawing);
    if (!text || !point) continue;
    const matches = maps
      .map((map, index) => {
        const footprint = map.footprint;
        const centerX = footprint.x + footprint.width / 2;
        const horizontalDistance = Math.abs(point.x - centerX) / footprint.width;
        const verticalDistance = Math.abs(point.y - footprint.y);
        const isNear =
          horizontalDistance <= 0.55 &&
          verticalDistance <= Math.max(gridSize * 4, footprint.height * 0.2);
        return { index, score: horizontalDistance + verticalDistance / footprint.height, isNear };
      })
      .filter((match) => match.isNear)
      .sort((left, right) => left.score - right.score);
    if (matches.length === 0) continue;
    const target = labels[matches[0].index];
    if (!target.includes(text)) target.push(text);
  }
  return labels;
};

const buildMapLabels = (
  scene: FoundryVTTData,
  maps: LogicalMapDraft[],
): string[] => {
  const interfaceLabels = getInterfaceLabels(scene, maps);
  const primaryNames = maps.map((map) => basename(map.primaryLayer.path));
  return maps.map((_, index) => {
    const labels = interfaceLabels[index];
    if (labels.length > 0) {
      return [...labels].sort((left, right) => {
        const leftLevel = /level|floor/i.test(left) ? 0 : 1;
        const rightLevel = /level|floor/i.test(right) ? 0 : 1;
        return leftLevel - rightLevel;
      }).join(" · ");
    }
    const primaryName = primaryNames[index] || scene.name || `Map ${index + 1}`;
    const duplicateCount = primaryNames.filter((name) => name === primaryName).length;
    return duplicateCount > 1 ? `${primaryName} · Map ${index + 1}` : primaryName;
  });
};

export function buildFoundryScenePlan(scene: FoundryVTTData): FoundryScenePlan {
  const sceneId = scene._id?.trim() || scene.name.trim() || "scene";
  const layers = buildVisualLayers(scene);
  if (layers.length === 0) {
    return {
      sceneId,
      maps: [],
      ignoredLayers: [],
      ambiguousWallIndexes: [],
      ambiguousLightIndexes: [],
      ambiguousDrawingIndexes: [],
      unassignedWallIndexes: [],
      unassignedLightIndexes: [],
      unassignedDrawingIndexes: [],
    };
  }

  const drafts = buildDraftMaps(scene, buildLayerGroups(layers));
  const filtered = filterMapDrafts(drafts);
  const maps = [...filtered.maps].sort((left, right) => {
    const yDifference = left.footprint.y - right.footprint.y;
    if (Math.abs(yDifference) > Math.min(left.footprint.height, right.footprint.height) * 0.25) {
      return yDifference;
    }
    return left.footprint.x - right.footprint.x;
  });
  const labels = buildMapLabels(scene, maps);
  const wallAssignments = maps.map(() => [] as number[]);
  const lightAssignments = maps.map(() => [] as number[]);
  const drawingAssignments = maps.map(() => [] as number[]);
  const ambiguousWallAssignments = maps.map(() => [] as number[]);
  const ambiguousLightAssignments = maps.map(() => [] as number[]);
  const ambiguousDrawingAssignments = maps.map(() => [] as number[]);
  const ambiguousWallIndexes: number[] = [];
  const ambiguousLightIndexes: number[] = [];
  const ambiguousDrawingIndexes: number[] = [];
  const unassignedWallIndexes: number[] = [];
  const unassignedLightIndexes: number[] = [];
  const unassignedDrawingIndexes: number[] = [];

  const walls = Array.isArray(scene.walls) ? scene.walls : [];
  walls.forEach((wall, index) => {
    if (!wall || typeof wall !== "object") return;
    const point = wallMidpoint(wall);
    if (!point) return;
    const assignment = assignPointToMap(point, maps);
    if (assignment.ambiguousMapIndexes.length > 0) {
      ambiguousWallIndexes.push(index);
      assignment.ambiguousMapIndexes.forEach((mapIndex) =>
        ambiguousWallAssignments[mapIndex].push(index),
      );
    }
    else if (assignment.mapIndex === undefined) unassignedWallIndexes.push(index);
    else wallAssignments[assignment.mapIndex].push(index);
  });

  const lights = Array.isArray(scene.lights) ? scene.lights : [];
  lights.forEach((light, index) => {
    if (!light || typeof light !== "object") return;
    const point = lightPoint(light);
    if (!point) return;
    const assignment = assignPointToMap(point, maps);
    if (assignment.ambiguousMapIndexes.length > 0) {
      ambiguousLightIndexes.push(index);
      assignment.ambiguousMapIndexes.forEach((mapIndex) =>
        ambiguousLightAssignments[mapIndex].push(index),
      );
    }
    else if (assignment.mapIndex === undefined) unassignedLightIndexes.push(index);
    else lightAssignments[assignment.mapIndex].push(index);
  });

  const drawings = Array.isArray(scene.drawings) ? scene.drawings : [];
  drawings.forEach((drawing, index) => {
    if (!drawing || typeof drawing !== "object" || drawing.interface === true) {
      return;
    }
    const point = drawingPoint(drawing);
    if (!point) return;
    const assignment = assignPointToMap(point, maps);
    if (assignment.ambiguousMapIndexes.length > 0) {
      ambiguousDrawingIndexes.push(index);
      assignment.ambiguousMapIndexes.forEach((mapIndex) =>
        ambiguousDrawingAssignments[mapIndex].push(index),
      );
    }
    else if (assignment.mapIndex === undefined) unassignedDrawingIndexes.push(index);
    else drawingAssignments[assignment.mapIndex].push(index);
  });

  const logicalMaps: FoundryLogicalMap[] = maps.map((map, index) => {
    const matchTerms = Array.from(
      new Set([
        labels[index],
        ...map.layers.flatMap((layer) => [layer.path, basename(layer.path)]),
      ].filter((value): value is string => !!value)),
    );
    return {
      id: map.id,
      label: labels[index],
      footprint: map.footprint,
      layers: map.layers,
      primaryLayer: map.primaryLayer,
      wallIndexes: wallAssignments[index],
      lightIndexes: lightAssignments[index],
      drawingIndexes: drawingAssignments[index],
      ambiguousWallIndexes: ambiguousWallAssignments[index],
      ambiguousLightIndexes: ambiguousLightAssignments[index],
      ambiguousDrawingIndexes: ambiguousDrawingAssignments[index],
      matchTerms,
    };
  });

  return {
    sceneId,
    maps: logicalMaps,
    ignoredLayers: filtered.ignored.flatMap((draft) => draft.layers),
    ambiguousWallIndexes,
    ambiguousLightIndexes,
    ambiguousDrawingIndexes,
    unassignedWallIndexes,
    unassignedLightIndexes,
    unassignedDrawingIndexes,
  };
}

export function selectFoundryLogicalMapFeatures(
  scene: FoundryVTTData,
  map: FoundryLogicalMap,
  scope: "selected-map" | "full-scene",
): FoundryVTTData {
  if (scope === "full-scene") {
    return {
      ...scene,
      drawings: (scene.drawings ?? []).filter(
        (drawing) => typeof drawing !== "object" || drawing.interface !== true,
      ),
    };
  }
  const walls = Array.isArray(scene.walls) ? scene.walls : [];
  const lights = Array.isArray(scene.lights) ? scene.lights : [];
  const drawings = Array.isArray(scene.drawings) ? scene.drawings : [];
  return {
    ...scene,
    walls: map.wallIndexes.map((index) => walls[index]).filter(
      (wall): wall is FoundryVTTWall => !!wall && typeof wall === "object",
    ),
    lights: map.lightIndexes.map((index) => lights[index]).filter(
      (light): light is FoundryVTTLight => !!light && typeof light === "object",
    ),
    drawings: map.drawingIndexes.map((index) => drawings[index]).filter(
      (drawing): drawing is FoundryVTTDrawing =>
        !!drawing && typeof drawing === "object" && drawing.interface !== true,
    ),
  };
}
