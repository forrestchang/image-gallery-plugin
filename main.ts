import { App, Modal, Notice, Plugin, TFile, getAllTags, MarkdownView, DropdownComponent, TextComponent, ButtonComponent, PluginSettingTab, Setting } from 'obsidian';
import { OCRService } from './ocr-service';
import { VaultSearchModal } from './src/modals/VaultSearchModal';

interface ImageInfo {
	path: string;
	file?: TFile;
	isLocal: boolean;
	displayName: string;
	createdTime?: number;
	modifiedTime?: number;
	ocrText?: string;
}

function isFailedImagePath(path: string): boolean {
	return /\.failed\.(png|jpe?g)$/i.test(path.toLowerCase());
}

interface ImageGallerySettings {
	enableOCRDebug: boolean;
	ocrConcurrency: number;
	contextParagraphs: number;
	searchExcludeFolders: string[];
	searchMinimalMode: boolean;
	searchIncludeImages: boolean;
	galleryCardSize: number;
	searchResultFontSize: number;
}

const DEFAULT_SETTINGS: ImageGallerySettings = {
	enableOCRDebug: false,
	ocrConcurrency: 4,
	contextParagraphs: 3,
	searchExcludeFolders: [],
	searchMinimalMode: false,
	searchIncludeImages: true,
	galleryCardSize: 200,
	searchResultFontSize: 13
}

export default class ImageGalleryPlugin extends Plugin {
	ocrService: OCRService;
	settings: ImageGallerySettings;

	async onload() {
		console.log('Loading Image Gallery plugin');
		
		// Load settings
		await this.loadSettings();
		
		// Initialize OCR service
		this.ocrService = new OCRService(this.app);
		await this.ocrService.loadIndex();

		// Add ribbon icon for Image Gallery
		const ribbonIconEl = this.addRibbonIcon('image', 'Image Gallery', (evt: MouseEvent) => {
			this.openImageGallery();
		});

		// Add ribbon icon for Search+
		const searchRibbonIconEl = this.addRibbonIcon('search', 'Search+', (evt: MouseEvent) => {
			this.openVaultSearch();
		});

		// Add command to open gallery
		this.addCommand({
			id: 'open-image-gallery',
			name: 'Open Image Gallery',
			callback: () => {
				this.openImageGallery();
			}
		});

		// Add command to open Search+
		this.addCommand({
			id: 'open-vault-search',
			name: 'Open Search+',
			callback: () => {
				this.openVaultSearch();
			}
		});
		
		// Add command to rebuild OCR index
		this.addCommand({
			id: 'rebuild-ocr-index',
			name: 'Rebuild OCR Index for Images',
			callback: async () => {
				const startTime = Date.now();
				const notice = new Notice('Building OCR index...', 0);
				const images = await this.getAllImages();
				
				await this.ocrService.indexAllImages(images, (current, total) => {
					const elapsed = Math.round((Date.now() - startTime) / 1000);
					const remaining = total - current;
					const rate = current / elapsed || 0;
					const eta = remaining > 0 && rate > 0 ? Math.round(remaining / rate) : 0;
					
					notice.setMessage(`Indexing images: ${current}/${total} (${elapsed}s elapsed, ${eta}s remaining)`);
				}, this.settings.ocrConcurrency);
				
				const totalTime = Math.round((Date.now() - startTime) / 1000);
				notice.setMessage(`OCR index complete! (${totalTime}s total)`);
				setTimeout(() => notice.hide(), 3000);
			}
		});

		// Add command to debug OCR for current image
		this.addCommand({
			id: 'debug-ocr-current-image',
			name: 'Debug OCR for Current Image',
			callback: async () => {
				if (!this.settings.enableOCRDebug) {
					new Notice('OCR debug is disabled. Enable it in plugin settings first.');
					return;
				}

				const activeFile = this.app.workspace.getActiveFile();
				if (!activeFile) {
					new Notice('No active file selected.');
					return;
				}

				const imageExtensions = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'webp'];
				if (!imageExtensions.includes(activeFile.extension.toLowerCase())) {
					new Notice('Active file is not an image.');
					return;
				}

				new OCRDebugModal(this.app, activeFile, this.ocrService).open();
			}
		});

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new ImageGallerySettingTab(this.app, this));
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async openImageGallery() {
		const images = await this.getAllImages();
		new ImageGalleryModal(this.app, images, this.ocrService).open();
	}

	openVaultSearch() {
		new VaultSearchModal(this.app, this).open();
	}

	async getAllImages(): Promise<ImageInfo[]> {
		const images: ImageInfo[] = [];
		const addedPaths = new Set<string>(); // Track added file paths to avoid duplicates
		
		// Get all files in vault
		const files = this.app.vault.getFiles();
		
		// Filter image files (local images)
		const imageExtensions = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'webp'];
		for (const file of files) {
			const extension = file.extension.toLowerCase();
			if (imageExtensions.includes(extension)) {
				if (isFailedImagePath(file.name)) continue;
				images.push({
					path: file.path,
					file: file,
					isLocal: true,
					displayName: file.name,
					createdTime: file.stat.ctime,
					modifiedTime: file.stat.mtime
				});
				addedPaths.add(file.path); // Track this file path
			}
		}

		// Scan markdown files for embedded images and URLs
		const markdownFiles = files.filter(f => f.extension === 'md');
		for (const mdFile of markdownFiles) {
			const content = await this.app.vault.read(mdFile);
			
			// Find wiki-style embeds: ![[image.png]] or ![[image]] (without extension)
			const wikiEmbedRegex = /!\[\[([^\]]+)\]\]/gi;
			let match;
			while ((match = wikiEmbedRegex.exec(content)) !== null) {
				const imagePath = match[1];
				
				// Check if it looks like an image (has extension or common image name)
				const hasImageExtension = /\.(png|jpg|jpeg|gif|bmp|svg|webp)$/i.test(imagePath);
				if (isFailedImagePath(imagePath)) continue;
				const imageFile = this.app.metadataCache.getFirstLinkpathDest(imagePath, mdFile.path);
				
				// Only add if it's an actual file that exists
				if (imageFile && !addedPaths.has(imageFile.path)) {
					// Verify it's an image file
					const extension = imageFile.extension.toLowerCase();
					const imageExtensions = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'webp'];
					
					if (imageExtensions.includes(extension)) {
						if (isFailedImagePath(imageFile.name)) continue;
						images.push({
							path: imageFile.path,
							file: imageFile,
							isLocal: true,
							displayName: imageFile.name,
							createdTime: imageFile.stat.ctime,
							modifiedTime: imageFile.stat.mtime
						});
						addedPaths.add(imageFile.path);
					}
				} else if (!imageFile && hasImageExtension) {
					// Log missing images for debugging
					console.warn(`Image not found: ${imagePath} referenced in ${mdFile.path}`);
				}
			}

			// Find markdown-style embeds: ![](image.png) or ![](http://...)
			const markdownEmbedRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
			while ((match = markdownEmbedRegex.exec(content)) !== null) {
				const imagePath = match[2];
				
				// Check if it's a URL
				if (imagePath.startsWith('http://') || imagePath.startsWith('https://')) {
					// Skip placeholder URLs that are commonly used in examples
					if (imagePath.includes('via.placeholder.com') || 
						imagePath.includes('placeholder.') ||
						imagePath.includes('example.com')) {
						continue;
					}
					if (isFailedImagePath(imagePath)) continue;
					
					// Check if we haven't already added this URL
					if (!addedPaths.has(imagePath)) {
						images.push({
							path: imagePath,
							isLocal: false,
							displayName: match[1] || imagePath.split('/').pop() || 'Remote Image'
						});
						addedPaths.add(imagePath);
					}
				} else {
					// Local image reference
					const imageFile = this.app.metadataCache.getFirstLinkpathDest(imagePath, mdFile.path);
					if (imageFile && !addedPaths.has(imageFile.path)) {
						// Verify it's an image file
						const extension = imageFile.extension.toLowerCase();
						const imageExtensions = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'webp'];
						
						if (imageExtensions.includes(extension)) {
							if (isFailedImagePath(imageFile.name)) continue;
							images.push({
								path: imageFile.path,
								file: imageFile,
								isLocal: true,
								displayName: imageFile.name,
								createdTime: imageFile.stat.ctime,
								modifiedTime: imageFile.stat.mtime
							});
							addedPaths.add(imageFile.path);
						}
					}
				}
			}

			// Find HTML img tags: <img src="...">
			const htmlImgRegex = /<img[^>]+src=["']([^"']+)["'][^>]*>/g;
			while ((match = htmlImgRegex.exec(content)) !== null) {
				const imagePath = match[1];
				
				// Check if it's a URL
				if (imagePath.startsWith('http://') || imagePath.startsWith('https://')) {
					// Skip placeholder URLs that are commonly used in examples
					if (imagePath.includes('via.placeholder.com') || 
						imagePath.includes('placeholder.') ||
						imagePath.includes('example.com')) {
						continue;
					}
					if (isFailedImagePath(imagePath)) continue;
					
					if (!addedPaths.has(imagePath)) {
						images.push({
							path: imagePath,
							isLocal: false,
							displayName: imagePath.split('/').pop() || 'Remote Image'
						});
						addedPaths.add(imagePath);
					}
				}
			}
		}

		return images;
	}

	onunload() {
		console.log('Unloading Image Gallery plugin');
		
		// Clean up all plugin styles on unload
		const styleIds = [
			'image-preview-modal-styles',
			'image-gallery-modal-styles', 
			'ocr-debug-modal-styles',
			'confirm-modal-styles'
		];
		
		styleIds.forEach(id => {
			const style = document.getElementById(id);
			if (style) {
				style.remove();
			}
		});
		
		// Also clean up any remaining plugin styles
		const styles = document.querySelectorAll('style');
		styles.forEach(style => {
			if (style.textContent && (
				style.textContent.includes('.image-preview-container') ||
				style.textContent.includes('.image-gallery-container') ||
				style.textContent.includes('.ocr-debug-') ||
				style.textContent.includes('.confirm-')
			)) {
				style.remove();
			}
		});
	}
}

