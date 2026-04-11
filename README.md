# Scene Importer for Owlbear Rodeo

Formerly: UVTT Importer.

A Virtual Tabletop (VTT) map importer extension for [Owlbear Rodeo](https://www.owlbear.rodeo/). It imports maps, complete with walls and doors (where applicable), from:

- Universal VTT (.uvtt) files
- DD2VTT (.dd2vtt) files
- FoundryVTT scene JSON files
- FoundryVTT Module ZIPs and `module.json` manifest URLs (Includes map image & walls)
- **Raw image and video files (to utilize the extension's compression features)**

Designed for use with the [Dynamic Fog Extension](https://extensions.owlbear.rodeo/dynamic-fog) for basic wall and door functionality. For advanced features, consider the [Smoke & Spectre Extension](https://extensions.owlbear.rodeo/smoke).

## Features

- Import maps from UVTT/DD2VTT files, and complete FoundryVTT module ZIP archives
- Import payloads dynamically via Web URLs or natively wrapped `module.json` configuration links
- Upload raw image and video files to take advantage of the built-in file compression
- Automatic wall and door creation from imported VTT data
- Image and video compression modes that target Owlbear Rodeo subscription limits
- Support for placing walls and doors relative to selected items
- Automatic DPI adjustment based on grid size

## Usage

### Import a New Map or Scene

This will create a new scene using your VTT file or raw media file. If a VTT file is used, it will include walls and doors.

1. Click the Scene Importer icon in the top left corner.
2. Select your `.uvtt`, `.dd2vtt`, `.zip` module file, raw image, raw video, or paste a direct URL link. _(Note: Standalone FoundryVTT .json config files are not supported for new scene creation as they typically don't include an embedded map image. For full image support, upload a Foundry ZIP module instead)._
3. Choose your compression mode (see below).
4. Click "Create New Scene". This can take a moment, depending on the file size and compression.
5. Once the process is complete, a new scene with your map will be available in your scenes list.

![create scene from file](https://raw.githubusercontent.com/Eppinguin/scene-importer/main/docs/import-map-from-menu.gif)

_Note: If your UVTT file does not contain a map image, you will not be able to use the "Create New Scene" option. In this case, you should first set up your scene with a map image manually, and then use the "Add Walls to Current Scene" feature._

### Add Walls and Doors to an Existing Scene

You can add walls and doors to an existing scene in two ways:

![add walls from menu](https://raw.githubusercontent.com/Eppinguin/scene-importer/main/docs/import-walls-from-menu.gif)

#### Using the Importer Window:

1. Open the scene where you want to add walls/doors
2. Click the Scene Importer button in the toolbar
3. Select your `.uvtt`, `.dd2vtt`, `.json`, `.zip` file, or paste a valid URL.
4. Click "Add Walls to Current Scene"

#### Using the Map's Context Menu:

1. Select the Map you want to Import Walls for
2. Right Click it
3. Click "Import Walls"
4. The extension will automatically open the Importer Selector so you can choose exactly which Wall structure you're casting onto your highlighted image.
5. Wait for Walls and Doors to be added to the Map

![add walls from context menu](https://raw.githubusercontent.com/Eppinguin/scene-importer/main/docs/import-walls-from-context-menu.gif)

## Compression Modes

Owlbear Rodeo has specific file size limits depending on your subscription tier. The extension dynamically adjusts the available compression options based on whether you are importing an image or a video to match these limits.

Select the option that includes your current Owlbear Rodeo subscription tier:

- **Images:** Nestling / Fledgeling (max 25MB) or Bestling (max 50MB)
- **Videos:** Nestling (max 50MB) or Fledgeling / Bestling (max 100MB)

### How the Modes Work

| Mode               | Behavior                                                                                                                                                           |
| :----------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **No Compression** | Uploads the original file without modification. The upload will fail if the file exceeds your account's size limit.                                                |
| **Your Tier Name** | Compresses the file to fit your selected tier's limit. Images are converted to WebP and quality is incrementally reduced until the file is under the maximum size. |

### Advanced Video Options

When importing video maps, you can adjust the following settings to control how the files are processed:

- **VP9/WebM:** Default format. Balances file size and browser compatibility.
- **AV1:** Yields the smallest file sizes, but takes longer to process.
- **H.264:** Maximum compatibility across older browsers and mobile devices.
- **Remove audio:** Removes the audio track to reduce file size.
- **Transcode anyway:** Compresses the video even if it is already under the size limit to save storage space.
- **Max video dimension:** Limits the longest side in pixels (example: `1920`) to reduce processing time and file size. Leave empty to keep the original resolution.

## Installing

The extension can be installed from https://scene-importer.pages.dev/manifest.json

## Development

1. Clone the repository
2. Install dependencies:
   ```
   pnpm install
   ```
3. Start development server:
   ```
   pnpm dev
   ```
4. Build for production:
   ```
   pnpm build
   ```

## Credits

Built with React, TypeScript, and Vite for Owlbear Rodeo's extension platform.

The map featured in the header image and demonstration GIFs are from [mbround18's VTT Maps repository](https://github.com/mbround18/vtt-maps?tab=readme-ov-file) and is available under the [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/) license.
