import { act, actor, getRuntime, orError, requireMember, text } from '#lib/server/context.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const viewer = requireMember(event);
	const { self, store, config } = getRuntime();
	const subject = await orError(() => self.subject(viewer, event.url.searchParams.get('as')));
	const usage = (await store.memberVendorUsageSince(Date.now() - 30 * 86_400_000)).filter((u) => u.member === subject.name);
	return {
		viewer: { name: viewer.name, displayName: viewer.displayName, githubLogin: viewer.githubLogin, githubId: viewer.githubId, role: viewer.role },
		productName: config.productName ?? 'GL Work',
		profile: await self.profile(subject),
		devices: await self.devices(subject),
		config: await self.systemConfig(),
		tokens30d: usage.reduce((n, u) => n + u.tokens, 0),
		// Administrators preview others; the list only for them.
		members: viewer.role === 'admin' ? (await store.listMembers()).filter((m) => m.status === 'active').map((m) => ({ name: m.name, displayName: m.displayName })) : []
	};
};

export const actions: Actions = {
	issueKey: async (event) => {
		const form = await event.request.formData();
		return act(async () => ({ issued: await getRuntime().self.issueKey(actor(event, false), text(form, 'label')) }));
	},
	revoke: async (event) => {
		const form = await event.request.formData();
		return act(async () => { await getRuntime().self.revoke(actor(event, false), text(form, 'id')); return {}; });
	}
};
