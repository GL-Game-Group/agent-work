import type { Handle } from '@sveltejs/kit/hooks';
import { getRuntime } from '@agent-work/gateway/runtime';
import { clientAddress } from '@agent-work/gateway/server';

/**
 * Who is signed in: the browser session cookie the company service set at
 * GitHub sign-in. Foreign sites (sibling glgwork.com subdomains included) may
 * neither post to the console nor read its pages' data.
 */
export const handle: Handle = async ({ event, resolve }) => {
	const runtime = getRuntime();
	const { headers } = event.request;
	const edge = runtime.config.clientIpHeader === undefined ? null : headers.get(runtime.config.clientIpHeader);
	const ip = clientAddress(runtime.config, headers.get('x-forwarded-for') ?? undefined, event.getClientAddress(), edge);
	const token = event.cookies.get(runtime.sessionCookie);
	const signedIn = token ? runtime.store.authenticate(token, 'browser', ip) : undefined;
	event.locals.member = signedIn?.member ?? null;
	event.locals.session = signedIn?.credential.id ?? null;
	event.locals.ip = ip;

	// Writes come from this site's own pages only (sibling glgwork.com subdomains are foreign too).
	if (!['GET', 'HEAD', 'OPTIONS'].includes(event.request.method) && event.request.headers.get('origin') !== event.url.origin) {
		return new Response('cross_site', { status: 403 });
	}
	const site = event.request.headers.get('sec-fetch-site');
	if ((site === 'cross-site' || site === 'same-site') && event.request.headers.get('sec-fetch-mode') !== 'navigate') {
		return new Response('cross_site', { status: 403 });
	}
	const response = await resolve(event);
	response.headers.set('x-frame-options', 'DENY');
	response.headers.set('x-content-type-options', 'nosniff');
	// same-origin, not no-referrer: with no-referrer browsers send "Origin: null" on plain form posts (sign-out), which the check above refuses.
	response.headers.set('referrer-policy', 'same-origin');
	if (event.locals.member) response.headers.set('cache-control', 'no-store');
	return response;
};
