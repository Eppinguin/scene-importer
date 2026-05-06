import {
    buildPath,
    buildShape,
    buildText,
    type PathCommand,
    type Item,
    type Path,
    type Vector2,
    Command,
} from "@owlbear-rodeo/sdk";
import type { VTTDrawing, VTTMapData } from "./vttTypes";

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

function clampOpacity(value: number | undefined, fallback: number): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return fallback;
    }
    return Math.max(0, Math.min(1, value));
}

function toDrawingPixelPoint(
    drawingX: number,
    drawingY: number,
    dpi: number,
    scale: Vector2
): Vector2 {
    return {
        x: drawingX * dpi * scale.x,
        y: drawingY * dpi * scale.y
    };
}

function rotateLocalPoint(point: Vector2, degrees: number): Vector2 {
    const normalized = ((degrees % 360) + 360) % 360;
    if (normalized === 0) return point;
    const radians = (normalized * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    return {
        x: point.x * cos - point.y * sin,
        y: point.x * sin + point.y * cos,
    };
}

function compensateForCenterAnchoredRotation(
    basePosition: Vector2,
    localCenter: Vector2,
    rotation: number
): Vector2 {
    if (!Number.isFinite(rotation) || rotation === 0) {
        return basePosition;
    }
    const rotatedCenter = rotateLocalPoint(localCenter, rotation);
    return {
        x: basePosition.x + localCenter.x - rotatedCenter.x,
        y: basePosition.y + localCenter.y - rotatedCenter.y,
    };
}

function getPathCommandBounds(commands: PathCommand[]): {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
} | null {
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;

    for (const command of commands) {
        for (let i = 1; i + 1 < command.length; i += 2) {
            const x = command[i];
            const y = command[i + 1];
            if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
        }
    }

    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
        return null;
    }

    return { minX, minY, maxX, maxY };
}

function estimateTextBounds(
    text: string,
    fontSize: number,
    fontFamily: string
): { width: number; height: number } {
    const normalizedText = text.trim();
    const safeFontSize = Number.isFinite(fontSize) && fontSize > 0 ? fontSize : 16;
    if (!normalizedText) {
        return { width: 0, height: safeFontSize * 1.2 };
    }

    try {
        if (typeof document !== "undefined") {
            const canvas = document.createElement("canvas");
            const context = canvas.getContext("2d");
            if (context) {
                context.font = `${safeFontSize}px ${fontFamily || "Signika"}`;
                const metrics = context.measureText(normalizedText);
                const measuredWidth = Number.isFinite(metrics.width) ? metrics.width : 0;
                return {
                    width: measuredWidth,
                    height: safeFontSize * 1.2
                };
            }
        }
    } catch {
        // Fall back to heuristic dimensions.
    }

    return {
        width: normalizedText.length * safeFontSize * 0.6,
        height: safeFontSize * 1.2
    };
}

function ellipsePathCommands(x: number, y: number, width: number, height: number): PathCommand[] {
    const halfWidth = width / 2;
    const halfHeight = height / 2;
    const centerX = x + halfWidth;
    const centerY = y + halfHeight;
    const kappa = 0.552284749831;
    const cpX = halfWidth * kappa;
    const cpY = halfHeight * kappa;

    return [
        [Command.MOVE, centerX + halfWidth, centerY],
        [Command.CUBIC, centerX + halfWidth, centerY + cpY, centerX + cpX, centerY + halfHeight, centerX, centerY + halfHeight],
        [Command.CUBIC, centerX - cpX, centerY + halfHeight, centerX - halfWidth, centerY + cpY, centerX - halfWidth, centerY],
        [Command.CUBIC, centerX - halfWidth, centerY - cpY, centerX - cpX, centerY - halfHeight, centerX, centerY - halfHeight],
        [Command.CUBIC, centerX + cpX, centerY - halfHeight, centerX + halfWidth, centerY - cpY, centerX + halfWidth, centerY],
        [Command.CLOSE]
    ];
}

function polygonPathCommands(points: Vector2[], closePath: boolean): PathCommand[] {
    if (points.length === 0) return [];
    const commands: PathCommand[] = [[Command.MOVE, points[0].x, points[0].y]];
    for (let i = 1; i < points.length; i++) {
        commands.push([Command.LINE, points[i].x, points[i].y]);
    }
    if (closePath) {
        commands.push([Command.CLOSE]);
    }
    return commands;
}

function pointsAreNear(a: Vector2, b: Vector2, epsilon = 0.001): boolean {
    return Math.abs(a.x - b.x) <= epsilon && Math.abs(a.y - b.y) <= epsilon;
}

