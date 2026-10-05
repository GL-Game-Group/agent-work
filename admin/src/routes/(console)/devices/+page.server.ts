import { act, actor, getRuntime, requireAdmin, text } from '#lib/server/context.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = (event) => {
	requireAdmin(event);
	const { admin } = getRuntime();
	return {
		devices: admin.devices(),
		members: admin.members().map((m) => ({ name: m.name, displayName: m.displayName, githubId: m.githubId }))
	};
};

export const actions: Actions = {
	revoke: async (event) => {
		const form = await event.request.formData();
		return act(() => { getRuntime().admin.revokeDevice(actor(event), text(form, 'id')); return {}; });
	}
};
