<script lang="ts">
	import * as Tooltip from '#lib/components/ui/tooltip/index.js';
	import { tokens, vendorColor } from '#lib/labels.js';

	let { daily, names, days = 14 }: {
		daily: { day: string; vendor: string; tokens: number }[];
		names: Record<string, string>;
		days?: number;
	} = $props();

	/** Every day of the window, oldest first, including days without calls. */
	const columns = $derived.by(() => {
		const out: { day: string; label: string; parts: { vendor: string; tokens: number }[]; total: number }[] = [];
		for (let i = days - 1; i >= 0; i -= 1) {
			const d = new Date(Date.now() - i * 86_400_000);
			const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
			const parts = daily.filter((row) => row.day === day).map(({ vendor, tokens }) => ({ vendor, tokens }));
			out.push({ day, label: `${d.getMonth() + 1}/${d.getDate()}`, parts, total: parts.reduce((n, p) => n + p.tokens, 0) });
		}
		return out;
	});
	const max = $derived(Math.max(1, ...columns.map((c) => c.total)));
	const vendors = $derived([...new Set(daily.map((row) => row.vendor))]);
</script>

<div class="space-y-3">
	<div class="flex h-48 items-end gap-1.5">
		{#each columns as column (column.day)}
			<Tooltip.Root>
				<Tooltip.Trigger class="flex h-full flex-1 flex-col justify-end">
					<div class="bg-muted flex w-full flex-col-reverse overflow-hidden rounded-t-sm" style="height: {Math.max((column.total / max) * 100, column.total ? 2 : 1)}%">
						{#each column.parts as part (part.vendor)}
							<div style="height: {(part.tokens / column.total) * 100}%; background: {vendorColor(part.vendor)}"></div>
						{/each}
					</div>
				</Tooltip.Trigger>
				<Tooltip.Content>
					<div class="space-y-0.5 text-xs">
						<div class="font-medium">{column.label} · {tokens(column.total)} tokens</div>
						{#each column.parts as part (part.vendor)}<div>{names[part.vendor] ?? part.vendor}：{tokens(part.tokens)}</div>{/each}
					</div>
				</Tooltip.Content>
			</Tooltip.Root>
		{/each}
	</div>
	{#if days <= 31}
		<div class="text-muted-foreground flex gap-1.5 text-[11px]">
			{#each columns as column (column.day)}<div class="flex-1 overflow-hidden text-center">{days <= 14 || column.label.endsWith('/1') ? column.label : ''}</div>{/each}
		</div>
	{/if}
	<div class="flex flex-wrap gap-4 text-xs">
		{#each vendors as vendor (vendor)}
			<span class="inline-flex items-center gap-1.5"><span class="size-2 rounded-sm" style="background: {vendorColor(vendor)}"></span>{names[vendor] ?? vendor}</span>
		{:else}
			<span class="text-muted-foreground">这段时间没有经公司网关的调用</span>
		{/each}
	</div>
</div>
