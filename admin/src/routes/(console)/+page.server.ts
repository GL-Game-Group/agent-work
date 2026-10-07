import { getRuntime, requireAdmin } from '#lib/server/context.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	requireAdmin(event);
	const { admin, store } = getRuntime();
	return {
		overview: await admin.overview(),
		members: await admin.members(),
		vendors: await admin.vendorList(),
		subscriptions: await admin.subscriptions(),
		accounts: await admin.accounts(),
		keys: await admin.keys(),
		devices: await admin.devices(),
		audit: await store.recentAudit(6)
	};
};