class ImagePreviewModal extends Modal {
	imageInfo: ImageInfo;
	currentIndex: number;
	allImages: ImageInfo[];
	app: App;
	zoomLevel: number = 1;
	minZoom: number = 0.5;
	maxZoom: number = 5;
	imageEl: HTMLImageElement | null = null;
	imageContainer: HTMLElement | null = null;
	isPanning: boolean = false;
	startX: number = 0;
	startY: number = 0;
	translateX: number = 0;
	translateY: number = 0;

	constructor(app: App, imageInfo: ImageInfo, allImages: ImageInfo[], currentIndex: number) {
		super(app);
		this.app = app;
		this.imageInfo = imageInfo;
		this.allImages = allImages;
		this.currentIndex = currentIndex;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		
		// Reset zoom and pan when changing images
		this.zoomLevel = 1;
		this.translateX = 0;
		this.translateY = 0;
		
		// Clean up any existing styles first
		this.cleanupStyles();
		
		// Add custom class for styling
		this.modalEl.addClass('mod-image-preview');
		
		// Create container
		const container = contentEl.createDiv({ cls: 'image-preview-container' });
		
		// Add top controls container - compact menu bar
		const topControls = container.createDiv({ cls: 'image-preview-top-controls' });
		
		// Navigation controls (left side)
		const navControls = topControls.createDiv({ cls: 'image-preview-nav-controls' });
		
		// Add navigation buttons if there are multiple images
		if (this.allImages.length > 1) {
			// Previous button
			const prevBtn = navControls.createEl('button', { 
				text: '◀', 
				cls: 'image-preview-control-btn',
				title: 'Previous (←)'
			});
			prevBtn.onclick = () => this.navigate(-1);
			
			// Image counter
			navControls.createEl('span', { 
				text: `${this.currentIndex + 1} / ${this.allImages.length}`,
				cls: 'image-preview-counter'
			});
			
			// Next button
			const nextBtn = navControls.createEl('button', { 
				text: '▶', 
				cls: 'image-preview-control-btn',
				title: 'Next (→)'
			});
			nextBtn.onclick = () => this.navigate(1);
			
			// Random button
			const randomBtn = navControls.createEl('button', { 
				text: '🎲', 
				cls: 'image-preview-control-btn',
				title: 'Random Image (Space)'
			});
			randomBtn.onclick = () => this.navigateRandom();
		}
		
		// Action controls (right side)
		const actionControls = topControls.createDiv({ cls: 'image-preview-action-controls' });
		
		// Zoom controls
		const zoomOutBtn = actionControls.createEl('button', { 
			text: '−', 
			cls: 'image-preview-control-btn',
			title: 'Zoom Out (-)'
		});
		zoomOutBtn.onclick = () => this.zoom(-0.25);
		
		// Zoom level display
		const zoomLevelEl = actionControls.createEl('span', { 
			text: '100%',
			cls: 'image-preview-zoom-level'
		});
		
		const zoomInBtn = actionControls.createEl('button', { 
			text: '+', 
			cls: 'image-preview-control-btn',
			title: 'Zoom In (+)'
		});
		zoomInBtn.onclick = () => this.zoom(0.25);
		
		const resetZoomBtn = actionControls.createEl('button', { 
			text: 'Reset', 
			cls: 'image-preview-control-btn',
			title: 'Reset Zoom (R)'
		});
		resetZoomBtn.onclick = () => this.resetZoom();
		
		const fitBtn = actionControls.createEl('button', { 
			text: 'Fit', 
			cls: 'image-preview-control-btn',
			title: 'Fit to Window (F)'
		});
		fitBtn.onclick = () => this.fitToWindow();
		
		// Add OCR debug button for local images if debug is enabled
		if (this.imageInfo.isLocal && this.imageInfo.file) {
			const ocrDebugBtn = actionControls.createEl('button', {
				text: '🔍',
				cls: 'image-preview-control-btn',
				title: 'Debug OCR'
			});

			ocrDebugBtn.onclick = () => {
				const plugin = (this.app as any).plugins.getPlugin('image-gallery-plugin');
				if (!plugin) {
					new Notice('Plugin not found');
					return;
				}

				if (!plugin.settings.enableOCRDebug) {
					new Notice('OCR debug is disabled. Enable it in plugin settings first.');
					return;
				}

				new OCRDebugModal(this.app, this.imageInfo.file!, plugin.ocrService).open();
			};
		}
		
		// Image container
		this.imageContainer = container.createDiv({ cls: 'image-preview-image-container' });
		this.imageEl = this.imageContainer.createEl('img', { cls: 'image-preview-img' });
		
		if (this.imageInfo.isLocal && this.imageInfo.file) {
			const resourcePath = this.app.vault.getResourcePath(this.imageInfo.file);
			this.imageEl.src = resourcePath;
		} else {
			this.imageEl.src = this.imageInfo.path;
		}
		
		this.imageEl.alt = this.imageInfo.displayName;
		
		// Add mouse wheel zoom
		this.imageContainer.addEventListener('wheel', (e: WheelEvent) => {
			e.preventDefault();
			const delta = e.deltaY > 0 ? -0.1 : 0.1;
			this.zoom(delta);
		});
		
		// Add pan functionality
		this.imageEl.addEventListener('mousedown', (e: MouseEvent) => {
			if (this.zoomLevel > 1) {
				this.isPanning = true;
				this.startX = e.clientX - this.translateX;
				this.startY = e.clientY - this.translateY;
				this.imageEl!.style.cursor = 'grabbing';
				e.preventDefault();
			}
		});
		
		document.addEventListener('mousemove', (e: MouseEvent) => {
			if (this.isPanning && this.imageEl) {
				this.translateX = e.clientX - this.startX;
				this.translateY = e.clientY - this.startY;
				this.updateImageTransform();
			}
		});
		
		document.addEventListener('mouseup', () => {
			if (this.isPanning && this.imageEl) {
				this.isPanning = false;
				this.imageEl.style.cursor = this.zoomLevel > 1 ? 'grab' : 'default';
			}
		});
		
		// Update zoom level display
		const updateZoomDisplay = () => {
			zoomLevelEl.textContent = `${Math.round(this.zoomLevel * 100)}%`;
		};
		
		// Store reference to zoom display element for updates
		(this.imageEl as any).zoomDisplayEl = zoomLevelEl;

		// Compact bottom metadata bar
		const bottomBar = container.createDiv({ cls: 'image-preview-bottom-bar' });
		
		// Build metadata string parts
		const metadataParts: string[] = [];
		metadataParts.push(this.imageInfo.displayName);
		
		if (this.imageInfo.createdTime) {
			const createdDate = new Date(this.imageInfo.createdTime);
			metadataParts.push(`Created: ${createdDate.toLocaleDateString()}`);
		}
		
		// Add referencing notes info for local images
		if (this.imageInfo.isLocal && this.imageInfo.file) {
			const plugin = (this.app as any).plugins.getPlugin('image-gallery-plugin');
			if (plugin && plugin.ocrService) {
				const ocrResult = plugin.ocrService.getCachedResult(this.imageInfo.file.path);
				if (ocrResult && ocrResult.context && ocrResult.context.referencingNotes.length > 0) {
					const notesTitles = ocrResult.context.referencingNotes.map((note: any) => note.title);
					if (notesTitles.length > 0) {
						if (notesTitles.length === 1) {
							metadataParts.push(`Referenced in: ${notesTitles[0]}`);
						} else {
							metadataParts.push(`Referenced in ${notesTitles.length} notes: ${notesTitles.slice(0, 2).join(', ')}${notesTitles.length > 2 ? '...' : ''}`);
						}
					}
					
					// Add clickable referencing notes section (expandable)
					const referencingBtn = actionControls.createEl('button', { 
						text: '📝',
						cls: 'image-preview-control-btn',
						title: `Jump to referencing notes (${ocrResult.context.referencingNotes.length})`
					});
					
					referencingBtn.onclick = () => {
						// Create a quick selector modal for referencing notes
						const notes = ocrResult.context!.referencingNotes;
						if (notes.length === 1) {
							// If only one note, open it directly
							const file = this.app.vault.getAbstractFileByPath(notes[0].path);
							if (file instanceof TFile) {
								const leaf = this.app.workspace.getLeaf('tab');
								leaf.openFile(file);
								this.close();
								new Notice(`Opened: ${notes[0].title}`);
							}
						} else {
							// Create a simple selection modal
							const suggester = new (this as any).app.plugins.plugins.quickswitcher?.QuickSwitcherModal || null;
							if (suggester) {
								// Use existing quick switcher if available
								notes.forEach(async (note: any) => {
									const file = this.app.vault.getAbstractFileByPath(note.path);
									if (file instanceof TFile) {
										const leaf = this.app.workspace.getLeaf('tab');
										await leaf.openFile(file);
									}
								});
							} else {
								// Simple notice with first note
								const file = this.app.vault.getAbstractFileByPath(notes[0].path);
								if (file instanceof TFile) {
									const leaf = this.app.workspace.getLeaf('tab');
									leaf.openFile(file);
									this.close();
									new Notice(`Opened: ${notes[0].title}`);
								}
							}
						}
					};
				}
			}
		}
		
		// Join all metadata parts with separators
		bottomBar.createEl('div', { 
			text: metadataParts.join(' • '),
			cls: 'image-preview-metadata'
		});
		
		// Add CSS styles with unique ID and proper isolation
		const style = document.createElement('style');
		style.id = 'image-preview-modal-styles';
		// Use data attribute to increase specificity and prevent conflicts
		style.textContent = `
			/* Scoped styles for image preview modal only */
			.modal.mod-image-preview {
				width: 90vw;
				max-width: 90vw;
				height: 90vh;
				max-height: 90vh;
			}
			.modal.mod-image-preview .modal-content {
				max-width: none;
				height: 100%;
				padding: 16px;
			}
			.modal.mod-image-preview .image-preview-container {
				display: flex;
				flex-direction: column;
				height: 100%;
				gap: 8px;
			}
			
			/* Compact top controls bar */
			.modal.mod-image-preview .image-preview-top-controls {
				display: flex;
				justify-content: space-between;
				align-items: center;
				padding: 6px 12px;
				background: var(--background-secondary);
				border-radius: 6px;
				min-height: 36px;
			}
			
			/* Navigation controls (left side) */
			.modal.mod-image-preview .image-preview-nav-controls {
				display: flex;
				align-items: center;
				gap: 8px;
			}
			
			/* Action controls (right side) */
			.modal.mod-image-preview .image-preview-action-controls {
				display: flex;
				align-items: center;
				gap: 6px;
			}
			
			/* Unified button styles */
			.modal.mod-image-preview .image-preview-control-btn {
				padding: 4px 8px;
				background: var(--interactive-normal);
				color: var(--text-normal);
				border: 1px solid var(--background-modifier-border);
				border-radius: 4px;
				cursor: pointer;
				font-size: 13px;
				min-width: 28px;
				height: 28px;
				display: flex;
				align-items: center;
				justify-content: center;
			}
			.modal.mod-image-preview .image-preview-control-btn:hover {
				background: var(--interactive-hover);
			}
			
			.modal.mod-image-preview .image-preview-counter {
				font-weight: 500;
				font-size: 12px;
				color: var(--text-muted);
				min-width: 60px;
				text-align: center;
			}
			
			.modal.mod-image-preview .image-preview-zoom-level {
				min-width: 40px;
				text-align: center;
				font-weight: 500;
				font-size: 12px;
				color: var(--text-muted);
			}
			
			/* Main image container */
			.modal.mod-image-preview .image-preview-image-container {
				flex: 1;
				display: flex;
				justify-content: center;
				align-items: center;
				overflow: hidden;
				background: var(--background-secondary);
				border-radius: 6px;
				position: relative;
			}
			.modal.mod-image-preview .image-preview-img {
				max-width: 100%;
				max-height: 100%;
				object-fit: contain;
				transition: transform 0.1s ease;
				transform-origin: center center;
				user-select: none;
				-webkit-user-drag: none;
			}
			.modal.mod-image-preview .image-preview-img.zoomed {
				cursor: grab;
			}
			.modal.mod-image-preview .image-preview-img.zoomed:active {
				cursor: grabbing;
			}
			
			/* Compact bottom metadata bar */
			.modal.mod-image-preview .image-preview-bottom-bar {
				padding: 6px 12px;
				background: var(--background-secondary);
				border-radius: 6px;
			}
			.modal.mod-image-preview .image-preview-metadata {
				font-size: 11px;
				color: var(--text-muted);
				text-align: center;
				overflow: hidden;
				text-overflow: ellipsis;
				white-space: nowrap;
			}
		`;
		// Append style to modal element instead of document.head to limit scope
		// This helps prevent conflicts with other plugins
		this.modalEl.appendChild(style);
		
		// Keyboard navigation and zoom
		this.modalEl.addEventListener('keydown', (e: KeyboardEvent) => {
			if (e.key === 'ArrowLeft') {
				this.navigate(-1);
			} else if (e.key === 'ArrowRight') {
				this.navigate(1);
			} else if (e.key === ' ') {
				e.preventDefault(); // Prevent page scroll
				this.navigateRandom();
			} else if (e.key === '+' || e.key === '=') {
				this.zoom(0.25);
			} else if (e.key === '-') {
				this.zoom(-0.25);
			} else if (e.key === 'r' || e.key === 'R') {
				this.resetZoom();
			} else if (e.key === 'f' || e.key === 'F') {
				this.fitToWindow();
			}
		});
	}
	
