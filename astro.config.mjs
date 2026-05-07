import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';

export default defineConfig({
  output: 'static',
  compressHTML: true,
  prefetch: { prefetchAll: false },
  site: 'https://market.bnpc.in',
  vite: {
    server: {
      allowedHosts: ['.ngrok-free.app'],
    },
  },
  integrations: [
    tailwind({ applyBaseStyles: false }),
  ],
  build: {
    assets: '_assets',
  },
});
