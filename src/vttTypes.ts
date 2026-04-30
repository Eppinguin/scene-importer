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

export interface VTTMapData {
    line_of_sight: Vector2[][];
    objects_line_of_sight: Vector2[][];
    lights?: VTTLight[];
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
    c: number[];  // coordinates [x1, y1, x2, y2]
    move?: number;
    sense?: number;
    door: number; // 0 for normal wall, 1 for door
    ds?: number;
    sound?: number;
}

export interface FoundryVTTLight {
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
}

export interface FoundryVTTData {
    name: string;
    width: number;
    height: number;
    grid: number | { size: number; distance?: number; units?: string;[key: string]: unknown };
    gridDistance?: number;
    gridUnits?: string;
    padding?: number;
    shiftX?: number;
    shiftY?: number;
    background?: {
        offsetX?: number;
        offsetY?: number;
        src?: string;
    };
    walls?: FoundryVTTWall[];
    lights?: FoundryVTTLight[];
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
