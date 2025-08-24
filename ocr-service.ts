import { exec } from 'child_process';
import { promisify } from 'util';
import { TFile } from 'obsidian';

const execAsync = promisify(exec);

export interface OCRResult {
	text: string;
	confidence?: number;
	timestamp: number;
	context?: {
		referencingNotes: Array<{
			title: string;
			path: string;
		}>;
		nearbyContent: string;
	};
	// Pre-computed search content for performance
	_searchableContent?: string;
}

interface SearchTerm {
	text: string;
	isNegated: boolean;
	isPhrase: boolean;
	alternatives: SearchTerm[];
}

export interface OCRDebugResult {
	text: string;
	error?: string;
	stderr?: string;
	timestamp: number;
}

export interface OCRIndex {
	[filePath: string]: OCRResult;
}

export class OCRService {
	private index: OCRIndex = {};
	private indexPath: string;
	private app: any;
	private fileContentCache = new Map<string, { content: string; mtime: number }>();
	private regexCache = new Map<string, RegExp[]>();

	constructor(app: any) {
		this.app = app;
		this.indexPath = '.obsidian/plugins/image-gallery-plugin/ocr-index.json';
	}

	/**
	 * Load existing OCR index from storage
	 */
	async loadIndex(): Promise<void> {
		try {
			const adapter = this.app.vault.adapter;
			if (await adapter.exists(this.indexPath)) {
				const data = await adapter.read(this.indexPath);
				this.index = JSON.parse(data);
				console.log(`Loaded OCR index with ${Object.keys(this.index).length} entries`);
			}
		} catch (error) {
			console.error('Failed to load OCR index:', error);
			this.index = {};
		}
	}

	/**
	 * Save OCR index to storage
	 */
	async saveIndex(): Promise<void> {
		try {
			const adapter = this.app.vault.adapter;
			const dir = this.indexPath.substring(0, this.indexPath.lastIndexOf('/'));
			
			// Ensure directory exists
			if (!(await adapter.exists(dir))) {
				await adapter.mkdir(dir);
			}
			
			await adapter.write(this.indexPath, JSON.stringify(this.index, null, 2));
			console.log(`Saved OCR index with ${Object.keys(this.index).length} entries`);
		} catch (error) {
			console.error('Failed to save OCR index:', error);
		}
	}

	/**
	 * Perform OCR on a single image using macOS Vision framework via Swift script
	 */
	async performOCR(filePath: string): Promise<string> {
		// Create a Swift script that uses Vision framework for OCR
		const swiftScript = `
import Vision
import AppKit
import Foundation

guard CommandLine.arguments.count > 1 else {
    print("Error: No image path provided")
    exit(1)
}

let imagePath = CommandLine.arguments[1]
let imageURL = URL(fileURLWithPath: imagePath)

guard let image = NSImage(contentsOf: imageURL) else {
    print("Error: Could not load image")
    exit(1)
}

guard let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    print("Error: Could not convert to CGImage")
    exit(1)
}

let semaphore = DispatchSemaphore(value: 0)
var recognizedText = ""

let request = VNRecognizeTextRequest { request, error in
    guard let observations = request.results as? [VNRecognizedTextObservation], error == nil else {
        semaphore.signal()
        return
    }
    
    let text = observations.compactMap { observation in
        observation.topCandidates(1).first?.string
    }.joined(separator: "\\n")
    
    recognizedText = text
    semaphore.signal()
}

// 专门针对中文优化的设置
request.recognitionLevel = .accurate
request.recognitionLanguages = ["zh-Hans", "zh-Hant", "en-US"]  // 优先中文
request.usesLanguageCorrection = true

// 设置自动语言检测
request.automaticallyDetectsLanguage = true

let requestHandler = VNImageRequestHandler(cgImage: cgImage, options: [:])

do {
    try requestHandler.perform([request])
    semaphore.wait()
    print(recognizedText)
} catch {
    print("Error: OCR failed - \\(error)")
    exit(1)
}
`;

		try {
			// Write Swift script to temporary file
			const tempScriptPath = `/tmp/ocr_${Date.now()}.swift`;
			
			// Use Node.js fs to write the file instead of Obsidian's adapter
			const fs = require('fs');
			fs.writeFileSync(tempScriptPath, swiftScript);

			// Execute Swift script
			const { stdout, stderr } = await execAsync(`swift "${tempScriptPath}" "${filePath}"`);
			
			// Clean up temp file
			try {
				fs.unlinkSync(tempScriptPath);
			} catch (cleanupError) {
				console.warn('Failed to cleanup temp script:', cleanupError);
			}

			if (stderr) {
				console.error('OCR stderr:', stderr);
			}

			return stdout.trim();
		} catch (error) {
			console.error('OCR failed for', filePath, error);
			
			// Fallback: Try using the shortcuts command if available
			try {
				const { stdout } = await execAsync(`shortcuts run "Extract Text from Image" --input-path "${filePath}" 2>/dev/null`);
				return stdout.trim();
			} catch (fallbackError) {
				console.error('Fallback OCR also failed:', fallbackError);
				return '';
			}
		}
	}

