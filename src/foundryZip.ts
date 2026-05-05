import JSZip from "jszip";
import { isFoundryVTTData } from "./importVTT";
import {
  extractScenesFromAdventureLevelDB,
  extractScenesFromLevelDB,
} from "./leveldb";
import type { FoundryVTTData } from "./vttTypes";

export type FoundrySceneData = FoundryVTTData & {
  _id?: string;
  name?: string;
  img?: string;
  thumb?: string;
  tiles?: Array<
    | string
    | {
        _id?: string;
        img?: string;
        texture?: {
          src?: string;
        };
      }
  >;
  background?: {
    src?: string;
    offsetX?: number;
    offsetY?: number;
    scaleX?: number;
    scaleY?: number;
    rotation?: number;
  };
};

export type FoundryZipScene = {
  name: string;
  data: FoundrySceneData;
  fileSource: string;
};

export type FoundrySceneMapSource = {
  path: string;
  placement?: {
    x?: number;
    y?: number;
    rotation?: number;
    scaleX?: number;
    scaleY?: number;
    targetWidth?: number;
    targetHeight?: number;
    z?: number;
    sort?: number;
    elevation?: number;
    orderIndex?: number;
    zIndex?: number;
  };
};

const extractTileSourcePath = (tile: unknown): string | null => {
  if (!tile || typeof tile !== "object") return null;
  const candidate = tile as {
    img?: unknown;
    texture?: { src?: unknown };
  };
  if (typeof candidate.img === "string" && candidate.img.trim().length > 0) {
    return candidate.img;
  }
  const textureSrc = candidate.texture?.src;
  if (typeof textureSrc === "string" && textureSrc.trim().length > 0) {
    return textureSrc;
  }
  return null;
};

export const getFoundrySceneMapImagePaths = (
  scene: FoundrySceneData,
): string[] => {
  const collectUniquePaths = (values: Array<string | null | undefined>) => {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const value of values) {
      if (!value) continue;
      const normalized = value.trim();
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      result.push(normalized);
    }
    return result;
  };

  const primaryPaths = collectUniquePaths([scene.img, scene.background?.src]);
  const tilePaths: Array<string | null> = [];
  if (Array.isArray(scene.tiles)) {
    for (const tile of scene.tiles) {
      if (typeof tile === "string") continue;
      tilePaths.push(extractTileSourcePath(tile));
    }
  }
  return collectUniquePaths([...primaryPaths, ...tilePaths]);
};

export const getFoundrySceneMapSources = (
  scene: FoundrySceneData,
): FoundrySceneMapSource[] => {
  const toFiniteOrUndefined = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;
  const normalizePath = (path: string | null | undefined): string | null => {
    if (!path) return null;
    const normalized = path.trim();
    return normalized.length > 0 ? normalized : null;
  };

  const sources: FoundrySceneMapSource[] = [];
  const seen = new Set<string>();
  const addSource = (source: FoundrySceneMapSource) => {
    const placement = source.placement;
    const dedupeKey = [
      source.path,
      toFiniteOrUndefined(placement?.x) ?? "none",
      toFiniteOrUndefined(placement?.y) ?? "none",
      toFiniteOrUndefined(placement?.rotation) ?? "none",
      toFiniteOrUndefined(placement?.scaleX) ?? "none",
      toFiniteOrUndefined(placement?.scaleY) ?? "none",
      toFiniteOrUndefined(placement?.targetWidth) ?? "none",
      toFiniteOrUndefined(placement?.targetHeight) ?? "none",
      toFiniteOrUndefined(placement?.z) ?? "none",
      toFiniteOrUndefined(placement?.sort) ?? "none",
      toFiniteOrUndefined(placement?.elevation) ?? "none",
      toFiniteOrUndefined(placement?.zIndex) ?? "none",
      toFiniteOrUndefined(placement?.orderIndex) ?? "none",
    ].join("|");
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    sources.push(source);
  };

  const background = scene.background;
  const shiftX = toFiniteOrUndefined(scene.shiftX);
  const shiftY = toFiniteOrUndefined(scene.shiftY);
  const offsetX =
    shiftX && shiftX !== 0
      ? shiftX
      : toFiniteOrUndefined(background?.offsetX);
  const offsetY =
    shiftY && shiftY !== 0
      ? shiftY
      : toFiniteOrUndefined(background?.offsetY);
  const primaryPaths = [normalizePath(scene.img), normalizePath(scene.background?.src)];
  for (const path of primaryPaths) {
    if (!path) continue;
    addSource({
      path,
      placement: {
        x: offsetX,
        y: offsetY,
        rotation: toFiniteOrUndefined(background?.rotation),
        scaleX: toFiniteOrUndefined(background?.scaleX),
        scaleY: toFiniteOrUndefined(background?.scaleY),
      },
    });
  }

  if (!Array.isArray(scene.tiles)) return sources;

  for (let tileIndex = 0; tileIndex < scene.tiles.length; tileIndex++) {
    const tile = scene.tiles[tileIndex];
    if (!tile || typeof tile !== "object") continue;
    const path = normalizePath(extractTileSourcePath(tile));
    if (!path) continue;

    const placementSource = tile as {
      x?: unknown;
      y?: unknown;
      z?: unknown;
      sort?: unknown;
      elevation?: unknown;
      width?: unknown;
      height?: unknown;
      rotation?: unknown;
      texture?: {
        scaleX?: unknown;
        scaleY?: unknown;
      };
    };
    addSource({
      path,
      placement: {
        x: toFiniteOrUndefined(placementSource.x),
        y: toFiniteOrUndefined(placementSource.y),
        z: toFiniteOrUndefined(placementSource.z),
        sort: toFiniteOrUndefined(placementSource.sort),
        elevation: toFiniteOrUndefined(placementSource.elevation),
        orderIndex: tileIndex,
        zIndex:
          toFiniteOrUndefined(placementSource.z) ??
          toFiniteOrUndefined(placementSource.sort),
        targetWidth: toFiniteOrUndefined(placementSource.width),
        targetHeight: toFiniteOrUndefined(placementSource.height),
        rotation: toFiniteOrUndefined(placementSource.rotation),
        scaleX: toFiniteOrUndefined(placementSource.texture?.scaleX),
        scaleY: toFiniteOrUndefined(placementSource.texture?.scaleY),
      },
    });
  }

  return sources;
};

