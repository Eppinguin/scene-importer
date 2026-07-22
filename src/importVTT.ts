import OBR, {
    buildImage,
    buildImageUpload,
    buildSceneUpload,
    type ImageContent,
    type ImageGrid,
    type Item,
    type Vector2
} from "@owlbear-rodeo/sdk";
import { type VTTMapData, type UniversalVTT, type FoundryVTTData, type FoundryVTTWall, type FoundryVTTLight, type FoundryVTTDrawing, type VTTDrawing } from "./vttTypes";
import { createWallItems, createDoorItems, createLightItems, createDrawingItems, type LightImportOptions } from "./vttItems";
import {
    selectFoundryLogicalMapFeatures,
    type FoundryLogicalMap,
} from "./foundryScenePlan";
import {
    FOUNDRY_MAP_IDENTITY_KEY,
    type FoundryMapIdentity,
} from "./foundryMapMetadata";
export type { LightImportOptions } from "./vttItems";

type VTTData = VTTMapData;

import JSZip from 'jszip';

const DEFAULT_NEW_SCENE_GRID_DPI = 150;
const DYNAMIC_FOG_LIGHT_KEY = "rodeo.owlbear.dynamic-fog/light";
const CHROMODYNAMIC_LIGHT_KEY = "com.desain.chromodynamic/light";

export function isFoundryVTTData(data: unknown): data is FoundryVTTData {
    const d = data as Partial<FoundryVTTData>;
    const hasNumericGrid = typeof d.grid === 'number';
    const hasGridObject = typeof d.grid === 'object' && d.grid !== null && 'size' in d.grid;
    const isSceneReferenceId = (value: unknown): value is string =>
        typeof value === 'string' && value.trim().length > 0;
    const isWallObject = (value: unknown): value is Partial<FoundryVTTWall> =>
        typeof value === 'object'
        && value !== null
        && Array.isArray((value as Partial<FoundryVTTWall>).c)
        && (value as Partial<FoundryVTTWall>).c!.length === 4;
    const isLightObject = (value: unknown): value is Partial<FoundryVTTLight> =>
        typeof value === 'object' && value !== null;
    const hasValidWalls = d.walls === undefined || (
        Array.isArray(d.walls)
        && d.walls.every((w: unknown) =>
            isSceneReferenceId(w) || isWallObject(w))
    );
    const hasValidLights = d.lights === undefined || (
        Array.isArray(d.lights)
        && d.lights.every((light: unknown) => isSceneReferenceId(light) || isLightObject(light))
    );
    return !!d
        && typeof d.width === 'number'
        && typeof d.height === 'number'
        && (hasNumericGrid || hasGridObject)
        && hasValidWalls
        && hasValidLights;
}

export function isUniversalVTTData(data: unknown): data is UniversalVTT {
    const d = data as Partial<UniversalVTT>;
    return !!d
        && typeof d.format === 'number'
        && !!d.resolution
        && (Array.isArray(d.line_of_sight) || Array.isArray(d.objects_line_of_sight) || Array.isArray(d.lights));
}

// Helper function to detect if VTT data contains an image
export function hasMapImage(data: unknown): boolean {
    return !!(data && typeof data === 'object' && 'image' in data && (data as { image?: string }).image);
}

function normalizeFoundryColor(value: unknown, fallback: string): string {
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) return fallback;
        const hexMatch = trimmed.match(/^#?([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3}|[A-Fa-f0-9]{8})$/);
        if (!hexMatch) return fallback;
        let hex = hexMatch[1];
        if (hex.length === 3) {
            hex = hex.split('').map((channel) => channel + channel).join('');
        } else if (hex.length === 8) {
            hex = hex.slice(0, 6);
        }
        return `#${hex.toUpperCase()}`;
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
        const normalized = Math.max(0, Math.min(0xffffff, Math.round(value)));
        return `#${normalized.toString(16).padStart(6, '0').toUpperCase()}`;
    }

    return fallback;
}

function normalizeFoundryPoints(points: unknown): number[] {
    if (!Array.isArray(points)) return [];
    if (points.length === 0) return [];
    if (typeof points[0] === 'number') {
        const raw = points as unknown[];
        const result: number[] = [];
        for (let i = 0; i < raw.length; i++) {
            const value = Number(raw[i]);
            if (!Number.isFinite(value)) continue;
            result.push(value);
        }
        return result.length >= 4 ? result : [];
    }

    const nested = points as unknown[];
    const flattened: number[] = [];
    for (const point of nested) {
        if (!Array.isArray(point) || point.length < 2) continue;
        const x = Number(point[0]);
        const y = Number(point[1]);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        flattened.push(x, y);
    }
    return flattened.length >= 4 ? flattened : [];
}

function toVttDrawingType(value: unknown): VTTDrawing['type'] {
    const normalized = typeof value === 'string' ? value.trim().toUpperCase() : '';
    if (normalized === 'T' || normalized === 'TEXT') return 'TEXT';
    if (normalized === 'R' || normalized === 'RECT' || normalized === 'RECTANGLE') return 'RECTANGLE';
    if (normalized === 'E' || normalized === 'ELLIPSE' || normalized === 'CIRCLE') return 'ELLIPSE';
    if (normalized === 'P' || normalized === 'POLYGON') return 'POLYGON';
    if (normalized === 'F' || normalized === 'FREEHAND') return 'FREEHAND';
    return 'RECTANGLE';
}

function pointsDefineClosedLoop(points: number[]): boolean {
    if (points.length < 4) return false;
    const firstX = points[0];
    const firstY = points[1];
    const lastX = points[points.length - 2];
    const lastY = points[points.length - 1];
    return Number.isFinite(firstX)
        && Number.isFinite(firstY)
        && Number.isFinite(lastX)
        && Number.isFinite(lastY)
        && Math.abs(firstX - lastX) <= 0.00001
        && Math.abs(firstY - lastY) <= 0.00001;
}

function convertFoundryDrawingsToVTTDrawings(
    sourceDrawings: Array<FoundryVTTDrawing | string>,
    offsetX: number,
    offsetY: number,
    gridSize: number,
    transformPoint: (point: Vector2) => Vector2 = (point) => point,
    rotationOffset = 0
): VTTDrawing[] {
    const drawings: VTTDrawing[] = [];

    for (const drawing of sourceDrawings) {
        if (!drawing || typeof drawing !== 'object') continue;

        const rawX = Number(drawing.x ?? 0);
        const rawY = Number(drawing.y ?? 0);
        const transformedPosition = transformPoint({
            x: Number.isFinite(rawX) ? rawX : 0,
            y: Number.isFinite(rawY) ? rawY : 0,
        });
        const x = transformedPosition.x - offsetX;
        const y = transformedPosition.y - offsetY;

        const shape = drawing.shape;
        const rawType = drawing.type ?? drawing.t ?? shape?.type;
        let shapeType = toVttDrawingType(rawType);
        const width = Number(shape?.width ?? drawing.width);
        const height = Number(shape?.height ?? drawing.height);
        const radius = Number(shape?.radius);
        const rawPoints = normalizeFoundryPoints(shape?.points ?? drawing.points);
        const points = rawPoints.map((point) => point / gridSize);
        const text = typeof drawing.text === 'string' ? drawing.text : '';

        if (
            shapeType !== 'TEXT' &&
            !Number.isFinite(width) &&
            !Number.isFinite(height) &&
            !Number.isFinite(radius) &&
            points.length < 4
        ) {
            continue;
        }

        const fillAlpha = Number(drawing.fillAlpha);
        const strokeAlpha = Number(drawing.strokeAlpha);
        const strokeWidth = Number(drawing.strokeWidth);
        const fillType = Number(drawing.fillType);
        const hasExplicitFillColor = drawing.fillColor !== undefined && drawing.fillColor !== null && `${drawing.fillColor}`.trim().length > 0;
        const hasExplicitStrokeColor = drawing.strokeColor !== undefined && drawing.strokeColor !== null && `${drawing.strokeColor}`.trim().length > 0;
        const fontSize = Number(drawing.fontSize);
        const textAlpha = Number(drawing.textAlpha);
        const rotation = Number(drawing.rotation);
        const z = Number.isFinite(Number(drawing.z)) ? Number(drawing.z) : 0;
        const sort = Number.isFinite(Number(drawing.sort)) ? Number(drawing.sort) : 0;
        const elevation = Number.isFinite(Number(drawing.elevation)) ? Number(drawing.elevation) : 0;
        const bezierFactor = Number(drawing.bezierFactor);

        const normalizedFillOpacity = Number.isFinite(fillAlpha) ? Math.max(0, Math.min(1, fillAlpha)) : 0;
        const fillTypeIsNone = Number.isFinite(fillType) && fillType === 0;
        const normalizedRawType = typeof rawType === 'string' ? rawType.trim().toUpperCase() : '';
        const explicitFreehandType = normalizedRawType === 'F' || normalizedRawType === 'FREEHAND';
        const hasBezierSmoothing = Number.isFinite(bezierFactor) && bezierFactor > 0;
        const hasFreehandPointDensity = points.length >= 8;
        const hasOpenStrokePath = hasFreehandPointDensity && !pointsDefineClosedLoop(points);
        const likelyFreehandFromPolygon = shapeType === 'POLYGON'
            && (
                explicitFreehandType
                || (hasOpenStrokePath && fillTypeIsNone)
                || (hasBezierSmoothing && (hasOpenStrokePath || fillTypeIsNone))
            );
        if (likelyFreehandFromPolygon) {
            shapeType = 'FREEHAND';
        }
        const effectiveFillOpacity = fillTypeIsNone ? 0 : normalizedFillOpacity;
        const normalizedStrokeOpacity = Number.isFinite(strokeAlpha) ? Math.max(0, Math.min(1, strokeAlpha)) : 1;
        const normalizedStrokeWidth = Number.isFinite(strokeWidth) ? Math.max(0, strokeWidth) / gridSize : 0;
        const hasFillDecoration = !fillTypeIsNone && effectiveFillOpacity > 0 && hasExplicitFillColor;
        const hasStrokeDecoration = normalizedStrokeWidth > 0 && normalizedStrokeOpacity > 0 && hasExplicitStrokeColor;
        const textHasShapeDecoration = hasFillDecoration || hasStrokeDecoration;

        const normalizedDrawing: VTTDrawing = {
            id: typeof drawing._id === 'string' ? drawing._id : undefined,
            type: shapeType,
            x: x / gridSize,
            y: y / gridSize,
            width: Number.isFinite(width) ? width / gridSize : undefined,
            height: Number.isFinite(height) ? height / gridSize : undefined,
            radius: Number.isFinite(radius) ? radius / gridSize : undefined,
            points: points.length >= 4 ? points : undefined,
            rotation: Number.isFinite(rotation) ? rotation + rotationOffset : rotationOffset,
            hidden: !!drawing.hidden,
            locked: !!drawing.locked,
            zIndex: Math.round(elevation * 1_000_000 + z * 1_000 + sort),
            fillColor: normalizeFoundryColor(drawing.fillColor, '#000000'),
            fillOpacity: effectiveFillOpacity,
            strokeColor: normalizeFoundryColor(drawing.strokeColor, '#000000'),
            strokeOpacity: normalizedStrokeOpacity,
            strokeWidth: normalizedStrokeWidth,
            text: text.trim().length > 0 ? text : undefined,
            textColor: normalizeFoundryColor(drawing.textColor, '#FFFFFF'),
            textOpacity: Number.isFinite(textAlpha) ? Math.max(0, Math.min(1, textAlpha)) : 1,
            fontFamily: typeof drawing.fontFamily === 'string' && drawing.fontFamily.trim().length > 0
                ? drawing.fontFamily
                : undefined,
            fontSize: Number.isFinite(fontSize) && fontSize > 0 ? fontSize / gridSize : undefined,
            textHasShapeDecoration,
            bezierFactor: Number.isFinite(bezierFactor) ? Math.max(0, Math.min(1, bezierFactor)) : undefined,
        };

        drawings.push(normalizedDrawing);
    }

    return drawings;
}

export type FoundryConversionOptions = {
    origin?: Vector2;
    mapSizePixels?: Vector2;
    sourceRotation?: number;
};

export function convertFoundryToVTTData(
    foundryData: FoundryVTTData,
    options: FoundryConversionOptions = {}
): VTTData {
    let padX = 0;
    let padY = 0;
    const sourceWalls = Array.isArray(foundryData.walls) ? foundryData.walls : [];
    const sourceLights = Array.isArray(foundryData.lights) ? foundryData.lights : [];
    const sourceDrawings = Array.isArray(foundryData.drawings) ? foundryData.drawings : [];

    // Resolve grid size handling for both Foundry V11 (numeric) and V12+ (object)
    const gridSize = typeof foundryData.grid === 'object' ? (foundryData.grid?.size || 100) : (Number(foundryData.grid) || 100);
    // Foundry light radii are scene distance values in many exports (e.g. ft, m), not pixels.
    // Convert those values to grid units expected by the VTTMapData pipeline.
    const gridDistanceTopLevel = Number(foundryData.gridDistance);
    const gridDistanceFromGridObject = typeof foundryData.grid === 'object'
        ? Number(foundryData.grid?.distance)
        : Number.NaN;

    const gridUnits = (typeof foundryData.grid === 'object' ? foundryData.grid?.units : undefined) || foundryData.gridUnits;
    const normalizedUnits = typeof gridUnits === 'string'
        ? gridUnits.trim().toLowerCase().replace(/[^a-z]+$/, '')
        : '';
    const isFeet = normalizedUnits === 'ft' || normalizedUnits === 'feet';
    const isMeters = normalizedUnits === 'm' || normalizedUnits === 'meter' || normalizedUnits === 'meters' || normalizedUnits === 'metre' || normalizedUnits === 'metres';
    const fallbackDistance = isFeet ? 5 : isMeters ? 1.5 : 1;

    const sceneDistancePerGrid = Number.isFinite(gridDistanceTopLevel) && gridDistanceTopLevel > 0
        ? gridDistanceTopLevel
        : (Number.isFinite(gridDistanceFromGridObject) && gridDistanceFromGridObject > 0
            ? gridDistanceFromGridObject
            : fallbackDistance);

    const displayUnit = isFeet
        ? 'ft'
        : isMeters
            ? 'm'
            : typeof gridUnits === 'string' && gridUnits.trim()
                ? gridUnits.trim()
                : 'ft';
    const gridScaleStr = `${sceneDistancePerGrid}${displayUnit}`;

    if (foundryData.padding !== undefined) {
        padX = Math.ceil((foundryData.width * foundryData.padding) / gridSize) * gridSize;
        padY = Math.ceil((foundryData.height * foundryData.padding) / gridSize) * gridSize;
    }
    const bgShiftX = foundryData.shiftX || (foundryData.background && foundryData.background.offsetX) || 0;
    const bgShiftY = foundryData.shiftY || (foundryData.background && foundryData.background.offsetY) || 0;

    const offsetX = options.origin?.x ?? (padX + bgShiftX);
    const offsetY = options.origin?.y ?? (padY + bgShiftY);
    const sourceRotation = Number.isFinite(options.sourceRotation)
        ? options.sourceRotation as number
        : 0;
    const mapSizePixels = options.mapSizePixels ?? {
        x: foundryData.width,
        y: foundryData.height,
    };
    const sourceCenter = {
        x: offsetX + mapSizePixels.x / 2,
        y: offsetY + mapSizePixels.y / 2,
    };
    const transformSourcePoint = (point: Vector2): Vector2 =>
        sourceRotation === 0
            ? point
            : rotatePointAroundOrigin(point, sourceCenter, -sourceRotation);

    const walls: Vector2[][] = sourceWalls
        .filter(wall => wall.door === 0) // Non-door walls
        .map(wall => {
            const start = transformSourcePoint({ x: wall.c[0], y: wall.c[1] });
            const end = transformSourcePoint({ x: wall.c[2], y: wall.c[3] });
            return [
                { x: (start.x - offsetX) / gridSize, y: (start.y - offsetY) / gridSize },
                { x: (end.x - offsetX) / gridSize, y: (end.y - offsetY) / gridSize }
            ];
        });

    const portals = sourceWalls
        .filter(wall => wall.door === 1) // Door walls
        .map(wall => {
            const start = transformSourcePoint({ x: wall.c[0], y: wall.c[1] });
            const end = transformSourcePoint({ x: wall.c[2], y: wall.c[3] });
            return {
                position: { x: 0, y: 0 }, // Not actually used by OBR sdk in same way
                bounds: [
                    { x: (start.x - offsetX) / gridSize, y: (start.y - offsetY) / gridSize },
                    { x: (end.x - offsetX) / gridSize, y: (end.y - offsetY) / gridSize }
                ],
                rotation: 0,
                closed: wall.ds === 0, // Assuming ds=0 means closed, ds=1 means open
                freestanding: false
            };
        });

    const lights = sourceLights
        .filter((light) => typeof light.x === 'number' && typeof light.y === 'number')
        .map((light) => {
            const transformedPosition = transformSourcePoint({ x: light.x, y: light.y });
            const config = light.config ?? {};
            const brightDistance = Number(config.bright ?? light.bright ?? 0);
            const dimDistance = Number(config.dim ?? light.dim ?? 0);
            const brightRadius = Number.isFinite(brightDistance) && brightDistance > 0
                ? brightDistance / sceneDistancePerGrid
                : 0;
            const dimRadius = Number.isFinite(dimDistance) && dimDistance > 0
                ? dimDistance / sceneDistancePerGrid
                : 0;
            const range = Math.max(brightRadius, dimRadius);
            const rawAngle = Number(config.angle ?? light.angle ?? 360);
            const angle = Number.isFinite(rawAngle)
                ? Math.min(360, Math.max(0, rawAngle))
                : 360;
            const rawRotation = Number(config.rotation ?? light.rotation ?? 0);
            const rotation = Number.isFinite(rawRotation)
                ? normalizeDegrees(rawRotation - sourceRotation)
                : 0;
            const rawColor = config.color ?? light.color;
            const tintAlpha = Number(config.tintAlpha ?? light.tintAlpha ?? 1);
            const rawTintColor = config.tintColor ?? light.tintColor;
            const color = typeof rawColor === 'string'
                ? rawColor
                : (typeof rawTintColor === 'string' && tintAlpha > 0 ? rawTintColor : '#000000');

            return {
                position: {
                    x: (transformedPosition.x - offsetX) / gridSize,
                    y: (transformedPosition.y - offsetY) / gridSize,
                },
                range,
                color,
                angle,
                rotation,
                hidden: !!light.hidden,
                vision:
                    typeof light.vision === 'boolean'
                        ? light.vision
                        : typeof config.vision === 'boolean'
                            ? config.vision
                            : undefined,
            };
        })
        .filter((light) => light.range > 0);
    const drawings = convertFoundryDrawingsToVTTDrawings(
        sourceDrawings,
        offsetX,
        offsetY,
        gridSize,
        transformSourcePoint,
        -sourceRotation
    );

    return {
        resolution: {
            map_origin: { x: 0, y: 0 },
            map_size: { x: mapSizePixels.x / gridSize, y: mapSizePixels.y / gridSize },
            pixels_per_grid: gridSize
        },
        gridScale: gridScaleStr,
        line_of_sight: walls,
        objects_line_of_sight: [],
        portals: portals,
        lights,
        drawings,
    };
}

// Helper function to determine image type from base64 data
function getImageTypeFromBase64(base64Data: string): 'image/png' | 'image/webp' {
    // Check the first few bytes of the base64 data
    const header = atob(base64Data.substring(0, 32));
    const bytes = new Uint8Array(header.length);
    for (let i = 0; i < header.length; i++) {
        bytes[i] = header.charCodeAt(i);
    }

    // Check for PNG signature
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
        return 'image/png';
    }
    // Check for WebP signature ('RIFF' + 4 bytes + 'WEBP')
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
        bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
        return 'image/webp';
    }

    // Default to PNG if we can't determine the type
    return 'image/png';
}

