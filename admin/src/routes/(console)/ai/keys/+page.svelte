<script lang="ts">
	import { enhance } from '$app/forms';
	import * as Table from '#lib/components/ui/table/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import PageHeader from '#lib/components/app/page-header.svelte';
	import Field from '#lib/components/app/field.svelte';
	import Choice from '#lib/components/app/choice.svelte';
	import VendorTag from '#lib/components/app/vendor-tag.svelte';
	import MemberCell from '#lib/components/app/member-cell.svelte';
	import Plus from '@lucide/svelte/icons/plus';
	import ShieldCheck from '@lucide/svelte/icons/shield-check';
	import ShieldAlert from '@lucide/svelte/icons/shield-alert';
	import { toastForm } from '#lib/form.js';
	import { date, num, tokens } from '#lib/labels.js';

	let { data } = $props();
	const names = $derived(Object.fromEntries(data.vendors.map((v) => [v.id, v.name])));
	const member = (name: string) => data.members.find((m) => m.name === name);

	let vendorFilter = $state('all');
	const rows = $derived(data.keys.filter((k) => vendorFilter === 'all' || k.vendor === vendorFilter));

	let open = $state(false);
	let form = $state({ vendor: 'deepseek', mode: 'shared', member: '' });
</script>

<PageHeader title="API Key" description="厂商的 API Key 加密保存在服务端，不会下发到成员电脑。成员的桌面端和内部 Key 都经公司网关使用分配给自己的 Key。">
	{#snippet actions()}<Button onclick={() => (open = true)} disabled={!data.canSeal || data.vendors.length === 0}><Plus />录入 Key</Button>{/snippet}
</PageHeader>

{#if !data.canSeal}
	<Alert.Root variant="destructive">
		<ShieldAlert />
		<Alert.Title>无法保存 Key</Alert.Title>
		<Alert.Description>服务端没有设置 AGENT_WORK_SECRET_KEY。用 openssl rand -base64 32 生成一个，写进服务端环境后重启。</Alert.Description>
	</Alert.Root>
{/if}

<div class="grid gap-4 sm:grid-cols-3">
	<Card.Root class="gap-1 py-4"><Card.Content class="px-4"><div class="text-muted-foreground text-sm">共享 Key</div><div class="text-2xl font-semibold">{data.keys.filter((k) => k.mode === 'shared').length}</div><div class="text-muted-foreground text-xs">多名成员共用，按使用人数自动均衡</div></Card.Content></Card.Root>
	<Card.Root class="gap-1 py-4"><Card.Content class="px-4"><div class="text-muted-foreground text-sm">独立 Key</div><div class="text-2xl font-semibold">{data.keys.filter((k) => k.mode === 'dedicated').length}</div><div class="text-muted-foreground text-xs">只给一个人用，方便单独核算</div></Card.Content></Card.Root>
	<Card.Root class="gap-1 py-4"><Card.Content class="px-4"><div class="text-muted-foreground text-sm">近 30 天调用</div><div class="text-2xl font-semibold">{num(data.keys.reduce((n, k) => n + k.requests30d, 0))}</div><div class="text-muted-foreground text-xs">{tokens(data.keys.reduce((n, k) => n + k.tokens30d, 0))} tokens</div></Card.Content></Card.Root>
</div>

<div class="flex items-center gap-2">
	<Choice bind:value={vendorFilter} class="w-40" options={[{ value: 'all', label: '全部厂商' }, ...data.vendors.map((v) => ({ value: v.id, label: v.name }))]} />
	<span class="text-muted-foreground text-sm">{rows.length} 个 Key</span>
</div>

<Card.Root class="py-0">
	<Table.Root>
		<Table.Header>
			<Table.Row>
				<Table.Head class="pl-4">厂商</Table.Head>
				<Table.Head>名称</Table.Head>
				<Table.Head>Key</Table.Head>
				<Table.Head>类型</Table.Head>
				<Table.Head>状态</Table.Head>
				<Table.Head>使用中</Table.Head>
				<Table.Head class="text-right">30 天调用</Table.Head>
				<Table.Head class="text-right">30 天 tokens</Table.Head>
				<Table.Head>录入</Table.Head>
				<Table.Head class="w-32"></Table.Head>
			</Table.Row>
		</Table.Header>
		<Table.Body>
			{#each rows as k (k.id)}
				<Table.Row>
					<Table.Cell class="pl-4"><VendorTag id={k.vendor} name={names[k.vendor] ?? k.vendor} /></Table.Cell>
					<Table.Cell class="font-medium">{k.label}</Table.Cell>
					<Table.Cell class="text-muted-foreground font-mono text-xs">••••{k.last4}</Table.Cell>
					<Table.Cell><Badge variant={k.mode === 'dedicated' ? 'default' : 'secondary'}>{k.mode === 'dedicated' ? '独立' : '共享'}</Badge></Table.Cell>
					<Table.Cell>{#if k.status === 'active'}<Badge variant="outline" class="border-emerald-500/40 text-emerald-600">可用</Badge>{:else}<Badge variant="destructive">已停用</Badge>{/if}</Table.Cell>
					<Table.Cell class="max-w-56 whitespace-normal">
						{#if k.members.length === 0}<span class="text-muted-foreground text-sm">空闲</span>
						{:else if k.members.length === 1}{@const m = member(k.members[0]!)}<MemberCell name={k.members[0]!} displayName={m?.displayName} githubId={m?.githubId} sub={false} />
						{:else}<span class="text-sm">{k.members.map((n) => member(n)?.displayName ?? n).join('、')}</span>{/if}
					</Table.Cell>
					<Table.Cell class="text-right tabular-nums">{num(k.requests30d)}</Table.Cell>
					<Table.Cell class="text-right tabular-nums">{tokens(k.tokens30d)}</Table.Cell>
					<Table.Cell class="text-muted-foreground">{date(k.createdAt)}</Table.Cell>
					<Table.Cell class="text-right whitespace-nowrap">
						<form method="POST" action="?/status" use:enhance={toastForm((d) => (d?.status === 'active' ? '已启用' : '已停用，使用它的成员改用同类的其他 Key'))} class="inline">
							<input type="hidden" name="id" value={k.id} />
							<input type="hidden" name="status" value={k.status === 'active' ? 'disabled' : 'active'} />
							<Button type="submit" variant="ghost" size="sm">{k.status === 'active' ? '停用' : '启用'}</Button>
						</form>
						<form method="POST" action="?/delete" use:enhance={toastForm('已删除')} class="inline" onsubmit={(e) => { if (!confirm(`删除 ${k.label}？服务端会抹掉它，使用它的成员改用同类的其他 Key。`)) e.preventDefault(); }}>
							<input type="hidden" name="id" value={k.id} />
							<Button type="submit" variant="ghost" size="sm" class="text-destructive">删除</Button>
						</form>
					</Table.Cell>
				</Table.Row>
			{:else}
				<Table.Row><Table.Cell colspan={10} class="text-muted-foreground py-8 text-center">还没有 Key</Table.Cell></Table.Row>
			{/each}
		</Table.Body>
	</Table.Root>
</Card.Root>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-lg">
		<form method="POST" action="?/add" use:enhance={toastForm((d) => `已加密保存（…${String(d?.last4 ?? '')}），原文不会再显示`, () => (open = false))} class="grid gap-4">
			<Dialog.Header>
				<Dialog.Title>录入 API Key</Dialog.Title>
				<Dialog.Description>保存后只显示末尾 4 位。</Dialog.Description>
			</Dialog.Header>
			<div class="grid gap-4 sm:grid-cols-2">
				<Field label="厂商"><Choice bind:value={form.vendor} options={data.vendors.map((v) => ({ value: v.id, label: v.name }))} /></Field>
				<Field label="名称" id="k-label"><Input id="k-label" name="label" placeholder="例如 公司主账号" required /></Field>
			</div>
			<input type="hidden" name="vendor" value={form.vendor} />
			<Field label="API Key" id="k-key"><Input id="k-key" name="key" type="password" placeholder="sk-…" autocomplete="new-password" class="font-mono" required /></Field>
			<Field label="类型" hint={form.mode === 'shared' ? '多人共用，开通这个厂商的成员自动均衡分配。' : '只分给一个成员，别人不会被分到它。'}>
				<Choice bind:value={form.mode} options={[{ value: 'shared', label: '共享 Key' }, { value: 'dedicated', label: '独立 Key' }]} />
			</Field>
			<input type="hidden" name="mode" value={form.mode} />
			{#if form.mode === 'dedicated'}
				<Field label="分配给" hint="不选则留给第一个选了“独立 Key”、还在等的成员。">
					<Choice bind:value={form.member} placeholder="暂不指定" options={data.members.map((m) => ({ value: m.name, label: `${m.displayName}（${m.name}）` }))} />
				</Field>
				<input type="hidden" name="member" value={form.member} />
			{/if}
			<Alert.Root>
				<ShieldCheck />
				<Alert.Title>Key 不会离开服务端</Alert.Title>
				<Alert.Description>成员拿到的是公司网关地址和自己的设备令牌或内部 Key；停用成员、吊销设备后立即失效。</Alert.Description>
			</Alert.Root>
			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (open = false)}>取消</Button>
				<Button type="submit">加密保存</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
