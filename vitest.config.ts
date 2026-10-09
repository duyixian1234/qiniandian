import { defineConfig } from 'vitest/config';

// Kept separate from vite.config.ts so that `tsc --noEmit` type-checks the Vite config
// without needing vitest's augmented config type. Merging them produced TS2769
// ("'test' does not exist in type UserConfigExport").
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
