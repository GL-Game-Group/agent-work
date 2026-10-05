<script lang="ts">
	import { enhance } from '$app/forms';
	import * as Card from '#lib/components/ui/card/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import * as Tabs from '#lib/components/ui/tabs/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import PageHeader from '#lib/components/app/page-header.svelte';
	import StatCard from '#lib/components/app/stat-card.svelte';
	import MemberCell from '#lib/components/app/member-cell.svelte';
	import StatusDot from '#lib/components/app/status-dot.svelte';
	import Field from '#lib/components/app/field.svelte';
	import CopyField from '#lib/components/app/copy-field.svelte';
	import Choice from '#lib/components/app/choice.svelte';
	import Waypoints from '@lucide/svelte/icons/waypoints';
	import Globe2 from '@lucide/svelte/icons/earth';
	import Users from '@lucide/svelte/icons/users';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import Lock from '@lucide/svelte/icons/lock';
	import Globe from '@lucide/svelte/icons/globe';
	import Laptop from '@lucide/svelte/icons/laptop';
	import Smartphone from '@lucide/svelte/icons/smartphone';
	import Plus from '@lucide/svelte/icons/plus';
	import Ellipsis from '@lucide/svelte/icons/ellipsis';
	import CircleCheck from '@lucide/svelte/icons/circle-check';
	import CircleX from '@lucide/svelte/icons/circle-x';
	import Loader from '@lucide/svelte/icons/loader-circle';
	import Clock from '@lucide/svelte/icons/clock';
	import Ban from '@lucide/svelte/icons/ban';
	import ShieldAlert from '@lucide/svelte/icons/shield-alert';
	import Info from '@lucide/svelte/icons/info';
	import Terminal from '@lucide/svelte/icons/square-terminal';
	import { toastForm, toastResult } from '#lib/form.js';
	import { relative } from '#lib/labels.js';
	import type { SubmitFunction } from '$app/forms';

	let { data } = $props();
	type Tunnel = (typeof data.tunnels)[number];

	const members = $derived(new Map(data.members.map((m) => [m.name, m])));
	const online = $derived(data.tunnels.filter((t) => t.online));
	const usable = $derived(data.domains.filter((d) => d.dns === 'ok' && d.cert === 'ok'));
	let domainFilter = $state('all');
	let typeFilter = $state('all');
	const rows = $derived(data.tunnels.filter((t) => (typeFilter === 'all' || t.type === typeFilter) && (domainFilter === 'all' || t.domain === domainFilter)));
	const address = (t: Tunnel) => (t.type === 'remote' ? `${t.member} 的手机远程` : t.host ?? `${t.member}/${t.name}`);
	const sshAccessLabel = (t: Tunnel) => (t.sshAccess === 'all' ? '全部成员' : `指定 ${(t.sshAccess ?? []).length} 人`);
	const confirmed = (message: string) => (e: SubmitEvent) => { if (!confirm(message)) e.preventDefault(); };

	// Domains
	let addOpen = $state(false);
	let draftName = $state('');
	let checking = $state<string | null>(null);
	const check: SubmitFunction = ({ formData }) => {
		checking = String(formData.get('name'));
		const after = toastResult((d) => (d?.dns === 'ok' && d?.cert === 'ok' ? `${String(d?.name)} 可以使用了` : `${String(d?.name)} 还没有就绪`));
		return async (opts) => { await after(opts); checking = null; };
	};

	let publicTcp = $state(false);
	$effect.pre(() => { publicTcp = data.settings.publicTcp; });
</script>

