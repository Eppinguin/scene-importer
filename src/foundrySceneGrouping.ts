import type { FoundryFolderMeta } from "./foundryZip";

export const UNGROUPED_FOLDER_ID = "__foundry_ungrouped__";

export type FoundrySceneGroupingItem = {
  index: number;
  name: string;
  folderId?: string | null;
  sort?: number;
};

export type FoundryFolderNode = {
  id: string;
  name: string;
  parentId: string | null;
  sort: number;
  children: FoundryFolderNode[];
};

export type FoundryGroupedFolderNode = {
  id: string;
  name: string;
  parentId: string | null;
  sort: number;
  sceneIndices: number[];
  totalSceneCount: number;
  children: FoundryGroupedFolderNode[];
};

export type GroupedFoundryScenes = {
  roots: FoundryGroupedFolderNode[];
  ungroupedSceneIndices: number[];
};

const normalizeFolderId = (value: string | null | undefined): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
};

const toFoundrySortValue = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

const compareByFoundrySortAndName = (a: { sort?: number; name: string }, b: { sort?: number; name: string }): number => {
  const sortDelta = toFoundrySortValue(a.sort) - toFoundrySortValue(b.sort);
  if (sortDelta !== 0) return sortDelta;
  return a.name.localeCompare(b.name, undefined, {
    sensitivity: "base",
    numeric: true,
  });
};

export const sortScenesFoundryOrder = <T extends { name: string; sort?: number }>(
  scenes: T[],
): T[] => [...scenes].sort(compareByFoundrySortAndName);

export const buildFolderTree = (
  folders: FoundryFolderMeta[],
  scenes: FoundrySceneGroupingItem[],
): FoundryFolderNode[] => {
  const normalizedFolders = new Map<
    string,
    { id: string; name: string; parentId: string | null; sort: number; type?: string }
  >();
  for (const folder of folders) {
    const id = normalizeFolderId(folder._id);
    if (!id || normalizedFolders.has(id)) continue;
    normalizedFolders.set(id, {
      id,
      name:
        typeof folder.name === "string" && folder.name.trim().length > 0
          ? folder.name.trim()
          : "Untitled Folder",
      parentId: normalizeFolderId(folder.folder),
      sort: toFoundrySortValue(folder.sort),
      type:
        typeof folder.type === "string" && folder.type.trim().length > 0
          ? folder.type.trim()
          : undefined,
    });
  }

  const referencedSceneFolderIds = new Set<string>();
  for (const scene of scenes) {
    const folderId = normalizeFolderId(scene.folderId);
    if (folderId) referencedSceneFolderIds.add(folderId);
  }

  const includedFolderIds = new Set<string>();
  for (const folder of normalizedFolders.values()) {
    if (folder.type?.toLowerCase() === "scene" || referencedSceneFolderIds.has(folder.id)) {
      includedFolderIds.add(folder.id);
    }
  }

  for (const id of Array.from(includedFolderIds)) {
    let current = normalizedFolders.get(id);
    while (current?.parentId) {
      const parent = normalizedFolders.get(current.parentId);
      if (!parent) break;
      includedFolderIds.add(parent.id);
      current = parent;
    }
  }

  const nodesById = new Map<string, FoundryFolderNode>();
  for (const id of includedFolderIds) {
    const folder = normalizedFolders.get(id);
    if (!folder) continue;
    nodesById.set(id, {
      id: folder.id,
      name: folder.name,
      parentId: folder.parentId && folder.parentId !== folder.id ? folder.parentId : null,
      sort: folder.sort,
      children: [],
    });
  }

  const roots: FoundryFolderNode[] = [];
  for (const node of nodesById.values()) {
    const parent = node.parentId ? nodesById.get(node.parentId) : null;
    if (parent) {
      parent.children.push(node);
      continue;
    }
    roots.push(node);
  }

  const sortNodes = (nodes: FoundryFolderNode[]) => {
    nodes.sort(compareByFoundrySortAndName);
    for (const node of nodes) {
      sortNodes(node.children);
    }
  };
  sortNodes(roots);

  return roots;
};

