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

// Helper function to optimize image data
async function optimizeImage(
    imageBlob: Blob,
    options: OptimizationOptions = {},
    onProgress?: (progress: number) => void
): Promise<Blob> {
    let lastProgress = -1;
    const reportProgress = (progress: number) => {
        if (!onProgress) return;
        const normalized = Math.max(0, Math.min(100, Math.round(progress)));
        if (normalized === lastProgress) return;
        lastProgress = normalized;
        onProgress(normalized);
    };

    const {
        compressionMode = 'standard',
        maxSizeInMB = 24, // Default to slightly under 25MB for safety
        maxMegapixels = compressionMode === 'standard' ? 67 : 144
    } = options;
    const maxSizeInBytes = maxSizeInMB * 1024 * 1024;
    reportProgress(2);

    // If no compression is requested and the image is under the maximum size, return it as is
    if (compressionMode === 'none' && imageBlob.size <= maxSizeInBytes) {
        reportProgress(100);
        return imageBlob;
    }

    return new Promise((resolve, reject) => {
        const img = new Image();
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');

        img.onload = () => {
            URL.revokeObjectURL(img.src);
            reportProgress(10);

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

            const didResize = width !== img.width || height !== img.height;

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
            const encodeCompressedImage = async (quality: number): Promise<Blob> => {
                const webpBlob = await canvasToBlob(canvas, 'image/webp', quality);
                if (webpBlob.type === 'image/webp') {
                    return webpBlob;
                }
                const jpegQuality = Math.max(0.6, Math.min(0.92, quality));
                return canvasToBlob(canvas, 'image/jpeg', jpegQuality);
            };

            if (compressionMode !== 'none' && isUnderSizeLimit && !didResize) {
                if (sourceMimeType === 'image/webp') {
                    reportProgress(100);
                    resolve(imageBlob);
                    return;
                }

                const isLossyNonWebp = sourceMimeType === 'image/jpeg' || sourceMimeType === 'image/jpg';
                if (!isLossyNonWebp) {
                    reportProgress(100);
                    resolve(imageBlob);
                    return;
                }

                void (async () => {
                    reportProgress(65);
                    const candidate = await encodeCompressedImage(0.85);
                    reportProgress(100);
                    resolve(candidate.size > imageBlob.size ? imageBlob : candidate);
                })().catch(() => {
                    reportProgress(100);
                    resolve(imageBlob);
                });
                return;
            }

            // Set initial quality based on compression mode - start with highest possible quality
            // In browsers, quality=1 can inflate already-compressed sources.
            const initialQuality = 0.95;
            const minQuality = 0.1;
            const qualityStep = 0.05;
            const totalPasses = Math.max(
                1,
                Math.ceil((initialQuality - minQuality) / qualityStep) + 1
            );

            // Try different quality settings until we get under maxSizeInMB
            const tryCompress = (currentQuality: number, passIndex: number) => {
                reportProgress(25 + (passIndex / totalPasses) * 70);
                void (compressionMode === 'none'
                    ? canvasToBlob(canvas, imageBlob.type)
                    : encodeCompressedImage(currentQuality))
                    .then((blob) => {
                        const finalBlob = (isUnderSizeLimit && blob.size > imageBlob.size) ? imageBlob : blob;
                        const currentSize = finalBlob.size / (1024 * 1024);
                        if (blob.size > maxSizeInBytes && currentQuality > minQuality && compressionMode !== 'none') {
                            // Try again with lower quality, use smaller steps for more precise control
                            tryCompress(currentQuality - qualityStep, passIndex + 1);
                        } else {
                            const finalSize = currentSize.toFixed(2);
                            const quality = (currentQuality * 100).toFixed(0);
                            OBR.notification.show(`Image compressed: ${quality}% quality (${finalSize}MB)`, "INFO");
                            reportProgress(100);
                            resolve(finalBlob);
                        }
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
        let settled = false;
        let timeoutId: number | null = null;

        const cleanup = () => {
            if (timeoutId !== null) {
                window.clearTimeout(timeoutId);
                timeoutId = null;
            }
            video.onloadeddata = null;
            video.onloadedmetadata = null;
            video.onerror = null;
            if (video.src) {
                URL.revokeObjectURL(video.src);
                video.removeAttribute('src');
                video.load();
            }
        };

        const finalize = () => {
            if (settled) return;
            settled = true;

            const duration = Number(video.duration);
            const width = Number(video.videoWidth);
            const height = Number(video.videoHeight);

            cleanup();

            if (!Number.isFinite(duration) || duration <= 0 || width <= 0 || height <= 0) {
                reject(new Error('Failed to read complete video metadata.'));
                return;
            }

            resolve({
                duration,
                width,
                height,
                frameRate: 30,
            });
        };

        video.onloadeddata = finalize;
        video.onloadedmetadata = finalize;

        video.onerror = () => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(new Error('Failed to load video metadata'));
        };

        timeoutId = window.setTimeout(() => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(new Error('Timed out while reading video metadata'));
        }, 15000);

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
    let lastReportedProgress = -1;
    const reportProgress = (progress: number) => {
        if (!onProgress) return;
        const normalized = Math.max(0, Math.min(100, Math.round(progress)));
        if (normalized <= lastReportedProgress) return;
        lastReportedProgress = normalized;
        onProgress(normalized);
    };

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
    const codecTransformRequested = preferredCodec !== 'vp9';
    const transformRequested = needsResize || audioTransformRequested || codecTransformRequested;
    const requiresTranscode = transformRequested || fileBlob.size > maxBytes || !!options.forceTranscodeUnderLimit;
    const preserveQualityUnderLimit = fileBlob.size <= maxBytes
        && !needsResize
        && !options.forceTranscodeUnderLimit;

    if (!requiresTranscode) {
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
    const getCodecFallbackOrder = (preferred: VideoCodecPreference): VideoCodecPreference[] => {
        const ordered: VideoCodecPreference[] = [preferred, 'h264', 'vp9', 'av1'];
        return Array.from(new Set(ordered));
    };
    const getBitrateScalesForCodec = (codec: VideoCodecPreference): number[] => {
        if (codec === 'av1') return [1, 0.9, 0.8, 0.72, 0.64, 0.56, 0.5];
        if (codec === 'h264') return [1, 0.9, 0.82, 0.74, 0.66];
        return [1, 0.9, 0.82, 0.74, 0.66, 0.58, 0.5];
    };
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

    if (requiresTranscode && isLikelyIOSBrowser()) {
        const iosTranscodeErrorMessage = 'This iOS browser cannot transcode video in this context. Try no compression, a lower Max video dimension, or a browser/device with hardware video encoding support.';
        if (canEncodeVideo) {
            const iosCodecCandidates = getCodecFallbackOrder(preferredCodec);
            const iosProbeModes: Array<'prefer-hardware' | 'no-preference'> = ['prefer-hardware', 'no-preference'];
            let iosTranscodeSupported = false;

            for (const codecCandidate of iosCodecCandidates) {
                const probeCodec = codecCandidate === 'h264' ? 'avc' : codecCandidate;
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
                        // Ignore probe failures and keep checking other candidates/modes.
                    }
                }
                if (iosTranscodeSupported) {
                    break;
                }
            }

            if (!iosTranscodeSupported) {
                throw new Error(iosTranscodeErrorMessage);
            }
        }
    }

    let sourceCodec: 'avc' | 'vp9' | 'av1' | 'other' = 'other';
    let sourceVideoBitrate = 0;
    let sourceAudioBitrate = 0;
    const skipDetailedPacketStats = fileBlob.size > 60_000_000;

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
        preferredCodec,
        !!options.forceTranscodeUnderLimit,
        preserveQualityUnderLimit
    );

    const sourceEquivalentBitrate = Math.floor(sourceVideoBitrate * equivalentFactor * resizeFactor * frameRateFactor);
    const qualityFloorBitrate = Math.floor(sourceVideoBitrate * qualityFloorFactor * resizeFactor * frameRateFactor);

    const highRiskSoftwareResize = needsResize
        && (fileBlob.size > 55_000_000 || pixels > 20_000_000);

    if (highRiskSoftwareResize && canEncodeVideo) {
        const codecCandidates = getCodecFallbackOrder(preferredCodec);
        let hasHardwareResizePath = false;

        for (const codecCandidate of codecCandidates) {
            const probeCodec = codecCandidate === 'h264' ? 'avc' : codecCandidate;
            try {
                const supported = await canEncodeVideo(probeCodec, {
                    width: outWidth,
                    height: outHeight,
                    bitrate: Math.max(450_000, bitrateFromBudget),
                    frameRate: outputFrameRate,
                    hardwareAcceleration: 'prefer-hardware',
                });
                if (supported) {
                    hasHardwareResizePath = true;
                    break;
                }
            } catch {
                // Ignore probing issues and continue checking other codecs.
            }
        }

        if (!hasHardwareResizePath) {
            throw new Error(
                'This resize request is too heavy for software encoding in this browser and may crash. ' +
                'Use a browser/device with hardware-accelerated video encoding, lower Max video dimension further, or pre-resize the video first.'
            );
        }
    }

    const transcodeOnce = async (
        codecPreference: VideoCodecPreference,
        bitrate: number,
        codecDefaultsForPass: ReturnType<typeof getCodecEncodingDefaults>
    ): Promise<Blob> => {
        throwIfAborted();

        const codec = codecPreference === 'h264' ? 'avc' : codecPreference;
        const outputFormat = codecPreference === 'h264'
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
                lastError = new Error('Unable to initialize MediaBunny conversion for this video in the current browser.');
                continue;
            }

            let stallDetected = false;
            let timeoutDetected = false;
            let lastProgressAt = Date.now();
            let lastProgressValue = 0;
            const startedAt = Date.now();
            let stallIntervalId: number | null = null;
            const stallThresholdMs = needsResize ? 18000 : 25000;
            const maxAttemptDurationMs = needsResize ? 90000 : 120000;

            const setProgressTimestamp = () => {
                lastProgressAt = Date.now();
            };

            setProgressTimestamp();
            conversion.onProgress = (progress: number) => {
                if (progress > lastProgressValue + 0.001) {
                    lastProgressValue = progress;
                    setProgressTimestamp();
                }
                reportProgress(Math.min(99, Math.round(progress * 100)));
            };

            stallIntervalId = window.setInterval(() => {
                const elapsedMs = Date.now() - startedAt;
                if (elapsedMs > maxAttemptDurationMs) {
                    timeoutDetected = true;
                    void conversion.cancel();
                    return;
                }

                const stalledForMs = Date.now() - lastProgressAt;
                if (stalledForMs > stallThresholdMs) {
                    stallDetected = true;
                    void conversion.cancel();
                }
            }, 3000);

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
                if (timeoutDetected) {
                    lastError = new Error(
                        'Video encoding timed out in this browser. Try a browser with hardware-accelerated video encoding or reduce Max video dimension.'
                    );
                    continue;
                }
                if (stallDetected) {
                    lastError = new Error(
                        'Video encoder stalled in this browser. Try a browser with hardware-accelerated video encoding or reduce Max video dimension.'
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
                type: codecPreference === 'h264' ? 'video/mp4' : 'video/webm',
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
            `This browser build cannot encode ${codecPreference.toUpperCase()} at ${outWidth}x${outHeight}. ` +
            `Try a lower max video dimension, switch codec, or use a Chromium build with WebCodecs encoding enabled.` +
            availableCodecs +
            (lastError ? ` ${lastError.message}` : '')
        );
    };

    const codecCandidates = getCodecFallbackOrder(preferredCodec);
    let output: Blob | null = null;
    let bestOverBudgetOutput: Blob | null = null;
    let selectedCodec = preferredCodec;
    let lastCodecError: Error | null = null;

    for (const codecCandidate of codecCandidates) {
        const codecDefaults = getCodecEncodingDefaults(codecCandidate);
        const bitrateScales = getBitrateScalesForCodec(codecCandidate);
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
            let candidateOutput = await transcodeOnce(
                codecCandidate,
                attemptedBitrate,
                codecDefaults
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
                candidateOutput = await transcodeOnce(
                    codecCandidate,
                    candidateBitrate,
                    codecDefaults
                );
            }

            if (candidateOutput.size <= maxBytes) {
                output = candidateOutput;
                selectedCodec = codecCandidate;
                break;
            }

            if (!bestOverBudgetOutput || candidateOutput.size < bestOverBudgetOutput.size) {
                bestOverBudgetOutput = candidateOutput;
                selectedCodec = codecCandidate;
            }
        } catch (error) {
            lastCodecError = error instanceof Error ? error : new Error(String(error));
        }
    }

    if (!output) {
        if (bestOverBudgetOutput) {
            const finalSize = (bestOverBudgetOutput.size / 1000 / 1000).toFixed(1);
            throw new Error(`Unable to compress video below ${targetSizeMB}MB (current: ${finalSize}MB). Try Standard mode, a lower max video dimension, or H.264.`);
        }
        throw new Error(
            lastCodecError?.message ||
            `This browser build cannot encode video at ${outWidth}x${outHeight}. Try a lower max video dimension or another codec.`
        );
    }

    if (selectedCodec !== preferredCodec) {
        OBR.notification.show(
            `Preferred codec unavailable at this resolution; switched to ${selectedCodec.toUpperCase()}.`,
            "INFO"
        );
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

    reportProgress(100);
    return {
        blob: output,
        sourceWidth: width,
        sourceHeight: height,
        outputWidth: outWidth,
        outputHeight: outHeight,
    };
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
    videoOptions?: VideoCompressionOptions
): Promise<void> {
    OBR.notification.show('Importing scene..', 'INFO');
    const isVideo =
        file.type.startsWith('video/') ||
        /\.(mp4|webm|mov|avi|mkv|ogv)$/i.test(file.name.toLowerCase());

    let finalBlob: Blob = file;
    let fileExtension = file.name.split('.').pop() || (isVideo ? 'mp4' : 'png');

    if (isVideo) {
        if (compressionMode !== 'none') {
            const sizeInMb = file.size / (1024 * 1024);
            if (sizeInMb > 500) {
                throw new Error(`Video file is too large (${sizeInMb.toFixed(1)}MB). The maximum supported size for browser compression is 500MB.`);
            }
            const compressed = await compressVideo(file, compressionMode, onProgress, videoOptions);
            finalBlob = compressed.blob;
            fileExtension = finalBlob.type.includes('webm') ? 'webm' : 'mp4';
        }
    } else {
        const optimizationOptions: OptimizationOptions = {
            compressionMode,
            maxSizeInMB: compressionMode === 'high' ? 49 : 24,
            maxMegapixels: compressionMode === 'standard' ? 67 : 144,
        };
        finalBlob = await optimizeImage(file, optimizationOptions, onProgress);
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
    videoOptions?: VideoCompressionOptions
): Promise<void> {
    if (isRawMediaFile(file)) {
        return uploadRawMediaScene(file, compressionMode, onProgress, videoOptions);
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
    const finalBlob = await optimizeImage(imageBlob, optimizationOptions, onProgress);
    const fileExtension = getImageExtensionFromMimeType(finalBlob.type, imageType === 'image/webp' ? 'webp' : 'png');
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
        finalBlob = await optimizeImage(imageBlob, optimizationOptions, onProgress);
        fileExtension = getImageExtensionFromMimeType(finalBlob.type, 'png');
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
                const sourceWidth = processedData.resolution?.map_size?.x;
                const sourceHeight = processedData.resolution?.map_size?.y;
                const selectedWithSize = selectedItem as {
                    width?: unknown;
                    height?: unknown;
                };
                const selectedWidth = typeof selectedWithSize.width === 'number' ? selectedWithSize.width : undefined;
                const selectedHeight = typeof selectedWithSize.height === 'number' ? selectedWithSize.height : undefined;

                if (
                    typeof sourceWidth === 'number' && sourceWidth > 0
                    && typeof sourceHeight === 'number' && sourceHeight > 0
                    && typeof selectedWidth === 'number' && selectedWidth > 0
                    && typeof selectedHeight === 'number' && selectedHeight > 0
                ) {
                    const renderedWidth = selectedWidth * scale.x;
                    const renderedHeight = selectedHeight * scale.y;
                    const scaleFromWidth = renderedWidth / (sourceWidth * dpi);
                    const scaleFromHeight = renderedHeight / (sourceHeight * dpi);

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