{#snippet state(value: string, ok: string, bad: string, pending: string)}
	{#if value === 'ok'}<span class="inline-flex items-center gap-1 text-emerald-600"><CircleCheck class="size-3.5" />{ok}</span>
	{:else if value === 'unknown'}<span class="text-muted-foreground inline-flex items-center gap-1"><Clock class="size-3.5" />{pending}</span>
	{:else}<span class="inline-flex items-center gap-1 text-amber-600"><CircleX class="size-3.5" />{bad}</span>{/if}
{/snippet}

<PageHeader title="内网穿透" description="基于 frp。成员在 GL Work 的“内网穿透”插件里新建隧道；frps 在每次登录、开隧道和心跳时都向公司服务核对，只放行这里登记过的隧道。网页隧道把本机开发服务发布到公网，SSH 隧道让指定的同事经 GL Work 连到成员的电脑。" />

{#if data.server === null}
	<Alert.Root>
		<Info />
		<Alert.Title>还没有配置 frps</Alert.Title>
		<Alert.Description>在公司服务的环境变量里设置 AGENT_WORK_FRPS_ADDR 和 AGENT_WORK_FRP_PLUGIN_SECRET 后重启，GL Work 才能开隧道。</Alert.Description>
	</Alert.Root>
{/if}

<div class="grid gap-4 sm:grid-cols-3">
	<StatCard label="在线隧道" value={String(online.length)} hint="共 {data.tunnels.length} 条，{new Set(online.map((t) => t.device)).size} 台 GL Work 在线" icon={Waypoints} />
	<StatCard label="可用域名" value={String(usable.length)} hint={usable.find((d) => d.isDefault)?.name ?? '还没有就绪的域名'} icon={Globe2} />
	<StatCard label="已开通成员" value={String(data.members.filter((m) => m.tunnels && m.status === 'active').length)} hint="其中 {data.members.filter((m) => m.ssh && m.status === 'active').length} 人可开 SSH · 每人最多 {data.settings.perMember} 条" icon={Users} />
</div>

<Tabs.Root value="tunnels">
	<Tabs.List>
		<Tabs.Trigger value="tunnels">隧道（{data.tunnels.length}）</Tabs.Trigger>
		<Tabs.Trigger value="domains">域名（{data.domains.length}）</Tabs.Trigger>
		<Tabs.Trigger value="settings">设置</Tabs.Trigger>
	</Tabs.List>

	<Tabs.Content value="tunnels" class="space-y-3">
		<div class="flex items-center gap-2">
			<Choice bind:value={typeFilter} class="w-32" options={[{ value: 'all', label: '全部类型' }, { value: 'http', label: '网页' }, { value: 'ssh', label: 'SSH' }]} />
			<Choice bind:value={domainFilter} class="w-48" options={[{ value: 'all', label: '全部域名' }, ...data.domains.map((d) => ({ value: d.name, label: d.name }))]} />
		</div>
		<Card.Root class="py-0">
			<Table.Root>
				<Table.Header>
					<Table.Row>
						<Table.Head class="pl-4">地址</Table.Head>
						<Table.Head>类型</Table.Head>
						<Table.Head>成员 / 设备</Table.Head>
						<Table.Head>本机端口</Table.Head>
						<Table.Head>访问</Table.Head>
						<Table.Head>状态</Table.Head>
						<Table.Head>创建</Table.Head>
						<Table.Head class="w-10"></Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each rows as t (t.id)}
						{@const m = members.get(t.member)}
						<Table.Row class={t.closedBy ? 'opacity-70' : ''}>
							<Table.Cell class="pl-4">
								{#if t.host && t.type !== 'remote'}
									<a href="https://{t.host}" target="_blank" rel="noreferrer" class="inline-flex items-center gap-1 font-mono text-sm hover:underline">{t.host}<ExternalLink class="size-3" /></a>
								{:else}
									<span class="font-mono text-sm">{address(t)}</span>
								{/if}
							</Table.Cell>
							<Table.Cell>{#if t.type === 'ssh'}<Badge variant="secondary"><Terminal />SSH</Badge>{:else if t.type === 'remote'}<Badge variant="secondary"><Smartphone />手机远程</Badge>{:else}<Badge variant="outline">网页</Badge>{/if}</Table.Cell>
							<Table.Cell>
								<MemberCell name={t.member} displayName={m?.displayName} githubId={m?.githubId} sub={false} />
								<div class="text-muted-foreground mt-0.5 flex items-center gap-1 pl-9 text-xs"><Laptop class="size-3" />{t.deviceRevoked ? '已吊销的设备' : (t.deviceLabel ?? '已删除的设备')}</div>
							</Table.Cell>
							<Table.Cell class="font-mono">{t.type === 'remote' ? '—' : t.localPort}</Table.Cell>
							<Table.Cell>
								{#if t.type === 'remote'}<Badge variant="secondary" title="经公司服务中转，只有成员本人登录的手机能连"><Lock />仅本人手机</Badge>
								{:else if t.type === 'ssh'}
									<div class="flex flex-wrap gap-1">
										<Badge variant="secondary" title={Array.isArray(t.sshAccess) ? t.sshAccess.join('、') : undefined}><Users />{sshAccessLabel(t)}</Badge>
										{#if t.publicPort}<Badge variant="destructive">公网 :{t.publicPort}</Badge>{/if}
									</div>
								{:else if t.protection === 'password'}<Badge variant="secondary"><Lock />密码</Badge>{:else}<Badge variant="outline" class="border-amber-500/50 text-amber-600"><Globe />公开</Badge>{/if}
							</Table.Cell>
							<Table.Cell>
								{#if t.closedBy}
									<span class="inline-flex items-center gap-1 text-sm text-red-600" title="由 {t.closedBy} 关闭"><Ban class="size-3.5" />{t.online ? '关闭中' : '已关闭'}</span>
								{:else}
									<StatusDot online={t.online} label={t.online ? '在线' : t.lastSeenAt ? `离线 · ${relative(t.lastSeenAt)}` : '未连接过'} />
								{/if}
							</Table.Cell>
							<Table.Cell class="text-muted-foreground">{relative(t.createdAt)}</Table.Cell>
							<Table.Cell>
								<DropdownMenu.Root>
									<DropdownMenu.Trigger>{#snippet child({ props })}<Button variant="ghost" size="icon-sm" {...props} aria-label="操作"><Ellipsis /></Button>{/snippet}</DropdownMenu.Trigger>
									<DropdownMenu.Content align="end">
										<form method="POST" action="?/close" use:enhance={toastForm((d) => (d?.closed ? '已关闭。正在运行的话，最迟 1 分钟内断开' : '已重新开放，成员在 GL Work 里重新打开即可'))}>
											<input type="hidden" name="id" value={t.id} />
											<input type="hidden" name="closed" value={t.closedBy ? 'false' : 'true'} />
											<DropdownMenu.Item>{#snippet child({ props })}<button {...props} type="submit" class="{props.class} w-full">{t.closedBy ? '重新开放' : '关闭'}</button>{/snippet}</DropdownMenu.Item>
										</form>
										<DropdownMenu.Item>{#snippet child({ props })}<a href="/members/{t.member}" {...props}>查看成员</a>{/snippet}</DropdownMenu.Item>
										<DropdownMenu.Separator />
										<form method="POST" action="?/delete" use:enhance={toastForm('已删除，地址已释放')} onsubmit={confirmed(`删除隧道 ${address(t)}？`)}>
											<input type="hidden" name="id" value={t.id} />
											<DropdownMenu.Item variant="destructive" disabled={t.online}>{#snippet child({ props })}<button {...props} type="submit" disabled={t.online} title={t.online ? '先关闭，断开后再删除' : undefined} class="{props.class} w-full">删除</button>{/snippet}</DropdownMenu.Item>
										</form>
									</DropdownMenu.Content>
								</DropdownMenu.Root>
							</Table.Cell>
						</Table.Row>
					{:else}
						<Table.Row><Table.Cell colspan={8} class="text-muted-foreground py-8 text-center">没有隧道</Table.Cell></Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		</Card.Root>
	</Tabs.Content>

	<Tabs.Content value="domains" class="space-y-3">
		<div class="flex flex-wrap items-center justify-between gap-2">
			<p class="text-muted-foreground text-sm">隧道地址的格式是 <span class="font-mono">名字-成员.域名</span>。成员新建网页隧道时在可用的域名里选，默认用标了“默认”的那个。</p>
			<Button onclick={() => { draftName = ''; addOpen = true; }}><Plus />添加域名</Button>
		</div>
		<Card.Root class="py-0">
			<Table.Root>
				<Table.Header>
					<Table.Row>
						<Table.Head class="pl-4">域名</Table.Head>
						<Table.Head>DNS</Table.Head>
						<Table.Head>证书</Table.Head>
						<Table.Head class="text-right">隧道</Table.Head>
						<Table.Head>备注</Table.Head>
						<Table.Head class="w-52"></Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each data.domains as d (d.name)}
						<Table.Row>
							<Table.Cell class="pl-4">
								<div class="flex items-center gap-2 font-mono text-sm">{d.name}{#if d.isDefault}<Badge>默认</Badge>{/if}</div>
								<div class="text-muted-foreground text-xs">{d.checkedAt ? `${relative(d.checkedAt)}检测` : '还没检测'}</div>
							</Table.Cell>
							<Table.Cell>{@render state(d.dns, '已解析', d.dns === 'wrong' ? '指向不对' : '未解析', '未检测')}</Table.Cell>
							<Table.Cell>{@render state(d.cert, '有效', '无效', d.dns === 'ok' ? '未检测' : '等待 DNS')}</Table.Cell>
							<Table.Cell class="text-right tabular-nums">{data.tunnels.filter((t) => t.domain === d.name).length}</Table.Cell>
							<Table.Cell class="text-muted-foreground max-w-56 truncate">{d.note ?? ''}</Table.Cell>
							<Table.Cell class="text-right">
								<div class="flex justify-end">
									<form method="POST" action="?/checkDomain" use:enhance={check}>
										<input type="hidden" name="name" value={d.name} />
										<Button type="submit" variant="ghost" size="sm" disabled={checking === d.name}>{#if checking === d.name}<Loader class="animate-spin" />{/if}检测</Button>
									</form>
									{#if !d.isDefault}
										<form method="POST" action="?/defaultDomain" use:enhance={toastForm(`默认域名改为 ${d.name}，只影响之后新建的隧道`)}>
											<input type="hidden" name="name" value={d.name} />
											<Button type="submit" variant="ghost" size="sm">设为默认</Button>
										</form>
									{/if}
									{#if !d.isDefault || data.domains.length === 1}
										<form method="POST" action="?/deleteDomain" use:enhance={toastForm('已删除')} onsubmit={confirmed(`删除域名 ${d.name}？`)}>
											<input type="hidden" name="name" value={d.name} />
											<Button type="submit" variant="ghost" size="sm" class="text-destructive">删除</Button>
										</form>
									{/if}
								</div>
							</Table.Cell>
						</Table.Row>
					{:else}
						<Table.Row><Table.Cell colspan={6} class="text-muted-foreground py-8 text-center">还没有添加域名，成员暂时不能开网页隧道</Table.Cell></Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		</Card.Root>
		<Alert.Root>
			<ShieldAlert />
			<Alert.Title>建议用单独的主域名</Alert.Title>
			<Alert.Description>
				隧道里运行的是成员本机的代码。和公司网站共用主域名时（比如 t.glgwork.com 和 www.glgwork.com），隧道页面能给公司其他网站写 cookie。
				公司服务本身不受影响，但如果还有别的公司网站，最好给隧道单独注册一个域名。
			</Alert.Description>
		</Alert.Root>
	</Tabs.Content>

	<Tabs.Content value="settings">
		<form method="POST" action="?/settings" use:enhance={toastForm('已保存')} class="grid gap-4 lg:grid-cols-2">
			<Card.Root class="h-fit">
				<Card.Header><Card.Title>通用</Card.Title></Card.Header>
				<Card.Content class="space-y-5">
					<div class="flex items-center justify-between gap-4">
						<div><Label for="s-enabled">启用内网穿透</Label><p class="text-muted-foreground text-xs">关闭后 frps 拒绝所有 GL Work，正在运行的隧道最迟 1 分钟内断开</p></div>
						<Switch id="s-enabled" name="enabled" checked={data.settings.enabled} />
					</div>
					<div class="flex items-center justify-between gap-4">
						<div><Label for="s-public">网页隧道允许公开访问</Label><p class="text-muted-foreground text-xs">关闭后每条网页隧道都必须设置访问密码</p></div>
						<Switch id="s-public" name="allowPublic" checked={data.settings.allowPublic} />
					</div>
					<div class="flex items-center justify-between gap-4">
						<div><Label for="s-remote">允许手机远程</Label><p class="text-muted-foreground text-xs">成员在 GL Work 里打开后，可以用 iPhone 上的 GL Work 远程使用自己的电脑；经公司服务中转，只有本人登录的手机能连。不占隧道数</p></div>
						<Switch id="s-remote" name="remote" checked={data.settings.remote} />
					</div>
					<Field label="每人最多隧道数" id="s-per"><Input id="s-per" name="perMember" type="number" min="1" max="50" value={data.settings.perMember} class="w-32" /></Field>
					<p class="text-muted-foreground text-xs">哪些成员可以开网页隧道、SSH 隧道，在成员详情页的“隧道”里分别设置。</p>
				</Card.Content>
			</Card.Root>

			<div class="space-y-4">
				<Card.Root>
					<Card.Header>
						<Card.Title>SSH 隧道</Card.Title>
						<Card.Description>用 frp 的 STCP：服务器不开公网端口，被允许的同事在 GL Work 里一键连接，经本机端口转发，例如 <span class="font-mono">ssh -p 62201 user@127.0.0.1</span>。</Card.Description>
					</Card.Header>
					<Card.Content class="space-y-5">
						<div class="flex items-center justify-between gap-4">
							<div><Label for="s-ssh">允许 SSH 隧道</Label><p class="text-muted-foreground text-xs">只有在成员详情里单独开通了 SSH 的成员才能开</p></div>
							<Switch id="s-ssh" name="ssh" checked={data.settings.ssh} />
						</div>
						<div class="flex items-center justify-between gap-4">
							<div><Label for="s-tcp">允许公网 TCP 端口</Label><p class="text-muted-foreground text-xs">给公司以外的人或设备连接用。端口会被全网扫描，只在确实需要时打开</p></div>
							<Switch id="s-tcp" name="publicTcp" bind:checked={publicTcp} />
						</div>
						{#if publicTcp}
							<Field label="端口范围" id="s-range" hint="frps 的 allowPorts、服务器防火墙和安全组也要放行这段端口">
								<Input id="s-range" name="portRange" value={data.settings.portRange} class="font-mono" />
							</Field>
						{/if}
					</Card.Content>
				</Card.Root>

				<Card.Root>
					<Card.Header><Card.Title>frps 服务端</Card.Title></Card.Header>
					<Card.Content class="text-muted-foreground grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm">
						{#if data.server}
							<span>客户端连接</span><span class="text-foreground font-mono">{data.server.protocol}://{data.server.addr}:{data.server.port}</span>
							<span>服务器 IP</span><span class="text-foreground font-mono">{data.publicIp ?? '未设置（AGENT_WORK_TUNNEL_IP），检测域名时只看能否解析'}</span>
							<span>在线</span><span class="text-foreground">{new Set(online.map((t) => t.device)).size} 台 GL Work 有隧道在运行</span>
						{:else}
							<span class="col-span-2">没有配置</span>
						{/if}
					</Card.Content>
				</Card.Root>
				<div class="flex justify-end"><Button type="submit">保存设置</Button></div>
			</div>
		</form>
	</Tabs.Content>
</Tabs.Root>

<Dialog.Root bind:open={addOpen}>
	<Dialog.Content class="sm:max-w-lg">
		<form method="POST" action="?/addDomain" use:enhance={toastForm((d) => `已添加 ${String(d?.domain)}，配置 DNS 后点“检测”`, () => (addOpen = false))} class="grid min-w-0 gap-4">
			<Dialog.Header>
				<Dialog.Title>添加隧道域名</Dialog.Title>
				<Dialog.Description>填你拥有的域名，隧道地址会是 <span class="font-mono">名字-成员.{draftName || '你的域名'}</span>。</Dialog.Description>
			</Dialog.Header>
			<Field label="域名" id="d-name"><Input id="d-name" name="name" bind:value={draftName} placeholder="t.example.com" class="font-mono" required /></Field>
			<Field label="备注" id="d-note"><Input id="d-note" name="note" placeholder="可选，例如 回调白名单专用" /></Field>
			<div class="min-w-0 space-y-2 text-sm">
				<div class="font-medium">添加后需要做两件事</div>
				<div class="text-muted-foreground">1. 在域名的 DNS 服务商添加一条泛解析记录，指向公司服务器（Cloudflare 上选“仅 DNS”，不要开代理）：</div>
				<CopyField value={`*.${draftName || 't.example.com'}   A   ${data.publicIp ?? '<服务器 IP>'}`} />
				<div class="text-muted-foreground">2. 在服务器上为 <span class="font-mono">*.{draftName || 't.example.com'}</span> 申请泛域名证书（DNS 验证），然后回到这里点“检测”。</div>
			</div>
			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (addOpen = false)}>取消</Button>
				<Button type="submit">添加</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