const normalizeZipPath = (path: string): string =>
  path
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\//, "")
    .replace(/\/+/g, "/");

const findLevelDbFilesForPack = (zip: JSZip, packPath: string): string[] => {
  const allPaths = Object.keys(zip.files);
  const normalizedPackPath = normalizeZipPath(packPath).replace(/\/+$/, "");
  const candidateRoots = new Set<string>();

  if (normalizedPackPath) {
    candidateRoots.add(normalizedPackPath);

    if (normalizedPackPath.toLowerCase().endsWith(".db")) {
      candidateRoots.add(normalizedPackPath.slice(0, -3));
    }

    const lastSlash = normalizedPackPath.lastIndexOf("/");
    const baseName =
      lastSlash >= 0
        ? normalizedPackPath.slice(lastSlash + 1)
        : normalizedPackPath;
    if (baseName.toLowerCase().endsWith(".db")) {
      const trimmedBase = baseName.slice(0, -3);
      candidateRoots.add(trimmedBase);
      if (lastSlash >= 0) {
        candidateRoots.add(
          `${normalizedPackPath.slice(0, lastSlash + 1)}${trimmedBase}`,
        );
      }
    }
  }

  const normalizedCandidates = Array.from(candidateRoots).map((candidate) =>
    normalizeZipPath(candidate).replace(/\/+$/, "/").toLowerCase(),
  );

  const matches = allPaths.filter((path) => {
    const normalizedPath = normalizeZipPath(path).toLowerCase();
    if (!normalizedPath.endsWith(".ldb")) return false;

    return normalizedCandidates.some(
      (candidate) =>
        normalizedPath.startsWith(candidate) ||
        normalizedPath.includes(`/${candidate}`),
    );
  });

  return Array.from(new Set(matches)).sort();
};

const parseJsonLineDocs = (content: string): unknown[] =>
  content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });

const loadLdbBuffers = async (
  zip: JSZip,
  ldbPaths: string[],
): Promise<ArrayBuffer[]> =>
  Promise.all(
    ldbPaths
      .map((path) => zip.file(path))
      .filter((file): file is JSZip.JSZipObject => !!file)
      .map((file) => file.async("arraybuffer")),
  );

type PackType = "Scene" | "Adventure";

const addFoundrySceneCandidate = (
  scenes: FoundryZipScene[],
  seenSceneIds: Set<string>,
  candidate: unknown,
  fileSource: string,
) => {
  if (!isFoundryVTTData(candidate)) return;
  const scene = candidate as FoundrySceneData;
  const sceneName =
    typeof scene.name === "string" && scene.name.trim().length > 0
      ? scene.name
      : "Unnamed Scene";
  const sceneId =
    typeof scene._id === "string" && scene._id.trim().length > 0
      ? scene._id
      : null;

  if (sceneId && seenSceneIds.has(sceneId)) return;
  if (sceneId) seenSceneIds.add(sceneId);

  scenes.push({
    name: sceneName,
    data: scene,
    fileSource,
  });
};

