import { useState, useRef, useEffect } from "react";
import "./App.css";
import {
  uploadSceneFromVTT,
  addItemsFromVTT,
  addItemsFromData,
  uploadFoundryScene,
  extractImageFromZip,
  convertFoundryToVTTData,
  type CompressionMode,
  type VideoCompressionErrorCode,
  type VideoCodecPreference,
  type VideoCompressionOptions,
  isFoundryVTTData,
  hasMapImage,
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
    (Array.isArray(vttData.portals) && vttData.portals.length > 0)
  );
};

function App() {
  const isContextMenuMode =
    new URLSearchParams(window.location.search).get("context") === "true";
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [moduleUrl, setModuleUrl] = useState("");
  const [zipObject, setZipObject] = useState<JSZip | null>(null);
  const [availableScenes, setAvailableScenes] = useState<SceneInfo[]>([]);
  const [selectedSceneIndex, setSelectedSceneIndex] = useState(0);

  const [hoveredSceneThumb, setHoveredSceneThumb] = useState<{
    url: string;
    isVideo?: boolean;
  } | null>(null);
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
    useState<VideoCodecPreference>("vp9");
  const [removeVideoAudio, setRemoveVideoAudio] = useState(false);
  const [forceVideoTranscode, setForceVideoTranscode] = useState(false);
  const [maxVideoDimension, setMaxVideoDimension] = useState<string>("");

  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [compressionStage, setCompressionStage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [theme, setTheme] = useState<Theme | null>(null);
  const [isGM, setIsGM] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const compressionAbortRef = useRef<AbortController | null>(null);
  const heightRafRef = useRef<number | null>(null);
  const selectedModuleScene = availableScenes[selectedSceneIndex];
  const selectedSceneHasWallData = selectedModuleScene
    ? sceneHasWallData(selectedModuleScene.data)
    : true;
  const selectedSceneIsVideo = !!selectedModuleScene?.isVideo;
  const selectedFileIsVideo =
    !!selectedFile &&
    (selectedFile.type.startsWith("video/") ||
      /\.(mp4|webm|mov|avi|mkv|ogv)$/i.test(selectedFile.name.toLowerCase()));
  const selectedInputIsVideo =
    availableScenes.length > 0 ? selectedSceneIsVideo : selectedFileIsVideo;
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
        setSelectedFile(null);
        setIsFoundryFormat(true);
        const firstScene = scenes[0].data;
        setHasImage(!!(firstScene.img || firstScene.background?.src));
        OBR.notification.show(
          `Loaded module with ${scenes.length} scenes.`,
          "SUCCESS",
        );
      } else {
        OBR.notification.show("No scenes found in this ZIP.", "WARNING");
        setZipObject(null);
        setAvailableScenes([]);
      }
    } catch (e) {
      console.error(e);
      OBR.notification.show("Failed to parse ZIP file.", "ERROR");
      setZipObject(null);
      setAvailableScenes([]);
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
    setAvailableScenes([]);
    setZipObject(null);
  };

  const isRawMediaFile = (file: File): boolean => {
    const lowerName = file.name.toLowerCase();
    return (
      file.type.startsWith("image/") ||
      file.type.startsWith("video/") ||
      /\.(png|jpe?g|webp|avif|gif|bmp|mp4|webm|mov|avi|mkv|ogv)$/i.test(
        lowerName,
      )
    );
  };

  const processMediaFile = (file: File) => {
    setSelectedFile(file);
    setIsFoundryFormat(false);
    setHasImage(true);
    setAvailableScenes([]);
    setZipObject(null);
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
    const file = event.target.files?.[0];
    if (file) {
      const fileName = file.name.toLowerCase();
      if (fileName.endsWith(".zip")) {
        await handleZipFile(file);
        if (fileInputRef.current) fileInputRef.current.value = "";
        return;
      }

      if (isRawMediaFile(file)) {
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
        setIsFoundryFormat(false);
        setHasImage(false);
      }
    }
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
    setUploadProgress(0);
    setCompressionStage(
      selectedInputIsVideo ? "Preparing video encoder" : "Preparing image",
    );
    await waitForProgressFrame();
    try {
      const fileToUpload = selectedFile;
      const abortController = new AbortController();
      compressionAbortRef.current = abortController;
      const parsedMaxDimension = Number(maxVideoDimension);
      const videoCompressionOptions: VideoCompressionOptions = {
        preferredCodec: preferredVideoCodec,
        keepAudio: !removeVideoAudio,
        forceTranscodeUnderLimit: forceVideoTranscode,
        abortSignal: abortController.signal,
        ...(Number.isFinite(parsedMaxDimension) && parsedMaxDimension > 0
          ? { maxDimension: parsedMaxDimension }
          : {}),
      };

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
        await uploadSceneFromVTT(
          fileToUpload,
          compressionMode,
          (progress) => setUploadProgress(progress),
          videoCompressionOptions,
          (stage) => setCompressionStage(stage),
        );
      }
      // Compression done — clear progress bar, show uploading state
      setUploadProgress(null);
      setCompressionStage(null);
      setIsLoading(true);

      OBR.notification.show("Scene created successfully!", "SUCCESS");
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
      const s = availableScenes[selectedSceneIndex];
      if (s) {
        const wallData = isFoundryVTTData(s.data)
          ? convertFoundryToVTTData(s.data)
          : (s.data as VTTMapData);
        await addItemsFromData(wallData, isContextMenuMode);
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
              </Box>
            )}

            {availableScenes.length > 0 && (
              <Box className="scene-selection section-gap">
                <Typography variant="subtitle2" sx={{ mb: 1 }}>
                  Select Scene ({availableScenes.length} found)
                </Typography>
                <div
                  className="scene-gallery"
                  onScroll={() => setHoveredSceneThumb(null)}>
                  {availableScenes.map((s, idx) => (
                    <div
                      key={idx}
                      className={`scene-card ${selectedSceneIndex === idx ? "selected" : ""}`}
                      onClick={() => {
                        setSelectedSceneIndex(idx);
                        setHasImage(!!(s.data.img || s.data.background?.src));
                      }}
                      onMouseEnter={() => {
                        if (s.thumbUrl) {
                          setHoveredSceneThumb({
                            url: s.thumbUrl,
                            isVideo: s.isVideo,
                          });
                        }
                      }}
                      onMouseLeave={() => setHoveredSceneThumb(null)}>
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
          </Stack>

          {hoveredSceneThumb && (
            <div className="scene-preview-float">
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
                    <MenuItem value="standard">
                      {selectedInputIsVideo
                        ? "Nestling (Max 50MB)"
                        : "Nestling / Fledgeling (Max 25MB)"}
                    </MenuItem>
                    <MenuItem value="high">
                      {selectedInputIsVideo
                        ? "Fledgeling / Bestling (Max 100MB)"
                        : "Bestling Tier (Max 50MB)"}
                    </MenuItem>
                  </Select>
                </FormControl>

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

                <Button
                  onClick={() =>
                    setShowAdvancedVideoOptions(!showAdvancedVideoOptions)
                  }
                  disabled={isLoading}
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
                        disabled={isLoading}>
                        <MenuItem value="vp9">
                          VP9/WebM (default, balanced quality)
                        </MenuItem>
                        <MenuItem value="av1">
                          AV1 (maximum compression)
                        </MenuItem>
                        <MenuItem value="h264">
                          H.264 (maximum compatibility)
                        </MenuItem>
                      </Select>
                    </FormControl>

                    <FormControlLabel
                      control={
                        <Checkbox
                          size="small"
                          checked={removeVideoAudio}
                          onChange={(e) =>
                            setRemoveVideoAudio(e.target.checked)
                          }
                          disabled={isLoading}
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
                          disabled={isLoading}
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
                      disabled={isLoading}
                      size="small"
                      fullWidth
                    />

                    <Typography variant="caption" className="help-text">
                      Limits the longest side in pixels (for example 1920).
                      Leave empty to keep original resolution.
                    </Typography>
                  </Stack>
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

          <Stack
            className="actions"
            direction={{ xs: "column", sm: "row" }}
            spacing={1}>
            {!isContextMenuMode && uploadProgress === null && (
              <Button
                onClick={handleCreateNewScene}
                variant="contained"
                disabled={
                  (!selectedFile && availableScenes.length === 0) ||
                  isLoading ||
                  uploadProgress !== null ||
                  (isFoundryFormat && availableScenes.length === 0) ||
                  !hasImage
                }>
                {uploadProgress !== null
                  ? `Compressing… ${uploadProgress}%`
                  : isLoading
                    ? "Uploading..."
                    : isFoundryFormat && availableScenes.length === 0
                      ? "Scene Creation Not Available (Foundry File)"
                      : !hasImage
                        ? "Scene Creation Not Available (No Image)"
                        : "Create New Scene"}
              </Button>
            )}

            {uploadProgress === null && (
              <Button
                onClick={handleAddWallsToCurrentScene}
                variant={isContextMenuMode ? "contained" : "outlined"}
                fullWidth={isContextMenuMode}
                disabled={
                  (!selectedFile && availableScenes.length === 0) ||
                  isLoading ||
                  uploadProgress !== null ||
                  (availableScenes.length > 0 && !selectedSceneHasWallData)
                }>
                {uploadProgress !== null
                  ? `Compressing… ${uploadProgress}%`
                  : isLoading
                    ? "Uploading..."
                    : availableScenes.length > 0 && !selectedSceneHasWallData
                      ? "No Walls In Selected Scene"
                      : isContextMenuMode
                        ? "Apply Walls to Selected Map"
                        : "Add Walls to Current Scene"}
              </Button>
            )}
          </Stack>
        </>
      )}
    </Box>
  );
}

export default App;
