import { act, actor, getRuntime, requireAdmin, text } from '#lib/server/context.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = (event) => {
	requireAdmin(event);
	return getRuntime().admin.tunnels();
};

export const actions: Actions = {
	settings: async (event) => {
		const form = await event.request.formData();
		return act(() => {
			getRuntime().admin.setTunnelSettings(actor(event), {
				enabled: form.get('enabled') === 'on',
				allowPublic: form.get('allowPublic') === 'on',
				ssh: form.get('ssh') === 'on',
				publicTcp: form.get('publicTcp') === 'on',
				remote: form.get('remote') === 'on',
				perMember: text(form, 'perMember'),
				...form.has('portRange') ? { portRange: text(form, 'portRange') } : {}
			});
			return {};
		});
	},
	addDomain: async (event) => {
		const form = await event.request.formData();
		return act(() => ({ domain: getRuntime().admin.addTunnelDomain(actor(event), { name: text(form, 'name'), note: text(form, 'note') }).name }));
	},
	checkDomain: async (event) => {
		const form = await event.request.formData();
		actor(event);
		return act(async () => {
			const d = await getRuntime().admin.checkTunnelDomain(text(form, 'name'));
			return { name: d.name, dns: d.dns, cert: d.cert };
		});
	},
	defaultDomain: async (event) => {
		const form = await event.request.formData();
		return act(() => { getRuntime().admin.setDefaultTunnelDomain(actor(event), text(form, 'name')); return {}; });
	},
	deleteDomain: async (event) => {
		const form = await event.request.formData();
		return act(() => { getRuntime().admin.deleteTunnelDomain(actor(event), text(form, 'name')); return {}; });
	},
	close: async (event) => {
		const form = await event.request.formData();
		return act(() => ({ closed: getRuntime().admin.setTunnelClosed(actor(event), text(form, 'id'), form.get('closed') === 'true').closedBy !== null }));
	},
	delete: async (event) => {
		const form = await event.request.formData();
		return act(() => { getRuntime().admin.deleteTunnel(actor(event), text(form, 'id')); return {}; });
	}
};
