# UVTT Importer for Owlbear Rodeo

A Virtual Tabletop (VTT) map importer extension for [Owlbear Rodeo](https://www.owlbear.rodeo/). It imports maps with walls and doors from:

- Universal VTT (.uvtt) files
- DD2VTT (.dd2vtt) files
- FoundryVTT scene JSON files
- **FoundryVTT Module ZIPs and `module.json` manifest URLs (Includes map image & walls)**

Designed for use with the [Dynamic Fog Extension](https://extensions.owlbear.rodeo/dynamic-fog) for basic wall and door functionality. For advanced features, consider the [Smoke & Spectre Extension](https://extensions.owlbear.rodeo/smoke).

## Features

- Import maps from UVTT/DD2VTT files, and complete FoundryVTT module ZIP archives
- Import payloads dynamically via Web URLs or natively wrapped `module.json` configuration links
- Automatic wall and door creation from the imported data
- Smart image optimization with multiple compression modes
- Support for placing walls and doors relative to selected items
- Automatic DPI adjustment based on grid size

## Usage

### Import a New Map with Walls and Doors

This will create a new scene, complete with the map image, walls, and doors from your VTT file.

1. Click the UVTT Importer icon in the top left corner.
2. Select your `.uvtt`, `.dd2vtt`, or `.zip` module file, or paste a direct URL link. *(Note: Standalone FoundryVTT .json config files are not supported for new scene creation as they typically don't include an embedded map image. For full image support, upload the a Foundry ZIP module instead).*
3. Choose your compression mode (see below).
4. Click "Create New Scene". This can take a moment, depending on the image size and compression.
5. Once the process is complete, a new scene with your map and all its walls and doors will be available in your scenes list.

_Note: If your UVTT file does not contain a map image, you will not be able to use the "Create New Scene" option. In this case, you should first set up your scene with a map image manually, and then use the "Add Walls to Current Scene" feature._

### Add Walls and Doors to an Existing Scene

You can add walls and doors to an existing scene in two ways:

![add walls from menu](https://raw.githubusercontent.com/Eppinguin/uvtt-importer/main/docs/import-walls-from-menu.gif)

#### Using the Importer Window:

1. Open the scene where you want to add walls/doors
2. Click the UVTT Importer button in the toolbar
3. Select your `.uvtt`, `.dd2vtt`, `.json`, `.zip` file, or paste a valid URL.
4. Click "Add Walls to Current Scene"

#### Using the Map's Context Menu:

1. Select the Map you want to Import Walls for
2. Right Click it
3. Click "Import Walls"
4. The extension will automatically open the Importer Selector so you can choose exactly which Wall structure you're casting onto your highlighted image.
5. Wait for Walls and Doors to be added to the Map

![add walls from context menu](https://raw.githubusercontent.com/Eppinguin/uvtt-importer/main/docs/import-walls-from-context-menu.gif)

## Compression Modes

When importing maps, you can choose from three compression modes:

| Mode     | Description                                           |
| -------- | ----------------------------------------------------- |
| Standard | Best for most maps (optimizes to ~24MB)               |
| Bestling | Better quality for detailed maps (optimizes to ~49MB) |
| None     | Uses original image format                            |

The two compressions will first convert the image to WebP and then incrementally reduce the quality of the image to fit the constraints.

## Installing

The extension can be installed from https://uvtt-importer.pages.dev/manifest.json

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
