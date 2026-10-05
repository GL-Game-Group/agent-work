<script lang="ts">
	import type { Component, Snippet } from 'svelte';
	import * as Card from '#lib/components/ui/card/index.js';

	let { label, value, hint, icon: Icon, children }: { label: string; value: string; hint?: string; icon?: Component; children?: Snippet } = $props();
</script>

<Card.Root class="gap-2 py-4">
	<Card.Header class="flex flex-row items-center justify-between px-4">
		<Card.Description>{label}</Card.Description>
		{#if Icon}<Icon class="text-muted-foreground size-4" />{/if}
	</Card.Header>
	<Card.Content class="px-4">
		<div class="text-2xl font-semibold tabular-nums">{value}</div>
		{#if hint}<p class="text-muted-foreground mt-1 text-xs">{hint}</p>{/if}
		{@render children?.()}
	</Card.Content>
</Card.Root>
