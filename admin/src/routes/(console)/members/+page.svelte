<script lang="ts">
	import { enhance } from '$app/forms';
	import * as Card from '#lib/components/ui/card/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import PageHeader from '#lib/components/app/page-header.svelte';
	import Field from '#lib/components/app/field.svelte';
	import Choice from '#lib/components/app/choice.svelte';
	import MemberCell from '#lib/components/app/member-cell.svelte';
	import AssignmentChip from '#lib/components/app/assignment-chip.svelte';
	import Plus from '@lucide/svelte/icons/plus';
	import Search from '@lucide/svelte/icons/search';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import { toastForm } from '#lib/form.js';
	import { TEAM_LABEL, relative, tokens, vendorColor } from '#lib/labels.js';

	let { data } = $props();
	const names = $derived(Object.fromEntries(data.vendors.map((v) => [v.id, v.name])));
	const keys = $derived(new Map(data.keys.map((k) => [k.id, `${k.label} …${k.last4}`])));
	const accounts = $derived(new Map(data.accounts.map((a) => [a.id, a.account])));

	let query = $state('');
	let team = $state('all');
	const rows = $derived(data.members.filter((m) => (team === 'all' || m.team === team) && `${m.name} ${m.displayName} ${m.githubLogin}`.toLowerCase().includes(query.toLowerCase())));

	let open = $state(false);
	let form = $state({ team: 'dev', role: 'member', tunnels: true });
	let picks = $state<Record<string, string | undefined>>({});
	function startAdd() {
		form = { team: 'dev', role: 'member', tunnels: true };
		picks = { deepseek: 'shared' };
		open = true;
	}
	const vendorsJson = $derived(JSON.stringify(Object.entries(picks).filter(([, mode]) => mode).map(([vendor, mode]) => ({ vendor, mode }))));
</script>

