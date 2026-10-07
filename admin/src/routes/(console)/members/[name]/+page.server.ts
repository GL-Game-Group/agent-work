import { error, redirect } from '@sveltejs/kit';
import { act, actor, getRuntime, requireAdmin, text } from '#lib/server/context.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	requireAdmin(event);
	const { admin } = getRuntime();
	const member = (await admin.members()).find((m) => m.name === event.params.name);
	if (!member) error(404, `没有成员 ${event.params.name}`);
	return {
		member,
		vendors: (await admin.vendorList()).map((v) => ({ id: v.id, name: v.name, auth: v.auth, models: v.models.length })),
		keys: await admin.keys(),
		accounts: await admin.accounts(),
		subscriptions: (await admin.subscriptions()).map((s) => ({ id: s.id, plan: s.plan })),
		devices: await admin.devices(member.name),
		usage: (await getRuntime().store.memberVendorUsageSince(Date.now() - 30 * 86_400_000)).filter((u) => u.member === member.name)
	};
};

export const actions: Actions = {
	profile: async (event) => {
		const form = await event.request.formData();
		return act(async () => { await getRuntime().admin.setProfile(actor(event), event.params.name, { displayName: text(form, 'displayName'), team: text(form, 'team') || null }); return {}; });
	},
	role: async (event) => {
		const form = await event.request.formData();
		return act(async () => ({ role: (await getRuntime().admin.setRole(actor(event), event.params.name, text(form, 'role'))).role }));
	},
	status: async (event) => {
		const form = await event.request.formData();
		return act(async () => ({ status: (await getRuntime().admin.setStatus(actor(event), event.params.name, text(form, 'status'))).status }));
	},
	delete: async (event) => {
		const result = await act(async () => { await getRuntime().admin.deleteMember(actor(event), event.params.name); return { deleted: true }; });
		if ('deleted' in result) redirect(303, '/members');
		return result;
	},
	assign: async (event) => {
		const form = await event.request.formData();
		const ref = text(form, 'ref');
		const mode = text(form, 'mode');
		return act(async () => {
			await getRuntime().admin.assign(actor(event), event.params.name, text(form, 'vendor'), {
				mode,
				// An empty choice means "assign automatically".
				...(mode === 'account' ? { cliAccount: ref || null } : { apiKey: ref || null })
			});
			return {};
		});
	},
	unassign: async (event) => {
		const form = await event.request.formData();
		return act(async () => { await getRuntime().admin.unassign(actor(event), event.params.name, text(form, 'vendor')); return {}; });
	},
	tunnels: async (event) => {
		const form = await event.request.formData();
		return act(async () => {
			const field = text(form, 'field');
			await getRuntime().admin.setTunnelGrants(actor(event), event.params.name, { [field === 'ssh' ? 'ssh' : 'tunnels']: text(form, 'on') === 'true' });
			return {};
		});
	},
	issueKey: async (event) => {
		const form = await event.request.formData();
		return act(async () => ({ issued: await getRuntime().admin.issueKey(actor(event), event.params.name, text(form, 'label')) }));
	},
	revoke: async (event) => {
		const form = await event.request.formData();
		return act(async () => { await getRuntime().admin.revokeDevice(actor(event), text(form, 'id')); return {}; });
	}
};
