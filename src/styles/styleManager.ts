/**
 * StyleManager - Handles all CSS injection and cleanup for the plugin
 */
export class StyleManager {
    private styles: Map<string, HTMLStyleElement> = new Map();
    
    /**
     * Inject reset styles to prevent conflicts with other plugins
     */
    injectResetStyles(container: HTMLElement): void {
        const resetStyle = document.createElement('style');
        resetStyle.textContent = `
            /* Reset all inherited CSS custom properties and styles */
            .modal.mod-image-preview,
            .modal.mod-image-gallery,
            .modal.mod-ocr-debug,
            .modal.mod-confirm {
                /* Reset Tailwind variables that might be injected by other plugins */
                --tw-border-spacing-x: initial !important;
                --tw-border-spacing-y: initial !important;
                --tw-translate-x: initial !important;
                --tw-translate-y: initial !important;
                --tw-rotate: initial !important;
                --tw-skew-x: initial !important;
                --tw-skew-y: initial !important;
                --tw-scale-x: initial !important;
                --tw-scale-y: initial !important;
                --tw-pan-x: initial !important;
                --tw-pan-y: initial !important;
                --tw-pinch-zoom: initial !important;
                
                /* Ensure our modals use standard box model */
                box-sizing: border-box !important;
            }
            
            /* Reset children to prevent interference */
            .modal.mod-image-preview *,
            .modal.mod-image-gallery *,
            .modal.mod-ocr-debug *,
            .modal.mod-confirm * {
                /* Reset Tailwind transform variables */
                --tw-translate-x: initial !important;
                --tw-translate-y: initial !important;
                --tw-rotate: initial !important;
                --tw-scale-x: initial !important;
                --tw-scale-y: initial !important;
            }
        `;
        
        // Insert at the beginning of the container
        container.insertBefore(resetStyle, container.firstChild);
    }
    
    /**
     * Add styles to a modal with proper isolation
     */
    addModalStyles(modalEl: HTMLElement, styleId: string, styles: string): void {
        // Remove existing style if any
        this.removeStyles(styleId);
        
        // First inject reset styles
        this.injectResetStyles(modalEl);
        
        // Then inject the modal-specific styles
        const style = document.createElement('style');
        style.id = styleId;
        style.textContent = styles;
        
        modalEl.appendChild(style);
        this.styles.set(styleId, style);
    }
    
    /**
     * Remove styles by ID
     */
    removeStyles(styleId: string): void {
        const style = this.styles.get(styleId);
        if (style) {
            style.remove();
            this.styles.delete(styleId);
        }
        
        // Also check document for any orphaned styles
        const orphaned = document.getElementById(styleId);
        if (orphaned) {
            orphaned.remove();
        }
    }
    
    /**
     * Clean up all managed styles
     */
    cleanup(): void {
        this.styles.forEach((style, id) => {
            style.remove();
        });
        this.styles.clear();
    }
}