<script lang="ts">
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import * as Card from '#lib/components/ui/card/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import * as Tabs from '#lib/components/ui/tabs/index.js';
	import * as Avatar from '#lib/components/ui/avatar/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import Choice from '#lib/components/app/choice.svelte';
	import Field from '#lib/components/app/field.svelte';
	import KindIcon from '#lib/components/app/kind-icon.svelte';
	import IssuedKey from '#lib/components/app/issued-key.svelte';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import AtSign from '@lucide/svelte/icons/at-sign';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Plus from '@lucide/svelte/icons/plus';
	import { toastForm } from '#lib/form.js';
	import { KIND_LABEL, MODE_LABEL, TEAM_LABEL, date, recentlyActive, relative, tokens, vendorColor } from '#lib/labels.js';

	let { data } = $props();
	const m = $derived(data.member);
	const isMe = $derived(page.data.viewer?.name === m.name);
	const keysOf = $derived(data.devices.filter((d) => d.kind === 'key'));
	const devices = $derived(data.devices.filter((d) => d.kind !== 'key'));
	const gateway = $derived(`${page.url.origin}/agent-work/llm`);
	const tokensOf = (vendor: string) => data.usage.find((u) => u.vendor === vendor)?.tokens ?? 0;

	function options(vendorId: string, mode: string) {
		if (mode === 'account') {
			return data.accounts.filter((a) => a.vendor === vendorId && (!a.member || a.member === m.name)).map((a) => ({
				value: a.id, label: `${a.account}${a.subscription ? `（${data.subscriptions.find((s) => s.id === a.subscription)?.plan ?? ''}）` : ''}`
			}));
		}
		return data.keys.filter((k) => k.vendor === vendorId && k.mode === mode && k.status === 'active' && (mode === 'shared' || k.members.every((u) => u === m.name)))
			.map((k) => ({ value: k.id, label: `${k.label} …${k.last4}${mode === 'shared' ? `（${k.members.length} 人在用）` : ''}` }));
	}

	// Each change posts at once.
	let assignForm = $state<HTMLFormElement>();
	let pending = $state({ vendor: '', mode: '', ref: '' });
	function assign(vendor: string, mode: string, ref = '') {
		pending = { vendor, mode, ref };
		queueMicrotask(() => assignForm?.requestSubmit());
	}
	let unassignForm = $state<HTMLFormElement>();
	let closing = $state('');
	function unassign(vendor: string) {
		closing = vendor;
		queueMicrotask(() => unassignForm?.requestSubmit());
	}
	let grantForm = $state<HTMLFormElement>();
	let grant = $state({ field: '', on: '' });
	function setGrant(field: string, on: boolean) {
		grant = { field, on: String(on) };
		queueMicrotask(() => grantForm?.requestSubmit());
	}

	let editOpen = $state(false);
	let team = $state('');
	let keyOpen = $state(false);
	let issued = $state<string | null>(null);
</script>

<svelte:head><title>{m.displayName} · 成员</title></svelte:head>