// Compression options for image optimization
export type CompressionMode = 'none' | 'standard' | 'high';
export type VideoCodecPreference = 'auto' | 'av1' | 'h265' | 'vp9' | 'h264';
type TranscodeCodecPreference = Exclude<VideoCodecPreference, 'auto'>;
export type MapLayoutMode = 'GRID' | 'ROW' | 'COLUMN' | 'STACK';
export type MapPlacementMode = 'RIGHT' | 'BELOW' | 'ORIGIN';

export interface FogImportOptions {
    includeWalls?: boolean;
    includeDrawings?: boolean;
    lightOptions?: LightImportOptions;
}

export interface MapImportSource {
    name: string;
    mediaBlob: Blob | File;
    dpi?: number;
    wallData?: VTTMapData;
    sourceKey?: string;
    sourceSceneName?: string;
    foundryMapIdentity?: FoundryMapIdentity;
    mapPlacement?: {
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
}

export async function buildMapImportSourceFromVTTFile(file: File): Promise<MapImportSource | null> {
    if (isRawMediaFile(file)) {
        return {
            name: file.name.replace(/\.[^/.]+$/, '') || file.name,
            mediaBlob: file,
            dpi: 100,
        };
    }

    const content = await readFileAsText(file);
    const parsedJson = JSON.parse(content);

    if (isFoundryVTTData(parsedJson)) {
        return null;
    }

    if (!isUniversalVTTData(parsedJson)) {
        throw new Error('Unsupported VTT file format. Please use a valid UVTT/DD2VTT file.');
    }

    const data = parsedJson as UniversalVTT;
    if (!data.image) {
        return null;
    }

    const imageData = atob(data.image);
    const arrayBuffer = new ArrayBuffer(imageData.length);
    const uint8Array = new Uint8Array(arrayBuffer);
    for (let i = 0; i < imageData.length; i++) {
        uint8Array[i] = imageData.charCodeAt(i);
    }

    const imageType = getImageTypeFromBase64(data.image);
    const imageBlob = new Blob([arrayBuffer], { type: imageType });
    const { image, ...vttData } = data;
    void image;
    const wallData = vttData as VTTMapData;

    return {
        name: file.name.replace(/\.[^/.]+$/, '') || file.name,
        mediaBlob: imageBlob,
        dpi: clampPositiveNumber(wallData.resolution?.pixels_per_grid, 100),
        wallData,
    };
}

export interface MultiMapImportOptions {
    layout?: MapLayoutMode;
    spacing?: number;
    snapToGrid?: boolean;
    scale?: number;
    placement?: MapPlacementMode;
    includeWalls?: boolean;
    includeDrawings?: boolean;
    lightOptions?: LightImportOptions;
    lockMaps?: boolean;
    compressionMode?: CompressionMode;
    sceneName?: string;
    videoOptions?: VideoCompressionOptions;
    onProgress?: (progress: number) => void;
    onStage?: (stage: string) => void;
    onFileProgress?: (progress: MapFileProgress) => void;
    selectionToken?: string;
    forceSelectionPrompt?: boolean;
}

export interface MapFileProgress {
    fileName: string;
    currentFile: number;
    totalFiles: number;
    completedFiles: number;
    remainingFiles: number;
    phase: 'preparing' | 'prepared';
}

export interface MapWorkflowResult {
    importedMapCount: number;
    wallsAppliedToMapCount: number;
    unmatchedSelectionNames: string[];
}

interface PreparedMapImportSource {
    displayName: string;
    uploadName: string;
    selectionKey: string;
    assetSelectionKey: string;
    file: File;
    dpi: number;
    wallData?: VTTMapData;
    sourceKey?: string;
    sourceSceneName?: string;
    foundryMapIdentity?: FoundryMapIdentity;
    mapPlacement?: MapImportSource['mapPlacement'];
}

interface ResolvedMapImportSource {
    displayName: string;
    metadataMatched: boolean;
    wallData?: VTTMapData;
    image: ImageContent;
    grid: ImageGrid;
    position: Vector2;
    rotation: number;
    scale: Vector2;
    zIndex?: number;
    foundryMapIdentity?: FoundryMapIdentity;
}

interface SelectedImageCandidate {
    name: string;
    image: ImageContent;
    grid: ImageGrid;
    description?: string;
}

interface CompletedMapSelectionState {
    prepared: PreparedMapImportSource[];
    selected: SelectedImageCandidate[];
}

const pendingMapSelections = new Map<string, PreparedMapImportSource[]>();
const completedMapSelections = new Map<string, CompletedMapSelectionState>();
const MAX_COMPLETED_MAP_SELECTIONS = 20;

export function clearMapSelectionState(selectionToken?: string): void {
    if (selectionToken) {
        pendingMapSelections.delete(selectionToken);
        completedMapSelections.delete(selectionToken);
        return;
    }

    pendingMapSelections.clear();
    completedMapSelections.clear();
}

function restorePendingMapSelection(
    token: string,
    prepared: PreparedMapImportSource[],
): void {
    pendingMapSelections.set(token, [...prepared]);
    completedMapSelections.delete(token);
}

function rememberCompletedMapSelection(
    token: string,
    prepared: PreparedMapImportSource[],
    selected: SelectedImageCandidate[]
): void {
    completedMapSelections.delete(token);
    completedMapSelections.set(token, {
        prepared: [...prepared],
        selected: [...selected],
    });

    while (completedMapSelections.size > MAX_COMPLETED_MAP_SELECTIONS) {
        const oldest = completedMapSelections.keys().next().value;
        if (!oldest) {
            break;
        }
        completedMapSelections.delete(oldest);
    }
}

export class MapSelectionPendingError extends Error {
    token: string;

    constructor(token: string) {
        super('Map assets uploaded. Continue once map selection is complete.');
        this.name = 'MapSelectionPendingError';
        this.token = token;
    }
}
export type VideoCompressionErrorCode =
    | 'VIDEO_COMPRESSION_ABORTED'
    | 'VIDEO_COMPRESSION_METADATA_FAILED'
    | 'VIDEO_COMPRESSION_NO_PROGRESS'
    | 'VIDEO_COMPRESSION_DECODE_FAILED'
    | 'VIDEO_COMPRESSION_UNSUPPORTED_ENCODER'
    | 'VIDEO_COMPRESSION_SIZE_LIMIT'
    | 'VIDEO_COMPRESSION_SOURCE_TOO_LARGE';

export class VideoCompressionError extends Error {
    code: VideoCompressionErrorCode;

    constructor(code: VideoCompressionErrorCode, message: string) {
        super(message);
        this.name = 'VideoCompressionError';
        this.code = code;
    }
}

interface OptimizationOptions {
    compressionMode?: CompressionMode;
    maxSizeInMB?: number;
    maxMegapixels?: number;
    maxDimension?: number;
}

function getImageExtensionFromMimeType(mimeType: string, fallback: string): string {
    if (mimeType === 'image/webp') return 'webp';
    if (mimeType === 'image/png') return 'png';
    if (mimeType === 'image/jpeg') return 'jpg';
    if (mimeType === 'image/avif') return 'avif';
    if (mimeType === 'image/gif') return 'gif';
    if (mimeType === 'image/bmp') return 'bmp';
    return fallback;
}

function canvasToBlob(canvas: HTMLCanvasElement, mimeType: string, quality?: number): Promise<Blob> {
    return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
            if (!blob) {
                reject(new Error('Could not create blob'));
                return;
            }
            resolve(blob);
        }, mimeType, quality);
    });
}

async function getImageDimensions(imageBlob: Blob): Promise<{ width: number; height: number }> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            const width = Number(img.width);
            const height = Number(img.height);
            URL.revokeObjectURL(img.src);
            if (width <= 0 || height <= 0) {
                reject(new Error('Could not read image dimensions'));
                return;
            }
            resolve({ width, height });
        };
        img.onerror = () => {
            URL.revokeObjectURL(img.src);
            reject(new Error('Failed to load image'));
        };
        img.src = URL.createObjectURL(imageBlob);
    });
}

function getAdjustedDpiAfterResize(
    sourceDpi: number,
    sourceDimensions: { width: number; height: number } | null,
    finalDimensions: { width: number; height: number } | null,
): number {
    const safeSourceDpi = clampPositiveNumber(sourceDpi, 100);
    if (
        !sourceDimensions ||
        !finalDimensions ||
        sourceDimensions.width <= 0 ||
        sourceDimensions.height <= 0 ||
        finalDimensions.width <= 0 ||
        finalDimensions.height <= 0
    ) {
        return safeSourceDpi;
    }

    const widthRatio = finalDimensions.width / sourceDimensions.width;

    if (!Number.isFinite(widthRatio) || widthRatio <= 0) {
        return safeSourceDpi;
    }

    return safeSourceDpi * widthRatio;
}

// Helper function to optimize image data
async function optimizeImage(
    imageBlob: Blob,
    options: OptimizationOptions = {},
    onProgress?: (progress: number) => void,
    onStage?: (stage: string) => void
): Promise<Blob> {
    let lastProgress = -1;
    const reportProgress = (progress: number) => {
        if (!onProgress) return;
        const normalized = Math.max(0, Math.min(100, Math.round(progress)));
        if (normalized === lastProgress) return;
        lastProgress = normalized;
        onProgress(normalized);
    };
    let lastStage = "";
    const reportStage = (stage: string) => {
        if (!onStage || stage === lastStage) return;
        lastStage = stage;
        onStage(stage);
    };

    const {
        compressionMode = 'standard',
        maxSizeInMB = 24, // Default to slightly under 25MB for safety
        maxMegapixels = compressionMode === 'standard' ? 67 : 144
    } = options;
    const maxDimension = Number(options.maxDimension);
    const hasMaxDimensionCap = Number.isFinite(maxDimension) && maxDimension > 0;
    const maxSizeInBytes = maxSizeInMB * 1024 * 1024;
    reportStage('Loading image');
    reportProgress(2);

    // If no compression is requested and the image is under the maximum size, return it as is
    if (compressionMode === 'none' && imageBlob.size <= maxSizeInBytes && !hasMaxDimensionCap) {
        reportStage('Using original image');
        reportProgress(100);
        return imageBlob;
    }

    return new Promise((resolve, reject) => {
        const img = new Image();
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');

        img.onload = () => {
            URL.revokeObjectURL(img.src);
            reportStage('Preparing image');
            reportProgress(10);

            // Start with original dimensions
            let width = img.width;
            let height = img.height;

            if (hasMaxDimensionCap && Math.max(width, height) > maxDimension) {
                const scale = maxDimension / Math.max(width, height);
                width = Math.max(1, Math.floor(width * scale));
                height = Math.max(1, Math.floor(height * scale));
            }

            // Check megapixels constraint
            const megapixels = (width * height) / (1024 * 1024);
            if (megapixels > maxMegapixels) {
                const scale = Math.sqrt(maxMegapixels / megapixels);
                width = Math.floor(width * scale);
                height = Math.floor(height * scale);
            }

            const didResize = width !== img.width || height !== img.height;
            if (didResize) {
                reportStage('Resizing image');
            }

            canvas.width = width;
            canvas.height = height;

            if (!ctx) {
                reject(new Error('Could not get canvas context'));
                return;
            }

            ctx.drawImage(img, 0, 0, width, height);
            reportProgress(20);

            const isUnderSizeLimit = imageBlob.size <= maxSizeInBytes;
            const sourceMimeType = imageBlob.type.toLowerCase();

            // Keep in-limit WebP files as-is unless a resize was required.
            if (compressionMode !== 'none' && sourceMimeType === 'image/webp' && isUnderSizeLimit && !didResize) {
                reportStage('Using original image');
                reportProgress(100);
                resolve(imageBlob);
                return;
            }

            const encodeCompressedImage = async (quality: number): Promise<Blob> => {
                const webpBlob = await canvasToBlob(canvas, 'image/webp', quality);
                if (webpBlob.type === 'image/webp') {
                    return webpBlob;
                }
                const jpegQuality = Math.max(0.6, Math.min(0.92, quality));
                return canvasToBlob(canvas, 'image/jpeg', jpegQuality);
            };

            if (compressionMode === 'none') {
                reportStage('Finalizing image');
                void canvasToBlob(canvas, imageBlob.type)
                    .then((blob) => {
                        const finalBlob = (isUnderSizeLimit && blob.size >= imageBlob.size) ? imageBlob : blob;
                        reportProgress(100);
                        resolve(finalBlob);
                    })
                    .catch((error) => {
                        reject(error instanceof Error ? error : new Error('Could not create blob'));
                    });
                return;
            }

            // Start high and only step down if needed to meet limits.
            const initialQuality = 0.85;
            const minQuality = 0.1;
            const qualityStep = 0.05;
            const totalPasses = Math.max(
                1,
                Math.ceil((initialQuality - minQuality) / qualityStep) + 1
            );

            let bestBlob = imageBlob;
            let bestQuality = initialQuality;

            const tryCompress = (currentQuality: number, passIndex: number) => {
                reportStage(`Encoding image (pass ${passIndex + 1})`);
                reportProgress(25 + (passIndex / totalPasses) * 70);
                void encodeCompressedImage(currentQuality)
                    .then((blob) => {
                        if (blob.size < bestBlob.size) {
                            bestBlob = blob;
                            bestQuality = currentQuality;
                        }

                        const reachedTarget = blob.size <= maxSizeInBytes;
                        if (!reachedTarget && currentQuality > minQuality) {
                            tryCompress(currentQuality - qualityStep, passIndex + 1);
                            return;
                        }

                        reportStage('Finalizing image');
                        const finalBlob = (bestBlob.size < imageBlob.size) ? bestBlob : imageBlob;
                        if (finalBlob !== imageBlob) {
                            const finalSize = (finalBlob.size / (1024 * 1024)).toFixed(2);
                            const quality = (bestQuality * 100).toFixed(0);
                            OBR.notification.show(`Image compressed: ${quality}% quality (${finalSize}MB)`, "INFO");
                        }

                        reportProgress(100);
                        resolve(finalBlob);
                    })
                    .catch((error) => {
                        reject(error instanceof Error ? error : new Error('Could not create blob'));
                    });
            };

            tryCompress(initialQuality, 0);
        };

        img.onerror = () => reject(new Error('Failed to load image'));
        img.src = URL.createObjectURL(imageBlob);
    });
}

// --- Video compression via MediaBunny conversion API ---

interface VideoMeta {
    duration: number;
    width: number;
    height: number;
    frameRate: number;
}

interface VideoCompressionResult {
    blob: Blob;
    sourceWidth: number;
    sourceHeight: number;
    outputWidth: number;
    outputHeight: number;
}

interface MediabunnyConversion {
    isValid: boolean;
    onProgress?: (progress: number) => unknown;
    execute(): Promise<void>;
    cancel(): Promise<void>;
}

interface MediabunnyPacketStats {
    packetCount: number;
    averagePacketRate: number;
    averageBitrate: number;
}

interface MediabunnyTrack {
    codec?: unknown;
    computePacketStats?: (packetSubset?: number) => Promise<MediabunnyPacketStats>;
}

interface MediabunnyInput {
    getPrimaryVideoTrack?: () => Promise<MediabunnyTrack | null>;
    getPrimaryAudioTrack?: () => Promise<MediabunnyTrack | null>;
}

interface MediabunnyModule {
    Input: new (options: { source: unknown; formats: unknown }) => MediabunnyInput;
    Output: new (options: { format: unknown; target: unknown }) => { target: { buffer: ArrayBuffer | null } };
    BlobSource: new (blob: Blob) => unknown;
    BufferTarget: new () => { buffer: ArrayBuffer | null };
    canEncodeVideo?: (codec: 'avc' | 'hevc' | 'vp9' | 'av1', config: {
        width: number;
        height: number;
        bitrate: number;
        frameRate: number;
        hardwareAcceleration?: 'no-preference' | 'prefer-hardware' | 'prefer-software';
    }) => Promise<boolean>;
    getEncodableVideoCodecs?: () => Promise<string[]>;
    Conversion: {
        init(options: {
            input: unknown;
            output: unknown;
            video: {
                codec: 'avc' | 'hevc' | 'vp9' | 'av1';
                frameRate: number;
                bitrate: number;
                keyFrameInterval: number;
                hardwareAcceleration: 'no-preference' | 'prefer-hardware' | 'prefer-software';
                forceTranscode: true;
                width?: number;
                height?: number;
                fit?: 'fill';
            };
            audio?: { discard: true };
        }): Promise<MediabunnyConversion>;
    };
    WebMOutputFormat: new () => unknown;
    Mp4OutputFormat: new () => unknown;
    ALL_FORMATS: unknown;
}

let cachedBrowserVideoCodecAvailability: Promise<BrowserVideoCodecAvailability> | null = null;

export async function getBrowserVideoCodecAvailability(): Promise<BrowserVideoCodecAvailability> {
    if (cachedBrowserVideoCodecAvailability) {
        return cachedBrowserVideoCodecAvailability;
    }

    cachedBrowserVideoCodecAvailability = (async () => {
        const defaultAvailability: BrowserVideoCodecAvailability = {
            auto: true,
            av1: false,
            h265: false,
            vp9: false,
            h264: false,
        };

        try {
            const mb = await import('mediabunny') as unknown as MediabunnyModule;
            const canEncodeVideo = mb.canEncodeVideo;
            const getEncodableVideoCodecs = mb.getEncodableVideoCodecs;
            const baselineProbe = {
                width: 1280,
                height: 720,
                bitrate: 2_000_000,
                frameRate: 30,
            };
            const accelerationModes: Array<'prefer-hardware' | 'no-preference' | 'prefer-software'> = [
                'prefer-hardware',
                'no-preference',
                'prefer-software',
            ];

            const results = { ...defaultAvailability };

            const tryProbe = async (codec: 'av1' | 'hevc' | 'vp9' | 'avc'): Promise<boolean> => {
                if (!canEncodeVideo) return false;
                for (const hardwareAcceleration of accelerationModes) {
                    try {
                        const supported = await canEncodeVideo(codec, {
                            ...baselineProbe,
                            hardwareAcceleration,
                        });
                        if (supported) return true;
                    } catch {
                        // Ignore per-mode probe errors.
                    }
                }
                return false;
            };

            if (getEncodableVideoCodecs) {
                try {
                    const encodable = new Set(await getEncodableVideoCodecs());
                    results.av1 = encodable.has('av1');
                    results.h265 = encodable.has('hevc');
                    results.vp9 = encodable.has('vp9');
                    results.h264 = encodable.has('avc');
                } catch {
                    // Fall back to explicit probes below.
                }
            }

            if (!results.av1) results.av1 = await tryProbe('av1');
            if (!results.h265) results.h265 = await tryProbe('hevc');
            if (!results.vp9) results.vp9 = await tryProbe('vp9');
            if (!results.h264) results.h264 = await tryProbe('avc');

            return results;
        } catch {
            return defaultAvailability;
        }
    })();

    return cachedBrowserVideoCodecAvailability;
}

export interface VideoCompressionOptions {
    keepAudio?: boolean;
    maxDimension?: number;
    preferredCodec?: VideoCodecPreference;
    forceTranscodeUnderLimit?: boolean;
    abortSignal?: AbortSignal;
    onStage?: (stage: string) => void;
}

export interface VideoCompressionPreflightResult {
    supported: boolean;
    reason?: string;
    inconclusive?: boolean;
}

