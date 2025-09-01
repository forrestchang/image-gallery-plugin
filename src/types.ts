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
	enableFolderFilter: boolean;
	searchExcludeFolders: string[];
	searchMinimalMode: boolean;
}

export const DEFAULT_SETTINGS: ImageGallerySettings = {
	enableOCRDebug: false,
	ocrConcurrency: 4,
	contextParagraphs: 3,
	enableFolderFilter: true,
	searchExcludeFolders: [],
	searchMinimalMode: false
}