<PageHeader title="成员" description="成员用 GitHub 账号登录。给成员开通厂商时选择分配方式：共享 Key、独立 Key 或订阅账号。">
	{#snippet actions()}<Button onclick={startAdd}><Plus />新建成员</Button>{/snippet}
</PageHeader>

<div class="flex flex-wrap items-center gap-2">
	<div class="relative w-64">
		<Search class="text-muted-foreground absolute top-2.5 left-2.5 size-4" />
		<Input bind:value={query} placeholder="搜索姓名、成员名、GitHub" class="pl-8" />
	</div>
	<Choice bind:value={team} class="w-32" options={[{ value: 'all', label: '全部职能' }, ...Object.entries(TEAM_LABEL).map(([value, label]) => ({ value, label }))]} />
</div>

<Card.Root class="py-0">
	<Table.Root>
		<Table.Header>
			<Table.Row>
				<Table.Head class="pl-4">成员</Table.Head>
				<Table.Head>职能</Table.Head>
				<Table.Head>角色</Table.Head>
				<Table.Head>状态</Table.Head>
				<Table.Head>AI 资源</Table.Head>
				<Table.Head class="text-right">设备</Table.Head>
				<Table.Head>最近使用</Table.Head>
				<Table.Head class="text-right">30 天 tokens</Table.Head>
				<Table.Head class="w-10"></Table.Head>
			</Table.Row>
		</Table.Header>
		<Table.Body>
			{#each rows as m (m.name)}
				<Table.Row class={m.status === 'disabled' ? 'opacity-60' : ''}>
					<Table.Cell class="pl-4"><MemberCell name={m.name} displayName={m.displayName} githubLogin={m.githubLogin} githubId={m.githubId} /></Table.Cell>
					<Table.Cell>{m.team ? TEAM_LABEL[m.team] : '—'}</Table.Cell>
					<Table.Cell>{#if m.role === 'admin'}<Badge>管理员</Badge>{:else}<Badge variant="secondary">成员</Badge>{/if}</Table.Cell>
					<Table.Cell>{#if m.status === 'active'}<Badge variant="outline" class="border-emerald-500/40 text-emerald-600">正常</Badge>{:else}<Badge variant="destructive">已停用</Badge>{/if}</Table.Cell>
					<Table.Cell class="max-w-[360px] whitespace-normal">
						<div class="flex flex-wrap gap-1">
							{#each m.vendors as a (a.vendor)}
								<AssignmentChip vendor={a.vendor} name={names[a.vendor] ?? a.vendor} mode={a.mode} held={a.mode === 'account' ? (a.cliAccount ? (accounts.get(a.cliAccount) ?? null) : null) : a.apiKey ? (keys.get(a.apiKey) ?? null) : null} />
							{:else}<span class="text-muted-foreground text-sm">未开通</span>{/each}
						</div>
					</Table.Cell>
					<Table.Cell class="text-right tabular-nums">{m.devices}</Table.Cell>
					<Table.Cell class="text-muted-foreground">{relative(m.lastUsedAt)}</Table.Cell>
					<Table.Cell class="text-right tabular-nums">{tokens(m.tokens30d)}</Table.Cell>
					<Table.Cell><Button variant="ghost" size="icon-sm" href="/members/{m.name}" aria-label="详情"><ChevronRight /></Button></Table.Cell>
				</Table.Row>
			{:else}
				<Table.Row><Table.Cell colspan={9} class="text-muted-foreground py-8 text-center">没有匹配的成员</Table.Cell></Table.Row>
			{/each}
		</Table.Body>
	</Table.Root>
</Card.Root>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-2xl">
		<form method="POST" action="?/add" use:enhance={toastForm((d) => `已添加 ${String(d?.displayName ?? '')}，用 GitHub 登录 GL Work 即可使用`, () => (open = false))} class="grid gap-4">
			<Dialog.Header>
				<Dialog.Title>新建成员</Dialog.Title>
				<Dialog.Description>绑定 GitHub 账号后，成员用 GitHub 登录 GL Work 和我的工作台。</Dialog.Description>
			</Dialog.Header>
			<div class="grid gap-4 sm:grid-cols-2">
				<Field label="成员名" id="m-name" hint="小写字母、数字和 -，用于隧道地址等"><Input id="m-name" name="name" placeholder="zhangsan" class="font-mono" required pattern="[a-z][a-z0-9-]{'{'}0,30{'}'}" /></Field>
				<Field label="姓名" id="m-display"><Input id="m-display" name="displayName" placeholder="张三" /></Field>
				<Field label="GitHub 用户名" id="m-gh" hint="github.com/ 后面那段"><Input id="m-gh" name="github" placeholder="zhangsan-dev" required /></Field>
				<div class="grid grid-cols-2 gap-4">
					<Field label="职能"><Choice bind:value={() => form.team, (t) => { form.team = t; form.tunnels = t !== 'product'; }} options={Object.entries(TEAM_LABEL).map(([value, label]) => ({ value, label }))} /></Field>
					<Field label="角色"><Choice bind:value={form.role} options={[{ value: 'member', label: '成员' }, { value: 'admin', label: '管理员' }]} /></Field>
				</div>
			</div>
			<input type="hidden" name="team" value={form.team} />
			<input type="hidden" name="role" value={form.role} />
			<input type="hidden" name="vendors" value={vendorsJson} />
			<div class="space-y-2">
				<div class="text-sm font-medium">开通的 AI 资源</div>
				<div class="divide-y rounded-md border">
					{#each data.vendors as v (v.id)}
						<div class="flex items-center gap-3 px-3 py-2">
							<Checkbox id="pick-{v.id}" checked={!!picks[v.id]} onCheckedChange={(on) => (picks[v.id] = on ? (v.auth === 'key' ? 'shared' : 'account') : undefined)} />
							<label for="pick-{v.id}" class="flex flex-1 items-center gap-2 text-sm"><span class="size-2 rounded-full" style="background: {vendorColor(v.id)}"></span>{v.name}</label>
							{#if picks[v.id] && v.auth === 'key'}
								<Choice bind:value={() => picks[v.id] ?? 'shared', (mode) => (picks[v.id] = mode)} class="h-8 w-32" options={[{ value: 'shared', label: '共享 Key' }, { value: 'dedicated', label: '独立 Key' }]} />
							{:else if picks[v.id]}
								<span class="text-muted-foreground text-xs">分配一个空闲的订阅账号</span>
							{/if}
						</div>
					{/each}
				</div>
			</div>
			<label class="flex items-center justify-between rounded-md border px-3 py-2.5">
				<span><span class="text-sm font-medium">内网穿透</span><span class="text-muted-foreground block text-xs">允许在 GL Work 里把本机网页服务发布到公网；开发和测试默认开通，SSH 在成员详情里单独开通</span></span>
				<Switch name="tunnels" bind:checked={form.tunnels} />
			</label>
			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (open = false)}>取消</Button>
				<Button type="submit">创建</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
