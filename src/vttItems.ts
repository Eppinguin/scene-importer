import {
    buildPath,
    buildShape,
    type PathCommand,
    type Item,
    type Path,
    type Vector2,
    Command,
} from "@owlbear-rodeo/sdk";
import type { VTTMapData } from "./vttTypes";

const DYNAMIC_FOG_LIGHT_KEY = "rodeo.owlbear.dynamic-fog/light";
const CHROMODYNAMIC_LIGHT_KEY = "com.desain.chromodynamic/light";

export interface LightImportOptions {
    includeLights?: boolean;
    sourceRadius?: number;
    falloff?: number;
    lightType?: "AUTO" | "PRIMARY" | "SECONDARY" | "AUXILIARY";
}

type DynamicFogLightType = "PRIMARY" | "SECONDARY" | "AUXILIARY";

function resolveLightType(
    configuredType: LightImportOptions["lightType"],
    vision: boolean | undefined
): DynamicFogLightType {
    if (configuredType && configuredType !== "AUTO") {
        return configuredType;
    }
    if (typeof vision === "boolean") {
        return vision ? "PRIMARY" : "SECONDARY";
    }
    return "SECONDARY";
}

function normalizeHexColor(color: string | undefined): string {
    const value = (color ?? "").trim();
    const match = value.match(/^#?([A-Fa-f0-9]{3}|[A-Fa-f0-9]{6}|[A-Fa-f0-9]{8})$/);
    if (!match) {
        return "#000000";
    }

    let hex = match[1];
    if (hex.length === 3) {
        hex = hex.split("").map((channel) => channel + channel).join("");
    } else if (hex.length === 8) {
        hex = hex.slice(0, 6);
    }

    return `#${hex.toUpperCase()}`;
}

// Create wall items for the scene
export async function createWallItems(data: VTTMapData, position: Vector2 = { x: 0, y: 0 }, scale: Vector2 = { x: 1, y: 1 }, dpi: number): Promise<Item[]> {
    const walls = [...(data.line_of_sight || [])];
    if (data.objects_line_of_sight) {
        walls.push(...data.objects_line_of_sight);
    }

    if (walls.length === 0) {
        console.warn("No wall data found in the file");
        return [];
    }
    // const dpi = await OBR.scene.grid.getDpi();

    const wallItems = [];

    for (const wall of walls) {
        if (wall.length < 2) continue;

        // Scale the wall points based on DPI and map scale
        const points = wall.map(point => ({
            x: point.x * dpi * scale.x,
            y: point.y * dpi * scale.y
        }));

        // Create the wall item using buildPath
        const commands: PathCommand[] = [
            [Command.MOVE, points[0].x, points[0].y],
            ...points.slice(1).map(p => [Command.LINE, p.x, p.y] as PathCommand)
        ];

        const wallItem = buildPath()
            .position(position)
            .strokeColor("#000000")
            .fillOpacity(0)
            .strokeOpacity(1)
            .strokeWidth(2)
            .commands(commands)
            .layer("FOG")
            .name("Wall")
            .visible(true)
            .build();

        wallItems.push(wallItem);
    }

    return wallItems;
}

// Create invisible drawing hosts that carry dynamic-fog light metadata
export async function createLightItems(
    data: VTTMapData,
    position: Vector2 = { x: 0, y: 0 },
    scale: Vector2 = { x: 1, y: 1 },
    dpi: number,
    options: LightImportOptions = {}
): Promise<Item[]> {
    const lights = Array.isArray(data.lights) ? data.lights : [];
    if (lights.length === 0 || options.includeLights === false) {
        return [];
    }

    const lightItems: Item[] = [];
    const lightScale = Number.isFinite(scale.x) && scale.x !== 0
        ? Math.abs(scale.x)
        : (Number.isFinite(scale.y) && scale.y !== 0 ? Math.abs(scale.y) : 1);
    const sourceRadiusOption = Number(options.sourceRadius);
    const configuredSourceRadius = Number.isFinite(sourceRadiusOption) && sourceRadiusOption >= 0
        ? sourceRadiusOption
        : 0;
    const falloffOption = Number(options.falloff);
    const configuredFalloff = Number.isFinite(falloffOption) && falloffOption >= 0
        ? falloffOption
        : 0.2;
    const configuredLightType = options.lightType ?? "AUTO";

    for (const light of lights) {
        const sourceRange = Number(light.range);
        if (!Number.isFinite(sourceRange) || sourceRange <= 0) continue;

        const attenuationRadius = sourceRange * dpi * lightScale;
        if (!Number.isFinite(attenuationRadius) || attenuationRadius <= 0) continue;

        const sourceRadius = configuredSourceRadius;
        const falloff = configuredFalloff;
        const color = normalizeHexColor(light.color);
        const hostDiameter = Math.max(12, Math.min(48, attenuationRadius * 0.08));
        const rawAngle = Number(light.angle ?? 360);
        const clampedAngle = Number.isFinite(rawAngle) ? Math.min(360, Math.max(0, rawAngle)) : 360;
        const hasLimitedAngle = clampedAngle > 0 && clampedAngle < 360;
        const innerAngle = hasLimitedAngle ? clampedAngle : 360;
        const outerAngle = hasLimitedAngle ? clampedAngle : 360;
        const rawRotation = Number(light.rotation ?? 0);
        const rotation = Number.isFinite(rawRotation)
            ? ((rawRotation % 360) + 360) % 360
            : 0;

        const lightMetadata = {
            attenuationRadius,
            sourceRadius,
            falloff,
            innerAngle,
            outerAngle,
            rotation,
            lightType: resolveLightType(configuredLightType, light.vision)
        };
        const chromodynamicMetadata = {
            ...lightMetadata,
            color
        };

        const hostItem = buildShape()
            .position({
                x: position.x + light.position.x * dpi * scale.x,
                y: position.y + light.position.y * dpi * scale.y
            })
            .shapeType("CIRCLE")
            .width(hostDiameter)
            .height(hostDiameter)
            .fillColor("#000000")
            .fillOpacity(0)
            .strokeColor("#000000")
            .strokeOpacity(0)
            .strokeWidth(0)
            .layer("MAP")
            .name("Light")
            .visible(light.hidden !== true)
            .locked(true)
            .disableHit(true)
            .metadata({
                [DYNAMIC_FOG_LIGHT_KEY]: lightMetadata,
                [CHROMODYNAMIC_LIGHT_KEY]: chromodynamicMetadata
            })
            .build();

        lightItems.push(hostItem);
    }

    return lightItems;
}

// Create door items for the scene
export async function createDoorItems(data: VTTMapData, position: Vector2 = { x: 0, y: 0 }, scale: Vector2 = { x: 1, y: 1 }, dpi: number): Promise<Path[]> {
    if (!data.portals || data.portals.length === 0) return [];

    const doorItems = [];
    // const dpi = await OBR.scene.grid.getDpi();

    for (const portal of data.portals) {
        if (portal.bounds.length < 2) continue;

        // Scale the portal points based on DPI and map scale
        const points = portal.bounds.map(point => ({
            x: point.x * dpi * scale.x,
            y: point.y * dpi * scale.y
        }));

        // Create the door as a path
        const doorCommands: PathCommand[] = [
            [Command.MOVE, points[0].x, points[0].y],
            [Command.LINE, points[points.length - 1].x, points[points.length - 1].y]
        ];

        const doorItem = buildPath()
            .name("Door")
            .fillRule("nonzero")
            .position(position)
            .style({
                fillColor: "black",
                fillOpacity: 0,
                strokeColor: "#FF0000",
                strokeOpacity: 1,
                strokeWidth: 5,
                strokeDash: []
            })
            .commands(doorCommands)
            .layer("FOG")
            .metadata({
                "rodeo.owlbear.dynamic-fog/doors": [{
                    open: !portal.closed,
                    start: {
                        distance: 0,
                        index: 0
                    },
                    end: {
                        distance: Math.sqrt(
                            Math.pow(points[points.length - 1].x - points[0].x, 2) +
                            Math.pow(points[points.length - 1].y - points[0].y, 2)
                        ),
                        index: 0
                    }
                }]
            })
            .build();

        doorItems.push(doorItem);
    }

    return doorItems;
}
