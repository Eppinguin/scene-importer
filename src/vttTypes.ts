import type { Vector2 } from "@owlbear-rodeo/sdk";

export interface VTTMapData {
    line_of_sight: Vector2[][];
    objects_line_of_sight: Vector2[][];
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
}

export interface FoundryVTTWall {
    c: number[];  // coordinates [x1, y1, x2, y2]
    move?: number;
    sense?: number;
    door: number; // 0 for normal wall, 1 for door
    ds?: number;
    sound?: number;
}

export interface FoundryVTTData {
    name: string;
    width: number;
    height: number;
    grid: number;
    gridDistance?: number;
    gridUnits?: string;
    padding?: number;
    shiftX?: number;
    shiftY?: number;
    background?: {
        offsetX?: number;
        offsetY?: number;
    };
    walls: FoundryVTTWall[];
}

export interface UniversalVTT extends VTTMapData {
    format: number;
    environment?: {
        baked_lighting: boolean;
        ambient_light: string;
    };
    lights?: {
        position: Vector2;
        range: number;
        intensity: number;
        color: string;
        shadows: boolean;
    }[];
    image?: string;
}
