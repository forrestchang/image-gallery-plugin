# Image Gallery Plugin

An Obsidian plugin that displays all images in your vault in a beautiful gallery view with OCR text search capabilities. Supports both local and remote images.

## Features

- **Gallery View**: Display all images from your vault in an organized gallery layout
- **OCR Text Recognition**: Automatically extract text from images using macOS Vision framework
- **Smart Search**: Search images by their OCR content or contextual information
- **Support for Multiple Formats**: Works with both local images and remote image URLs
- **Context-Aware**: Shows which notes reference each image and surrounding content
- **Batch Processing**: Efficiently process multiple images with configurable concurrency

## Installation

### Manual Installation

1. Download the latest release files (`main.js`, `manifest.json`, `styles.css`)
2. Copy them to your vault's plugin folder: `VaultFolder/.obsidian/plugins/image-gallery-plugin/`
3. Reload Obsidian and enable the plugin in Settings → Community Plugins

### Development Setup

1. Clone this repository to your vault's plugin folder
2. Install dependencies: `npm i`
3. Build the plugin: `npm run build`
4. Reload Obsidian and enable the plugin

## Usage

The plugin automatically scans your vault for images and provides:

- A gallery view accessible through the ribbon icon or command palette
- OCR text extraction from images (macOS only)
- Search functionality to find images by their text content
- Context information showing which notes reference each image

## OCR Features

The OCR functionality uses macOS's Vision framework and supports:

- **Multi-language recognition**: Optimized for Chinese (Simplified & Traditional) and English
- **Automatic language detection**
- **Caching**: Results are cached to avoid re-processing unchanged images
- **Context extraction**: Captures surrounding text from notes that reference images
- **Advanced search**: Support for phrases, negation, and OR operators

### Search Syntax

- `"exact phrase"`: Search for exact phrases
- `-word`: Exclude images containing this word
- `word1 OR word2`: Find images containing either word
- `word1 word2`: Find images containing both words

## Development

### Building

```bash
npm run dev    # Development mode with file watching
npm run build  # Production build
```

### Project Structure

- `main.ts`: Main plugin entry point
- `ocr-service.ts`: OCR functionality and image text processing
- `styles.css`: Plugin styling
- `manifest.json`: Plugin metadata

## Requirements

- Obsidian v0.15.0+
- macOS (for OCR functionality)

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## License

MIT License - see LICENSE file for details.

## Author

Julian Zhang ([@forrestchang](https://github.com/forrestchang))