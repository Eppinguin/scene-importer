---
title: Scene Importer
description: Import VTT wall data (.uvtt, .dd2vtt, Foundry) for Dynamic Fog, or automatically compress raw media uploads to fit your tier limits.
author: Eppinguin
image: https://raw.githubusercontent.com/Eppinguin/scene-importer/main/docs/header.webp
icon: https://scene-importer.pages.dev/Logo.webp
tags:
  - tool
  - fog
  - other
manifest: https://scene-importer.pages.dev/manifest.json
learn-more: https://github.com/Eppinguin/scene-importer
---

# Scene Importer

Import VTT wall data directly for [Dynamic Fog](https://extensions.owlbear.rodeo/dynamic-fog) using Universal VTT (.uvtt), DD2VTT (.dd2vtt), or FoundryVTT files (JSON, ZIP, or URLs). Alternatively, you can upload raw image and video files and let the extension automatically compress them to fit your Owlbear Rodeo subscription limits.

This importer is designed to work with the Dynamic Fog Extension, providing an easy way to import walls and doors from your existing maps. For users seeking advanced features like dynamic lighting and custom fog backgrounds, check out the excellent [Smoke & Spectre Extension](https://extensions.owlbear.rodeo/smoke).

![add walls from menu](https://raw.githubusercontent.com/Eppinguin/scene-importer/main/docs/import-walls-from-menu.gif)

## Import a New Map

This will create a new scene using your VTT file or raw media file. If a VTT file is used, it will include walls and doors.

1. Click the Scene Importer icon in the top left corner.
2. Select your `.uvtt`, `.dd2vtt`, `.zip` module file, raw image, raw video, or paste a URL. _(Note: Standalone FoundryVTT .json config files are not supported for new scene creation as they typically don't include an embedded map image. Upload a Foundry ZIP module instead)._
3. Choose your compression mode ([see below](#compression-modes)).
4. Click "Create New Scene". This can take a moment, depending on the file size and compression.
5. Once the process is complete, a new scene with your map will be available in your scenes list.

![create scene from file](https://raw.githubusercontent.com/Eppinguin/scene-importer/main/docs/import-map-from-menu.gif)

_Note: If your UVTT file does not contain a map image, you will not be able to use the "Create New Scene" option. In this case, you should first set up your scene with a map image manually, and then use the "Add Walls to Current Scene" feature._

## Add Walls and Doors to an Existing Scene or Map

This option is for adding walls and doors to a scene that already exists or to a specific map image you've already placed.

### Using the Importer Window:

1. Open the scene where you want to add walls/doors.
2. Click the Scene Importer button in the toolbar.
3. Select your `.uvtt`, `.dd2vtt`, `.json`, `.zip` file, or paste a URL.
4. Click "Add Walls to Current Scene".
5. The walls and doors will be added to the current scene.

### Using the Map's Context Menu (for existing maps):

For existing maps, you can add Walls and Doors using the Map's Context Menu (right-click menu). This method automatically positions the walls relative to the map's current location and scale, which is useful when you have already positioned or resized the map, or when working with multiple maps in a single scene.

1. Select the Map you want to Import Walls for.
2. Right Click it.
3. Click "Import Walls".
4. The extension will automatically open the Importer Selector so you can choose exactly which wall structure to cast onto your highlighted image.
5. Wait for Walls and Doors to be added to the Map.

![add walls from context menu](https://raw.githubusercontent.com/Eppinguin/scene-importer/main/docs/import-walls-from-context-menu.gif)

## Compression Modes

Owlbear Rodeo has specific file size limits depending on your subscription tier. The extension dynamically adjusts the available compression options based on whether you are importing an image or a video to match these limits.

Select the option that includes your current Owlbear Rodeo subscription tier:

- **Images:** Nestling / Fledgeling (max 25MB) or Bestling (max 50MB)
- **Videos:** Nestling (max 50MB) or Fledgeling / Bestling (max 100MB)

| Mode               | Description                                                                                                                                                        |
| :----------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **No Compression** | Uploads the original file without modification. The upload will fail if the file exceeds your account's size limit.                                                |
| **Your Tier Name** | Compresses the file to fit your selected tier's limit. Images are converted to WebP and quality is incrementally reduced until the file is under the maximum size. |

_Advanced video compression settings (such as automatic codec fallback based on browser capabilities, format selection like AV1/H.265/VP9/H.264, audio removal, and resolution limits) are available directly in the importer window._

> **💡 Hint:** Video conversion depends on built-in browser capabilities, which can vary wildly. For the most reliable compression experience and widest codec support, we recommend using a **Chromium-based browser** (like Chrome, Edge, or Brave). Browsers like Safari have strict source decoding and memory limits that might cause processing to fail on larger files.

## Acknowledgments

The map featured in the header image and demonstration GIFs are from [mbround18's VTT Maps repository](https://github.com/mbround18/vtt-maps?tab=readme-ov-file) and is available under the [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/) license.

## Support

For questions, bug reports, or feature requests, please visit the [GitHub repository issues page](https://github.com/Eppinguin/scene-importer/issues).
