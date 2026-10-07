import { redirect } from '@sveltejs/kit';
import { getRuntime } from '#lib/server/context.js';
import type { RequestHandler } from './$types';

/** Sign out: revoke this browser's session. A form post, so SvelteKit checks its origin. */
export const POST: RequestHandler = async ({ locals, cookies }) => {
	const runtime = getRuntime();
	if (locals.session && locals.member) {
		await runtime.store.revokeCredential(locals.session);
		await runtime.store.audit({ actor: locals.member.name, action: 'logout', target: locals.session, detail: null, ip: locals.ip });
	}
	cookies.delete(runtime.sessionCookie, { path: '/' });
	redirect(303, '/login');
};
