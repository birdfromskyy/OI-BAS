import tailwindcss from '@tailwindcss/vite';
import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
	const env = loadEnv(mode, '.', '');

	return {
		server: {
			// The browser always calls a relative /api URL. In development Vite
			// forwards it to Go; in production the identical path is handled by
			// Caddy. This keeps access links and PWA sync independent of a port.
			proxy: {
				'/api': {
					target: env.VITE_API_PROXY_TARGET ?? 'http://localhost:8081',
					changeOrigin: true
				},
				'/healthz': {
					target: env.VITE_API_PROXY_TARGET ?? 'http://localhost:8081',
					changeOrigin: true
				}
			}
		},
		optimizeDeps: {
			/**
			 * maplibre-gl не отдаём предсборке зависимостей.
			 *
			 * Библиотека поднимает веб-воркер, адрес которого вычисляет от своего
			 * import.meta.url. После предсборки её код лежит в node_modules/.vite/deps,
			 * а файла воркера рядом нет — воркер не поднимается, и карта молча
			 * остаётся пустой: ни ошибки, ни тайлов. Исключение из предсборки
			 * оставляет библиотеку в своём каталоге, где воркер лежит рядом.
			 */
			exclude: ['maplibre-gl']
		},
		plugins: [
			tailwindcss(),
			sveltekit({
				compilerOptions: {
					// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
					runes: ({ filename }) =>
						filename.split(/[/\\]/).includes('node_modules') ? undefined : true
				},

				adapter: adapter({ fallback: 'index.html' })
			})
		]
	};
});