	/**
	 * Get OCR text for an image, using cache if available
	 */
	async getOCRText(file: TFile): Promise<string> {
		const filePath = file.path;
		
		// Check if we have a cached result that's not too old (30 days)
		if (this.index[filePath]) {
			const cachedResult = this.index[filePath];
			const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
			
			if (Date.now() - cachedResult.timestamp < thirtyDaysMs) {
				// Also check if file hasn't been modified since indexing
				if (file.stat.mtime <= cachedResult.timestamp) {
					return cachedResult.text;
				}
			}
		}

		// Perform OCR and extract context
		const absolutePath = (this.app.vault.adapter as any).getFullPath(filePath);
		const text = await this.performOCR(absolutePath);
		
		// Extract context information
		const context = await this.extractImageContext(file);
		
		this.index[filePath] = {
			text,
			timestamp: Date.now(),
			context
		};

		// Save index after each new OCR (could be optimized with debouncing)
		await this.saveIndex();
		
		return text;
	}

	/**
	 * Index all images in the vault with parallel processing
	 */
	async indexAllImages(
		images: Array<{ file?: TFile; isLocal: boolean }>,
		onProgress?: (current: number, total: number) => void,
		concurrencyLimit: number = 4
	): Promise<void> {
		const localImages = images.filter(img => img.isLocal && img.file);
		let processed = 0;

		// Split images into chunks for parallel processing
		const chunks = [];
		for (let i = 0; i < localImages.length; i += concurrencyLimit) {
			chunks.push(localImages.slice(i, i + concurrencyLimit));
		}

		for (const chunk of chunks) {
			// Process current chunk in parallel
			const promises = chunk.map(async (img) => {
				if (img.file) {
					try {
						await this.getOCRTextWithoutSave(img.file); // Don't save after each OCR
						processed++;
						
						if (onProgress) {
							onProgress(processed, localImages.length);
						}
						return true;
					} catch (error) {
						console.error(`Failed to index ${img.file.path}:`, error);
						processed++;
						
						if (onProgress) {
							onProgress(processed, localImages.length);
						}
						return false;
					}
				}
				return false;
			});

			// Wait for current chunk to complete before processing next chunk
			await Promise.all(promises);
			
			// Save index after each chunk to avoid data loss
			await this.saveIndex();
		}

		// Final save to ensure all data is persisted
		await this.saveIndex();
	}

	/**
	 * Get OCR text without saving index (for batch processing)
	 */
	async getOCRTextWithoutSave(file: TFile): Promise<string> {
		const filePath = file.path;
		
		// Check if we have a cached result that's not too old (30 days)
		if (this.index[filePath]) {
			const cachedResult = this.index[filePath];
			const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
			
			if (Date.now() - cachedResult.timestamp < thirtyDaysMs) {
				// Also check if file hasn't been modified since indexing
				if (file.stat.mtime <= cachedResult.timestamp) {
					return cachedResult.text;
				}
			}
		}

		// Perform OCR and extract context
		const absolutePath = (this.app.vault.adapter as any).getFullPath(filePath);
		const text = await this.performOCR(absolutePath);
		
		// Extract context information
		const context = await this.extractImageContext(file);
		
		this.index[filePath] = {
			text,
			timestamp: Date.now(),
			context
		};

		// Don't save index here - will be saved in batch
		return text;
	}

