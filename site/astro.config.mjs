// @ts-check

import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
	site: process.env.SITE_URL || 'https://robinmordasiewicz.github.io',
	base: process.env.SITE_BASE || '/maui',
	integrations: [mdx(), sitemap()],
});
