<script lang="ts">
	import { enhance } from '$app/forms';
	import * as Card from '#lib/components/ui/card/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import PageHeader from '#lib/components/app/page-header.svelte';
	import Field from '#lib/components/app/field.svelte';
	import MemberCell from '#lib/components/app/member-cell.svelte';
	import Plus from '@lucide/svelte/icons/plus';
	import Package from '@lucide/svelte/icons/package';
	import ShieldCheck from '@lucide/svelte/icons/shield-check';
	import Ellipsis from '@lucide/svelte/icons/ellipsis';
	import Loader from '@lucide/svelte/icons/loader-circle';
	import Info from '@lucide/svelte/icons/info';
	import { toastForm, toastResult } from '#lib/form.js';
	import { relative } from '#lib/labels.js';
	import type { SubmitFunction } from '$app/forms';

	let { data } = $props();
	type Plugin = (typeof data.plugins)[number];
	type Preview = { name: string; version: string; description: string | null; integrity: string; size: number; dependencies: number; registered: string | null };

	const size = (bytes: number) => (bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`);
	const installed = (p: Plugin) => data.installs.filter((i) => i.plugin === p.name);
	const outdated = (p: Plugin) => installed(p).filter((i) => i.version !== p.version).length;
	const versionOn = (device: string, plugin: string) => data.installs.find((i) => i.credential === device && i.plugin === plugin)?.version;

	// Register or update: read the package first, then confirm.
	let open = $state(false);
	let updating = $state<Plugin | null>(null);
	let url = $state('');
	let preview = $state<Preview | null>(null);
	let reading = $state(false);
	function start(plugin: Plugin | null) {
		updating = plugin;
		url = '';
		preview = null;
		open = true;
	}
	const read: SubmitFunction = () => {
		reading = true;
		preview = null;
		const after = toastResult(undefined, (d) => { preview = (d?.preview as Preview | undefined) ?? null; });
		return async (opts) => { await after(opts); reading = false; };
	};

	// Edit what members read
	let editing = $state<Plugin | null>(null);
	let editOpen = $state(false);
</script>

<PageHeader title="插件" description="公司给 GL Work 提供的插件。成员在 GL Work 的插件管理里看到已上架的插件，自己点击安装；安装前会核对 sha512，并列出插件要用到的权限。">
	{#snippet actions()}<Button onclick={() => start(null)}><Plus />登记插件</Button>{/snippet}
</PageHeader>

<div class="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
	{#each data.plugins as p (p.name)}
		{@const count = installed(p).length}
		<Card.Root class={p.status === 'hidden' ? 'opacity-75' : ''}>
			<Card.Header>
				<Card.Title class="flex items-center gap-2"><Package class="text-muted-foreground size-4" />{p.displayName}<span class="text-muted-foreground font-mono text-xs font-normal">{p.version}</span></Card.Title>
				<Card.Description class="flex flex-wrap gap-1.5 pt-1">
					{#if p.status === 'published'}<Badge variant="outline" class="border-emerald-500/40 text-emerald-600">已上架</Badge>{:else}<Badge variant="secondary">未上架</Badge>{/if}
					{#if p.preinstalled}<Badge>随 GL Work 预装</Badge>{/if}
				</Card.Description>
				<Card.Action>
					<DropdownMenu.Root>
						<DropdownMenu.Trigger>{#snippet child({ props })}<Button variant="ghost" size="icon-sm" {...props} aria-label="操作"><Ellipsis /></Button>{/snippet}</DropdownMenu.Trigger>
						<DropdownMenu.Content align="end">
							<DropdownMenu.Item onclick={() => start(p)}>更新版本</DropdownMenu.Item>
							<DropdownMenu.Item onclick={() => { editing = p; editOpen = true; }}>编辑说明</DropdownMenu.Item>
							<DropdownMenu.Separator />
							<form method="POST" action="?/delete" use:enhance={toastForm('已删除')} onsubmit={(e) => { if (!confirm(`删除 ${p.displayName}？成员电脑上已装的不受影响，但列表里不再显示。`)) e.preventDefault(); }}>
								<input type="hidden" name="name" value={p.name} />
								<button type="submit" class="text-destructive hover:bg-destructive/10 w-full rounded-sm px-2 py-1.5 text-left text-sm">删除</button>
							</form>
						</DropdownMenu.Content>
					</DropdownMenu.Root>
				</Card.Action>
			</Card.Header>
			<Card.Content class="space-y-3 text-sm">
				<p class="text-muted-foreground">{p.description ?? '没有说明'}</p>
				<div class="text-muted-foreground font-mono text-xs break-all">{p.name}</div>
				{#if p.permissions.length}
					<div>
						<div class="text-muted-foreground mb-1 flex items-center gap-1 text-xs"><ShieldCheck class="size-3.5" />安装后可以</div>
						<ul class="list-disc space-y-0.5 pl-5">{#each p.permissions as perm (perm)}<li>{perm}</li>{/each}</ul>
					</div>
				{/if}
				<div class="text-muted-foreground text-xs">
					{count}/{data.desktops.length} 台 GL Work 已安装{outdated(p) ? `，${outdated(p)} 台待更新` : ''} · {size(p.size)} · {relative(p.updatedAt)}更新
				</div>
			</Card.Content>
			<Card.Footer>
				<form method="POST" action="?/status" use:enhance={toastForm((d) => (d?.status === 'published' ? '已上架，成员的 GL Work 刷新列表后就能看到' : '已下架，成员不能再新装'))}>
					<input type="hidden" name="name" value={p.name} />
					<input type="hidden" name="status" value={p.status === 'published' ? 'hidden' : 'published'} />
					<Button type="submit" size="sm" variant={p.status === 'published' ? 'outline' : 'default'}>{p.status === 'published' ? '下架' : '上架'}</Button>
				</form>
			</Card.Footer>
		</Card.Root>
	{:else}
		<Card.Root class="md:col-span-2 xl:col-span-3"><Card.Content class="text-muted-foreground py-10 text-center text-sm">还没有登记插件</Card.Content></Card.Root>
	{/each}
</div>

<Card.Root class="gap-0 py-0">
	<Card.Header class="border-b py-4"><Card.Title>各台 GL Work 的安装情况</Card.Title><Card.Description>GL Work 每次拉取插件列表时上报。</Card.Description></Card.Header>
	<Table.Root>
		<Table.Header>
			<Table.Row>
				<Table.Head class="pl-4">设备</Table.Head>
				<Table.Head>成员</Table.Head>
				{#each data.plugins as p (p.name)}<Table.Head>{p.displayName}</Table.Head>{/each}
			</Table.Row>
		</Table.Header>
		<Table.Body>
			{#each data.desktops as d (d.id)}
				<Table.Row>
					<Table.Cell class="pl-4"><div class="font-medium">{d.label}</div><div class="text-muted-foreground text-xs">{relative(d.lastUsedAt)}活动</div></Table.Cell>
					<Table.Cell><MemberCell name={d.member} displayName={d.displayName} githubId={d.githubId} sub={false} /></Table.Cell>
					{#each data.plugins as p (p.name)}
						{@const v = versionOn(d.id, p.name)}
						<Table.Cell>
							{#if v}<span class="font-mono text-xs">{v}</span>{#if v !== p.version}<Badge variant="outline" class="ml-1 border-amber-500/50 text-amber-600">待更新</Badge>{/if}
							{:else}<span class="text-muted-foreground text-xs">未安装</span>{/if}
						</Table.Cell>
					{/each}
				</Table.Row>
			{:else}
				<Table.Row><Table.Cell colspan={2 + data.plugins.length} class="text-muted-foreground py-8 text-center">还没有登录的 GL Work 桌面端</Table.Cell></Table.Row>
			{/each}
		</Table.Body>
	</Table.Root>
</Card.Root>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-xl">
		<Dialog.Header>
			<Dialog.Title>{updating ? `更新 ${updating.displayName}` : '登记插件'}</Dialog.Title>
			<Dialog.Description>先用 npm pack（或 pnpm pack）打包，上传到 OSS，再把下载地址填在这里。服务端会下载并核对插件包。</Dialog.Description>
		</Dialog.Header>
		<form method="POST" action="?/inspect" use:enhance={read} class="flex gap-2">
			<Input name="url" bind:value={url} placeholder="https://download.glgwork.com/plugins/dsh-xxx-0.1.0.tgz" class="font-mono text-xs" required />
			<Button type="submit" variant="secondary" disabled={reading}>{#if reading}<Loader class="animate-spin" />{/if}读取</Button>
		</form>
		{#if preview}
			<div class="bg-muted/50 grid min-w-0 grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-md border p-3 text-sm">
				<span class="text-muted-foreground">包名</span><span class="font-mono break-all">{preview.name}</span>
				<span class="text-muted-foreground">版本</span><span class="font-mono">{preview.version}{preview.registered ? `（已登记 ${preview.registered}）` : ''}</span>
				<span class="text-muted-foreground">大小</span><span>{size(preview.size)}</span>
				<span class="text-muted-foreground">sha512</span><span class="truncate font-mono text-xs" title={preview.integrity}>{preview.integrity}</span>
				{#if preview.description}<span class="text-muted-foreground">说明</span><span>{preview.description}</span>{/if}
			</div>
			{#if preview.dependencies > 0}
				<Alert.Root><Info /><Alert.Description>这个插件声明了 {preview.dependencies} 个依赖，成员安装时会从 npm 源下载它们。</Alert.Description></Alert.Root>
			{/if}
			{#if updating}
				{#if preview.name !== updating.name}
					<Alert.Root variant="destructive"><Info /><Alert.Description>这是 {preview.name}，不是 {updating.name}。</Alert.Description></Alert.Root>
				{:else}
					<form method="POST" action="?/update" use:enhance={toastForm((d) => `已更新到 ${String(d?.version ?? '')}`, () => (open = false))}>
						<input type="hidden" name="name" value={updating.name} />
						<input type="hidden" name="url" value={url} />
						<Dialog.Footer><Button type="button" variant="outline" onclick={() => (open = false)}>取消</Button><Button type="submit">更新到 {preview.version}</Button></Dialog.Footer>
					</form>
				{/if}
			{:else if preview.registered}
				<Alert.Root><Info /><Alert.Description>{preview.name} 已经登记过，请在它的卡片上选“更新版本”。</Alert.Description></Alert.Root>
			{:else}
				<form method="POST" action="?/register" use:enhance={toastForm((d) => `已登记 ${String(d?.plugin ?? '')}`, () => (open = false))} class="grid gap-4">
					<input type="hidden" name="url" value={url} />
					<Field label="名称" id="pl-name" hint="成员在 GL Work 里看到的名字"><Input id="pl-name" name="displayName" required /></Field>
					<Field label="安装后可以（每行一条）" id="pl-perm" hint="例如：读取系统配置 feishu.webhook；发送网络请求到 open.feishu.cn">
						<Textarea id="pl-perm" name="permissions" rows={3} />
					</Field>
					<div class="flex flex-wrap gap-6">
						<div class="flex items-center gap-2"><Switch id="pl-pre" name="preinstalled" /><Label for="pl-pre">随 GL Work 预装</Label></div>
						<div class="flex items-center gap-2"><Switch id="pl-pub" name="publish" /><Label for="pl-pub">立即上架</Label></div>
					</div>
					<Dialog.Footer><Button type="button" variant="outline" onclick={() => (open = false)}>取消</Button><Button type="submit">登记</Button></Dialog.Footer>
				</form>
			{/if}
		{/if}
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={editOpen}>
	<Dialog.Content class="sm:max-w-lg">
		{#if editing}
			<form method="POST" action="?/describe" use:enhance={toastForm('已保存', () => (editOpen = false))} class="grid gap-4">
				<Dialog.Header><Dialog.Title>编辑 {editing.displayName}</Dialog.Title></Dialog.Header>
				<input type="hidden" name="name" value={editing.name} />
				<Field label="名称" id="pe-name"><Input id="pe-name" name="displayName" value={editing.displayName} required /></Field>
				<Field label="安装后可以（每行一条）" id="pe-perm"><Textarea id="pe-perm" name="permissions" rows={3} value={editing.permissions.join('\n')} /></Field>
				<div class="flex items-center gap-2"><Switch id="pe-pre" name="preinstalled" checked={editing.preinstalled} /><Label for="pe-pre">随 GL Work 预装</Label></div>
				<Dialog.Footer><Button type="button" variant="outline" onclick={() => (editOpen = false)}>取消</Button><Button type="submit">保存</Button></Dialog.Footer>
			</form>
		{/if}
	</Dialog.Content>
</Dialog.Root>
