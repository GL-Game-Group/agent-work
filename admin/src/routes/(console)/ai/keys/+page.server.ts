import { act, actor, getRuntime, requireAdmin, text } from '#lib/server/context.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = (event) => {
	requireAdmin(event);
	const { admin, vendors } = getRuntime();
	return {
		keys: admin.keys(),
		vendors: admin.vendorList().filter((v) => v.auth === 'key').map((v) => ({ id: v.id, name: v.name })),
		members: admin.members().filter((m) => m.status === 'active').map((m) => ({ name: m.name, displayName: m.displayName, githubLogin: m.githubLogin, githubId: m.githubId })),
		canSeal: vendors.canSeal
	};
};

export const actions: Actions = {
	add: async (event) => {
		const form = await event.request.formData();
		return act(() => {
			const key = getRuntime().admin.addKey(actor(event), {
				vendor: text(form, 'vendor'), label: text(form, 'label'), key: text(form, 'key'), mode: text(form, 'mode') || 'shared', member: text(form, 'member') || null
			});
			return { last4: key.last4 };
		});
	},
	status: async (event) => {
		const form = await event.request.formData();
		return act(() => ({ status: getRuntime().admin.setKeyStatus(actor(event), text(form, 'id'), text(form, 'status')).status }));
	},
	delete: async (event) => {
		const form = await event.request.formData();
		return act(() => { getRuntime().admin.deleteKey(actor(event), text(form, 'id')); return {}; });
	}
};
