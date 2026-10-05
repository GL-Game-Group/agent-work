<script lang="ts">
	let { online, label }: { online: boolean; label?: string } = $props();
</script>

<span class="inline-flex items-center gap-1.5 whitespace-nowrap">
	<span class="relative flex size-2">
		{#if online}<span class="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500 opacity-60"></span>{/if}
		<span class="relative inline-flex size-2 rounded-full {online ? 'bg-emerald-500' : 'bg-muted-foreground/40'}"></span>
	</span>
	{label ?? (online ? '在线' : '离线')}
</span>
