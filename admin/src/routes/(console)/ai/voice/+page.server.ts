import { act, actor, getRuntime, requireAdmin, text } from '#lib/server/context.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	requireAdmin(event);
	return getRuntime().admin.voice();
};

export const actions: Actions = {
	vendor: async (event) => {
		const form = await event.request.formData();
		const id = text(form, 'id');
		return act(async () => {
			await getRuntime().admin.setVoiceSettings(actor(event), {
				vendors: { [id]: { asr: form.get('asr') === 'on', asrModel: text(form, 'asrModel'), tts: form.get('tts') === 'on', ttsModel: text(form, 'ttsModel') } }
			});
			return {};
		});
	},
	tokens: async (event) => {
		const form = await event.request.formData();
		return act(async () => {
			await getRuntime().admin.setVoiceSettings(actor(event), { tokenTtlSeconds: text(form, 'tokenTtlSeconds'), tokensPerHour: text(form, 'tokensPerHour') });
			return {};
		});
	},
	refresh: async (event) => {
		const form = await event.request.formData();
		return act(async () => getRuntime().admin.refreshVoices(actor(event), text(form, 'vendor')));
	},
	voices: async (event) => {
		const form = await event.request.formData();
		let ids: unknown;
		try { ids = JSON.parse(text(form, 'ids')); } catch { ids = null; }
		return act(async () => ({ count: await getRuntime().admin.setEnabledVoices(actor(event), text(form, 'vendor'), ids) }));
	}
};
