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
  type VideoCodecPreference,
  type VideoCompressionOptions,
  isFoundryVTTData,
  hasMapImage,
} from "./importVTT";
import OBR, { type Theme } from "@owlbear-rodeo/sdk";
import JSZip from "jszip";
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
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
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
  const [isLoading, setIsLoading] = useState(false);
  const [theme, setTheme] = useState<Theme | null>(null);
  const [isGM, setIsGM] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const compressionAbortRef = useRef<AbortController | null>(null);
  const selectedModuleScene = availableScenes[selectedSceneIndex];
  const selectedSceneHasWallData = selectedModuleScene
    ? sceneHasWallData(selectedModuleScene.data)
    : true;
  const selectedSceneIsVideo = !!selectedModuleScene?.isVideo;

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
    const updateHeight = () => {
      if (OBR.isReady) {
        if (containerRef.current) {
          const height = containerRef.current.offsetHeight;
          OBR.action.setHeight(height);
        }
      }
    };

    // Initial height update
    updateHeight();

    // Update height when content changes
    const observer = new ResizeObserver(updateHeight);
    const currentContainer = containerRef.current;

    if (currentContainer) {
      observer.observe(currentContainer);
    }

    return () => {
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

    // Convert background-paper to RGB for transparency
    const paperColor = theme.background.paper;
    const rgb = paperColor.match(/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/)?.[1];
    if (rgb) {
      const r = parseInt(
        rgb.length === 3 ? rgb[0].repeat(2) : rgb.slice(0, 2),
        16,
      );
      const g = parseInt(
        rgb.length === 3 ? rgb[1].repeat(2) : rgb.slice(2, 4),
        16,
      );
      const b = parseInt(
        rgb.length === 3 ? rgb[1].repeat(2) : rgb.slice(4, 6),
        16,
      );
      root.style.setProperty("--background-paper-rgb", `${r}, ${g}, ${b}`);
    }

    root.style.setProperty("--text-primary", theme.text.primary);
    root.style.setProperty("--text-secondary", theme.text.secondary);
    root.style.setProperty("--text-disabled", theme.text.disabled);
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
              "Error reading file. Make sure it's a valid VTT file or module package.",
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
          "Please select a valid .uvtt, .dd2vtt, .json or .zip file",
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

    setIsLoading(true);
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
        );
        // Compression done — clear progress bar, show uploading state
        setUploadProgress(null);
        setIsLoading(true);
      } else if (fileToUpload) {
        await uploadSceneFromVTT(
          fileToUpload,
          compressionMode,
          (progress) => setUploadProgress(progress),
          videoCompressionOptions,
        );
      }
      // Compression done — clear progress bar, show uploading state
      setUploadProgress(null);
      setIsLoading(true);

      OBR.notification.show("Scene created successfully!", "SUCCESS");
      OBR.modal.close("com.eppinguin.uvtt-importer/modal");
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

      const message = getErrorMessage(error);
      const lowerMessage = message.toLowerCase();
      if (lowerMessage.includes("aborted")) {
        OBR.notification.show("Compression canceled.", "INFO");
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
        OBR.notification.show(`${message}. ${hint}`, "WARNING");
      } else {
        OBR.notification.show(`Failed to create scene: ${message}`, "ERROR");
      }
    } finally {
      compressionAbortRef.current = null;
      setUploadProgress(null);
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
        await OBR.modal.close("com.eppinguin.uvtt-importer/modal");
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
    <div className="container" ref={containerRef}>
      {!isGM ? (
        <p>This extension requires GM privileges to use.</p>
      ) : (
        <>
          <h1>UVTT Importer</h1>

          <div className="file-upload">
            <input
              type="file"
              accept=".uvtt,.dd2vtt,.json,.zip,application/json,application/octet-stream,application/zip"
              capture={undefined}
              onChange={handleFileSelect}
              ref={fileInputRef}
              className="file-input"
              disabled={isLoading}
            />

            {showUrlInput ? (
              <div
                className="url-upload"
                style={{
                  marginTop: "0.5rem",
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.5rem",
                  width: "100%",
                }}>
                <input
                  type="text"
                  value={moduleUrl}
                  onChange={(e) => setModuleUrl(e.target.value)}
                  placeholder="Enter asset URL (e.g. .uvtt, .zip, or module.json)"
                  style={{
                    width: "100%",
                    padding: "0.75rem",
                    borderRadius: "4px",
                    border: "1px solid var(--primary-light)",
                    background: "var(--background-default)",
                    color: "var(--text-primary)",
                  }}
                  disabled={isLoading}
                />
                <div style={{ display: "flex", gap: "0.5rem" }}>
                  <button
                    onClick={handleFetchUrl}
                    disabled={!moduleUrl || isLoading}
                    className="primary-button"
                    style={{ flex: 1 }}>
                    Fetch from URL
                  </button>
                  <button
                    onClick={() => setShowUrlInput(false)}
                    disabled={isLoading}
                    className="secondary-button">
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setShowUrlInput(true)}
                disabled={isLoading}
                style={{
                  background: "none",
                  color: "var(--primary-main)",
                  border: "none",
                  fontSize: "0.85rem",
                  textDecoration: "underline",
                  marginTop: "0.2rem",
                  padding: 0,
                  width: "auto",
                }}>
                Import from URL instead
              </button>
            )}

            {manualDownloadUrl && (
              <div
                className="options"
                style={{
                  marginTop: "10px",
                  borderColor: "var(--primary-main)",
                  borderStyle: "dashed",
                }}>
                <h3>Manual Download Required</h3>
                <p
                  style={{
                    fontSize: "0.85rem",
                    color: "var(--text-secondary)",
                    marginBottom: "0.75rem",
                  }}>
                  The host server rigidly blocked our ability to automatically
                  fetch this file. Please download it manually to your system
                  and then upload the resulting file here!
                </p>
                <a
                  href={manualDownloadUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="primary-button"
                  style={{
                    display: "inline-block",
                    textDecoration: "none",
                    textAlign: "center",
                    width: "100%",
                  }}>
                  Download File Manually
                </a>
              </div>
            )}

            {selectedFile && (
              <div style={{ marginTop: "10px" }}>
                <p className="selected-file">Selected: {selectedFile.name}</p>
                <p className="file-info">
                  {(isFoundryFormat || !hasImage) &&
                    "No map image found (walls and doors only)"}
                </p>
              </div>
            )}

            {availableScenes.length > 0 && (
              <div className="scene-selection" style={{ marginTop: "10px" }}>
                <h3>Select Scene ({availableScenes.length} found)</h3>
                <div className="scene-gallery">
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
                      onMouseLeave={() => setHoveredSceneThumb(null)}
                      onMouseMove={(e) =>
                        setMousePos({ x: e.clientX, y: e.clientY })
                      }>
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
                              autoPlay
                              loop
                              muted
                              playsInline
                            />
                          ) : (
                            <img
                              src={s.thumbUrl}
                              className="scene-thumb"
                              alt={s.name}
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
              </div>
            )}
          </div>

          {hoveredSceneThumb && (
            <div
              className="scene-preview-float"
              style={{
                ...(mousePos.x > window.innerWidth / 2
                  ? { right: window.innerWidth - mousePos.x + 15 }
                  : { left: mousePos.x + 15 }),
                ...(mousePos.y > window.innerHeight / 2
                  ? { bottom: window.innerHeight - mousePos.y + 15 }
                  : { top: mousePos.y + 15 }),
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
            <div className="options">
              <h2>Import Options</h2>
              <div className="compression-options">
                <label>Compression Mode:</label>
                <select
                  value={compressionMode}
                  onChange={(e) =>
                    setCompressionMode(e.target.value as CompressionMode)
                  }
                  disabled={isLoading}>
                  <option value="none">No Compression</option>
                  <option value="standard">
                    {selectedSceneIsVideo
                      ? "Nestling (Max 50MB)"
                      : "Nestling / Fledgeling (Max 25MB)"}
                  </option>
                  <option value="high">
                    {selectedSceneIsVideo
                      ? "Fledgeling / Bestling (Max 100MB)"
                      : "Bestling Tier (Max 50MB)"}
                  </option>
                </select>

                <div className="compression-info">
                  {compressionMode === "none" && (
                    <p>
                      Uploads the original file without modification. The upload
                      will fail if it exceeds your account's file size limit.
                    </p>
                  )}

                  {compressionMode === "standard" && (
                    <p>
                      {selectedSceneIsVideo
                        ? "Compresses the video to a maximum of 50MB to fit Nestling account limits."
                        : "Compresses the image to a maximum of 25MB to fit Nestling and Fledgeling account limits."}
                    </p>
                  )}

                  {compressionMode === "high" && (
                    <p>
                      {selectedSceneIsVideo
                        ? "Compresses the video to a maximum of 100MB to fit Fledgeling and Bestling account limits."
                        : "Compresses the image to a maximum of 50MB to fit Bestling account limits."}
                    </p>
                  )}
                </div>

                <button
                  onClick={() =>
                    setShowAdvancedVideoOptions(!showAdvancedVideoOptions)
                  }
                  disabled={isLoading}
                  style={{
                    background: "none",
                    color: "var(--primary-main)",
                    border: "none",
                    fontSize: "0.85rem",
                    textDecoration: "underline",
                    marginTop: "0.4rem",
                    padding: 0,
                    width: "auto",
                  }}>
                  {showAdvancedVideoOptions
                    ? "Hide advanced video options"
                    : "Show advanced video options"}
                </button>
                {showAdvancedVideoOptions && (
                  <div
                    style={{
                      marginTop: "0.6rem",
                      display: "flex",
                      flexDirection: "column",
                      gap: "0.5rem",
                    }}>
                    <label>Preferred Video Codec:</label>
                    <select
                      value={preferredVideoCodec}
                      onChange={(e) =>
                        setPreferredVideoCodec(
                          e.target.value as VideoCodecPreference,
                        )
                      }
                      disabled={isLoading}>
                      <option value="vp9">
                        VP9/WebM (default, balanced quality)
                      </option>
                      <option value="av1">AV1 (maximum compression)</option>
                      <option value="h264">
                        H.264 (maximum compatibility)
                      </option>
                    </select>
                    <label style={{ display: "flex", gap: "0.5rem" }}>
                      <input
                        type="checkbox"
                        checked={removeVideoAudio}
                        onChange={(e) => setRemoveVideoAudio(e.target.checked)}
                        disabled={isLoading}
                      />
                      Remove audio track
                    </label>
                    <label style={{ display: "flex", gap: "0.5rem" }}>
                      <input
                        type="checkbox"
                        checked={forceVideoTranscode}
                        onChange={(e) =>
                          setForceVideoTranscode(e.target.checked)
                        }
                        disabled={isLoading}
                      />
                      Transcode anyway when already under size limit
                    </label>
                    <label>Max video dimension (optional):</label>
                    <input
                      type="number"
                      min={0}
                      step={1}
                      value={maxVideoDimension}
                      onChange={(e) => setMaxVideoDimension(e.target.value)}
                      placeholder="e.g. 1920"
                      disabled={isLoading}
                      style={{
                        width: "100%",
                        padding: "0.5rem",
                        borderRadius: "4px",
                        border: "1px solid var(--primary-light)",
                        background: "var(--background-default)",
                        color: "var(--text-primary)",
                      }}
                    />
                    <p
                      style={{
                        margin: 0,
                        fontSize: "0.8rem",
                        color: "var(--text-secondary)",
                      }}>
                      Limits the longest side in pixels (for example 1920).
                      Leave empty to keep original resolution.
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}

          {uploadProgress !== null && (
            <div className="compression-progress">
              <div className="compression-progress-label">
                Compressing video… {uploadProgress}%
              </div>
              <div className="compression-progress-track">
                <div
                  className="compression-progress-bar"
                  style={{ width: `${uploadProgress}%` }}
                />
              </div>
              <button
                className="secondary-button"
                onClick={() => {
                  compressionAbortRef.current?.abort();
                  setUploadProgress(null);
                }}
                style={{ marginTop: "0.4rem" }}>
                Cancel Compression
              </button>
            </div>
          )}

          <div className="actions">
            {!isContextMenuMode && uploadProgress === null && (
              <button
                onClick={handleCreateNewScene}
                disabled={
                  (!selectedFile && availableScenes.length === 0) ||
                  isLoading ||
                  uploadProgress !== null ||
                  (isFoundryFormat && availableScenes.length === 0) ||
                  !hasImage
                }
                className="primary-button">
                {uploadProgress !== null
                  ? `Compressing… ${uploadProgress}%`
                  : isLoading
                    ? "Uploading..."
                    : isFoundryFormat && availableScenes.length === 0
                      ? "Scene Creation Not Available (Foundry File)"
                      : !hasImage
                        ? "Scene Creation Not Available (No Image)"
                        : "Create New Scene"}
              </button>
            )}
            {uploadProgress === null && (
              <button
                onClick={handleAddWallsToCurrentScene}
                disabled={
                  (!selectedFile && availableScenes.length === 0) ||
                  isLoading ||
                  uploadProgress !== null ||
                  (availableScenes.length > 0 && !selectedSceneHasWallData)
                }
                className={
                  isContextMenuMode ? "primary-button" : "secondary-button"
                }
                style={isContextMenuMode ? { width: "100%" } : {}}>
                {uploadProgress !== null
                  ? `Compressing… ${uploadProgress}%`
                  : isLoading
                    ? "Uploading..."
                    : availableScenes.length > 0 && !selectedSceneHasWallData
                      ? "No Walls In Selected Scene"
                      : isContextMenuMode
                        ? "Apply Walls to Selected Map"
                        : "Add Walls to Current Scene"}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export default App;