function freehandPathCommands(points: Vector2[], factor: number): PathCommand[] {
    if (points.length < 2) return [];
    const clampedFactor = Math.max(0, Math.min(1, factor));
    const commands: PathCommand[] = [[Command.MOVE, points[0].x, points[0].y]];
    if (clampedFactor <= 0 || points.length < 3) {
        for (let i = 1; i < points.length; i++) {
            commands.push([Command.LINE, points[i].x, points[i].y]);
        }
        return commands;
    }

    // Mirror Foundry's approach: smooth freehand polylines with cubic Bezier segments.
    for (let i = 0; i < points.length - 1; i++) {
        const previous = i === 0 ? points[i] : points[i - 1];
        const current = points[i];
        const next = points[i + 1];
        const afterNext = i + 2 < points.length ? points[i + 2] : next;

        const cp1: Vector2 = {
            x: current.x + ((next.x - previous.x) / 6) * clampedFactor,
            y: current.y + ((next.y - previous.y) / 6) * clampedFactor,
        };
        const cp2: Vector2 = {
            x: next.x - ((afterNext.x - current.x) / 6) * clampedFactor,
            y: next.y - ((afterNext.y - current.y) / 6) * clampedFactor,
        };

        commands.push([Command.CUBIC, cp1.x, cp1.y, cp2.x, cp2.y, next.x, next.y]);
    }
    return commands;
}

