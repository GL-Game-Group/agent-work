import { act, actor, getRuntime, requireAdmin, text } from '#lib/server/context.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = (event) => {
	requireAdmin(event);
	const { admin } = getRuntime();
	return {
		subscriptions: admin.subscriptions(),
		accounts: admin.accounts(),
		vendors: admin.vendorList().filter((v) => v.auth === 'account').map((v) => ({ id: v.id, name: v.name, waiting: v.waiting })),
		members: admin.members().map((m) => ({ name: m.name, displayName: m.displayName, githubId: m.githubId, role: m.role, status: m.status }))
	};
};

function subscriptionInput(form: FormData) {
	const renews = text(form, 'renewsAt');
	return {
		vendor: text(form, 'vendor'), plan: text(form, 'plan'), seats: Number(text(form, 'seats')), price: text(form, 'price') || null,
		cycle: text(form, 'cycle') || 'monthly', renewsAt: renews ? new Date(`${renews}T00:00:00`).getTime() : null,
		owner: text(form, 'owner') || null, note: text(form, 'note') || null
	};
}

export const actions: Actions = {
	addSubscription: async (event) => {
		const form = await event.request.formData();
		return act(() => ({ plan: getRuntime().admin.addSubscription(actor(event), subscriptionInput(form)).plan }));
	},
	updateSubscription: async (event) => {
		const form = await event.request.formData();
		return act(() => { getRuntime().admin.updateSubscription(actor(event), text(form, 'id'), subscriptionInput(form)); return {}; });
	},
	deleteSubscription: async (event) => {
		const form = await event.request.formData();
		return act(() => { getRuntime().admin.deleteSubscription(actor(event), text(form, 'id')); return {}; });
	},
	addAccount: async (event) => {
		const form = await event.request.formData();
		return act(() => {
			const runtime = getRuntime();
			const account = runtime.admin.addAccount(actor(event), { subscription: text(form, 'subscription'), account: text(form, 'account'), note: text(form, 'note') || null, member: text(form, 'member') || null });
			return { member: runtime.admin.accounts().find((a) => a.id === account.id)?.member ?? null };
		});
	},
	release: async (event) => {
		const form = await event.request.formData();
		return act(() => ({ from: getRuntime().admin.releaseAccount(actor(event), text(form, 'id')) }));
	},
	deleteAccount: async (event) => {
		const form = await event.request.formData();
		return act(() => { getRuntime().admin.deleteAccount(actor(event), text(form, 'id')); return {}; });
	}
};
