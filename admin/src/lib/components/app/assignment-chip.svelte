<script lang="ts">
	import * as Tooltip from '#lib/components/ui/tooltip/index.js';
	import { MODE_LABEL, MODE_SHORT, vendorColor } from '#lib/labels.js';

	let { vendor, name, mode, held }: { vendor: string; name: string; mode: string; held: string | null } = $props();
</script>

<Tooltip.Root>
	<Tooltip.Trigger>
		<span class="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs whitespace-nowrap {held ? 'bg-muted/50' : 'border-amber-500/50 text-amber-600'}">
			<span class="size-1.5 rounded-full" style="background: {vendorColor(vendor)}"></span>
			{name}
			<span class="text-muted-foreground">{held ? MODE_SHORT[mode] : '待分配'}</span>
		</span>
	</Tooltip.Trigger>
	<Tooltip.Content>{MODE_LABEL[mode]}：{held ?? '还没有可分配的，录入后自动补上'}</Tooltip.Content>
</Tooltip.Root>
