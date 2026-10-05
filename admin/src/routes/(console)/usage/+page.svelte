<script lang="ts">
	import { goto } from '$app/navigation';
	import * as Card from '#lib/components/ui/card/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import { Progress } from '#lib/components/ui/progress/index.js';
	import PageHeader from '#lib/components/app/page-header.svelte';
	import Choice from '#lib/components/app/choice.svelte';
	import UsageChart from '#lib/components/app/usage-chart.svelte';
	import MemberCell from '#lib/components/app/member-cell.svelte';
	import VendorTag from '#lib/components/app/vendor-tag.svelte';
	import { num, tokens } from '#lib/labels.js';

	let { data } = $props();
	const names = $derived(Object.fromEntries(data.vendors.map((v) => [v.id, v.name])));
	const member = (name: string) => data.members.find((m) => m.name === name);
	const rows = $derived(data.usage.members.map((u) => ({ ...u, total: u.inputTokens + u.outputTokens })).filter((u) => u.requests > 0).sort((a, b) => b.total - a.total));
	const top = $derived(Math.max(1, ...rows.map((r) => r.total)));
	const keys = $derived([...data.usage.keys].filter((k) => k.requests > 0).sort((a, b) => b.tokens - a.tokens));
</script>

<PageHeader title="用量" description="经公司网关的 API 调用，按成员、厂商和 Key 统计。订阅账号在厂商那边计量，不在这里。">
	{#snippet actions()}
		<Choice class="w-32" options={[{ value: '1', label: '今天' }, { value: '7', label: '近 7 天' }, { value: '30', label: '近 30 天' }, { value: '90', label: '近 90 天' }]}
			bind:value={() => String(data.usage.days), (days) => goto(`?days=${days}`, { replace: true })} />
	{/snippet}
</PageHeader>

<Card.Root>
	<Card.Header><Card.Title>每日 token</Card.Title></Card.Header>
	<Card.Content><UsageChart daily={data.usage.daily} {names} days={Math.max(data.usage.days, 7)} /></Card.Content>
</Card.Root>

<div class="grid gap-4 lg:grid-cols-2">
	<Card.Root class="gap-0 py-0">
		<Card.Header class="border-b py-4"><Card.Title>按成员</Card.Title></Card.Header>
		<Table.Root>
			<Table.Body>
				{#each rows as u (u.member)}
					{@const m = member(u.member)}
					<Table.Row>
						<Table.Cell class="pl-4"><MemberCell name={u.member} displayName={m?.displayName} githubId={m?.githubId} sub={false} /></Table.Cell>
						<Table.Cell class="w-1/2">
							<Progress value={(u.total / top) * 100} class="h-2" />
							<div class="text-muted-foreground mt-1 flex flex-wrap gap-3 text-xs">
								{#each data.usage.byVendor.filter((b) => b.member === u.member) as b (b.vendor)}<span><VendorTag id={b.vendor} name={names[b.vendor] ?? b.vendor} muted /> {tokens(b.tokens)}</span>{/each}
							</div>
						</Table.Cell>
						<Table.Cell class="pr-4 text-right tabular-nums">{tokens(u.total)}<div class="text-muted-foreground text-xs">{num(u.requests)} 次</div></Table.Cell>
					</Table.Row>
				{:else}
					<Table.Row><Table.Cell class="text-muted-foreground py-8 text-center">这段时间没有调用</Table.Cell></Table.Row>
				{/each}
			</Table.Body>
		</Table.Root>
	</Card.Root>

	<Card.Root class="gap-0 py-0">
		<Card.Header class="border-b py-4"><Card.Title>按 Key</Card.Title></Card.Header>
		<Table.Root>
			<Table.Header><Table.Row><Table.Head class="pl-4">Key</Table.Head><Table.Head class="text-right">调用</Table.Head><Table.Head class="text-right">tokens</Table.Head><Table.Head class="pr-4 text-right">缓存命中</Table.Head></Table.Row></Table.Header>
			<Table.Body>
				{#each keys as k (k.id)}
					<Table.Row>
						<Table.Cell class="pl-4"><VendorTag id={k.vendor} name={names[k.vendor] ?? k.vendor} /> <span class="text-muted-foreground text-xs">{k.label} …{k.last4}</span></Table.Cell>
						<Table.Cell class="text-right tabular-nums">{num(k.requests)}</Table.Cell>
						<Table.Cell class="text-right tabular-nums">{tokens(k.tokens)}</Table.Cell>
						<Table.Cell class="pr-4 text-right tabular-nums">{k.inputTokens + k.cacheReadTokens > 0 ? `${Math.round((k.cacheReadTokens / (k.inputTokens + k.cacheReadTokens)) * 100)}%` : '—'}</Table.Cell>
					</Table.Row>
				{:else}
					<Table.Row><Table.Cell colspan={4} class="text-muted-foreground py-8 text-center">这段时间没有调用</Table.Cell></Table.Row>
				{/each}
			</Table.Body>
		</Table.Root>
	</Card.Root>
</div>
