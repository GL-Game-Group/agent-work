/**
 * The company service in production: one process, one port. Everything under
 * /agent-work/ (sign-in, the model gateway, the desktop's config) goes to the
 * service's own handler; the rest is the web console (SvelteKit, adapter-node).
 *
 *   node server.js            # configuration from the environment (gateway/.env.example)
 */
import { createServer } from 'node:http';
import { loadConfig } from '@agent-work/gateway/config';
import { createRuntime, setRuntime } from '@agent-work/gateway/runtime';

if (process.env.AGENT_WORK_ENV_FILE) process.loadEnvFile(process.env.AGENT_WORK_ENV_FILE);
const config = loadConfig();
if (config.secretKey === undefined) console.warn('agent-work: AGENT_WORK_SECRET_KEY is not set; API keys and secret config cannot be stored (openssl rand -base64 32)');
const runtime = createRuntime(config);
setRuntime(runtime);
// SvelteKit's origin checks and URLs follow the public address, not the listening one.
process.env.ORIGIN = config.publicOrigin;
const { handler } = await import('./build/handler.js');

const server = createServer((req, res) => {
	if (req.url?.startsWith('/agent-work/')) {
		runtime.gateway(req, res).catch((error) => {
			console.error('agent-work: request failed', error);
			if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }).end('{"error":"internal"}');
			else res.destroy();
		});
		return;
	}
	handler(req, res);
});

// 手机远程's live events (a WebSocket relayed to the member's Mac); nothing else upgrades.
server.on('upgrade', (req, socket, head) => {
	if (!runtime.upgrade(req, socket, head)) socket.destroy();
});

const purge = setInterval(() => { runtime.store.purge(); }, 60 * 60 * 1000);
purge.unref();
server.listen(config.listenPort, config.listenHost, () => {
	console.log(`agent-work: ${config.publicOrigin} served on ${config.listenHost}:${String(config.listenPort)}`);
});
for (const signal of ['SIGTERM', 'SIGINT']) {
	process.once(signal, () => {
		server.close(() => { runtime.store.close(); process.exit(0); });
		server.closeAllConnections();
	});
}