function getDecoderCodecCandidates(
    codec: unknown,
    mimeType: string
): string[] {
    const normalized = normalizeSourceCodec(codec);
    const candidates = new Set<string>();

    if (typeof codec === 'string' && codec.trim().length > 0) {
        candidates.add(codec.trim());
    }

    if (normalized === 'avc') {
        candidates.add('avc1.42E01E');
        candidates.add('avc1.640028');
    } else if (normalized === 'hevc') {
        candidates.add('hvc1.1.6.L120.B0');
        candidates.add('hev1.1.6.L120.B0');
    } else if (normalized === 'vp9') {
        candidates.add('vp09.00.10.08');
        candidates.add('vp9');
    } else if (normalized === 'av1') {
        candidates.add('av01.0.08M.08');
        candidates.add('av1');
    }

    const lowerMime = mimeType.toLowerCase();
    if (candidates.size === 0 && lowerMime.includes('webm')) {
        candidates.add('vp09.00.10.08');
        candidates.add('vp8');
        candidates.add('av01.0.08M.08');
    }

    if (candidates.size === 0 && lowerMime.includes('mp4')) {
        candidates.add('avc1.42E01E');
        candidates.add('hvc1.1.6.L120.B0');
    }

    return Array.from(candidates);
}

async function isDecoderSupportedForSource(
    codecCandidates: string[],
    mimeType: string,
    width: number,
    height: number,
    frameRate: number,
    bitrate: number
): Promise<boolean | null> {
    let hadAnyCheck = false;

    const mediaCapabilities = typeof navigator !== 'undefined'
        && !!navigator.mediaCapabilities
        && typeof navigator.mediaCapabilities.decodingInfo === 'function'
        ? navigator.mediaCapabilities
        : null;

    if (mediaCapabilities && codecCandidates.length > 0) {
        for (const codec of codecCandidates) {
            hadAnyCheck = true;
            try {
                const info = await mediaCapabilities.decodingInfo({
                    type: 'file',
                    video: {
                        contentType: `${mimeType}; codecs="${codec}"`,
                        width,
                        height,
                        bitrate,
                        framerate: frameRate,
                    },
                });
                if (info.supported) {
                    return true;
                }
            } catch {
                // Try next candidate.
            }
        }
    }

    if (typeof VideoDecoder !== 'undefined' && typeof VideoDecoder.isConfigSupported === 'function' && codecCandidates.length > 0) {
        for (const codec of codecCandidates) {
            hadAnyCheck = true;
            try {
                const support = await VideoDecoder.isConfigSupported({
                    codec,
                    codedWidth: width,
                    codedHeight: height,
                    hardwareAcceleration: 'prefer-hardware',
                });
                if (support.supported) {
                    return true;
                }
            } catch {
                // Try next candidate.
            }
        }
    }

    if (!hadAnyCheck) return null;
    return false;
}

export type BrowserVideoCodecAvailability = {
    auto: true;
    av1: boolean;
    h265: boolean;
    vp9: boolean;
    h264: boolean;
};

function toEvenDimension(value: number): number {
    return Math.max(2, Math.round(value) & ~1);
}

function isLikelyIOSBrowser(): boolean {
    if (typeof navigator === 'undefined') return false;
    const ua = navigator.userAgent || '';
    const platform = navigator.platform || '';
    const maxTouchPoints = (navigator as Navigator & { maxTouchPoints?: number }).maxTouchPoints || 0;
    const isIOSDevice = /iPad|iPhone|iPod/.test(ua);
    const isTouchMac = platform === 'MacIntel' && maxTouchPoints > 1;
    return isIOSDevice || isTouchMac;
}

async function getVideoMetadata(fileBlob: Blob): Promise<VideoMeta> {
    return new Promise((resolve, reject) => {
        const video = document.createElement('video');
        video.preload = 'metadata';
        video.muted = true;
        video.playsInline = true;
        let settled = false;
        let timeoutId: number | null = null;

        const cleanup = () => {
            if (timeoutId !== null) {
                window.clearTimeout(timeoutId);
                timeoutId = null;
            }
            video.onloadeddata = null;
            video.onloadedmetadata = null;
            video.ondurationchange = null;
            video.oncanplay = null;
            video.onerror = null;
            if (video.src) {
                URL.revokeObjectURL(video.src);
                video.removeAttribute('src');
                video.load();
            }
        };

        const tryFinalize = () => {
            if (settled) return;

            const duration = Number(video.duration);
            const width = Number(video.videoWidth);
            const height = Number(video.videoHeight);

            if (!Number.isFinite(duration) || duration <= 0 || width <= 0 || height <= 0) {
                return;
            }

            settled = true;
            cleanup();

            resolve({
                duration,
                width,
                height,
                frameRate: 30,
            });
        };

        video.onloadeddata = tryFinalize;
        video.onloadedmetadata = tryFinalize;
        video.ondurationchange = tryFinalize;
        video.oncanplay = tryFinalize;

        video.onerror = () => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(new Error('Failed to load video metadata'));
        };

        timeoutId = window.setTimeout(() => {
            if (settled) return;
            settled = true;
            const duration = Number(video.duration);
            const width = Number(video.videoWidth);
            const height = Number(video.videoHeight);
            cleanup();
            if (Number.isFinite(duration) && duration > 0 && width > 0 && height > 0) {
                resolve({
                    duration,
                    width,
                    height,
                    frameRate: 30,
                });
                return;
            }
            reject(new Error('Timed out while reading complete video metadata'));
        }, 25000);

        video.src = URL.createObjectURL(fileBlob);
    });
}

function getCodecEncodingDefaults(codec: VideoCodecPreference): {
    keyFrameIntervalSeconds: number;
    qualityFactor: number;
    minBitrate: number;
    maxBitrate: number;
} {
    if (codec === 'auto') {
        return {
            keyFrameIntervalSeconds: 2,
            qualityFactor: 0.045,
            minBitrate: 550_000,
            maxBitrate: 14_000_000,
        };
    }
    if (codec === 'av1') {
        return {
            keyFrameIntervalSeconds: 2,
            qualityFactor: 0.036,
            minBitrate: 450_000,
            maxBitrate: 10_000_000,
        };
    }
    if (codec === 'h265') {
        return {
            keyFrameIntervalSeconds: 2,
            qualityFactor: 0.041,
            minBitrate: 550_000,
            maxBitrate: 16_000_000,
        };
    }
    if (codec === 'h264') {
        return {
            keyFrameIntervalSeconds: 2,
            qualityFactor: 0.055,
            minBitrate: 700_000,
            maxBitrate: 18_000_000,
        };
    }
    return {
        keyFrameIntervalSeconds: 2,
        qualityFactor: 0.045,
        minBitrate: 550_000,
        maxBitrate: 14_000_000,
    };
}

function normalizeSourceCodec(codec: unknown): 'avc' | 'hevc' | 'vp9' | 'av1' | 'other' {
    if (typeof codec !== 'string') {
        return 'other';
    }
    if (codec === 'avc' || codec.startsWith('avc') || codec.startsWith('h264')) {
        return 'avc';
    }
    if (codec === 'hevc' || codec.startsWith('hevc') || codec.startsWith('h265') || codec.startsWith('hev1') || codec.startsWith('hvc1')) {
        return 'hevc';
    }
    if (codec === 'vp9' || codec.startsWith('vp9')) {
        return 'vp9';
    }
    if (codec === 'av1' || codec.startsWith('av1')) {
        return 'av1';
    }
    return 'other';
}

function getCodecRatePolicy(
    sourceCodec: 'avc' | 'hevc' | 'vp9' | 'av1' | 'other',
    targetCodec: TranscodeCodecPreference,
    forceShrinkMode: boolean,
    preserveQualityMode: boolean
): { equivalentFactor: number; qualityFloorFactor: number } {
    const key = `${sourceCodec}->${targetCodec}`;
    const equivalentByPair: Record<string, number> = preserveQualityMode
        ? {
            'avc->vp9': 1.0,
            'avc->av1': 0.95,
            'avc->h265': 0.88,
            'avc->h264': 1.0,
            'hevc->av1': 1.12,
            'hevc->vp9': 1.2,
            'hevc->h265': 1.0,
            'hevc->h264': 1.28,
            'vp9->av1': 0.96,
            'vp9->h265': 0.96,
            'vp9->vp9': 1.0,
            'vp9->h264': 1.15,
            'av1->av1': 1.0,
            'av1->h265': 1.05,
            'av1->vp9': 1.2,
            'av1->h264': 1.35,
        }
        : {
            'avc->vp9': 0.9,
            'avc->av1': 0.82,
            'avc->h265': 0.8,
            'avc->h264': 1.0,
            'hevc->av1': 1.0,
            'hevc->vp9': 1.1,
            'hevc->h265': 1.0,
            'hevc->h264': 1.2,
            'vp9->av1': 0.9,
            'vp9->h265': 0.9,
            'vp9->vp9': 1.0,
            'vp9->h264': 1.15,
            'av1->av1': 1.0,
            'av1->h265': 0.92,
            'av1->vp9': 1.2,
            'av1->h264': 1.35,
        };

    const fallbackEquivalent = preserveQualityMode
        ? (targetCodec === 'h264' ? 1.08 : targetCodec === 'h265' ? 0.95 : 1.0)
        : (targetCodec === 'av1'
            ? 0.9
            : targetCodec === 'h265'
                ? 0.88
                : targetCodec === 'vp9'
                    ? 0.95
                    : 1.05);

    const equivalentFactor = equivalentByPair[key] ?? fallbackEquivalent;
    const qualityFloorFactor = preserveQualityMode
        ? (targetCodec === 'av1' ? 0.92 : targetCodec === 'h265' ? 0.95 : targetCodec === 'vp9' ? 0.97 : 1.0)
        : forceShrinkMode
            ? (targetCodec === 'av1' ? 0.72 : targetCodec === 'h265' ? 0.76 : targetCodec === 'vp9' ? 0.8 : 0.92)
            : (targetCodec === 'av1' ? 0.84 : targetCodec === 'h265' ? 0.88 : targetCodec === 'vp9' ? 0.9 : 0.98);

    return { equivalentFactor, qualityFloorFactor };
}

function getVideoNoProgressTimeoutMs(
    sourceBytes: number,
    durationSeconds: number,
    outputPixels: number,
    needsResize: boolean
): number {
    const sourceSizeMb = sourceBytes / 1000 / 1000;
    const outputMegaPixels = outputPixels / 1_000_000;

    const baseMs = needsResize ? 45_000 : 35_000;
    const sizeAllowanceMs = Math.min(90_000, Math.max(0, sourceSizeMb - 8) * 600);
    const durationAllowanceMs = Math.min(90_000, Math.max(0, durationSeconds - 20) * 900);
    const resolutionAllowanceMs = Math.min(45_000, Math.max(0, outputMegaPixels - 2) * 7_500);

    return Math.round(Math.min(240_000, baseMs + sizeAllowanceMs + durationAllowanceMs + resolutionAllowanceMs));
}

function isLikelyDecodeFailure(message: string): boolean {
    const lower = message.toLowerCase();
    return lower.includes('decoder failure')
        || lower.includes('decode failure')
        || lower.includes('failed to decode')
        || (lower.includes('decoder') && lower.includes('failed'));
}

