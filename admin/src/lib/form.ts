import type { ActionResult, SubmitFunction } from '$app/forms';
import { toast } from 'svelte-sonner';

type Data = Record<string, unknown> | undefined;
type Success = string | ((data: Data) => string);

/** What to do with an action's result: a toast on success (when given) or with the refusal's message, then reload the page's data. */
export function toastResult(success?: Success, after?: (data: Data) => void) {
	return async ({ result, update }: { result: ActionResult; update: (options?: { reset?: boolean; invalidateAll?: boolean }) => Promise<void> }) => {
		if (result.type === 'failure') {
			toast.error(String((result.data as { error?: unknown } | undefined)?.error ?? '操作失败'));
			return;
		}
		if (result.type === 'error') {
			toast.error((result.error as { message?: string } | undefined)?.message ?? '服务器内部错误');
			return;
		}
		if (result.type === 'success') {
			const data = result.data as Data;
			const message = typeof success === 'function' ? success(data) : success;
			if (message) toast.success(message);
			after?.(data);
		}
		await update({ reset: false });
	};
}

/** Progressive form enhancement with feedback. */
export function toastForm(success?: Success, after?: (data: Data) => void): SubmitFunction {
	return () => toastResult(success, after);
}
