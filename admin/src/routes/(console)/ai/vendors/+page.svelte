<script lang="ts">
	import { enhance, type SubmitFunction } from '$app/forms';
	import * as Card from '#lib/components/ui/card/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import * as Sheet from '#lib/components/ui/sheet/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import PageHeader from '#lib/components/app/page-header.svelte';
	import Field from '#lib/components/app/field.svelte';
	import Choice from '#lib/components/app/choice.svelte';
	import Plus from '@lucide/svelte/icons/plus';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import Pencil from '@lucide/svelte/icons/pencil';
	import ListChecks from '@lucide/svelte/icons/list-checks';
	import Search from '@lucide/svelte/icons/search';
	import Trash from '@lucide/svelte/icons/trash-2';
	import { toastForm, toastResult } from '#lib/form.js';
	import { PROTOCOL_LABEL, relative, tokens, vendorColor } from '#lib/labels.js';

	let { data } = $props();
	type Vendor = (typeof data.vendors)[number];

	// Add / edit
	let open = $state(false);
	let editing = $state<Vendor | null>(null);
	let form = $state({ id: '', name: '', type: 'api', auth: 'key', protocol: 'openai', baseUrl: '', modelsUrl: '', compat: '' });
	function startAdd() {
		editing = null;
		form = { id: '', name: '', type: 'api', auth: 'key', protocol: 'openai', baseUrl: '', modelsUrl: '', compat: '' };
		open = true;
	}
	function startEdit(v: Vendor) {
		editing = v;
		form = { id: v.id, name: v.name, type: v.type, auth: v.auth, protocol: v.protocol ?? 'openai', baseUrl: v.baseUrl ?? '', modelsUrl: v.modelsUrl ?? '', compat: v.compat ? JSON.stringify(v.compat, null, 2) : '' };
		open = true;
	}

	// Models
	let modelsId = $state<string | null>(null);
	const modelsOf = $derived(data.vendors.find((v) => v.id === modelsId) ?? null);
	let sheetOpen = $state(false);
	let chosen = $state<Record<string, string>>({});
	let filter = $state('');
	let manual = $state('');
	let refreshing = $state(false);
	function openModels(v: Vendor) {
		modelsId = v.id;
		chosen = Object.fromEntries(v.models.map((m) => [m.id, m.name ?? '']));
		filter = '';
		sheetOpen = true;
	}
	const rows = $derived.by(() => {
		if (!modelsOf) return [];
		return [...new Set([...Object.keys(chosen), ...modelsOf.catalog])]
			.filter((id) => id.toLowerCase().includes(filter.toLowerCase()))
			.sort((a, b) => Number(b in chosen) - Number(a in chosen) || a.localeCompare(b));
	});
	const refreshCatalog: SubmitFunction = () => {
		refreshing = true;
		const after = toastResult((d) => `获取到 ${String(d?.listed ?? 0)} 个模型`);
		return async (opts) => {
			await after(opts);
			refreshing = false;
		};
	};
	const modelsJson = $derived(JSON.stringify(Object.entries(chosen).map(([id, name]) => (name.trim() ? { id, name: name.trim() } : { id }))));
</script>