	zoom(delta: number) {
		this.zoomLevel = Math.max(this.minZoom, Math.min(this.maxZoom, this.zoomLevel + delta));
		this.updateImageTransform();
		
		// Update zoom level display
		const zoomDisplayEl = (this.imageEl as any)?.zoomDisplayEl;
		if (zoomDisplayEl) {
			zoomDisplayEl.textContent = `${Math.round(this.zoomLevel * 100)}%`;
		}
		
		// Update cursor
		if (this.imageEl) {
			this.imageEl.style.cursor = this.zoomLevel > 1 ? 'grab' : 'default';
			if (this.zoomLevel > 1) {
				this.imageEl.classList.add('zoomed');
			} else {
				this.imageEl.classList.remove('zoomed');
				// Reset pan when zoom is 1 or less
				this.translateX = 0;
				this.translateY = 0;
			}
		}
	}
	
	resetZoom() {
		this.zoomLevel = 1;
		this.translateX = 0;
		this.translateY = 0;
		this.updateImageTransform();
		
		// Update zoom level display
		const zoomDisplayEl = (this.imageEl as any)?.zoomDisplayEl;
		if (zoomDisplayEl) {
			zoomDisplayEl.textContent = `${Math.round(this.zoomLevel * 100)}%`;
		}
		
		if (this.imageEl) {
			this.imageEl.style.cursor = 'default';
			this.imageEl.classList.remove('zoomed');
		}
	}
	