	/**
	 * Search images by OCR content and context
	 */
	searchImages(query: string): Set<string> {
		const results = new Set<string>();
		
		if (!query.trim()) {
			return results;
		}

		// Parse the search query into structured search terms
		const searchTerms = this.parseSearchQuery(query);

		for (const [filePath, ocrResult] of Object.entries(this.index)) {
			// Use pre-computed searchable content or compute on demand
			const searchableContent = this.getSearchableContent(ocrResult);

			// Evaluate the search terms against the content
			if (this.evaluateSearchTerms(searchTerms, searchableContent)) {
				results.add(filePath);
			}
		}

		return results;
	}

	/**
	 * Get or compute searchable content for an OCR result
	 */
	private getSearchableContent(ocrResult: OCRResult): string {
		if (!ocrResult._searchableContent) {
			ocrResult._searchableContent = [
				ocrResult.text,
				...(ocrResult.context?.referencingNotes.map(note => note.title) || []),
				ocrResult.context?.nearbyContent || ''
			].join(' ').toLowerCase();
		}
		return ocrResult._searchableContent;
	}

	/**
	 * Parse search query into structured terms supporting various syntax
	 */
	private parseSearchQuery(query: string): SearchTerm[] {
		const terms: SearchTerm[] = [];
		const tokens = this.tokenizeQuery(query);
		
		let i = 0;
		while (i < tokens.length) {
			const token = tokens[i];
			
			if (token.toLowerCase() === 'or') {
				// Handle OR operator - modify the previous term
				if (terms.length > 0) {
					const prevTerm = terms[terms.length - 1];
					if (i + 1 < tokens.length) {
						const nextToken = tokens[i + 1];
						const nextTerm = this.parseToken(nextToken);
						prevTerm.alternatives = prevTerm.alternatives || [];
						prevTerm.alternatives.push(nextTerm);
						i += 2; // Skip the OR and next token
						continue;
					}
				}
			} else {
				const term = this.parseToken(token);
				terms.push(term);
			}
			i++;
		}
		
		return terms;
	}

	/**
	 * Tokenize query while respecting quoted phrases
	 */
	private tokenizeQuery(query: string): string[] {
		const tokens: string[] = [];
		let current = '';
		let inQuotes = false;
		let quoteChar = '';
		
		for (let i = 0; i < query.length; i++) {
			const char = query[i];
			
			if ((char === '"' || char === "'") && !inQuotes) {
				// Start of quoted phrase
				inQuotes = true;
				quoteChar = char;
				current += char;
			} else if (char === quoteChar && inQuotes) {
				// End of quoted phrase
				inQuotes = false;
				current += char;
				tokens.push(current.trim());
				current = '';
				quoteChar = '';
			} else if (char === ' ' && !inQuotes) {
				// Space outside quotes - end current token
				if (current.trim()) {
					tokens.push(current.trim());
					current = '';
				}
			} else {
				current += char;
			}
		}
		
		// Add final token
		if (current.trim()) {
			tokens.push(current.trim());
		}
		
		return tokens.filter(token => token.length > 0);
	}

	/**
	 * Parse individual token into search term
	 */
	private parseToken(token: string): SearchTerm {
		const term: SearchTerm = {
			text: '',
			isNegated: false,
			isPhrase: false,
			alternatives: []
		};
		
		// Check for negation
		if (token.startsWith('-')) {
			term.isNegated = true;
			token = token.substring(1);
		}
		
		// Check for quoted phrase
		if ((token.startsWith('"') && token.endsWith('"')) || 
			(token.startsWith("'") && token.endsWith("'"))) {
			term.isPhrase = true;
			term.text = token.slice(1, -1).toLowerCase();
		} else {
			term.text = token.toLowerCase();
		}
		
		return term;
	}