function buildDrawingGeometryCommands(
    drawing: VTTDrawing,
    dpi: number,
    scale: Vector2
): PathCommand[] {
    const radius = drawing.radius ?? 0;
    const widthGridUnits = drawing.width ?? (drawing.type === "ELLIPSE" && Number.isFinite(radius) ? radius * 2 : 0);
    const heightGridUnits = drawing.height ?? (drawing.type === "ELLIPSE" && Number.isFinite(radius) ? radius * 2 : 0);
    const width = widthGridUnits * dpi * scale.x;
    const height = heightGridUnits * dpi * scale.y;

    switch (drawing.type) {
        case "RECTANGLE": {
            if (!Number.isFinite(width) || !Number.isFinite(height)) return [];
            return [
                [Command.MOVE, 0, 0],
                [Command.LINE, width, 0],
                [Command.LINE, width, height],
                [Command.LINE, 0, height],
                [Command.CLOSE]
            ];
        }
        case "ELLIPSE": {
            if (!Number.isFinite(width) || !Number.isFinite(height)) return [];
            return ellipsePathCommands(0, 0, width, height);
        }
        case "POLYGON":
        case "FREEHAND": {
            const points = Array.isArray(drawing.points) ? drawing.points : [];
            if (points.length < 4) return [];
            const vectorPoints: Vector2[] = [];
            for (let i = 0; i + 1 < points.length; i += 2) {
                const px = points[i];
                const py = points[i + 1];
                if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
                vectorPoints.push({
                    x: px * dpi * scale.x,
                    y: py * dpi * scale.y
                });
            }
            if (
                drawing.type === "FREEHAND"
                && clampOpacity(drawing.fillOpacity, 0) <= 0
                && vectorPoints.length >= 2
                && pointsAreNear(vectorPoints[0], vectorPoints[vectorPoints.length - 1])
            ) {
                // Foundry freehand exports may repeat the first point at the end.
                // Remove the duplicate endpoint so the stroke stays open in OBR.
                vectorPoints.pop();
            }
            if (vectorPoints.length < 2) return [];
            if (drawing.type === "FREEHAND") {
                const bezierFactor = Number.isFinite(drawing.bezierFactor) ? drawing.bezierFactor ?? 0 : 0;
                return freehandPathCommands(vectorPoints, bezierFactor);
            }
            return polygonPathCommands(vectorPoints, true);
        }
        case "TEXT": {
            if (!Number.isFinite(width) || !Number.isFinite(height) || width === 0 || height === 0) return [];
            return [
                [Command.MOVE, 0, 0],
                [Command.LINE, width, 0],
                [Command.LINE, width, height],
                [Command.LINE, 0, height],
                [Command.CLOSE]
            ];
        }
        default:
            return [];
    }
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

export async function createDrawingItems(
    data: VTTMapData,
    position: Vector2 = { x: 0, y: 0 },
    scale: Vector2 = { x: 1, y: 1 },
    dpi: number
): Promise<Item[]> {
    const drawings = Array.isArray(data.drawings) ? data.drawings : [];
    if (drawings.length === 0) {
        return [];
    }

    const items: Item[] = [];
    const strokeScale = Math.max(
        0.001,
        (Math.abs(scale.x || 1) + Math.abs(scale.y || 1)) / 2
    );

    for (const drawing of drawings) {
        const drawingText = typeof drawing.text === "string" ? drawing.text : "";
        const hasText = drawingText.trim().length > 0;
        const drawingRotation = Number.isFinite(drawing.rotation) ? drawing.rotation ?? 0 : 0;
        const isTextualDrawing = drawing.type === "TEXT" || hasText;
        const fillOpacity = clampOpacity(drawing.fillOpacity, 0);
        const strokeOpacity = clampOpacity(drawing.strokeOpacity, 1);
        const strokeWidth = Math.max(0, (drawing.strokeWidth ?? 0) * dpi * strokeScale);
        const hasTextDecoration = isTextualDrawing
            ? (drawing.textHasShapeDecoration ?? (fillOpacity > 0 || (strokeOpacity > 0 && strokeWidth > 0)))
            : false;
        const commands = buildDrawingGeometryCommands(drawing, dpi, scale);
        const hasVisibleGeometry = commands.length > 0 && (fillOpacity > 0 || (strokeOpacity > 0 && strokeWidth > 0));

        if (hasVisibleGeometry && (!isTextualDrawing || hasTextDecoration)) {
            const drawingPosition = toDrawingPixelPoint(drawing.x, drawing.y, dpi, scale);
            const baseShapePosition = {
                x: position.x + drawingPosition.x,
                y: position.y + drawingPosition.y
            };
            const bounds = getPathCommandBounds(commands);
            const shapeCenter = bounds
                ? { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 }
                : { x: 0, y: 0 };
            const shapePosition = compensateForCenterAnchoredRotation(
                baseShapePosition,
                shapeCenter,
                drawingRotation
            );
            const shapeItem = buildPath()
                .position(shapePosition)
                .commands(commands)
                .fillRule("nonzero")
                .fillColor(normalizeHexColor(drawing.fillColor))
                .fillOpacity(fillOpacity)
                .strokeColor(normalizeHexColor(drawing.strokeColor))
                .strokeOpacity(strokeOpacity)
                .strokeWidth(strokeWidth)
                .layer("DRAWING")
                .name("Drawing")
                .visible(drawing.hidden !== true)
                .locked(drawing.locked === true)
                .rotation(drawingRotation);

            const zIndex = drawing.zIndex;
            if (typeof zIndex === "number" && Number.isFinite(zIndex)) {
                shapeItem.zIndex(zIndex);
            }

            items.push(shapeItem.build());
        }

        if (hasText) {
            const textPosition = toDrawingPixelPoint(drawing.x, drawing.y, dpi, scale);
            const width = (drawing.width ?? 0) * dpi * Math.abs(scale.x || 1);
            const height = (drawing.height ?? 0) * dpi * Math.abs(scale.y || 1);
            const fontSize = Math.max(1, (drawing.fontSize ?? 0.24) * dpi * strokeScale);
            const fontFamily = drawing.fontFamily ?? "Signika";
            const estimatedBounds = estimateTextBounds(drawingText, fontSize, fontFamily);
            const resolvedWidth =
                Number.isFinite(width) && width > 0 ? width : estimatedBounds.width;
            const resolvedHeight =
                Number.isFinite(height) && height > 0 ? height : estimatedBounds.height;
            const baseTextPosition = {
                x: position.x + textPosition.x,
                y: position.y + textPosition.y
            };
            const textCenter = {
                x: resolvedWidth > 0 ? resolvedWidth / 2 : 0,
                y: resolvedHeight > 0 ? resolvedHeight / 2 : 0
            };
            const rotatedTextPosition = compensateForCenterAnchoredRotation(
                baseTextPosition,
                textCenter,
                drawingRotation
            );

            const textBuilder = buildText()
                .position(rotatedTextPosition)
                .plainText(drawingText)
                .textType("PLAIN")
                .fontFamily(fontFamily)
                .fontSize(fontSize)
                .fillColor(normalizeHexColor(drawing.textColor))
                .fillOpacity(clampOpacity(drawing.textOpacity, 1))
                .strokeColor("#000000")
                .strokeOpacity(0)
                .strokeWidth(0)
                .lineHeight(1.2)
                .textAlign("CENTER")
                .textAlignVertical("MIDDLE")
                .layer("TEXT")
                .name("Drawing Text")
                .visible(drawing.hidden !== true)
                .locked(drawing.locked === true)
                .rotation(drawingRotation);

            if (Number.isFinite(resolvedWidth) && resolvedWidth > 0) {
                textBuilder.width(resolvedWidth);
            }
            if (Number.isFinite(resolvedHeight) && resolvedHeight > 0) {
                textBuilder.height(resolvedHeight);
            }
            const zIndex = drawing.zIndex;
            if (typeof zIndex === "number" && Number.isFinite(zIndex)) {
                textBuilder.zIndex(zIndex + 1);
            }

            items.push(textBuilder.build());
        }
    }


    return items;
}
