<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import * as Card from '#lib/components/ui/card/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import * as Avatar from '#lib/components/ui/avatar/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import Choice from '#lib/components/app/choice.svelte';
	import Field from '#lib/components/app/field.svelte';
	import CopyField from '#lib/components/app/copy-field.svelte';
	import KindIcon from '#lib/components/app/kind-icon.svelte';
	import IssuedKey from '#lib/components/app/issued-key.svelte';
	import Plus from '@lucide/svelte/icons/plus';
	import Shield from '@lucide/svelte/icons/shield';
	import Lock from '@lucide/svelte/icons/lock';
	import LogIn from '@lucide/svelte/icons/log-in';
	import Clock from '@lucide/svelte/icons/clock';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import Eye from '@lucide/svelte/icons/eye';
	import LogOut from '@lucide/svelte/icons/log-out';
	import SunMoon from '@lucide/svelte/icons/sun-moon';
	import { toggleMode } from 'mode-watcher';
	import { toastForm } from '#lib/form.js';
	import { KIND_LABEL, PROTOCOL_LABEL, TEAM_LABEL, recentlyActive, relative, tokens, vendorColor } from '#lib/labels.js';

	let { data } = $props();
	const viewer = $derived(data.viewer);
	const me = $derived(data.profile.member);
	const own = $derived(me.name === viewer.name);
	const isAdmin = $derived(viewer.role === 'admin');
	const keys = $derived(data.devices.filter((d) => d.kind === 'key'));
	const devices = $derived(data.devices.filter((d) => d.kind !== 'key'));

	const loginHint: Record<string, string> = {
		claude: '终端运行 claude，输入 /login，选择 Claude 账号，在浏览器里登录',
		codex: '终端运行 codex login，在浏览器里用 ChatGPT 账号登录',
		qoder: '打开 Qoder，点右上角登录'
	};

	let keyOpen = $state(false);
	let issued = $state<string | null>(null);
	let logout = $state<HTMLFormElement>();
</script>

<svelte:head><title>我的工作台 · {data.productName}</title></svelte:head>

