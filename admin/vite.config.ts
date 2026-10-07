import tailwindcss from '@tailwindcss/vite';
import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, type Plugin } from 'vite';

/**
 * The company service runs in the same process as the console. In development
 * this plugin starts it and hands it everything under /agent-work/ (sign-in,
 * the model gateway, the desktop's config); SvelteKit serves the rest.
 *
 * - default: a fake GitHub and seeded data on http://127.0.0.1:5173;
 * - AGENT_WORK_ENV_FILE=../gateway/.env: the real configuration (real GitHub sign-in)
 *   on the port its AGENT_WORK_PUBLIC_ORIGIN names, so the OAuth callback matches.
 */
const envFile = process.env.AGENT_WORK_ENV_FILE;
if (envFile) process.loadEnvFile(envFile);
const DEV_ORIGIN = envFile ? (process.env.AGENT_WORK_PUBLIC_ORIGIN ?? 'http://127.0.0.1:8787') : 'http://127.0.0.1:5173';

function companyService(): Plugin {
	return {
		name: 'agent-work-company-service',
		apply: 'serve',
		async configureServer(server) {
			const { setRuntime, createRuntime } = await import('@agent-work/gateway/runtime');
			let runtime;
			if (envFile) {
				const { loadConfig } = await import('@agent-work/gateway/config');
				runtime = await createRuntime(loadConfig());
			} else {
				const { startDevRuntime } = await import('@agent-work/gateway/dev-runtime');
				({ runtime } = await startDevRuntime({ publicOrigin: DEV_ORIGIN, ...(process.env.AGENT_WORK_DEV_DB ? { dataDir: process.env.AGENT_WORK_DEV_DB } : {}) }));
			}
			setRuntime(runtime);
			server.middlewares.use((req, res, next) => {
				if (!req.url?.startsWith('/agent-work/')) return next();
				runtime.gateway(req, res).catch(next);
			});
			// 手机远程's WebSocket; Vite's own HMR upgrades pass by.
			server.httpServer?.on('upgrade', (req, socket, head) => { runtime.upgrade(req, socket, head); });
		},
	};
}

export default defineConfig({
	plugins: [
		companyService(),
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			// server.js mounts the company service in front of SvelteKit's handler.
			adapter: adapter(),
			csp: {
				mode: 'auto',
				directives: {
					'default-src': ['none'],
					'script-src': ['self'],
					// Component libraries position popovers through style attributes.
					'style-src': ['self', 'unsafe-inline'],
					'img-src': ['self', 'data:', 'https://avatars.githubusercontent.com'],
					'font-src': ['self'],
					'connect-src': ['self'],
					'form-action': ['self'],
					'base-uri': ['none'],
					'frame-ancestors': ['none']
				}
			}
		})
	],
	server: { host: new URL(DEV_ORIGIN).hostname, port: Number(new URL(DEV_ORIGIN).port), strictPort: true }
});