	/**
	 * Evaluate search terms against content
	 */
	private evaluateSearchTerms(terms: SearchTerm[], content: string): boolean {
		for (const term of terms) {
			const matches = this.evaluateSingleTerm(term, content);
			
			if (term.isNegated) {
				// For negated terms, if ANY match, this fails
				if (matches) {
					return false;
				}
			} else {
				// For positive terms, ALL must match
				if (!matches) {
					return false;
				}
			}
		}
		return true;
	}

	/**
	 * Evaluate a single search term
	 */
	private evaluateSingleTerm(term: SearchTerm, content: string): boolean {
		// Check the main term
		const mainMatch = term.isPhrase 
			? content.includes(term.text)
			: this.matchesKeywords([term.text], content);
			
		// Check alternatives (OR logic)
		if (term.alternatives && term.alternatives.length > 0) {
			const alternativeMatches = term.alternatives.some(alt => 
				alt.isPhrase 
					? content.includes(alt.text)
					: this.matchesKeywords([alt.text], content)
			);
			return mainMatch || alternativeMatches;
		}
		
		return mainMatch;
	}

	/**
	 * Check if content matches keywords (supports multi-word AND logic)
	 */
	private matchesKeywords(keywords: string[], content: string): boolean {
		return keywords.every(keyword => {
			// Split keyword into individual words and check all are present
			const words = keyword.split(/\s+/).filter(word => word.length > 0);
			return words.every(word => content.includes(word));
		});
	}

	/**
	 * Clear the entire index
	 */
	async clearIndex(): Promise<void> {
		this.index = {};
		// Clear performance caches
		this.fileContentCache.clear();
		this.regexCache.clear();
		await this.saveIndex();
	}

	/**
	 * Clean up performance caches periodically
	 */
	cleanupCaches(): void {
		// Clear file content cache if it gets too large
		if (this.fileContentCache.size > 500) {
			const entries = Array.from(this.fileContentCache.entries());
			// Sort by mtime and keep only the 250 most recent
			entries.sort((a, b) => b[1].mtime - a[1].mtime);
			this.fileContentCache.clear();
			entries.slice(0, 250).forEach(([path, data]) => {
				this.fileContentCache.set(path, data);
			});
		}

		// Clear regex cache if it gets too large  
		if (this.regexCache.size > 100) {
			this.regexCache.clear();
		}
	}

	/**
	 * Get index statistics
	 */
	getIndexStats(): { total: number; size: number } {
		const total = Object.keys(this.index).length;
		const size = JSON.stringify(this.index).length;
		return { total, size };
	}

	/**
	 * Perform incremental update - only index new or modified images
	 */
	async incrementalUpdate(
		images: Array<{ file?: TFile; isLocal: boolean }>,
		onProgress?: (current: number, total: number) => void,
		concurrencyLimit: number = 4
	): Promise<{ indexed: number; skipped: number }> {
		const localImages = images.filter(img => img.isLocal && img.file);
		const imagesToIndex = [];

		// Check which images need indexing
		for (const img of localImages) {
			if (!img.file) continue;

			const filePath = img.file.path;
			const existingResult = this.index[filePath];

			if (!existingResult) {
				// New image - needs indexing
				imagesToIndex.push(img);
			} else {
				// Check if file was modified since last indexing
				if (img.file.stat.mtime > existingResult.timestamp) {
					imagesToIndex.push(img);
				}
			}
		}

		if (imagesToIndex.length === 0) {
			return { indexed: 0, skipped: localImages.length };
		}

		// Index only the images that need it
		await this.indexAllImages(imagesToIndex, onProgress, concurrencyLimit);

		return { 
			indexed: imagesToIndex.length, 
			skipped: localImages.length - imagesToIndex.length 
		};
	}

