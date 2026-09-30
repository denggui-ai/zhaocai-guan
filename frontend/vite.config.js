import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

function vendorChunkName(id) {
  if (!id.includes('/node_modules/')) return undefined;
  if (/\/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'react-vendor';
  if (/\/node_modules\/antd\/(?:es|lib)\/table\//.test(id)) return 'antd-table-vendor';
  if (id.includes('/node_modules/antd/')) return 'antd-vendor';
  if (/\/node_modules\/(rc-|@rc-component\/)/.test(id)) return 'rc-vendor';
  if (/\/node_modules\/@ant-design\/(cssinjs|cssinjs-utils|colors)\//.test(id)) return 'design-runtime';
  if (/\/node_modules\/@ant-design\/(icons|icons-svg)\//.test(id)) return 'icon-vendor';
  return 'vendor';
}

export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: vendorChunkName,
      },
    },
  },
});
