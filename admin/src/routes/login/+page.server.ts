import { redirect } from '@sveltejs/kit';
import { getRuntime } from '#lib/server/context.js';
import type { PageServerLoad } from './$types';

/** Only same-site paths, and never back into sign-in. */
function safeReturn(value: string | null): string | null {
	if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\') || value.startsWith('/login')) return null;
	return value;
}

export const load: PageServerLoad = ({ locals, url }) => {
	const returnTo = safeReturn(url.searchParams.get('return_to'));
	if (locals.member) redirect(303, locals.member.role === 'admin' ? (returnTo ?? '/') : '/me');
	const config = getRuntime().config;
	return {
		productName: config.productName ?? 'GL Work',
		org: config.github.org || null,
		error: url.searchParams.get('error'),
		login: url.searchParams.get('login'),
		// The company service signs the browser in, then sends it to return_to.
		start: `/agent-work/auth/github/start?return_to=${encodeURIComponent(returnTo ?? '/')}`
	};
};
