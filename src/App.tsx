import { useState, useRef, useEffect } from "react";
import "./App.css";
import {
  uploadSceneFromVTT,
  uploadMediaSceneWithWallData,
  addItemsFromVTT,
  addItemsFromData,
  uploadFoundryScene,
  extractImageFromZip,
  addMapsToCurrentScene,
  addWallsToCurrentSceneWithLayout,
  createSceneWithMultipleMaps,
  MapSelectionPendingError,
  type MapWorkflowResult,
  convertFoundryToVTTData,
  type MapImportSource,
  type MapLayoutMode,
  type MapPlacementMode,
  type CompressionMode,
  type VideoCompressionErrorCode,
  type VideoCodecPreference,
  type VideoCompressionOptions,
  preflightVideoCompression,
  type BrowserVideoCodecAvailability,
  getBrowserVideoCodecAvailability,
  isFoundryVTTData,
  hasMapImage,
  clearMapSelectionState,
} from "./importVTT";
import OBR, { type Theme } from "@owlbear-rodeo/sdk";
import JSZip from "jszip";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import FormControl from "@mui/material/FormControl";
import FormControlLabel from "@mui/material/FormControlLabel";
import InputLabel from "@mui/material/InputLabel";
import LinearProgress from "@mui/material/LinearProgress";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { extractScenesFromLevelDB } from "./leveldb";
import type { FoundryVTTData, VTTMapData } from "./vttTypes";

type SceneData = (FoundryVTTData | VTTMapData) & {
  _id?: string;
  name?: string;
  img?: string;
  thumb?: string;
  background?: {
    src?: string;
    offsetX?: number;
    offsetY?: number;
  };
};

type SceneInfo = {
  name: string;
  data: SceneData;
  fileSource: string;
  thumbUrl?: string;
  isVideo?: boolean;
};

type PendingMapSelectionAction = "add-current" | "multi-scene";
type CompanionWallData = FoundryVTTData | VTTMapData;
type MapWorkflowRunOptions = {
  forceSelectionPrompt?: boolean;
  resetSelectionCache?: boolean;
};

const PREVIEW_HOVER_OPEN_DELAY_MS = 500;
const PREVIEW_TOUCH_OPEN_DELAY_MS = 240;
const PREVIEW_TOUCH_RELEASE_THRESHOLD_MS = 120;

const showMapWorkflowMismatchWarning = async (
  result: MapWorkflowResult,
) => {
  if (result.unmatchedSelectionNames.length === 0) return;

  const unmatchedCount = result.unmatchedSelectionNames.length;
  const preview = result.unmatchedSelectionNames.slice(0, 3).join(", ");
  const moreSuffix =
    unmatchedCount > 3 ? ` (+${unmatchedCount - 3} more)` : "";

  await OBR.notification.show(
    `${unmatchedCount} selected map(s) did not match uploaded metadata, so walls/doors were skipped for those maps. ${preview}${moreSuffix}`,
    "WARNING",
  );
};

const hexToRgbChannels = (color: string): string | null => {
  const hex = color.match(/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/)?.[1];
  if (!hex) return null;

  const r = parseInt(hex.length === 3 ? hex[0].repeat(2) : hex.slice(0, 2), 16);
  const g = parseInt(hex.length === 3 ? hex[1].repeat(2) : hex.slice(2, 4), 16);
  const b = parseInt(hex.length === 3 ? hex[2].repeat(2) : hex.slice(4, 6), 16);
  return `${r}, ${g}, ${b}`;
};

const sceneHasWallData = (sceneData: SceneData): boolean => {
  if (isFoundryVTTData(sceneData)) {
    return Array.isArray(sceneData.walls) && sceneData.walls.length > 0;
  }

  const vttData = sceneData as Partial<VTTMapData>;
  return (
    (Array.isArray(vttData.line_of_sight) &&
      vttData.line_of_sight.length > 0) ||
    (Array.isArray(vttData.objects_line_of_sight) &&
      vttData.objects_line_of_sight.length > 0) ||
    (Array.isArray(vttData.portals) && vttData.portals.length > 0)
  );
};

function isRawMediaFile(file: File): boolean {
  const lowerName = file.name.toLowerCase();
  return (
    file.type.startsWith("image/") ||
    file.type.startsWith("video/") ||
    /\.(png|jpe?g|webp|avif|gif|bmp|mp4|webm|mov|avi|mkv|ogv)$/i.test(
      lowerName,
    )
  );
}

type VideoReadabilityProbe = {
  readable: boolean;
  width: number;
  height: number;
};

const probeBrowserVideoReadability = async (
  blob: Blob,
): Promise<VideoReadabilityProbe> => {
  if (typeof document === "undefined") {
    return { readable: false, width: 0, height: 0 };
  }

  return new Promise<VideoReadabilityProbe>((resolve) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.playsInline = true;

    let settled = false;
    let timeoutId: number | null = null;
    const objectUrl = URL.createObjectURL(blob);

    const finish = (result: VideoReadabilityProbe) => {
      if (settled) return;
      settled = true;
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
        timeoutId = null;
      }
      video.onloadedmetadata = null;
      video.onerror = null;
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(objectUrl);
      resolve(result);
    };

    const onLoaded = () => {
      const width = Number(video.videoWidth);
      const height = Number(video.videoHeight);
      if (width > 0 && height > 0) {
        finish({ readable: true, width, height });
      }
    };

    video.onloadedmetadata = onLoaded;
    video.onloadeddata = onLoaded;

    video.onerror = () => finish({ readable: false, width: 0, height: 0 });

    timeoutId = window.setTimeout(
      () => finish({ readable: false, width: 0, height: 0 }),
      7000,
    );
    video.src = objectUrl;
  });
};

const hashMapSourceSignature = (value: string): string => {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
};

