<script lang="ts">
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import * as Tooltip from '#lib/components/ui/tooltip/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import * as Tabs from '#lib/components/ui/tabs/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Progress } from '#lib/components/ui/progress/index.js';
	import Choice from '#lib/components/app/choice.svelte';
	import CopyField from '#lib/components/app/copy-field.svelte';
	import StatusDot from '#lib/components/app/status-dot.svelte';
	import MessageSquare from '@lucide/svelte/icons/message-square';
	import CalendarClock from '@lucide/svelte/icons/calendar-clock';
	import Puzzle from '@lucide/svelte/icons/puzzle';
	import Waypoints from '@lucide/svelte/icons/waypoints';
	import Settings from '@lucide/svelte/icons/settings';
	import Plus from '@lucide/svelte/icons/plus';
	import Copy from '@lucide/svelte/icons/copy';
	import PanelRight from '@lucide/svelte/icons/panel-right';
	import Ellipsis from '@lucide/svelte/icons/ellipsis';
	import Lock from '@lucide/svelte/icons/lock';
	import Globe from '@lucide/svelte/icons/globe';
	import Terminal from '@lucide/svelte/icons/square-terminal';
	import CircleCheck from '@lucide/svelte/icons/circle-check';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import ShieldCheck from '@lucide/svelte/icons/shield-check';
	import Package from '@lucide/svelte/icons/package';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import RotateCw from '@lucide/svelte/icons/rotate-cw';
	import FlaskConical from '@lucide/svelte/icons/flask-conical';
	import Info from '@lucide/svelte/icons/info';
	import { toast } from 'svelte-sonner';
	import { bytes, canConnect, db, defaultDomain, log, memberOf, relative, tunnelHost, usableDomains, type CompanyPlugin, type Tunnel } from '#lib/mock/data.svelte.js';

	let who = $state(memberOf(db.me)?.status === 'active' ? db.me : 'chenjie');
	const member = $derived(memberOf(who));
	const device = $derived(db.devices.find((d) => d.member === who && d.kind === 'desktop'));
	const installed = $derived(!!device?.plugins?.tunnel);
	const mine = $derived(db.tunnels.filter((t) => t.member === who));
	const shared = $derived(db.tunnels.filter((t) => canConnect(t, who)));
	let panel = $state<'tunnel' | 'plugins'>('tunnel');
	let preview = $state<Tunnel | null>(null);

	$effect(() => {
		if (!installed && panel === 'tunnel') panel = 'plugins';
	});

	// Plugin install
	let installing = $state<CompanyPlugin | null>(null);
	let progress = $state<number | null>(null);
	async function install() {
		if (!installing || !device) return;
		const plugin = installing;
		for (progress = 0; progress < 100; progress += 20) await new Promise((r) => setTimeout(r, 180));
		device.plugins = { ...device.plugins, [plugin.id]: plugin.version };
		log('安装插件', plugin.name, `${who} · ${device.label}`);
		installing = null;
		progress = null;
		panel = 'tunnel';
		toast.success(`已安装 ${plugin.name}`, { description: '侧边栏里多了一个入口' });
	}
	function uninstall(p: CompanyPlugin) {
		if (!device?.plugins) return;
		const { [p.id]: _, ...rest } = device.plugins;
		device.plugins = rest;
		for (const t of mine) t.online = false;
		log('卸载插件', p.name, who);
		toast.success(`已卸载 ${p.name}`, { description: '隧道已全部断开，frpc 已删除' });
	}

	// New tunnel
	let creating = $state(false);
	let form = $state({ type: 'http', name: '', port: '', domain: '', protection: 'public', password: '', access: 'some', people: [] as string[], publicPort: false, auto: true });
	const LISTENING = [22, 3000, 4010, 5173, 8000, 8080];
	const portState = $derived(form.port === '' ? null : LISTENING.includes(Number(form.port)) ? 'listening' : 'idle');
	const sshAllowed = $derived(!!member?.ssh && db.tunnelSettings.ssh);

	function startCreate() {
		if (mine.length >= db.tunnelSettings.perMember) return toast.error(`每人最多 ${db.tunnelSettings.perMember} 条隧道`);
		form = { type: 'http', name: '', port: '', domain: defaultDomain(), protection: db.tunnelSettings.allowPublic ? 'public' : 'password', password: '', access: 'some', people: [], publicPort: false, auto: true };
		creating = true;
	}
	function setType(type: string) {
		form.type = type;
		form.port = type === 'ssh' ? '22' : '';
	}
	function create() {
		if (!/^[a-z][a-z0-9-]{0,30}$/.test(form.name)) return toast.error('名字只能用小写字母、数字和 -，以字母开头');
		const port = Number(form.port);
		if (!Number.isInteger(port) || port < 1 || port > 65535) return toast.error('请填写本机端口');
		const ssh = form.type === 'ssh';
		if (!ssh && form.protection === 'password' && form.password.length < 6) return toast.error('访问密码至少 6 位');
		if (ssh && form.access === 'some' && form.people.length === 0 && !form.publicPort) return toast.error('请选择可以连接的同事');
		const t: Tunnel = {
			id: `t_${Date.now()}`, member: who, device: device?.id ?? '', type: ssh ? 'ssh' : 'http', name: form.name, domain: ssh ? '' : form.domain, localPort: port,
			protection: form.protection as Tunnel['protection'], online: true, traffic24h: 0, requests24h: 0, createdAt: Date.now(), lastSeenAt: Date.now(),
			...(ssh ? { sshAccess: form.access === 'all' ? 'all' : form.people, ...(form.publicPort ? { publicPort: 20000 + Math.floor(Math.random() * 100) } : {}) } : {}),
		};
		db.tunnels.push(t);
		log('新建隧道', tunnelHost(t), `${ssh ? 'SSH' : '网页'} · 本机 ${port}`);
		creating = false;
		toast.success('隧道已开启', { description: ssh ? '有权限的同事可以在“连接 SSH”里连接' : `https://${tunnelHost(t)}` });
	}
	function toggle(t: Tunnel, on: boolean) {
		t.online = on;
		t.lastSeenAt = Date.now();
		log(on ? '开启隧道' : '关闭隧道', tunnelHost(t));
	}
	function remove(t: Tunnel) {
		db.tunnels.splice(db.tunnels.indexOf(t), 1);
		if (preview === t) preview = null;
		log('删除隧道', tunnelHost(t));
	}
	const accessLabel = (t: Tunnel) => t.publicPort ? `公网端口 ${t.publicPort}` : t.sshAccess === 'all' ? '全部成员可连' : `${(t.sshAccess ?? []).map((n) => memberOf(n)?.displayName).join('、')} 可连`;

	// SSH visitors
	const connection = (t: Tunnel) => db.sshConnections.find((c) => c.tunnel === t.id && c.member === who);
	function connect(t: Tunnel) {
		db.sshConnections.push({ tunnel: t.id, member: who, localPort: 62200 + Math.floor(Math.random() * 99), since: Date.now() });
		log('连接 SSH 隧道', tunnelHost(t), who);
	}
	function disconnect(t: Tunnel) {
		const c = connection(t);
		if (c) db.sshConnections.splice(db.sshConnections.indexOf(c), 1);
	}