	/**
	 * Extract context information for an image
	 */
	async extractImageContext(file: TFile): Promise<{ referencingNotes: Array<{ title: string; path: string }>; nearbyContent: string }> {
		const referencingNotes: Array<{ title: string; path: string }> = [];
		let nearbyContent = '';

		// Get all markdown files
		const markdownFiles = this.app.vault.getMarkdownFiles();
		const imageName = file.name;
		const imagePath = file.path;
		const imageBasename = file.basename;
		
		// Get context lines setting once
		const plugin = (this.app as any).plugins.getPlugin('image-gallery-plugin');
		const contextLines = plugin?.settings?.contextParagraphs || 3;
		
		// Use Promise.all to read files in parallel, but limit concurrency
		const batchSize = 10;
		for (let i = 0; i < markdownFiles.length; i += batchSize) {
			const batch = markdownFiles.slice(i, i + batchSize);
			
			await Promise.all(batch.map(async (mdFile: TFile) => {
				try {
					const content = await this.getCachedFileContent(mdFile);
					
					// Quick check with multiple patterns
					if (!this.fileReferencesImage(content, imageName, imagePath, imageBasename)) {
						return;
					}

					// Add to referencing notes
					referencingNotes.push({
						title: mdFile.basename,
						path: mdFile.path
					});

					// Extract nearby content
					const contextFromFile = this.extractNearbyContent(content, imageName, imagePath, imageBasename, contextLines);
					if (contextFromFile) {
						const separator = nearbyContent ? '\n---\n' : '';
						nearbyContent += separator + `${mdFile.basename}: ${contextFromFile}`;
					}
				} catch (error) {
					console.error(`Failed to read file ${mdFile.path}:`, error);
				}
			}));
		}

		return { referencingNotes, nearbyContent };
	}

	/**
	 * Get cached file content with mtime check
	 */
	private async getCachedFileContent(file: TFile): Promise<string> {
		const cached = this.fileContentCache.get(file.path);
		
		if (cached && cached.mtime >= file.stat.mtime) {
			return cached.content;
		}
		
		const content = await this.app.vault.read(file);
		this.fileContentCache.set(file.path, {
			content,
			mtime: file.stat.mtime
		});
		
		return content;
	}

	/**
	 * Quick check if file references an image
	 */
	private fileReferencesImage(content: string, imageName: string, imagePath: string, imageBasename: string): boolean {
		// Use indexOf for better performance than includes
		return content.indexOf(imageName) !== -1 || 
			   content.indexOf(imagePath) !== -1 || 
			   content.indexOf(imageBasename) !== -1;
	}

	/**
	 * Get cached regex patterns for image matching
	 */
	private getImagePatterns(imageName: string, imageBasename: string): RegExp[] {
		const cacheKey = `${imageName}|${imageBasename}`;
		
		if (this.regexCache.has(cacheKey)) {
			return this.regexCache.get(cacheKey)!;
		}
		
		const patterns = [
			new RegExp(`!\\[\\[${this.escapeRegex(imageName)}\\]\\]`, 'i'),
			new RegExp(`!\\[.*?\\]\\(.*?${this.escapeRegex(imageName)}.*?\\)`, 'i'),
			new RegExp(`<img.*?src=["'].*?${this.escapeRegex(imageName)}.*?["']`, 'i'),
			new RegExp(`!\\[\\[${this.escapeRegex(imageBasename)}\\]\\]`, 'i')
		];
		
		this.regexCache.set(cacheKey, patterns);
		return patterns;
	}

	/**
	 * Escape regex special characters
	 */
	private escapeRegex(str: string): string {
		return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	}

	/**
	 * Extract nearby content around image references
	 */
	private extractNearbyContent(content: string, imageName: string, imagePath: string, imageBasename: string, maxContextLines: number = 3): string {
		const lines = content.split('\n');
		const contexts: string[] = [];
		
		// Get cached regex patterns
		const patterns = this.getImagePatterns(imageName, imageBasename);

		// Helper function to check if a line should be skipped
		const shouldSkipLine = (line: string): boolean => {
			const trimmed = line.trim();
			return trimmed === '' ||                              // Empty lines
				   trimmed.startsWith('#') ||                     // Headers
				   trimmed.startsWith('![[') ||                   // Wiki image links
				   trimmed.startsWith('![') ||                    // Markdown images
				   trimmed.includes('<img') ||                    // HTML images
				   trimmed.startsWith('---') ||                   // Horizontal rules
				   trimmed.startsWith('```');                     // Code blocks
		};

		// Find all lines that contain the target image
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			
			// Check if this line contains the target image
			const hasImageRef = patterns.some(pattern => pattern.test(line));
			
			if (hasImageRef) {
				const contextLines: string[] = [];
				
				// Collect previous context lines
				let prevCount = 0;
				for (let j = i - 1; j >= 0 && prevCount < maxContextLines; j--) {
					const prevLine = lines[j].trim();
					if (!shouldSkipLine(prevLine)) {
						contextLines.unshift(prevLine);
						prevCount++;
					}
				}
				
				// Collect next context lines
				let nextCount = 0;
				for (let j = i + 1; j < lines.length && nextCount < maxContextLines; j++) {
					const nextLine = lines[j].trim();
					if (!shouldSkipLine(nextLine)) {
						contextLines.push(nextLine);
						nextCount++;
					}
				}
				
				if (contextLines.length > 0) {
					contexts.push(contextLines.join(' | '));
				}
			}
		}

