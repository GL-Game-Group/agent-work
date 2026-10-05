<script lang="ts">
	import { enhance } from '$app/forms';
	import * as Card from '#lib/components/ui/card/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import PageHeader from '#lib/components/app/page-header.svelte';
	import Choice from '#lib/components/app/choice.svelte';
	import MemberCell from '#lib/components/app/member-cell.svelte';
	import KindIcon from '#lib/components/app/kind-icon.svelte';
	import { toastForm } from '#lib/form.js';
	import { KIND_LABEL, date, recentlyActive, relative } from '#lib/labels.js';

	let { data } = $props();
	const member = (name: string) => data.members.find((m) => m.name === name);
	let kind = $state('all');
	let who = $state('all');
	let activeOnly = $state('all');
	const rows = $derived(data.devices
		.filter((d) => (kind === 'all' || d.kind === kind) && (who === 'all' || d.member === who) && (activeOnly === 'all' || recentlyActive(d.lastUsedAt)))
		.sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0)));
	const kinds = Object.keys(KIND_LABEL);
</script>

<PageHeader title="设备" description="连接公司服务的每一个客户端：GL Work 桌面端、手机上的 GL Work、浏览器会话、内部 Key。每个连接都归属到一个成员，停用成员时全部失效。" />

<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
	{#each kinds as k (k)}
		{@const list = data.devices.filter((d) => d.kind === k)}
		<button class="text-left" onclick={() => (kind = kind === k ? 'all' : k)}>
			<Card.Root class="gap-1 py-4 transition-colors {kind === k ? 'border-primary' : ''}">
				<Card.Content class="flex items-center gap-3 px-4">
					<div class="bg-muted rounded-md p-2"><KindIcon kind={k} /></div>
					<div>
						<div class="text-muted-foreground text-sm">{KIND_LABEL[k]}</div>
						<div class="text-xl font-semibold">{list.length}<span class="text-muted-foreground text-sm font-normal"> · {list.filter((d) => recentlyActive(d.lastUsedAt)).length} 活跃</span></div>
					</div>
				</Card.Content>
			</Card.Root>
		</button>
	{/each}
</div>

<div class="flex flex-wrap items-center gap-2">
	<Choice bind:value={kind} class="w-36" options={[{ value: 'all', label: '全部类型' }, ...kinds.map((k) => ({ value: k, label: KIND_LABEL[k]! }))]} />
	<Choice bind:value={who} class="w-36" options={[{ value: 'all', label: '全部成员' }, ...data.members.map((m) => ({ value: m.name, label: m.displayName }))]} />
	<Choice bind:value={activeOnly} class="w-36" options={[{ value: 'all', label: '全部状态' }, { value: 'active', label: '最近 10 分钟活跃' }]} />
	<span class="text-muted-foreground ml-auto text-sm">{rows.length} 个连接</span>
</div>

<Card.Root class="py-0">
	<Table.Root>
		<Table.Header>
			<Table.Row>
				<Table.Head class="pl-4">设备</Table.Head>
				<Table.Head>成员</Table.Head>
				<Table.Head>类型</Table.Head>
				<Table.Head>最近活动</Table.Head>
				<Table.Head>IP</Table.Head>
				<Table.Head>首次连接</Table.Head>
				<Table.Head>到期</Table.Head>
				<Table.Head class="w-20"></Table.Head>
			</Table.Row>
		</Table.Header>
		<Table.Body>
			{#each rows as d (d.id)}
				{@const m = member(d.member)}
				<Table.Row>
					<Table.Cell class="pl-4">
						<div class="flex items-center gap-2">
							<KindIcon kind={d.kind} class="text-muted-foreground size-4" />
							<span class="max-w-72 truncate font-medium" title={d.label}>{d.label}</span>
							{#if recentlyActive(d.lastUsedAt)}<Badge variant="outline" class="border-emerald-500/40 text-emerald-600">活跃</Badge>{/if}
						</div>
					</Table.Cell>
					<Table.Cell><MemberCell name={d.member} displayName={m?.displayName} githubId={m?.githubId} sub={false} /></Table.Cell>
					<Table.Cell><Badge variant="secondary">{KIND_LABEL[d.kind]}</Badge></Table.Cell>
					<Table.Cell>{relative(d.lastUsedAt)}</Table.Cell>
					<Table.Cell class="text-muted-foreground font-mono text-xs">{d.lastIp ?? '—'}</Table.Cell>
					<Table.Cell class="text-muted-foreground">{date(d.createdAt)}</Table.Cell>
					<Table.Cell class="text-muted-foreground">{date(d.expiresAt)}</Table.Cell>
					<Table.Cell>
						<form method="POST" action="?/revoke" use:enhance={toastForm('已吊销')} onsubmit={(e) => { if (!confirm(`吊销 ${d.label}？它会立即断开。`)) e.preventDefault(); }}>
							<input type="hidden" name="id" value={d.id} />
							<Button type="submit" variant="ghost" size="sm" class="text-destructive">吊销</Button>
						</form>
					</Table.Cell>
				</Table.Row>
			{:else}
				<Table.Row><Table.Cell colspan={8} class="text-muted-foreground py-8 text-center">没有连接</Table.Cell></Table.Row>
			{/each}
		</Table.Body>
	</Table.Root>
</Card.Root>
