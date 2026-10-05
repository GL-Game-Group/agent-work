<script lang="ts">
	import type { Snippet } from 'svelte';
	import { Label } from '#lib/components/ui/label/index.js';

	let { label, hint, id, children, class: className = '' }: { label: string; hint?: string; id?: string; children: Snippet; class?: string } = $props();
</script>

<div class="grid gap-2 {className}">
	<Label for={id}>{label}</Label>
	{@render children()}
	{#if hint}<p class="text-muted-foreground text-xs">{hint}</p>{/if}
</div>
