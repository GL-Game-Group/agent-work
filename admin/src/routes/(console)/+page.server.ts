import { getRuntime, requireAdmin } from '#lib/server/context.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = (event) => {
	requireAdmin(event);
	const { admin, store } = getRuntime();
	return {
		overview: admin.overview(),
		members: admin.members(),
		vendors: admin.vendorList(),
		subscriptions: admin.subscriptions(),
		accounts: admin.accounts(),
		keys: admin.keys(),
		devices: admin.devices(),
		audit: store.recentAudit(6)
	};
};
