import { error } from '@sveltejs/kit';
import { Refusal } from '@agent-work/gateway/errors';
import { getRuntime, requireAdmin } from '#lib/server/context.js';
import type { RequestHandler } from './$types';

/** 试听: a voice's sample, from this origin (the console's CSP allows media from itself only). */
export const GET: RequestHandler = async (event) => {
	requireAdmin(event);
	const vendor = event.url.searchParams.get('vendor') ?? '';
	const voice = event.url.searchParams.get('voice') ?? '';
	try {
		const sample = await getRuntime().admin.voiceSample(vendor, voice);
		return new Response(sample.body as BodyInit, { headers: { 'content-type': sample.contentType, 'cache-control': 'private, max-age=86400' } });
	} catch (cause) {
		if (Refusal.is(cause)) error(cause.status, cause.message);
		throw cause;
	}
};
