import { getRuntime, requireAdmin } from '#lib/server/context.js';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async (event) => {
	const viewer = requireAdmin(event);
	const runtime = getRuntime();
	const vendors = new Map((await runtime.vendors.listVendors()).map((v) => [v.id, v]));
	const waiting = (await runtime.vendors.assignments()).filter((a) => {
		const vendor = vendors.get(a.vendor);
		return vendor?.auth === 'key' ? a.apiKey === null : a.cliAccount === null;
	}).length;
	return {
		viewer: { name: viewer.name, displayName: viewer.displayName, githubLogin: viewer.githubLogin, githubId: viewer.githubId },
		productName: runtime.config.productName ?? 'GL Work',
		badges: { waiting }
	};
};