async function compressVideo(
    fileBlob: Blob,
    compressionMode: CompressionMode,
    onProgress?: (progress: number) => void,
    options: VideoCompressionOptions = {}
): Promise<VideoCompressionResult> {
    let lastReportedProgress = -1;
    const reportProgress = (progress: number) => {
        if (!onProgress) return;
        const normalized = Math.max(0, Math.min(100, Math.round(progress)));
        if (normalized <= lastReportedProgress) return;
        lastReportedProgress = normalized;
        onProgress(normalized);
    };
    let lastStage = '';
    const reportStage = (stage: string) => {
        if (!options.onStage || stage === lastStage) return;
        lastReportedProgress = -1;
        lastStage = stage;
        options.onStage(stage);
    };

    const throwIfAborted = () => {
        if (options.abortSignal?.aborted) {
            throw new VideoCompressionError('VIDEO_COMPRESSION_ABORTED', 'Video compression canceled.');
        }
    };

    throwIfAborted();
    reportStage('Reading video metadata');
    let duration: number;
    let width: number;
    let height: number;
    let frameRate: number;
    try {
        const metadata = await getVideoMetadata(fileBlob);
        duration = metadata.duration;
        width = metadata.width;
        height = metadata.height;
        frameRate = metadata.frameRate;
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to read video metadata.';
        throw new VideoCompressionError(
            'VIDEO_COMPRESSION_METADATA_FAILED',
            `${message} Try another browser or upload without compression.`
        );
    }
    const requestedCodec = options.preferredCodec ?? 'auto';
    const targetSizeMB = compressionMode === 'high' ? 99 : 49;
    // Use decimal MB to match user-facing size limits (50MB / 100MB) more closely.
    const maxBytes = targetSizeMB * 1000 * 1000;
    const bitrateFromBudget = Math.max(450_000, Math.floor((targetSizeMB * 8 * 1000 * 1000) / Math.max(duration, 1)));

    let outWidth = width;
    let outHeight = height;
    if (options.maxDimension && options.maxDimension > 0 && (width > options.maxDimension || height > options.maxDimension)) {
        const scale = options.maxDimension / Math.max(width, height);
        outWidth = toEvenDimension(width * scale);
        outHeight = toEvenDimension(height * scale);
    }

    const needsResize = outWidth !== width || outHeight !== height;
    const resizeConfig = needsResize
        ? { width: outWidth, height: outHeight, fit: 'fill' as const }
        : undefined;

    const sourceFrameRate = Number.isFinite(frameRate) && frameRate > 1 ? frameRate : 30;
    const outputFrameRate = needsResize
        ? Math.min(30, Math.max(24, Math.round(sourceFrameRate)))
        : Math.min(120, Math.max(24, Math.round(sourceFrameRate)));

    const audioTransformRequested = options.keepAudio === false;
    const codecTransformRequested = requestedCodec !== 'auto' && requestedCodec !== 'vp9';
    const transformRequested = needsResize || audioTransformRequested || codecTransformRequested;
    const requiresTranscode = transformRequested || fileBlob.size > maxBytes || !!options.forceTranscodeUnderLimit;
    const preserveQualityUnderLimit = fileBlob.size <= maxBytes
        && !needsResize
        && !options.forceTranscodeUnderLimit;

    if (!requiresTranscode) {
        reportStage('Using original video');
        reportProgress(100);
        return {
            blob: fileBlob,
            sourceWidth: width,
            sourceHeight: height,
            outputWidth: width,
            outputHeight: height,
        };
    }

    const pixels = outWidth * outHeight;
    const getBitrateScalesForCodec = (codec: TranscodeCodecPreference): number[] => {
        if (codec === 'av1') return [1, 0.9, 0.8, 0.72, 0.64, 0.56, 0.5];
        if (codec === 'h265') return [1, 0.9, 0.82, 0.74, 0.66, 0.58, 0.5];
        if (codec === 'h264') return [1, 0.9, 0.82, 0.74, 0.66];
        return [1, 0.9, 0.82, 0.74, 0.66, 0.58, 0.5];
    };
    const sourcePixels = Math.max(1, width * height);
    const resizeFactor = pixels / sourcePixels;
    const frameRateFactor = outputFrameRate / Math.max(sourceFrameRate, 1);
    const sourceTotalBitrate = Math.max(250_000, Math.floor((fileBlob.size * 8) / Math.max(duration, 1)));
    const assumedAudioBitrate = options.keepAudio === false ? 0 : 128_000;
    const noProgressTimeoutMs = getVideoNoProgressTimeoutMs(fileBlob.size, duration, pixels, needsResize);
    const noProgressTimeoutSeconds = Math.round(noProgressTimeoutMs / 1000);

    reportStage('Loading video encoder');
    const mb = await import('mediabunny') as unknown as MediabunnyModule;
    const {
        Input,
        Output,
        BlobSource,
        BufferTarget,
        Conversion,
        WebMOutputFormat,
        Mp4OutputFormat,
        ALL_FORMATS,
        canEncodeVideo,
    } = mb;

    let effectiveCodec: TranscodeCodecPreference = requestedCodec === 'auto' ? 'av1' : requestedCodec;

    if (requestedCodec === 'auto') {
        const codecOrder: TranscodeCodecPreference[] = ['av1', 'h265', 'vp9', 'h264'];
        const probeModes: Array<'prefer-hardware' | 'no-preference' | 'prefer-software'> = [
            'prefer-hardware',
            'no-preference',
            'prefer-software',
        ];
        const toEncoderCodec = (codec: TranscodeCodecPreference): 'avc' | 'hevc' | 'vp9' | 'av1' => {
            if (codec === 'h264') return 'avc';
            if (codec === 'h265') return 'hevc';
            return codec;
        };

        if (canEncodeVideo) {
            const probeBitrate = Math.max(450_000, bitrateFromBudget);
            let chosenCodec: TranscodeCodecPreference | null = null;
            for (const candidate of codecOrder) {
                const encoderCodec = toEncoderCodec(candidate);
                let supported = false;
                for (const hardwareAcceleration of probeModes) {
                    try {
                        const canEncode = await canEncodeVideo(encoderCodec, {
                            width: outWidth,
                            height: outHeight,
                            bitrate: probeBitrate,
                            frameRate: outputFrameRate,
                            hardwareAcceleration,
                        });
                        if (canEncode) {
                            supported = true;
                            break;
                        }
                    } catch {
                        // Try next acceleration mode.
                    }
                }
                if (supported) {
                    chosenCodec = candidate;
                    break;
                }
            }

            if (chosenCodec) {
                effectiveCodec = chosenCodec;
                if (chosenCodec !== codecOrder[0]) {
                    OBR.notification.show(
                        `Auto codec selected ${chosenCodec.toUpperCase()} for this browser and resolution.`,
                        'INFO'
                    );
                }
            } else {
                effectiveCodec = 'vp9';
            }
        } else {
            const availability = await getBrowserVideoCodecAvailability();
            if (availability.av1) effectiveCodec = 'av1';
            else if (availability.h265) effectiveCodec = 'h265';
            else if (availability.vp9) effectiveCodec = 'vp9';
            else effectiveCodec = 'h264';
        }
    }

    if (requiresTranscode && isLikelyIOSBrowser()) {
        const iosTranscodeErrorMessage = 'This iOS browser cannot transcode video in this context. Try no compression, a lower Max video dimension, or a browser/device with hardware video encoding support.';
        if (canEncodeVideo) {
            const probeCodec = effectiveCodec === 'h264'
                ? 'avc'
                : effectiveCodec === 'h265'
                    ? 'hevc'
                    : effectiveCodec;
            const iosProbeModes: Array<'prefer-hardware' | 'no-preference' | 'prefer-software'> = ['prefer-hardware', 'no-preference', 'prefer-software'];
            let iosTranscodeSupported = false;

            for (const hardwareAcceleration of iosProbeModes) {
                try {
                    const supported = await canEncodeVideo(probeCodec, {
                        width: outWidth,
                        height: outHeight,
                        bitrate: Math.max(450_000, bitrateFromBudget),
                        frameRate: outputFrameRate,
                        hardwareAcceleration,
                    });
                    if (supported) {
                        iosTranscodeSupported = true;
                        break;
                    }
                } catch {
                    // Ignore probe failures and keep checking other modes.
                }
            }

            if (!iosTranscodeSupported) {
                throw new VideoCompressionError('VIDEO_COMPRESSION_UNSUPPORTED_ENCODER', iosTranscodeErrorMessage);
            }
        }
    }

    let sourceCodec: 'avc' | 'hevc' | 'vp9' | 'av1' | 'other' = 'other';
    let sourceVideoBitrate = 0;
    let sourceAudioBitrate = 0;
    const skipDetailedPacketStats = fileBlob.size > 60_000_000;

    reportStage('Analyzing source video');
    try {
        const analysisInput = new Input({
            source: new BlobSource(fileBlob),
            formats: ALL_FORMATS,
        });

        const sourceVideoTrack = await analysisInput.getPrimaryVideoTrack?.();
        if (sourceVideoTrack) {
            sourceCodec = normalizeSourceCodec(sourceVideoTrack.codec);
            const videoStats = sourceVideoTrack.computePacketStats
                ? skipDetailedPacketStats
                    ? undefined
                    : fileBlob.size <= 20_000_000
                        ? await sourceVideoTrack.computePacketStats()
                        : await sourceVideoTrack.computePacketStats(180)
                : undefined;
            if (videoStats && Number.isFinite(videoStats.averageBitrate) && videoStats.averageBitrate > 0) {
                sourceVideoBitrate = Math.floor(videoStats.averageBitrate);
            }
        }

        if (options.keepAudio !== false) {
            const sourceAudioTrack = await analysisInput.getPrimaryAudioTrack?.();
            const audioStats = sourceAudioTrack?.computePacketStats
                ? skipDetailedPacketStats
                    ? undefined
                    : fileBlob.size <= 20_000_000
                        ? await sourceAudioTrack.computePacketStats()
                        : await sourceAudioTrack.computePacketStats(180)
                : undefined;
            if (audioStats && Number.isFinite(audioStats.averageBitrate) && audioStats.averageBitrate > 0) {
                sourceAudioBitrate = Math.floor(audioStats.averageBitrate);
            }
        }
    } catch {
        // Metadata probing is best-effort. Compression falls back to conservative estimates.
    }

    if (sourceVideoBitrate <= 0) {
        const fallbackAudioBitrate = sourceAudioBitrate > 0 ? sourceAudioBitrate : assumedAudioBitrate;
        sourceVideoBitrate = Math.max(250_000, sourceTotalBitrate - fallbackAudioBitrate);
    }

    const { equivalentFactor, qualityFloorFactor } = getCodecRatePolicy(
        sourceCodec,
        effectiveCodec,
        !!options.forceTranscodeUnderLimit,
        preserveQualityUnderLimit
    );

    const sourceEquivalentBitrate = Math.floor(sourceVideoBitrate * equivalentFactor * resizeFactor * frameRateFactor);
    const qualityFloorBitrate = Math.floor(sourceVideoBitrate * qualityFloorFactor * resizeFactor * frameRateFactor);

    const transcodeOnce = async (
        codecPreference: TranscodeCodecPreference,
        bitrate: number,
        codecDefaultsForPass: ReturnType<typeof getCodecEncodingDefaults>,
        stageLabel: string
    ): Promise<Blob> => {
        throwIfAborted();
        reportStage(stageLabel);
        reportProgress(0);

        const codec = codecPreference === 'h264'
            ? 'avc'
            : codecPreference === 'h265'
                ? 'hevc'
                : codecPreference;
        const outputFormat = codecPreference === 'h264' || codecPreference === 'h265'
            ? new Mp4OutputFormat()
            : new WebMOutputFormat();

        const accelerationModes: Array<'no-preference' | 'prefer-software' | 'prefer-hardware'> = needsResize
            ? ['prefer-hardware', 'no-preference', 'prefer-software']
            : ['prefer-hardware', 'no-preference', 'prefer-software'];

        let lastError: Error | null = null;

        for (const hardwareAcceleration of accelerationModes) {
            throwIfAborted();

            if (canEncodeVideo) {
                try {
                    const supported = await canEncodeVideo(codec, {
                        width: outWidth,
                        height: outHeight,
                        bitrate,
                        frameRate: outputFrameRate,
                        hardwareAcceleration,
                    });
                    if (!supported) {
                        continue;
                    }
                } catch {
                    // If probing fails in this browser, continue and let conversion init decide.
                }
            }

            const input = new Input({
                source: new BlobSource(fileBlob),
                formats: ALL_FORMATS,
            });
            const output = new Output({
                format: outputFormat,
                target: new BufferTarget(),
            });

            let conversion: MediabunnyConversion;
            try {
                conversion = await Conversion.init({
                    input,
                    output,
                    video: {
                        codec,
                        frameRate: outputFrameRate,
                        bitrate,
                        keyFrameInterval: codecDefaultsForPass.keyFrameIntervalSeconds,
                        hardwareAcceleration,
                        forceTranscode: true,
                        ...(resizeConfig ?? {}),
                    },
                    audio: options.keepAudio === false ? { discard: true } : undefined,
                });
            } catch (error) {
                lastError = error instanceof Error ? error : new Error(String(error));
                continue;
            }

            if (!conversion.isValid) {
                lastError = new VideoCompressionError(
                    'VIDEO_COMPRESSION_UNSUPPORTED_ENCODER',
                    'Unable to initialize video conversion in this browser.'
                );
                continue;
            }

            let noProgressDetected = false;
            let lastProgressAt = Date.now();
            let lastProgressValue = 0;
            let stallIntervalId: number | null = null;
            conversion.onProgress = (progress: number) => {
                if (progress > lastProgressValue + 0.0005) {
                    lastProgressValue = progress;
                    lastProgressAt = Date.now();
                }
                const scopedProgress = Math.max(0, Math.min(1, progress)) * 100;
                reportProgress(scopedProgress);
            };

            stallIntervalId = window.setInterval(() => {
                if ((Date.now() - lastProgressAt) > noProgressTimeoutMs) {
                    noProgressDetected = true;
                    void conversion.cancel();
                }
            }, 2000);

            const onAbort = () => {
                void conversion.cancel();
            };
            options.abortSignal?.addEventListener('abort', onAbort, { once: true });

            try {
                await conversion.execute();
            } catch (error) {
                if (options.abortSignal?.aborted) {
                    throw new VideoCompressionError('VIDEO_COMPRESSION_ABORTED', 'Video compression canceled.');
                }
                if (noProgressDetected) {
                    lastError = new VideoCompressionError(
                        'VIDEO_COMPRESSION_NO_PROGRESS',
                        `Video compression made no progress for ${noProgressTimeoutSeconds}s and was stopped. Try a lower Max video dimension, H.264, or another browser/device.`
                    );
                    continue;
                }
                lastError = error instanceof Error ? error : new Error(String(error));
                continue;
            } finally {
                if (stallIntervalId !== null) {
                    window.clearInterval(stallIntervalId);
                }
                options.abortSignal?.removeEventListener('abort', onAbort);
            }

            const outputBuffer = output.target.buffer as ArrayBuffer | null;
            if (!outputBuffer) {
                lastError = new Error('MediaBunny conversion produced no output data.');
                continue;
            }

            return new Blob([outputBuffer], {
                type: codecPreference === 'h264' || codecPreference === 'h265' ? 'video/mp4' : 'video/webm',
            });
        }

        let availableCodecs = '';
        if (mb.getEncodableVideoCodecs) {
            try {
                const encodable = await mb.getEncodableVideoCodecs();
                if (encodable.length > 0) {
                    availableCodecs = ` Available encoders in this browser: ${encodable.join(', ')}.`;
                }
            } catch {
                // Ignore diagnostics helper failure.
            }
        }

        if (lastError && isLikelyDecodeFailure(lastError.message)) {
            throw new VideoCompressionError(
                'VIDEO_COMPRESSION_DECODE_FAILED',
                `This browser failed while decoding/processing source frames (source: ${width}x${height}, target: ${outWidth}x${outHeight}). ` +
                `Try another Browser or reducing source resolution before upload (most effective).` +
                availableCodecs
            );
        }

        throw new VideoCompressionError(
            'VIDEO_COMPRESSION_UNSUPPORTED_ENCODER',
            `This browser build cannot encode ${codecPreference.toUpperCase()} at ${outWidth}x${outHeight}. ` +
            `Try a lower max video dimension, switch codec (or Auto mode), or use a browser version that supports this codec.` +
            availableCodecs +
            (lastError ? ` ${lastError.message}` : '')
        );
    };

    const bitrateScales = getBitrateScalesForCodec(effectiveCodec);
    reportStage('Preparing video compression');
    let output: Blob | null = null;
    let bestOverBudgetOutput: Blob | null = null;
    let lastCodecError: Error | null = null;
    const codecDefaults = getCodecEncodingDefaults(effectiveCodec);
    const qualityBitrate = Math.floor(pixels * outputFrameRate * codecDefaults.qualityFactor);
    const seededBitrateBase = preserveQualityUnderLimit
        ? Math.min(bitrateFromBudget, sourceEquivalentBitrate)
        : Math.min(
            bitrateFromBudget,
            qualityBitrate,
            sourceEquivalentBitrate
        );
    const boundedQualityFloorBitrate = Math.max(
        codecDefaults.minBitrate,
        Math.min(codecDefaults.maxBitrate, qualityFloorBitrate)
    );
    const boundedSeedBitrate = Math.max(
        codecDefaults.minBitrate,
        Math.min(codecDefaults.maxBitrate, seededBitrateBase)
    );
    const seededBitrate = Math.max(
        boundedQualityFloorBitrate,
        boundedSeedBitrate
    );

    try {
        let attemptedBitrate = Math.floor(seededBitrate * bitrateScales[0]);
        let currentPass = 1;
        const codecLabel = effectiveCodec.toUpperCase();
        let candidateOutput = await transcodeOnce(
            effectiveCodec,
            attemptedBitrate,
            codecDefaults,
            `Encoding video (${codecLabel}, pass ${currentPass})`
        );

        for (let i = 1; i < bitrateScales.length; i++) {
            if (candidateOutput.size <= maxBytes) {
                break;
            }

            const currentSizeMb = (candidateOutput.size / 1000 / 1000).toFixed(1);
            OBR.notification.show(
                `Output is still ${currentSizeMb}MB, running an additional compression pass.`,
                "INFO"
            );

            const minimumPassBitrate = codecDefaults.minBitrate;
            const candidateBitrate = Math.max(
                minimumPassBitrate,
                Math.floor(seededBitrate * bitrateScales[i])
            );
            if (candidateBitrate >= attemptedBitrate) {
                break;
            }

            attemptedBitrate = candidateBitrate;
            currentPass += 1;
            candidateOutput = await transcodeOnce(
                effectiveCodec,
                candidateBitrate,
                codecDefaults,
                `Encoding video (${codecLabel}, pass ${currentPass})`
            );
        }

        if (candidateOutput.size <= maxBytes) {
            output = candidateOutput;
        } else {
            bestOverBudgetOutput = candidateOutput;
        }
    } catch (error) {
        lastCodecError = error instanceof Error ? error : new Error(String(error));
    }

    if (!output) {
        if (bestOverBudgetOutput) {
            const finalSize = (bestOverBudgetOutput.size / 1000 / 1000).toFixed(1);
            throw new VideoCompressionError(
                'VIDEO_COMPRESSION_SIZE_LIMIT',
                `Unable to compress video below ${targetSizeMB}MB (current: ${finalSize}MB). Try a lower Max video dimension, remove audio, or use H.264.`
            );
        }
        if (lastCodecError instanceof VideoCompressionError) {
            throw lastCodecError;
        }
        throw new VideoCompressionError(
            'VIDEO_COMPRESSION_UNSUPPORTED_ENCODER',
            lastCodecError?.message ||
            `This browser build cannot encode ${effectiveCodec.toUpperCase()} at ${outWidth}x${outHeight}. Try a lower Max video dimension or another codec.`
        );
    }

    if (output.size > maxBytes) {
        const finalSize = (output.size / 1000 / 1000).toFixed(1);
        throw new VideoCompressionError(
            'VIDEO_COMPRESSION_SIZE_LIMIT',
            `Unable to compress video below ${targetSizeMB}MB (current: ${finalSize}MB). Try a lower Max video dimension, remove audio, or use H.264.`
        );
    }

    if (
        output.size >= fileBlob.size
        && !transformRequested
        && fileBlob.size <= maxBytes
        && !options.forceTranscodeUnderLimit
    ) {
        output = fileBlob;
    }

    reportStage('Finalizing video');
    reportProgress(100);
    return {
        blob: output,
        sourceWidth: width,
        sourceHeight: height,
        outputWidth: outWidth,
        outputHeight: outHeight,
    };
}

function sanitizeMapName(name: string): string {
    const noExtension = name.replace(/\.[^/.]+$/, '').trim();
    const compact = noExtension.replace(/\s+/g, ' ').replace(/[^a-zA-Z0-9 _-]/g, '').trim();
    return compact || 'Map';
}

function buildUploadName(name: string): string {
    return sanitizeMapName(name).slice(0, 40);
}

function normalizeNameForMatching(name: string): string {
    return name
        .replace(/\.[^/.]+$/, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .replace(/[^a-z0-9 _-]/g, '')
        .trim();
}

function normalizeNameForLooseMatching(name: string): string {
    const strict = normalizeNameForMatching(name);
    return strict.replace(/\s*\(\d+\)\s*$/, '').trim();
}

function normalizeDegrees(value: number): number {
    if (!Number.isFinite(value)) return 0;
    const normalized = ((value % 360) + 360) % 360;
    return normalized === 0 ? 0 : normalized;
}

function rotatePointAroundOrigin(point: Vector2, origin: Vector2, degrees: number): Vector2 {
    const normalizedDegrees = normalizeDegrees(degrees);
    if (normalizedDegrees === 0) {
        return point;
    }

    const radians = (normalizedDegrees * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    const dx = point.x - origin.x;
    const dy = point.y - origin.y;

    return {
        x: origin.x + (dx * cos) - (dy * sin),
        y: origin.y + (dx * sin) + (dy * cos),
    };
}

function compensateForCenterAnchoredRotation(
    basePosition: Vector2,
    localCenter: Vector2,
    rotation: number
): Vector2 {
    const normalizedRotation = normalizeDegrees(rotation);
    if (normalizedRotation === 0) {
        return basePosition;
    }

    const rotatedCenter = rotatePointAroundOrigin(
        localCenter,
        { x: 0, y: 0 },
        normalizedRotation
    );

    return {
        x: basePosition.x + localCenter.x - rotatedCenter.x,
        y: basePosition.y + localCenter.y - rotatedCenter.y,
    };
}

function applyMapRotationToImportedItems(
    items: Item[],
    mapOrigin: Vector2,
    mapRotation: number
): Item[] {
    const normalizedRotation = normalizeDegrees(mapRotation);
    if (normalizedRotation === 0) {
        return items;
    }

    return items.map((item) => {
        const existingRotation =
            typeof item.rotation === "number" && Number.isFinite(item.rotation)
                ? item.rotation
                : 0;
        const currentPosition = item.position;
        const nextPosition =
            currentPosition &&
            Number.isFinite(currentPosition.x) &&
            Number.isFinite(currentPosition.y)
                ? rotatePointAroundOrigin(currentPosition, mapOrigin, normalizedRotation)
                : currentPosition;

        let nextMetadata = item.metadata;
        const dynamicFog = item.metadata?.[DYNAMIC_FOG_LIGHT_KEY];
        if (dynamicFog && typeof dynamicFog === "object") {
            const dynamicFogLight = dynamicFog as { rotation?: unknown };
            const currentRotation = Number(dynamicFogLight.rotation ?? 0);
            const adjustedDynamicFogLight = {
                ...dynamicFogLight,
                rotation: normalizeDegrees(
                    (Number.isFinite(currentRotation) ? currentRotation : 0) + normalizedRotation
                ),
            };

            const chromodynamic = item.metadata?.[CHROMODYNAMIC_LIGHT_KEY];
            const adjustedChromodynamic =
                chromodynamic && typeof chromodynamic === "object"
                    ? {
                        ...(chromodynamic as { rotation?: unknown }),
                        rotation: normalizeDegrees(
                            (Number(
                                (chromodynamic as { rotation?: unknown }).rotation ?? 0
                            ) || 0) + normalizedRotation
                        ),
                    }
                    : chromodynamic;

            nextMetadata = {
                ...item.metadata,
                [DYNAMIC_FOG_LIGHT_KEY]: adjustedDynamicFogLight,
                ...(adjustedChromodynamic
                    ? { [CHROMODYNAMIC_LIGHT_KEY]: adjustedChromodynamic }
                    : {}),
            };
        }

        return {
            ...item,
            position: nextPosition,
            rotation: normalizeDegrees(existingRotation + normalizedRotation),
            metadata: nextMetadata,
        };
    });
}

function clampPositiveNumber(value: number | undefined, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        return fallback;
    }
    return value;
}

function snapUpToGrid(value: number, gridSize: number): number {
    const safeGridSize = clampPositiveNumber(gridSize, 100);
    return Math.ceil(value / safeGridSize) * safeGridSize;
}

function snapToNearestGrid(value: number, gridSize: number): number {
    const safeGridSize = clampPositiveNumber(gridSize, 100);
    return Math.round(value / safeGridSize) * safeGridSize;
}

function computeLayoutPositions(
    widths: number[],
    heights: number[],
    layout: MapLayoutMode,
    spacing: number,
    gridSize: number,
    snapToGrid = true
): Vector2[] {
    const positions: Vector2[] = [];
    const normalizedSpacing = Math.max(0, spacing);
    const safeGridSize = clampPositiveNumber(gridSize, 100);

    if (layout === 'STACK') {
        for (let i = 0; i < widths.length; i++) {
            positions.push({ x: 0, y: 0 });
        }
        return positions;
    }

    if (layout === 'ROW') {
        let x = 0;
        for (let i = 0; i < widths.length; i++) {
            positions.push({ x, y: 0 });
            const nextX = x + widths[i] + normalizedSpacing;
            x = snapToGrid ? snapUpToGrid(nextX, safeGridSize) : nextX;
        }
        return positions;
    }

    if (layout === 'COLUMN') {
        let y = 0;
        for (let i = 0; i < widths.length; i++) {
            positions.push({ x: 0, y });
            const nextY = y + heights[i] + normalizedSpacing;
            y = snapToGrid ? snapUpToGrid(nextY, safeGridSize) : nextY;
        }
        return positions;
    }

    const columns = Math.max(1, Math.ceil(Math.sqrt(widths.length)));
    let rowMaxHeight = 0;
    let x = 0;
    let y = 0;

    for (let i = 0; i < widths.length; i++) {
        const column = i % columns;
        if (column === 0) {
            if (i > 0) {
                const nextY = y + rowMaxHeight + normalizedSpacing;
                y = snapToGrid ? snapUpToGrid(nextY, safeGridSize) : nextY;
            }
            x = 0;
            rowMaxHeight = 0;
        }

        positions.push({ x, y });
        const nextX = x + widths[i] + normalizedSpacing;
        x = snapToGrid ? snapUpToGrid(nextX, safeGridSize) : nextX;
        rowMaxHeight = Math.max(rowMaxHeight, heights[i]);
    }

    return positions;
}

async function waitForPickerOpenTransition(): Promise<void> {
    if (typeof window === 'undefined') {
        return;
    }

    await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
    });

    await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 120);
    });
}

