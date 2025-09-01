import { Modal, App, TFile, TextComponent, ButtonComponent, Notice, MarkdownView } from 'obsidian';
import { StyleManager } from '../styles/styleManager';
import { ImageGallerySettings } from '../types';
import { OCRService } from '../../ocr-service';

interface ImageInfo {
	path: string;
	file?: TFile;
	isLocal: boolean;
	displayName: string;
	createdTime?: number;
	modifiedTime?: number;
	ocrText?: string;
}

interface BlockSearchResult {
	file: TFile;
	blockContent: string;
	blockStartLine: number;
	blockEndLine: number;
	matchedTerms: string[];
	score: number;
	context: string;
	isTitle: boolean;
	isImage?: boolean;
	imagePreview?: string;
}

export class VaultSearchModal extends Modal {
	private searchInput: HTMLInputElement;
	private searchResultsContainer: HTMLElement;
	private searchMetadataEl: HTMLElement;
	private styleManager: StyleManager;
	private searchResults: BlockSearchResult[] = [];
	private searchTimeout?: NodeJS.Timeout;
	private currentSearchTerms: string[] = [];
	private selectedResultIndex: number = -1;
	private hoveredResultIndex: number = -1;
	private static lastSearchQuery: string = '';
	private settings: ImageGallerySettings;
	private ocrService: OCRService;
	
	constructor(app: App, private plugin: any) {
		super(app);
		this.styleManager = new StyleManager();
		this.ocrService = plugin.ocrService;
		this.settings = plugin.settings;
	}

	/**
	 * Check if a file should be excluded from search
	 */
	private isFileExcluded(file: TFile): boolean {
		if (!this.settings?.searchExcludeFolders || this.settings.searchExcludeFolders.length === 0) {
			return false;
		}

		const filePath = file.path;
		return this.settings.searchExcludeFolders.some(excludePath => {
			// Check if file path starts with excluded folder path
			return filePath.startsWith(excludePath + '/') || filePath === excludePath;
		});
	}

