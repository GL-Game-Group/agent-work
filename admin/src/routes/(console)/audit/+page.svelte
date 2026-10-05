<script lang="ts">
	import * as Card from '#lib/components/ui/card/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import PageHeader from '#lib/components/app/page-header.svelte';
	import Choice from '#lib/components/app/choice.svelte';
	import Search from '@lucide/svelte/icons/search';
	import { ACTION_LABEL, datetime } from '#lib/labels.js';

	let { data } = $props();
	const nameOf = (name: string | null) => (name === null ? null : (data.members.find((m) => m.name === name)?.displayName ?? name));
	let query = $state('');
	let actor = $state('all');
	const rows = $derived(data.entries.filter((e) => (actor === 'all' || e.actor === actor)
		&& `${ACTION_LABEL[e.action] ?? e.action} ${e.target ?? ''} ${e.detail ?? ''}`.toLowerCase().includes(query.toLowerCase())));
	const actors = $derived([...new Set(data.entries.map((e) => e.actor).filter((a) => a !== null))]);
</script>

<PageHeader title="审计" description="所有管理操作和登录事件，最近 500 条。Key、令牌和配置值不会写进日志。" />

<div class="flex flex-wrap items-center gap-2">
	<div class="relative w-64">
		<Search class="text-muted-foreground absolute top-2.5 left-2.5 size-4" />
		<Input bind:value={query} placeholder="搜索动作、对象、详情" class="pl-8" />
	</div>
	<Choice bind:value={actor} class="w-36" options={[{ value: 'all', label: '全部操作者' }, ...actors.map((a) => ({ value: a!, label: nameOf(a) ?? a! }))]} />
</div>

<Card.Root class="py-0">
	<Table.Root>
		<Table.Header><Table.Row><Table.Head class="pl-4">时间</Table.Head><Table.Head>操作者</Table.Head><Table.Head>动作</Table.Head><Table.Head>对象</Table.Head><Table.Head>详情</Table.Head><Table.Head>IP</Table.Head></Table.Row></Table.Header>
		<Table.Body>
			{#each rows as e, i (i)}
				<Table.Row>
					<Table.Cell class="text-muted-foreground pl-4 tabular-nums">{datetime(e.at)}</Table.Cell>
					<Table.Cell>{#if e.actor === null}<Badge variant="secondary">系统</Badge>{:else}{nameOf(e.actor)}{/if}</Table.Cell>
					<Table.Cell><Badge variant="outline">{ACTION_LABEL[e.action] ?? e.action}</Badge></Table.Cell>
					<Table.Cell class="max-w-48 truncate font-medium">{e.target ?? ''}</Table.Cell>
					<Table.Cell class="text-muted-foreground max-w-80 truncate" title={e.detail ?? ''}>{e.detail ?? ''}</Table.Cell>
					<Table.Cell class="text-muted-foreground font-mono text-xs">{e.ip ?? ''}</Table.Cell>
				</Table.Row>
			{:else}
				<Table.Row><Table.Cell colspan={6} class="text-muted-foreground py-8 text-center">没有记录</Table.Cell></Table.Row>
			{/each}
		</Table.Body>
	</Table.Root>
</Card.Root>
