import { useState, useRef, useEffect } from "react";
import "./App.css";
import {
  uploadSceneFromVTT,
  addItemsFromVTT,
  uploadFoundryScene,
  addItemsFromData,
  extractImageFromZip,
  convertFoundryToVTTData,
  type CompressionMode,
} from "./importVTT";
import { isFoundryVTTData, hasMapImage } from "./importVTT";
import OBR, { type Theme } from "@owlbear-rodeo/sdk";
import * as React from "react";
import JSZip from "jszip";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SceneInfo = { name: string, data: any, fileSource: string, thumbUrl?: string };

function App() {
  const isContextMenuMode = new URLSearchParams(window.location.search).get('context') === 'true';
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [moduleUrl, setModuleUrl] = useState("");
  const [zipObject, setZipObject] = useState<JSZip | null>(null);
  const [availableScenes, setAvailableScenes] = useState<SceneInfo[]>([]);
  const [selectedSceneIndex, setSelectedSceneIndex] = useState(0);

  const [hoveredSceneThumb, setHoveredSceneThumb] = useState<string | null>(null);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
  const [showUrlInput, setShowUrlInput] = useState(false);
  const [manualDownloadUrl, setManualDownloadUrl] = useState<string | null>(null);

  const [isFoundryFormat, setIsFoundryFormat] = useState(false);
  const [hasImage, setHasImage] = useState(false);
  const [compressionMode, setCompressionMode] =
    useState<CompressionMode>("standard");
  const [isLoading, setIsLoading] = useState(false);
  const [theme, setTheme] = useState<Theme | null>(null);
  const [isGM, setIsGM] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

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
    []
  );

  // Clean up object URLs to prevent memory leaks
  useEffect(() => {
    return () => {
      availableScenes.forEach(s => {
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
  }, [selectedFile, hasImage, isLoading, compressionMode, availableScenes, selectedSceneIndex]);

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
      theme.secondary.contrastText
    );
    root.style.setProperty("--background-default", theme.background.default);
    root.style.setProperty("--background-paper", theme.background.paper);

    // Convert background-paper to RGB for transparency
    const paperColor = theme.background.paper;
    const rgb = paperColor.match(/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/)?.[1];
    if (rgb) {
      const r = parseInt(
        rgb.length === 3 ? rgb[0].repeat(2) : rgb.slice(0, 2),
        16
      );
      const g = parseInt(
        rgb.length === 3 ? rgb[1].repeat(2) : rgb.slice(2, 4),
        16
      );
      const b = parseInt(
        rgb.length === 3 ? rgb[1].repeat(2) : rgb.slice(4, 6),
        16
      );
      root.style.setProperty("--background-paper-rgb", `${r}, ${g}, ${b}`);
    }

    root.style.setProperty("--text-primary", theme.text.primary);
    root.style.setProperty("--text-secondary", theme.text.secondary);
    root.style.setProperty("--text-disabled", theme.text.disabled);
  }, [theme]);

  const handleZipFile = async (fileOrBlob: Blob | File) => {
    setIsLoading(true);
    try {
      const zip = await JSZip.loadAsync(fileOrBlob);
      setZipObject(zip);

      let moduleJsonFile = zip.file("module.json");
      if (!moduleJsonFile) {
        const match = Object.keys(zip.files).find(p => p.endsWith("module.json"));
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
            let packPath = pack.path.replace(/\\/g, '/');
            if (packPath.startsWith('.')) packPath = packPath.substring(1);
            if (packPath.startsWith('/')) packPath = packPath.substring(1);

            let packFile = zip.file(packPath);
            if (!packFile) {
              const match = Object.keys(zip.files).find(p => p.endsWith(packPath) || packPath.endsWith(p));
              if (match) packFile = zip.file(match);
            }

            if (packFile) {
              const content = await packFile.async("string");
              const lines = content.split('\n').filter(l => l.trim().length > 0);
              for (const line of lines) {
                try {
                  const scene = JSON.parse(line);
                  if (scene.name && (scene.walls || scene.portals)) {
                    scenes.push({ name: scene.name, data: scene, fileSource: fileOrBlob instanceof File ? fileOrBlob.name : 'module' });
                  }
                } catch (e) {
                  // ignore
                }
              }
            }
          }
        }
      }

      if (scenes.length === 0) {
        for (const path of Object.keys(zip.files)) {
          if (path.endsWith('.db') || path.endsWith('.json')) {
            if (path.endsWith('module.json')) continue;
            const content = await zip.file(path)!.async("string");
            const lines = content.split('\n').filter(l => l.trim().length > 0);
            for (const line of lines) {
              try {
                const scene = JSON.parse(line);
                if (scene.name && (scene.walls || scene.portals)) {
                  scenes.push({ name: scene.name, data: scene, fileSource: fileOrBlob instanceof File ? fileOrBlob.name : 'module' });
                }
              } catch (e) {
                // ignore
              }
            }
          }
        }
      }

      if (scenes.length > 0) {
        // Pre-fetch thumbnails as object URLs
        for (const s of scenes) {
          const possiblePaths = [s.data.thumb, s.data.background?.src, s.data.img].filter(Boolean);
          for (const imgPath of possiblePaths) {
            try {
              const blob = await extractImageFromZip(zip, imgPath);
              s.thumbUrl = URL.createObjectURL(blob);
              break; // Success, stop trying fallbacks
            } catch (e) {
              // Silently try the next fallback path
            }
          }
          if (!s.thumbUrl) {
            console.warn(`Failed to extract any thumbnail or image for scene ${s.name}`);
          }
        }

        setAvailableScenes(scenes);
        setSelectedSceneIndex(0);
        setSelectedFile(null);
        setIsFoundryFormat(true);
        const firstScene = scenes[0].data;
        setHasImage(!!(firstScene.img || firstScene.background?.src));
        OBR.notification.show(`Loaded module with ${scenes.length} scenes.`, "SUCCESS");
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
      newUrl = newUrl.replace("www.dropbox.com/s/", "dl.dropboxusercontent.com/s/");
      newUrl = newUrl.replace("dropbox.com/s/", "dl.dropboxusercontent.com/s/");
    }
    if (newUrl.includes("dropbox.com/scl/")) {
      newUrl = newUrl.replace("www.dropbox.com/scl/", "dl.dropboxusercontent.com/scl/");
      newUrl = newUrl.replace("dropbox.com/scl/", "dl.dropboxusercontent.com/scl/");
    }

    // GitHub transformations
    if (newUrl.includes("github.com/") && newUrl.includes("/blob/")) {
      newUrl = newUrl.replace("github.com", "raw.githubusercontent.com").replace("/blob/", "/");
    }

    return newUrl;
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const processJsonData = async (fileData: any, originalName: string, originalBlob: Blob | File) => {
    // Is it a module.json with a download link?
    if (fileData.download && typeof fileData.download === 'string') {
      OBR.notification.show("Downloading module ZIP...", "INFO");

      let zipRes;
      const targetUrl = normalizeCorsUrl(fileData.download);
      try {
        zipRes = await fetch(targetUrl);
      } catch (e) {
        setManualDownloadUrl(targetUrl);
        throw new Error(`CORS blocked auto-download. Please manually download the ZIP module and upload it.`);
      }

      if (!zipRes.ok) throw new Error(`HTTP Error ${zipRes.status} downloading ZIP file.`);

      const zipBlob = await zipRes.blob();
      await handleZipFile(zipBlob);
      return;
    }

    // Otherwise, it's a standard VTT scene or regular Foundry config map
    const foundryFormat = isFoundryVTTData(fileData);
    const imageExists = hasMapImage(fileData);
    setIsFoundryFormat(foundryFormat);
    setHasImage(imageExists);

    const fileObj = originalBlob instanceof File
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
      } catch (e) {
        setManualDownloadUrl(targetUrl);
        throw new Error(`Failed to fetch (CORS block or invalid URL). Please download manually.`);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} returned from remote server.`);

      const clonedRes = res.clone();

      // First try to see if it's a ZIP by looking at filename or content-type
      const isZipPath = moduleUrl.toLowerCase().split('?')[0].endsWith('.zip');
      const contentType = res.headers.get('content-type') || '';

      if (isZipPath || contentType.includes('zip') || contentType.includes('octet-stream')) {
        try {
          const zipBlob = await res.blob();
          await handleZipFile(zipBlob);
          if (fileInputRef.current) fileInputRef.current.value = "";
          setIsLoading(false);
          return; // Successfully handled as zip
        } catch (e) {
          // Might not actually be a zip, fallback to text parsing if needed
          console.warn("Attempted to parse as zip but failed, falling back to JSON parsing", e);
        }
      }

      // Next, try parsing it as text/json
      const text = await clonedRes.text();
      let fileData;
      try {
        fileData = JSON.parse(text);
      } catch (e) {
        throw new Error("Target file was not a valid ZIP archive or JSON formatted string.");
      }

      const fileName = moduleUrl.split('/').pop()?.split('?')[0] || "downloaded.json";
      const blob = new Blob([text], { type: "application/json" });

      await processJsonData(fileData, fileName, blob);
      if (fileInputRef.current) fileInputRef.current.value = "";

    } catch (e: unknown) {
      console.error(e);
      const errorMessage = e instanceof Error ? e.message : "Unknown error";
      if (!errorMessage.includes("download manually") && !errorMessage.includes("CORS block")) {
        OBR.notification.show(`${errorMessage}`, "ERROR");
      }
    }
    setIsLoading(false);
  }

  const handleFileSelect = async (
    event: React.ChangeEvent<HTMLInputElement>
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
              "WARNING"
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
          "WARNING"
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
      if (availableScenes.length > 0 && zipObject) {
        const scene = availableScenes[selectedSceneIndex].data;
        const imgPath = scene.img || scene.background?.src;
        if (!imgPath) throw new Error("No image found for this scene.");

        const imgBlob = await extractImageFromZip(zipObject, imgPath);
        await uploadFoundryScene(scene, imgBlob, scene.name || "Foundry Scene", compressionMode);
      } else if (selectedFile) {
        await uploadSceneFromVTT(selectedFile, compressionMode);
      }
    } catch (error: unknown) {
      console.error(error);
      let errorMessage = "Unknown error";

      if (typeof error === "object" && error !== null) {
        const err = error as { error?: { message: string }; message?: string };
        errorMessage = err.error?.message || err.message || errorMessage;
      }

      console.error("Error creating scene:", errorMessage);
      await OBR.notification.show(
        `Error creating scene: ${errorMessage}`,
        "ERROR"
      );
    }
    setIsLoading(false);
  };

  const handleAddToCurrentScene = async () => {
    if (!selectedFile && availableScenes.length === 0) return;

    setIsLoading(true);
    try {
      if (availableScenes.length > 0) {
        const scene = availableScenes[selectedSceneIndex].data;
        const pData = isFoundryVTTData(scene) ? convertFoundryToVTTData(scene) : scene;
        await addItemsFromData(pData, isContextMenuMode);
        if (isContextMenuMode) await OBR.modal.close("com.eppinguin.uvtt-importer/modal");
      } else if (selectedFile) {
        await addItemsFromVTT(selectedFile, isContextMenuMode);
        if (isContextMenuMode) await OBR.modal.close("com.eppinguin.uvtt-importer/modal");
      }
    } catch (error: unknown) {
      console.error(error);
      let errorMessage = "Unknown error";

      if (typeof error === "object" && error !== null) {
        const err = error as { error?: { message: string }; message?: string };
        errorMessage = err.error?.message || err.message || errorMessage;
      }

      await OBR.notification.show(
        `Error adding to scene: ${errorMessage}`,
        "ERROR"
      );
    }
    setIsLoading(false);
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
              <div className="url-upload" style={{ marginTop: '0.5rem', display: 'flex', flexDirection: 'column', gap: '0.5rem', width: '100%' }}>
                <input
                  type="text"
                  value={moduleUrl}
                  onChange={(e) => setModuleUrl(e.target.value)}
                  placeholder="Enter asset URL (e.g. .uvtt, .zip, or module.json)"
                  style={{
                    width: '100%',
                    padding: '0.75rem',
                    borderRadius: '4px',
                    border: '1px solid var(--primary-light)',
                    background: 'var(--background-default)',
                    color: 'var(--text-primary)'
                  }}
                  disabled={isLoading}
                />
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <button
                    onClick={handleFetchUrl}
                    disabled={!moduleUrl || isLoading}
                    className="primary-button"
                    style={{ flex: 1 }}
                  >
                    Fetch from URL
                  </button>
                  <button
                    onClick={() => setShowUrlInput(false)}
                    disabled={isLoading}
                    className="secondary-button"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setShowUrlInput(true)}
                disabled={isLoading}
                style={{
                  background: 'none',
                  color: 'var(--primary-main)',
                  border: 'none',
                  fontSize: '0.85rem',
                  textDecoration: 'underline',
                  marginTop: '0.2rem',
                  padding: 0,
                  width: 'auto'
                }}
              >
                Import from URL instead
              </button>
            )}

            {manualDownloadUrl && (
              <div className="options" style={{ marginTop: '10px', borderColor: 'var(--primary-main)', borderStyle: 'dashed' }}>
                <h3>Manual Download Required</h3>
                <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.75rem' }}>
                  The host server rigidly blocked our ability to automatically fetch this file. Please download it manually to your system and then upload the resulting file here!
                </p>
                <a
                  href={manualDownloadUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="primary-button"
                  style={{ display: 'inline-block', textDecoration: 'none', textAlign: 'center', width: '100%' }}
                >
                  Download File Manually
                </a>
              </div>
            )}

            {selectedFile && (
              <div style={{ marginTop: '10px' }}>
                <p className="selected-file">Selected: {selectedFile.name}</p>
                <p className="file-info">
                  {(isFoundryFormat || !hasImage) &&
                    "No map image found (walls and doors only)"}
                </p>
              </div>
            )}

            {availableScenes.length > 0 && (
              <div className="scene-selection" style={{ marginTop: '10px' }}>
                <h3>Select Scene ({availableScenes.length} found)</h3>
                <div className="scene-gallery">
                  {availableScenes.map((s, idx) => (
                    <div
                      key={idx}
                      className={`scene-card ${selectedSceneIndex === idx ? 'selected' : ''}`}
                      onClick={() => {
                        setSelectedSceneIndex(idx);
                        setHasImage(!!(s.data.img || s.data.background?.src));
                      }}
                      onMouseEnter={() => setHoveredSceneThumb(s.thumbUrl || null)}
                      onMouseLeave={() => setHoveredSceneThumb(null)}
                      onMouseMove={(e) => setMousePos({ x: e.clientX, y: e.clientY })}
                    >
                      <div className="scene-thumb-container">
                        {s.thumbUrl ? (
                          <img src={s.thumbUrl} className="scene-thumb" alt={s.name} />
                        ) : (
                          <span className="scene-thumb-placeholder">No Preview</span>
                        )}
                      </div>
                      <div className="scene-name" title={s.name || `Scene ${idx + 1}`}>
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
                  : { top: mousePos.y + 15 })
              }}
            >
              <img src={hoveredSceneThumb} alt="Enlarged preview" />
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
                  <option value="none">None</option>
                  <option value="standard">Standard</option>
                  <option value="high">Bestling</option>
                </select>
                <div className="compression-info">
                  {compressionMode === "none" && (
                    <p>Uploads the image as is, without any compression.</p>
                  )}
                  {compressionMode === "standard" && (
                    <p>
                      Converts to WebP format and optimizes to keep the file
                      under 25MB.
                    </p>
                  )}
                  {compressionMode === "high" && (
                    <p>
                      Converts to WebP format and optimizes to keep the file
                      under 50MB.
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}

          <div className="actions">
            {!isContextMenuMode && (
              <button
                onClick={handleCreateNewScene}
                disabled={
                  (!selectedFile && availableScenes.length === 0) || isLoading || (isFoundryFormat && availableScenes.length === 0) || !hasImage
                }
                className="primary-button">
                {isLoading
                  ? "Creating..."
                  : isFoundryFormat && availableScenes.length === 0
                    ? "Scene Creation Not Available (Foundry File)"
                    : !hasImage
                      ? "Scene Creation Not Available (No Image)"
                      : "Create New Scene"}
              </button>
            )}

            <button
              onClick={handleAddToCurrentScene}
              disabled={(!selectedFile && availableScenes.length === 0) || isLoading}
              className={isContextMenuMode ? "primary-button" : "secondary-button"}
              style={isContextMenuMode ? { width: '100%' } : {}}>
              {isLoading ? "Adding..." : (isContextMenuMode ? "Apply Walls to Selected Map" : "Add Walls to Current Scene")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export default App;
