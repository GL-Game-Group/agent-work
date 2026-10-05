<script lang="ts">
	import * as Card from '#lib/components/ui/card/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import PageHeader from '#lib/components/app/page-header.svelte';
	import StatCard from '#lib/components/app/stat-card.svelte';
	import UsageChart from '#lib/components/app/usage-chart.svelte';
	import VendorTag from '#lib/components/app/vendor-tag.svelte';
	import Users from '@lucide/svelte/icons/users';
	import MonitorSmartphone from '@lucide/svelte/icons/monitor-smartphone';
	import Sparkles from '@lucide/svelte/icons/sparkles';
	import CreditCard from '@lucide/svelte/icons/credit-card';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import CalendarClock from '@lucide/svelte/icons/calendar-clock';
	import KeyRound from '@lucide/svelte/icons/key-round';
	import ShieldAlert from '@lucide/svelte/icons/shield-alert';
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import { ACTION_LABEL, TEAM_LABEL, recentlyActive, relative, tokens } from '#lib/labels.js';

	let { data } = $props();
	const names = $derived(Object.fromEntries(data.vendors.map((v) => [v.id, v.name])));
	const memberName = (name: string | null) => data.members.find((m) => m.name === name)?.displayName ?? name ?? '系统';
	const active = $derived(data.members.filter((m) => m.status === 'active'));
	const desktops = $derived(data.devices.filter((d) => d.kind === 'device'));

	const todo = $derived([
		...(!data.overview.secretKey ? [{ icon: ShieldAlert, tone: 'text-destructive', href: '/ai/keys', text: '服务端没有设置 AGENT_WORK_SECRET_KEY', hint: '无法保存 API Key 和加密配置' }] : []),
		...data.members.flatMap((m) => m.vendors.filter((a) => (a.mode === 'account' ? a.cliAccount === null : a.apiKey === null)).map((a) => ({
			icon: TriangleAlert, tone: 'text-amber-600', href: `/members/${m.name}`,
			text: `${m.displayName} 的 ${names[a.vendor] ?? a.vendor} 还没有分到${a.mode === 'account' ? '订阅账号' : ' Key'}`,
			hint: a.mode === 'account' ? '订阅席位已满：增加账号或调整分配' : a.mode === 'dedicated' ? '没有空闲的独立 Key：录入后自动分配' : '录入 Key 后自动分配'
		}))),
		...data.subscriptions.filter((s) => s.renewsAt !== null && s.renewsAt - Date.now() < 7 * 86_400_000).map((s) => ({
			icon: CalendarClock, tone: 'text-sky-600', href: '/ai/subscriptions',
			text: `${s.plan} ${relative(s.renewsAt)}续费${s.price ? `（${s.price}）` : ''}`,
			hint: `${data.accounts.filter((a) => a.subscription === s.id && a.member).length}/${s.seats} 席在用`
		})),
		...data.keys.filter((k) => k.status === 'disabled').map((k) => ({
			icon: KeyRound, tone: 'text-muted-foreground', href: '/ai/keys', text: `${names[k.vendor] ?? k.vendor} Key「${k.label}」已停用`, hint: '确认不再使用后可以删除'
		}))
	]);
</script>

<PageHeader title="概览" description="团队 AI 资源、设备和用量的整体情况。" />

<div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
	<StatCard label="成员" value={String(active.length)} hint="{data.members.length - active.length} 人已停用 · {Object.entries(TEAM_LABEL).map(([k, v]) => `${v} ${active.filter((m) => m.team === k).length}`).join(' / ')}" icon={Users} />
	<StatCard label="桌面端" value={String(desktops.length)} hint="{desktops.filter((d) => recentlyActive(d.lastUsedAt)).length} 台最近 10 分钟活跃 · 共 {data.devices.length} 个连接" icon={MonitorSmartphone} />
	<StatCard label="近 7 天模型用量" value="{tokens(data.overview.usage7d.tokens)} tokens" hint="{data.overview.usage7d.requests.toLocaleString('zh-CN')} 次经公司网关的调用" icon={Sparkles} />
	<StatCard label="订阅席位" value="{data.accounts.filter((a) => a.member).length} / {data.subscriptions.reduce((n, s) => n + s.seats, 0)}" hint="{data.subscriptions.length} 个订阅 · 已分配 / 购买" icon={CreditCard} />