async function prepareMapSources(
    sources: MapImportSource[],
    targetDpi: number,
    options: MultiMapImportOptions
): Promise<ResolvedMapImportSource[]> {
    const {
        compressionMode = 'standard',
        onProgress,
        onStage,
        onFileProgress,
        videoOptions,
        selectionToken,
        forceSelectionPrompt = false,
    } = options;

    const prefix = selectionToken ?? `scene-importer-${Date.now()}`;
    let prepared: PreparedMapImportSource[] = [];
    let selectedCandidates: SelectedImageCandidate[] | null = null;
    let preOpenedSelection: Awaited<ReturnType<typeof OBR.assets.downloadImages>> | null = null;

    if (selectionToken) {
        const completedSelection = completedMapSelections.get(selectionToken);
        if (completedSelection) {
            prepared = completedSelection.prepared;
            if (!forceSelectionPrompt) {
                selectedCandidates = completedSelection.selected;
            }
        } else if (pendingMapSelections.has(selectionToken)) {
            prepared = pendingMapSelections.get(selectionToken) || [];
        }
    }

    if (prepared.length === 0) {
        const total = Math.max(1, sources.length);
        const blobIds = new WeakMap<Blob, number>();
        let nextBlobId = 1;
        const getBlobId = (blob: Blob): number => {
            const existingId = blobIds.get(blob);
            if (existingId) return existingId;
            const id = nextBlobId++;
            blobIds.set(blob, id);
            return id;
        };
        const processedAssetByKey = new Map<string, {
            file: File;
            dpi: number;
            uploadName: string;
            assetSelectionKey: string;
        }>();

        for (let i = 0; i < sources.length; i++) {
            const source = sources[i];
            const sourceDpi = clampPositiveNumber(source.dpi, 100);
            const assetCacheKey = `${getBlobId(source.mediaBlob)}|${sourceDpi}`;
            onFileProgress?.({
                fileName: source.name,
                currentFile: i + 1,
                totalFiles: total,
                completedFiles: i,
                remainingFiles: Math.max(0, total - i),
                phase: 'preparing',
            });
            const startProgress = (i / total) * 70;
            const endProgress = ((i + 1) / total) * 70;
            const reportProgress = (localProgress: number) => {
                if (!onProgress) return;
                const normalizedLocal = Math.max(0, Math.min(100, localProgress));
                const value = Math.round(startProgress + ((endProgress - startProgress) * (normalizedLocal / 100)));
                onProgress(value);
            };

            if (onStage) {
                onStage(`Preparing ${source.name}`);
            }

            let processedAsset = processedAssetByKey.get(assetCacheKey);
            if (!processedAsset) {
                const isVideo =
                    source.mediaBlob.type.startsWith('video/') ||
                    /\.(mp4|webm|mov|avi|mkv|ogv)$/i.test(source.name.toLowerCase());

                let finalBlob: Blob = source.mediaBlob;
                let effectiveDpi = sourceDpi;

                if (isVideo) {
                    if (compressionMode !== 'none') {
                        const sizeInMb = source.mediaBlob.size / (1024 * 1024);
                        if (sizeInMb > 500) {
                            throw new VideoCompressionError(
                                'VIDEO_COMPRESSION_SOURCE_TOO_LARGE',
                                `Video file is too large (${sizeInMb.toFixed(1)}MB). The maximum supported size for browser compression is 500MB.`
                            );
                        }
                        const compressed = await compressVideo(source.mediaBlob, compressionMode, reportProgress, {
                            ...videoOptions,
                            onStage,
                        });
                        finalBlob = compressed.blob;
                        if (compressed.outputWidth > 0 && compressed.sourceWidth > 0) {
                            effectiveDpi = sourceDpi * (compressed.outputWidth / compressed.sourceWidth);
                        }
                    } else {
                        reportProgress(100);
                    }
                } else {
                    const sourceDimensions = await getImageDimensions(source.mediaBlob);
                    finalBlob = await optimizeImage(
                        source.mediaBlob,
                        {
                            compressionMode,
                            maxSizeInMB: compressionMode === 'high' ? 49 : 24,
                            maxMegapixels: compressionMode === 'standard' ? 67 : 144,
                            maxDimension: videoOptions?.maxDimension,
                        },
                        reportProgress,
                        onStage,
                    );
                    const dimensions = await getImageDimensions(finalBlob);
                    effectiveDpi = getAdjustedDpiAfterResize(sourceDpi, sourceDimensions, dimensions);
                }

                const extension = getImageExtensionFromMimeType(
                    finalBlob.type,
                    isVideo ? (finalBlob.type.includes('webm') ? 'webm' : 'mp4') : 'png'
                );
                processedAsset = {
                    file: new File([finalBlob], `${sanitizeMapName(source.name)}.${extension}`, { type: finalBlob.type }),
                    dpi: clampPositiveNumber(effectiveDpi, sourceDpi),
                    uploadName: buildUploadName(source.name),
                    assetSelectionKey: `${prefix}:asset:${processedAssetByKey.size + 1}`,
                };
                processedAssetByKey.set(assetCacheKey, processedAsset);
            } else {
                reportProgress(100);
            }

            prepared.push({
                displayName: sanitizeMapName(source.name),
                uploadName: processedAsset.uploadName,
                selectionKey: `${prefix}:map:${i + 1}`,
                assetSelectionKey: processedAsset.assetSelectionKey,
                file: processedAsset.file,
                dpi: processedAsset.dpi,
                wallData: source.wallData,
                sourceKey: source.sourceKey,
                sourceSceneName: source.sourceSceneName,
                foundryMapIdentity: source.foundryMapIdentity,
                mapPlacement: source.mapPlacement,
            });

            onFileProgress?.({
                fileName: source.name,
                currentFile: i + 1,
                totalFiles: total,
                completedFiles: i + 1,
                remainingFiles: Math.max(0, total - (i + 1)),
                phase: 'prepared',
            });
        }

        if (onProgress) {
            onProgress(72);
        }

        const uploadSources = new Map<string, PreparedMapImportSource>();
        for (const source of prepared) {
            if (!uploadSources.has(source.assetSelectionKey)) {
                uploadSources.set(source.assetSelectionKey, source);
            }
        }
        const uploads = Array.from(uploadSources.values()).map((source) =>
            buildImageUpload(source.file)
                .name(source.uploadName)
                .description(source.assetSelectionKey)
                .dpi(source.dpi)
                .locked(true)
                .build()
        );

        if (onStage) {
            onStage('Opening map picker');
        }
        const mapPickerPromise = OBR.assets.downloadImages(true, undefined, 'MAP');
        await waitForPickerOpenTransition();

        if (onStage) {
            onStage('Choose map storage location');
        }
        await OBR.assets.uploadImages(uploads, 'MAP');
        pendingMapSelections.set(prefix, prepared);

        if (onStage) {
            onStage('Select uploaded maps');
        }
        preOpenedSelection = await mapPickerPromise;
    }

    if (!selectedCandidates) {
        if (onStage) {
            onStage('Select uploaded maps');
        }

        const selected = preOpenedSelection ?? await OBR.assets.downloadImages(true, undefined, 'MAP');
        if (!selected.length) {
            restorePendingMapSelection(prefix, prepared);
            throw new MapSelectionPendingError(prefix);
        }

        selectedCandidates = selected.map((entry) => ({
            name: entry.name,
            image: entry.image,
            grid: entry.grid,
            description: entry.description,
        }));

        pendingMapSelections.delete(prefix);
        rememberCompletedMapSelection(prefix, prepared, selectedCandidates);
    }

    const preparedByAssetSelectionKey = new Map<string, PreparedMapImportSource[]>();
    const preparedByUploadName = new Map<string, PreparedMapImportSource[]>();
    const preparedByNormalizedUploadName = new Map<string, PreparedMapImportSource[]>();
    const preparedByLooseNormalizedUploadName = new Map<string, PreparedMapImportSource[]>();
    for (const entry of prepared) {
        const byAsset = preparedByAssetSelectionKey.get(entry.assetSelectionKey) ?? [];
        byAsset.push(entry);
        preparedByAssetSelectionKey.set(entry.assetSelectionKey, byAsset);
        const byUpload = preparedByUploadName.get(entry.uploadName) ?? [];
        byUpload.push(entry);
        preparedByUploadName.set(entry.uploadName, byUpload);
        const normalizedUploadName = normalizeNameForMatching(entry.uploadName);
        if (normalizedUploadName) {
            const byNormalizedUpload = preparedByNormalizedUploadName.get(normalizedUploadName) ?? [];
            byNormalizedUpload.push(entry);
            preparedByNormalizedUploadName.set(normalizedUploadName, byNormalizedUpload);
        }
        const looseNormalizedUploadName = normalizeNameForLooseMatching(entry.uploadName);
        if (looseNormalizedUploadName) {
            const byLooseNormalizedUpload = preparedByLooseNormalizedUploadName.get(looseNormalizedUploadName) ?? [];
            byLooseNormalizedUpload.push(entry);
            preparedByLooseNormalizedUploadName.set(looseNormalizedUploadName, byLooseNormalizedUpload);
        }
    }

    const selectedWithMetadata: Array<{
        selectedImage: SelectedImageCandidate;
        sourceMeta?: PreparedMapImportSource;
        metadataMatched: boolean;
    }> = [];
    const unmatchedSelectionDebug: Array<{
        selectedName: string;
        selectedDescription: string;
        normalizedSelectedName: string;
    }> = [];
    const emittedSelectionKeys = new Set<string>();
    for (const selectedImage of selectedCandidates) {
        const matchedByAssetKey = selectedImage.description
            ? preparedByAssetSelectionKey.get(selectedImage.description) ?? []
            : [];
        const matchedByUploadName = preparedByUploadName.get(selectedImage.name) ?? [];
        const normalizedSelectedName = normalizeNameForMatching(selectedImage.name);
        const matchedByNormalizedName = normalizedSelectedName
            ? preparedByNormalizedUploadName.get(normalizedSelectedName) ?? []
            : [];
        const looseNormalizedSelectedName = normalizeNameForLooseMatching(selectedImage.name);
        const matchedByLooseNormalizedName = looseNormalizedSelectedName
            ? preparedByLooseNormalizedUploadName.get(looseNormalizedSelectedName) ?? []
            : [];
        const unmatchedAssetMatches = matchedByAssetKey.filter(
            (sourceMeta) => !emittedSelectionKeys.has(sourceMeta.selectionKey)
        );
        const unmatchedUploadNameMatches = matchedByUploadName.filter(
            (sourceMeta) => !emittedSelectionKeys.has(sourceMeta.selectionKey)
        );
        const unmatchedNormalizedMatches = matchedByNormalizedName.filter(
            (sourceMeta) => !emittedSelectionKeys.has(sourceMeta.selectionKey)
        );
        const unmatchedLooseNormalizedMatches = matchedByLooseNormalizedName.filter(
            (sourceMeta) => !emittedSelectionKeys.has(sourceMeta.selectionKey)
        );
        let matches: PreparedMapImportSource[] = [];
        if (unmatchedAssetMatches.length > 0) {
            matches = unmatchedAssetMatches;
        } else if (unmatchedUploadNameMatches.length === 1) {
            matches = unmatchedUploadNameMatches;
        } else if (unmatchedNormalizedMatches.length === 1) {
            matches = unmatchedNormalizedMatches;
        } else if (unmatchedLooseNormalizedMatches.length === 1) {
            matches = unmatchedLooseNormalizedMatches;
        }
        if (matches.length === 0) {
            selectedWithMetadata.push({
                selectedImage,
                metadataMatched: false,
            });
            unmatchedSelectionDebug.push({
                selectedName: selectedImage.name,
                selectedDescription: selectedImage.description ?? '',
                normalizedSelectedName,
            });
            continue;
        }
        for (const sourceMeta of matches) {
            if (emittedSelectionKeys.has(sourceMeta.selectionKey)) continue;
            emittedSelectionKeys.add(sourceMeta.selectionKey);
            selectedWithMetadata.push({
                selectedImage,
                sourceMeta,
                metadataMatched: true,
            });
        }
    }



    console.info('[Scene Importer][Map Match] final', {
        preparedCount: prepared.length,
        selectedCount: selectedCandidates.length,
            matchedCount: selectedWithMetadata.filter((entry) => entry.metadataMatched).length,
                matchedSample: selectedWithMetadata.slice(0, 10).map((entry) => ({
                    selectedName: entry.selectedImage.name,
                    metadataMatched: entry.metadataMatched,
                    sourceDisplayName: entry.sourceMeta?.displayName ?? '',
                    sourceUploadName: entry.sourceMeta?.uploadName ?? '',
                    hasWallData: !!entry.sourceMeta?.wallData,
                    drawingCount: entry.sourceMeta?.wallData?.drawings?.length ?? 0,
                })),
    });

    const scale = clampPositiveNumber(options.scale, 1);
    const spacing = Math.max(0, Math.round(options.spacing ?? targetDpi));
    const shouldSnapToGrid = options.snapToGrid ?? true;
    const layout = options.layout ?? 'GRID';

    const displayWidths = selectedWithMetadata.map(({ selectedImage }) => {
        const entry = selectedImage;
        const sourceDpi = clampPositiveNumber(entry.grid?.dpi, 100);
        return (entry.image.width * targetDpi / sourceDpi) * scale;
    });
    const displayHeights = selectedWithMetadata.map(({ selectedImage }) => {
        const entry = selectedImage;
        const sourceDpi = clampPositiveNumber(entry.grid?.dpi, 100);
        return (entry.image.height * targetDpi / sourceDpi) * scale;
    });
    const positions = computeLayoutPositions(displayWidths, displayHeights, layout, spacing, targetDpi, shouldSnapToGrid);

    if (onProgress) {
        onProgress(92);
    }

    return selectedWithMetadata.map(({ selectedImage, sourceMeta, metadataMatched }, index) => {
        if (!sourceMeta) {
            console.warn(`No metadata match found for selected map "${selectedImage.name}". Importing without wall data.`);
        }

        const sourceDpi = clampPositiveNumber(selectedImage.grid?.dpi, 100);
        const mapPlacement = sourceMeta?.mapPlacement;
        let position = positions[index];
        let resolvedScale: Vector2 = { x: 1, y: 1 };
        let resolvedRotation = 0;
        let resolvedZIndex: number | undefined = undefined;
        const baseWidth = (selectedImage.image.width * targetDpi) / sourceDpi;
        const baseHeight = (selectedImage.image.height * targetDpi) / sourceDpi;

        if (mapPlacement) {
            const targetDpiRatio = targetDpi / sourceDpi;
            const mappedX = typeof mapPlacement.x === 'number' && Number.isFinite(mapPlacement.x)
                ? mapPlacement.x * targetDpiRatio
                : undefined;
            const mappedY = typeof mapPlacement.y === 'number' && Number.isFinite(mapPlacement.y)
                ? mapPlacement.y * targetDpiRatio
                : undefined;
            if (typeof mappedX === 'number' || typeof mappedY === 'number') {
                position = {
                    x: typeof mappedX === 'number' ? mappedX : position.x,
                    y: typeof mappedY === 'number' ? mappedY : position.y,
                };
            }

            const targetWidth = typeof mapPlacement.targetWidth === 'number' && Number.isFinite(mapPlacement.targetWidth)
                ? mapPlacement.targetWidth * targetDpiRatio
                : undefined;
            const targetHeight = typeof mapPlacement.targetHeight === 'number' && Number.isFinite(mapPlacement.targetHeight)
                ? mapPlacement.targetHeight * targetDpiRatio
                : undefined;
            const widthScale = targetWidth && baseWidth > 0 ? targetWidth / baseWidth : undefined;
            const heightScale = targetHeight && baseHeight > 0 ? targetHeight / baseHeight : undefined;
            const explicitScaleX = typeof mapPlacement.scaleX === 'number' && Number.isFinite(mapPlacement.scaleX)
                ? mapPlacement.scaleX
                : undefined;
            const explicitScaleY = typeof mapPlacement.scaleY === 'number' && Number.isFinite(mapPlacement.scaleY)
                ? mapPlacement.scaleY
                : undefined;
            resolvedScale = {
                x: widthScale ?? explicitScaleX ?? 1,
                y: heightScale ?? explicitScaleY ?? 1,
            };

            if (typeof mapPlacement.rotation === 'number' && Number.isFinite(mapPlacement.rotation)) {
                resolvedRotation = mapPlacement.rotation;
            }
            const elevation = typeof mapPlacement.elevation === 'number' && Number.isFinite(mapPlacement.elevation)
                ? mapPlacement.elevation
                : 0;
            const z = typeof mapPlacement.z === 'number' && Number.isFinite(mapPlacement.z)
                ? mapPlacement.z
                : 0;
            const sort = typeof mapPlacement.sort === 'number' && Number.isFinite(mapPlacement.sort)
                ? mapPlacement.sort
                : (typeof mapPlacement.zIndex === 'number' && Number.isFinite(mapPlacement.zIndex)
                    ? mapPlacement.zIndex
                    : 0);
            const orderIndex = typeof mapPlacement.orderIndex === 'number' && Number.isFinite(mapPlacement.orderIndex)
                ? mapPlacement.orderIndex
                : index;
            // Foundry stacks by several depth hints (elevation + z/sort + draw order).
            // Collapse these into one deterministic OBR z-index.
            resolvedZIndex = Math.round(
                elevation * 1_000_000 +
                z * 1_000 +
                sort * 10 +
                orderIndex
            );
        }

        if (
            Number.isFinite(resolvedRotation)
            && normalizeDegrees(resolvedRotation) !== 0
            && Number.isFinite(baseWidth)
            && Number.isFinite(baseHeight)
            && baseWidth > 0
            && baseHeight > 0
        ) {
            const localCenter = {
                x: (baseWidth * Math.abs(resolvedScale.x) * scale) / 2,
                y: (baseHeight * Math.abs(resolvedScale.y) * scale) / 2,
            };
            position = compensateForCenterAnchoredRotation(position, localCenter, resolvedRotation);
        }

        return {
            displayName: selectedImage.name || sourceMeta?.displayName || `Map ${index + 1}`,
            metadataMatched,
            wallData: sourceMeta?.wallData,
            image: selectedImage.image,
            grid: selectedImage.grid,
            position,
            rotation: resolvedRotation,
            scale: resolvedScale,
            zIndex: resolvedZIndex,
            foundryMapIdentity: sourceMeta?.foundryMapIdentity,
        };
    });
}

