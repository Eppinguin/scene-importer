import type { Vector2 } from "@owlbear-rodeo/sdk";

export interface VTTLight {
    position: Vector2;
    range: number;
    color: string;
    angle?: number;
    rotation?: number;
    hidden?: boolean;
    vision?: boolean;
}

export type VTTDrawingType = "RECTANGLE" | "ELLIPSE" | "POLYGON" | "FREEHAND" | "TEXT";

export interface VTTDrawing {
    id?: string;
    type: VTTDrawingType;
    x: number;
    y: number;
    width?: number;
    height?: number;
    radius?: number;
    points?: number[];
    rotation?: number;
    hidden?: boolean;
    locked?: boolean;
    zIndex?: number;
    fillColor?: string;
    fillOpacity?: number;
    strokeColor?: string;
    strokeOpacity?: number;
    strokeWidth?: number;
    text?: string;
    textColor?: string;
    textOpacity?: number;
    fontFamily?: string;
    fontSize?: number;
    textHasShapeDecoration?: boolean;
    bezierFactor?: number;
}

export interface VTTMapData {
    line_of_sight: Vector2[][];
    objects_line_of_sight: Vector2[][];
    lights?: VTTLight[];
    drawings?: VTTDrawing[];
    portals?: {
        position: { x: number; y: number };
        bounds: Vector2[];
        rotation: number;
        closed: boolean;
        freestanding: boolean;
    }[];
    resolution: {
        map_origin: { x: number; y: number };
        map_size: { x: number; y: number };
        pixels_per_grid: number;
    };
    gridScale?: string;
}

export interface FoundryVTTWall {
    _id?: string;
    c: number[];  // coordinates [x1, y1, x2, y2]
    move?: number;
    sense?: number;
    door: number; // 0 for normal wall, 1 for door
    ds?: number;
    sound?: number;
    flags?: Record<string, unknown>;
}

export interface FoundryVTTLight {
    _id?: string;
    x: number;
    y: number;
    hidden?: boolean;
    vision?: boolean;
    rotation?: number;
    walls?: boolean;
    tintColor?: string;
    tintAlpha?: number;
    config?: {
        dim?: number;
        bright?: number;
        rotation?: number;
        angle?: number;
        color?: string;
        tintColor?: string;
        tintAlpha?: number;
        luminosity?: number;
        attenuation?: number;
        walls?: boolean;
        vision?: boolean;
    };
    dim?: number;
    bright?: number;
    angle?: number;
    color?: string;
    luminosity?: number;
    attenuation?: number;
    flags?: Record<string, unknown>;
}

export interface FoundryVTTTile {
    _id?: string;
    name?: string;
    img?: string;
    texture?: {
        src?: string;
        scaleX?: number;
        scaleY?: number;
        offsetX?: number;
        offsetY?: number;
        rotation?: number;
        anchorX?: number;
        anchorY?: number;
    };
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    rotation?: number;
    hidden?: boolean;
    alpha?: number;
    elevation?: number;
    z?: number;
    sort?: number;
    flags?: Record<string, unknown>;
}

export interface FoundryShapeData {
    type?: string;
    width?: number;
    height?: number;
    radius?: number;
    points?: number[] | Array<number[]>;
}

export interface FoundryVTTDrawing {
    _id?: string | null;
    type?: string;
    t?: string;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    points?: number[] | Array<number[]>;
    shape?: FoundryShapeData;
    rotation?: number;
    elevation?: number;
    sort?: number;
    z?: number;
    hidden?: boolean;
    locked?: boolean;
    fillType?: number;
    fillColor?: string | number;
    fillAlpha?: number;
    strokeWidth?: number;
    strokeColor?: string | number;
    strokeAlpha?: number;
    text?: string;
    textColor?: string | number;
    textAlpha?: number;
    fontFamily?: string;
    fontSize?: number;
    bezierFactor?: number;
    texture?: string;
    interface?: boolean;
    flags?: Record<string, unknown>;
}

export interface FoundryVTTData {
    _id?: string;
    name: string;
    width: number;
    height: number;
    grid: number | { size: number; distance?: number; units?: string;[key: string]: unknown };
    gridDistance?: number;
    gridUnits?: string;
    padding?: number;
    shiftX?: number;
    shiftY?: number;
    img?: string;
    background?: {
        offsetX?: number;
        offsetY?: number;
        src?: string;
        scaleX?: number;
        scaleY?: number;
        rotation?: number;
        anchorX?: number;
        anchorY?: number;
    };
    tiles?: Array<FoundryVTTTile | string>;
    walls?: FoundryVTTWall[];
    lights?: FoundryVTTLight[];
    drawings?: Array<FoundryVTTDrawing | string>;
}

export interface UniversalVTT extends VTTMapData {
    format: number;
    environment?: {
        baked_lighting: boolean;
        ambient_light: string;
    };
    lights?: VTTLight[];
    image?: string;
}