</div>

<div class="grid gap-4 lg:grid-cols-3">
	<Card.Root class="lg:col-span-2">
		<Card.Header>
			<Card.Title>近 14 天 token 用量</Card.Title>
			<Card.Description>按厂商堆叠；订阅账号（Claude、Codex、Qoder）在厂商那边计量，不在这里。</Card.Description>
		</Card.Header>
		<Card.Content><UsageChart daily={data.overview.daily} {names} /></Card.Content>
	</Card.Root>

	<Card.Root>
		<Card.Header>
			<Card.Title>需要处理</Card.Title>
			<Card.Description>{todo.length} 项</Card.Description>
		</Card.Header>
		<Card.Content class="space-y-1">
			{#each todo as item, i (i)}
				<a href={item.href} class="hover:bg-muted -mx-2 flex gap-3 rounded-md p-2">
					<item.icon class="mt-0.5 size-4 shrink-0 {item.tone}" />
					<span class="grid gap-0.5"><span class="text-sm">{item.text}</span><span class="text-muted-foreground text-xs">{item.hint}</span></span>
				</a>
			{:else}
				<p class="text-muted-foreground text-sm">一切正常。</p>
			{/each}
		</Card.Content>
	</Card.Root>
</div>

<div class="grid gap-4 lg:grid-cols-3">
	<Card.Root class="lg:col-span-2">
		<Card.Header>
			<Card.Title>AI 资源</Card.Title>
			<Card.Description>每家厂商的凭据和使用人数。</Card.Description>
			<Card.Action><Button variant="outline" size="sm" href="/ai/vendors">管理 <ArrowRight /></Button></Card.Action>
		</Card.Header>
		<Card.Content>
			<div class="divide-y">
				{#each data.vendors as v (v.id)}
					<div class="flex items-center gap-3 py-2.5 text-sm">
						<span class="w-28"><VendorTag id={v.id} name={v.name} /></span>
						<Badge variant="outline">{v.auth === 'key' ? 'API Key' : '订阅账号'}</Badge>
						<span class="text-muted-foreground flex-1 truncate">
							{#if v.auth === 'key'}{v.activeKeys} 个可用 Key · 开放 {v.models.length} 个模型
							{:else}{@const subs = data.subscriptions.filter((s) => s.vendor === v.id)}{subs.map((s) => s.plan).join('、') || '没有订阅'} · {v.accounts} 个账号{/if}
						</span>
						<span class="tabular-nums">{v.members} 人</span>
						<span class="text-muted-foreground w-20 text-right tabular-nums">{v.auth === 'key' ? tokens(v.tokens30d) : '—'}</span>
					</div>
				{/each}
			</div>
		</Card.Content>
	</Card.Root>

	<Card.Root>
		<Card.Header>
			<Card.Title>最近操作</Card.Title>
			<Card.Action><Button variant="ghost" size="sm" href="/audit">全部</Button></Card.Action>
		</Card.Header>
		<Card.Content class="space-y-3">
			{#each data.audit as e, i (i)}
				<div class="grid gap-0.5 text-sm">
					<span><span class="font-medium">{memberName(e.actor)}</span> {ACTION_LABEL[e.action] ?? e.action} <span class="font-medium">{e.target ?? ''}</span></span>
					<span class="text-muted-foreground text-xs">{relative(e.at)}{e.detail ? ` · ${e.detail}` : ''}</span>
				</div>
			{:else}
				<p class="text-muted-foreground text-sm">还没有操作记录。</p>
			{/each}
		</Card.Content>
	</Card.Root>
</div>