export async function addMapsToCurrentScene(
    sources: MapImportSource[],
    options: MultiMapImportOptions = {}
): Promise<MapWorkflowResult> {
    if (!sources.length) {
        throw new Error('Please select at least one map to add.');
    }

    if (!await OBR.scene.isReady()) {
        throw new Error('Scene is not ready. Please wait for the scene to finish loading.');
    }

    const targetDpi = await OBR.scene.grid.getDpi();
    const scale = clampPositiveNumber(options.scale, 1);
    const includeWalls = options.includeWalls ?? true;
    const includeDrawings = options.includeDrawings ?? true;
    const includeLights = options.lightOptions?.includeLights ?? true;
    const lockMaps = options.lockMaps ?? true;
    const prepared = await prepareMapSources(sources, targetDpi, options);

    const spacing = Math.max(0, Math.round(options.spacing ?? targetDpi));
    const shouldSnapToGrid = options.snapToGrid ?? true;
    let placementOffset: Vector2 = { x: 0, y: 0 };
    const existingMaps = await OBR.scene.items.getItems((item) => item.layer === 'MAP');
    if (existingMaps.length > 0) {
        const bounds = await OBR.scene.items.getItemBounds(existingMaps.map((item) => item.id));
        const placementMode = options.placement ?? 'RIGHT';
        if (placementMode === 'BELOW') {
            placementOffset = {
                x: shouldSnapToGrid ? snapToNearestGrid(bounds.min.x, targetDpi) : bounds.min.x,
                y: shouldSnapToGrid ? snapUpToGrid(bounds.max.y + spacing, targetDpi) : bounds.max.y + spacing,
            };
        } else if (placementMode === 'ORIGIN') {
            placementOffset = { x: 0, y: 0 };
        } else {
            placementOffset = {
                x: shouldSnapToGrid ? snapUpToGrid(bounds.max.x + spacing, targetDpi) : bounds.max.x + spacing,
                y: shouldSnapToGrid ? snapToNearestGrid(bounds.min.y, targetDpi) : bounds.min.y,
            };
        }
    }

    const positionedPrepared = prepared.map((entry) => ({
        ...entry,
        position: {
            x: entry.position.x + placementOffset.x,
            y: entry.position.y + placementOffset.y,
        },
    }));

    const mapItems: Item[] = positionedPrepared.map((entry) => {
        let builder = buildImage(entry.image, entry.grid)
            .name(entry.displayName)
            .layer('MAP')
            .position(entry.position)
            .rotation(entry.rotation)
            .scale({ x: entry.scale.x * scale, y: entry.scale.y * scale })
            .locked(lockMaps)
            .visible(true);
        if (typeof entry.zIndex === 'number' && Number.isFinite(entry.zIndex)) {
            builder = builder.zIndex(entry.zIndex);
        }
        if (entry.foundryMapIdentity) {
            builder = builder.metadata({
                [FOUNDRY_MAP_IDENTITY_KEY]: entry.foundryMapIdentity,
            });
        }
        return builder.build();
    });

    await addItemsInBatches(mapItems, BATCH_SIZE);

    const unmatchedSelectionNames = positionedPrepared
        .filter((entry) => !entry.metadataMatched)
        .map((entry) => entry.displayName);

    if (!includeWalls && !includeDrawings && !includeLights) {
        options.onProgress?.(100);
        return {
            importedMapCount: positionedPrepared.length,
            wallsAppliedToMapCount: 0,
            unmatchedSelectionNames,
        };
    }

    const importedItems: Item[] = [];
    let addedFogFeatures = false;
    let wallsAppliedToMapCount = 0;
    for (const entry of positionedPrepared) {
        if (!entry.wallData) continue;
        let addedFeaturesForMap = false;
        const sourceScale = {
            x: entry.scale.x * scale,
            y: entry.scale.y * scale,
        };
        if (includeDrawings && entry.wallData.drawings && entry.wallData.drawings.length > 0) {
            const drawings = applyMapRotationToImportedItems(
                await createDrawingItems(entry.wallData, entry.position, sourceScale, targetDpi),
                entry.position,
                entry.rotation
            );
            if (drawings.length > 0) {
                importedItems.push(...drawings);
                addedFeaturesForMap = true;
            }
        }
        if (includeWalls) {
            const walls = await createWallItems(entry.wallData, entry.position, sourceScale, targetDpi);
            if (walls.length > 0) {
                importedItems.push(...walls);
                addedFeaturesForMap = true;
                addedFogFeatures = true;
            }
            if (entry.wallData.portals && entry.wallData.portals.length > 0) {
                const doors = await createDoorItems(entry.wallData, entry.position, sourceScale, targetDpi);
                if (doors.length > 0) {
                    importedItems.push(...doors);
                    addedFeaturesForMap = true;
                    addedFogFeatures = true;
                }
            }
        }
        if (includeLights && entry.wallData.lights && entry.wallData.lights.length > 0) {
            const lights = await createLightItems(entry.wallData, entry.position, sourceScale, targetDpi, options.lightOptions);
            if (lights.length > 0) {
                importedItems.push(...lights);
                addedFeaturesForMap = true;
                addedFogFeatures = true;
            }
        }
        if (addedFeaturesForMap) {
            wallsAppliedToMapCount += 1;
        }
    }

    if (importedItems.length > 0) {
        await addItemsInBatches(importedItems, BATCH_SIZE);
        if (addedFogFeatures) {
            await OBR.scene.fog.setFilled(true);
        }
    }

    options.onProgress?.(100);

    return {
        importedMapCount: positionedPrepared.length,
        wallsAppliedToMapCount,
        unmatchedSelectionNames,
    };
}

export async function addWallsToCurrentSceneWithLayout(
    sources: MapImportSource[],
    options: MultiMapImportOptions = {}
): Promise<MapWorkflowResult> {
    if (!sources.length) {
        throw new Error('Please select at least one map to add walls from.');
    }

    if (!await OBR.scene.isReady()) {
        throw new Error('Scene is not ready. Please wait for the scene to finish loading.');
    }

    const targetDpi = await OBR.scene.grid.getDpi();
    const scale = clampPositiveNumber(options.scale, 1);
    const includeWalls = options.includeWalls ?? true;
    const includeDrawings = options.includeDrawings ?? true;
    const includeLights = options.lightOptions?.includeLights ?? true;
    const spacing = Math.max(0, Math.round(options.spacing ?? targetDpi));
    const shouldSnapToGrid = options.snapToGrid ?? true;
    const layout = options.layout ?? 'GRID';

    const displayWidths: number[] = [];
    const displayHeights: number[] = [];

    for (const source of sources) {
        const wallResolution = source.wallData?.resolution;
        const sourceDpi = clampPositiveNumber(
            wallResolution?.pixels_per_grid ?? source.dpi,
            100
        );

        try {
            if (source.mediaBlob.type.startsWith('video/')) {
                const metadata = await getVideoMetadata(source.mediaBlob);
                displayWidths.push((metadata.width * targetDpi / sourceDpi) * scale);
                displayHeights.push((metadata.height * targetDpi / sourceDpi) * scale);
            } else {
                const dimensions = await getImageDimensions(source.mediaBlob);
                displayWidths.push((dimensions.width * targetDpi / sourceDpi) * scale);
                displayHeights.push((dimensions.height * targetDpi / sourceDpi) * scale);
            }
        } catch {
            if (
                wallResolution &&
                Number.isFinite(wallResolution.map_size?.x) &&
                Number.isFinite(wallResolution.map_size?.y) &&
                (wallResolution.map_size?.x ?? 0) > 0 &&
                (wallResolution.map_size?.y ?? 0) > 0
            ) {
                const mapWidth = wallResolution.map_size.x;
                const mapHeight = wallResolution.map_size.y;
                const appearsToBePixelDimensions = mapWidth > 1000 || mapHeight > 1000;
                const width = appearsToBePixelDimensions
                    ? (mapWidth * targetDpi / sourceDpi) * scale
                    : (mapWidth * targetDpi) * scale;
                const height = appearsToBePixelDimensions
                    ? (mapHeight * targetDpi / sourceDpi) * scale
                    : (mapHeight * targetDpi) * scale;
                displayWidths.push(width);
                displayHeights.push(height);
                continue;
            }

            const fallbackDimension = (1000 * targetDpi / sourceDpi) * scale;
            displayWidths.push(fallbackDimension);
            displayHeights.push(fallbackDimension);
        }
    }

    const positions = computeLayoutPositions(displayWidths, displayHeights, layout, spacing, targetDpi, shouldSnapToGrid);

    let placementOffset: Vector2 = { x: 0, y: 0 };
    const existingMaps = await OBR.scene.items.getItems((item) => item.layer === 'MAP');
    type ExistingMapTransform = {
        id: string;
        name: string;
        position: Vector2;
        scale: Vector2;
        rotation: number;
    };
    const existingMapTransformByStrictName = new Map<string, ExistingMapTransform[]>();
    const existingMapTransformsByLooseName = new Map<string, ExistingMapTransform[]>();
    const strictNameToMapIds = new Map<string, Set<string>>();
    const looseNameToMapIds = new Map<string, Set<string>>();
    const appendUniqueTransform = (
        transformsByName: Map<string, ExistingMapTransform[]>,
        seenIdsByName: Map<string, Set<string>>,
        normalizedName: string,
        transform: ExistingMapTransform
    ): void => {
        const seenIds = seenIdsByName.get(normalizedName) ?? new Set<string>();
        if (seenIds.has(transform.id)) {
            return;
        }
        seenIds.add(transform.id);
        seenIdsByName.set(normalizedName, seenIds);
        const transforms = transformsByName.get(normalizedName) ?? [];
        transforms.push(transform);
        transformsByName.set(normalizedName, transforms);
    };
    for (const mapItem of existingMaps) {
        const mapId = typeof mapItem.id === 'string' ? mapItem.id : '';
        if (!mapId) continue;
        const mapName = typeof mapItem.name === 'string' ? mapItem.name : '';
        const strictNormalizedMapName = normalizeNameForMatching(mapName);
        if (!strictNormalizedMapName) continue;
        const looseNormalizedMapName = normalizeNameForLooseMatching(mapName);
        const mapPosition = (mapItem as { position?: unknown }).position as Vector2 | undefined;
        const mapScale = (mapItem as { scale?: unknown }).scale as Vector2 | undefined;
        if (
            !mapPosition
            || typeof mapPosition.x !== 'number'
            || typeof mapPosition.y !== 'number'
        ) {
            continue;
        }
        const resolvedScale: Vector2 = {
            x: typeof mapScale?.x === 'number' && Number.isFinite(mapScale.x) ? mapScale.x : 1,
            y: typeof mapScale?.y === 'number' && Number.isFinite(mapScale.y) ? mapScale.y : 1,
        };
        const mapRotation = (mapItem as { rotation?: unknown }).rotation;
        const resolvedRotation =
            typeof mapRotation === "number" && Number.isFinite(mapRotation)
                ? mapRotation
                : 0;
        const transform = {
            id: mapId,
            name: mapName,
            position: { x: mapPosition.x, y: mapPosition.y },
            scale: resolvedScale,
            rotation: resolvedRotation,
        };
        appendUniqueTransform(
            existingMapTransformByStrictName,
            strictNameToMapIds,
            strictNormalizedMapName,
            transform
        );
        if (looseNormalizedMapName) {
            appendUniqueTransform(
                existingMapTransformsByLooseName,
                looseNameToMapIds,
                looseNormalizedMapName,
                transform
            );
        }
    }

    const resolveExistingMapTransform = (
        sourceName: string
    ): {
        transform?: ExistingMapTransform;
        matchType: 'strict' | 'loose' | 'none' | 'ambiguous-strict' | 'ambiguous-loose';
    } => {
        const strictKey = normalizeNameForMatching(sourceName);
        if (!strictKey) {
            return { matchType: 'none' };
        }
        const strictMatches = existingMapTransformByStrictName.get(strictKey) ?? [];
        if (strictMatches.length === 1) {
            return { transform: strictMatches[0], matchType: 'strict' };
        }
        if (strictMatches.length > 1) {
            return { matchType: 'ambiguous-strict' };
        }
        const looseKey = normalizeNameForLooseMatching(sourceName);
        if (!looseKey) {
            return { matchType: 'none' };
        }
        const looseMatches = existingMapTransformsByLooseName.get(looseKey) ?? [];
        if (looseMatches.length === 1) {
            return { transform: looseMatches[0], matchType: 'loose' };
        }
        if (looseMatches.length > 1) {
            return { matchType: 'ambiguous-loose' };
        }
        return { matchType: 'none' };
    };
    if (existingMaps.length > 0) {
        const bounds = await OBR.scene.items.getItemBounds(existingMaps.map((item) => item.id));
        const placementMode = options.placement ?? 'RIGHT';
        if (placementMode === 'BELOW') {
            placementOffset = {
                x: shouldSnapToGrid ? snapToNearestGrid(bounds.min.x, targetDpi) : bounds.min.x,
                y: shouldSnapToGrid ? snapUpToGrid(bounds.max.y + spacing, targetDpi) : bounds.max.y + spacing,
            };
        } else if (placementMode === 'ORIGIN') {
            placementOffset = { x: 0, y: 0 };
        } else {
            placementOffset = {
                x: shouldSnapToGrid ? snapUpToGrid(bounds.max.x + spacing, targetDpi) : bounds.max.x + spacing,
                y: shouldSnapToGrid ? snapToNearestGrid(bounds.min.y, targetDpi) : bounds.min.y,
            };
        }
    }

    const unmatchedSelectionNames: string[] = [];
    const importedItems: Item[] = [];
    let addedFogFeatures = false;
    let wallsAppliedToMapCount = 0;
    const matchedSourceTransforms = sources.map((source) => {
        const match = resolveExistingMapTransform(source.name);
        return {
            source,
            transform: match.transform,
            matchType: match.matchType,
        };
    });

    for (let i = 0; i < sources.length; i++) {
        const source = sources[i];
        const wallData = source.wallData;
        if (!wallData) {
            unmatchedSelectionNames.push(source.name);
            continue;
        }

        const wallDataSourceDpi = clampPositiveNumber(
            wallData.resolution?.pixels_per_grid ?? source.dpi,
            100
        );
        const sourceMatch = matchedSourceTransforms[i];
        const directExistingMapTransform = sourceMatch.transform;

        let position = directExistingMapTransform
            ? {
                x: directExistingMapTransform.position.x,
                y: directExistingMapTransform.position.y,
            }
            : {
                x: positions[i].x + placementOffset.x,
                y: positions[i].y + placementOffset.y,
            };
        let sourceScale = directExistingMapTransform
            ? {
                x: directExistingMapTransform.scale.x,
                y: directExistingMapTransform.scale.y,
            }
            : { x: scale, y: scale };
        let sourceRotation = directExistingMapTransform
            ? directExistingMapTransform.rotation
            : 0;
        if (!directExistingMapTransform) {
            const sourcePlacementX = source.mapPlacement?.x;
            const sourcePlacementY = source.mapPlacement?.y;
            const sourceSceneName = (source.sourceSceneName ?? '').trim().toLowerCase();
            const anchorCandidate = matchedSourceTransforms.find((candidate) => {
                const candidatePlacementX = candidate.source.mapPlacement?.x;
                const candidatePlacementY = candidate.source.mapPlacement?.y;
                const candidateSceneName = (candidate.source.sourceSceneName ?? '').trim().toLowerCase();
                const sameSourceScene = sourceSceneName || candidateSceneName
                    ? sourceSceneName === candidateSceneName
                    : true;
                return !!candidate.transform
                    && sameSourceScene
                    && typeof sourcePlacementX === 'number'
                    && Number.isFinite(sourcePlacementX)
                    && typeof sourcePlacementY === 'number'
                    && Number.isFinite(sourcePlacementY)
                    && typeof candidatePlacementX === 'number'
                    && Number.isFinite(candidatePlacementX)
                    && typeof candidatePlacementY === 'number'
                    && Number.isFinite(candidatePlacementY);
            });

            if (
                anchorCandidate
                && anchorCandidate.transform
                && typeof sourcePlacementX === 'number'
                && typeof sourcePlacementY === 'number'
            ) {
                const anchorPlacementX = anchorCandidate.source.mapPlacement?.x as number;
                const anchorPlacementY = anchorCandidate.source.mapPlacement?.y as number;
                const anchorScale = anchorCandidate.transform.scale;
                const anchorDpiRatio = targetDpi / wallDataSourceDpi;
                const deltaFoundryX = anchorPlacementX - sourcePlacementX;
                const deltaFoundryY = anchorPlacementY - sourcePlacementY;
                const anchorRotation = anchorCandidate.transform.rotation;
                const sourceOffsetInAnchorSpace = {
                    x: deltaFoundryX * anchorDpiRatio * anchorScale.x,
                    y: deltaFoundryY * anchorDpiRatio * anchorScale.y,
                };
                const sourceOffsetInSceneSpace = rotatePointAroundOrigin(
                    sourceOffsetInAnchorSpace,
                    { x: 0, y: 0 },
                    anchorRotation
                );

                position = {
                    x: anchorCandidate.transform.position.x - sourceOffsetInSceneSpace.x,
                    y: anchorCandidate.transform.position.y - sourceOffsetInSceneSpace.y,
                };
                sourceScale = {
                    x: anchorScale.x,
                    y: anchorScale.y,
                };
                sourceRotation = anchorRotation;
            }
        }

        let addedFeaturesForMap = false;
        if (includeDrawings && wallData.drawings && wallData.drawings.length > 0) {
            const drawings = applyMapRotationToImportedItems(
                await createDrawingItems(wallData, position, sourceScale, targetDpi),
                position,
                sourceRotation
            );
            if (drawings.length > 0) {
                importedItems.push(...drawings);
                addedFeaturesForMap = true;
            }
        }
        if (includeWalls) {
            const walls = applyMapRotationToImportedItems(
                await createWallItems(wallData, position, sourceScale, targetDpi),
                position,
                sourceRotation
            );
            if (walls.length > 0) {
                importedItems.push(...walls);
                addedFeaturesForMap = true;
                addedFogFeatures = true;
            }

            if (wallData.portals && wallData.portals.length > 0) {
                const doors = applyMapRotationToImportedItems(
                    await createDoorItems(wallData, position, sourceScale, targetDpi),
                    position,
                    sourceRotation
                );
                if (doors.length > 0) {
                    importedItems.push(...doors);
                    addedFeaturesForMap = true;
                    addedFogFeatures = true;
                }
            }
        }
        if (includeLights && wallData.lights && wallData.lights.length > 0) {
            const lights = applyMapRotationToImportedItems(
                await createLightItems(
                    wallData,
                    position,
                    sourceScale,
                    targetDpi,
                    options.lightOptions
                ),
                position,
                sourceRotation
            );
            if (lights.length > 0) {
                importedItems.push(...lights);
                addedFeaturesForMap = true;
                addedFogFeatures = true;
            }
        }
        if (addedFeaturesForMap) {
            wallsAppliedToMapCount += 1;
        }

    }

    if (importedItems.length > 0) {
        await addItemsInBatches(importedItems, BATCH_SIZE);
        if (addedFogFeatures) {
            await OBR.scene.fog.setFilled(true);
        }
    }

    options.onProgress?.(100);

    return {
        importedMapCount: sources.length,
        wallsAppliedToMapCount,
        unmatchedSelectionNames,
    };
}

export async function createSceneWithMultipleMaps(
    sources: MapImportSource[],
    options: MultiMapImportOptions = {}
): Promise<MapWorkflowResult> {
    if (!sources.length) {
        throw new Error('Please select at least one map to create a scene.');
    }

    const targetDpi = DEFAULT_NEW_SCENE_GRID_DPI;
    const scale = clampPositiveNumber(options.scale, 1);
    const includeWalls = options.includeWalls ?? true;
    const includeDrawings = options.includeDrawings ?? true;
    const includeLights = options.lightOptions?.includeLights ?? true;
    const lockMaps = options.lockMaps ?? true;
    const prepared = await prepareMapSources(sources, targetDpi, options);

    const sceneItems: Item[] = prepared.map((entry) => {
        let builder = buildImage(entry.image, entry.grid)
            .name(entry.displayName)
            .layer('MAP')
            .position(entry.position)
            .rotation(entry.rotation)
            .scale({ x: entry.scale.x * scale, y: entry.scale.y * scale })
            .locked(lockMaps)
            .visible(true);
        if (typeof entry.zIndex === 'number' && Number.isFinite(entry.zIndex)) {
            builder = builder.zIndex(entry.zIndex);
        }
        if (entry.foundryMapIdentity) {
            builder = builder.metadata({
                [FOUNDRY_MAP_IDENTITY_KEY]: entry.foundryMapIdentity,
            });
        }
        return builder.build();
    });

    let addedFogFeatures = false;
    let wallsAppliedToMapCount = 0;
    if (includeWalls || includeDrawings || includeLights) {
        for (const entry of prepared) {
            if (!entry.wallData) continue;
            let addedFeaturesForMap = false;
            const sourceScale = {
                x: entry.scale.x * scale,
                y: entry.scale.y * scale,
            };
            if (includeDrawings && entry.wallData.drawings && entry.wallData.drawings.length > 0) {
                const drawings = applyMapRotationToImportedItems(
                    await createDrawingItems(entry.wallData, entry.position, sourceScale, targetDpi),
                    entry.position,
                    entry.rotation
                );
                if (drawings.length > 0) {
                    addedFeaturesForMap = true;
                    sceneItems.push(...drawings);
                }
            }
            if (includeWalls) {
                const walls = await createWallItems(entry.wallData, entry.position, sourceScale, targetDpi);
                if (walls.length > 0) {
                    addedFeaturesForMap = true;
                    addedFogFeatures = true;
                    sceneItems.push(...walls);
                }
                if (entry.wallData.portals && entry.wallData.portals.length > 0) {
                    const doors = await createDoorItems(entry.wallData, entry.position, sourceScale, targetDpi);
                    if (doors.length > 0) {
                        addedFeaturesForMap = true;
                        addedFogFeatures = true;
                        sceneItems.push(...doors);
                    }
                }
            }
            if (includeLights && entry.wallData.lights && entry.wallData.lights.length > 0) {
                const lights = await createLightItems(entry.wallData, entry.position, sourceScale, targetDpi, options.lightOptions);
                if (lights.length > 0) {
                    addedFeaturesForMap = true;
                    addedFogFeatures = true;
                    sceneItems.push(...lights);
                }
            }
            if (addedFeaturesForMap) {
                wallsAppliedToMapCount += 1;
            }
        }
    }

    const sceneBuilder = buildSceneUpload()
        .name(options.sceneName?.trim() || 'Multi Map Scene')
        .gridType('SQUARE')
        .items(sceneItems)
        .fogFilled(addedFogFeatures);

    const firstMapGridScale = sources.find(m => m.wallData?.gridScale)?.wallData?.gridScale;
    if (firstMapGridScale) {
        sceneBuilder.gridScale(firstMapGridScale);
    }

    const sceneUpload = sceneBuilder.build();

    options.onStage?.('Uploading scene');
    await OBR.assets.uploadScenes([sceneUpload]);
    options.onProgress?.(100);

    return {
        importedMapCount: prepared.length,
        wallsAppliedToMapCount,
        unmatchedSelectionNames: prepared
            .filter((entry) => !entry.metadataMatched)
            .map((entry) => entry.displayName),
    };
}

