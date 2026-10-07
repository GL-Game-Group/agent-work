import { getRuntime, orError, requireAdmin } from '#lib/server/context.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	requireAdmin(event);
	const { admin } = getRuntime();
	const days = Number(event.url.searchParams.get('days') ?? '30');
	return {
		usage: await orError(() => admin.usage(days)),
		vendors: (await admin.vendorList()).map((v) => ({ id: v.id, name: v.name })),
		members: (await admin.members()).map((m) => ({ name: m.name, displayName: m.displayName, githubId: m.githubId }))
	};
};
