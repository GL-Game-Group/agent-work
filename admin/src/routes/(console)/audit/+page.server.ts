import { getRuntime, requireAdmin } from '#lib/server/context.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	requireAdmin(event);
	const { admin } = getRuntime();
	return { entries: await admin.auditLog(500), members: (await admin.members()).map((m) => ({ name: m.name, displayName: m.displayName })) };
};