export async function preflightVideoCompression(
    fileBlob: Blob,
    options: VideoCompressionOptions = {}
): Promise<VideoCompressionPreflightResult> {
    if (!fileBlob.type.startsWith('video/')) {
        return { supported: true };
    }

    try {
        const metadata = await getVideoMetadata(fileBlob);
        const targetDimension = options.maxDimension && options.maxDimension > 0
            ? options.maxDimension
            : Math.max(metadata.width, metadata.height);

        let outWidth = metadata.width;
        let outHeight = metadata.height;
        if (targetDimension > 0 && Math.max(metadata.width, metadata.height) > targetDimension) {
            const scale = targetDimension / Math.max(metadata.width, metadata.height);
            outWidth = toEvenDimension(metadata.width * scale);
            outHeight = toEvenDimension(metadata.height * scale);
        }

        const mb = await import('mediabunny') as unknown as MediabunnyModule;
        const analysisInput = new mb.Input({
            source: new mb.BlobSource(fileBlob),
            formats: mb.ALL_FORMATS,
        });
        const sourceVideoTrack = await analysisInput.getPrimaryVideoTrack?.();
        const codecCandidates = getDecoderCodecCandidates(sourceVideoTrack?.codec, fileBlob.type);

        const estimatedBitrate = Math.max(
            250_000,
            Math.floor((fileBlob.size * 8) / Math.max(metadata.duration, 1))
        );

        const decodeSupported = await isDecoderSupportedForSource(
            codecCandidates,
            fileBlob.type || 'video/mp4',
            outWidth,
            outHeight,
            Number.isFinite(metadata.frameRate) && metadata.frameRate > 1 ? metadata.frameRate : 30,
            estimatedBitrate
        );

        if (decodeSupported === false) {
            return {
                supported: false,
                reason: `Decoder capability check failed for ${outWidth}x${outHeight} input in this browser.`,
            };
        }

        if (decodeSupported === null) {
            return {
                supported: true,
                inconclusive: true,
            };
        }

        return { supported: true };
    } catch {
        return { supported: true, inconclusive: true };
    }
}

function isRawMediaFile(file: File): boolean {
    const lowerName = file.name.toLowerCase();
    return (
        file.type.startsWith('image/') ||
        file.type.startsWith('video/') ||
        /\.(png|jpe?g|webp|avif|gif|bmp|mp4|webm|mov|avi|mkv|ogv)$/i.test(lowerName)
    );
}

async function uploadRawMediaScene(
    file: File,
    compressionMode: CompressionMode = 'standard',
    onProgress?: (progress: number) => void,
    videoOptions?: VideoCompressionOptions,
    onStage?: (stage: string) => void
): Promise<void> {
    const isVideo =
        file.type.startsWith('video/') ||
        /\.(mp4|webm|mov|avi|mkv|ogv)$/i.test(file.name.toLowerCase());

    let finalBlob: Blob = file;
    let fileExtension = file.name.split('.').pop() || (isVideo ? 'mp4' : 'png');

    if (isVideo) {
        if (compressionMode !== 'none') {
            const sizeInMb = file.size / (1024 * 1024);
            if (sizeInMb > 500) {
                throw new VideoCompressionError(
                    'VIDEO_COMPRESSION_SOURCE_TOO_LARGE',
                    `Video file is too large (${sizeInMb.toFixed(1)}MB). The maximum supported size for browser compression is 500MB.`
                );
            }
            const compressed = await compressVideo(file, compressionMode, onProgress, { ...videoOptions, onStage });
            finalBlob = compressed.blob;
            fileExtension = finalBlob.type.includes('webm') ? 'webm' : 'mp4';
        }
    } else {
        const optimizationOptions: OptimizationOptions = {
            compressionMode,
            maxSizeInMB: compressionMode === 'high' ? 49 : 24,
            maxMegapixels: compressionMode === 'standard' ? 67 : 144,
            maxDimension: videoOptions?.maxDimension,
        };
        finalBlob = await optimizeImage(file, optimizationOptions, onProgress, onStage);
        fileExtension = getImageExtensionFromMimeType(finalBlob.type, 'png');
    }

    const mediaFile = new File([finalBlob], `map.${fileExtension}`, { type: finalBlob.type });
    const imageUpload = buildImageUpload(mediaFile)
        .dpi(100)
        .name(file.name.replace(/\.[^/.]+$/, ''))
        .build();

    const sceneBuilder = buildSceneUpload()
        .name(file.name.replace(/\.[^/.]+$/, ''))
        .baseMap(imageUpload)
        .gridType('SQUARE');



    const sceneToUpload = sceneBuilder.build();
    await OBR.assets.uploadScenes([sceneToUpload]);
}

export async function uploadSceneFromVTT(
    file: File,
    compressionMode: CompressionMode = 'standard',
    onProgress?: (progress: number) => void,
    videoOptions?: VideoCompressionOptions,
    onStage?: (stage: string) => void,
    fogImportOptions: FogImportOptions = {}
): Promise<void> {
    if (isRawMediaFile(file)) {
        return uploadRawMediaScene(file, compressionMode, onProgress, videoOptions, onStage);
    }

    const content = await readFileAsText(file);
    const parsedJson = JSON.parse(content);

    if (isFoundryVTTData(parsedJson)) {
        throw new Error("FoundryVTT files do not contain map images and cannot be used to create scenes. Use 'Add Walls to Current Scene' for Foundry files.");
    }

    if (!isUniversalVTTData(parsedJson)) {
        throw new Error("Unsupported VTT file format. Please use a valid UVTT file for creating new scenes.");
    }

    // Now we know parsedJson is UniversalVTT
    const data = parsedJson as UniversalVTT;

    if (!data.image) {
        throw new Error("No map image found in UVTT file. A map image is required to create a new scene.");
    }

    // Convert base64 to Blob/File
    const imageData = atob(data.image);
    const arrayBuffer = new ArrayBuffer(imageData.length);
    const uint8Array = new Uint8Array(arrayBuffer);
    for (let i = 0; i < imageData.length; i++) {
        uint8Array[i] = imageData.charCodeAt(i);
    }

    // Determine the image type from the base64 data
    const imageType = getImageTypeFromBase64(data.image);
    const imageBlob = new Blob([arrayBuffer], { type: imageType });
    const sourceDpi = clampPositiveNumber(data.resolution?.pixels_per_grid, 100);
    const sourceDimensions = await getImageDimensions(imageBlob);

    // Configure optimization based on compression mode
    const optimizationOptions: OptimizationOptions = {
        compressionMode,
        maxSizeInMB: compressionMode === 'high' ? 49 : 24, // Using 49MB and 24MB to leave some safety margin
        maxMegapixels: compressionMode === 'standard' ? 67 : 144,
        maxDimension: videoOptions?.maxDimension,
    };

    // UVTT data embeds map images, not videos.
    const finalBlob = await optimizeImage(imageBlob, optimizationOptions, onProgress, onStage);
    const finalDimensions = await getImageDimensions(finalBlob);
    const effectiveDpi = getAdjustedDpiAfterResize(sourceDpi, sourceDimensions, finalDimensions);
    const fileExtension = getImageExtensionFromMimeType(finalBlob.type, imageType === 'image/webp' ? 'webp' : 'png');
    const imageFile = new File([finalBlob], `map.${fileExtension}`, { type: finalBlob.type });

    // Create and upload just the map as a scene
    const imageUpload = buildImageUpload(imageFile)
        .dpi(effectiveDpi)
        .name(file.name.replace(/\.[^/.]+$/, ""))
        .build();

    // Prepare items to add to the scene
    const vttMapDataSource = data as VTTMapData; // data is UniversalVTT which is compatible
    const defaultPosition: Vector2 = { x: 0, y: 0 };
    const defaultScale: Vector2 = { x: 1, y: 1 };
    const includeWalls = fogImportOptions.includeWalls ?? true;
    const includeDrawings = fogImportOptions.includeDrawings ?? true;
    const lightOptions = fogImportOptions.lightOptions;

    const wallItems = includeWalls
        ? await createWallItems(vttMapDataSource, defaultPosition, defaultScale, DEFAULT_NEW_SCENE_GRID_DPI)
        : [];
    let doorItems: Item[] = [];
    let lightItems: Item[] = [];
    let drawingItems: Item[] = [];
    if (includeWalls && vttMapDataSource.portals && vttMapDataSource.portals.length > 0) {
        doorItems = await createDoorItems(vttMapDataSource, defaultPosition, defaultScale, DEFAULT_NEW_SCENE_GRID_DPI);
    }
    if (includeDrawings && vttMapDataSource.drawings && vttMapDataSource.drawings.length > 0) {
        drawingItems = await createDrawingItems(vttMapDataSource, defaultPosition, defaultScale, DEFAULT_NEW_SCENE_GRID_DPI);
    }
    if (vttMapDataSource.lights && vttMapDataSource.lights.length > 0) {
        lightItems = await createLightItems(vttMapDataSource, defaultPosition, defaultScale, DEFAULT_NEW_SCENE_GRID_DPI, lightOptions);
    }
    const allItems = [...wallItems, ...doorItems, ...drawingItems, ...lightItems];
    const hasFogFeatures = wallItems.length > 0 || doorItems.length > 0 || lightItems.length > 0;

    let sceneBuilder = buildSceneUpload()
        .name(file.name.replace(/\.[^/.]+$/, ""))
        .baseMap(imageUpload)
        .gridType("SQUARE");

    if (vttMapDataSource.gridScale) {
        sceneBuilder.gridScale(vttMapDataSource.gridScale);
    }

    if (allItems.length > 0) {
        sceneBuilder = sceneBuilder.items(allItems).fogFilled(hasFogFeatures);
    }

    const sceneToUpload = sceneBuilder.build();
    await OBR.assets.uploadScenes([sceneToUpload]);
}

export async function uploadFoundryScene(
    foundryData: FoundryVTTData,
    imageBlob: Blob,
    name: string,
    compressionMode: CompressionMode = 'standard',
    onProgress?: (progress: number) => void,
    videoOptions?: VideoCompressionOptions,
    onStage?: (stage: string) => void,
    fogImportOptions: FogImportOptions = {}
): Promise<void> {
    const vttMapDataSource = convertFoundryToVTTData(foundryData);

    const optimizationOptions: OptimizationOptions = {
        compressionMode,
        maxSizeInMB: compressionMode === 'high' ? 49 : 24,
        maxMegapixels: compressionMode === 'standard' ? 67 : 144,
        maxDimension: videoOptions?.maxDimension,
    };

    const isVideo = imageBlob.type.startsWith('video/');
    let finalBlob: Blob = imageBlob;
    let fileExtension = isVideo ? (imageBlob.type.includes('mp4') ? 'mp4' : 'webm') : 'png';

    let effectiveDpi = vttMapDataSource.resolution.pixels_per_grid;

    if (isVideo) {
        const sizeInMb = imageBlob.size / (1024 * 1024);
        if (compressionMode !== 'none') {
            if (sizeInMb > 500) {
                throw new VideoCompressionError(
                    'VIDEO_COMPRESSION_SOURCE_TOO_LARGE',
                    `Video file is too large (${sizeInMb.toFixed(1)}MB). The maximum supported size for browser compression is 500MB.`
                );
            }
            const compressed = await compressVideo(imageBlob, compressionMode, onProgress, { ...videoOptions, onStage });
            finalBlob = compressed.blob;
            if (compressed.outputWidth > 0 && compressed.sourceWidth > 0) {
                effectiveDpi = vttMapDataSource.resolution.pixels_per_grid * (compressed.outputWidth / compressed.sourceWidth);
            }
            fileExtension = finalBlob.type.includes('webm') ? 'webm' : 'mp4';
        }
    } else {
        const sourceDimensions = await getImageDimensions(imageBlob);
        finalBlob = await optimizeImage(imageBlob, optimizationOptions, onProgress, onStage);
        const finalDimensions = await getImageDimensions(finalBlob);
        effectiveDpi = getAdjustedDpiAfterResize(vttMapDataSource.resolution.pixels_per_grid, sourceDimensions, finalDimensions);
        fileExtension = getImageExtensionFromMimeType(finalBlob.type, 'png');
    }
    const imageFile = new File([finalBlob], `map.${fileExtension}`, { type: finalBlob.type });

    const imageUpload = buildImageUpload(imageFile)
        .dpi(effectiveDpi)
        .name(name)
        .build();

    const defaultPosition: Vector2 = { x: 0, y: 0 };
    const defaultScale: Vector2 = { x: 1, y: 1 };
    const includeWalls = fogImportOptions.includeWalls ?? true;
    const includeDrawings = fogImportOptions.includeDrawings ?? true;
    const lightOptions = fogImportOptions.lightOptions;

    const wallItems = includeWalls
        ? await createWallItems(vttMapDataSource, defaultPosition, defaultScale, DEFAULT_NEW_SCENE_GRID_DPI)
        : [];
    let doorItems: Item[] = [];
    let lightItems: Item[] = [];
    let drawingItems: Item[] = [];
    if (includeWalls && vttMapDataSource.portals && vttMapDataSource.portals.length > 0) {
        doorItems = await createDoorItems(vttMapDataSource, defaultPosition, defaultScale, DEFAULT_NEW_SCENE_GRID_DPI);
    }
    if (includeDrawings && vttMapDataSource.drawings && vttMapDataSource.drawings.length > 0) {
        drawingItems = await createDrawingItems(vttMapDataSource, defaultPosition, defaultScale, DEFAULT_NEW_SCENE_GRID_DPI);
    }
    if (vttMapDataSource.lights && vttMapDataSource.lights.length > 0) {
        lightItems = await createLightItems(vttMapDataSource, defaultPosition, defaultScale, DEFAULT_NEW_SCENE_GRID_DPI, lightOptions);
    }
    const allItems = [...wallItems, ...doorItems, ...drawingItems, ...lightItems];
    const hasFogFeatures = wallItems.length > 0 || doorItems.length > 0 || lightItems.length > 0;

    let sceneBuilder = buildSceneUpload()
        .name(name)
        .baseMap(imageUpload)
        .gridType("SQUARE");

    if (vttMapDataSource.gridScale) {
        sceneBuilder.gridScale(vttMapDataSource.gridScale);
    }

    if (allItems.length > 0) {
        sceneBuilder = sceneBuilder.items(allItems).fogFilled(hasFogFeatures);
    }

    const sceneToUpload = sceneBuilder.build();
    await OBR.assets.uploadScenes([sceneToUpload]);
}

export async function uploadMediaSceneWithWallData(
    mediaFile: File,
    wallData: FoundryVTTData | VTTMapData,
    sceneName?: string,
    compressionMode: CompressionMode = 'standard',
    onProgress?: (progress: number) => void,
    videoOptions?: VideoCompressionOptions,
    onStage?: (stage: string) => void,
    fogImportOptions: FogImportOptions = {}
): Promise<void> {
    if (!isRawMediaFile(mediaFile)) {
        throw new Error('Wall-data scene creation requires an image or video file.');
    }

    const vttMapDataSource = isFoundryVTTData(wallData)
        ? convertFoundryToVTTData(wallData)
        : wallData;

    const isVideo =
        mediaFile.type.startsWith('video/') ||
        /\.(mp4|webm|mov|avi|mkv|ogv)$/i.test(mediaFile.name.toLowerCase());

    const sourceDpi = clampPositiveNumber(vttMapDataSource.resolution?.pixels_per_grid, 100);
    const normalizedName = (sceneName?.trim() || mediaFile.name.replace(/\.[^/.]+$/, '') || 'Scene').trim();

    const optimizationOptions: OptimizationOptions = {
        compressionMode,
        maxSizeInMB: compressionMode === 'high' ? 49 : 24,
        maxMegapixels: compressionMode === 'standard' ? 67 : 144,
        maxDimension: videoOptions?.maxDimension,
    };

    let finalBlob: Blob = mediaFile;
    let fileExtension = mediaFile.name.split('.').pop() || (isVideo ? 'mp4' : 'png');
    let effectiveDpi = sourceDpi;

    if (isVideo) {
        if (compressionMode !== 'none') {
            const sizeInMb = mediaFile.size / (1024 * 1024);
            if (sizeInMb > 500) {
                throw new VideoCompressionError(
                    'VIDEO_COMPRESSION_SOURCE_TOO_LARGE',
                    `Video file is too large (${sizeInMb.toFixed(1)}MB). The maximum supported size for browser compression is 500MB.`
                );
            }

            const compressed = await compressVideo(mediaFile, compressionMode, onProgress, { ...videoOptions, onStage });
            finalBlob = compressed.blob;
            if (compressed.outputWidth > 0 && compressed.sourceWidth > 0) {
                effectiveDpi = sourceDpi * (compressed.outputWidth / compressed.sourceWidth);
            }
            fileExtension = finalBlob.type.includes('webm') ? 'webm' : 'mp4';
        }
    } else {
        finalBlob = await optimizeImage(mediaFile, optimizationOptions, onProgress, onStage);
        const sourceDimensions = await getImageDimensions(mediaFile);
        const finalDimensions = await getImageDimensions(finalBlob);
        effectiveDpi = getAdjustedDpiAfterResize(sourceDpi, sourceDimensions, finalDimensions);
        fileExtension = getImageExtensionFromMimeType(finalBlob.type, 'png');
    }

    const imageFile = new File([finalBlob], `map.${fileExtension}`, { type: finalBlob.type });
    const imageUpload = buildImageUpload(imageFile)
        .dpi(effectiveDpi)
        .name(normalizedName)
        .build();

    onStage?.('Generating walls and doors');

    const defaultPosition: Vector2 = { x: 0, y: 0 };
    const defaultScale: Vector2 = { x: 1, y: 1 };
    const includeWalls = fogImportOptions.includeWalls ?? true;
    const includeDrawings = fogImportOptions.includeDrawings ?? true;
    const lightOptions = fogImportOptions.lightOptions;
    const wallItems = includeWalls
        ? await createWallItems(vttMapDataSource, defaultPosition, defaultScale, DEFAULT_NEW_SCENE_GRID_DPI)
        : [];
    let doorItems: Item[] = [];
    let lightItems: Item[] = [];
    let drawingItems: Item[] = [];
    if (includeWalls && vttMapDataSource.portals && vttMapDataSource.portals.length > 0) {
        doorItems = await createDoorItems(vttMapDataSource, defaultPosition, defaultScale, DEFAULT_NEW_SCENE_GRID_DPI);
    }
    if (includeDrawings && vttMapDataSource.drawings && vttMapDataSource.drawings.length > 0) {
        drawingItems = await createDrawingItems(vttMapDataSource, defaultPosition, defaultScale, DEFAULT_NEW_SCENE_GRID_DPI);
    }
    if (vttMapDataSource.lights && vttMapDataSource.lights.length > 0) {
        lightItems = await createLightItems(vttMapDataSource, defaultPosition, defaultScale, DEFAULT_NEW_SCENE_GRID_DPI, lightOptions);
    }
    const allItems = [...wallItems, ...doorItems, ...drawingItems, ...lightItems];
    const hasFogFeatures = wallItems.length > 0 || doorItems.length > 0 || lightItems.length > 0;

    let sceneBuilder = buildSceneUpload()
        .name(normalizedName)
        .baseMap(imageUpload)
        .gridType('SQUARE');

    if (vttMapDataSource.gridScale) {
        sceneBuilder.gridScale(vttMapDataSource.gridScale);
    }

    if (allItems.length > 0) {
        sceneBuilder = sceneBuilder.items(allItems).fogFilled(hasFogFeatures);
    }

    onStage?.('Uploading scene');
    const sceneToUpload = sceneBuilder.build();
    await OBR.assets.uploadScenes([sceneToUpload]);
    onProgress?.(100);
}

