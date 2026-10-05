import { act, actor, getRuntime, orError, requireMember, text } from '#lib/server/context.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = (event) => {
	const viewer = requireMember(event);
	const { self, store, config } = getRuntime();
	const subject = orError(() => self.subject(viewer, event.url.searchParams.get('as')));
	const usage = store.memberVendorUsageSince(Date.now() - 30 * 86_400_000).filter((u) => u.member === subject.name);
	return {
		viewer: { name: viewer.name, displayName: viewer.displayName, githubLogin: viewer.githubLogin, githubId: viewer.githubId, role: viewer.role },
		productName: config.productName ?? 'GL Work',
		profile: self.profile(subject),
		devices: self.devices(subject),
		config: self.systemConfig(),
		tokens30d: usage.reduce((n, u) => n + u.tokens, 0),
		// Administrators preview others; the list only for them.
		members: viewer.role === 'admin' ? store.listMembers().filter((m) => m.status === 'active').map((m) => ({ name: m.name, displayName: m.displayName })) : []
	};
};

export const actions: Actions = {
	issueKey: async (event) => {
		const form = await event.request.formData();
		return act(() => ({ issued: getRuntime().self.issueKey(actor(event, false), text(form, 'label')) }));
	},
	revoke: async (event) => {
		const form = await event.request.formData();
		return act(() => { getRuntime().self.revoke(actor(event, false), text(form, 'id')); return {}; });
	}
};