		return contexts.join(' | ');
	}

	/**
	 * Get cached OCR result for debugging
	 */
	getCachedResult(filePath: string): OCRResult | null {
		return this.index[filePath] || null;
	}

	/**
	 * Perform OCR with detailed debug information
	 */
	async performOCRWithDebug(filePath: string): Promise<OCRDebugResult> {
		// Create a Swift script that uses Vision framework for OCR
		const swiftScript = `
import Vision
import AppKit
import Foundation

guard CommandLine.arguments.count > 1 else {
    print("Error: No image path provided")
    exit(1)
}

let imagePath = CommandLine.arguments[1]
let imageURL = URL(fileURLWithPath: imagePath)

guard let image = NSImage(contentsOf: imageURL) else {
    print("Error: Could not load image")
    exit(1)
}

guard let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    print("Error: Could not convert to CGImage")
    exit(1)
}

let semaphore = DispatchSemaphore(value: 0)
var recognizedText = ""

let request = VNRecognizeTextRequest { request, error in
    guard let observations = request.results as? [VNRecognizedTextObservation], error == nil else {
        if let error = error {
            print("OCR Error: \\(error.localizedDescription)")
        }
        semaphore.signal()
        return
    }
    
    let text = observations.compactMap { observation in
        observation.topCandidates(1).first?.string
    }.joined(separator: "\\n")
    
    recognizedText = text
    semaphore.signal()
}

// 专门针对中文优化的设置
request.recognitionLevel = .accurate
request.recognitionLanguages = ["zh-Hans", "zh-Hant", "en-US"]  // 优先中文
request.usesLanguageCorrection = true

// 设置自动语言检测
request.automaticallyDetectsLanguage = true

let requestHandler = VNImageRequestHandler(cgImage: cgImage, options: [:])

do {
    try requestHandler.perform([request])
    semaphore.wait()
    print(recognizedText)
} catch {
    print("OCR Processing Error: \\(error.localizedDescription)")
    exit(1)
}
`;

		try {
			// Write Swift script to temporary file
			const tempScriptPath = `/tmp/ocr_debug_${Date.now()}.swift`;
			
			// Use Node.js fs to write the file instead of Obsidian's adapter
			const fs = require('fs');
			fs.writeFileSync(tempScriptPath, swiftScript);

			// Execute Swift script
			const { stdout, stderr } = await execAsync(`swift "${tempScriptPath}" "${filePath}"`);
			
			// Clean up temp file
			try {
				fs.unlinkSync(tempScriptPath);
			} catch (cleanupError) {
				console.warn('Failed to cleanup temp script:', cleanupError);
			}

			return {
				text: stdout.trim(),
				stderr: stderr || undefined,
				timestamp: Date.now()
			};
		} catch (error) {
			console.error('OCR failed for', filePath, error);
			
			// Try fallback method
			try {
				const { stdout, stderr } = await execAsync(`shortcuts run "Extract Text from Image" --input-path "${filePath}" 2>/dev/null`);
				return {
					text: stdout.trim(),
					stderr: stderr || undefined,
					timestamp: Date.now()
				};
			} catch (fallbackError) {
				return {
					text: '',
					error: error instanceof Error ? error.message : String(error),
					stderr: undefined,
					timestamp: Date.now()
				};
			}
		}
	}
}