	fitToWindow() {
		if (!this.imageEl || !this.imageContainer) return;
		
		const containerRect = this.imageContainer.getBoundingClientRect();
		const imgWidth = this.imageEl.naturalWidth;
		const imgHeight = this.imageEl.naturalHeight;
		
		const scaleX = containerRect.width / imgWidth;
		const scaleY = containerRect.height / imgHeight;
		
		this.zoomLevel = Math.min(scaleX, scaleY, 1);
		this.translateX = 0;
		this.translateY = 0;
		this.updateImageTransform();
		
		// Update zoom level display
		const zoomDisplayEl = (this.imageEl as any)?.zoomDisplayEl;
		if (zoomDisplayEl) {
			zoomDisplayEl.textContent = `${Math.round(this.zoomLevel * 100)}%`;
		}
		
		this.imageEl.style.cursor = 'default';
		this.imageEl.classList.remove('zoomed');
	}
	
	updateImageTransform() {
		if (this.imageEl) {
			this.imageEl.style.transform = `scale(${this.zoomLevel}) translate(${this.translateX / this.zoomLevel}px, ${this.translateY / this.zoomLevel}px)`;
		}
	}
	
	navigate(direction: number) {
		this.currentIndex = (this.currentIndex + direction + this.allImages.length) % this.allImages.length;
		this.imageInfo = this.allImages[this.currentIndex];
		this.onOpen(); // Re-render with new image
	}
	
	navigateRandom() {
		if (this.allImages.length <= 1) return;
		
		// Generate a random index different from current
		let randomIndex;
		do {
			randomIndex = Math.floor(Math.random() * this.allImages.length);
		} while (randomIndex === this.currentIndex && this.allImages.length > 1);
		
		this.currentIndex = randomIndex;
		this.imageInfo = this.allImages[this.currentIndex];
		this.onOpen(); // Re-render with new image
	}

	cleanupStyles() {
		// Styles are now in modal element, so they get cleaned up automatically
		// This method is kept for compatibility but no longer needed
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
		
		// Clean up styles
		this.cleanupStyles();
	}
}

class ImageGalleryModal extends Modal {
	images: ImageInfo[];
	sortedImages: ImageInfo[];
	filteredImages: ImageInfo[];
	currentSort: string = 'created-new';
	currentSearch: string = '';
	galleryContainer: HTMLElement;
	ocrService: OCRService;
	searchInput: TextComponent;
	statsContainer: HTMLElement;
	indexStatusEl: HTMLElement;
	private searchTimeout?: NodeJS.Timeout;
	private settings: ImageGallerySettings;
	private currentCardSize: number;

	constructor(app: App, images: ImageInfo[], ocrService: OCRService) {
		super(app);
		this.images = images;
		this.sortedImages = [...images];
		this.filteredImages = [...images];
		this.ocrService = ocrService;
		
		// Get plugin settings
		const plugin = (this.app as any).plugins.getPlugin('image-gallery-plugin');
		this.settings = plugin?.settings || DEFAULT_SETTINGS;
		this.currentCardSize = this.settings.galleryCardSize || 200;
		
		this.sortImages('created-new');
	}

	sortImages(sortType: string) {
		this.currentSort = sortType;
		
		switch(sortType) {
			case 'name-asc':
				this.filteredImages.sort((a, b) => a.displayName.localeCompare(b.displayName));
				break;
			case 'name-desc':
				this.filteredImages.sort((a, b) => b.displayName.localeCompare(a.displayName));
				break;
			case 'created-new':
				this.filteredImages.sort((a, b) => {
					const aTime = a.createdTime || 0;
					const bTime = b.createdTime || 0;
					return bTime - aTime;
				});
				break;
			case 'created-old':
				this.filteredImages.sort((a, b) => {
					const aTime = a.createdTime || 0;
					const bTime = b.createdTime || 0;
					return aTime - bTime;
				});
				break;
			case 'modified-new':
				this.filteredImages.sort((a, b) => {
					const aTime = a.modifiedTime || 0;
					const bTime = b.modifiedTime || 0;
					return bTime - aTime;
				});
				break;
			case 'modified-old':
				this.filteredImages.sort((a, b) => {
					const aTime = a.modifiedTime || 0;
					const bTime = b.modifiedTime || 0;
					return aTime - bTime;
				});
				break;
			case 'type':
				this.filteredImages.sort((a, b) => {
					if (a.isLocal === b.isLocal) {
						return a.displayName.localeCompare(b.displayName);
					}
					return a.isLocal ? -1 : 1;
				});
				break;
		}
	}

	async searchImages(query: string) {
		this.currentSearch = query.toLowerCase();
		
		if (!query) {
			// No search query, show all images
			this.filteredImages = [...this.sortedImages];
		} else {
			// First, filter by filename
			this.filteredImages = this.sortedImages.filter(img => 
				img.displayName.toLowerCase().includes(this.currentSearch)
			);
			
			// Then, add images that match OCR content
			if (this.ocrService) {
				const ocrMatches = this.ocrService.searchImages(query);
				
				for (const img of this.sortedImages) {
					if (img.file && ocrMatches.has(img.file.path)) {
						// Add if not already in filtered list
						if (!this.filteredImages.includes(img)) {
							this.filteredImages.push(img);
						}
					}
				}
			}
		}
		
		// Re-apply current sort
		this.sortImages(this.currentSort);
		this.renderGallery();
		this.updateStats();
	}
	
	updateStats() {
		if (!this.statsContainer) return;
		
		const localImages = this.filteredImages.filter(img => img.isLocal).length;
		const remoteImages = this.filteredImages.filter(img => !img.isLocal).length;
		
		// Update stats display
		const statElements = this.statsContainer.querySelectorAll('.image-gallery-stat');
		if (statElements[0]) {
			statElements[0].innerHTML = `<span class="image-gallery-stat-label">Showing:</span> ${this.filteredImages.length}/${this.images.length}`;
		}
		if (statElements[1]) {
			statElements[1].innerHTML = `<span class="image-gallery-stat-label">Local:</span> ${localImages}`;
		}
		if (statElements[2]) {
			statElements[2].innerHTML = `<span class="image-gallery-stat-label">Remote:</span> ${remoteImages}`;
		}
	}

	updateCardSize() {
		// Update CSS variable for card size
		if (this.galleryContainer) {
			this.galleryContainer.style.setProperty('--card-size', `${this.currentCardSize}px`);
		}
		
		// Update all image heights
		const images = this.galleryContainer.querySelectorAll('.image-gallery-item img');
		images.forEach((img: HTMLElement) => {
			img.style.height = `${this.currentCardSize}px`;
		});
	}

	async performIncrementalUpdate() {
		try {
			// Get plugin settings for concurrency
			const plugin = (this.app as any).plugins.getPlugin('image-gallery-plugin');
			const concurrency = plugin?.settings?.ocrConcurrency || 4;

			// Perform incremental update
			const result = await this.ocrService.incrementalUpdate(this.images, undefined, concurrency);

			// Show subtle notification if new images were indexed
			if (result.indexed > 0) {
				new Notice(`Updated OCR index: ${result.indexed} new/modified images processed`, 3000);
				
				// Update index status if element exists
				if (this.indexStatusEl) {
					const stats = this.ocrService.getIndexStats();
					this.indexStatusEl.textContent = `OCR Index: ${stats.total} images`;
				}
			}
		} catch (error) {
			console.error('Incremental OCR update failed:', error);
			// Don't show error to user as this is a background operation
		}
	}

