import { act, actor, getRuntime, requireAdmin, text } from '#lib/server/context.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	requireAdmin(event);
	const { admin } = getRuntime();
	const members = new Map((await admin.members()).map((m) => [m.name, m]));
	return {
		...(await admin.plugins()),
		desktops: (await admin.devices()).filter((d) => d.kind === 'device').map((d) => ({
			id: d.id, label: d.label, lastUsedAt: d.lastUsedAt, member: d.member,
			displayName: members.get(d.member)?.displayName ?? d.member, githubId: members.get(d.member)?.githubId
		}))
	};
};

const meta = (form: FormData) => ({
	displayName: text(form, 'displayName'),
	permissions: text(form, 'permissions'),
	preinstalled: form.get('preinstalled') === 'on'
});

export const actions: Actions = {
	inspect: async (event) => {
		const form = await event.request.formData();
		return act(async () => ({ preview: await getRuntime().admin.inspectPlugin(text(form, 'url')) }));
	},
	register: async (event) => {
		const form = await event.request.formData();
		return act(async () => ({
			plugin: (await getRuntime().admin.registerPlugin(actor(event), { url: text(form, 'url'), ...meta(form), publish: form.get('publish') === 'on' })).displayName
		}));
	},
	update: async (event) => {
		const form = await event.request.formData();
		return act(async () => ({ version: (await getRuntime().admin.updatePlugin(actor(event), text(form, 'name'), text(form, 'url'))).version }));
	},
	describe: async (event) => {
		const form = await event.request.formData();
		return act(async () => { await getRuntime().admin.describePlugin(actor(event), text(form, 'name'), meta(form)); return {}; });
	},
	status: async (event) => {
		const form = await event.request.formData();
		return act(async () => ({ status: (await getRuntime().admin.setPluginStatus(actor(event), text(form, 'name'), text(form, 'status'))).status }));
	},
	delete: async (event) => {
		const form = await event.request.formData();
		return act(async () => { await getRuntime().admin.deletePlugin(actor(event), text(form, 'name')); return {}; });
	}
};