<div class="bg-muted/30 min-h-svh">
	<header class="bg-background sticky top-0 z-10 border-b">
		<div class="mx-auto flex h-14 max-w-5xl items-center gap-3 px-4">
			<a href="/me" class="flex items-center gap-2.5">
				<img src="/logo.svg" alt="" class="size-7" />
				<span class="font-semibold whitespace-nowrap">{data.productName}</span>
				<span class="text-muted-foreground hidden text-sm sm:inline">我的工作台</span>
			</a>
			<div class="ml-auto flex items-center gap-2">
				{#if isAdmin}<Button variant="outline" size="sm" href="/"><ArrowLeft />返回管理后台</Button>{/if}
				<DropdownMenu.Root>
					<DropdownMenu.Trigger>
						{#snippet child({ props })}
							<button {...props} class="hover:bg-muted flex items-center gap-2 rounded-md p-1 pr-2" aria-label="账号菜单">
								<Avatar.Root class="size-7">
									<Avatar.Image src="https://avatars.githubusercontent.com/u/{viewer.githubId}?s=56" alt="" />
									<Avatar.Fallback class="bg-primary/10 text-primary text-xs">{viewer.displayName.slice(0, 1)}</Avatar.Fallback>
								</Avatar.Root>
								<span class="hidden text-sm sm:inline">{viewer.displayName}</span>
							</button>
						{/snippet}
					</DropdownMenu.Trigger>
					<DropdownMenu.Content align="end" class="w-52">
						<DropdownMenu.Label class="font-normal"><div class="text-sm font-medium">{viewer.displayName}</div><div class="text-muted-foreground text-xs">GitHub @{viewer.githubLogin}</div></DropdownMenu.Label>
						<DropdownMenu.Separator />
						{#if isAdmin}<DropdownMenu.Item>{#snippet child({ props })}<a href="/" {...props}><Shield />管理后台</a>{/snippet}</DropdownMenu.Item>{/if}
						<DropdownMenu.Item onclick={toggleMode}><SunMoon />切换深浅色</DropdownMenu.Item>
						<DropdownMenu.Separator />
						<DropdownMenu.Item variant="destructive" onclick={() => logout?.requestSubmit()}><LogOut />退出登录</DropdownMenu.Item>
					</DropdownMenu.Content>
				</DropdownMenu.Root>
			</div>
		</div>
	</header>
	<form bind:this={logout} method="POST" action="/logout" hidden></form>

	{#if isAdmin}
		<div class="border-b bg-sky-50 dark:bg-sky-950/30">
			<div class="mx-auto flex max-w-5xl flex-wrap items-center gap-2 px-4 py-2 text-sm">
				<Eye class="size-4 text-sky-600" />
				<span>管理员预览：查看</span>
				<Choice class="bg-background h-8 w-32" options={data.members.map((m) => ({ value: m.name, label: m.name === viewer.name ? `${m.displayName}（我）` : m.displayName }))}
					bind:value={() => me.name, (name) => goto(name === viewer.name ? '/me' : `/me?as=${name}`)} />
				<span class="text-muted-foreground">看到的工作台{own ? '' : '（只读）'}</span>
				{#if !own}<Button variant="link" size="sm" href="/me">回到我自己</Button>{/if}
			</div>
		</div>
	{/if}

	<main class="mx-auto max-w-5xl space-y-6 p-4 md:p-6">
		<div class="flex items-center gap-4">
			<Avatar.Root class="size-12">
				<Avatar.Image src="https://avatars.githubusercontent.com/u/{me.githubId}?s=96" alt="" />
				<Avatar.Fallback class="bg-primary/10 text-primary text-lg">{me.displayName.slice(0, 1)}</Avatar.Fallback>
			</Avatar.Root>
			<div>
				<h1 class="text-xl font-semibold">{own ? `你好，${me.displayName}` : `${me.displayName} 的工作台`}</h1>
				<p class="text-muted-foreground text-sm">{me.team ? `${TEAM_LABEL[me.team]} · ` : ''}GitHub @{me.githubLogin} · 近 30 天经公司网关用了 {tokens(data.tokens30d)} tokens</p>
			</div>
		</div>

		<section class="space-y-3">
			<h2 class="font-semibold">{own ? '我的 AI 资源' : 'AI 资源'}</h2>
			<div class="grid gap-4 md:grid-cols-2">
				{#each data.profile.vendors as v (v.vendor)}
					<Card.Root>
						<Card.Header>
							<Card.Title class="flex items-center gap-2"><span class="size-2.5 rounded-full" style="background: {vendorColor(v.vendor)}"></span>{v.name}</Card.Title>
							<Card.Description>{v.mode === 'account' ? '公司订阅账号' : v.mode === 'dedicated' ? '独立 Key（经公司网关）' : '公司共享 Key（经公司网关）'}</Card.Description>
						</Card.Header>
						<Card.Content class="space-y-3 text-sm">
							{#if v.auth === 'account'}
								{#if v.account}
									<div>登录账号</div>
									<CopyField value={v.account.account} />
									<div class="text-muted-foreground flex gap-2"><LogIn class="mt-0.5 size-4 shrink-0" />{loginHint[v.vendor] ?? '在厂商的官方客户端登录'}。密码由管理员单独提供，公司系统不保存密码。</div>
									{#if v.account.plan}<div class="text-muted-foreground text-xs">{v.account.plan}</div>{/if}
								{:else}
									<div class="flex items-center gap-2 text-amber-600"><Clock class="size-4" />还在分配中：订阅席位满了，管理员加席位后自动分给你</div>
								{/if}
							{:else if !v.key}
								<div class="flex items-center gap-2 text-amber-600"><Clock class="size-4" />还在分配中，管理员录入 Key 后自动可用</div>
							{:else if v.models.length === 0}
								<div class="flex items-center gap-2 text-amber-600"><Clock class="size-4" />管理员还没有开放模型</div>
							{:else}
								<div class="text-muted-foreground">GL Work 桌面端里已自动配置好。在其他工具里用这个地址，Key 填你的内部 Key：</div>
								<CopyField value={v.url ?? ''} />
								<div class="text-muted-foreground text-xs">{v.protocol ? PROTOCOL_LABEL[v.protocol] : ''}协议 · 可用模型：{v.models.map((m) => m.id).join('、')}</div>
							{/if}
						</Card.Content>
					</Card.Root>
				{:else}
					<p class="text-muted-foreground text-sm">还没有开通任何 AI 资源，请联系管理员。</p>
				{/each}
			</div>
		</section>

		<section class="space-y-3">
			<div class="flex items-center justify-between">
				<div><h2 class="font-semibold">内部 Key</h2><p class="text-muted-foreground text-sm">在 Claude Code、脚本里代表你：调用你开通的模型、读取系统配置。只在生成时显示一次。</p></div>
				{#if own}<Button size="sm" onclick={() => { issued = null; keyOpen = true; }}><Plus />生成</Button>{/if}
			</div>
			<Card.Root class="py-0">
				<Table.Root>
					<Table.Body>
						{#each keys as k (k.id)}
							<Table.Row>
								<Table.Cell class="pl-4 font-medium">{k.label}</Table.Cell>
								<Table.Cell class="text-muted-foreground">{k.lastUsedAt ? `${relative(k.lastUsedAt)}使用` : '从未使用'}{k.lastIp ? ` · ${k.lastIp}` : ''}</Table.Cell>
								<Table.Cell class="pr-4 text-right">
									{#if own}
										<form method="POST" action="?/revoke" use:enhance={toastForm('已吊销')} onsubmit={(e) => { if (!confirm(`吊销 ${k.label}？用它的工具会立即失效。`)) e.preventDefault(); }}>
											<input type="hidden" name="id" value={k.id} /><Button type="submit" variant="ghost" size="sm" class="text-destructive">吊销</Button>
										</form>
									{/if}
								</Table.Cell>
							</Table.Row>
						{:else}
							<Table.Row><Table.Cell class="text-muted-foreground py-6 text-center">还没有内部 Key</Table.Cell></Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			</Card.Root>
		</section>

		<div class="grid gap-4 md:grid-cols-2">
			<section class="space-y-3">
				<h2 class="font-semibold">{own ? '我的设备' : '设备'}</h2>
				<Card.Root class="py-2">
					<Card.Content class="divide-y px-4">
						{#each devices as d (d.id)}
							<div class="flex items-center gap-3 py-2.5 text-sm">
								<KindIcon kind={d.kind} class="text-muted-foreground size-4" />
								<div class="min-w-0 flex-1"><div class="truncate">{d.label}</div><div class="text-muted-foreground text-xs">{KIND_LABEL[d.kind]} · {relative(d.lastUsedAt)}</div></div>
								{#if recentlyActive(d.lastUsedAt)}<Badge variant="outline" class="border-emerald-500/40 text-emerald-600">活跃</Badge>{/if}
								{#if own}
									<form method="POST" action="?/revoke" use:enhance={toastForm('已退出')} onsubmit={(e) => { if (!confirm(`让 ${d.label} 退出登录？`)) e.preventDefault(); }}>
										<input type="hidden" name="id" value={d.id} /><Button type="submit" variant="ghost" size="sm">退出</Button>
									</form>
								{/if}
							</div>
						{:else}
							<p class="text-muted-foreground py-4 text-center text-sm">没有登录中的设备</p>
						{/each}
					</Card.Content>
				</Card.Root>
			</section>
			<section class="space-y-3">
				<h2 class="font-semibold">系统配置</h2>
				<Card.Root class="py-2">
					<Card.Content class="divide-y px-4">
						{#each data.config as c (c.key)}
							<div class="flex items-center justify-between gap-3 py-2 text-sm">
								<span class="font-mono text-xs">{c.key}</span>
								<span class="text-muted-foreground truncate font-mono text-xs">{#if c.secret}<Lock class="mr-1 inline size-3" />已加密 · 用内部 Key 读取{:else}{c.value}{/if}</span>
							</div>
						{:else}
							<p class="text-muted-foreground py-4 text-center text-sm">还没有系统配置</p>
						{/each}
					</Card.Content>
				</Card.Root>
			</section>
		</div>

		<section class="space-y-2">
			<h2 class="font-semibold">内网穿透</h2>
			<p class="text-muted-foreground text-sm">{me.tunnels ? '已开通网页隧道' : '还没有开通网页隧道'}{me.ssh ? '和 SSH 隧道' : ''}。功能上线后，在 GL Work 的插件管理里安装“内网穿透”插件即可使用。</p>
		</section>
	</main>
</div>

<Dialog.Root bind:open={keyOpen}>
	<Dialog.Content class="sm:max-w-xl">
		<Dialog.Header>
			<Dialog.Title>{issued ? '内部 Key 已生成' : '生成内部 Key'}</Dialog.Title>
			<Dialog.Description>你个人的公司网关凭据：调用你开通的 API 厂商、读取系统配置。</Dialog.Description>
		</Dialog.Header>
		{#if issued}
			<IssuedKey token={issued} gateway={data.profile.gateway} />
			<Dialog.Footer><Button onclick={() => (keyOpen = false)}>我已保存</Button></Dialog.Footer>
		{:else}
			<form method="POST" action="?/issueKey" use:enhance={toastForm(undefined, (d) => { issued = String((d?.issued as { token?: string } | undefined)?.token ?? ''); })} class="grid gap-4">
				<Field label="用途" id="ik-label" hint="方便以后认出它，例如“Claude Code”“CI 脚本”"><Input id="ik-label" name="label" required /></Field>
				<Dialog.Footer><Button type="button" variant="outline" onclick={() => (keyOpen = false)}>取消</Button><Button type="submit">生成</Button></Dialog.Footer>
			</form>
		{/if}
	</Dialog.Content>
</Dialog.Root>