<PageHeader title="厂商与模型" description="API Key 类厂商经公司网关调用，Key 只保存在服务端，可以选择给成员开放哪些模型；订阅类厂商只记录账号，成员用官方流程自己登录。">
	{#snippet actions()}<Button onclick={startAdd}><Plus />新增厂商</Button>{/snippet}
</PageHeader>

<div class="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
	{#each data.vendors as v (v.id)}
		<Card.Root>
			<Card.Header>
				<Card.Title class="flex items-center gap-2">
					<span class="size-2.5 rounded-full" style="background: {vendorColor(v.id)}"></span>{v.name}
					<span class="text-muted-foreground font-mono text-xs font-normal">{v.id}</span>
				</Card.Title>
				<Card.Description class="flex flex-wrap gap-1.5 pt-1">
					<Badge variant="secondary">{v.type === 'api' ? 'API' : 'CLI'}</Badge>
					<Badge variant="outline">{v.auth === 'key' ? 'API Key' : '订阅账号'}</Badge>
					{#if v.builtin}<Badge variant="outline" class="text-muted-foreground">内置</Badge>{/if}
					{#if v.waiting > 0}<Badge variant="outline" class="border-amber-500/50 text-amber-600">{v.waiting} 人待分配</Badge>{/if}
				</Card.Description>
				<Card.Action><Button variant="ghost" size="icon-sm" onclick={() => startEdit(v)} aria-label="编辑"><Pencil /></Button></Card.Action>
			</Card.Header>
			<Card.Content class="space-y-3 text-sm">
				{#if v.auth === 'key'}
					<div class="text-muted-foreground space-y-1">
						<div>{v.protocol ? PROTOCOL_LABEL[v.protocol] : ''}</div>
						<div class="truncate font-mono text-xs" title={v.baseUrl}>{v.baseUrl}</div>
					</div>
					<div class="grid grid-cols-3 gap-2 rounded-md border p-2 text-center">
						<div><div class="font-semibold tabular-nums">{v.models.length}</div><div class="text-muted-foreground text-xs">开放模型</div></div>
						<div><div class="font-semibold tabular-nums">{v.activeKeys}</div><div class="text-muted-foreground text-xs">可用 Key</div></div>
						<div><div class="font-semibold tabular-nums">{v.members}</div><div class="text-muted-foreground text-xs">成员</div></div>
					</div>
					<div class="flex flex-wrap gap-1">
						{#each v.models.slice(0, 4) as m (m.id)}<Badge variant="secondary" class="font-mono font-normal">{m.id}</Badge>{/each}
						{#if v.models.length > 4}<Badge variant="outline">+{v.models.length - 4}</Badge>{/if}
						{#if v.models.length === 0}<span class="text-xs text-amber-600">还没有开放模型，成员用不了</span>{/if}
					</div>
				{:else}
					{@const subs = data.subscriptions.filter((s) => s.vendor === v.id)}
					<div class="text-muted-foreground">成员在自己电脑上用 {v.name} 官方流程登录分配到的账号。</div>
					<div class="grid grid-cols-3 gap-2 rounded-md border p-2 text-center">
						<div><div class="font-semibold tabular-nums">{subs.length}</div><div class="text-muted-foreground text-xs">订阅</div></div>
						<div><div class="font-semibold tabular-nums">{v.accounts}</div><div class="text-muted-foreground text-xs">账号</div></div>
						<div><div class="font-semibold tabular-nums">{v.members}</div><div class="text-muted-foreground text-xs">成员</div></div>
					</div>
					<div class="text-muted-foreground text-xs">{subs.map((s) => s.plan).join('、') || '还没有订阅'}</div>
				{/if}
			</Card.Content>
			<Card.Footer class="gap-2">
				{#if v.auth === 'key'}
					<Button variant="outline" size="sm" onclick={() => openModels(v)}><ListChecks />选择模型</Button>
					<Button variant="ghost" size="sm" href="/ai/keys">Key 管理</Button>
					<span class="text-muted-foreground ml-auto text-xs">{tokens(v.tokens30d)} / 30 天</span>
				{:else}
					<Button variant="outline" size="sm" href="/ai/subscriptions">订阅与账号</Button>
				{/if}
			</Card.Footer>
		</Card.Root>
	{/each}
</div>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-lg">
		<form method="POST" action={editing ? '?/update' : '?/add'} use:enhance={toastForm(editing ? '已保存' : (d) => `已添加 ${String(d?.vendor ?? '')}`, () => (open = false))} class="grid gap-4">
			<Dialog.Header>
				<Dialog.Title>{editing ? `编辑 ${editing.name}` : '新增厂商'}</Dialog.Title>
				<Dialog.Description>{editing ? '标识和登录方式创建后不能修改。' : '例如 Kimi、智谱、OpenRouter。'}</Dialog.Description>
			</Dialog.Header>
			<div class="grid gap-4 sm:grid-cols-2">
				<Field label="名称" id="v-name"><Input id="v-name" name="name" bind:value={form.name} placeholder="Kimi" required /></Field>
				<Field label="标识" id="v-id" hint="网关地址里的 /llm/<标识>">
					<Input id="v-id" name="id" bind:value={form.id} placeholder="moonshot" readonly={!!editing} class="font-mono" required />
				</Field>
				<Field label="类型"><Choice bind:value={form.type} options={[{ value: 'api', label: 'API（桌面端和工具调用）' }, { value: 'cli', label: 'CLI（命令行工具）' }]} /></Field>
				<Field label="登录方式">
					{#if editing}<Input value={form.auth === 'key' ? 'API Key' : '订阅账号'} disabled />
					{:else}<Choice bind:value={form.auth} options={[{ value: 'key', label: 'API Key' }, { value: 'account', label: '订阅账号（成员自己登录）' }]} />{/if}
				</Field>
				<input type="hidden" name="type" value={form.type} />
				<input type="hidden" name="auth" value={form.auth} />
				{#if form.auth === 'key'}
					<Field label="接口协议" class="sm:col-span-2"><Choice bind:value={form.protocol} options={[{ value: 'openai', label: 'OpenAI 兼容' }, { value: 'anthropic', label: 'Anthropic Messages' }]} /></Field>
					<input type="hidden" name="protocol" value={form.protocol} />
					<Field label="接口地址" id="v-url" class="sm:col-span-2"><Input id="v-url" name="baseUrl" bind:value={form.baseUrl} placeholder="https://api.moonshot.cn/v1" class="font-mono" required /></Field>
					<Field label="模型列表地址（可选）" id="v-models" hint="留空则用接口地址下的 /models" class="sm:col-span-2"><Input id="v-models" name="modelsUrl" bind:value={form.modelsUrl} class="font-mono" /></Field>
					<Field label="兼容参数（可选）" id="v-compat" hint="JSON，对应客户端的 compat 设置，例如思考格式" class="sm:col-span-2">
						<Textarea id="v-compat" name="compat" bind:value={form.compat} placeholder={'{ "thinkingFormat": "qwen" }'} class="font-mono text-xs" />
					</Field>
				{/if}
			</div>
			<Dialog.Footer class="sm:justify-between">
				{#if editing}
					<Button type="submit" formaction="?/delete" variant="ghost" class="text-destructive" onclick={(e) => { if (!confirm(`删除厂商 ${editing?.name}？成员的开通记录会一起删除。`)) e.preventDefault(); }}><Trash />删除</Button>
				{:else}<span></span>{/if}
				<div class="flex gap-2">
					<Button type="button" variant="outline" onclick={() => (open = false)}>取消</Button>
					<Button type="submit">{editing ? '保存' : '添加'}</Button>
				</div>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>

<Sheet.Root bind:open={sheetOpen}>
	<Sheet.Content class="flex w-full flex-col gap-0 sm:max-w-xl">
		<Sheet.Header class="border-b">
			<Sheet.Title>{modelsOf?.name} · 开放的模型</Sheet.Title>
			<Sheet.Description>{modelsOf?.catalogAt ? `厂商列出 ${modelsOf.catalog.length} 个模型，${relative(modelsOf.catalogAt)}刷新` : '尚未获取模型列表'}</Sheet.Description>
		</Sheet.Header>
		<div class="space-y-3 border-b p-4">
			<div class="flex gap-2">
				<div class="relative flex-1">
					<Search class="text-muted-foreground absolute top-2.5 left-2.5 size-4" />
					<Input bind:value={filter} placeholder="筛选模型" class="pl-8" />
				</div>
				<form method="POST" action="?/catalog" use:enhance={refreshCatalog}>
					<input type="hidden" name="id" value={modelsOf?.id} />
					<Button type="submit" variant="outline" disabled={refreshing}><RefreshCw class={refreshing ? 'animate-spin' : ''} />刷新列表</Button>
				</form>
			</div>
			<div class="flex gap-2">
				<Input bind:value={manual} placeholder="列表里没有？手动添加模型 ID" class="font-mono" />
				<Button variant="secondary" onclick={() => { if (manual.trim()) { chosen[manual.trim()] = ''; manual = ''; } }}>添加</Button>
			</div>
		</div>
		<div class="flex-1 overflow-y-auto p-2">
			{#each rows as id (id)}
				<label class="hover:bg-muted flex items-center gap-3 rounded-md px-2 py-1.5">
					<Checkbox checked={id in chosen} onCheckedChange={(on) => { if (on) chosen[id] = chosen[id] ?? ''; else delete chosen[id]; }} />
					<span class="flex-1 truncate font-mono text-sm">{id}</span>
					{#if id in chosen}<Input bind:value={chosen[id]} placeholder="显示名称（可选）" class="h-7 w-44 text-xs" />{/if}
				</label>
			{:else}
				<p class="text-muted-foreground p-6 text-center text-sm">{modelsOf?.catalog.length ? '没有匹配的模型' : '先录入一个 Key 再刷新列表，或手动添加模型 ID'}</p>
			{/each}
		</div>
		<form method="POST" action="?/models" use:enhance={toastForm((d) => `已开放 ${String(d?.count ?? 0)} 个模型，成员的客户端下次同步时更新`, () => (sheetOpen = false))}>
			<Sheet.Footer class="flex-row items-center border-t">
				<input type="hidden" name="id" value={modelsOf?.id} />
				<input type="hidden" name="models" value={modelsJson} />
				<span class="text-muted-foreground mr-auto text-sm">已开放 {Object.keys(chosen).length} 个</span>
				<Button type="button" variant="outline" onclick={() => (sheetOpen = false)}>取消</Button>
				<Button type="submit">保存</Button>
			</Sheet.Footer>
		</form>
	</Sheet.Content>
</Sheet.Root>
