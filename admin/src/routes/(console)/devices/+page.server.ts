import { act, actor, getRuntime, requireAdmin, text } from '#lib/server/context.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	requireAdmin(event);
	const { admin } = getRuntime();
	return {
		devices: await admin.devices(),
		members: (await admin.members()).map((m) => ({ name: m.name, displayName: m.displayName, githubId: m.githubId }))
	};
};

export const actions: Actions = {
	revoke: async (event) => {
		const form = await event.request.formData();
		return act(async () => { await getRuntime().admin.revokeDevice(actor(event), text(form, 'id')); return {}; });
	}
};
