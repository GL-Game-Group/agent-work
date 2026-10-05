import { act, actor, getRuntime, requireAdmin, text } from '#lib/server/context.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = (event) => {
	requireAdmin(event);
	const { admin } = getRuntime();
	return {
		members: admin.members(),
		vendors: admin.vendorList().map((v) => ({ id: v.id, name: v.name, auth: v.auth })),
		keys: admin.keys().map((k) => ({ id: k.id, label: k.label, last4: k.last4 })),
		accounts: admin.accounts().map((a) => ({ id: a.id, account: a.account }))
	};
};

export const actions: Actions = {
	add: async (event) => {
		const form = await event.request.formData();
		let vendors: unknown = [];
		try { vendors = JSON.parse(text(form, 'vendors') || '[]'); } catch { vendors = null; }
		return act(async () => {
			const member = await getRuntime().admin.addMember(actor(event), {
				name: text(form, 'name'), displayName: text(form, 'displayName'), github: text(form, 'github'),
				role: text(form, 'role') || 'member', team: text(form, 'team') || null, tunnels: form.get('tunnels') === 'on', vendors
			});
			return { name: member.name, displayName: member.displayName };
		});
	}
};