<div class="flex flex-wrap items-center gap-4">
	<Button variant="ghost" size="icon" href="/members" aria-label="返回"><ArrowLeft /></Button>
	<Avatar.Root class="size-14">
		<Avatar.Image src="https://avatars.githubusercontent.com/u/{m.githubId}?s=112" alt="" />
		<Avatar.Fallback class="bg-primary/10 text-primary text-xl">{m.displayName.slice(0, 1)}</Avatar.Fallback>
	</Avatar.Root>
	<div class="space-y-1">
		<div class="flex items-center gap-2">
			<h1 class="text-2xl font-semibold">{m.displayName}</h1>
			<span class="text-muted-foreground font-mono">{m.name}</span>
			{#if m.role === 'admin'}<Badge>管理员</Badge>{/if}
			{#if m.status === 'disabled'}<Badge variant="destructive">已停用</Badge>{/if}
			<Button variant="ghost" size="icon-sm" onclick={() => { team = m.team ?? ''; editOpen = true; }} aria-label="编辑资料"><Pencil /></Button>
		</div>
		<div class="text-muted-foreground flex flex-wrap items-center gap-x-4 text-sm">
			<span class="inline-flex items-center gap-1"><AtSign class="size-3.5" />GitHub {m.githubLogin}</span>
			<span>{m.team ? TEAM_LABEL[m.team] : '未设职能'}</span>
			<span>{date(m.createdAt)} 加入</span>
			<span>30 天 {tokens(m.tokens30d)} tokens</span>
		</div>
	</div>
	<div class="ml-auto flex gap-2">
		<form method="POST" action="?/role" use:enhance={toastForm('已更新角色')}>
			<input type="hidden" name="role" value={m.role === 'admin' ? 'member' : 'admin'} />
			<Button type="submit" variant="outline" disabled={isMe}>{m.role === 'admin' ? '降为成员' : '设为管理员'}</Button>
		</form>
		<form method="POST" action="?/status" use:enhance={toastForm((d) => (d?.status === 'disabled' ? '已停用，所有设备和内部 Key 立即失效' : '已启用，需要重新登录'))}
			onsubmit={(e) => { if (m.status === 'active' && !confirm(`停用 ${m.displayName}？这个成员的设备、内部 Key 立即失效。`)) e.preventDefault(); }}>
			<input type="hidden" name="status" value={m.status === 'active' ? 'disabled' : 'active'} />
			<Button type="submit" variant={m.status === 'active' ? 'destructive' : 'default'} disabled={isMe}>{m.status === 'active' ? '停用' : '启用'}</Button>
		</form>
		<form method="POST" action="?/delete" use:enhance={toastForm('已删除')} onsubmit={(e) => { if (!confirm(`删除成员 ${m.displayName}？这个成员的设备会全部失效，占用的账号会释放。审计和用量记录会保留。`)) e.preventDefault(); }}>
			<Button type="submit" variant="ghost" class="text-destructive" disabled={isMe}>删除</Button>
		</form>
	</div>
</div>

<form bind:this={assignForm} method="POST" action="?/assign" use:enhance={toastForm('已更新')} hidden>
	<input name="vendor" value={pending.vendor} /><input name="mode" value={pending.mode} /><input name="ref" value={pending.ref} />
</form>
<form bind:this={unassignForm} method="POST" action="?/unassign" use:enhance={toastForm('已关闭')} hidden>
	<input name="vendor" value={closing} />
</form>
<form bind:this={grantForm} method="POST" action="?/tunnels" use:enhance={toastForm('已更新')} hidden>
	<input name="field" value={grant.field} /><input name="on" value={grant.on} />
</form>

<Tabs.Root value="ai">
	<Tabs.List>
		<Tabs.Trigger value="ai">AI 资源</Tabs.Trigger>
		<Tabs.Trigger value="keys">内部 Key（{keysOf.length}）</Tabs.Trigger>
		<Tabs.Trigger value="devices">设备（{devices.length}）</Tabs.Trigger>
		<Tabs.Trigger value="tunnels">内网穿透</Tabs.Trigger>
	</Tabs.List>

	<Tabs.Content value="ai">
		<Card.Root class="py-0">
			<Table.Root>
				<Table.Header>
					<Table.Row>
						<Table.Head class="pl-4">厂商</Table.Head>
						<Table.Head class="w-16">开通</Table.Head>
						<Table.Head class="w-40">分配方式</Table.Head>
						<Table.Head>分配到的 Key / 账号</Table.Head>
						<Table.Head class="text-right">30 天 tokens</Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each data.vendors as v (v.id)}
						{@const a = m.vendors.find((x) => x.vendor === v.id)}
						<Table.Row>
							<Table.Cell class="pl-4">
								<div class="flex items-center gap-2"><span class="size-2 rounded-full" style="background: {vendorColor(v.id)}"></span><span class="font-medium">{v.name}</span></div>
								<div class="text-muted-foreground text-xs">{v.auth === 'key' ? `API · 开放 ${v.models} 个模型` : '订阅 · 成员自己登录'}</div>
							</Table.Cell>
							<Table.Cell>
								{#if a}
									<Switch checked={true} onCheckedChange={(on) => { if (!on) unassign(v.id); }} />
								{:else}
									<Switch checked={false} onCheckedChange={(on) => { if (on) assign(v.id, v.auth === 'key' ? 'shared' : 'account'); }} />
								{/if}
							</Table.Cell>
							<Table.Cell>
								{#if a && v.auth === 'key'}
									<Choice class="h-8 w-32" options={[{ value: 'shared', label: '共享 Key' }, { value: 'dedicated', label: '独立 Key' }]} bind:value={() => a.mode, (mode) => assign(v.id, mode)} />
								{:else if a}<span class="text-sm">订阅账号</span>{:else}<span class="text-muted-foreground">—</span>{/if}
							</Table.Cell>
							<Table.Cell>
								{#if a}
									{@const opts = options(v.id, a.mode)}
									{@const held = a.mode === 'account' ? a.cliAccount : a.apiKey}
									{#if opts.length}
										<Choice class="h-8 w-80" placeholder="待分配" options={opts} bind:value={() => held ?? '', (ref) => assign(v.id, a.mode, ref)} />
									{:else}
										<span class="text-sm text-amber-600">待分配：没有可用的{MODE_LABEL[a.mode]}</span>
										<Button variant="link" size="sm" href={a.mode === 'account' ? '/ai/subscriptions' : '/ai/keys'}>{a.mode === 'account' ? '添加账号' : '录入 Key'}</Button>
									{/if}
								{/if}
							</Table.Cell>
							<Table.Cell class="text-muted-foreground text-right tabular-nums">{v.auth === 'key' && a ? tokens(tokensOf(v.id)) : ''}</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		</Card.Root>
	</Tabs.Content>

	<Tabs.Content value="keys" class="space-y-3">
		<div class="flex items-center justify-between">
			<p class="text-muted-foreground text-sm">内部 Key 是成员个人的公司网关凭据，用在 Claude Code、脚本里。成员也可以在“我的工作台”里自己生成和吊销。</p>
			<Button size="sm" onclick={() => { issued = null; keyOpen = true; }} disabled={m.status !== 'active'}><Plus />生成内部 Key</Button>
		</div>
		<Card.Root class="py-0">
			<Table.Root>
				<Table.Header><Table.Row><Table.Head class="pl-4">用途</Table.Head><Table.Head>创建</Table.Head><Table.Head>最近使用</Table.Head><Table.Head>IP</Table.Head><Table.Head class="w-20"></Table.Head></Table.Row></Table.Header>
				<Table.Body>
					{#each keysOf as k (k.id)}
						<Table.Row>
							<Table.Cell class="pl-4 font-medium">{k.label}</Table.Cell>
							<Table.Cell>{date(k.createdAt)}</Table.Cell>
							<Table.Cell>{relative(k.lastUsedAt)}</Table.Cell>
							<Table.Cell class="text-muted-foreground font-mono text-xs">{k.lastIp ?? '—'}</Table.Cell>
							<Table.Cell>
								<form method="POST" action="?/revoke" use:enhance={toastForm('已吊销')} onsubmit={(e) => { if (!confirm(`吊销 ${k.label}？用它的工具会立即失效。`)) e.preventDefault(); }}>
									<input type="hidden" name="id" value={k.id} /><Button type="submit" variant="ghost" size="sm" class="text-destructive">吊销</Button>
								</form>
							</Table.Cell>
						</Table.Row>
					{:else}
						<Table.Row><Table.Cell colspan={5} class="text-muted-foreground py-6 text-center">还没有内部 Key</Table.Cell></Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		</Card.Root>
	</Tabs.Content>

	<Tabs.Content value="devices">
		<Card.Root class="py-0">
			<Table.Root>
				<Table.Header><Table.Row><Table.Head class="pl-4">设备</Table.Head><Table.Head>类型</Table.Head><Table.Head>最近活动</Table.Head><Table.Head>IP</Table.Head><Table.Head>到期</Table.Head><Table.Head class="w-20"></Table.Head></Table.Row></Table.Header>
				<Table.Body>
					{#each devices as d (d.id)}
						<Table.Row>
							<Table.Cell class="pl-4"><div class="flex items-center gap-2"><KindIcon kind={d.kind} class="text-muted-foreground size-4" /><span class="font-medium">{d.label}</span>{#if recentlyActive(d.lastUsedAt)}<Badge variant="outline" class="border-emerald-500/40 text-emerald-600">活跃</Badge>{/if}</div></Table.Cell>
							<Table.Cell>{KIND_LABEL[d.kind]}</Table.Cell>
							<Table.Cell>{relative(d.lastUsedAt)}</Table.Cell>
							<Table.Cell class="text-muted-foreground font-mono text-xs">{d.lastIp ?? '—'}</Table.Cell>
							<Table.Cell class="text-muted-foreground">{date(d.expiresAt)}</Table.Cell>
							<Table.Cell>
								<form method="POST" action="?/revoke" use:enhance={toastForm('已吊销')} onsubmit={(e) => { if (!confirm(`吊销 ${d.label}？它会立即退出登录。`)) e.preventDefault(); }}>
									<input type="hidden" name="id" value={d.id} /><Button type="submit" variant="ghost" size="sm" class="text-destructive">吊销</Button>
								</form>
							</Table.Cell>
						</Table.Row>
					{:else}
						<Table.Row><Table.Cell colspan={6} class="text-muted-foreground py-6 text-center">没有登录中的设备</Table.Cell></Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		</Card.Root>
	</Tabs.Content>

	<Tabs.Content value="tunnels" class="space-y-3">
		<div class="bg-card divide-y rounded-lg border">
			<div class="flex items-center justify-between gap-4 px-4 py-3">
				<span><span class="font-medium">网页隧道</span><span class="text-muted-foreground block text-sm">把本机网页服务发布到公网。</span></span>
				<Switch checked={m.tunnels} onCheckedChange={(on) => setGrant('tunnels', on)} />
			</div>
			<div class="flex items-center justify-between gap-4 px-4 py-3">
				<span><span class="font-medium">SSH 隧道</span><span class="text-muted-foreground block text-sm">让指定的同事经 GL Work 连到这个成员电脑的 SSH。风险更高，按需单独开通。</span></span>
				<Switch checked={m.ssh} onCheckedChange={(on) => setGrant('ssh', on)} />
			</div>
		</div>
		<p class="text-muted-foreground text-sm">隧道本身在内网穿透功能上线后显示在这里（成员还需要在 GL Work 里安装“内网穿透”插件）。</p>
	</Tabs.Content>
</Tabs.Root>

<Dialog.Root bind:open={editOpen}>
	<Dialog.Content class="sm:max-w-md">
		<form method="POST" action="?/profile" use:enhance={toastForm('已保存', () => (editOpen = false))} class="grid gap-4">
			<Dialog.Header><Dialog.Title>编辑资料</Dialog.Title></Dialog.Header>
			<Field label="姓名" id="p-name"><Input id="p-name" name="displayName" value={m.displayName} /></Field>
			<Field label="职能"><Choice bind:value={team} placeholder="未设置" options={Object.entries(TEAM_LABEL).map(([value, label]) => ({ value, label }))} /></Field>
			<input type="hidden" name="team" value={team} />
			<Dialog.Footer><Button type="button" variant="outline" onclick={() => (editOpen = false)}>取消</Button><Button type="submit">保存</Button></Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={keyOpen}>
	<Dialog.Content class="sm:max-w-xl">
		<Dialog.Header>
			<Dialog.Title>{issued ? '内部 Key 已生成' : `给 ${m.displayName} 生成内部 Key`}</Dialog.Title>
			<Dialog.Description>能调用这个成员已开通的 API 厂商、读取系统配置；停用成员或吊销后立即失效。</Dialog.Description>
		</Dialog.Header>
		{#if issued}
			<IssuedKey token={issued} {gateway} />
			<Dialog.Footer><Button onclick={() => (keyOpen = false)}>已转交</Button></Dialog.Footer>
		{:else}
			<form method="POST" action="?/issueKey" use:enhance={toastForm(undefined, (d) => { issued = String((d?.issued as { token?: string } | undefined)?.token ?? ''); })} class="grid gap-4">
				<Field label="用途" id="ik-label" hint="例如“Claude Code”“CI 脚本”"><Input id="ik-label" name="label" required /></Field>
				<Dialog.Footer><Button type="button" variant="outline" onclick={() => (keyOpen = false)}>取消</Button><Button type="submit">生成</Button></Dialog.Footer>
			</form>
		{/if}
	</Dialog.Content>
</Dialog.Root>
