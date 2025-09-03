# Claude Development Guide

## Building Process

To build the plugin after making changes:

```bash
npm run build
```

This command will:
1. Run TypeScript type checking (`tsc -noEmit -skipLibCheck`)
2. Bundle the plugin using esbuild for production

Always run the build command after making code changes to ensure the plugin compiles correctly.

## Testing

After building, reload Obsidian or disable/enable the plugin to test your changes.