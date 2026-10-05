<script lang="ts">
	import { vendorColor } from '#lib/labels.js';

	let { id, name, muted = false }: { id: string; name: string; muted?: boolean } = $props();
</script>

<span class="inline-flex items-center gap-1.5 whitespace-nowrap {muted ? 'text-muted-foreground' : ''}">
	<span class="size-2 shrink-0 rounded-full" style="background: {vendorColor(id)}"></span>
	{name}
</span>
