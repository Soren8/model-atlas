import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset URLs so the build works from any base path (GitHub Pages, etc.).
  base: './',
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.js'],
    // Nested subpath so main.test.js exercises data-URL resolution for
    // project-page deployments (e.g. https://<user>.github.io/model-atlas/).
    environmentOptions: {
      jsdom: { url: 'https://user.github.io/model-atlas/' },
    },
  },
});
