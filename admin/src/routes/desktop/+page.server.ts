import { requireMember } from '#lib/server/context.js';
import type { PageServerLoad } from './$types';

/** A prototype of the desktop's tunnel panel; signed-in members only. */
export const load: PageServerLoad = (event) => {
	requireMember(event);
	return {};
};
