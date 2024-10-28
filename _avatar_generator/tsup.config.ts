// tsup.config.ts
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts'], // Replace with your entry file
  format: ['esm'], // CommonJS output
  minify: true, // Minify the output
  target: 'node20', // Adjust this based on your target Node.js version
  sourcemap: true, // Generate source maps
  dts: true, // Generate TypeScript declaration files
  bundle: true, // Bundle dependencies
  external: ['@heygen/streaming-avatar'], 
});