const sortSceneIndicesInPlace = (
  indices: number[],
  scenesByIndex: Map<number, FoundrySceneGroupingItem>,
) => {
  indices.sort((left, right) => {
    const leftScene = scenesByIndex.get(left);
    const rightScene = scenesByIndex.get(right);
    if (!leftScene && !rightScene) return left - right;
    if (!leftScene) return 1;
    if (!rightScene) return -1;
    const sortDelta = compareByFoundrySortAndName(leftScene, rightScene);
    return sortDelta !== 0 ? sortDelta : left - right;
  });
};

export const groupScenesByFolder = (
  scenes: FoundrySceneGroupingItem[],
  folderTree: FoundryFolderNode[],
): GroupedFoundryScenes => {
  const groupedNodesById = new Map<string, FoundryGroupedFolderNode>();
  const cloneNode = (node: FoundryFolderNode): FoundryGroupedFolderNode => {
    const cloned: FoundryGroupedFolderNode = {
      ...node,
      children: node.children.map(cloneNode),
      sceneIndices: [],
      totalSceneCount: 0,
    };
    groupedNodesById.set(cloned.id, cloned);
    return cloned;
  };

  const roots = folderTree.map(cloneNode);
  const scenesByIndex = new Map<number, FoundrySceneGroupingItem>(
    scenes.map((scene) => [scene.index, scene]),
  );

  const ungroupedSceneIndices: number[] = [];
  for (const scene of scenes) {
    const folderId = normalizeFolderId(scene.folderId);
    if (!folderId) {
      ungroupedSceneIndices.push(scene.index);
      continue;
    }
    const folder = groupedNodesById.get(folderId);
    if (!folder) {
      ungroupedSceneIndices.push(scene.index);
      continue;
    }
    folder.sceneIndices.push(scene.index);
  }

  const finalizeNode = (node: FoundryGroupedFolderNode): number => {
    sortSceneIndicesInPlace(node.sceneIndices, scenesByIndex);
    const childCount = node.children.reduce(
      (total, child) => total + finalizeNode(child),
      0,
    );
    node.totalSceneCount = node.sceneIndices.length + childCount;
    return node.totalSceneCount;
  };
  for (const node of roots) {
    finalizeNode(node);
  }
  sortSceneIndicesInPlace(ungroupedSceneIndices, scenesByIndex);

  return { roots, ungroupedSceneIndices };
};

export const filterGroupedScenesBySearch = (
  grouped: GroupedFoundryScenes,
  scenes: FoundrySceneGroupingItem[],
  query: string,
): GroupedFoundryScenes => {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return grouped;
  }

  const scenesByIndex = new Map<number, FoundrySceneGroupingItem>(
    scenes.map((scene) => [scene.index, scene]),
  );
  const sceneMatches = (sceneIndex: number): boolean => {
    const scene = scenesByIndex.get(sceneIndex);
    if (!scene) return false;
    return scene.name.toLowerCase().includes(normalizedQuery);
  };

  const cloneNode = (node: FoundryGroupedFolderNode): FoundryGroupedFolderNode => ({
    ...node,
    children: node.children.map(cloneNode),
    sceneIndices: [...node.sceneIndices],
  });

  const filterNode = (
    node: FoundryGroupedFolderNode,
  ): FoundryGroupedFolderNode | null => {
    const folderMatches = node.name.toLowerCase().includes(normalizedQuery);
    if (folderMatches) {
      return cloneNode(node);
    }

    const filteredChildren = node.children
      .map(filterNode)
      .filter((child): child is FoundryGroupedFolderNode => !!child);
    const filteredScenes = node.sceneIndices.filter(sceneMatches);
    if (filteredChildren.length === 0 && filteredScenes.length === 0) {
      return null;
    }

    const totalSceneCount =
      filteredScenes.length +
      filteredChildren.reduce((total, child) => total + child.totalSceneCount, 0);
    return {
      ...node,
      children: filteredChildren,
      sceneIndices: filteredScenes,
      totalSceneCount,
    };
  };

  const filteredRoots = grouped.roots
    .map(filterNode)
    .filter((node): node is FoundryGroupedFolderNode => !!node);
  const filteredUngrouped = grouped.ungroupedSceneIndices.filter(sceneMatches);

  return {
    roots: filteredRoots,
    ungroupedSceneIndices: filteredUngrouped,
  };
};