	/**
	 * Parse search query into individual terms
	 * Supports: "quoted phrases", word1 word2 (all must match)
	 */
	private parseSearchQuery(query: string): string[] {
		const terms: string[] = [];
		const quotedPhrases = query.match(/"[^"]+"/g) || [];
		
		// Extract quoted phrases
		quotedPhrases.forEach(phrase => {
			terms.push(phrase.replace(/"/g, '').toLowerCase());
			query = query.replace(phrase, '');
		});
		
		// Extract individual words
		const words = query.trim().split(/\s+/).filter(word => word.length > 0);
		words.forEach(word => {
			if (word.length > 0) {
				terms.push(word.toLowerCase());
			}
		});
		
		return terms;
	}

	/**
	 * Check if a line is a bullet point
	 */
	private isBulletPoint(line: string): boolean {
		const trimmed = line.trim();
		// Check for various bullet point formats
		return /^[-*+•]\s/.test(trimmed) || /^\d+\.\s/.test(trimmed) || /^[a-zA-Z]\.\s/.test(trimmed);
	}

	/**
	 * Check if a line is a title/heading
	 */
	private isTitle(line: string): boolean {
		const trimmed = line.trim();
		// Check for markdown headings (# ## ### etc.)
		return /^#{1,6}\s/.test(trimmed);
	}

	/**
	 * Split content into blocks (paragraphs, bullet points, and titles)
	 */
	private splitContentIntoBlocks(content: string): Array<{content: string; startLine: number; endLine: number; isTitle: boolean}> {
		const lines = content.split('\n');
		const blocks: Array<{content: string; startLine: number; endLine: number; isTitle: boolean}> = [];
		
		let currentBlock = '';
		let blockStartLine = 0;
		let currentLine = 0;
		
		for (const line of lines) {
			const trimmedLine = line.trim();
			
			// If this is a title, treat it as a high-priority single-line block
			if (this.isTitle(line)) {
				// Save any existing block first
				if (currentBlock.trim()) {
					blocks.push({
						content: currentBlock.trim(),
						startLine: blockStartLine + 1,
						endLine: currentLine,
						isTitle: false
					});
					currentBlock = '';
				}
				
				// Add title as its own block with high priority
				blocks.push({
					content: line,
					startLine: currentLine + 1,
					endLine: currentLine + 1,
					isTitle: true
				});
				
				blockStartLine = currentLine + 1;
			}
			// If this is a bullet point, treat it as a single-line block
			else if (this.isBulletPoint(line)) {
				// Save any existing block first
				if (currentBlock.trim()) {
					blocks.push({
						content: currentBlock.trim(),
						startLine: blockStartLine + 1,
						endLine: currentLine,
						isTitle: false
					});
					currentBlock = '';
				}
				
				// Add bullet point as its own block
				blocks.push({
					content: line,
					startLine: currentLine + 1,
					endLine: currentLine + 1,
					isTitle: false
				});
				
				blockStartLine = currentLine + 1;
			}
			// Check if this is an empty line (paragraph delimiter)
			else if (trimmedLine === '') {
				// If we have content in current block, save it
				if (currentBlock.trim()) {
					blocks.push({
						content: currentBlock.trim(),
						startLine: blockStartLine + 1, // 1-based line numbers
						endLine: currentLine,
						isTitle: false
					});
				}
				
				// Reset for next block
				currentBlock = '';
				blockStartLine = currentLine + 1;
			} else {
				// Add line to current block
				if (currentBlock) {
					currentBlock += '\n' + line;
				} else {
					currentBlock = line;
					blockStartLine = currentLine;
				}
			}
			
			currentLine++;
		}
		
		// Don't forget the last block if there's content
		if (currentBlock.trim()) {
			blocks.push({
				content: currentBlock.trim(),
				startLine: blockStartLine + 1, // 1-based line numbers
				endLine: currentLine,
				isTitle: false
			});
		}
		
		return blocks;
	}

	/**
	 * Check if a block contains all search terms
	 */
	private blockContainsAllTerms(blockContent: string, terms: string[]): {matches: boolean; matchedTerms: string[]} {
		const blockLower = blockContent.toLowerCase();
		const matchedTerms: string[] = [];
		
		for (const term of terms) {
			if (blockLower.includes(term)) {
				matchedTerms.push(term);
			}
		}
		
		return {
			matches: matchedTerms.length === terms.length,
			matchedTerms
		};
	}

	/**
	 * Calculate block relevance score with title priority
	 */
	private calculateBlockScore(blockContent: string, terms: string[], isTitle: boolean = false): number {
		const blockLower = blockContent.toLowerCase();
		let score = 0;
		
		// HUGE bonus for titles - highest priority
		if (isTitle) {
			score += 1000;
		}
		
		// Base score for each term occurrence
		for (const term of terms) {
			const termMatches = (blockLower.match(new RegExp(this.escapeRegex(term), 'g')) || []).length;
			score += termMatches * (isTitle ? 100 : 10); // Higher score for title matches
		}
		
		// Bonus for shorter blocks (more focused) - but not for titles
		if (!isTitle) {
			const blockLength = blockContent.length;
			if (blockLength < 200) {
				score += 20;
			} else if (blockLength < 500) {
				score += 10;
			}
		}
		
		// Bonus for terms appearing close together
		if (terms.length > 1) {
			for (let i = 0; i < terms.length - 1; i++) {
				for (let j = i + 1; j < terms.length; j++) {
					const term1Index = blockLower.indexOf(terms[i]);
					const term2Index = blockLower.indexOf(terms[j]);
					
					if (term1Index !== -1 && term2Index !== -1) {
						const distance = Math.abs(term2Index - term1Index);
						if (distance < 50) {
							score += isTitle ? 100 : 30; // Higher bonus for titles
						} else if (distance < 100) {
							score += isTitle ? 50 : 15;
						} else if (distance < 200) {
							score += isTitle ? 25 : 5;
						}
					}
				}
			}
		}
		
		return score;
	}

	/**
	 * Check if query is a special command (TODO/DONE)
	 */
	private isSpecialCommand(query: string): { isTodo: boolean; isDone: boolean; remainingQuery: string } {
		const trimmed = query.trim().toUpperCase();
		if (trimmed.startsWith('TODO')) {
			return { isTodo: true, isDone: false, remainingQuery: query.slice(4).trim() };
		}
		if (trimmed.startsWith('DONE')) {
			return { isTodo: false, isDone: true, remainingQuery: query.slice(4).trim() };
		}
		return { isTodo: false, isDone: false, remainingQuery: query };
	}

	/**
	 * Search for TODO/DONE blocks specifically
	 */
	private async searchTodoBlocks(isDone: boolean, additionalQuery: string): Promise<BlockSearchResult[]> {
		const results: BlockSearchResult[] = [];
		const files = this.app.vault.getMarkdownFiles().filter(file => !this.isFileExcluded(file));
		
		const pattern = isDone ? /^- \[x\]/i : /^- \[ \]/i;
		
		for (const file of files) {
			try {
				const content = await this.app.vault.read(file);
				const lines = content.split('\n');
				
				for (let i = 0; i < lines.length; i++) {
					const line = lines[i];
					const trimmedLine = line.trim();
					
					if (pattern.test(trimmedLine)) {
						// Check if additional query matches if provided
						if (additionalQuery && additionalQuery.length > 0) {
							const lineLower = line.toLowerCase();
							const queryLower = additionalQuery.toLowerCase();
							if (!lineLower.includes(queryLower)) {
								continue;
							}
						}
						
						// Calculate score based on line content
						let score = 100; // Base score for todo items
						if (additionalQuery) {
							const occurrences = (line.toLowerCase().match(new RegExp(this.escapeRegex(additionalQuery.toLowerCase()), 'g')) || []).length;
							score += occurrences * 50;
						}
						
						results.push({
							file,
							blockContent: line,
							blockStartLine: i + 1,
							blockEndLine: i + 1,
							matchedTerms: additionalQuery ? [additionalQuery.toLowerCase()] : [],
							score,
							context: line,
							isTitle: false
						});
					}
				}
			} catch (error) {
				console.error(`Error reading file ${file.path}:`, error);
			}
		}
		
		return results;
	}

	/**
	 * Search images by OCR content
	 */
	private async searchImages(query: string): Promise<BlockSearchResult[]> {
		console.log('🖼️ searchImages function called with query:', query);
		if (!query.trim() || query.trim().length < 2) {
			console.log('🖼️ searchImages: query too short, returning empty');
			return [];
		}

		const results: BlockSearchResult[] = [];
		
		try {
			// Get all images from the main plugin
			const allImages: ImageInfo[] = await this.plugin.getAllImages();
			
			// Filter to local images only
			const localImages = allImages.filter(img => img.isLocal && img.file);
			
			// Search OCR content for matching images
			const imagePaths = this.ocrService.searchImages(query);
			console.log('Image search for query:', query, 'Found paths:', imagePaths);
			
			for (const imagePath of imagePaths) {
				// Find the ImageInfo object for this path
				const imageInfo = localImages.find(img => img.path === imagePath);
				if (!imageInfo || !imageInfo.file) {
					continue;
				}

				// Check if this image file should be excluded
				if (this.isFileExcluded(imageInfo.file)) {
					continue;
				}

				// Get OCR result for context and text
				const ocrResult = this.ocrService.getCachedResult(imagePath);
				if (!ocrResult) {
					continue;
				}

				// Create image preview URL using the correct vault method
				const imagePreview = this.app.vault.getResourcePath(imageInfo.file);

				// Format OCR text by joining lines with spaces
				const formattedOcrText = this.formatOcrText(ocrResult.text);
				
				// Calculate score based on OCR content relevance
				const score = this.calculateImageScore(ocrResult.text, this.currentSearchTerms) + 500; // Bonus for images

				results.push({
					file: imageInfo.file,
					blockContent: formattedOcrText || 'No text detected',
					blockStartLine: 0,
					blockEndLine: 0,
					matchedTerms: this.currentSearchTerms,
					score,
					context: ocrResult.context?.nearbyContent || '',
					isTitle: false,
					isImage: true,
					imagePreview
				});
			}
		} catch (error) {
			console.error('Error searching images:', error);
		}

		return results;
	}

	/**
	 * Format OCR text by joining lines with spaces and cleaning up
	 */
	private formatOcrText(ocrText: string): string {
		if (!ocrText || ocrText.trim() === '') {
			return '';
		}
		
		// Split by newlines and filter out empty lines
		const lines = ocrText.split('\n')
			.map(line => line.trim())
			.filter(line => line.length > 0);
		
		// Join with spaces and clean up multiple spaces
		return lines.join(' ').replace(/\s+/g, ' ').trim();
	}

	/**
	 * Calculate relevance score for image OCR content
	 */
	private calculateImageScore(ocrText: string, terms: string[]): number {
		const textLower = ocrText.toLowerCase();
		let score = 0;
		
		for (const term of terms) {
			const termMatches = (textLower.match(new RegExp(this.escapeRegex(term), 'g')) || []).length;
			score += termMatches * 20; // Base score for OCR matches
		}
		
		// Bonus for shorter OCR text (more focused)
		const textLength = ocrText.length;
		if (textLength > 0 && textLength < 100) {
			score += 30;
		} else if (textLength < 300) {
			score += 15;
		}
		
		return score;
	}

	/**
	 * Search vault content at block level
	 */
	private async searchVaultContent(query: string) {
		console.log('=== Search+ searchVaultContent called with query:', query);
		const trimmedQuery = query.trim();
		
		if (!trimmedQuery) {
			this.searchResults = [];
			this.currentSearchTerms = [];
			this.renderSearchResults();
			return;
		}

		// Check for special commands first
		const specialCommand = this.isSpecialCommand(trimmedQuery);
		
		if (specialCommand.isTodo || specialCommand.isDone) {
			// Handle TODO/DONE search
			this.currentSearchTerms = specialCommand.remainingQuery ? [specialCommand.remainingQuery] : [];
			this.searchResults = await this.searchTodoBlocks(specialCommand.isDone, specialCommand.remainingQuery);
			this.searchResults.sort((a, b) => {
				const aModTime = a.file.stat.mtime;
				const bModTime = b.file.stat.mtime;
				
				// If files have different modification times, sort by time (most recent first)
				if (aModTime !== bModTime) {
					return bModTime - aModTime;
				}
				
				// If same file or same modification time, sort by relevance score
				return b.score - a.score;
			});
			this.selectedResultIndex = -1;
			this.renderSearchResults();
			return;
		}

		// Regular search - require at least 2 characters
		if (trimmedQuery.length < 2) {
			this.searchResults = [];
			this.currentSearchTerms = [];
			this.renderSearchResults();
			return;
		}

		// Parse search terms
		this.currentSearchTerms = this.parseSearchQuery(trimmedQuery);
		if (this.currentSearchTerms.length === 0) {
			this.searchResults = [];
			this.renderSearchResults();
			return;
		}

		const results: BlockSearchResult[] = [];
		
		// Get all markdown files and filter out excluded folders
		const files = this.app.vault.getMarkdownFiles().filter(file => !this.isFileExcluded(file));
		
		// Search images using OCR
		console.log('=== Calling searchImages with query:', trimmedQuery);
		const imageResults = await this.searchImages(trimmedQuery);
		console.log('=== searchImages returned', imageResults.length, 'results');
		results.push(...imageResults);
		
		for (const file of files) {
			try {
				// First check if file name matches search terms
				const fileNameLower = file.basename.toLowerCase();
				let fileNameMatches = true;
				for (const term of this.currentSearchTerms) {
					if (!fileNameLower.includes(term)) {
						fileNameMatches = false;
						break;
					}
				}
				
				// If file name matches, add as a special result
				if (fileNameMatches) {
					results.push({
						file,
						blockContent: `File: ${file.basename}`,
						blockStartLine: 0,
						blockEndLine: 0,
						matchedTerms: this.currentSearchTerms,
						score: 2000, // Very high score for file name matches
						context: file.path,
						isTitle: true
					});
				}
				
				// Then search content
				const content = await this.app.vault.read(file);
				
				// Split content into blocks
				const blocks = this.splitContentIntoBlocks(content);
				
				// Search each block
				for (const block of blocks) {
					const termCheck = this.blockContainsAllTerms(block.content, this.currentSearchTerms);
					
					if (termCheck.matches) {
						const score = this.calculateBlockScore(block.content, this.currentSearchTerms, block.isTitle);
						
						// Create context (show a bit more around the block if available)
						const allLines = content.split('\n');
						const contextStart = Math.max(0, block.startLine - 2);
						const contextEnd = Math.min(allLines.length, block.endLine + 1);
						const context = allLines.slice(contextStart, contextEnd).join('\n');
						
						results.push({
							file,
							blockContent: block.content,
							blockStartLine: block.startLine,
							blockEndLine: block.endLine,
							matchedTerms: termCheck.matchedTerms,
							score,
							context,
							isTitle: block.isTitle
						});
					}
				}
			} catch (error) {
				console.error(`Error reading file ${file.path}:`, error);
			}
		}
		
		// Sort results by file edit time first (most recent first), then by relevance score
		results.sort((a, b) => {
			const aModTime = a.file.stat.mtime;
			const bModTime = b.file.stat.mtime;
			
			// If files have different modification times, sort by time (most recent first)
			if (aModTime !== bModTime) {
				return bModTime - aModTime;
			}
			
			// If same file or same modification time, sort by relevance score
			return b.score - a.score;
		});
		
		// Limit total results to prevent overwhelming UI
		this.searchResults = results.slice(0, 50);
		this.selectedResultIndex = -1; // Reset selection
		this.hoveredResultIndex = -1; // Reset hover
		this.renderSearchResults();
	}

	/**
	 * Navigate through search results with keyboard
	 */
	private navigateResults(direction: 'up' | 'down') {
		if (this.searchResults.length === 0) return;
		
		// Clear hover state during keyboard navigation
		this.hoveredResultIndex = -1;
		
		if (direction === 'down') {
			this.selectedResultIndex = Math.min(this.selectedResultIndex + 1, this.searchResults.length - 1);
		} else {
			this.selectedResultIndex = Math.max(this.selectedResultIndex - 1, -1);
		}
		
		this.updateResultSelection();
	}

	/**
	 * Update visual selection of results
	 */
	private updateResultSelection() {
		const blockItems = this.searchResultsContainer.querySelectorAll('.search-block-item');
		
		blockItems.forEach((item, index) => {
			// Remove all classes first
			item.removeClass('selected');
			item.removeClass('hovered');
			
			// Add appropriate class - selected takes priority over hovered
			if (index === this.selectedResultIndex) {
				item.addClass('selected');
			} else if (index === this.hoveredResultIndex && index !== this.selectedResultIndex) {
				item.addClass('hovered');
			}
		});
		
		// Scroll selected item into view (no animation for efficiency)
		if (this.selectedResultIndex >= 0) {
			const selectedItem = blockItems[this.selectedResultIndex] as HTMLElement;
			if (selectedItem) {
				selectedItem.scrollIntoView({ block: 'nearest' });
			}
		}
	}

	/**
	 * Open selected result and navigate to specific block
	 */
	private async openSelectedResult() {
		if (this.selectedResultIndex >= 0 && this.selectedResultIndex < this.searchResults.length) {
			const result = this.searchResults[this.selectedResultIndex];
			
			// Handle image results differently
			if (result.isImage) {
				// Open image file directly or in image gallery
				const leaf = this.app.workspace.getLeaf('tab');
				await leaf.openFile(result.file);
				this.close();
				return;
			}
			
			// Open file in new tab and navigate to line
			const leaf = this.app.workspace.getLeaf('tab');
			await leaf.openFile(result.file);
			
			// Navigate to the specific line if available
			if (result.blockStartLine > 0) {
				const view = leaf.view as MarkdownView;
				if (view && view.editor) {
					// Navigate to the line
					const lineNumber = Math.max(0, result.blockStartLine - 1); // Convert to 0-based
					view.editor.setCursor({ line: lineNumber, ch: 0 });
					view.editor.scrollIntoView({ from: { line: lineNumber, ch: 0 }, to: { line: lineNumber, ch: 0 } }, true);
					
					// Highlight the search terms in the editor
					this.highlightSearchTermsInEditor(view.editor, this.currentSearchTerms);
				}
			}
			
			this.close();
		}
	}

	/**
	 * Highlight search terms in the editor
	 */
	private highlightSearchTermsInEditor(editor: any, terms: string[]) {
		// Clear existing highlights
		editor.removeHighlight();
		
		if (!terms || terms.length === 0) return;
		
		// Highlight each term
		for (const term of terms) {
			if (term.length < 2) continue;
			
			const content = editor.getValue();
			const regex = new RegExp(this.escapeRegex(term), 'gi');
			let match;
			
			while ((match = regex.exec(content)) !== null) {
				const from = editor.offsetToPos(match.index);
				const to = editor.offsetToPos(match.index + match[0].length);
				
				// Add highlight
				editor.addHighlight(from, to, 'search-highlight');
			}
		}
		
		// Remove highlights after 3 seconds
		setTimeout(() => {
			if (editor) {
				editor.removeHighlight('search-highlight');
			}
		}, 3000);
	}

	/**
	 * Highlight search terms in text
	 */
	private highlightTerms(text: string): string {
		let highlighted = text;
		
		// Sort terms by length (longest first) to avoid partial replacements
		const sortedTerms = [...this.currentSearchTerms].sort((a, b) => b.length - a.length);
		
		for (const term of sortedTerms) {
			const regex = new RegExp(`(${this.escapeRegex(term)})`, 'gi');
			highlighted = highlighted.replace(regex, '<mark>$1</mark>');
		}
		
		return highlighted;
	}

	/**
	 * Escape special regex characters
	 */
	private escapeRegex(str: string): string {
		return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	}

	/**
	 * Format relative time
	 */
	private formatRelativeTime(timestamp: number): string {
		const now = Date.now();
		const diff = now - timestamp;
		const seconds = Math.floor(diff / 1000);
		const minutes = Math.floor(seconds / 60);
		const hours = Math.floor(minutes / 60);
		const days = Math.floor(hours / 24);
		const weeks = Math.floor(days / 7);
		const months = Math.floor(days / 30);
		
		if (seconds < 60) return 'just now';
		if (minutes < 60) return minutes === 1 ? '1 min ago' : `${minutes} mins ago`;
		if (hours < 24) return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
		if (days < 7) return days === 1 ? 'yesterday' : `${days} days ago`;
		if (weeks < 4) return weeks === 1 ? '1 week ago' : `${weeks} weeks ago`;
		if (months < 12) return months === 1 ? '1 month ago' : `${months} months ago`;
		return 'long ago';
	}

	/**
	 * Update search metadata display
	 */
	private updateSearchMetadata() {
		if (!this.searchMetadataEl) return;
		
		this.searchMetadataEl.empty();
		
		if (this.searchResults.length > 0) {
			// Count unique files and image results
			const uniqueFiles = new Set(this.searchResults.map(r => r.file.path)).size;
			const imageResults = this.searchResults.filter(r => r.isImage).length;
			const blockResults = this.searchResults.length - imageResults;
			
			// Get search type
			const currentQuery = this.searchInput?.value || '';
			const specialCommand = this.isSpecialCommand(currentQuery);
			
			let metadataText = '';
			if (specialCommand.isTodo || specialCommand.isDone) {
				const taskType = specialCommand.isTodo ? 'TODO' : 'DONE';
				metadataText = `${this.searchResults.length} ${taskType} items in ${uniqueFiles} files`;
			} else {
				const parts = [];
				if (blockResults > 0) parts.push(`${blockResults} blocks`);
				if (imageResults > 0) parts.push(`${imageResults} images`);
				metadataText = `${parts.join(', ')} in ${uniqueFiles} files`;
			}
			
			if (this.currentSearchTerms.length > 0) {
				metadataText += ' • Terms: ' + this.currentSearchTerms.join(', ');
			}
			
			this.searchMetadataEl.createEl('span', {
				text: metadataText,
				cls: 'search-metadata-text'
			});
		}
	}

	/**
	 * Render search results
	 */
	private renderSearchResults() {
		if (!this.searchResultsContainer) return;
		
		this.searchResultsContainer.empty();
		
		// Update metadata display
		this.updateSearchMetadata();
		
		if (this.searchResults.length === 0) {
			const currentQuery = this.searchInput?.value || '';
			const specialCommand = this.isSpecialCommand(currentQuery);
			
			if (currentQuery.trim()) {
				if (currentQuery.trim().length < 2 && !specialCommand.isTodo && !specialCommand.isDone) {
					this.searchResultsContainer.createEl('p', {
						text: 'Type at least 2 characters',
						cls: 'search-empty-state'
					});
				} else {
					this.searchResultsContainer.createEl('p', {
						text: 'No results',
						cls: 'search-empty-state'
					});
				}
			} else {
				this.searchResultsContainer.createEl('p', {
					text: 'Start typing to search',
					cls: 'search-empty-state'
				});
			}
			return;
		}
		
		// Group results by file
		const resultsByFile = new Map<string, BlockSearchResult[]>();
		for (const result of this.searchResults) {
			const filePath = result.file.path;
			if (!resultsByFile.has(filePath)) {
				resultsByFile.set(filePath, []);
			}
			resultsByFile.get(filePath)!.push(result);
		}
		
		// Create results list
		const resultsList = this.searchResultsContainer.createEl('div', {
			cls: 'search-results-list'
		});
		
		// Display grouped results
		let displayIndex = 0; // Index for UI display elements
		for (const [filePath, fileResults] of resultsByFile) {
			const fileGroup = resultsList.createEl('div', {
				cls: 'search-file-group'
			});
			
			// Check if any result is a file name match
			const hasFileNameMatch = fileResults.some(r => r.blockContent.startsWith('File: '));
			
			// Check if this file group contains image results
			const hasImageResults = fileResults.some(r => r.isImage);
			
			// File header (only once per file)
			let headerClass = 'search-file-header';
			if (hasFileNameMatch) headerClass += ' file-name-match';
			if (hasImageResults) headerClass += ' image-file';
			
			const fileHeader = fileGroup.createEl('div', {
				cls: headerClass
			});
			
			const fileName = fileHeader.createEl('span', {
				text: fileResults[0].file.basename,
				cls: 'search-file-name'
			});
			
			if (hasFileNameMatch) {
				fileName.innerHTML = this.highlightTerms(fileResults[0].file.basename);
			}
			
			fileHeader.createEl('span', {
				text: '·',
				cls: 'search-file-separator'
			});
			
			fileHeader.createEl('span', {
				text: this.formatRelativeTime(fileResults[0].file.stat.mtime),
				cls: 'search-file-time'
			});
			
			fileHeader.createEl('span', {
				text: `(${fileResults.length} ${fileResults.length === 1 ? 'match' : 'matches'})`,
				cls: 'search-file-count'
			});
			
			// Click file header to open file
			fileHeader.addEventListener('click', async () => {
				// Open file in new tab
				const leaf = this.app.workspace.getLeaf('tab');
				await leaf.openFile(fileResults[0].file);
				
				// If there are search terms, highlight them in the editor
				if (this.currentSearchTerms.length > 0) {
					const view = leaf.view as MarkdownView;
					if (view && view.editor) {
						this.highlightSearchTermsInEditor(view.editor, this.currentSearchTerms);
					}
				}
				
				this.close();
			});
			
			// Display blocks for this file
			const blocksContainer = fileGroup.createEl('div', {
				cls: 'search-blocks-container'
			});
			
			for (let i = 0; i < fileResults.length; i++) {
				const result = fileResults[i];
				
				// Skip file name matches in block display (they're shown in header)
				if (result.blockContent.startsWith('File: ')) {
					continue;
				}
				
				const blockItem = blocksContainer.createEl('div', {
					cls: 'search-block-item'
				});
				
				// Find the actual index in searchResults array
				const actualResultIndex = this.searchResults.findIndex(r => 
					r.file.path === result.file.path && 
					r.blockContent === result.blockContent &&
					r.blockStartLine === result.blockStartLine
				);
				
				const currentDisplayIndex = displayIndex++;
				
				// Add click handler to open file
				blockItem.addEventListener('click', async () => {
					// Use the actual result index from searchResults array
					this.selectedResultIndex = actualResultIndex;
					await this.openSelectedResult();
				});
				
				// Add hover effect
				blockItem.addEventListener('mouseenter', () => {
					this.hoveredResultIndex = currentDisplayIndex;
					this.updateResultSelection();
				});
				
				// Clear hover when mouse leaves
				blockItem.addEventListener('mouseleave', () => {
					this.hoveredResultIndex = -1;
					this.updateResultSelection();
				});
				
				// Block content
				const blockContentEl = blockItem.createEl('div', {
					cls: result.isImage ? 'search-block-content search-image-content' : 'search-block-content'
				});
				
				// Add image preview if this is an image result
				if (result.isImage && result.imagePreview) {
					console.log('Rendering image result:', result.file.path, 'Preview URL:', result.imagePreview);
					
					const imagePreviewEl = blockContentEl.createEl('div', {
						cls: 'search-image-preview'
					});
					
					const imageEl = imagePreviewEl.createEl('img', {
						cls: 'search-image-thumbnail'
					});
					imageEl.src = result.imagePreview;
					imageEl.alt = result.file.name;
					
					// Add error handling for image loading
					imageEl.addEventListener('error', () => {
						console.error('Failed to load image:', result.imagePreview);
						imageEl.style.display = 'none';
					});
					
					imageEl.addEventListener('load', () => {
						console.log('Image loaded successfully:', result.imagePreview);
					});
					
					// Content area next to image
					const contentAreaEl = blockContentEl.createEl('div', {
						cls: 'search-image-content-area'
					});
					
					// OCR text with label
					if (result.blockContent && result.blockContent !== 'No text detected') {
						const ocrSection = contentAreaEl.createEl('div', {
							cls: 'search-image-ocr-section'
						});
						
						const ocrLabel = ocrSection.createEl('div', {
							cls: 'search-image-ocr-label',
							text: 'Image text:'
						});
						
						const ocrText = ocrSection.createEl('div', {
							cls: 'search-image-ocr-text'
						});
						ocrText.innerHTML = this.highlightTerms(result.blockContent);
					} else {
						const noTextEl = contentAreaEl.createEl('div', {
							cls: 'search-image-no-text',
							text: 'No text detected in image'
						});
					}
					
					// Context section removed for cleaner interface
					
					// File info
					const fileInfo = contentAreaEl.createEl('div', {
						cls: 'search-image-file-info',
						text: `📷 ${result.file.name}`
					});
					
				} else {
					blockContentEl.innerHTML = this.highlightTerms(result.blockContent);
				}
			}
		}
		
		// Update selection after rendering
		this.updateResultSelection();
	}

	async onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		
		// Add custom class to modal for styling
		this.modalEl.addClass('mod-vault-search');
		this.modalEl.setAttribute('data-vault-search-modal', 'true');
		
		// Add minimal mode class if enabled
		if (this.settings?.searchMinimalMode) {
			this.modalEl.addClass('mod-minimal');
		}
		
		// Hide the close button
		const closeButton = this.modalEl.querySelector('.modal-close-button');
		if (closeButton) {
			(closeButton as HTMLElement).style.display = 'none';
		}
		
		// Add title (hidden in minimal mode)
		if (!this.settings?.searchMinimalMode) {
			contentEl.createEl('h2', { text: '🔍 Search+ - Vault Content Search' });
		}
		
		// Search header
		const searchHeader = contentEl.createDiv({ cls: 'search-header' });
		
		// Custom search input container - completely independent
		const searchInputContainer = searchHeader.createDiv({ cls: 'custom-search-container' });
		
		this.searchInput = document.createElement('input');
		this.searchInput.type = 'text';
		this.searchInput.placeholder = 'Search blocks and images... (min 2 chars, or type TODO/DONE)';
		this.searchInput.className = 'custom-search-input';
		searchInputContainer.appendChild(this.searchInput);
		
		// Restore last search query
		if (VaultSearchModal.lastSearchQuery) {
			this.searchInput.value = VaultSearchModal.lastSearchQuery;
		}
		
		// Auto-focus search input and select text if there's a previous search
		this.searchInput.focus();
		if (VaultSearchModal.lastSearchQuery) {
			this.searchInput.select();
		}
		
		// Search on input with debounce
		this.searchInput.addEventListener('input', async (e) => {
			const value = (e.target as HTMLInputElement).value;
			// Save search query
			VaultSearchModal.lastSearchQuery = value;
			
			if (this.searchTimeout) {
				clearTimeout(this.searchTimeout);
			}
			
			this.searchTimeout = setTimeout(async () => {
				await this.searchVaultContent(value);
			}, 300);
		});
		
		// Keyboard navigation
		this.searchInput.addEventListener('keydown', async (e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				if (this.selectedResultIndex >= 0) {
					// Open selected result
					this.openSelectedResult();
				} else {
					// Search immediately
					await this.searchVaultContent(this.searchInput.value);
				}
			}
			// Navigation shortcuts
			else if ((e.ctrlKey || e.metaKey) && e.key === 'p') {
				e.preventDefault();
				this.navigateResults('up');
			}
			else if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
				e.preventDefault();
				this.navigateResults('down');
			}
			else if ((e.ctrlKey || e.metaKey) && e.key === 'j') {
				e.preventDefault();
				this.navigateResults('down');
			}
			else if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
				e.preventDefault();
				this.navigateResults('up');
			}
			else if (e.key === 'ArrowDown') {
				e.preventDefault();
				this.navigateResults('down');
			}
			else if (e.key === 'ArrowUp') {
				e.preventDefault();
				this.navigateResults('up');
			}
		});
		
		// Search metadata display
		this.searchMetadataEl = searchHeader.createEl('div', {
			cls: 'search-metadata'
		});
		
		// Help text (hidden in minimal mode)
		if (!this.settings?.searchMinimalMode) {
			const helpText = searchHeader.createEl('div', {
				text: 'Search blocks and images (2+ chars): Use spaces for multiple words, "quotes" for exact phrases. Type TODO/DONE for task items.',
				cls: 'search-help-text'
			});
		}
		
		// Results container
		this.searchResultsContainer = contentEl.createDiv({ cls: 'search-results-container' });
		
		// Always show placeholder initially to avoid UI flashing
		this.renderSearchResults();
		
		// If there was a previous query, trigger search after UI is stable
		if (VaultSearchModal.lastSearchQuery) {
			// Use setTimeout to avoid UI flashing during modal opening
			setTimeout(async () => {
				await this.searchVaultContent(VaultSearchModal.lastSearchQuery);
			}, 100);
		}
		
		// Add styles
		this.addModalStyles();
	}

	private addModalStyles() {
		const styles = `
			[data-vault-search-modal="true"].modal.mod-vault-search {
				width: 80vw !important;
				max-width: 1000px !important;
				height: 80vh !important;
				max-height: 80vh !important;
			}
			
			/* Minimal mode styles */
			[data-vault-search-modal="true"].modal.mod-vault-search.mod-minimal {
				width: 70vw !important;
				max-width: 800px !important;
				height: 70vh !important;
			}
			
			[data-vault-search-modal="true"].mod-minimal .modal-content {
				padding: 12px !important;
			}
			
			/* Hide elements in minimal mode */
			[data-vault-search-modal="true"].mod-minimal .search-help-text,
			[data-vault-search-modal="true"].mod-minimal .search-results-header,
			[data-vault-search-modal="true"].mod-minimal .search-result-file-path,
			[data-vault-search-modal="true"].mod-minimal .search-result-stats {
				display: none !important;
			}
			
			/* Simplified search input in minimal mode */
			[data-vault-search-modal="true"].mod-minimal .search-header {
				margin-bottom: 12px !important;
			}
			
			[data-vault-search-modal="true"].mod-minimal .search-result-item {
				padding: 8px !important;
				margin-bottom: 4px !important;
			}
			
			[data-vault-search-modal="true"] .modal-content {
				height: 100% !important;
				display: flex !important;
				flex-direction: column !important;
				padding: 20px !important;
			}
			
			[data-vault-search-modal="true"] h2 {
				margin-bottom: 20px !important;
				color: var(--text-normal) !important;
			}
			
			/* Search header */
			[data-vault-search-modal="true"] .search-header {
				margin-bottom: 20px !important;
			}
			
			/* Custom search input - completely independent */
			[data-vault-search-modal="true"] .custom-search-container {
				margin-bottom: 10px !important;
				position: relative !important;
				width: 100% !important;
			}
			
			[data-vault-search-modal="true"] .custom-search-input {
				width: 100% !important;
				padding: 12px 16px !important;
				background: var(--background-secondary) !important;
				border: 2px solid var(--background-modifier-border) !important;
				border-radius: 6px !important;
				font-size: 14px !important;
				color: var(--text-normal) !important;
				font-family: var(--font-interface) !important;
				box-sizing: border-box !important;
				transition: border-color 0.15s ease !important;
				/* Reset any inherited styles */
				background-image: none !important;
				background-repeat: no-repeat !important;
				background-position: left center !important;
				appearance: none !important;
				-webkit-appearance: none !important;
				-moz-appearance: none !important;
			}
			
			[data-vault-search-modal="true"] .custom-search-input:focus {
				border-color: var(--interactive-accent) !important;
				box-shadow: 0 0 0 2px var(--interactive-accent-alpha) !important;
				outline: none !important;
				background-image: none !important;
			}
			
			[data-vault-search-modal="true"] .custom-search-input::placeholder {
				color: var(--text-muted) !important;
				opacity: 1 !important;
			}
			
			/* Search metadata display */
			[data-vault-search-modal="true"] .search-metadata {
				margin: 8px 0 !important;
				padding: 6px 12px !important;
				background: var(--background-secondary) !important;
				border-radius: 4px !important;
				min-height: 24px !important;
			}
			
			[data-vault-search-modal="true"] .search-metadata:empty {
				display: none !important;
			}
			
			[data-vault-search-modal="true"] .search-metadata-text {
				font-size: 12px !important;
				color: var(--text-muted) !important;
				font-weight: 500 !important;
			}
			
			[data-vault-search-modal="true"] .search-help-text {
				font-size: 12px !important;
				color: var(--text-muted) !important;
				font-style: italic !important;
			}
			
			
			/* Results container */
			[data-vault-search-modal="true"] .search-results-container {
				flex: 1 !important;
				overflow-y: auto !important;
				border: 1px solid var(--background-modifier-border) !important;
				border-radius: 8px !important;
				padding: 16px !important;
				background: var(--background-primary) !important;
			}
			
			[data-vault-search-modal="true"] .search-placeholder,
			[data-vault-search-modal="true"] .search-no-results {
				text-align: center !important;
				color: var(--text-muted) !important;
				padding: 60px 20px !important;
				font-size: 14px !important;
				line-height: 1.6 !important;
			}
			
			
			/* Minimalist results list */
			[data-vault-search-modal="true"] .search-results-list {
				display: flex !important;
				flex-direction: column !important;
				gap: 24px !important;
			}
			
			/* File group - no decoration */
			[data-vault-search-modal="true"] .search-file-group {
				/* Intentionally empty - no styling needed */
			}
			
			/* File header - minimal, text only */
			[data-vault-search-modal="true"] .search-file-header {
				display: flex !important;
				align-items: baseline !important;
				gap: 8px !important;
				margin-bottom: 8px !important;
				cursor: pointer !important;
				padding: 6px 8px !important;
				margin: 0 -8px 8px -8px !important;
				border-radius: 4px !important;
				transition: background 0.15s ease !important;
			}
			
			[data-vault-search-modal="true"] .search-file-header:hover {
				background: var(--background-modifier-hover) !important;
			}
			
			/* File name - only visual emphasis */
			[data-vault-search-modal="true"] .search-file-name {
				font-weight: 600 !important;
				color: var(--text-normal) !important;
				font-size: 13px !important;
			}
			
			/* File name match - subtle highlight */
			[data-vault-search-modal="true"] .search-file-header.file-name-match .search-file-name {
				color: var(--text-accent) !important;
			}
			
			[data-vault-search-modal="true"] .search-file-separator {
				color: var(--text-muted) !important;
				opacity: 0.4 !important;
				font-size: 12px !important;
			}
			
			[data-vault-search-modal="true"] .search-file-time {
				color: var(--text-muted) !important;
				font-size: 12px !important;
				opacity: 0.6 !important;
			}
			
			[data-vault-search-modal="true"] .search-file-count {
				display: none !important; /* Remove match count - unnecessary */
			}
			
			/* Blocks container - simple indentation */
			[data-vault-search-modal="true"] .search-blocks-container {
				margin-left: 16px !important;
			}
			
			/* Block items - minimal styling with clear interaction */
			[data-vault-search-modal="true"] .search-block-item {
				padding: 8px 12px !important;
				margin: 4px -12px !important;
				cursor: pointer !important;
				border-radius: 4px !important;
				transition: background 0.15s ease !important;
			}
			
			[data-vault-search-modal="true"] .search-block-item.selected {
				background: var(--interactive-accent) !important;
				color: var(--text-on-accent) !important;
			}
			
			[data-vault-search-modal="true"] .search-block-item.hovered {
				background: var(--background-modifier-hover) !important;
			}
			
			/* Ensure selected content is readable */
			[data-vault-search-modal="true"] .search-block-item.selected .search-block-content {
				color: var(--text-on-accent) !important;
			}
			
			[data-vault-search-modal="true"] .search-block-item.selected .search-block-content mark {
				color: var(--text-on-accent) !important;
				font-weight: 600 !important;
			}
			
			/* Block content - clean text */
			[data-vault-search-modal="true"] .search-block-content {
				font-size: 13px !important;
				color: var(--text-muted) !important;
				line-height: 1.6 !important;
				white-space: pre-wrap !important;
				word-break: break-word !important;
			}
			
			/* Minimal highlight - just color, no decoration */
			[data-vault-search-modal="true"] .search-block-content mark {
				background: transparent !important;
				color: var(--text-accent) !important;
				font-weight: 500 !important;
			}
			
			/* Image search result styles */
			[data-vault-search-modal="true"] .search-image-content {
				display: flex !important;
				gap: 16px !important;
				align-items: flex-start !important;
				padding: 8px !important;
				background: var(--background-secondary) !important;
				border-radius: 8px !important;
				margin: 4px 0 !important;
			}
			
			[data-vault-search-modal="true"] .search-image-preview {
				flex-shrink: 0 !important;
			}
			
			[data-vault-search-modal="true"] .search-image-thumbnail {
				width: 120px !important;
				height: 90px !important;
				object-fit: cover !important;
				border-radius: 6px !important;
				border: 2px solid var(--background-modifier-border) !important;
				transition: all 0.2s ease !important;
				cursor: pointer !important;
			}
			
			[data-vault-search-modal="true"] .search-image-thumbnail:hover {
				border-color: var(--interactive-accent) !important;
				transform: scale(1.02) !important;
				box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15) !important;
			}
			
			[data-vault-search-modal="true"] .search-image-content-area {
				flex: 1 !important;
				display: flex !important;
				flex-direction: column !important;
				gap: 8px !important;
			}
			
			[data-vault-search-modal="true"] .search-image-ocr-section {
				margin-bottom: 6px !important;
			}
			
			[data-vault-search-modal="true"] .search-image-ocr-label {
				font-size: 11px !important;
				font-weight: 600 !important;
				color: var(--text-accent) !important;
				margin-bottom: 3px !important;
				text-transform: uppercase !important;
				letter-spacing: 0.5px !important;
			}
			
			[data-vault-search-modal="true"] .search-image-ocr-text {
				font-size: 13px !important;
				color: var(--text-normal) !important;
				line-height: 1.4 !important;
				background: var(--background-primary) !important;
				padding: 6px 8px !important;
				border-radius: 4px !important;
				border-left: 3px solid var(--interactive-accent) !important;
			}
			
			[data-vault-search-modal="true"] .search-image-no-text {
				font-size: 12px !important;
				color: var(--text-faint) !important;
				font-style: italic !important;
				padding: 6px 8px !important;
			}
			
			
			[data-vault-search-modal="true"] .search-image-file-info {
				font-size: 11px !important;
				color: var(--text-muted) !important;
				margin-top: auto !important;
				padding-top: 6px !important;
				border-top: 1px solid var(--background-modifier-border) !important;
				font-weight: 500 !important;
			}
			
			/* Image result file header styling */
			[data-vault-search-modal="true"] .search-file-header.image-file .search-file-name {
				color: var(--color-orange) !important;
			}
			
			[data-vault-search-modal="true"] .search-file-header.image-file::before {
				content: "🖼️ " !important;
				font-size: 12px !important;
			}
		`;
		
		this.styleManager.addModalStyles(this.modalEl, 'vault-search-modal-styles', styles);
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
		
		// Clean up timeout
		if (this.searchTimeout) {
			clearTimeout(this.searchTimeout);
		}
		
		// Clean up styles
		this.styleManager.cleanup();
		
		// Remove data attribute
		this.modalEl.removeAttribute('data-vault-search-modal');
	}
}