import OBR, {
    buildImageUpload,
    buildSceneUpload,
    type Item,
    type Vector2
} from "@owlbear-rodeo/sdk";
import { type VTTMapData, type UniversalVTT, type FoundryVTTData, type FoundryVTTWall } from "./vttTypes";
import { createWallItems, createDoorItems } from "./vttItems";

type VTTData = VTTMapData;

import JSZip from 'jszip';

export function isFoundryVTTData(data: unknown): data is FoundryVTTData {
    const d = data as Partial<FoundryVTTData>;
    const hasNumericGrid = typeof d.grid === 'number';
    const hasGridObject = typeof d.grid === 'object' && d.grid !== null && 'size' in d.grid;
    const hasValidWalls = d.walls === undefined || (
        Array.isArray(d.walls)
        && d.walls.every((w: Partial<FoundryVTTWall>) =>
            Array.isArray(w.c) && w.c.length === 4)
    );
    return !!d
        && typeof d.width === 'number'
        && typeof d.height === 'number'
        && (hasNumericGrid || hasGridObject)
        && hasValidWalls;
}

export function isUniversalVTTData(data: unknown): data is UniversalVTT {
    const d = data as Partial<UniversalVTT>;
    return !!d
        && typeof d.format === 'number'
        && !!d.resolution
        && (Array.isArray(d.line_of_sight) || Array.isArray(d.objects_line_of_sight));
}

// Helper function to detect if VTT data contains an image
export function hasMapImage(data: unknown): boolean {
    return !!(data && typeof data === 'object' && 'image' in data && (data as { image?: string }).image);
}

