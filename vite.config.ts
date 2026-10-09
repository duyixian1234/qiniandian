import { defineConfig } from 'vite';

// appType 'mpa' disables the SPA history fallback. This is load-bearing, not cosmetic:
// with the default ('spa'), vite preview answers ANY unmatched path with index.html and
// HTTP 200, so a missing asset never surfaces as a 404 and an asset-integrity gate can
// never fire. Verified in .probe/scaffold-test (a 404 probe was silently ignored until
// this was set). Do not "simplify" this back to the default.
export default defineConfig({
  appType: 'mpa',
  build: { target: 'es2022' },
  preview: { host: '127.0.0.1', port: 5390, strictPort: true },
});
