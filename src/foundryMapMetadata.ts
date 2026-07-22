export const FOUNDRY_MAP_IDENTITY_KEY =
  "com.eppinguin.scene-importer/foundry-map";

export type FoundryMapIdentity = {
  version: 1;
  sceneId: string;
  logicalMapId: string;
  layerId: string;
};

export const readFoundryMapIdentity = (
  value: unknown,
): FoundryMapIdentity | null => {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<FoundryMapIdentity>;
  if (
    candidate.version !== 1 ||
    typeof candidate.sceneId !== "string" ||
    typeof candidate.logicalMapId !== "string" ||
    typeof candidate.layerId !== "string"
  ) {
    return null;
  }
  return {
    version: 1,
    sceneId: candidate.sceneId,
    logicalMapId: candidate.logicalMapId,
    layerId: candidate.layerId,
  };
};