	renderGallery() {
		this.galleryContainer.empty();
		
		// Use DocumentFragment for better performance
		const fragment = document.createDocumentFragment();
		
		// Display images
		for (const imageInfo of this.filteredImages) {
			const itemContainer = document.createElement('div');
			itemContainer.className = 'image-gallery-item';
			
			const img = document.createElement('img');
			
			if (imageInfo.isLocal && imageInfo.file) {
				// For local images, use Obsidian's resource path
				const resourcePath = this.app.vault.getResourcePath(imageInfo.file);
				img.src = resourcePath;
			} else {
				// For remote images, use the URL directly
				img.src = imageInfo.path;
			}
			
			img.alt = imageInfo.displayName;
			img.loading = 'lazy'; // Native lazy loading for performance
			
			// Add error handling - remove the item if image fails to load
			img.onerror = () => {
				// Remove this item from the gallery
				itemContainer.remove();
			};
			
			// Add title with date info
			const titleEl = document.createElement('div');
			titleEl.className = 'image-gallery-item-title';
			titleEl.textContent = imageInfo.displayName;
			
			// Add tooltip with creation time if available
			if (imageInfo.createdTime) {
				const createdDate = new Date(imageInfo.createdTime);
				titleEl.title = `Created: ${createdDate.toLocaleString()}`;
			}
			
			itemContainer.appendChild(img);
			itemContainer.appendChild(titleEl);
			fragment.appendChild(itemContainer);
		}
		
		// Append all items at once
		this.galleryContainer.appendChild(fragment);
		
		// Add message if no images found
		if (this.filteredImages.length === 0) {
			this.galleryContainer.createEl('p', { 
				text: 'No images found in the vault.',
				cls: 'image-gallery-empty'
			});
		}
	}

	async onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		
		// Add custom class to modal for styling
		this.modalEl.addClass('mod-image-gallery');
		
		// Keep gallery open when pressing Escape
		this.scope.register([], 'Escape', (evt) => {
			evt.preventDefault();
			evt.stopPropagation();
		});
		
		// Add title
		const titleEl = contentEl.createEl('h2', { text: `Image Gallery (${this.images.length} images)` });
		
		// Perform incremental OCR index update in background
		this.performIncrementalUpdate();
		
		// Create compact header container
		const headerContainer = contentEl.createDiv({ cls: 'image-gallery-header' });
		
		// Left section: Search input
		const searchSection = headerContainer.createDiv({ cls: 'search-section' });
		this.searchInput = new TextComponent(searchSection);
		this.searchInput.setPlaceholder('Search: "exact phrase", word1 word2, word1 OR word2, -exclude');
		this.searchInput.inputEl.addClass('image-gallery-search-input');
		this.searchInput.onChange(async (value) => {
			// Debounce search for better performance
			if (this.searchTimeout) {
				clearTimeout(this.searchTimeout);
			}
			
			this.searchTimeout = setTimeout(async () => {
				await this.searchImages(value);
			}, 300); // 300ms debounce
		});
		
		// Center section: OCR status and controls
		const ocrSection = headerContainer.createDiv({ cls: 'ocr-section' });
		
		// Index status (compact)
		const indexStats = this.ocrService.getIndexStats();
		this.indexStatusEl = ocrSection.createEl('span', {
			cls: 'ocr-index-status',
			text: `${indexStats.total}`
		});
		this.indexStatusEl.title = 'Images indexed for OCR search';
		
		// Index button (compact)
		const indexBtn = new ButtonComponent(ocrSection);
		indexBtn.setButtonText('Index');
		indexBtn.setTooltip('Build OCR index for text search');
		indexBtn.onClick(async () => {
			indexBtn.setDisabled(true);
			indexBtn.setButtonText('...');
			
			const startTime = Date.now();
			const notice = new Notice('Building OCR index...', 0);
			let indexedCount = 0;
			
			// Get plugin settings for concurrency
			const plugin = (this.app as any).plugins.getPlugin('image-gallery-plugin');
			const concurrency = plugin?.settings?.ocrConcurrency || 4;
			
			await this.ocrService.indexAllImages(this.images, (current, total) => {
				indexedCount = current;
				const elapsed = Math.round((Date.now() - startTime) / 1000);
				const remaining = total - current;
				const rate = current / elapsed || 0;
				const eta = remaining > 0 && rate > 0 ? Math.round(remaining / rate) : 0;
				
				notice.setMessage(`Indexing: ${current}/${total} (${eta}s remaining)`);
				indexBtn.setButtonText(`${current}/${total}`);
			}, concurrency);
			
			const totalTime = Math.round((Date.now() - startTime) / 1000);
			notice.setMessage(`OCR index complete! ${indexedCount} images (${totalTime}s)`);
			setTimeout(() => notice.hide(), 3000);
			
			// Update status
			const newStats = this.ocrService.getIndexStats();
			this.indexStatusEl.textContent = `${newStats.total}`;
			
			indexBtn.setButtonText('Index');
			indexBtn.setDisabled(false);
			
			// Re-run search if there's a query
			if (this.currentSearch) {
				await this.searchImages(this.currentSearch);
			}
		});
		
		// Right section: Card size slider and Sort dropdown
		const rightSection = headerContainer.createDiv({ cls: 'right-section' });
		
		// Card size controls
		const cardSizeContainer = rightSection.createDiv({ cls: 'card-size-container' });
		cardSizeContainer.createEl('span', { text: '📐', cls: 'card-size-icon', title: 'Card Size' });
		
		// Card size slider
		const slider = cardSizeContainer.createEl('input', {
			type: 'range',
			cls: 'card-size-slider'
		});
		slider.min = '100';
		slider.max = '400';
		slider.step = '20';
		slider.value = this.currentCardSize.toString();
		
		// Card size value display
		const sizeDisplay = cardSizeContainer.createEl('span', { 
			text: `${this.currentCardSize}px`,
			cls: 'card-size-value'
		});
		
		// Update card size on slider change
		slider.addEventListener('input', (e) => {
			const newSize = parseInt((e.target as HTMLInputElement).value);
			this.currentCardSize = newSize;
			sizeDisplay.textContent = `${newSize}px`;
			this.updateCardSize();
			
			// Save preference to settings
			const plugin = (this.app as any).plugins.getPlugin('image-gallery-plugin');
			if (plugin) {
				plugin.settings.galleryCardSize = newSize;
				plugin.saveSettings();
			}
		});
		
		// Sort dropdown
		const sortSection = rightSection.createDiv({ cls: 'sort-section' });
		const dropdown = new DropdownComponent(sortSection);
		dropdown.addOption('name-asc', 'Name (A-Z)');
		dropdown.addOption('name-desc', 'Name (Z-A)');
		dropdown.addOption('created-new', 'Created (Newest First)');
		dropdown.addOption('created-old', 'Created (Oldest First)');
		dropdown.addOption('modified-new', 'Modified (Newest First)');
		dropdown.addOption('modified-old', 'Modified (Oldest First)');
		dropdown.addOption('type', 'Type (Local/Remote)');
		
		dropdown.setValue(this.currentSort);
		dropdown.onChange((value) => {
			this.sortImages(value);
			this.renderGallery();
		});
		
		// Create gallery container
		this.galleryContainer = contentEl.createDiv({ cls: 'image-gallery-container' });
		
		// Add statistics after gallery (more compact at bottom)
		const localImages = this.filteredImages.filter(img => img.isLocal).length;
		const remoteImages = this.filteredImages.filter(img => !img.isLocal).length;
		
		this.statsContainer = contentEl.createDiv({ cls: 'image-gallery-stats' });
		this.statsContainer.createDiv({ cls: 'image-gallery-stat' }).innerHTML = 
			`<span class="image-gallery-stat-label">Showing:</span> ${this.filteredImages.length}/${this.images.length}`;
		this.statsContainer.createDiv({ cls: 'image-gallery-stat' }).innerHTML = 
			`<span class="image-gallery-stat-label">Local:</span> ${localImages}`;
		this.statsContainer.createDiv({ cls: 'image-gallery-stat' }).innerHTML = 
			`<span class="image-gallery-stat-label">Remote:</span> ${remoteImages}`;

