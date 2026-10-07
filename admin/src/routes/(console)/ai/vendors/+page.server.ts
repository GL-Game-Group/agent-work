import { act, actor, getRuntime, requireAdmin, text } from '#lib/server/context.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	requireAdmin(event);
	const { admin } = getRuntime();
	return { vendors: await admin.vendorList(), subscriptions: await admin.subscriptions() };
};

function vendorInput(form: FormData) {
	return {
		id: text(form, 'id'), name: text(form, 'name'), type: text(form, 'type'), auth: text(form, 'auth'),
		protocol: text(form, 'protocol') || undefined, baseUrl: text(form, 'baseUrl') || undefined,
		modelsUrl: text(form, 'modelsUrl') || null, compat: text(form, 'compat') || null
	};
}

export const actions: Actions = {
	add: async (event) => {
		const form = await event.request.formData();
		return act(async () => ({ vendor: (await getRuntime().admin.addVendor(actor(event), vendorInput(form))).name }));
	},
	update: async (event) => {
		const form = await event.request.formData();
		return act(async () => { await getRuntime().admin.updateVendor(actor(event), text(form, 'id'), vendorInput(form)); return {}; });
	},
	delete: async (event) => {
		const form = await event.request.formData();
		return act(async () => { await getRuntime().admin.deleteVendor(actor(event), text(form, 'id')); return {}; });
	},
	catalog: async (event) => {
		const form = await event.request.formData();
		return act(async () => ({ listed: (await getRuntime().admin.refreshCatalog(actor(event), text(form, 'id'))).catalog.length }));
	},
	models: async (event) => {
		const form = await event.request.formData();
		let models: unknown;
		try { models = JSON.parse(text(form, 'models')); } catch { models = null; }
		return act(async () => ({ count: (await getRuntime().admin.setModels(actor(event), text(form, 'id'), models)).models.length }));
	}
};
