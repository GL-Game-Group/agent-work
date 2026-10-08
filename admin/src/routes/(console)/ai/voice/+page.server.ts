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
				vendors: {
					[id]: {
						asr: form.get('asr') === 'on', asrModel: text(form, 'asrModel'),
						asrFile: form.get('asrFile') === 'on', asrFileModel: text(form, 'asrFileModel'),
						ttsStream: form.get('ttsStream') === 'on', ttsStreamModel: text(form, 'ttsStreamModel'),
						tts: form.get('tts') === 'on', ttsModel: text(form, 'ttsModel')
					}
				}
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
	voice: async (event) => {
		const form = await event.request.formData();
		return act(async () => ({ state: (await getRuntime().admin.setVoiceState(actor(event), text(form, 'vendor'), text(form, 'id'), text(form, 'state'))).state }));
	}
};