		// Add CSS styles with unique ID and proper isolation
		const style = document.createElement('style');
		style.id = 'image-gallery-modal-styles';
		style.textContent = `
			.modal.mod-image-gallery {
				width: 80vw;
				max-width: 80vw;
			}
			.modal.mod-image-gallery .modal-content {
				max-width: none;
			}
			.modal.mod-image-gallery .image-gallery-header {
				display: flex;
				align-items: center;
				gap: 12px;
				padding: 6px 0;
				border-bottom: 1px solid var(--background-modifier-border);
				margin-bottom: 10px;
			}
			.modal.mod-image-gallery .search-section {
				flex: 1;
				min-width: 200px;
			}
			.modal.mod-image-gallery .image-gallery-search-input {
				width: 100%;
				background: var(--background-secondary);
				border: 1px solid var(--background-modifier-border);
				border-radius: 4px;
				padding: 6px 10px;
				font-size: 13px;
				color: var(--text-normal);
			}
			.modal.mod-image-gallery .image-gallery-search-input:focus {
				border-color: var(--interactive-accent);
				box-shadow: 0 0 0 1px var(--interactive-accent-alpha);
				outline: none;
			}
			.modal.mod-image-gallery .image-gallery-search-input::placeholder {
				color: var(--text-muted);
			}
			.modal.mod-image-gallery .ocr-section {
				display: flex;
				align-items: center;
				gap: 6px;
				flex-shrink: 0;
			}
			.modal.mod-image-gallery .ocr-index-status {
				color: var(--text-accent);
				font-size: 11px;
				font-weight: 500;
				background: var(--background-modifier-hover);
				padding: 2px 6px;
				border-radius: 3px;
				cursor: help;
			}
			.modal.mod-image-gallery .right-section {
				display: flex;
				align-items: center;
				gap: 12px;
				flex-shrink: 0;
			}
			.modal.mod-image-gallery .card-size-container {
				display: flex;
				align-items: center;
				gap: 6px;
			}
			.modal.mod-image-gallery .card-size-icon {
				font-size: 14px;
				cursor: help;
			}
			.modal.mod-image-gallery .card-size-slider {
				width: 100px;
				cursor: pointer;
			}
			.modal.mod-image-gallery .card-size-value {
				font-size: 11px;
				color: var(--text-muted);
				min-width: 40px;
				text-align: right;
			}
			.modal.mod-image-gallery .sort-section {
				flex-shrink: 0;
				display: flex;
				align-items: center;
			}
			.modal.mod-image-gallery .sort-section .dropdown {
				font-size: 12px;
			}
			.modal.mod-image-gallery .ocr-section .clickable-icon,
			.modal.mod-image-gallery .ocr-section button {
				padding: 4px 8px;
				font-size: 11px;
				border-radius: 3px;
				background: var(--background-secondary);
				border: 1px solid var(--background-modifier-border);
			}
			.modal.mod-image-gallery .ocr-section .clickable-icon:hover,
			.modal.mod-image-gallery .ocr-section button:hover {
				background: var(--background-modifier-hover);
			}
				.modal.mod-image-gallery .image-gallery-container {
					display: grid;
					grid-template-columns: repeat(auto-fill, minmax(var(--card-size, 200px), 1fr));
					gap: 15px;
					padding: 10px 0 15px 0;
					max-height: 75vh;
					overflow-y: auto;
					--card-size: ${this.currentCardSize}px;
				}
			.modal.mod-image-gallery .image-gallery-stats {
				display: flex;
				justify-content: center;
				gap: 20px;
				padding: 8px 0;
				border-top: 1px solid var(--background-modifier-border);
				margin-top: 5px;
				font-size: 11px;
				color: var(--text-muted);
			}
			.modal.mod-image-gallery .image-gallery-stat-label {
				font-weight: 500;
				margin-right: 4px;
			}
				.modal.mod-image-gallery .image-gallery-item {
					position: relative;
					border: 1px solid var(--background-modifier-border);
					border-radius: 8px;
					overflow: hidden;
					background: var(--background-secondary);
				}
				.modal.mod-image-gallery .image-gallery-item img {
					width: 100%;
					height: var(--card-size, 200px);
					object-fit: cover;
					display: block;
				}
			.modal.mod-image-gallery .image-gallery-item-title {
				padding: 8px;
				font-size: 12px;
				text-align: center;
				white-space: nowrap;
				overflow: hidden;
				text-overflow: ellipsis;
				background: var(--background-primary);
				border-top: 1px solid var(--background-modifier-border);
			}
			.modal.mod-image-gallery .image-gallery-stats {
				padding: 10px;
				background: var(--background-secondary);
				border-radius: 8px;
				margin-bottom: 10px;
				display: flex;
				gap: 20px;
			}
			.modal.mod-image-gallery .image-gallery-stat {
				display: flex;
				gap: 5px;
			}
			.modal.mod-image-gallery .image-gallery-stat-label {
				font-weight: bold;
			}
		`;
		// Append style to modal element instead of document.head to limit scope
		// This helps prevent conflicts with other plugins
		this.modalEl.appendChild(style);
		
		
		// Initial render of gallery
		this.renderGallery();
		
		// Apply initial card size
		this.updateCardSize();
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
		
		// Clean up timeout
		if (this.searchTimeout) {
			clearTimeout(this.searchTimeout);
		}
		
		// Styles are now in modal element, so they get cleaned up automatically
	}
}

class OCRDebugModal extends Modal {
	file: TFile;
	ocrService: OCRService;
	isProcessing: boolean = false;