function App() {
  const isContextMenuMode =
    new URLSearchParams(window.location.search).get("context") === "true";
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [selectedWallDataFile, setSelectedWallDataFile] =
    useState<File | null>(null);
  const [selectedWallData, setSelectedWallData] =
    useState<CompanionWallData | null>(null);
  const [selectedRawFiles, setSelectedRawFiles] = useState<File[]>([]);
  const [moduleUrl, setModuleUrl] = useState("");
  const [zipObject, setZipObject] = useState<JSZip | null>(null);
  const [availableScenes, setAvailableScenes] = useState<SceneInfo[]>([]);
  const [selectedSceneIndex, setSelectedSceneIndex] = useState(0);
  const [selectedSceneIndices, setSelectedSceneIndices] = useState<number[]>(
    [],
  );
  const [layoutMode, setLayoutMode] = useState<MapLayoutMode>("GRID");
  const [mapPlacementMode, setMapPlacementMode] = useState<MapPlacementMode>("RIGHT");
  const [layoutSpacing, setLayoutSpacing] = useState("80");
  const [layoutScalePercent, setLayoutScalePercent] = useState("100");
  const [includeWallsWithMaps, setIncludeWallsWithMaps] = useState(true);
  const [lockImportedMaps, setLockImportedMaps] = useState(true);
  const [showMapLayoutOptions, setShowMapLayoutOptions] = useState(false);
  const [showAdvancedLayoutOptions, setShowAdvancedLayoutOptions] = useState(false);
  const [multiSceneName, setMultiSceneName] = useState("Multi Map Scene");
  const [pendingMapSelection, setPendingMapSelection] = useState<{
    token: string;
    action: PendingMapSelectionAction;
  } | null>(null);
  const [mapSelectionToken, setMapSelectionToken] = useState<string | null>(null);
  const [lastMapWorkflowAction, setLastMapWorkflowAction] =
    useState<PendingMapSelectionAction | null>(null);

  const [hoveredSceneThumb, setHoveredSceneThumb] = useState<{
    url: string;
    isVideo?: boolean;
  } | null>(null);
  const [canHoverPreview, setCanHoverPreview] = useState(false);
  const [showUrlInput, setShowUrlInput] = useState(false);
  const [manualDownloadUrl, setManualDownloadUrl] = useState<string | null>(
    null,
  );

  const [isFoundryFormat, setIsFoundryFormat] = useState(false);
  const [hasImage, setHasImage] = useState(false);
  const [compressionMode, setCompressionMode] =
    useState<CompressionMode>("standard");
  const [showAdvancedVideoOptions, setShowAdvancedVideoOptions] =
    useState(false);
  const [preferredVideoCodec, setPreferredVideoCodec] =
    useState<VideoCodecPreference>("auto");
  const [browserCodecAvailability, setBrowserCodecAvailability] =
    useState<BrowserVideoCodecAvailability | null>(null);
  const [removeVideoAudio, setRemoveVideoAudio] = useState(false);
  const [forceVideoTranscode, setForceVideoTranscode] = useState(false);
  const [maxVideoDimension, setMaxVideoDimension] = useState<string>("");
  const [isVideoCompressionSupported, setIsVideoCompressionSupported] =
    useState(true);
  const [videoCompressionSupportMessage, setVideoCompressionSupportMessage] =
    useState<string | null>(null);

  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [compressionStage, setCompressionStage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [theme, setTheme] = useState<Theme | null>(null);
  const [isGM, setIsGM] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const compressionAbortRef = useRef<AbortController | null>(null);
  const heightRafRef = useRef<number | null>(null);
  const previewOpenTimeoutRef = useRef<number | null>(null);
  const previewHideTimeoutRef = useRef<number | null>(null);
  const suppressNextCardClickRef = useRef(false);
  const previewSourceIndexRef = useRef<number | null>(null);
  const suppressedPreviewCardIndexRef = useRef<number | null>(null);
  const touchPreviewPressStartedAtRef = useRef<number | null>(null);

  const clearPreviewOpenTimeout = () => {
    if (previewOpenTimeoutRef.current !== null) {
      window.clearTimeout(previewOpenTimeoutRef.current);
      previewOpenTimeoutRef.current = null;
    }
  };

  const clearPreviewHideTimeout = () => {
    if (previewHideTimeoutRef.current !== null) {
      window.clearTimeout(previewHideTimeoutRef.current);
      previewHideTimeoutRef.current = null;
    }
  };

  const schedulePreviewOpen = (
    sourceIndex: number,
    preview: { url: string; isVideo?: boolean },
    delayMs: number,
    onShow?: () => void,
  ) => {
    if (suppressedPreviewCardIndexRef.current === sourceIndex) return;
    clearPreviewOpenTimeout();
    clearPreviewHideTimeout();
    previewOpenTimeoutRef.current = window.setTimeout(() => {
      previewSourceIndexRef.current = sourceIndex;
      setHoveredSceneThumb(preview);
      previewOpenTimeoutRef.current = null;
      onShow?.();
    }, delayMs);
  };

  const hideHoverPreviewSoon = () => {
    clearPreviewOpenTimeout();
    clearPreviewHideTimeout();
    previewHideTimeoutRef.current = window.setTimeout(() => {
      setHoveredSceneThumb(null);
      previewSourceIndexRef.current = null;
      previewHideTimeoutRef.current = null;
    }, 140);
  };
  const selectedSceneIndexes =
    isContextMenuMode
      ? [selectedSceneIndex]
      : selectedSceneIndices.length > 0
        ? selectedSceneIndices
        : [selectedSceneIndex];
  const selectedScenes = selectedSceneIndexes
    .map((idx) => availableScenes[idx])
    .filter((scene): scene is SceneInfo => !!scene);
  const hasRawMediaSources =
    selectedRawFiles.length > 0 || (!!selectedFile && isRawMediaFile(selectedFile));
  const hasArchiveMapSources =
    availableScenes.length > 0 &&
    selectedScenes.some((scene) => !!(scene.data.img || scene.data.background?.src));
  const hasCompanionWallData = !!selectedWallData;
  const hasMapWorkflowSources = hasArchiveMapSources || hasRawMediaSources;
  const selectedSceneHasWallData =
    availableScenes.length === 0 ||
    selectedScenes.some((scene) => sceneHasWallData(scene.data));
  const selectedSceneHasMap =
    availableScenes.length === 0 ||
    selectedScenes.some((scene) => !!(scene.data.img || scene.data.background?.src));
  const selectedSceneIsVideo = selectedScenes.some((scene) => !!scene.isVideo);
  const selectedFileIsVideo =
    !!selectedFile &&
    (selectedFile.type.startsWith("video/") ||
      /\.(mp4|webm|mov|avi|mkv|ogv)$/i.test(selectedFile.name.toLowerCase()));
  const selectedRawFilesContainVideo = selectedRawFiles.some(
    (file) =>
      file.type.startsWith("video/") ||
      /\.(mp4|webm|mov|avi|mkv|ogv)$/i.test(file.name.toLowerCase()),
  );
  const selectedInputIsVideo =
    availableScenes.length > 0
      ? selectedSceneIsVideo
      : selectedRawFiles.length > 0
        ? selectedRawFilesContainVideo
        : selectedFileIsVideo;
  const selectedSourceCount =
    availableScenes.length > 0
      ? selectedScenes.length
      : selectedRawFiles.length > 0
        ? selectedRawFiles.length
        : selectedFile
          ? 1
          : 0;
  const hasWallImportSources =
    (availableScenes.length > 0 && selectedSceneHasWallData) ||
    !!selectedWallData ||
    (!!selectedFile && !isRawMediaFile(selectedFile));
  const canImportToCurrentScene = hasMapWorkflowSources || hasWallImportSources;
  const canCreateNewScene =
    !isContextMenuMode &&
    selectedSourceCount > 0 &&
    (hasImage || (!!selectedFile && selectedWallData));
  const shouldUseMultiMapSceneCreation =
    !isContextMenuMode && hasMapWorkflowSources && selectedSourceCount > 1;
  const useMultiSceneSelectionLabel =
    !isContextMenuMode && selectedSceneIndices.length > 1;
  const shouldPreferWallImportForCurrent =
    (hasCompanionWallData && !hasRawMediaSources) ||
    !hasMapWorkflowSources;
  const shouldShowMapLayoutOptions =
    !isContextMenuMode &&
    hasMapWorkflowSources &&
    (showMapLayoutOptions ||
      selectedSourceCount > 1 ||
      pendingMapSelection !== null ||
      mapSelectionToken !== null);
  const videoCompressionBlocked =
    selectedInputIsVideo && !isVideoCompressionSupported;
  const containerClassName = `container ${isContextMenuMode ? "context-mode" : "action-mode"} ${availableScenes.length > 0 ? "has-scenes" : ""}`;

  useEffect(
    () =>
      OBR.onReady(() => {
        // Check if player is GM
        OBR.player.getRole().then((role) => {
          setIsGM(role === "GM");
        });

        // Get initial theme
        OBR.theme.getTheme().then(setTheme);
        // Subscribe to theme changes
        return OBR.theme.onChange(setTheme);
      }),
    [],
  );

  useEffect(() => {
    let isMounted = true;

    void getBrowserVideoCodecAvailability()
      .then((availability) => {
        if (!isMounted) return;
        setBrowserCodecAvailability(availability);
      })
      .catch((error) => {
        console.warn("Failed to determine browser codec availability", error);
      });

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (!browserCodecAvailability || preferredVideoCodec === "auto") return;
    if (!browserCodecAvailability[preferredVideoCodec]) {
      setPreferredVideoCodec("auto");
    }
  }, [browserCodecAvailability, preferredVideoCodec]);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;

    const mediaQuery = window.matchMedia("(hover: hover) and (pointer: fine)");
    const updateCanHover = () => {
      setCanHoverPreview(mediaQuery.matches);
    };

    updateCanHover();
    mediaQuery.addEventListener("change", updateCanHover);

    return () => {
      mediaQuery.removeEventListener("change", updateCanHover);
    };
  }, []);

  useEffect(
    () => () => {
      clearPreviewOpenTimeout();
      clearPreviewHideTimeout();
    },
    [],
  );

  useEffect(() => {
    clearPreviewOpenTimeout();
    clearPreviewHideTimeout();
    setHoveredSceneThumb(null);
  }, [canHoverPreview]);

  useEffect(() => {
    let isMounted = true;

    const setSupported = () => {
      if (!isMounted) return;
      setIsVideoCompressionSupported(true);
      setVideoCompressionSupportMessage(null);
    };

    const setUnsupported = (message: string) => {
      if (!isMounted) return;
      setIsVideoCompressionSupported(false);
      setVideoCompressionSupportMessage(message);
    };

    const checkSupport = async () => {
      if (!selectedInputIsVideo) {
        setSupported();
        return;
      }

      if (availableScenes.length > 0) {
        const scene = selectedScenes.find((candidate) => candidate.isVideo);
        if (!scene || !scene.isVideo || !zipObject || !isFoundryVTTData(scene.data)) {
          setSupported();
          return;
        }

        const imgPath = scene.data.img || scene.data.background?.src;
        if (!imgPath) {
          setSupported();
          return;
        }

        try {
          const mediaBlob = await extractImageFromZip(zipObject, imgPath);
          const probe = await probeBrowserVideoReadability(mediaBlob);
          if (!isMounted) return;

          if (!probe.readable) {
            setUnsupported(
              "Compression for this video is not supported by this browser. No Compression has been selected automatically.",
            );
          } else {
            const preflight = await preflightVideoCompression(
              mediaBlob,
            );
            if (!isMounted) return;
            if (!preflight.supported) {
              setUnsupported(
                preflight.reason
                  ? `Compression for this file is not supported by this browser (${preflight.reason}). No Compression has been selected automatically.`
                  : "Compression for this file is not supported by this browser. No Compression has been selected automatically.",
              );
            } else {
              setSupported();
            }
          }
        } catch {
          // If we cannot access the media blob here, do not block compression preemptively.
          setSupported();
        }
        return;
      }

      const primaryMediaFile =
        selectedRawFiles.find(
          (file) =>
            file.type.startsWith("video/") ||
            /\.(mp4|webm|mov|avi|mkv|ogv)$/i.test(file.name.toLowerCase()),
        ) || (selectedFileIsVideo ? selectedFile : null);

      if (!primaryMediaFile) {
        setSupported();
        return;
      }

      const probe = await probeBrowserVideoReadability(primaryMediaFile);
      if (!isMounted) return;

      if (!probe.readable) {
        setUnsupported(
          "Compression for this video is not supported by this browser. No Compression has been selected automatically.",
        );
      } else {
        const preflight = await preflightVideoCompression(
          primaryMediaFile,
        );
        if (!isMounted) return;
        if (!preflight.supported) {
          setUnsupported(
            preflight.reason
              ? `Compression for this file is not supported by this browser (${preflight.reason}). No Compression has been selected automatically.`
              : "Compression for this file is not supported by this browser. No Compression has been selected automatically.",
          );
        } else {
          setSupported();
        }
      }
    };

    void checkSupport();

    return () => {
      isMounted = false;
    };
  }, [
    availableScenes,
    selectedScenes,
    selectedFile,
    selectedRawFiles,
    selectedFileIsVideo,
    selectedInputIsVideo,
    zipObject,
  ]);

  useEffect(() => {
    if (videoCompressionBlocked && compressionMode !== "none") {
      setCompressionMode("none");
    }
  }, [videoCompressionBlocked, compressionMode]);

  // Clean up object URLs to prevent memory leaks
  useEffect(() => {
    return () => {
      availableScenes.forEach((s) => {
        if (s.thumbUrl) URL.revokeObjectURL(s.thumbUrl);
      });
    };
  }, [availableScenes]);

  useEffect(() => {
    // Context menu runs inside a modal. Do not mutate action popover height from here.
    if (isContextMenuMode) {
      return;
    }

    const updateHeight = () => {
      if (heightRafRef.current !== null) return;

      heightRafRef.current = requestAnimationFrame(() => {
        heightRafRef.current = null;
        if (!OBR.isReady || !containerRef.current) return;

        const minHeight = 250;
        const nextHeight = Math.max(
          containerRef.current.offsetHeight,
          minHeight,
        );
        OBR.action.setHeight(nextHeight);
      });
    };

    const cancelScheduledHeight = () => {
      if (heightRafRef.current !== null) {
        cancelAnimationFrame(heightRafRef.current);
        heightRafRef.current = null;
      }
    };

    // Initial height update
    updateHeight();
    if (!OBR.isReady) {
      OBR.onReady(() => updateHeight());
    }

    // Update height when content changes
    const observer = new ResizeObserver(updateHeight);
    const currentContainer = containerRef.current;

    if (currentContainer) {
      observer.observe(currentContainer);
    }

    return () => {
      cancelScheduledHeight();
      if (currentContainer) {
        observer.unobserve(currentContainer);
      }
      observer.disconnect();
    };
  }, [
    selectedFile,
    hasImage,
    isLoading,
    compressionMode,
    availableScenes,
    selectedSceneIndex,
    isContextMenuMode,
  ]);

  useEffect(() => {
    if (availableScenes.length === 0) {
      if (selectedSceneIndices.length > 0) {
        setSelectedSceneIndices([]);
      }
      return;
    }

    if (selectedSceneIndices.length === 0) {
      setSelectedSceneIndices([selectedSceneIndex]);
    }
  }, [availableScenes, selectedSceneIndex, selectedSceneIndices]);

  useEffect(() => {
    if (selectedSceneIndices.length === 0) {
      return;
    }
    if (!selectedSceneIndices.includes(selectedSceneIndex)) {
      setSelectedSceneIndex(selectedSceneIndices[0]);
    }
  }, [selectedSceneIndices, selectedSceneIndex]);

  useEffect(() => {
    if (selectedRawFiles.length > 0) {
      if (!hasImage) setHasImage(true);
      return;
    }

    if (availableScenes.length > 0) {
      setHasImage(selectedScenes.some((scene) => !!(scene.data.img || scene.data.background?.src)));
    }
  }, [availableScenes, selectedScenes, selectedRawFiles, hasImage]);

  useEffect(() => {
    if (!hasMapWorkflowSources) {
      if (showMapLayoutOptions) setShowMapLayoutOptions(false);
      if (showAdvancedLayoutOptions) setShowAdvancedLayoutOptions(false);
    }
  }, [
    hasMapWorkflowSources,
    showMapLayoutOptions,
    showAdvancedLayoutOptions,
  ]);

  // Set theme CSS variables when theme changes
  useEffect(() => {
    if (!theme) return;

    const root = document.documentElement;
    root.style.setProperty("--primary-main", theme.primary.main);
    root.style.setProperty("--primary-light", theme.primary.light);
    root.style.setProperty("--primary-dark", theme.primary.dark);
    root.style.setProperty("--primary-contrast", theme.primary.contrastText);
    root.style.setProperty("--secondary-main", theme.secondary.main);
    root.style.setProperty("--secondary-light", theme.secondary.light);
    root.style.setProperty("--secondary-dark", theme.secondary.dark);
    root.style.setProperty(
      "--secondary-contrast",
      theme.secondary.contrastText,
    );
    root.style.setProperty("--background-default", theme.background.default);
    root.style.setProperty("--background-paper", theme.background.paper);

    const backgroundDefaultRgb = hexToRgbChannels(theme.background.default);
    if (backgroundDefaultRgb) {
      root.style.setProperty("--background-default-rgb", backgroundDefaultRgb);
    }

    const paperRgb = hexToRgbChannels(theme.background.paper);
    if (paperRgb) root.style.setProperty("--background-paper-rgb", paperRgb);

    const primaryRgb = hexToRgbChannels(theme.primary.main);
    if (primaryRgb) root.style.setProperty("--primary-main-rgb", primaryRgb);

    root.style.setProperty("--text-primary", theme.text.primary);
    root.style.setProperty("--text-secondary", theme.text.secondary);
    root.style.setProperty("--text-disabled", theme.text.disabled);

    const textRgb = hexToRgbChannels(theme.text.primary);
    if (textRgb) root.style.setProperty("--text-primary-rgb", textRgb);
  }, [theme]);

  const normalizeZipPath = (path: string): string =>
    path
      .replace(/\\/g, "/")
      .replace(/^\.\//, "")
      .replace(/^\//, "")
      .replace(/\/+/g, "/");

  const findLevelDbFilesForPack = (zip: JSZip, packPath: string): string[] => {
    const allPaths = Object.keys(zip.files);
    const normalizedPackPath = normalizeZipPath(packPath).replace(/\/+$/, "");
    const candidateRoots = new Set<string>();

    if (normalizedPackPath) {
      candidateRoots.add(normalizedPackPath);

      if (normalizedPackPath.toLowerCase().endsWith(".db")) {
        candidateRoots.add(normalizedPackPath.slice(0, -3));
      }

      const lastSlash = normalizedPackPath.lastIndexOf("/");
      const baseName =
        lastSlash >= 0
          ? normalizedPackPath.slice(lastSlash + 1)
          : normalizedPackPath;
      if (baseName.toLowerCase().endsWith(".db")) {
        const trimmedBase = baseName.slice(0, -3);
        candidateRoots.add(trimmedBase);
        if (lastSlash >= 0) {
          candidateRoots.add(
            `${normalizedPackPath.slice(0, lastSlash + 1)}${trimmedBase}`,
          );
        }
      }
    }

    const normalizedCandidates = Array.from(candidateRoots).map((candidate) =>
      normalizeZipPath(candidate).replace(/\/+$/, "/").toLowerCase(),
    );

    const matches = allPaths.filter((path) => {
      const normalizedPath = normalizeZipPath(path).toLowerCase();
      if (!normalizedPath.endsWith(".ldb")) return false;

      return normalizedCandidates.some(
        (candidate) =>
          normalizedPath.startsWith(candidate) ||
          normalizedPath.includes(`/${candidate}`),
      );
    });

    return Array.from(new Set(matches)).sort();
  };

  const handleZipFile = async (fileOrBlob: Blob | File) => {
    setIsLoading(true);
    try {
      const zip = await JSZip.loadAsync(fileOrBlob);
      setZipObject(zip);

      let moduleJsonFile = zip.file("module.json");
      if (!moduleJsonFile) {
        const match = Object.keys(zip.files).find((p) =>
          p.endsWith("module.json"),
        );
        if (match) moduleJsonFile = zip.file(match);
      }

      let moduleJson = null;
      if (moduleJsonFile) {
        const content = await moduleJsonFile.async("string");
        moduleJson = JSON.parse(content);
      }

      const scenes: SceneInfo[] = [];

      if (moduleJson && Array.isArray(moduleJson.packs)) {
        for (const pack of moduleJson.packs) {
          if (pack.type === "Scene" && pack.path) {
            let packPath = pack.path.replace(/\\/g, "/");
            if (packPath.startsWith(".")) packPath = packPath.substring(1);
            if (packPath.startsWith("/")) packPath = packPath.substring(1);

            let packFile = zip.file(packPath);
            if (!packFile) {
              const match = Object.keys(zip.files).find(
                (p) => p.endsWith(packPath) || packPath.endsWith(p),
              );
              if (match) packFile = zip.file(match);
            }

            if (packFile) {
              const content = await packFile.async("string");
              const lines = content
                .split("\n")
                .filter((l) => l.trim().length > 0);
              for (const line of lines) {
                try {
                  const scene = JSON.parse(line);
                  if (
                    isFoundryVTTData(scene) &&
                    typeof scene.name === "string"
                  ) {
                    scenes.push({
                      name: scene.name,
                      data: scene,
                      fileSource:
                        fileOrBlob instanceof File ? fileOrBlob.name : "module",
                    });
                  }
                } catch {
                  // ignore
                }
              }
            } else {
              // Try LevelDB format (it might be a directory in the zip)
              // Support both legacy `<pack>.db` paths and modern `<pack>/` ldb directories.
              const ldbFiles = findLevelDbFilesForPack(zip, packPath);

              if (ldbFiles.length > 0) {
                const ldbBuffers: ArrayBuffer[] = [];
                for (const f of ldbFiles) {
                  ldbBuffers.push(await zip.file(f)!.async("arraybuffer"));
                }
                const ldbScenes = extractScenesFromLevelDB(ldbBuffers);
                for (const scene of ldbScenes) {
                  if (
                    isFoundryVTTData(scene) &&
                    typeof scene.name === "string"
                  ) {
                    scenes.push({
                      name: scene.name,
                      data: scene,
                      fileSource:
                        fileOrBlob instanceof File ? fileOrBlob.name : "module",
                    });
                  }
                }
              }
            }
          }
        }
      }

      if (scenes.length === 0) {
        const allLdbFiles = Object.keys(zip.files)
          .filter((path) => path.toLowerCase().endsWith(".ldb"))
          .sort();

        if (allLdbFiles.length > 0) {
          const ldbBuffers: ArrayBuffer[] = [];
          for (const ldbPath of allLdbFiles) {
            ldbBuffers.push(await zip.file(ldbPath)!.async("arraybuffer"));
          }

          const ldbScenes = extractScenesFromLevelDB(ldbBuffers);
          for (const scene of ldbScenes) {
            if (isFoundryVTTData(scene) && typeof scene.name === "string") {
              scenes.push({
                name: scene.name,
                data: scene,
                fileSource:
                  fileOrBlob instanceof File ? fileOrBlob.name : "module",
              });
            }
          }
        }

        if (scenes.length === 0) {
          for (const path of Object.keys(zip.files)) {
            if (path.endsWith(".db") || path.endsWith(".json")) {
              if (path.endsWith("module.json")) continue;
              const content = await zip.file(path)!.async("string");
              const lines = content
                .split("\n")
                .filter((l) => l.trim().length > 0);
              for (const line of lines) {
                try {
                  const scene = JSON.parse(line);
                  if (
                    isFoundryVTTData(scene) &&
                    typeof scene.name === "string"
                  ) {
                    scenes.push({
                      name: scene.name,
                      data: scene,
                      fileSource:
                        fileOrBlob instanceof File ? fileOrBlob.name : "module",
                    });
                  }
                } catch {
                  // ignore
                }
              }
            }
          }
        }
      }

      if (scenes.length > 0) {
        // Pre-fetch thumbnails as object URLs
        for (const s of scenes) {
          // V11+ stores thumbnails in assets/scenes/<id>-thumb.webp
          const sceneId = s.data._id || "";
          const v11ThumbPath = sceneId
            ? `assets/scenes/${sceneId}-thumb.webp`
            : null;

          const possiblePaths = [
            v11ThumbPath,
            s.data.thumb,
            s.data.background?.src,
            s.data.img,
          ].filter(Boolean) as string[];
          for (const imgPath of possiblePaths) {
            try {
              const blob = await extractImageFromZip(zip, imgPath);
              s.thumbUrl = URL.createObjectURL(blob);
              s.isVideo = blob.type.startsWith("video/");
              break; // Success, stop trying fallbacks
            } catch {
              // Silently try the next fallback path
            }
          }
          if (!s.thumbUrl) {
            console.warn(
              `Failed to extract any thumbnail or image for scene ${s.name}`,
            );
          }
        }

        setAvailableScenes(scenes);
        setSelectedSceneIndex(0);
        setSelectedSceneIndices([0]);
        setSelectedFile(null);
        setSelectedWallDataFile(null);
        setSelectedWallData(null);
        setSelectedRawFiles([]);
        resetMapWorkflowState();
        setIsFoundryFormat(true);
        const firstScene = scenes[0].data;
        setHasImage(!!(firstScene.img || firstScene.background?.src));
      } else {
        OBR.notification.show("No scenes found in this ZIP.", "WARNING");
        setZipObject(null);
        setAvailableScenes([]);
        setSelectedSceneIndices([]);
        setSelectedWallDataFile(null);
        setSelectedWallData(null);
        resetMapWorkflowState();
      }
    } catch (e) {
      console.error(e);
      OBR.notification.show("Failed to parse ZIP file.", "ERROR");
      setZipObject(null);
      setAvailableScenes([]);
      setSelectedSceneIndices([]);
      setSelectedWallDataFile(null);
      setSelectedWallData(null);
      resetMapWorkflowState();
    }
    setIsLoading(false);
  };

  const normalizeCorsUrl = (url: string): string => {
    if (!url) return url;
    let newUrl = url.trim();

    // Dropbox transformations
    if (newUrl.includes("dropbox.com/s/")) {
      newUrl = newUrl.replace(
        "www.dropbox.com/s/",
        "dl.dropboxusercontent.com/s/",
      );
      newUrl = newUrl.replace("dropbox.com/s/", "dl.dropboxusercontent.com/s/");
    }
    if (newUrl.includes("dropbox.com/scl/")) {
      newUrl = newUrl.replace(
        "www.dropbox.com/scl/",
        "dl.dropboxusercontent.com/scl/",
      );
      newUrl = newUrl.replace(
        "dropbox.com/scl/",
        "dl.dropboxusercontent.com/scl/",
      );
    }

    // GitHub transformations
    if (newUrl.includes("github.com/") && newUrl.includes("/blob/")) {
      newUrl = newUrl
        .replace("github.com", "raw.githubusercontent.com")
        .replace("/blob/", "/");
    }

    return newUrl;
  };

  const processJsonData = async (
    fileData: unknown,
    originalName: string,
    originalBlob: Blob | File,
  ) => {
    // Is it a module.json with a download link?
    const downloadUrl =
      typeof fileData === "object" &&
      fileData !== null &&
      "download" in fileData &&
      typeof fileData.download === "string"
        ? fileData.download
        : null;

    if (downloadUrl) {
      OBR.notification.show("Downloading module ZIP...", "INFO");

      let zipRes;
      const targetUrl = normalizeCorsUrl(downloadUrl);
      try {
        zipRes = await fetch(targetUrl);
      } catch {
        setManualDownloadUrl(targetUrl);
        throw new Error(
          `CORS blocked auto-download. Please manually download the ZIP module and upload it.`,
        );
      }

      if (!zipRes.ok)
        throw new Error(`HTTP Error ${zipRes.status} downloading ZIP file.`);

      const zipBlob = await zipRes.blob();
      await handleZipFile(zipBlob);
      return;
    }

    // Otherwise, it's a standard VTT scene or regular Foundry config map
    const foundryFormat = isFoundryVTTData(fileData);
    const imageExists = hasMapImage(fileData);
    setIsFoundryFormat(foundryFormat);
    setHasImage(imageExists);

    const fileObj =
      originalBlob instanceof File
        ? originalBlob
        : new File([originalBlob], originalName, { type: originalBlob.type });

    setSelectedFile(fileObj);
    setSelectedWallDataFile(null);
    setSelectedWallData(null);
    setSelectedRawFiles([]);
    setAvailableScenes([]);
    setSelectedSceneIndices([]);
    setZipObject(null);
    resetMapWorkflowState();
  };

  const isJsonDataFile = (file: File): boolean => {
    const lowerName = file.name.toLowerCase();
    return (
      lowerName.endsWith(".json") ||
      file.type === "application/json" ||
      file.type === "application/octet-stream"
    );
  };

  const normalizeVTTWallDataPayload = (payload: unknown): VTTMapData | null => {
    if (!payload || typeof payload !== "object") return null;

    const source = payload as Partial<VTTMapData> & {
      resolution?: {
        map_origin?: { x?: unknown; y?: unknown };
        map_size?: { x?: unknown; y?: unknown };
        pixels_per_grid?: unknown;
      };
    };

    const resolution = source.resolution;
    if (!resolution || typeof resolution !== "object") return null;

    const pixelsPerGrid = Number(resolution.pixels_per_grid);
    const mapSizeX = Number(resolution.map_size?.x);
    const mapSizeY = Number(resolution.map_size?.y);
    const mapOriginX = Number(resolution.map_origin?.x ?? 0);
    const mapOriginY = Number(resolution.map_origin?.y ?? 0);

    if (
      !Number.isFinite(pixelsPerGrid) ||
      pixelsPerGrid <= 0 ||
      !Number.isFinite(mapSizeX) ||
      !Number.isFinite(mapSizeY)
    ) {
      return null;
    }

    const lineOfSight = Array.isArray(source.line_of_sight)
      ? source.line_of_sight
      : [];
    const objectLineOfSight = Array.isArray(source.objects_line_of_sight)
      ? source.objects_line_of_sight
      : [];
    const portals = Array.isArray(source.portals) ? source.portals : [];

    if (
      lineOfSight.length === 0 &&
      objectLineOfSight.length === 0 &&
      portals.length === 0
    ) {
      return null;
    }

    return {
      line_of_sight: lineOfSight,
      objects_line_of_sight: objectLineOfSight,
      portals,
      resolution: {
        map_origin: { x: mapOriginX, y: mapOriginY },
        map_size: { x: mapSizeX, y: mapSizeY },
        pixels_per_grid: pixelsPerGrid,
      },
    };
  };

  const parseWallDataFile = async (file: File): Promise<CompanionWallData> => {
    const parsed = JSON.parse(await file.text()) as unknown;

    if (isFoundryVTTData(parsed)) {
      return parsed;
    }

    const normalizedVttWallData = normalizeVTTWallDataPayload(parsed);
    if (normalizedVttWallData) {
      return normalizedVttWallData;
    }

    throw new Error(
      "Wall data JSON must be Foundry scene wall data or UVTT-style wall data with a valid resolution block.",
    );
  };

  const processMediaFile = (file: File) => {
    setSelectedFile(file);
    setSelectedWallDataFile(null);
    setSelectedWallData(null);
    setSelectedRawFiles([]);
    setIsFoundryFormat(false);
    setHasImage(true);
    setAvailableScenes([]);
    setSelectedSceneIndices([]);
    setZipObject(null);
    resetMapWorkflowState();
  };

  const handleFetchUrl = async () => {
    if (!moduleUrl) return;
    setIsLoading(true);
    setManualDownloadUrl(null);
    try {
      let res;
      const targetUrl = normalizeCorsUrl(moduleUrl);
      try {
        res = await fetch(targetUrl);
      } catch {
        setManualDownloadUrl(targetUrl);
        throw new Error(
          `Failed to fetch (CORS block or invalid URL). Please download manually.`,
        );
      }
      if (!res.ok)
        throw new Error(`HTTP ${res.status} returned from remote server.`);

      const clonedRes = res.clone();

      // First try to see if it's a ZIP by looking at filename or content-type
      const isZipPath = moduleUrl.toLowerCase().split("?")[0].endsWith(".zip");
      const contentType = res.headers.get("content-type") || "";

      if (
        isZipPath ||
        contentType.includes("zip") ||
        contentType.includes("octet-stream")
      ) {
        try {
          const zipBlob = await res.blob();
          await handleZipFile(zipBlob);
          if (fileInputRef.current) fileInputRef.current.value = "";
          setIsLoading(false);
          return; // Successfully handled as zip
        } catch (e) {
          // Might not actually be a zip, fallback to text parsing if needed
          console.warn(
            "Attempted to parse as zip but failed, falling back to JSON parsing",
            e,
          );
        }
      }

      const mediaUrlPattern =
        /\.(png|jpe?g|webp|avif|gif|bmp|mp4|webm|mov|avi|mkv|ogv)(\?.*)?$/i;
      const isMediaUrl =
        contentType.startsWith("image/") ||
        contentType.startsWith("video/") ||
        mediaUrlPattern.test(moduleUrl.toLowerCase());

      if (isMediaUrl) {
        if (isContextMenuMode) {
          await OBR.notification.show(
            "Context menu import only supports wall-data files (.uvtt, .dd2vtt, .json, or .zip).",
            "WARNING",
          );
          if (fileInputRef.current) fileInputRef.current.value = "";
          setIsLoading(false);
          return;
        }

        const mediaBlob = await res.blob();
        const fileName =
          moduleUrl.split("/").pop()?.split("?")[0] || "downloaded.asset";
        const file = new File([mediaBlob], fileName, { type: mediaBlob.type });
        processMediaFile(file);
        if (fileInputRef.current) fileInputRef.current.value = "";
        setIsLoading(false);
        return;
      }

      // Next, try parsing it as text/json
      const text = await clonedRes.text();
      let fileData;
      try {
        fileData = JSON.parse(text);
      } catch {
        throw new Error(
          "Target file was not a valid ZIP archive or JSON formatted string.",
        );
      }

      const fileName =
        moduleUrl.split("/").pop()?.split("?")[0] || "downloaded.json";
      const blob = new Blob([text], { type: "application/json" });

      await processJsonData(fileData, fileName, blob);
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch (e: unknown) {
      console.error(e);
      const errorMessage = e instanceof Error ? e.message : "Unknown error";
      if (
        !errorMessage.includes("download manually") &&
        !errorMessage.includes("CORS block")
      ) {
        OBR.notification.show(`${errorMessage}`, "ERROR");
      }
    }
    setIsLoading(false);
  };

  const handleFileSelect = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    setManualDownloadUrl(null);
    const files = Array.from(event.target.files ?? []);
    if (files.length === 0) return;

    resetMapWorkflowState();

    if (files.length > 1) {
      if (isContextMenuMode) {
        await OBR.notification.show(
          "Context menu import accepts one wall-data file at a time (.uvtt, .dd2vtt, .json, or .zip).",
          "WARNING",
        );
        if (fileInputRef.current) {
          fileInputRef.current.value = "";
        }
        return;
      }

      const mediaFiles = files.filter((file) => isRawMediaFile(file));
      const jsonFiles = files.filter((file) => !isRawMediaFile(file));

      const isSingleSceneMediaWithWallsSelection =
        !isContextMenuMode &&
        files.length === 2 &&
        mediaFiles.length === 1 &&
        jsonFiles.length === 1 &&
        isJsonDataFile(jsonFiles[0]);

      if (isSingleSceneMediaWithWallsSelection) {
        try {
          const wallData = await parseWallDataFile(jsonFiles[0]);
          const mediaFile = mediaFiles[0];

          setSelectedFile(mediaFile);
          setSelectedWallDataFile(jsonFiles[0]);
          setSelectedWallData(wallData);
          setSelectedRawFiles([]);
          setAvailableScenes([]);
          setSelectedSceneIndices([]);
          setZipObject(null);
          setIsFoundryFormat(false);
          setHasImage(true);
          return;
        } catch (error) {
          const message =
            error instanceof Error
              ? error.message
              : "Could not parse wall data JSON.";
          await OBR.notification.show(message, "WARNING");
          if (fileInputRef.current) {
            fileInputRef.current.value = "";
          }
          return;
        }
      }

      if (!files.every((file) => isRawMediaFile(file))) {
        await OBR.notification.show(
          "Select image/video files only, or select exactly one image/video file plus one wall data JSON file.",
          "WARNING",
        );
        if (fileInputRef.current) {
          fileInputRef.current.value = "";
        }
        return;
      }

      setSelectedRawFiles(files);
      setSelectedFile(null);
      setSelectedWallDataFile(null);
      setSelectedWallData(null);
      setAvailableScenes([]);
      setSelectedSceneIndices([]);
      setZipObject(null);
      setIsFoundryFormat(false);
      setHasImage(true);
      return;
    }

    const file = files[0];
    if (file) {
      setSelectedWallDataFile(null);
      setSelectedWallData(null);
      setSelectedRawFiles([]);
      const fileName = file.name.toLowerCase();
      if (fileName.endsWith(".zip")) {
        await handleZipFile(file);
        if (fileInputRef.current) fileInputRef.current.value = "";
        return;
      }

      if (isRawMediaFile(file)) {
        if (isContextMenuMode) {
          await OBR.notification.show(
            "Context menu import only supports wall-data files (.uvtt, .dd2vtt, .json, or .zip).",
            "WARNING",
          );
          if (fileInputRef.current) {
            fileInputRef.current.value = "";
          }
          return;
        }
        processMediaFile(file);
        return;
      }

      const isValidExtension =
        fileName.endsWith(".uvtt") ||
        fileName.endsWith(".dd2vtt") ||
        fileName.endsWith(".json");
      // On iOS, the file might not have the correct extension but still be valid JSON
      const isValidType =
        isValidExtension ||
        file.type === "application/json" ||
        file.type === "application/octet-stream";

      if (isValidType) {
        try {
          const content = await file.text();
          const fileData = JSON.parse(content);

          await processJsonData(fileData, file.name, file);
        } catch (error: unknown) {
          console.error("Error parsing file:", error);
          const errMessage = error instanceof Error ? error.message : "";

          if (errMessage.includes("CORS blocked auto-download")) {
            // Hide toast since we now display the in-app fallback UI instead
          } else if (errMessage.includes("HTTP Error")) {
            await OBR.notification.show(errMessage, "ERROR");
          } else {
            await OBR.notification.show(
              "Error reading file. Make sure it's a valid VTT file, module package, image, or video.",
              "WARNING",
            );
          }

          if (fileInputRef.current) {
            fileInputRef.current.value = "";
          }
          setSelectedFile(null);
          setSelectedWallDataFile(null);
          setSelectedWallData(null);
          setIsFoundryFormat(false);
          setHasImage(false);
        }
      } else {
        await OBR.notification.show(
          "Please select a valid .uvtt, .dd2vtt, .json, .zip, image, or video file",
          "WARNING",
        );
        if (fileInputRef.current) {
          fileInputRef.current.value = "";
        }
        setSelectedFile(null);
        setSelectedWallDataFile(null);
        setSelectedWallData(null);
        setIsFoundryFormat(false);
        setHasImage(false);
      }
    }
  };

  const buildVideoCompressionOptions = (
    abortSignal?: AbortSignal,
  ): VideoCompressionOptions => {
    const parsedMaxDimension = Number(maxVideoDimension);
    return {
      preferredCodec: preferredVideoCodec,
      keepAudio: !removeVideoAudio,
      forceTranscodeUnderLimit: forceVideoTranscode,
      ...(abortSignal ? { abortSignal } : {}),
      ...(Number.isFinite(parsedMaxDimension) && parsedMaxDimension > 0
        ? { maxDimension: parsedMaxDimension }
        : {}),
    };
  };

  const getLayoutScale = (): number => {
    const parsed = Number(layoutScalePercent);
    if (!Number.isFinite(parsed) || parsed <= 0) return 1;
    return Math.max(0.1, parsed / 100);
  };

  const getLayoutSpacing = (): number => {
    const parsed = Number(layoutSpacing);
    if (!Number.isFinite(parsed) || parsed < 0) return 80;
    return Math.round(parsed);
  };

  const buildMapSelectionToken = (
    sources: MapImportSource[],
    settingsFingerprint: string,
  ): string => {
    const signature = sources
      .map((source, index) => {
        const media = source.mediaBlob;
        const fileLike = media as File;
        const lastModified =
          typeof fileLike.lastModified === "number" ? fileLike.lastModified : 0;
        const wallData = source.wallData;
        const wallResolution = wallData?.resolution;

        return [
          index,
          source.name,
          media.type,
          media.size,
          lastModified,
          Math.round(source.dpi ?? 0),
          wallResolution?.pixels_per_grid ?? 0,
          wallResolution?.map_size?.x ?? 0,
          wallResolution?.map_size?.y ?? 0,
        ].join("|");
      })
      .concat(settingsFingerprint)
      .join("||");

    return `scene-importer:${hashMapSourceSignature(signature)}`;
  };

  const buildMapSelectionSettingsFingerprint = (
    action: PendingMapSelectionAction,
  ): string => {
    return JSON.stringify({
      action,
      compressionMode,
      preferredVideoCodec,
      removeVideoAudio,
      forceVideoTranscode,
      maxVideoDimension,
    });
  };

  const buildMapImportSources = async (): Promise<MapImportSource[]> => {
    const sources: MapImportSource[] = [];

    if (availableScenes.length > 0) {
      if (!zipObject) {
        throw new Error("Scene archive is not loaded.");
      }

      for (const scene of selectedScenes) {
        if (!isFoundryVTTData(scene.data)) continue;
        const imgPath = scene.data.img || scene.data.background?.src;
        if (!imgPath) continue;

        const mediaBlob = await extractImageFromZip(zipObject, imgPath);
        const wallData = convertFoundryToVTTData(scene.data);
        sources.push({
          name: scene.name || "Map",
          mediaBlob,
          dpi: wallData.resolution.pixels_per_grid,
          wallData,
        });
      }

      return sources;
    }

    const mediaFiles =
      selectedRawFiles.length > 0
        ? selectedRawFiles
        : selectedFile && isRawMediaFile(selectedFile)
          ? [selectedFile]
          : [];

    for (const file of mediaFiles) {
      const companionData =
        selectedWallData && mediaFiles.length === 1 && file === selectedFile
          ? selectedWallData
          : undefined;
      sources.push({
        name: file.name,
        mediaBlob: file,
        dpi: 100,
        wallData: companionData
          ? isFoundryVTTData(companionData)
            ? convertFoundryToVTTData(companionData)
            : companionData
          : undefined,
      });
    }

    return sources;
  };

  const resetMapWorkflowState = () => {
    if (mapSelectionToken) {
      clearMapSelectionState(mapSelectionToken);
    }
    setPendingMapSelection(null);
    setMapSelectionToken(null);
    setLastMapWorkflowAction(null);
  };

  const handleAddMapsToCurrentScene = async (
    runOptions: MapWorkflowRunOptions = {},
  ) => {
    setIsLoading(true);
    setUploadProgress(0);
    setCompressionStage("Preparing maps");

    try {
      const sources = await buildMapImportSources();
      if (sources.length === 0) {
        await OBR.notification.show(
          "No map images were found in the current selection.",
          "WARNING",
        );
        return;
      }

      const abortController = new AbortController();
      compressionAbortRef.current = abortController;

      const computedSelectionToken = buildMapSelectionToken(
        sources,
        buildMapSelectionSettingsFingerprint("add-current"),
      );
      if (runOptions.resetSelectionCache) {
        clearMapSelectionState(computedSelectionToken);
      }

      const hasMatchingPendingSelection =
        pendingMapSelection?.action === "add-current" &&
        pendingMapSelection.token === computedSelectionToken;

      const activeSelectionToken = runOptions.resetSelectionCache
        ? computedSelectionToken
        : hasMatchingPendingSelection
          ? pendingMapSelection.token
          : mapSelectionToken === computedSelectionToken
            ? mapSelectionToken
            : computedSelectionToken;

      const result = await addMapsToCurrentScene(sources, {
        layout: layoutMode,
        spacing: getLayoutSpacing(),
        scale: getLayoutScale(),
        placement: mapPlacementMode,
        includeWalls: includeWallsWithMaps,
        lockMaps: lockImportedMaps,
        compressionMode,
        selectionToken: activeSelectionToken,
        forceSelectionPrompt: !!runOptions.forceSelectionPrompt,
        videoOptions: buildVideoCompressionOptions(abortController.signal),
        onProgress: setUploadProgress,
        onStage: setCompressionStage,
      });

      await showMapWorkflowMismatchWarning(result);

      setMapSelectionToken(activeSelectionToken);
      setPendingMapSelection(null);
      setLastMapWorkflowAction("add-current");
      await OBR.notification.show("Maps added to current scene.", "SUCCESS");
      if (isContextMenuMode) {
        await OBR.modal.close("com.eppinguin.scene-importer/modal");
      }
    } catch (error) {
      if (error instanceof MapSelectionPendingError) {
        setMapSelectionToken(error.token);
        setPendingMapSelection({ token: error.token, action: "add-current" });
        setLastMapWorkflowAction("add-current");
        await OBR.notification.show(
          "No maps were selected. Click Continue Map Selection to reopen the picker without re-uploading.",
          "INFO",
        );
        return;
      }
      console.error("Error adding maps to scene:", error);
      const message = error instanceof Error ? error.message : "Unknown error";
      await OBR.notification.show(`Error adding maps: ${message}`, "ERROR");
    } finally {
      compressionAbortRef.current = null;
      setUploadProgress(null);
      setCompressionStage(null);
      setIsLoading(false);
    }
  };

  const handleCreateMultiMapScene = async (
    runOptions: MapWorkflowRunOptions = {},
  ) => {
    setIsLoading(true);
    setUploadProgress(0);
    setCompressionStage("Preparing maps");

    try {
      const sources = await buildMapImportSources();
      if (sources.length === 0) {
        await OBR.notification.show(
          "No map images were found in the current selection.",
          "WARNING",
        );
        return;
      }

      const abortController = new AbortController();
      compressionAbortRef.current = abortController;

      const computedSelectionToken = buildMapSelectionToken(
        sources,
        buildMapSelectionSettingsFingerprint("multi-scene"),
      );
      if (runOptions.resetSelectionCache) {
        clearMapSelectionState(computedSelectionToken);
      }

      const hasMatchingPendingSelection =
        pendingMapSelection?.action === "multi-scene" &&
        pendingMapSelection.token === computedSelectionToken;

      const activeSelectionToken = runOptions.resetSelectionCache
        ? computedSelectionToken
        : hasMatchingPendingSelection
          ? pendingMapSelection.token
          : mapSelectionToken === computedSelectionToken
            ? mapSelectionToken
            : computedSelectionToken;

      const result = await createSceneWithMultipleMaps(sources, {
        layout: layoutMode,
        spacing: getLayoutSpacing(),
        scale: getLayoutScale(),
        includeWalls: includeWallsWithMaps,
        lockMaps: lockImportedMaps,
        compressionMode,
        sceneName: multiSceneName,
        selectionToken: activeSelectionToken,
        forceSelectionPrompt: !!runOptions.forceSelectionPrompt,
        videoOptions: buildVideoCompressionOptions(abortController.signal),
        onProgress: setUploadProgress,
        onStage: setCompressionStage,
      });

      await showMapWorkflowMismatchWarning(result);

      setMapSelectionToken(activeSelectionToken);
      setPendingMapSelection(null);
      setLastMapWorkflowAction("multi-scene");
      await OBR.notification.show("Multi-map scene created.", "SUCCESS");
      await OBR.modal.close("com.eppinguin.scene-importer/modal");
    } catch (error) {
      if (error instanceof MapSelectionPendingError) {
        setMapSelectionToken(error.token);
        setPendingMapSelection({ token: error.token, action: "multi-scene" });
        setLastMapWorkflowAction("multi-scene");
        await OBR.notification.show(
          "No maps were selected. Click Continue Map Selection to reopen the picker without re-uploading.",
          "INFO",
        );
        return;
      }
      console.error("Error creating multi-map scene:", error);
      const message = error instanceof Error ? error.message : "Unknown error";
      await OBR.notification.show(`Error creating scene: ${message}`, "ERROR");
    } finally {
      compressionAbortRef.current = null;
      setUploadProgress(null);
      setCompressionStage(null);
      setIsLoading(false);
    }
  };

  const runMapWorkflowByAction = (
    action: PendingMapSelectionAction,
    runOptions: MapWorkflowRunOptions = {},
  ) => {
    if (action === "add-current") {
      void handleAddMapsToCurrentScene(runOptions);
      return;
    }
    void handleCreateMultiMapScene(runOptions);
  };

  const runMapWorkflowFromSelectionState = (
    runOptions: MapWorkflowRunOptions = {},
  ) => {
    const action =
      pendingMapSelection?.action ||
      lastMapWorkflowAction ||
      (shouldUseMultiMapSceneCreation ? "multi-scene" : "add-current");
    runMapWorkflowByAction(action, runOptions);
  };

  const handleImportToCurrentScene = () => {
    if (shouldPreferWallImportForCurrent && hasWallImportSources) {
      void handleAddWallsToCurrentScene();
      return;
    }
    runMapWorkflowByAction("add-current");
  };

  const handleCreateSceneDestination = () => {
    if (shouldUseMultiMapSceneCreation) {
      runMapWorkflowByAction("multi-scene");
      return;
    }
    void handleCreateNewScene();
  };

  const handleCreateNewScene = async () => {
    if (!selectedFile && availableScenes.length === 0) return;

    const waitForProgressFrame = async () => {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          window.setTimeout(resolve, 0);
        });
      });
    };

    setIsLoading(true);
    resetMapWorkflowState();
    setUploadProgress(0);
    setCompressionStage(
      selectedInputIsVideo ? "Preparing video encoder" : "Preparing image",
    );
    await waitForProgressFrame();
    try {
      const fileToUpload = selectedFile;
      const abortController = new AbortController();
      compressionAbortRef.current = abortController;
      const videoCompressionOptions = buildVideoCompressionOptions(
        abortController.signal,
      );

      if (availableScenes.length > 0 && zipObject) {
        const scene = availableScenes[selectedSceneIndex].data;
        if (!isFoundryVTTData(scene)) {
          throw new Error("Selected scene data is not compatible.");
        }
        const imgPath = scene.img || scene.background?.src;
        if (!imgPath) throw new Error("No image found for this scene.");

        const imgBlob = await extractImageFromZip(zipObject, imgPath);
        await uploadFoundryScene(
          scene,
          imgBlob,
          scene.name || "Foundry Scene",
          compressionMode,
          (progress) => setUploadProgress(progress),
          videoCompressionOptions,
          (stage) => setCompressionStage(stage),
        );
        // Compression done — clear progress bar, show uploading state
        setUploadProgress(null);
        setCompressionStage(null);
        setIsLoading(true);
      } else if (fileToUpload) {
        if (selectedWallData) {
          if (!isRawMediaFile(fileToUpload)) {
            throw new Error(
              "When using a wall data JSON companion file, the map file must be an image or video.",
            );
          }

          await uploadMediaSceneWithWallData(
            fileToUpload,
            selectedWallData,
            fileToUpload.name.replace(/\.[^/.]+$/, ""),
            compressionMode,
            (progress) => setUploadProgress(progress),
            videoCompressionOptions,
            (stage) => setCompressionStage(stage),
          );
        } else {
          await uploadSceneFromVTT(
            fileToUpload,
            compressionMode,
            (progress) => setUploadProgress(progress),
            videoCompressionOptions,
            (stage) => setCompressionStage(stage),
          );
        }
      }
      // Compression done — clear progress bar, show uploading state
      setUploadProgress(null);
      setCompressionStage(null);
      setIsLoading(true);

      OBR.modal.close("com.eppinguin.scene-importer/modal");
    } catch (error) {
      console.error("Error creating scene:", error);
      const getErrorMessage = (err: unknown): string => {
        if (err instanceof Error) return err.message;
        if (err && typeof err === "object") {
          const asRecord = err as Record<string, unknown>;
          const nested = asRecord.error as Record<string, unknown> | undefined;
          if (nested && typeof nested.message === "string")
            return nested.message;
          if (typeof asRecord.message === "string") return asRecord.message;
        }
        return "Unknown error";
      };
      const getErrorCode = (err: unknown): VideoCompressionErrorCode | null => {
        if (!err || typeof err !== "object") return null;
        const value = (err as { code?: unknown }).code;
        if (typeof value !== "string") return null;
        return value as VideoCompressionErrorCode;
      };
      const toNotificationMessage = (text: string, max = 240): string =>
        text.length <= max ? text : `${text.slice(0, max - 1)}…`;

      const message = getErrorMessage(error);
      const errorCode = getErrorCode(error);
      const lowerMessage = message.toLowerCase();
      if (
        errorCode === "VIDEO_COMPRESSION_ABORTED" ||
        lowerMessage.includes("aborted")
      ) {
        OBR.notification.show("Compression canceled.", "INFO");
      } else if (
        errorCode === "VIDEO_COMPRESSION_NO_PROGRESS" ||
        errorCode === "VIDEO_COMPRESSION_METADATA_FAILED" ||
        errorCode === "VIDEO_COMPRESSION_DECODE_FAILED" ||
        errorCode === "VIDEO_COMPRESSION_UNSUPPORTED_ENCODER" ||
        errorCode === "VIDEO_COMPRESSION_SIZE_LIMIT" ||
        errorCode === "VIDEO_COMPRESSION_SOURCE_TOO_LARGE"
      ) {
        OBR.notification.show(toNotificationMessage(message), "WARNING");
      } else if (
        lowerMessage.includes("timed out") ||
        lowerMessage.includes("stalled") ||
        lowerMessage.includes("hardware-accelerated")
      ) {
        OBR.notification.show(
          toNotificationMessage(
            "This browser could not finish video compression in time. Try a browser/device with hardware-accelerated video encoding, or lower Max video dimension.",
          ),
          "WARNING",
        );
      } else if (
        lowerMessage.includes("too large") ||
        lowerMessage.includes("size") ||
        lowerMessage.includes("limit") ||
        lowerMessage.includes("validation")
      ) {
        const hint =
          compressionMode === "high"
            ? "Bestling may exceed your account upload limit. Try Standard mode or reduce Max video dimension in Advanced options."
            : "Try reducing Max video dimension in Advanced options or using H.264 codec.";
        const suffix = message.endsWith(".") ? "" : ".";
        OBR.notification.show(
          toNotificationMessage(`${message}${suffix} ${hint}`),
          "WARNING",
        );
      } else {
        OBR.notification.show(
          toNotificationMessage(`Failed to create scene: ${message}`),
          "ERROR",
        );
      }
    } finally {
      compressionAbortRef.current = null;
      setUploadProgress(null);
      setCompressionStage(null);
      setIsLoading(false);
    }
  };

  const handleAddWallsToCurrentScene = async () => {
    if (!selectedFile && availableScenes.length === 0) return;
    if (availableScenes.length > 0 && !selectedSceneHasWallData) {
      await OBR.notification.show(
        "Selected scene has no walls or doors to import.",
        "INFO",
      );
      return;
    }

    setIsLoading(true);
    try {
      if (!isContextMenuMode && hasMapWorkflowSources) {
        const sources = await buildMapImportSources();
        const result = await addWallsToCurrentSceneWithLayout(sources, {
          layout: layoutMode,
          spacing: getLayoutSpacing(),
          scale: getLayoutScale(),
          placement: "ORIGIN",
        });          

        await showMapWorkflowMismatchWarning(result);

        if (result.wallsAppliedToMapCount === 0) {
          await OBR.notification.show(
            "No walls or doors were found for the selected maps.",
            "INFO",
          );
        } else {
          await OBR.notification.show(
            `Imported walls/doors for ${result.wallsAppliedToMapCount} map(s).`,
            "SUCCESS",
          );
        }
      } else if (selectedWallData) {
        await addItemsFromData(
          isFoundryVTTData(selectedWallData)
            ? convertFoundryToVTTData(selectedWallData)
            : selectedWallData,
          isContextMenuMode,
        );
      } else if (availableScenes.length > 0) {
        const s = availableScenes[selectedSceneIndex];
        if (s) {
          const wallData = isFoundryVTTData(s.data)
            ? convertFoundryToVTTData(s.data)
            : (s.data as VTTMapData);
          await addItemsFromData(wallData, isContextMenuMode);
        }
      } else if (selectedFile) {
        await addItemsFromVTT(selectedFile, isContextMenuMode);
      }

      if (isContextMenuMode) {
        await OBR.modal.close("com.eppinguin.scene-importer/modal");
      }
    } catch (error) {
      console.error("Error adding items to scene:", error);
      let errorMessage = "Unknown error";
      if (error instanceof Error) {
        errorMessage = error.message;
      } else if (error && typeof error === "object") {
        const asRecord = error as Record<string, unknown>;
        if (typeof asRecord.message === "string") {
          errorMessage = asRecord.message;
        }
      }
      OBR.notification.show(`Error adding to scene: ${errorMessage}`, "ERROR");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Box className={containerClassName} ref={containerRef}>
      {!isGM ? (
        <Typography variant="body2">
          This extension requires GM privileges to use.
        </Typography>
      ) : (
        <>
          <Typography variant="h6" sx={{ fontWeight: 600 }}>
            Scene Importer
          </Typography>

          <Stack className="file-upload" spacing={1}>
            <input
              type="file"
              multiple
              accept=".uvtt,.dd2vtt,.json,.zip,application/json,application/octet-stream,application/zip,image/*,video/*"
              capture={undefined}
              onChange={handleFileSelect}
              ref={fileInputRef}
              className="file-input"
              disabled={isLoading}
            />

            {showUrlInput ? (
              <Stack className="url-upload" spacing={1}>
                <TextField
                  value={moduleUrl}
                  onChange={(e) => setModuleUrl(e.target.value)}
                  placeholder="Enter asset URL (e.g. .uvtt, .zip, image, or video)"
                  size="small"
                  fullWidth
                  disabled={isLoading}
                />
                <Stack className="inline-actions" direction="row" spacing={1}>
                  <Button
                    onClick={handleFetchUrl}
                    disabled={!moduleUrl || isLoading}
                    variant="contained"
                    sx={{ flex: 1 }}>
                    Fetch from URL
                  </Button>
                  <Button
                    onClick={() => setShowUrlInput(false)}
                    disabled={isLoading}
                    variant="outlined">
                    Cancel
                  </Button>
                </Stack>
              </Stack>
            ) : (
              <Button
                onClick={() => setShowUrlInput(true)}
                disabled={isLoading}
                variant="text"
                size="small"
                sx={{ alignSelf: "flex-start", px: 0.5 }}>
                Import from URL instead
              </Button>
            )}

            {manualDownloadUrl && (
              <Box className="options notice-card">
                <Typography variant="subtitle2" sx={{ mb: 1 }}>
                  Manual Download Required
                </Typography>
                <Typography variant="body2" className="notice-text">
                  The host server rigidly blocked our ability to automatically
                  fetch this file. Please download it manually to your system
                  and then upload the resulting file here!
                </Typography>
                <Button
                  href={manualDownloadUrl}
                  target="_blank"
                  rel="noreferrer"
                  variant="contained"
                  fullWidth>
                  Download File Manually
                </Button>
              </Box>
            )}

            {selectedFile && (
              <Box className="selected-file-block">
                <Typography className="selected-file" variant="body2">
                  Selected: {selectedFile.name}
                </Typography>
                <Typography className="file-info" variant="caption">
                  {(isFoundryFormat || !hasImage) &&
                    "No map image found (walls and doors only)"}
                </Typography>
                {selectedWallDataFile && (
                  <Typography className="file-info" variant="caption">
                    Walls JSON: {selectedWallDataFile.name}
                  </Typography>
                )}
              </Box>
            )}

            {selectedRawFiles.length > 0 && (
              <Box className="selected-file-block">
                <Typography className="selected-file" variant="body2">
                  Selected files: {selectedRawFiles.length}
                </Typography>
                <Typography className="file-info" variant="caption">
                  {selectedRawFiles
                    .slice(0, 3)
                    .map((file) => file.name)
                    .join(", ")}
                  {selectedRawFiles.length > 3 ? "..." : ""}
                </Typography>
              </Box>
            )}

            {availableScenes.length > 0 && (
              <Box className="scene-selection section-gap">
                <Typography variant="subtitle2" sx={{ mb: 1 }}>
                  {isContextMenuMode || !useMultiSceneSelectionLabel
                    ? `Select Scene (${availableScenes.length} found)`
                    : `Select Maps (${selectedScenes.length}/${availableScenes.length})`}
                </Typography>
                {!isContextMenuMode && availableScenes.length > 1 && (
                  <Typography variant="caption" className="help-text" sx={{ mb: 0.5 }}>
                    Click to select one map. Hold Shift to select a range. Hold Cmd/Ctrl and click to toggle selection.
                  </Typography>
                )}
                <div
                  className="scene-gallery"
                  onClickCapture={() => {
                    if (!canHoverPreview || !hoveredSceneThumb) return;
                    suppressedPreviewCardIndexRef.current = previewSourceIndexRef.current;
                    clearPreviewOpenTimeout();
                    clearPreviewHideTimeout();
                    setHoveredSceneThumb(null);
                  }}
                  onScroll={() => setHoveredSceneThumb(null)}>
                  {availableScenes.map((s, idx) => (
                    <div
                      key={idx}
                      className={`scene-card ${(isContextMenuMode
                        ? selectedSceneIndex === idx
                        : selectedSceneIndices.includes(idx))
                        ? "selected"
                        : ""}`}
                      onClick={(event) => {
                        if (suppressNextCardClickRef.current) {
                          suppressNextCardClickRef.current = false;
                          return;
                        }

                        const anchorIndex = Math.min(
                          Math.max(selectedSceneIndex, 0),
                          Math.max(availableScenes.length - 1, 0),
                        );
                        setSelectedSceneIndex(idx);
                        setHasImage(!!(s.data.img || s.data.background?.src));

                        if (isContextMenuMode) {
                          setSelectedSceneIndices([idx]);
                          return;
                        }

                        const isRangeSelect = event.shiftKey;
                        const isMultiSelectToggle =
                          event.metaKey || event.ctrlKey;

                        if (isRangeSelect) {
                          const start = Math.min(anchorIndex, idx);
                          const end = Math.max(anchorIndex, idx);
                          const range = Array.from(
                            { length: end - start + 1 },
                            (_, offset) => start + offset,
                          );

                          if (isMultiSelectToggle) {
                            setSelectedSceneIndices((previous) => {
                              const merged = new Set([...previous, ...range]);
                              return Array.from(merged).sort((a, b) => a - b);
                            });
                            return;
                          }

                          setSelectedSceneIndices(range);
                          return;
                        }

                        if (!isMultiSelectToggle) {
                          setSelectedSceneIndices([idx]);
                          return;
                        }

                        setSelectedSceneIndices((previous) => {
                          const exists = previous.includes(idx);
                          const next = exists
                            ? previous.filter((value) => value !== idx)
                            : [...previous, idx];
                          return next.length > 0 ? next : [idx];
                        });
                      }}
                      onMouseEnter={() => {
                        if (!canHoverPreview || !s.thumbUrl) return;
                        if (suppressedPreviewCardIndexRef.current === idx) return;
                        const preview = {
                          url: s.thumbUrl,
                          isVideo: s.isVideo,
                        };

                        if (hoveredSceneThumb) {
                          clearPreviewOpenTimeout();
                          clearPreviewHideTimeout();
                          previewSourceIndexRef.current = idx;
                          setHoveredSceneThumb(preview);
                          return;
                        }

                        schedulePreviewOpen(
                          idx,
                          preview,
                          PREVIEW_HOVER_OPEN_DELAY_MS,
                        );
                      }}
                      onMouseLeave={() => {
                        if (!canHoverPreview) return;
                        if (suppressedPreviewCardIndexRef.current === idx) {
                          suppressedPreviewCardIndexRef.current = null;
                        }
                        hideHoverPreviewSoon();
                      }}
                      onPointerDown={(event) => {
                        if (canHoverPreview || !s.thumbUrl) return;
                        if (
                          event.pointerType !== "touch" &&
                          event.pointerType !== "pen"
                        ) {
                          return;
                        }

                        touchPreviewPressStartedAtRef.current = Date.now();

                        schedulePreviewOpen(
                          idx,
                          {
                            url: s.thumbUrl,
                            isVideo: s.isVideo,
                          },
                          PREVIEW_TOUCH_OPEN_DELAY_MS,
                          () => {
                            suppressNextCardClickRef.current = true;
                          },
                        );
                      }}
                      onPointerUp={() => {
                        if (canHoverPreview) return;
                        const pressStartedAt = touchPreviewPressStartedAtRef.current;
                        touchPreviewPressStartedAtRef.current = null;

                        if (!s.thumbUrl || pressStartedAt === null) {
                          clearPreviewOpenTimeout();
                          return;
                        }

                        const elapsedMs = Date.now() - pressStartedAt;
                        if (
                          !hoveredSceneThumb &&
                          elapsedMs >= PREVIEW_TOUCH_RELEASE_THRESHOLD_MS
                        ) {
                          clearPreviewOpenTimeout();
                          clearPreviewHideTimeout();
                          previewSourceIndexRef.current = idx;
                          setHoveredSceneThumb({
                            url: s.thumbUrl,
                            isVideo: s.isVideo,
                          });
                          suppressNextCardClickRef.current = true;
                          return;
                        }

                        clearPreviewOpenTimeout();
                      }}
                      onPointerCancel={() => {
                        if (canHoverPreview) return;
                        touchPreviewPressStartedAtRef.current = null;
                        clearPreviewOpenTimeout();
                      }}
                      onPointerLeave={() => {
                        if (canHoverPreview) return;
                        touchPreviewPressStartedAtRef.current = null;
                        clearPreviewOpenTimeout();
                      }}
                      >
                      <div className="scene-thumb-container">
                        {s.isVideo && (
                          <div className="video-badge">
                            <svg viewBox="0 0 24 24" fill="currentColor">
                              <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z" />
                            </svg>
                          </div>
                        )}
                        {s.thumbUrl ? (
                          s.isVideo ? (
                            <video
                              src={s.thumbUrl}
                              className="scene-thumb"
                              autoPlay={selectedSceneIndex === idx}
                              loop
                              muted
                              playsInline
                              preload={
                                selectedSceneIndex === idx ? "metadata" : "none"
                              }
                            />
                          ) : (
                            <img
                              src={s.thumbUrl}
                              className="scene-thumb"
                              alt={s.name}
                              loading="lazy"
                              decoding="async"
                            />
                          )
                        ) : (
                          <span className="scene-thumb-placeholder">
                            No Preview
                          </span>
                        )}
                      </div>
                      <div
                        className="scene-name"
                        title={s.name || `Scene ${idx + 1}`}>
                        {s.name || `Scene ${idx + 1}`}
                      </div>
                    </div>
                  ))}
                </div>
              </Box>
            )}

            {!isContextMenuMode &&
              hasMapWorkflowSources &&
              selectedSourceCount <= 1 && (
                <Button
                  onClick={() =>
                    setShowMapLayoutOptions((previous) => !previous)
                  }
                  disabled={isLoading}
                  variant="text"
                  size="small"
                  sx={{ alignSelf: "flex-start", px: 0.5 }}>
                  {showMapLayoutOptions
                    ? "Hide map layout options"
                    : "Show map layout options"}
                </Button>
              )}

            {shouldShowMapLayoutOptions && (
              <Box className="options section-gap">
                <Typography variant="subtitle2" sx={{ mb: 1 }}>
                  Map Layout Options
                </Typography>
                <Stack spacing={1}>
                  <Typography variant="caption" className="help-text">
                    Selected sources: {selectedSourceCount}
                    {pendingMapSelection ? " - selection pending" : ""}
                  </Typography>

                  {shouldUseMultiMapSceneCreation && (
                    <TextField
                      label="New Scene Name"
                      value={multiSceneName}
                      onChange={(e) => setMultiSceneName(e.target.value)}
                      size="small"
                      fullWidth
                      disabled={isLoading}
                    />
                  )}

                  <FormControl fullWidth size="small">
                    <InputLabel id="layout-mode-label">Layout</InputLabel>
                    <Select
                      labelId="layout-mode-label"
                      label="Layout"
                      value={layoutMode}
                      onChange={(e) =>
                        setLayoutMode(e.target.value as MapLayoutMode)
                      }
                      disabled={isLoading}>
                      <MenuItem value="GRID">Grid (auto columns)</MenuItem>
                      <MenuItem value="ROW">Single row</MenuItem>
                      <MenuItem value="COLUMN">Single column</MenuItem>
                      <MenuItem value="STACK">Stacked on top of each other</MenuItem>
                    </Select>
                  </FormControl>

                  <Button
                    onClick={() => setShowAdvancedLayoutOptions(!showAdvancedLayoutOptions)}
                    disabled={isLoading}
                    variant="text"
                    size="small"
                    sx={{ alignSelf: "flex-start", px: 0.5 }}>
                    {showAdvancedLayoutOptions
                      ? "Hide advanced layout options"
                      : "Show advanced layout options"}
                  </Button>

                  {showAdvancedLayoutOptions && (
                    <Stack className="advanced-layout-options" spacing={1}>
                      {hasMapWorkflowSources && (
                        <FormControl fullWidth size="small">
                          <InputLabel id="placement-mode-label">
                           Map Placement
                          </InputLabel>
                          <Select
                            labelId="placement-mode-label"
                            label="Placement"
                            value={mapPlacementMode}
                            onChange={(e) =>
                              setMapPlacementMode(e.target.value as MapPlacementMode)
                            }
                            disabled={isLoading}>
                            <MenuItem value="RIGHT">
                              Place Right of Existing
                            </MenuItem>
                            <MenuItem value="BELOW">
                              Place Below Existing
                            </MenuItem>
                            <MenuItem value="ORIGIN">Place at Origin</MenuItem>
                          </Select>
                        </FormControl>
                      )}

                      <TextField
                        type="number"
                        label="Spacing (px)"
                        value={layoutSpacing}
                        onChange={(e) => setLayoutSpacing(e.target.value)}
                        inputProps={{ min: 0, step: 1 }}
                        size="small"
                        fullWidth
                        disabled={isLoading}
                      />

                      <TextField
                        type="number"
                        label="Scale (%)"
                        value={layoutScalePercent}
                        onChange={(e) => setLayoutScalePercent(e.target.value)}
                        inputProps={{ min: 10, step: 5 }}
                        size="small"
                        fullWidth
                        disabled={isLoading}
                      />

                      <FormControlLabel
                        control={
                          <Checkbox
                            size="small"
                            checked={includeWallsWithMaps}
                            onChange={(e) =>
                              setIncludeWallsWithMaps(e.target.checked)
                            }
                            disabled={isLoading}
                          />
                        }
                        label="Include walls/doors when available"
                      />

                      <FormControlLabel
                        control={
                          <Checkbox
                            size="small"
                            checked={lockImportedMaps}
                            onChange={(e) => setLockImportedMaps(e.target.checked)}
                            disabled={isLoading}
                          />
                        }
                        label="Lock placed maps"
                      />
                    </Stack>
                  )}
                </Stack>
              </Box>
            )}
          </Stack>

          {hoveredSceneThumb && (
            <div
              className={`scene-preview-float${canHoverPreview ? " hover-through" : ""}`}
              role="button"
              tabIndex={0}
              onMouseEnter={() => {
                clearPreviewHideTimeout();
              }}
              onMouseLeave={() => {
                hideHoverPreviewSoon();
              }}
              onClick={() => {
                suppressedPreviewCardIndexRef.current = previewSourceIndexRef.current;
                clearPreviewOpenTimeout();
                clearPreviewHideTimeout();
                setHoveredSceneThumb(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape" || event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  suppressedPreviewCardIndexRef.current = previewSourceIndexRef.current;
                  clearPreviewOpenTimeout();
                  clearPreviewHideTimeout();
                  setHoveredSceneThumb(null);
                }
              }}>
              {hoveredSceneThumb.isVideo ? (
                <video
                  src={hoveredSceneThumb.url}
                  autoPlay
                  loop
                  muted
                  playsInline
                />
              ) : (
                <img src={hoveredSceneThumb.url} alt="Enlarged preview" />
              )}
            </div>
          )}

          {hasImage && !isContextMenuMode && (
            <Box className="options">
              <Typography variant="subtitle2" sx={{ mb: 1 }}>
                Import Options
              </Typography>
              <Stack className="compression-options" spacing={1}>
                <FormControl fullWidth size="small">
                  <InputLabel id="compression-mode-label">
                    Compression Mode
                  </InputLabel>
                  <Select
                    labelId="compression-mode-label"
                    label="Compression Mode"
                    value={compressionMode}
                    onChange={(e) =>
                      setCompressionMode(e.target.value as CompressionMode)
                    }
                    disabled={isLoading}>
                    <MenuItem value="none">No Compression</MenuItem>
                    <MenuItem value="standard" disabled={videoCompressionBlocked}>
                      {selectedInputIsVideo
                        ? "Nestling (Max 50MB)"
                        : "Nestling / Fledgeling (Max 25MB)"}
                    </MenuItem>
                    <MenuItem value="high" disabled={videoCompressionBlocked}>
                      {selectedInputIsVideo
                        ? "Fledgeling / Bestling (Max 100MB)"
                        : "Bestling Tier (Max 50MB)"}
                    </MenuItem>
                  </Select>
                </FormControl>

                {videoCompressionBlocked && videoCompressionSupportMessage && (
                  <Typography variant="caption" className="help-text" color="warning.main">
                    {videoCompressionSupportMessage}
                  </Typography>
                )}

                <Box className="compression-info">
                  {compressionMode === "none" && (
                    <Typography variant="body2">
                      Uploads the original file without modification. The upload
                      will fail if it exceeds your account's file size limit.
                    </Typography>
                  )}

                  {compressionMode === "standard" && (
                    <Typography variant="body2">
                      {selectedInputIsVideo
                        ? "Compresses the video to a maximum of 50MB to fit Nestling account limits."
                        : "Compresses the image to a maximum of 25MB to fit Nestling and Fledgeling account limits."}
                    </Typography>
                  )}

                  {compressionMode === "high" && (
                    <Typography variant="body2">
                      {selectedInputIsVideo
                        ? "Compresses the video to a maximum of 100MB to fit Fledgeling and Bestling account limits."
                        : "Compresses the image to a maximum of 50MB to fit Bestling account limits."}
                    </Typography>
                  )}
                </Box>

                {selectedInputIsVideo && (
                  <>
                    <Button
                      onClick={() =>
                        setShowAdvancedVideoOptions(!showAdvancedVideoOptions)
                      }
                      disabled={isLoading || videoCompressionBlocked}
                      variant="text"
                      size="small"
                      sx={{ alignSelf: "flex-start", px: 0.5 }}>
                      {showAdvancedVideoOptions
                        ? "Hide advanced video options"
                        : "Show advanced video options"}
                    </Button>

                    {showAdvancedVideoOptions && (
                      <Stack className="advanced-video-options" spacing={1}>
                        <FormControl fullWidth size="small">
                          <InputLabel id="video-codec-label">
                            Preferred Video Codec
                          </InputLabel>
                          <Select
                            labelId="video-codec-label"
                            label="Preferred Video Codec"
                            value={preferredVideoCodec}
                            onChange={(e) =>
                              setPreferredVideoCodec(
                                e.target.value as VideoCodecPreference,
                              )
                            }
                            disabled={isLoading || videoCompressionBlocked}>
                            <MenuItem value="auto">
                              Auto (AV1 - H.265 - VP9 - H.264)
                            </MenuItem>
                            <MenuItem
                              value="vp9"
                              disabled={
                                !!browserCodecAvailability &&
                                !browserCodecAvailability.vp9
                              }>
                              {browserCodecAvailability &&
                              !browserCodecAvailability.vp9
                                ? "VP9/WebM (not available in current browser)"
                                : "VP9/WebM"}
                            </MenuItem>
                            <MenuItem
                              value="av1"
                              disabled={!!browserCodecAvailability && !browserCodecAvailability.av1}>
                              {browserCodecAvailability && !browserCodecAvailability.av1
                                ? "AV1 (not available in current browser)"
                                : "AV1 (maximum compression)"}
                            </MenuItem>
                            <MenuItem
                              value="h265"
                              disabled={!!browserCodecAvailability && !browserCodecAvailability.h265}>
                              {browserCodecAvailability && !browserCodecAvailability.h265
                                ? "H.265/HEVC (not available in current browser)"
                                : "H.265/HEVC (high efficiency)"}
                            </MenuItem>
                            <MenuItem
                              value="h264"
                              disabled={!!browserCodecAvailability && !browserCodecAvailability.h264}>
                              {browserCodecAvailability && !browserCodecAvailability.h264
                                ? "H.264 (not available in current browser)"
                                : "H.264 (maximum compatibility)"}
                            </MenuItem>
                          </Select>
                        </FormControl>

                        {browserCodecAvailability && (
                          <Typography variant="caption" className="help-text">
                            Browser codec availability: AV1
                            {browserCodecAvailability.av1 ? " yes" : " no"},
                            H.265
                            {browserCodecAvailability.h265 ? " yes" : " no"},
                            VP9
                            {browserCodecAvailability.vp9 ? " yes" : " no"},
                            H.264
                            {browserCodecAvailability.h264 ? " yes" : " no"}
                          </Typography>
                        )}

                        <FormControlLabel
                          control={
                            <Checkbox
                              size="small"
                              checked={removeVideoAudio}
                              onChange={(e) =>
                                setRemoveVideoAudio(e.target.checked)
                              }
                              disabled={isLoading || videoCompressionBlocked}
                            />
                          }
                          label="Remove audio track"
                        />

                        <FormControlLabel
                          control={
                            <Checkbox
                              size="small"
                              checked={forceVideoTranscode}
                              onChange={(e) =>
                                setForceVideoTranscode(e.target.checked)
                              }
                              disabled={isLoading || videoCompressionBlocked}
                            />
                          }
                          label="Transcode anyway when already under size limit"
                        />

                        <TextField
                          type="number"
                          label="Max video dimension (optional)"
                          inputProps={{ min: 0, step: 1 }}
                          value={maxVideoDimension}
                          onChange={(e) => setMaxVideoDimension(e.target.value)}
                          placeholder="e.g. 1920"
                          disabled={isLoading || videoCompressionBlocked}
                          size="small"
                          fullWidth
                        />

                        <Typography variant="caption" className="help-text">
                          Limits the longest side in pixels (for example 1920).
                          Leave empty to keep original resolution.
                        </Typography>
                      </Stack>
                    )}
                  </>
                )}
              </Stack>
            </Box>
          )}

          {uploadProgress !== null && (
            <Box className="compression-progress">
              <Typography
                className="compression-progress-label"
                variant="caption">
                {selectedInputIsVideo
                  ? `${compressionStage ?? "Compressing video"} (${uploadProgress}%)`
                  : (compressionStage ?? "Compressing image…")}
              </Typography>
              <LinearProgress
                variant={selectedInputIsVideo ? "determinate" : "indeterminate"}
                value={selectedInputIsVideo ? uploadProgress : undefined}
                sx={{ height: 6, borderRadius: 999 }}
              />
              <Button
                variant="outlined"
                size="small"
                onClick={() => {
                  compressionAbortRef.current?.abort();
                  setUploadProgress(null);
                  setCompressionStage(null);
                }}>
                Cancel Compression
              </Button>
            </Box>
          )}

          {(pendingMapSelection || mapSelectionToken) &&
            hasMapWorkflowSources &&
            uploadProgress === null && (
              <Box
                sx={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "flex-end",
                  flexWrap: "wrap",
                  gap: 0.5,
                  mb: 0.5,
                }}>
                <Button
                  variant="text"
                  size="small"
                  sx={{ minWidth: "auto", px: 1 }}
                  onClick={() =>
                    runMapWorkflowFromSelectionState({ forceSelectionPrompt: true })
                  }
                  disabled={isLoading || !mapSelectionToken}>
                  Re-select
                </Button>
                <Button
                  variant="text"
                  size="small"
                  sx={{ minWidth: "auto", px: 1 }}
                  onClick={() =>
                    runMapWorkflowFromSelectionState({ resetSelectionCache: true })
                  }
                  disabled={
                    isLoading ||
                    selectedSourceCount === 0 ||
                    (availableScenes.length > 0 && !selectedSceneHasMap)
                  }>
                  Re-upload
                </Button>
                <Button
                  variant="text"
                  color="error"
                  size="small"
                  sx={{ minWidth: "auto", px: 1 }}
                  onClick={resetMapWorkflowState}
                  disabled={isLoading}>
                  Clear
                </Button>
              </Box>
            )}

          <Stack
            className="actions"
            direction={{ xs: "column", sm: "row" }}
            spacing={1}>
            {!isContextMenuMode && uploadProgress === null && (
              <Button
                onClick={handleImportToCurrentScene}
                variant="contained"
                disabled={
                  isLoading ||
                  uploadProgress !== null ||
                  !canImportToCurrentScene
                }>
                {uploadProgress !== null
                  ? `Compressing… ${uploadProgress}%`
                  : isLoading
                    ? "Uploading..."
                    : pendingMapSelection?.action === "add-current"
                      ? "Continue Import to Current Scene"
                      : "Import to Current Scene"}
              </Button>
            )}

            {!isContextMenuMode && uploadProgress === null && (
              <Button
                onClick={handleCreateSceneDestination}
                variant="outlined"
                disabled={
                  isLoading ||
                  uploadProgress !== null ||
                  !canCreateNewScene
                }>
                {!hasImage
                  ? "Create New Scene (No Map Image)"
                  : pendingMapSelection?.action === "multi-scene"
                    ? "Continue Create New Scene"
                    : "Create New Scene"}
              </Button>
            )}

            {!isContextMenuMode &&
              uploadProgress === null &&
              hasWallImportSources && (
                <Button
                  onClick={handleAddWallsToCurrentScene}
                  variant="text"
                  disabled={
                    isLoading ||
                    uploadProgress !== null ||
                    (availableScenes.length > 0 && !selectedSceneHasWallData)
                  }>
                  {isLoading
                    ? "Uploading..."
                    : availableScenes.length > 0 && !selectedSceneHasWallData
                      ? "No Walls In Selected Scene"
                      : "Import Walls Only"}
                </Button>
              )}

            {isContextMenuMode && uploadProgress === null && (
              <>
                <Button
                  onClick={handleAddWallsToCurrentScene}
                  variant="contained"
                  fullWidth
                  disabled={
                    (!selectedFile && availableScenes.length === 0) ||
                    isLoading ||
                    (availableScenes.length > 0 && !selectedSceneHasWallData)
                  }>
                  {isLoading
                    ? "Uploading..."
                    : availableScenes.length > 0 && !selectedSceneHasWallData
                      ? "No Walls In Selected Scene"
                      : "Import Walls to Selected Map"}
                </Button>
              </>
            )}

            {isLoading && uploadProgress === null && (
              <Button
                variant="text"
                color="error"
                size="small"
                onClick={() => {
                  compressionAbortRef.current?.abort();
                  setIsLoading(false);
                  setUploadProgress(null);
                  setCompressionStage(null);
                }}>
                Cancel
              </Button>
            )}
          </Stack>
        </>
      )}
    </Box>
  );
}

export default App;
