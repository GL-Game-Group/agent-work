<script lang="ts">
	import { Button } from '#lib/components/ui/button/index.js';
	import Copy from '@lucide/svelte/icons/copy';
	import Check from '@lucide/svelte/icons/check';

	let { value, multiline = false }: { value: string; multiline?: boolean } = $props();
	let copied = $state(false);

	async function copy() {
		await navigator.clipboard?.writeText(value).catch(() => undefined);
		copied = true;
		setTimeout(() => (copied = false), 1500);
	}
</script>

<div class="bg-muted flex min-w-0 items-start gap-1 rounded-md border">
	<pre class="min-w-0 flex-1 overflow-x-auto p-3 font-mono text-xs leading-relaxed {multiline ? 'whitespace-pre' : 'whitespace-nowrap'}">{value}</pre>
	<Button variant="ghost" size="icon-sm" class="m-1.5 shrink-0" onclick={copy} aria-label="复制">
		{#if copied}<Check />{:else}<Copy />{/if}
	</Button>
</div>
