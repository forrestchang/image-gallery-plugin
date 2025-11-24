import { TFile } from 'obsidian';

export interface ImageInfo {
	path: string;
	file?: TFile;
	isLocal: boolean;
	displayName: string;
	createdTime?: number;
	modifiedTime?: number;
	ocrText?: string;
}

export interface ImageGallerySettings {
	enableOCRDebug: boolean;
	ocrConcurrency: number;
	contextParagraphs: number;
	searchExcludeFolders: string[];
	searchMinimalMode: boolean;
	searchIncludeImages: boolean;
	searchResultFontSize: number;
}

export const DEFAULT_SETTINGS: ImageGallerySettings = {
	enableOCRDebug: false,
	ocrConcurrency: 4,
	contextParagraphs: 3,
	searchExcludeFolders: [],
	searchMinimalMode: false,
	searchIncludeImages: true,
	searchResultFontSize: 13
}
