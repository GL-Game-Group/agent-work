import { getRuntime, requireAdmin } from '#lib/server/context.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = (event) => {
	requireAdmin(event);
	const { admin } = getRuntime();
	return { entries: admin.auditLog(500), members: admin.members().map((m) => ({ name: m.name, displayName: m.displayName })) };
};
