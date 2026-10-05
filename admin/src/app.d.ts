// See https://svelte.dev/docs/kit/types#app.d.ts
import type { Member } from '@agent-work/gateway/db';

declare global {
	namespace App {
		interface Error {
			message: string;
		}
		interface Locals {
			/** The signed-in member (active, browser session), or null. */
			member: Member | null;
			/** The session credential's id, for signing out. */
			session: string | null;
			/** The client address, for the audit log. */
			ip: string | null;
		}
	}
}

export {};
