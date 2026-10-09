import { defineConfig } from 'vite';

// appType 'mpa' disables the SPA history fallback. This is load-bearing, not cosmetic:
// with the default ('spa'), vite preview answers ANY unmatched path with index.html and
// HTTP 200, so a missing asset never surfaces as a 404 and an asset-integrity gate can
// never fire. Verified in .probe/scaffold-test (a 404 probe was silently ignored until
// this was set). Do not "simplify" this back to the default.
export default defineConfig({
  appType: 'mpa',
  build: { target: 'es2022' },
  // 开发服务器（HMR）与预览服务器（跑构建产物）用**不同端口**，否则两者同时跑时
  // strictPort 会让其中一个直接启动失败，而报错信息不直观。
  //   5390 = preview，供 run.ps1 的截图门禁使用（必须跑构建产物才代表交付物）
  //   5391 = dev，供日常开发（有 HMR，但不代表交付物）
  server: { host: '127.0.0.1', port: 5391, strictPort: true },
  preview: { host: '127.0.0.1', port: 5390, strictPort: true },
});
