<script lang="ts">
	import * as Avatar from '#lib/components/ui/avatar/index.js';

	let { name, displayName, githubLogin, githubId, link = true, sub = true }: {
		name: string; displayName?: string; githubLogin?: string; githubId?: number; link?: boolean; sub?: boolean;
	} = $props();
</script>

<svelte:element this={link ? 'a' : 'span'} href={link ? `/members/${name}` : undefined} class="group inline-flex items-center gap-2">
	<Avatar.Root class="size-7">
		{#if githubId}<Avatar.Image src="https://avatars.githubusercontent.com/u/{githubId}?s=56" alt="" />{/if}
		<Avatar.Fallback class="bg-primary/10 text-primary text-xs">{(displayName ?? name).slice(0, 1)}</Avatar.Fallback>
	</Avatar.Root>
	<span class="grid leading-tight">
		<span class="font-medium {link ? 'group-hover:underline' : ''}">{displayName ?? name}</span>
		{#if sub && githubLogin}<span class="text-muted-foreground text-xs">{name} · @{githubLogin}</span>{/if}
	</span>
</svelte:element>