	constructor(app: App, file: TFile, ocrService: OCRService) {
		super(app);
		this.file = file;
		this.ocrService = ocrService;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		this.modalEl.addClass('mod-ocr-debug');

		// Title
		contentEl.createEl('h2', { text: 'OCR Debug' });

		// Image info
		const imageInfo = contentEl.createDiv({ cls: 'ocr-debug-image-info' });
		imageInfo.createEl('p', { text: `File: ${this.file.name}` });
		imageInfo.createEl('p', { text: `Path: ${this.file.path}` });

		// Image preview
		const imageContainer = contentEl.createDiv({ cls: 'ocr-debug-image-container' });
		const img = imageContainer.createEl('img', { cls: 'ocr-debug-image' });
		const resourcePath = this.app.vault.getResourcePath(this.file);
		img.src = resourcePath;
		img.alt = this.file.name;

		// Results container
		const resultsContainer = contentEl.createDiv({ cls: 'ocr-debug-results' });
		resultsContainer.createEl('h3', { text: 'OCR Results' });

		// Cached result
		const cachedResult = this.ocrService.getCachedResult(this.file.path);
		if (cachedResult) {
			const cachedSection = resultsContainer.createDiv({ cls: 'ocr-debug-section' });
			cachedSection.createEl('h4', { text: 'Cached Result:' });
			const cachedDate = new Date(cachedResult.timestamp).toLocaleString();
			cachedSection.createEl('p', { text: `Cached on: ${cachedDate}`, cls: 'ocr-debug-timestamp' });
			
			// OCR text
			cachedSection.createEl('h5', { text: 'OCR Text:' });
			const cachedTextEl = cachedSection.createEl('div', { cls: 'ocr-debug-text' });
			cachedTextEl.textContent = cachedResult.text || '(empty)';

			// Context information
			if (cachedResult.context) {
				cachedSection.createEl('h5', { text: 'Context Information:' });
				
				// Referencing notes
				if (cachedResult.context.referencingNotes.length > 0) {
					cachedSection.createEl('h6', { text: 'Referenced in Notes:' });
					const notesEl = cachedSection.createEl('div', { cls: 'ocr-debug-context' });
					const notesList = cachedResult.context.referencingNotes.map(note => `• ${note.title}`).join('\n');
					notesEl.textContent = notesList;
				}

				// Nearby content
				if (cachedResult.context.nearbyContent) {
					cachedSection.createEl('h6', { text: 'Nearby Content:' });
					const contextEl = cachedSection.createEl('div', { cls: 'ocr-debug-context' });
					contextEl.textContent = cachedResult.context.nearbyContent;
				}
			}
		}

		// Fresh result section
		const freshSection = resultsContainer.createDiv({ cls: 'ocr-debug-section' });
		freshSection.createEl('h4', { text: 'Fresh OCR Result:' });
		const freshResultEl = freshSection.createDiv({ cls: 'ocr-debug-text' });
		freshResultEl.textContent = 'Click "Run OCR" to get fresh result';
		
		// Container for fresh context (will be populated when OCR runs)
		const freshContextContainer = freshSection.createDiv({ cls: 'fresh-context-container' });

		// Debug info section
		const debugSection = resultsContainer.createDiv({ cls: 'ocr-debug-section' });
		debugSection.createEl('h4', { text: 'Debug Information:' });
		const debugInfo = debugSection.createEl('pre', { cls: 'ocr-debug-info' });

		// Run OCR button
		const buttonContainer = contentEl.createDiv({ cls: 'ocr-debug-buttons' });
		const runButton = buttonContainer.createEl('button', { text: 'Run OCR', cls: 'mod-cta' });
		
		runButton.onclick = async () => {
			if (this.isProcessing) return;

			this.isProcessing = true;
			runButton.textContent = 'Processing...';
			runButton.disabled = true;

			try {
				const absolutePath = (this.app.vault.adapter as any).getFullPath(this.file.path);
				debugInfo.textContent = `Running OCR on: ${absolutePath}\n\nProcessing...`;

				// Get fresh OCR result with debug info
				const result = await this.ocrService.performOCRWithDebug(absolutePath);
				
				// Update results
				freshResultEl.textContent = result.text || '(empty)';
				
				// Extract context information for fresh result
				const context = await this.ocrService.extractImageContext(this.file);
				
				// Update debug info
				let debugText = `File: ${absolutePath}\n`;
				debugText += `Timestamp: ${new Date().toLocaleString()}\n`;
				debugText += `Result length: ${result.text.length} characters\n`;
				debugText += `Context notes: ${context.referencingNotes.length}\n`;
				debugText += `Context content length: ${context.nearbyContent.length} characters\n`;
				if (result.error) {
					debugText += `Error: ${result.error}\n`;
				}
				if (result.stderr) {
					debugText += `stderr: ${result.stderr}\n`;
				}
				debugText += `Command executed successfully: ${!result.error}\n`;
				debugInfo.textContent = debugText;

				// Clear previous context and display new context information
				freshContextContainer.empty();
				if (context.referencingNotes.length > 0 || context.nearbyContent) {
					freshContextContainer.createEl('h5', { text: 'Fresh Context Information:' });
					
					// Referencing notes
					if (context.referencingNotes.length > 0) {
						freshContextContainer.createEl('h6', { text: 'Referenced in Notes:' });
						const notesEl = freshContextContainer.createEl('div', { cls: 'ocr-debug-context' });
						const notesList = context.referencingNotes.map(note => `• ${note.title}`).join('\n');
						notesEl.textContent = notesList;
					}

					// Nearby content
					if (context.nearbyContent) {
						freshContextContainer.createEl('h6', { text: 'Nearby Content:' });
						const contextEl = freshContextContainer.createEl('div', { cls: 'ocr-debug-context' });
						contextEl.textContent = context.nearbyContent;
					}
				} else {
					freshContextContainer.createEl('p', { 
						text: 'No context information found (image not referenced in any notes)',
						cls: 'ocr-debug-no-context'
					});
				}

			} catch (error) {
				freshResultEl.textContent = `Error: ${error}`;
				debugInfo.textContent = `Error occurred: ${error}`;
			} finally {
				this.isProcessing = false;
				runButton.textContent = 'Run OCR';
				runButton.disabled = false;
			}
		};

		// Add styles with unique ID and proper isolation
		const style = document.createElement('style');
		style.id = 'ocr-debug-modal-styles';
		style.textContent = `
			.modal.mod-ocr-debug {
				width: 80vw;
				max-width: 900px;
				height: 80vh;
			}
			.modal.mod-ocr-debug .modal-content {
				height: 100%;
				display: flex;
				flex-direction: column;
			}
			.modal.mod-ocr-debug .ocr-debug-image-info {
				margin-bottom: 15px;
			}
			.modal.mod-ocr-debug .ocr-debug-image-container {
				text-align: center;
				margin-bottom: 20px;
			}
			.modal.mod-ocr-debug .ocr-debug-image {
				max-width: 100%;
				max-height: 200px;
				border: 1px solid var(--background-modifier-border);
				border-radius: 8px;
			}
			.modal.mod-ocr-debug .ocr-debug-results {
				flex: 1;
				overflow-y: auto;
			}
			.modal.mod-ocr-debug .ocr-debug-section {
				margin-bottom: 20px;
				padding: 15px;
				background: var(--background-secondary);
				border-radius: 8px;
			}
			.modal.mod-ocr-debug .ocr-debug-section h4 {
				margin: 0 0 10px 0;
				color: var(--text-accent);
			}
			.modal.mod-ocr-debug .ocr-debug-text {
				background: var(--background-primary);
				padding: 10px;
				border-radius: 4px;
				border: 1px solid var(--background-modifier-border);
				font-family: var(--font-monospace);
				white-space: pre-wrap;
				word-wrap: break-word;
				min-height: 60px;
			}
			.modal.mod-ocr-debug .ocr-debug-info {
				background: var(--background-primary);
				padding: 10px;
				border-radius: 4px;
				border: 1px solid var(--background-modifier-border);
				margin: 0;
				font-size: 12px;
			}
			.modal.mod-ocr-debug .ocr-debug-timestamp {
				font-size: 12px;
				color: var(--text-muted);
				margin: 5px 0;
			}
			.modal.mod-ocr-debug .ocr-debug-context {
				background: var(--background-primary);
				padding: 8px;
				border-radius: 4px;
				border: 1px solid var(--background-modifier-border);
				font-family: var(--font-monospace);
				font-size: 11px;
				white-space: pre-wrap;
				word-wrap: break-word;
				margin: 5px 0;
				max-height: 100px;
				overflow-y: auto;
			}
			.modal.mod-ocr-debug .ocr-debug-section h5 {
				margin: 15px 0 5px 0;
				font-size: 13px;
				font-weight: 600;
				color: var(--text-normal);
			}
			.modal.mod-ocr-debug .ocr-debug-section h6 {
				margin: 10px 0 3px 0;
				font-size: 11px;
				font-weight: 500;
				color: var(--text-muted);
			}
			.modal.mod-ocr-debug .fresh-context-container {
				margin-top: 15px;
			}
			.modal.mod-ocr-debug .ocr-debug-no-context {
				color: var(--text-muted);
				font-style: italic;
				font-size: 12px;
				margin: 10px 0;
			}
			.modal.mod-ocr-debug .ocr-debug-buttons {
				text-align: center;
				margin-top: 15px;
			}
		`;
		// Append style to modal element instead of document.head to limit scope
		// This helps prevent conflicts with other plugins
		this.modalEl.appendChild(style);
	}

	onClose() {
		// Styles are now in modal element, so they get cleaned up automatically
	}
}

class ImageGallerySettingTab extends PluginSettingTab {
	plugin: ImageGalleryPlugin;

