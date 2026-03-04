import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';

export default defineConfig({
  site: process.env.SITE_URL || 'https://robinmordasiewicz.github.io',
  base: process.env.SITE_BASE || '/maui',
  integrations: [tailwind()],
});
