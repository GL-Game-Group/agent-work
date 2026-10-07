import { error, fail, redirect, type RequestEvent } from '@sveltejs/kit';
import { getRuntime } from '@agent-work/gateway/runtime';
import { Refusal } from '@agent-work/gateway/errors';
import type { Member } from '@agent-work/gateway/db';
import type { Actor } from '@agent-work/gateway/services';

export { getRuntime };

/** Signed in, or off to the sign-in page (and back here afterwards). */
export function requireMember(event: Pick<RequestEvent, 'locals' | 'url'>): Member {
	const member = event.locals.member;
	if (!member) redirect(303, `/login?return_to=${encodeURIComponent(event.url.pathname + event.url.search)}`);
	return member;
}

/** An administrator; members go to their own page. */
export function requireAdmin(event: Pick<RequestEvent, 'locals' | 'url'>): Member {
	const member = requireMember(event);
	if (member.role !== 'admin') redirect(303, '/me');
	return member;
}

export function actor(event: Pick<RequestEvent, 'locals' | 'url'>, admin = true): Actor {
	return { member: admin ? requireAdmin(event) : requireMember(event), ip: event.locals.ip };
}

/** A refusal from the service becomes the form's error message; anything else is a server error. */
export async function act<T>(operation: () => T | Promise<T>): Promise<T | ReturnType<typeof fail<{ error: string }>>> {
	try {
		return await operation();
	} catch (cause) {
		if (Refusal.is(cause)) return fail(cause.status, { error: cause.message });
		throw cause;
	}
}

/** For loads: a refusal becomes the error page. */
export async function orError<T>(operation: () => T | Promise<T>): Promise<T> {
	try {
		return await operation();
	} catch (cause) {
		if (Refusal.is(cause)) error(cause.status, cause.message);
		throw cause;
	}
}

export function text(form: FormData, name: string): string {
	const value = form.get(name);
	return typeof value === 'string' ? value : '';
}