</script>

<div class="bg-muted/60 flex min-h-svh flex-col items-center gap-4 p-4 md:p-8">
	<div class="text-muted-foreground flex w-full max-w-6xl flex-wrap items-center gap-3 text-sm">
		<FlaskConical class="size-4" />原型：GL Work 桌面端 · 按需安装的“内网穿透”插件
		<span class="ml-auto">以</span>
		<Choice bind:value={who} class="h-8 w-28 bg-background" options={db.members.filter((m) => m.status === 'active').map((m) => ({ value: m.name, label: m.displayName }))} />
		<span>的电脑查看</span>
		<Button variant="outline" size="sm" href={memberOf(db.me)?.role === 'admin' ? '/tunnels' : '/me'}><ArrowLeft />返回</Button>
	</div>

	<div class="bg-background flex h-[720px] w-full max-w-6xl flex-col overflow-hidden rounded-xl border shadow-2xl">
		<div class="relative flex h-10 shrink-0 items-center border-b px-3">
			<div class="flex gap-2"><span class="size-3 rounded-full bg-[#ff5f57]"></span><span class="size-3 rounded-full bg-[#febc2e]"></span><span class="size-3 rounded-full bg-[#28c840]"></span></div>
			<div class="text-muted-foreground absolute left-1/2 -translate-x-1/2 text-xs">GL Work</div>
		</div>
		<div class="flex min-h-0 flex-1">
			<!-- Icon rail -->
			<div class="bg-muted/40 flex w-12 shrink-0 flex-col items-center gap-1 border-r py-2">
				<img src="/logo.svg" alt="" class="mb-2 size-6" />
				{#each [{ icon: MessageSquare, label: '会话' }, { icon: CalendarClock, label: '计划任务' }] as item (item.label)}
					<Tooltip.Root><Tooltip.Trigger class="text-muted-foreground hover:bg-muted rounded-md p-2"><item.icon class="size-4" /></Tooltip.Trigger><Tooltip.Content side="right">{item.label}</Tooltip.Content></Tooltip.Root>
				{/each}
				<Tooltip.Root>
					<Tooltip.Trigger class="rounded-md p-2 {panel === 'plugins' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted'}" onclick={() => (panel = 'plugins')}><Puzzle class="size-4" /></Tooltip.Trigger>
					<Tooltip.Content side="right">插件</Tooltip.Content>
				</Tooltip.Root>
				{#if installed}
					<Tooltip.Root>
						<Tooltip.Trigger class="relative rounded-md p-2 {panel === 'tunnel' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted'}" onclick={() => (panel = 'tunnel')}>
							<Waypoints class="size-4" />
							{#if mine.some((t) => t.online)}<span class="absolute top-1 right-1 size-1.5 rounded-full bg-emerald-500"></span>{/if}
						</Tooltip.Trigger>
						<Tooltip.Content side="right">内网穿透</Tooltip.Content>
					</Tooltip.Root>
				{/if}
				<div class="mt-auto"><span class="text-muted-foreground block p-2"><Settings class="size-4" /></span></div>
			</div>

			<!-- Panel -->
			<div class="flex w-80 shrink-0 flex-col border-r">
				{#if panel === 'plugins'}
					<div class="flex h-12 items-center border-b px-4 font-medium">插件</div>
					<div class="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
						<div class="text-muted-foreground text-xs font-medium">公司插件</div>
						{#each db.plugins as p (p.id)}
							{@const has = !!device?.plugins?.[p.id]}
							<div class="space-y-2 rounded-lg border p-3">
								<div class="flex items-center gap-2">
									<Package class="text-muted-foreground size-4" />
									<span class="font-medium">{p.name}</span>
									<span class="text-muted-foreground font-mono text-[11px]">{p.version}</span>
									{#if p.mode === 'preinstalled'}<Badge variant="secondary" class="ml-auto">预装</Badge>{/if}
								</div>
								<p class="text-muted-foreground text-xs">{p.description}</p>
								{#if p.mode === 'optional'}
									<div class="flex items-center justify-between">
										<span class="text-muted-foreground text-[11px]">{p.size}</span>
										{#if has}
											<Button size="xs" variant="ghost" onclick={() => uninstall(p)}>卸载</Button>
										{:else}
											<Button size="xs" onclick={() => (installing = p)}>安装</Button>
										{/if}
									</div>
								{/if}
							</div>
						{/each}
					</div>
				{:else}
					<div class="flex h-12 items-center justify-between border-b px-4">
						<span class="font-medium">内网穿透</span>
						{#if db.tunnelSettings.enabled && (member?.tunnels || sshAllowed) && !creating}
							<Button size="icon-sm" variant="ghost" onclick={startCreate} aria-label="新建隧道"><Plus /></Button>
						{/if}
					</div>
					<Tabs.Root value="mine" class="flex min-h-0 flex-1 flex-col gap-0">
						<Tabs.List class="mx-4 mt-3 w-auto">
							<Tabs.Trigger value="mine">我的隧道</Tabs.Trigger>
							<Tabs.Trigger value="connect">连接 SSH{#if shared.length}（{shared.length}）{/if}</Tabs.Trigger>
						</Tabs.List>

						<Tabs.Content value="mine" class="min-h-0 flex-1 overflow-y-auto">
							{#if !db.tunnelSettings.enabled}
								<p class="text-muted-foreground p-6 text-center text-sm">管理员已关闭内网穿透。</p>
							{:else if !member?.tunnels && !sshAllowed}
								<div class="space-y-2 p-6 text-center text-sm">
									<Waypoints class="text-muted-foreground mx-auto size-8" />
									<p>你还没有开通内网穿透</p>
									<p class="text-muted-foreground text-xs">需要时请联系管理员开通。你仍然可以在“连接 SSH”里连同事共享给你的电脑。</p>
								</div>
							{:else}
								{#if creating}
									<div class="bg-muted/40 mt-3 space-y-3 border-y p-4">
										<div class="grid gap-1.5">
											<Label class="text-xs">类型</Label>
											<Choice class="h-8 w-full" bind:value={() => form.type, setType} options={[
												{ value: 'http', label: '网页（HTTP）', disabled: !member?.tunnels },
												{ value: 'ssh', label: sshAllowed ? 'SSH（让同事连我的电脑）' : 'SSH（未开通）', disabled: !sshAllowed },
											]} />
										</div>
										<div class="grid gap-1.5">
											<Label for="t-name" class="text-xs">名字</Label>
											<Input id="t-name" bind:value={form.name} placeholder={form.type === 'ssh' ? 'mbp' : 'shop-h5'} class="h-8 font-mono text-sm" />
										</div>
										{#if form.type === 'http'}
											<div class="grid gap-1.5">
												<Label class="text-xs">域名</Label>
												<Choice bind:value={form.domain} class="h-8 w-full" options={usableDomains().map((d) => ({ value: d.name, label: d.name }))} />
												<p class="text-muted-foreground font-mono text-[11px] break-all">https://{form.name || '名字'}-{who}.{form.domain}</p>
											</div>
										{/if}
										<div class="grid gap-1.5">
											<Label for="t-port" class="text-xs">本机端口</Label>
											<Input id="t-port" bind:value={form.port} placeholder="5173" inputmode="numeric" class="h-8 font-mono text-sm" />
											{#if portState === 'listening'}<p class="flex items-center gap-1 text-[11px] text-emerald-600"><CircleCheck class="size-3" />127.0.0.1:{form.port} 有服务在监听</p>
											{:else if portState === 'idle'}<p class="flex items-center gap-1 text-[11px] text-amber-600"><TriangleAlert class="size-3" />本机 {form.port} 端口现在没有服务{form.type === 'ssh' ? '，请先在系统设置里打开“远程登录”' : ''}</p>{/if}
										</div>
										{#if form.type === 'http'}
											<div class="grid gap-1.5">
												<Label class="text-xs">访问</Label>
												<Choice bind:value={form.protection} class="h-8 w-full" options={[{ value: 'public', label: '公开（知道地址就能访问）', disabled: !db.tunnelSettings.allowPublic }, { value: 'password', label: '需要密码' }]} />
												{#if form.protection === 'password'}<Input bind:value={form.password} type="password" placeholder="访问密码，至少 6 位" class="h-8 text-sm" />{/if}
											</div>
										{:else}
											<div class="grid gap-1.5">
												<Label class="text-xs">谁可以连接</Label>
												<Choice bind:value={form.access} class="h-8 w-full" options={[{ value: 'some', label: '指定同事' }, { value: 'all', label: '全部成员' }]} />
												{#if form.access === 'some'}
													<div class="grid grid-cols-2 gap-1 rounded-md border p-2">
														{#each db.members.filter((m) => m.status === 'active' && m.name !== who) as m (m.name)}
															<label class="flex items-center gap-1.5 text-xs">
																<Checkbox checked={form.people.includes(m.name)} onCheckedChange={(on) => (form.people = on ? [...form.people, m.name] : form.people.filter((x) => x !== m.name))} />{m.displayName}
															</label>
														{/each}
													</div>
												{/if}
												{#if db.tunnelSettings.publicTcp}
													<label class="flex items-start gap-1.5 text-xs"><Checkbox bind:checked={form.publicPort} class="mt-0.5" /><span>同时开放公网端口<span class="block text-amber-600">任何人都能尝试连接，务必只允许密钥登录</span></span></label>
												{/if}
												<p class="text-muted-foreground flex gap-1 text-[11px]"><ShieldCheck class="size-3 shrink-0" />同事要在 GL Work 里登录公司账号才能连，服务器不开公网端口。建议本机 SSH 只允许密钥登录。</p>
											</div>
										{/if}
										<label class="flex items-center gap-2 text-xs"><Checkbox bind:checked={form.auto} />GL Work 启动时自动连接</label>
										<div class="flex justify-end gap-2">
											<Button size="sm" variant="ghost" onclick={() => (creating = false)}>取消</Button>
											<Button size="sm" onclick={create}>创建并开启</Button>
										</div>
									</div>
								{/if}

								{#each mine as t (t.id)}
									<div class="space-y-2 border-b p-4 {preview === t ? 'bg-primary/5' : ''}">
										<div class="flex items-center gap-2">
											{#if t.type === 'ssh'}<Terminal class="text-muted-foreground size-4" />{/if}
											<span class="font-medium">{t.name}</span>
											{#if t.type === 'http'}{#if t.protection === 'password'}<Lock class="text-muted-foreground size-3.5" />{:else}<Globe class="size-3.5 text-amber-600" />{/if}{/if}
											<Switch class="ml-auto" checked={t.online} onCheckedChange={(on) => toggle(t, on)} />
										</div>
										{#if t.type === 'http'}
											<div class="text-muted-foreground font-mono text-[11px] break-all {t.online ? '' : 'opacity-50'}">https://{tunnelHost(t)}</div>
										{:else}
											<div class="text-muted-foreground text-[11px]">{accessLabel(t)}</div>
										{/if}
										<div class="flex items-center gap-1">
											<span class="text-muted-foreground text-xs">→ 本机 {t.localPort}{t.online ? ` · ${bytes(t.traffic24h)}` : ' · 已关闭'}</span>
											{#if t.type === 'http'}
												<Button class="ml-auto" size="icon-xs" variant="ghost" onclick={() => { navigator.clipboard?.writeText(`https://${tunnelHost(t)}`).catch(() => undefined); toast.success('已复制地址'); }} aria-label="复制地址"><Copy /></Button>
												<Button size="icon-xs" variant="ghost" disabled={!t.online} onclick={() => (preview = t)} aria-label="在侧边栏预览"><PanelRight /></Button>
											{/if}
											<DropdownMenu.Root>
												<DropdownMenu.Trigger>{#snippet child({ props })}<Button size="icon-xs" variant="ghost" class={t.type === 'ssh' ? 'ml-auto' : ''} {...props} aria-label="更多"><Ellipsis /></Button>{/snippet}</DropdownMenu.Trigger>
												<DropdownMenu.Content align="end">
													<DropdownMenu.Item onclick={() => toast.info('原型：编辑端口、访问方式')}>编辑</DropdownMenu.Item>
													<DropdownMenu.Item variant="destructive" onclick={() => remove(t)}>删除</DropdownMenu.Item>
												</DropdownMenu.Content>
											</DropdownMenu.Root>
										</div>
									</div>
								{:else}
									{#if !creating}
										<div class="space-y-3 p-6 text-center text-sm">
											<p class="text-muted-foreground">把本机的网页服务发布到公网，或者让同事连你电脑的 SSH。</p>
											<Button size="sm" onclick={startCreate}><Plus />新建隧道</Button>
										</div>
									{/if}
								{/each}
							{/if}
						</Tabs.Content>

						<Tabs.Content value="connect" class="min-h-0 flex-1 overflow-y-auto">
							{#each shared as t (t.id)}
								{@const c = connection(t)}
								<div class="space-y-2 border-b p-4">
									<div class="flex items-center gap-2">
										<Terminal class="text-muted-foreground size-4" />
										<span class="font-medium">{memberOf(t.member)?.displayName} 的 {t.name}</span>
										<span class="ml-auto text-xs"><StatusDot online={t.online} /></span>
									</div>
									{#if c}
										<div class="text-muted-foreground text-[11px]">已在本机 127.0.0.1:{c.localPort} 打开，{relative(c.since)}连接</div>
										<CopyField value="ssh -p {c.localPort} 用户名@127.0.0.1" />
										<div class="flex justify-end"><Button size="xs" variant="ghost" onclick={() => disconnect(t)}>断开</Button></div>
									{:else}
										<div class="flex items-center justify-between">
											<span class="text-muted-foreground text-[11px]">{t.online ? '可以连接' : '对方的 GL Work 没有在线'}</span>
											<Button size="xs" disabled={!t.online} onclick={() => connect(t)}>连接</Button>
										</div>
									{/if}
								</div>
							{:else}
								<p class="text-muted-foreground p-6 text-center text-sm">还没有同事把 SSH 共享给你。</p>
							{/each}
						</Tabs.Content>
					</Tabs.Root>

					<div class="text-muted-foreground space-y-1 border-t p-3 text-[11px] leading-relaxed">
						<div class="flex items-center gap-1.5"><StatusDot online={true} label="frpc {db.frps.version} · 已连接 agent.glgwork.com" /></div>
						<div class="flex gap-1.5"><Info class="mt-0.5 size-3 shrink-0" /><span>只转发到本机（127.0.0.1）。关闭 GL Work 后隧道自动断开。</span></div>
					</div>
				{/if}
			</div>

			<!-- Main area -->
			<div class="flex min-w-0 flex-1 flex-col">
				{#if preview}
					<div class="flex h-12 items-center gap-2 border-b px-3">
						<Button size="icon-sm" variant="ghost" aria-label="刷新"><RotateCw /></Button>
						<div class="bg-muted flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-3 py-1.5 font-mono text-xs">
							<Lock class="size-3 shrink-0 text-emerald-600" /><span class="truncate">https://{tunnelHost(preview)}</span>
						</div>
						<Button size="sm" variant="ghost" onclick={() => (preview = null)}>关闭</Button>
					</div>
					<div class="flex flex-1 flex-col items-center justify-center gap-3 bg-gradient-to-br from-slate-50 to-sky-50 dark:from-slate-900 dark:to-sky-950">
						<div class="text-4xl font-bold tracking-tight">{preview.name}</div>
						<div class="text-muted-foreground text-sm">你本机 {preview.localPort} 端口上的页面会显示在这里</div>
					</div>
				{:else}
					<div class="flex h-12 items-center border-b px-4 text-sm font-medium">新会话</div>
					<div class="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-2 text-sm">
						<img src="/logo.svg" alt="" class="size-12 opacity-80" />
						<div class="text-foreground text-lg font-semibold">高效工作，努力赚钱。</div>
					</div>
				{/if}
			</div>
		</div>
	</div>
</div>

<Dialog.Root open={installing !== null} onOpenChange={(o) => { if (!o && progress === null) installing = null; }}>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>安装“{installing?.name}”？</Dialog.Title>
			<Dialog.Description>由 GL Work 团队提供 · {installing?.version} · {installing?.size}</Dialog.Description>
		</Dialog.Header>
		<div class="space-y-2 text-sm">
			<div class="font-medium">安装后，这个插件可以：</div>
			<ul class="text-muted-foreground list-disc space-y-1 pl-5">{#each installing?.permissions ?? [] as perm (perm)}<li>{perm}</li>{/each}</ul>
			<p class="text-muted-foreground text-xs">随时可以在插件管理里卸载，卸载时会删除 frpc 并断开所有隧道。</p>
			{#if progress !== null}<div class="space-y-1 pt-2"><Progress value={progress} /><div class="text-muted-foreground text-xs">正在下载 frpc（{device?.detail.includes('Windows') ? 'windows-x64' : 'darwin-arm64'}）…</div></div>{/if}
		</div>
		<Dialog.Footer>
			<Button variant="outline" disabled={progress !== null} onclick={() => (installing = null)}>取消</Button>
			<Button disabled={progress !== null} onclick={install}>安装</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
