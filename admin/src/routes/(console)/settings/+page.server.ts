import { act, actor, getRuntime, requireAdmin, text } from '#lib/server/context.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = (event) => {
	requireAdmin(event);
	const { admin, config } = getRuntime();
	return { ...admin.systemConfig(), origin: config.publicOrigin };
};

export const actions: Actions = {
	save: async (event) => {
		const form = await event.request.formData();
		const value = text(form, 'value');
		return act(() => ({
			key: getRuntime().admin.setConfig(actor(event), {
				key: text(form, 'key'), secret: form.get('secret') === 'on', note: text(form, 'note') || null, group: text(form, 'group') || null,
				// Left empty while editing a secret entry: keep its value.
				value: value === '' && form.get('editing') === 'true' ? undefined : value
			}).key
		}));
	},
	delete: async (event) => {
		const form = await event.request.formData();
		return act(() => { getRuntime().admin.deleteConfig(actor(event), text(form, 'key')); return {}; });
	}
};