export function convertFoundryToVTTData(foundryData: FoundryVTTData): VTTData {
    let padX = 0;
    let padY = 0;
    const sourceWalls = Array.isArray(foundryData.walls) ? foundryData.walls : [];

    // Resolve grid size handling for both Foundry V11 (numeric) and V12+ (object)
    const gridSize = typeof foundryData.grid === 'object' ? (foundryData.grid?.size || 100) : (Number(foundryData.grid) || 100);

    if (foundryData.padding !== undefined) {
        padX = Math.ceil((foundryData.width * foundryData.padding) / gridSize) * gridSize;
        padY = Math.ceil((foundryData.height * foundryData.padding) / gridSize) * gridSize;
    }
    const bgShiftX = foundryData.shiftX || (foundryData.background && foundryData.background.offsetX) || 0;
    const bgShiftY = foundryData.shiftY || (foundryData.background && foundryData.background.offsetY) || 0;

    const offsetX = padX + bgShiftX;
    const offsetY = padY + bgShiftY;

    const walls: Vector2[][] = sourceWalls
        .filter(wall => wall.door === 0) // Non-door walls
        .map(wall => [
            { x: (wall.c[0] - offsetX) / gridSize, y: (wall.c[1] - offsetY) / gridSize },
            { x: (wall.c[2] - offsetX) / gridSize, y: (wall.c[3] - offsetY) / gridSize }
        ]);

    const portals = sourceWalls
        .filter(wall => wall.door === 1) // Door walls
        .map(wall => ({
            position: { x: 0, y: 0 }, // Not actually used by OBR sdk in same way
            bounds: [
                { x: (wall.c[0] - offsetX) / gridSize, y: (wall.c[1] - offsetY) / gridSize },
                { x: (wall.c[2] - offsetX) / gridSize, y: (wall.c[3] - offsetY) / gridSize }
            ],
            rotation: 0,
            closed: wall.ds === 0, // Assuming ds=0 means closed, ds=1 means open
            freestanding: false
        }));

    return {
        resolution: {
            map_origin: { x: 0, y: 0 },
            map_size: { x: foundryData.width / gridSize, y: foundryData.height / gridSize },
            pixels_per_grid: gridSize
        },
        line_of_sight: walls,
        objects_line_of_sight: [],
        portals: portals
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
export type VideoCodecPreference = 'av1' | 'vp9' | 'h264';

interface OptimizationOptions {
    compressionMode?: CompressionMode;
    maxSizeInMB?: number;
    maxMegapixels?: number;
}

// Helper function to optimize image data
async function optimizeImage(imageBlob: Blob, options: OptimizationOptions = {}): Promise<Blob> {
    const {
        compressionMode = 'standard',
        maxSizeInMB = 24, // Default to slightly under 25MB for safety
        maxMegapixels = compressionMode === 'standard' ? 67 : 144
    } = options;

    // If no compression is requested and the image is under the maximum size, return it as is
    if (compressionMode === 'none' && imageBlob.size <= maxSizeInMB * 1024 * 1024) {
        return imageBlob;
    }

    return new Promise((resolve, reject) => {
        const img = new Image();
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');

        img.onload = () => {
            URL.revokeObjectURL(img.src);

            // Start with original dimensions
            let width = img.width;
            let height = img.height;

            // Check megapixels constraint
            const megapixels = (width * height) / (1024 * 1024);
            if (megapixels > maxMegapixels) {
                const scale = Math.sqrt(maxMegapixels / megapixels);
                width = Math.floor(width * scale);
                height = Math.floor(height * scale);
            }

            canvas.width = width;
            canvas.height = height;

            if (!ctx) {
                reject(new Error('Could not get canvas context'));
                return;
            }

            ctx.drawImage(img, 0, 0, width, height);

            // Set initial quality based on compression mode - start with highest possible quality
            const initialQuality = 1;

            // Try different quality settings until we get under maxSizeInMB
            const tryCompress = (currentQuality: number) => {
                // Always use WebP for better compression unless no compression is requested
                const mimeType = compressionMode === 'none' ? imageBlob.type : 'image/webp';

                canvas.toBlob((blob) => {
                    if (!blob) {
                        reject(new Error('Could not create blob'));
                        return;
                    }

                    const currentSize = blob.size / (1024 * 1024);
                    if (blob.size > maxSizeInMB * 1024 * 1024 && currentQuality > 0.1 && compressionMode !== 'none') {
                        // Try again with lower quality, use smaller steps for more precise control
                        tryCompress(currentQuality - 0.05);
                    } else {
                        const finalSize = currentSize.toFixed(2);
                        const quality = (currentQuality * 100).toFixed(0);
                        OBR.notification.show(`Image compressed: ${quality}% quality (${finalSize}MB)`, "INFO");
                        resolve(blob);
                    }
                }, mimeType, compressionMode === 'none' ? undefined : currentQuality);
            };

            tryCompress(initialQuality);
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
    canEncodeVideo?: (codec: 'avc' | 'vp9' | 'av1', config: {
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
                codec: 'avc' | 'vp9' | 'av1';
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

export interface VideoCompressionOptions {
    keepAudio?: boolean;
    maxDimension?: number;
    preferredCodec?: VideoCodecPreference;
    forceTranscodeUnderLimit?: boolean;
    abortSignal?: AbortSignal;
}

async function getVideoMetadata(fileBlob: Blob): Promise<VideoMeta> {
    return new Promise((resolve, reject) => {
        const video = document.createElement('video');
        video.preload = 'auto';
        video.muted = true;
        let settled = false;
        const finalize = () => {
            if (settled) return;
            settled = true;

            let frameRate = 30;
            try {
                const withCapture = video as HTMLVideoElement & {
                    captureStream?: () => MediaStream;
                    mozCaptureStream?: () => MediaStream;
                };
                const stream = withCapture.captureStream?.() ?? withCapture.mozCaptureStream?.();
                const track = stream?.getVideoTracks()[0];
                const candidate = track?.getSettings().frameRate;
                if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 1) {
                    frameRate = candidate;
                }
                stream?.getTracks().forEach((t) => t.stop());
            } catch {
                // Some browsers do not expose captureStream settings for local files.
            }

            resolve({
                duration: video.duration,
                width: video.videoWidth,
                height: video.videoHeight,
                frameRate,
            });
            URL.revokeObjectURL(video.src);
        };

        video.onloadeddata = finalize;
        video.onloadedmetadata = () => {
            if (video.readyState >= 2) {
                finalize();
            }
        };
        video.onerror = () => reject(new Error('Failed to load video metadata'));
        video.src = URL.createObjectURL(fileBlob);
    });
}

function getCodecEncodingDefaults(codec: VideoCodecPreference): {
    keyFrameIntervalSeconds: number;
    qualityFactor: number;
    minBitrate: number;
    maxBitrate: number;
} {
    if (codec === 'av1') {
        return {
            keyFrameIntervalSeconds: 2,
            qualityFactor: 0.036,
            minBitrate: 450_000,
            maxBitrate: 10_000_000,
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

function normalizeSourceCodec(codec: unknown): 'avc' | 'vp9' | 'av1' | 'other' {
    if (typeof codec !== 'string') {
        return 'other';
    }
    if (codec === 'avc' || codec.startsWith('avc') || codec.startsWith('h264')) {
        return 'avc';
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
    sourceCodec: 'avc' | 'vp9' | 'av1' | 'other',
    targetCodec: VideoCodecPreference,
    forceShrinkMode: boolean,
    preserveQualityMode: boolean
): { equivalentFactor: number; qualityFloorFactor: number } {
    const key = `${sourceCodec}->${targetCodec}`;
    const equivalentByPair: Record<string, number> = preserveQualityMode
        ? {
            'avc->vp9': 1.0,
            'avc->av1': 0.95,
            'avc->h264': 1.0,
            'vp9->av1': 0.96,
            'vp9->vp9': 1.0,
            'vp9->h264': 1.15,
            'av1->av1': 1.0,
            'av1->vp9': 1.2,
            'av1->h264': 1.35,
        }
        : {
            'avc->vp9': 0.9,
            'avc->av1': 0.82,
            'avc->h264': 1.0,
            'vp9->av1': 0.9,
            'vp9->vp9': 1.0,
            'vp9->h264': 1.15,
            'av1->av1': 1.0,
            'av1->vp9': 1.2,
            'av1->h264': 1.35,
        };

    const fallbackEquivalent = preserveQualityMode
        ? (targetCodec === 'h264' ? 1.08 : 1.0)
        : (targetCodec === 'av1'
            ? 0.9
            : targetCodec === 'vp9'
                ? 0.95
                : 1.05);

    const equivalentFactor = equivalentByPair[key] ?? fallbackEquivalent;
    const qualityFloorFactor = preserveQualityMode
        ? (targetCodec === 'av1' ? 0.92 : targetCodec === 'vp9' ? 0.97 : 1.0)
        : forceShrinkMode
            ? (targetCodec === 'av1' ? 0.72 : targetCodec === 'vp9' ? 0.8 : 0.92)
            : (targetCodec === 'av1' ? 0.84 : targetCodec === 'vp9' ? 0.9 : 0.98);

    return { equivalentFactor, qualityFloorFactor };
}

async function compressVideo(
    fileBlob: Blob,
    compressionMode: CompressionMode,
    onProgress?: (progress: number) => void,
    options: VideoCompressionOptions = {}
): Promise<VideoCompressionResult> {
    const throwIfAborted = () => {
        if (options.abortSignal?.aborted) {
            throw new Error('Video Compression Aborted');
        }
    };

    throwIfAborted();
    const { duration, width, height, frameRate } = await getVideoMetadata(fileBlob);
    const preferredCodec = options.preferredCodec ?? 'vp9';
    const targetSizeMB = compressionMode === 'high' ? 99 : 49;
    // Use decimal MB to match user-facing size limits (50MB / 100MB) more closely.
    const maxBytes = targetSizeMB * 1000 * 1000;
    const bitrateFromBudget = Math.max(450_000, Math.floor((targetSizeMB * 8 * 1000 * 1000) / Math.max(duration, 1)));

    let outWidth = width;
    let outHeight = height;
    if (options.maxDimension && options.maxDimension > 0 && (width > options.maxDimension || height > options.maxDimension)) {
        const scale = options.maxDimension / Math.max(width, height);
        outWidth = Math.max(2, Math.round(width * scale) & ~1);
        outHeight = Math.max(2, Math.round(height * scale) & ~1);
    }

    const sourceFrameRate = Number.isFinite(frameRate) && frameRate > 1 ? frameRate : 30;
    const outputFrameRate = Math.min(120, Math.max(24, Math.round(sourceFrameRate)));

    const needsResize = outWidth !== width || outHeight !== height;
    const audioTransformRequested = options.keepAudio === false;
    const codecTransformRequested = preferredCodec !== 'vp9';
    const transformRequested = needsResize || audioTransformRequested || codecTransformRequested;
    const preserveQualityUnderLimit = fileBlob.size <= maxBytes
        && !needsResize
        && !options.forceTranscodeUnderLimit;

    if (!transformRequested && fileBlob.size <= maxBytes && !options.forceTranscodeUnderLimit) {
        if (onProgress) onProgress(100);
        return {
            blob: fileBlob,
            sourceWidth: width,
            sourceHeight: height,
            outputWidth: width,
            outputHeight: height,
        };
    }

    const pixels = outWidth * outHeight;
    const codecDefaults = getCodecEncodingDefaults(preferredCodec);
    const sourcePixels = Math.max(1, width * height);
    const resizeFactor = pixels / sourcePixels;
    const frameRateFactor = outputFrameRate / Math.max(sourceFrameRate, 1);
    const sourceTotalBitrate = Math.max(250_000, Math.floor((fileBlob.size * 8) / Math.max(duration, 1)));
    const assumedAudioBitrate = options.keepAudio === false ? 0 : 128_000;

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

    let sourceCodec: 'avc' | 'vp9' | 'av1' | 'other' = 'other';
    let sourceVideoBitrate = 0;
    let sourceAudioBitrate = 0;

    try {
        const analysisInput = new Input({
            source: new BlobSource(fileBlob),
            formats: ALL_FORMATS,
        });

        const sourceVideoTrack = await analysisInput.getPrimaryVideoTrack?.();
        if (sourceVideoTrack) {
            sourceCodec = normalizeSourceCodec(sourceVideoTrack.codec);
            const videoStats = sourceVideoTrack.computePacketStats
                ? fileBlob.size <= 20_000_000
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
                ? fileBlob.size <= 20_000_000
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
        preferredCodec,
        !!options.forceTranscodeUnderLimit,
        preserveQualityUnderLimit
    );

    const sourceEquivalentBitrate = Math.floor(sourceVideoBitrate * equivalentFactor * resizeFactor * frameRateFactor);
    const qualityFloorBitrate = Math.floor(sourceVideoBitrate * qualityFloorFactor * resizeFactor * frameRateFactor);

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

    const transcodeOnce = async (bitrate: number): Promise<Blob> => {
        throwIfAborted();

        const codec = preferredCodec === 'h264' ? 'avc' : preferredCodec;
        const outputFormat = preferredCodec === 'h264'
            ? new Mp4OutputFormat()
            : new WebMOutputFormat();

        const accelerationModes: Array<'no-preference' | 'prefer-software' | 'prefer-hardware'> = [
            'no-preference',
            'prefer-software',
            'prefer-hardware',
        ];

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
                        keyFrameInterval: codecDefaults.keyFrameIntervalSeconds,
                        hardwareAcceleration,
                        forceTranscode: true,
                        ...(needsResize ? { width: outWidth, height: outHeight, fit: 'fill' as const } : {}),
                    },
                    audio: options.keepAudio === false ? { discard: true } : undefined,
                });
            } catch (error) {
                lastError = error instanceof Error ? error : new Error(String(error));
                continue;
            }

            if (!conversion.isValid) {
                lastError = new Error('Unable to initialize MediaBunny conversion for this video in the current browser.');
                continue;
            }

            conversion.onProgress = (progress: number) => {
                if (onProgress) {
                    onProgress(Math.min(99, Math.round(progress * 100)));
                }
            };

            const onAbort = () => {
                void conversion.cancel();
            };
            options.abortSignal?.addEventListener('abort', onAbort, { once: true });

            try {
                await conversion.execute();
            } catch (error) {
                if (options.abortSignal?.aborted) {
                    throw new Error('Video Compression Aborted');
                }
                lastError = error instanceof Error ? error : new Error(String(error));
                continue;
            } finally {
                options.abortSignal?.removeEventListener('abort', onAbort);
            }

            const outputBuffer = output.target.buffer as ArrayBuffer | null;
            if (!outputBuffer) {
                lastError = new Error('MediaBunny conversion produced no output data.');
                continue;
            }

            return new Blob([outputBuffer], {
                type: preferredCodec === 'h264' ? 'video/mp4' : 'video/webm',
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

        throw new Error(
            `This browser build cannot encode ${preferredCodec.toUpperCase()} at ${outWidth}x${outHeight}. ` +
            `Try a lower max video dimension, switch codec, or use a Chromium build with WebCodecs encoding enabled on Linux.` +
            availableCodecs +
            (lastError ? ` ${lastError.message}` : '')
        );
    };

    const bitrateScales = preferredCodec === 'av1'
        ? [1, 0.9, 0.8, 0.72, 0.64, 0.56, 0.5]
        : preferredCodec === 'h264'
            ? [1, 0.9, 0.82, 0.74, 0.66]
            : [1, 0.9, 0.82, 0.74, 0.66, 0.58, 0.5];

    let attemptedBitrate = Math.floor(seededBitrate * bitrateScales[0]);
    let output = await transcodeOnce(attemptedBitrate);
    for (let i = 1; i < bitrateScales.length; i++) {
        const aboveBudget = output.size > maxBytes;
        if (!aboveBudget) {
            break;
        }

        const currentSizeMb = (output.size / 1000 / 1000).toFixed(1);
        OBR.notification.show(
            `Output is still ${currentSizeMb}MB, running an additional compression pass.`,
            "INFO"
        );

        const minimumPassBitrate = codecDefaults.minBitrate;
        const candidateBitrate = Math.max(minimumPassBitrate, Math.floor(seededBitrate * bitrateScales[i]));
        if (candidateBitrate >= attemptedBitrate) {
            break;
        }

        attemptedBitrate = candidateBitrate;
        output = await transcodeOnce(candidateBitrate);
    }

    if (output.size > maxBytes) {
        const finalSize = (output.size / 1000 / 1000).toFixed(1);
        throw new Error(`Unable to compress video below ${targetSizeMB}MB (current: ${finalSize}MB). Try Standard mode, a lower max video dimension, or H.264.`);
    }

    if (
        output.size >= fileBlob.size
        && !transformRequested
        && fileBlob.size <= maxBytes
        && !options.forceTranscodeUnderLimit
    ) {
        output = fileBlob;
    }

    if (onProgress) onProgress(100);
    return {
        blob: output,
        sourceWidth: width,
        sourceHeight: height,
        outputWidth: outWidth,
        outputHeight: outHeight,
    };
}

export async function uploadSceneFromVTT(
    file: File,
    compressionMode: CompressionMode = 'standard',
    onProgress?: (progress: number) => void,
    videoOptions?: VideoCompressionOptions
): Promise<void> {
    void onProgress;
    void videoOptions;

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

    OBR.notification.show("Importing scene..", "INFO");

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

    // Configure optimization based on compression mode
    const optimizationOptions: OptimizationOptions = {
        compressionMode,
        maxSizeInMB: compressionMode === 'high' ? 49 : 24, // Using 49MB and 24MB to leave some safety margin
        maxMegapixels: compressionMode === 'standard' ? 67 : 144
    };

    // UVTT data embeds map images, not videos.
    const finalBlob = await optimizeImage(imageBlob, optimizationOptions);
    const fileExtension = compressionMode === 'none'
        ? (imageType === 'image/webp' ? 'webp' : 'png')
        : 'webp';
    const imageFile = new File([finalBlob], `map.${fileExtension}`, { type: finalBlob.type });

    // Create and upload just the map as a scene
    const imageUpload = buildImageUpload(imageFile)
        .dpi(data.resolution.pixels_per_grid)
        .name(file.name.replace(/\.[^/.]+$/, ""))
        .build();

    // Prepare items to add to the scene
    const vttMapDataSource = data as VTTMapData; // data is UniversalVTT which is compatible
    const defaultPosition: Vector2 = { x: 0, y: 0 };
    const defaultScale: Vector2 = { x: 1, y: 1 };

    const wallItems = await createWallItems(vttMapDataSource, defaultPosition, defaultScale, 150);
    let doorItems: Item[] = [];
    if (vttMapDataSource.portals && vttMapDataSource.portals.length > 0) {
        doorItems = await createDoorItems(vttMapDataSource, defaultPosition, defaultScale, 150);
    }
    const allItems = [...wallItems, ...doorItems];

    let sceneBuilder = buildSceneUpload()
        .name(file.name.replace(/\.[^/.]+$/, ""))
        .baseMap(imageUpload)
        .gridType("SQUARE");

    if (allItems.length > 0) {
        sceneBuilder = sceneBuilder.items(allItems).fogFilled(true);
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
    videoOptions?: VideoCompressionOptions
): Promise<void> {
    OBR.notification.show("Importing scene..", "INFO");
    const vttMapDataSource = convertFoundryToVTTData(foundryData);

    const optimizationOptions: OptimizationOptions = {
        compressionMode,
        maxSizeInMB: compressionMode === 'high' ? 49 : 24,
        maxMegapixels: compressionMode === 'standard' ? 67 : 144
    };

    const isVideo = imageBlob.type.startsWith('video/');
    let finalBlob: Blob = imageBlob;
    let fileExtension = isVideo ? (imageBlob.type.includes('mp4') ? 'mp4' : 'webm') : 'png';

    let effectiveDpi = vttMapDataSource.resolution.pixels_per_grid;

    if (isVideo) {
        const sizeInMb = imageBlob.size / (1024 * 1024);
        if (compressionMode !== 'none') {
            if (sizeInMb > 500) {
                throw new Error(`Video file is too large (${sizeInMb.toFixed(1)}MB). The maximum supported size for browser compression is 500MB.`);
            }
            const compressed = await compressVideo(imageBlob, compressionMode, onProgress, videoOptions);
            finalBlob = compressed.blob;
            if (compressed.outputWidth > 0 && compressed.sourceWidth > 0) {
                effectiveDpi = vttMapDataSource.resolution.pixels_per_grid * (compressed.outputWidth / compressed.sourceWidth);
            }
            fileExtension = finalBlob.type.includes('webm') ? 'webm' : 'mp4';
        }
    } else {
        finalBlob = await optimizeImage(imageBlob, optimizationOptions);
        fileExtension = compressionMode === 'none' ?
            (imageBlob.type === 'image/webp' ? 'webp' : 'png') :
            'webp';
    }
    const imageFile = new File([finalBlob], `map.${fileExtension}`, { type: finalBlob.type });

    const imageUpload = buildImageUpload(imageFile)
        .dpi(effectiveDpi)
        .name(name)
        .build();

    const defaultPosition: Vector2 = { x: 0, y: 0 };
    const defaultScale: Vector2 = { x: 1, y: 1 };

    const wallItems = await createWallItems(vttMapDataSource, defaultPosition, defaultScale, 150);
    let doorItems: Item[] = [];
    if (vttMapDataSource.portals && vttMapDataSource.portals.length > 0) {
        doorItems = await createDoorItems(vttMapDataSource, defaultPosition, defaultScale, 150);
    }
    const allItems = [...wallItems, ...doorItems];

    let sceneBuilder = buildSceneUpload()
        .name(name)
        .baseMap(imageUpload)
        .gridType("SQUARE");

    if (allItems.length > 0) {
        sceneBuilder = sceneBuilder.items(allItems).fogFilled(true);
    }

    const sceneToUpload = sceneBuilder.build();
    await OBR.assets.uploadScenes([sceneToUpload]);
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

export async function addItemsFromData(processedData: VTTMapData, context: boolean): Promise<void> {
    if (!await OBR.scene.isReady()) {
        console.error("Scene is not ready. Please wait until the scene is fully loaded.");
        return;
    }

    if (!processedData.resolution?.pixels_per_grid) {
        throw new Error("No valid grid resolution data found in the file");
    }

    let position = { x: 0, y: 0 };
    let scale = { x: 1, y: 1 };
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
            }
        }
    }

    const dpi = await OBR.scene.grid.getDpi();

    const walls = await createWallItems(processedData, position, scale, dpi);
    if (walls.length > 0) {
        await addItemsInBatches(walls, BATCH_SIZE);
    }

    if (processedData.portals && processedData.portals.length > 0) {
        const doors = await createDoorItems(processedData, position, scale, dpi);
        if (doors.length > 0) {
            await addItemsInBatches(doors, BATCH_SIZE);
        }
    }

    await OBR.scene.fog.setFilled(true);
    await OBR.notification.show("Import complete!", "SUCCESS");
}

export async function addItemsFromVTT(file: File, context: boolean): Promise<void> {
    const text = await readFileAsText(file);
    const fileData = JSON.parse(text);

    let processedData: VTTMapData;

    try {
        if (isFoundryVTTData(fileData)) {
            console.log("Detected FoundryVTT format");
            processedData = convertFoundryToVTTData(fileData);
        } else if (isUniversalVTTData(fileData)) {
            console.log("Detected UniversalVTT format");
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

    await addItemsFromData(processedData, context);
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

    // 1. Decode URL-encoded characters (like %20 -> space)
    try {
        imgPath = decodeURIComponent(imgPath);
    } catch {
        // Fallback to original if decoding fails
    }

    // 2. Normalize slashes
    imgPath = imgPath.replace(/\\/g, '/');

    // 3. Handle specific replacement for Foundry internal paths
    // Usually "modules/module-id/..."
    if (imgPath.startsWith('modules/')) {
        const parts = imgPath.split('/');
        parts.shift(); // remove 'modules'
        // Check if the next part matches any folder in the zip, if not, it's likely the module-id and can be stripped
        const possibleModuleId = parts[0];
        const allFiles = Object.keys(zip.files);
        const foldersInZip = allFiles.filter(f => f.includes('/')).map(f => f.split('/')[0]);

        if (!foldersInZip.includes(possibleModuleId)) {
            parts.shift(); // remove module-id
        }
        imgPath = parts.join('/');
    }

    let resolvedPath = imgPath;
    let file = zip.file(imgPath);
    if (!file) {
        const allFiles = Object.keys(zip.files);
        let match = allFiles.find(p => p.toLowerCase() === imgPath.toLowerCase());
        if (!match) {
            match = allFiles.find(p => p.endsWith(imgPath));
        }
        if (!match) {
            match = allFiles.find(p => imgPath.endsWith(p));
        }
        // Very aggressive fallback: if path contains '/', try just the filename,
        // but only if this yields exactly one candidate to avoid wrong matches.
        if (!match && imgPath.includes('/')) {
            const fileName = imgPath.split('/').pop()!.toLowerCase();
            const basenameMatches = allFiles.filter((p) => {
                const lower = p.toLowerCase();
                return lower === fileName || lower.endsWith(`/${fileName}`);
            });

            if (basenameMatches.length === 1) {
                match = basenameMatches[0];
            } else if (basenameMatches.length > 1) {
                console.warn(
                    `Ambiguous filename fallback for ${imgPath}; found ${basenameMatches.length} candidates. Skipping basename fallback.`
                );
            }
        }
        if (match) {
            resolvedPath = match;
            file = zip.file(match);
        }
    }

    if (!file) {
        throw new Error(`Image not found in ZIP: ${imgPath}`);
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