const BATCH_SIZE = 75;

// Helper function to process items in batches with rate-limit pacing
async function addItemsInBatches(items: Item[], batchSize: number): Promise<void> {
    for (let i = 0; i < items.length; i += batchSize) {
        const batch = items.slice(i, i + batchSize);
        await OBR.scene.items.addItems(batch);

        // Respect rate limits for subsequent batches
        if (i + batchSize < items.length) {
            await new Promise(resolve => setTimeout(resolve, 250));
        }
    }
}

export type FoundryLogicalMapImportOptions = {
    scope?: "selected-map" | "full-scene";
    includeWalls?: boolean;
    includeDrawings?: boolean;
    lightOptions?: LightImportOptions;
    anchorLayer?: FoundryLogicalMap["primaryLayer"];
};

export type FoundryLogicalMapImportResult = {
    logicalMapId: string;
    logicalMapLabel: string;
    wallCount: number;
    doorCount: number;
    lightCount: number;
    drawingItemCount: number;
};

function rotateFogPathsOntoImage(
    items: Item[],
    imagePosition: Vector2,
    rotation: number
): Item[] {
    const normalizedRotation = normalizeDegrees(rotation);
    if (normalizedRotation === 0) return items;
    return items.map((item) => {
        const pathItem = item as Item & { commands?: Array<Array<number>> };
        if (item.layer !== "FOG" || !Array.isArray(pathItem.commands)) {
            return applyMapRotationToImportedItems(
                [item],
                imagePosition,
                normalizedRotation
            )[0];
        }
        const itemPosition = item.position ?? imagePosition;
        const commands = pathItem.commands.map((command) => {
            if (!Array.isArray(command) || command.length < 3) return command;
            const next = [...command];
            for (let index = 1; index + 1 < next.length; index += 2) {
                const x = next[index];
                const y = next[index + 1];
                if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
                const rotated = rotatePointAroundOrigin(
                    { x: itemPosition.x + x, y: itemPosition.y + y },
                    imagePosition,
                    normalizedRotation
                );
                next[index] = rotated.x;
                next[index + 1] = rotated.y;
            }
            return next;
        });
        return {
            ...item,
            position: { x: 0, y: 0 },
            rotation: 0,
            commands,
        };
    });
}

export async function addFoundryLogicalMapToExistingMap(
    foundryData: FoundryVTTData,
    logicalMap: FoundryLogicalMap,
    anchorMapId: string,
    options: FoundryLogicalMapImportOptions = {}
): Promise<FoundryLogicalMapImportResult> {
    if (!await OBR.scene.isReady()) {
        throw new Error("Scene is not ready. Please wait for the scene to finish loading.");
    }
    const anchorId = anchorMapId.trim();
    if (!anchorId) {
        throw new Error("No selected OBR map was provided.");
    }
    const anchorItems = await OBR.scene.items.getItems([anchorId]);
    const anchorItem = anchorItems[0] as Item & {
        image?: { width?: unknown; height?: unknown };
        grid?: { dpi?: unknown };
    };
    if (!anchorItem || anchorItem.layer !== "MAP") {
        throw new Error("The selected OBR map is no longer available.");
    }
    const imageWidth = Number(anchorItem.image?.width);
    const imageHeight = Number(anchorItem.image?.height);
    const imageDpi = Number(anchorItem.grid?.dpi);
    if (
        !Number.isFinite(imageWidth) || imageWidth <= 0 ||
        !Number.isFinite(imageHeight) || imageHeight <= 0 ||
        !Number.isFinite(imageDpi) || imageDpi <= 0
    ) {
        throw new Error("The selected OBR item does not contain usable map dimensions.");
    }

    const scope = options.scope ?? "selected-map";
    const selectedData = selectFoundryLogicalMapFeatures(
        foundryData,
        logicalMap,
        scope
    );
    const anchorLayer =
        options.anchorLayer && logicalMap.layers.some((layer) => layer.id === options.anchorLayer?.id)
            ? options.anchorLayer
            : logicalMap.primaryLayer;
    const processedData = convertFoundryToVTTData(selectedData, {
        origin: {
            x: anchorLayer.footprint.x,
            y: anchorLayer.footprint.y,
        },
        mapSizePixels: {
            x: anchorLayer.footprint.width,
            y: anchorLayer.footprint.height,
        },
        sourceRotation: anchorLayer.footprint.rotation,
    });
    const targetDpi = await OBR.scene.grid.getDpi();
    const anchorScale = anchorItem.scale ?? { x: 1, y: 1 };
    const renderedWidth = (imageWidth * targetDpi / imageDpi) * anchorScale.x;
    const renderedHeight = (imageHeight * targetDpi / imageDpi) * anchorScale.y;
    const sourceWidth = anchorLayer.footprint.width;
    const sourceHeight = anchorLayer.footprint.height;
    const sourceGridSize = processedData.resolution.pixels_per_grid;
    const importScale = {
        x: (renderedWidth / sourceWidth) * (sourceGridSize / targetDpi),
        y: (renderedHeight / sourceHeight) * (sourceGridSize / targetDpi),
    };
    const includeWalls = options.includeWalls ?? true;
    const includeDrawings = options.includeDrawings ?? true;
    const includeLights = options.lightOptions?.includeLights ?? true;
    const position = anchorItem.position;
    const wallItems = includeWalls
        ? await createWallItems(processedData, position, importScale, targetDpi)
        : [];
    const doorItems = includeWalls
        ? await createDoorItems(processedData, position, importScale, targetDpi)
        : [];
    const lightItems = includeLights
        ? await createLightItems(
            processedData,
            position,
            importScale,
            targetDpi,
            options.lightOptions
        )
        : [];
    const drawingItems = includeDrawings
        ? await createDrawingItems(processedData, position, importScale, targetDpi)
        : [];
    const allItems = rotateFogPathsOntoImage(
        [...wallItems, ...doorItems, ...lightItems, ...drawingItems],
        position,
        anchorItem.rotation
    );
    if (allItems.length > 0) {
        await addItemsInBatches(allItems, BATCH_SIZE);
        if (wallItems.length > 0 || doorItems.length > 0 || lightItems.length > 0) {
            await OBR.scene.fog.setFilled(true);
        }
    }
    return {
        logicalMapId: logicalMap.id,
        logicalMapLabel: logicalMap.label,
        wallCount: wallItems.length,
        doorCount: doorItems.length,
        lightCount: lightItems.length,
        drawingItemCount: drawingItems.length,
    };
}

export async function addItemsFromData(
    processedData: VTTMapData,
    context: boolean,
    options: {
        includeWalls?: boolean;
        includeDrawings?: boolean;
        lightOptions?: LightImportOptions;
    } = {}
): Promise<void> {
    if (!await OBR.scene.isReady()) {
        console.error("Scene is not ready. Please wait until the scene is fully loaded.");
        return;
    }

    if (!processedData.resolution?.pixels_per_grid) {
        throw new Error("No valid grid resolution data found in the file");
    }

    let position = { x: 0, y: 0 };
    let scale = { x: 1, y: 1 };
    const dpi = await OBR.scene.grid.getDpi();

    if (context) {
        const selection = await OBR.player.getSelection();
        if (selection && selection.length > 0) {
            const items = await OBR.scene.items.getItems(selection);
            if (items.length > 0) {
                const selectedItem = items[0];
                position = selectedItem.position;
                if ('scale' in selectedItem) {
                    scale = selectedItem.scale;
                }

                // Keep walls aligned to the selected map even when the map has been resized.
                const sourceMapWidth = processedData.resolution?.map_size?.x;
                const sourceMapHeight = processedData.resolution?.map_size?.y;
                const sourcePixelsPerGrid = processedData.resolution?.pixels_per_grid;
                const selectedWithImage = selectedItem as {
                    image?: {
                        width?: unknown;
                        height?: unknown;
                    };
                    grid?: {
                        dpi?: unknown;
                    };
                    width?: unknown;
                    height?: unknown;
                };
                const selectedWidth = typeof selectedWithImage.image?.width === 'number'
                    ? selectedWithImage.image.width
                    : typeof selectedWithImage.width === 'number'
                        ? selectedWithImage.width
                        : undefined;
                const selectedHeight = typeof selectedWithImage.image?.height === 'number'
                    ? selectedWithImage.image.height
                    : typeof selectedWithImage.height === 'number'
                        ? selectedWithImage.height
                        : undefined;
                const selectedImageDpi = typeof selectedWithImage.grid?.dpi === 'number'
                    ? selectedWithImage.grid.dpi
                    : dpi;

                if (
                    typeof sourceMapWidth === 'number' && sourceMapWidth > 0
                    && typeof sourceMapHeight === 'number' && sourceMapHeight > 0
                    && typeof sourcePixelsPerGrid === 'number' && sourcePixelsPerGrid > 0
                    && typeof selectedWidth === 'number' && selectedWidth > 0
                    && typeof selectedHeight === 'number' && selectedHeight > 0
                    && typeof selectedImageDpi === 'number' && selectedImageDpi > 0
                ) {
                    const renderedWidth = (selectedWidth * dpi / selectedImageDpi) * scale.x;
                    const renderedHeight = (selectedHeight * dpi / selectedImageDpi) * scale.y;
                    const sourceSceneWidth = sourceMapWidth * dpi;
                    const sourceSceneHeight = sourceMapHeight * dpi;
                    const scaleFromWidth = renderedWidth / sourceSceneWidth;
                    const scaleFromHeight = renderedHeight / sourceSceneHeight;

                    if (Number.isFinite(scaleFromWidth) && scaleFromWidth > 0) {
                        scale.x = scaleFromWidth;
                    }
                    if (Number.isFinite(scaleFromHeight) && scaleFromHeight > 0) {
                        scale.y = scaleFromHeight;
                    }
                }
            }
        }
    }

    const includeWalls = options.includeWalls ?? true;
    const includeDrawings = options.includeDrawings ?? true;
    const includeLights = options.lightOptions?.includeLights ?? true;
    let addedAnyItems = false;
    let addedAnyFogItems = false;

    if (includeWalls) {
        const walls = await createWallItems(processedData, position, scale, dpi);
        if (walls.length > 0) {
            await addItemsInBatches(walls, BATCH_SIZE);
            addedAnyFogItems = true;
            addedAnyItems = true;
        }

        if (processedData.portals && processedData.portals.length > 0) {
            const doors = await createDoorItems(processedData, position, scale, dpi);
            if (doors.length > 0) {
                await addItemsInBatches(doors, BATCH_SIZE);
                addedAnyFogItems = true;
                addedAnyItems = true;
            }
        }
    }

    if (includeLights && processedData.lights && processedData.lights.length > 0) {
        const lights = await createLightItems(processedData, position, scale, dpi, options.lightOptions);
        if (lights.length > 0) {
            await addItemsInBatches(lights, BATCH_SIZE);
            addedAnyFogItems = true;
            addedAnyItems = true;
        }
    }
    if (includeDrawings && processedData.drawings && processedData.drawings.length > 0) {
        const drawings = await createDrawingItems(processedData, position, scale, dpi);
        if (drawings.length > 0) {
            await addItemsInBatches(drawings, BATCH_SIZE);
            addedAnyItems = true;
        }
    }

    if (addedAnyItems) {
        if (addedAnyFogItems) {
            await OBR.scene.fog.setFilled(true);
        }
        await OBR.notification.show("Import complete!", "SUCCESS");
        return;
    }

    const noDataMessage = includeWalls && includeLights && includeDrawings
        ? "No walls, doors, lights, or drawings were found for the selected import options."
        : includeWalls && includeLights
            ? "No walls, doors, or lights were found for the selected import options."
            : includeWalls && includeDrawings
                ? "No walls, doors, or drawings were found for the selected import options."
                : includeLights && includeDrawings
                    ? "No lights or drawings were found for the selected import options."
                    : includeWalls
                        ? "No walls or doors were found for the selected import options."
                        : includeLights
                            ? "No lights were found for the selected import options."
                            : "No drawings were found for the selected import options.";
    await OBR.notification.show(noDataMessage, "INFO");
}

export async function addItemsFromVTT(
    file: File,
    context: boolean,
    options: {
        includeWalls?: boolean;
        includeDrawings?: boolean;
        lightOptions?: LightImportOptions;
    } = {}
): Promise<void> {
    const text = await readFileAsText(file);
    const fileData = JSON.parse(text);

    let processedData: VTTMapData;

    try {
        if (isFoundryVTTData(fileData)) {
            processedData = convertFoundryToVTTData(fileData);
        } else if (isUniversalVTTData(fileData)) {
            const { image, ...vttData } = fileData;
            void image;
            processedData = vttData as VTTMapData;
        } else {
            throw new Error("Unsupported file format. Please use a valid UVTT, DD2VTT, or FoundryVTT JSON file.");
        }
    } catch (error) {
        console.error("Error processing file:", error);
        throw new Error("Failed to process the file. Make sure it's a valid UVTT, DD2VTT, or FoundryVTT JSON file.");
    }

    await addItemsFromData(processedData, context, options);
}

// Helper function to read file as text
function readFileAsText(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsText(file);
    });
}

export async function extractImageFromZip(zip: JSZip, imgPath: string): Promise<Blob> {
    if (!imgPath) {
        throw new Error('Image path is empty.');
    }

    const normalizePath = (rawPath: string): string => {
        let normalized = rawPath.trim();

        try {
            normalized = decodeURIComponent(normalized);
        } catch {
            // Keep original path if URI decoding fails
        }

        if (/^[a-z][a-z0-9+.-]*:\/\//i.test(normalized)) {
            try {
                normalized = new URL(normalized).pathname;
            } catch {
                // Keep original path if URL parsing fails
            }
        }

        normalized = normalized
            .split(/[?#]/, 1)[0] ?? normalized;
        normalized = normalized
            .replace(/\\/g, '/')
            .replace(/\/{2,}/g, '/')
            .replace(/^\.\//, '')
            .replace(/^\/+/, '');

        return normalized;
    };

    const stripPackageScopePrefix = (path: string): string | null => {
        const parts = path.split('/').filter(Boolean);
        if (parts.length < 3) return null;
        const scope = parts[0].toLowerCase();
        if (scope !== 'modules' && scope !== 'systems' && scope !== 'worlds') return null;
        return parts.slice(2).join('/');
    };

    const trailingSegmentScore = (targetPath: string, candidatePath: string): number => {
        const targetParts = targetPath.toLowerCase().split('/').filter(Boolean);
        const candidateParts = candidatePath.toLowerCase().split('/').filter(Boolean);
        let matched = 0;
        while (
            matched < targetParts.length &&
            matched < candidateParts.length &&
            targetParts[targetParts.length - 1 - matched] === candidateParts[candidateParts.length - 1 - matched]
        ) {
            matched++;
        }
        return matched;
    };

    const normalizedRequestedPath = normalizePath(imgPath);
    const allFiles = Object.keys(zip.files).filter((path) => !zip.files[path].dir);
    const pathByLower = new Map<string, string>();
    for (const path of allFiles) {
        pathByLower.set(path.toLowerCase(), path);
    }

    const topLevelFolders = new Set(
        allFiles
            .filter((path) => path.includes('/'))
            .map((path) => path.split('/')[0])
    );

    const candidatePaths = new Set<string>();
    const addCandidate = (candidate: string | null | undefined) => {
        if (!candidate) return;
        const normalized = normalizePath(candidate);
        if (!normalized) return;
        candidatePaths.add(normalized);
    };

    addCandidate(normalizedRequestedPath);
    addCandidate(stripPackageScopePrefix(normalizedRequestedPath));

    const baseCandidates = Array.from(candidatePaths);
    for (const folder of topLevelFolders) {
        for (const candidate of baseCandidates) {
            addCandidate(`${folder}/${candidate}`);
            if (candidate.toLowerCase().startsWith(`${folder.toLowerCase()}/`)) {
                addCandidate(candidate.slice(folder.length + 1));
            }
        }
    }

    let resolvedPath = normalizedRequestedPath;
    let file: JSZip.JSZipObject | null = null;

    for (const candidate of candidatePaths) {
        const direct = zip.file(candidate);
        if (direct) {
            resolvedPath = candidate;
            file = direct;
            break;
        }
        const caseInsensitive = pathByLower.get(candidate.toLowerCase());
        if (caseInsensitive) {
            resolvedPath = caseInsensitive;
            file = zip.file(caseInsensitive);
            break;
        }
    }

    if (!file) {
        const suffixMatches = new Set<string>();
        for (const candidate of candidatePaths) {
            const lowerCandidate = candidate.toLowerCase();
            for (const actualPath of allFiles) {
                const lowerActualPath = actualPath.toLowerCase();
                if (
                    lowerActualPath === lowerCandidate ||
                    lowerActualPath.endsWith(`/${lowerCandidate}`)
                ) {
                    suffixMatches.add(actualPath);
                }
            }
        }

        if (suffixMatches.size === 1) {
            resolvedPath = Array.from(suffixMatches)[0];
            file = zip.file(resolvedPath);
        } else if (suffixMatches.size > 1) {
            const ranked = Array.from(suffixMatches).sort((a, b) => {
                const scoreA = trailingSegmentScore(normalizedRequestedPath, a);
                const scoreB = trailingSegmentScore(normalizedRequestedPath, b);
                if (scoreA !== scoreB) return scoreB - scoreA;
                const depthA = a.split('/').length;
                const depthB = b.split('/').length;
                return depthA - depthB;
            });
            resolvedPath = ranked[0];
            file = zip.file(resolvedPath);
        }
    }

    if (!file) {
        // Very aggressive fallback: if path contains '/', try just the filename,
        // but only if this yields exactly one candidate to avoid wrong matches.
        if (normalizedRequestedPath.includes('/')) {
            const fileName = normalizedRequestedPath.split('/').pop()!.toLowerCase();
            const basenameMatches = allFiles.filter((path) => {
                const lower = path.toLowerCase();
                return lower === fileName || lower.endsWith(`/${fileName}`);
            });

            if (basenameMatches.length === 1) {
                resolvedPath = basenameMatches[0];
                file = zip.file(resolvedPath);
            } else if (basenameMatches.length > 1) {
                console.warn(
                    `Ambiguous filename fallback for ${normalizedRequestedPath}; found ${basenameMatches.length} candidates. Skipping basename fallback.`
                );
            }
        }
    }

    if (!file) {
        throw new Error(`Image not found in ZIP: ${normalizedRequestedPath}`);
    }

    const arrayBuffer = await file.async('arraybuffer');

    let type = 'image/png';
    const lowerPath = resolvedPath.toLowerCase();
    if (lowerPath.endsWith('.jpg') || lowerPath.endsWith('.jpeg')) {
        type = 'image/jpeg';
    } else if (lowerPath.endsWith('.webp')) {
        type = 'image/webp';
    } else if (lowerPath.endsWith('.webm')) {
        type = 'video/webm';
    } else if (lowerPath.endsWith('.mp4')) {
        type = 'video/mp4';
    }

    return new Blob([arrayBuffer], { type });
}