	constructor(app: App, plugin: ImageGalleryPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		containerEl.createEl('h2', { text: 'Image Gallery Settings' });

		new Setting(containerEl)
			.setName('Enable OCR Debug')
			.setDesc('Enable debugging features for OCR functionality. This adds a command to test OCR on individual images.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableOCRDebug)
				.onChange(async (value) => {
					this.plugin.settings.enableOCRDebug = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('OCR Concurrency')
			.setDesc('Number of images to process simultaneously during OCR indexing. Higher values are faster but use more system resources.')
			.addSlider(slider => slider
				.setLimits(1, 8, 1)
				.setValue(this.plugin.settings.ocrConcurrency)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.ocrConcurrency = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Context Lines')
			.setDesc('Number of text lines to include as context around each image (before and after). More lines provide richer context but increase index size.')
			.addSlider(slider => slider
				.setLimits(1, 8, 1)
				.setValue(this.plugin.settings.contextParagraphs)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.contextParagraphs = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Default Gallery Card Size')
			.setDesc('Default size for image cards in the gallery view (in pixels). You can also adjust this with the slider in the gallery window.')
			.addSlider(slider => slider
				.setLimits(100, 400, 20)
				.setValue(this.plugin.settings.galleryCardSize)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.galleryCardSize = value;
					await this.plugin.saveSettings();
				}));

		// Search+ Settings Section
		containerEl.createEl('h3', { text: 'Search+ Settings' });

		new Setting(containerEl)
			.setName('Exclude Folders from Search')
			.setDesc('List of folder paths to exclude from Search+ results. Enter one folder path per line (e.g., "Templates" or "Archive/Old Notes").')
			.addTextArea(text => {
				text.setPlaceholder('Templates\nArchive\nPrivate')
					.setValue(this.plugin.settings.searchExcludeFolders.join('\n'))
					.onChange(async (value) => {
						// Split by lines and filter empty lines
						this.plugin.settings.searchExcludeFolders = value
							.split('\n')
							.map(line => line.trim())
							.filter(line => line.length > 0);
						await this.plugin.saveSettings();
					});
				text.inputEl.rows = 4;
				text.inputEl.cols = 50;
			});

		new Setting(containerEl)
			.setName('Minimal Mode')
			.setDesc('Enable minimal mode for Search+ to show only search results without extra UI elements.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.searchMinimalMode)
				.onChange(async (value) => {
					this.plugin.settings.searchMinimalMode = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Result Font Size')
			.setDesc('Base font size for Search+ results (in pixels). Adjust to improve readability of the result preview text.')
			.addSlider(slider => slider
				.setLimits(10, 24, 1)
				.setValue(this.plugin.settings.searchResultFontSize)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.searchResultFontSize = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Include Image Results')
			.setDesc('Enable image search in Search+ to show images containing text that matches your query.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.searchIncludeImages)
				.onChange(async (value) => {
					this.plugin.settings.searchIncludeImages = value;
					await this.plugin.saveSettings();
				}));

		// OCR Index Management Section
		containerEl.createEl('h3', { text: 'OCR Index Management' });

		const indexStats = this.plugin.ocrService.getIndexStats();
		const statsEl = containerEl.createEl('p', { 
			text: `Current index contains ${indexStats.total} images (${(indexStats.size / 1024).toFixed(1)}KB)`,
			cls: 'setting-item-description'
		});

		new Setting(containerEl)
			.setName('Clear and Rebuild OCR Index')
			.setDesc('Clear the existing OCR index and rebuild it from scratch. This will re-process all images and may take several minutes.')
			.addButton(button => button
				.setButtonText('Clear & Rebuild')
				.setClass('mod-warning')
				.onClick(async () => {
					// Confirm action
					const confirmed = await this.showConfirmDialog(
						'Clear and Rebuild OCR Index',
						'This will delete the existing OCR index and rebuild it from scratch. All cached OCR results will be lost and images will be re-processed. This may take several minutes.\n\nAre you sure you want to continue?'
					);

					if (!confirmed) return;

					button.setDisabled(true);
					button.setButtonText('Processing...');

					try {
						// Clear existing index
						await this.plugin.ocrService.clearIndex();

						// Get all images
						const images = await this.plugin.getAllImages();

						// Show progress notice
						const startTime = Date.now();
						const notice = new Notice('Rebuilding OCR index...', 0);

						// Rebuild index
						await this.plugin.ocrService.indexAllImages(images, (current, total) => {
							const elapsed = Math.round((Date.now() - startTime) / 1000);
							const remaining = total - current;
							const rate = current / elapsed || 0;
							const eta = remaining > 0 && rate > 0 ? Math.round(remaining / rate) : 0;
							
							notice.setMessage(`Rebuilding OCR index: ${current}/${total} (${elapsed}s elapsed, ${eta}s remaining)`);
						}, this.plugin.settings.ocrConcurrency);

						const totalTime = Math.round((Date.now() - startTime) / 1000);
						notice.setMessage(`OCR index rebuilt successfully! (${totalTime}s total)`);
						setTimeout(() => notice.hide(), 3000);

						// Update stats display
						const newStats = this.plugin.ocrService.getIndexStats();
						statsEl.textContent = `Current index contains ${newStats.total} images (${(newStats.size / 1024).toFixed(1)}KB)`;

						new Notice('OCR index has been completely rebuilt!');

					} catch (error) {
						console.error('Failed to rebuild OCR index:', error);
						new Notice('Failed to rebuild OCR index. Check console for details.', 5000);
					} finally {
						button.setDisabled(false);
						button.setButtonText('Clear & Rebuild');
					}
				}));

		new Setting(containerEl)
			.setName('Clear OCR Index Only')
			.setDesc('Only clear the OCR index without rebuilding. Use this to free up space or reset the index.')
			.addButton(button => button
				.setButtonText('Clear Index')
				.setClass('mod-warning')
				.onClick(async () => {
					const confirmed = await this.showConfirmDialog(
						'Clear OCR Index',
						'This will permanently delete all cached OCR results. You can rebuild the index later if needed.\n\nAre you sure you want to continue?'
					);

					if (!confirmed) return;

					try {
						await this.plugin.ocrService.clearIndex();
						
						// Update stats display
						const newStats = this.plugin.ocrService.getIndexStats();
						statsEl.textContent = `Current index contains ${newStats.total} images (${(newStats.size / 1024).toFixed(1)}KB)`;

						new Notice('OCR index cleared successfully!');
					} catch (error) {
						console.error('Failed to clear OCR index:', error);
						new Notice('Failed to clear OCR index. Check console for details.', 5000);
					}
				}));
	}

	async showConfirmDialog(title: string, message: string): Promise<boolean> {
		return new Promise((resolve) => {
			const modal = new ConfirmModal(this.app, title, message, resolve);
			modal.open();
		});
	}
}

class ConfirmModal extends Modal {
	private title: string;
	private message: string;
	private resolve: (value: boolean) => void;

	constructor(app: App, title: string, message: string, resolve: (value: boolean) => void) {
		super(app);
		this.title = title;
		this.message = message;
		this.resolve = resolve;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		this.modalEl.addClass('mod-confirm');

		// Title
		contentEl.createEl('h2', { text: this.title });

		// Message
		const messageEl = contentEl.createDiv({ cls: 'confirm-message' });
		this.message.split('\n').forEach(line => {
			messageEl.createEl('p', { text: line });
		});

		// Buttons
		const buttonContainer = contentEl.createDiv({ cls: 'confirm-buttons' });
		
		const cancelBtn = buttonContainer.createEl('button', {
			text: 'Cancel',
			cls: 'mod-cancel'
		});
		cancelBtn.onclick = () => {
			this.resolve(false);
			this.close();
		};

		const confirmBtn = buttonContainer.createEl('button', {
			text: 'Continue',
			cls: 'mod-cta mod-warning'
		});
		confirmBtn.onclick = () => {
			this.resolve(true);
			this.close();
		};

		// Add styles with unique ID and proper isolation
		const style = document.createElement('style');
		style.id = 'confirm-modal-styles';
		style.textContent = `
			.modal.mod-confirm {
				width: 400px;
				max-width: 90vw;
			}
			.modal.mod-confirm .confirm-message {
				margin: 20px 0;
			}
			.modal.mod-confirm .confirm-message p {
				margin: 10px 0;
				color: var(--text-normal);
			}
			.modal.mod-confirm .confirm-buttons {
				display: flex;
				gap: 10px;
				justify-content: flex-end;
				margin-top: 20px;
			}
			.modal.mod-confirm .confirm-buttons button {
				padding: 8px 16px;
				border: none;
				border-radius: 4px;
				cursor: pointer;
			}
			.modal.mod-confirm .confirm-buttons .mod-cancel {
				background: var(--interactive-normal);
				color: var(--text-normal);
			}
			.modal.mod-confirm .confirm-buttons .mod-cancel:hover {
				background: var(--interactive-hover);
			}
			.modal.mod-confirm .confirm-buttons .mod-cta.mod-warning {
				background: var(--color-red);
				color: white;
			}
			.modal.mod-confirm .confirm-buttons .mod-cta.mod-warning:hover {
				background: var(--color-red);
				opacity: 0.8;
			}
		`;
		// Append style to modal element instead of document.head to limit scope
		// This helps prevent conflicts with other plugins
		this.modalEl.appendChild(style);

		// Focus the cancel button by default
		cancelBtn.focus();
		
		// Handle escape key
		this.modalEl.addEventListener('keydown', (e) => {
			if (e.key === 'Escape') {
				this.resolve(false);
				this.close();
			} else if (e.key === 'Enter') {
				this.resolve(true);
				this.close();
			}
		});
	}

	onClose() {
		// Styles are now in modal element, so they get cleaned up automatically
	}
}