const addScenesFromDocs = (
  scenes: FoundryZipScene[],
  seenSceneIds: Set<string>,
  docs: unknown[],
  fileSource: string,
  sourceType?: PackType,
) => {
  const addScenesFromAdventureDocument = (candidate: unknown) => {
    if (!candidate || typeof candidate !== "object") return;
    const adventureScenes = (candidate as { scenes?: unknown[] }).scenes;
    if (!Array.isArray(adventureScenes)) return;

    for (const adventureScene of adventureScenes) {
      addFoundrySceneCandidate(scenes, seenSceneIds, adventureScene, fileSource);
    }
  };

  const isAdventureSource = sourceType === "Adventure";
  for (const doc of docs) {
    if (isAdventureSource) {
      addScenesFromAdventureDocument(doc);
    } else {
      addFoundrySceneCandidate(scenes, seenSceneIds, doc, fileSource);
      addScenesFromAdventureDocument(doc);
    }
  }
};

const addScenesFromLdbBuffers = (
  scenes: FoundryZipScene[],
  seenSceneIds: Set<string>,
  ldbBuffers: ArrayBuffer[],
  fileSource: string,
  sourceType?: PackType,
) => {
  if (sourceType === "Adventure") {
    for (const scene of extractScenesFromAdventureLevelDB(ldbBuffers)) {
      addFoundrySceneCandidate(scenes, seenSceneIds, scene, fileSource);
    }
    return;
  }
  if (sourceType === "Scene") {
    for (const scene of extractScenesFromLevelDB(ldbBuffers)) {
      addFoundrySceneCandidate(scenes, seenSceneIds, scene, fileSource);
    }
    return;
  }
  for (const scene of extractScenesFromLevelDB(ldbBuffers)) {
    addFoundrySceneCandidate(scenes, seenSceneIds, scene, fileSource);
  }
  for (const scene of extractScenesFromAdventureLevelDB(ldbBuffers)) {
    addFoundrySceneCandidate(scenes, seenSceneIds, scene, fileSource);
  }
};

type ModulePackLike = {
  type?: string;
  path?: string;
};

export async function extractScenesFromFoundryZip(
  zip: JSZip,
  fileSource: string,
): Promise<FoundryZipScene[]> {
  let moduleJsonFile = zip.file("module.json");
  if (!moduleJsonFile) {
    const match = Object.keys(zip.files).find((p) => p.endsWith("module.json"));
    if (match) moduleJsonFile = zip.file(match);
  }

  let moduleJson: { packs?: ModulePackLike[] } | null = null;
  if (moduleJsonFile) {
    const content = await moduleJsonFile.async("string");
    moduleJson = JSON.parse(content);
  }

  const scenes: FoundryZipScene[] = [];
  const seenSceneIds = new Set<string>();

  if (moduleJson && Array.isArray(moduleJson.packs)) {
    for (const pack of moduleJson.packs) {
      if (
        (pack.type === "Scene" || pack.type === "Adventure") &&
        pack.path
      ) {
        const packType = pack.type as PackType;
        let packPath = pack.path.replace(/\\/g, "/");
        if (packPath.startsWith(".")) packPath = packPath.substring(1);
        if (packPath.startsWith("/")) packPath = packPath.substring(1);

        let packFile = zip.file(packPath);
        if (!packFile) {
          const match = Object.keys(zip.files).find(
            (p) => p.endsWith(packPath) || packPath.endsWith(p),
          );
          if (match) packFile = zip.file(match);
        }

        if (packFile) {
          const content = await packFile.async("string");
          addScenesFromDocs(
            scenes,
            seenSceneIds,
            parseJsonLineDocs(content),
            fileSource,
            packType,
          );
        } else {
          // Try LevelDB format (it might be a directory in the zip)
          // Support both legacy `<pack>.db` paths and modern `<pack>/` ldb directories.
          const ldbFiles = findLevelDbFilesForPack(zip, packPath);

          if (ldbFiles.length > 0) {
            addScenesFromLdbBuffers(
              scenes,
              seenSceneIds,
              await loadLdbBuffers(zip, ldbFiles),
              fileSource,
              packType,
            );
          }
        }
      }
    }
  }

  if (scenes.length === 0) {
    const allLdbFiles = Object.keys(zip.files)
      .filter((path) => path.toLowerCase().endsWith(".ldb"))
      .sort();

    if (allLdbFiles.length > 0) {
      addScenesFromLdbBuffers(
        scenes,
        seenSceneIds,
        await loadLdbBuffers(zip, allLdbFiles),
        fileSource,
      );
    }

    if (scenes.length === 0) {
      for (const path of Object.keys(zip.files)) {
        const lower = path.toLowerCase();
        if (lower.endsWith(".db") || lower.endsWith(".json")) {
          if (lower.endsWith("module.json")) continue;
          const file = zip.file(path);
          if (!file) continue;
          const content = await file.async("string");
          addScenesFromDocs(
            scenes,
            seenSceneIds,
            parseJsonLineDocs(content),
            fileSource,
          );
        }
      }
    }
  }

  return scenes;
}
