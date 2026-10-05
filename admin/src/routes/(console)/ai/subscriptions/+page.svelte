<script lang="ts">
	import { enhance } from '$app/forms';
	import * as Card from '#lib/components/ui/card/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Progress } from '#lib/components/ui/progress/index.js';
	import PageHeader from '#lib/components/app/page-header.svelte';
	import Field from '#lib/components/app/field.svelte';
	import Choice from '#lib/components/app/choice.svelte';
	import VendorTag from '#lib/components/app/vendor-tag.svelte';
	import MemberCell from '#lib/components/app/member-cell.svelte';
	import Plus from '@lucide/svelte/icons/plus';
	import UserPlus from '@lucide/svelte/icons/user-plus';
	import Pencil from '@lucide/svelte/icons/pencil';
	import CalendarClock from '@lucide/svelte/icons/calendar-clock';
	import Trash from '@lucide/svelte/icons/trash-2';
	import { toastForm } from '#lib/form.js';
	import { date, dateInput, relative } from '#lib/labels.js';

	let { data } = $props();
	type Subscription = (typeof data.subscriptions)[number];
	const names = $derived(Object.fromEntries(data.vendors.map((v) => [v.id, v.name])));
	const member = (name: string | null) => data.members.find((m) => m.name === name);
	const accountsOf = (id: string | null) => data.accounts.filter((a) => a.subscription === id);
	const orphans = $derived(data.accounts.filter((a) => a.subscription === null));
	const seats = $derived(data.subscriptions.reduce((n, s) => n + s.seats, 0));
	const next = $derived([...data.subscriptions].filter((s) => s.renewsAt !== null).sort((a, b) => a.renewsAt! - b.renewsAt!)[0]);

	// Subscription dialog
	let subOpen = $state(false);
	let editing = $state<Subscription | null>(null);
	let sub = $state({ vendor: 'claude', cycle: 'monthly', owner: '' });
	function startSub(s: Subscription | null) {
		editing = s;
		sub = { vendor: s?.vendor ?? data.vendors[0]?.id ?? 'claude', cycle: s?.cycle ?? 'monthly', owner: s?.owner ?? '' };
		subOpen = true;
	}

	// Account dialog
	let accOpen = $state(false);
	let acc = $state({ subscription: '', member: '' });
	function startAccount(s: Subscription) {
		acc = { subscription: s.id, member: '' };
		accOpen = true;
	}
</script>

<PageHeader title="订阅与账号" description="公司购买的 Claude、Codex、Qoder 等订阅。只记录账号，不保存密码；一个账号同一时间只分给一个成员，成员在自己电脑上用官方流程登录。">
	{#snippet actions()}<Button onclick={() => startSub(null)} disabled={data.vendors.length === 0}><Plus />新增订阅</Button>{/snippet}
</PageHeader>

<div class="grid gap-4 sm:grid-cols-3">
	<Card.Root class="gap-1 py-4"><Card.Content class="px-4"><div class="text-muted-foreground text-sm">订阅</div><div class="text-2xl font-semibold">{data.subscriptions.length}</div><div class="text-muted-foreground truncate text-xs">{data.subscriptions.map((s) => s.plan).join('、') || '还没有订阅'}</div></Card.Content></Card.Root>
	<Card.Root class="gap-1 py-4"><Card.Content class="px-4"><div class="text-muted-foreground text-sm">席位使用</div><div class="text-2xl font-semibold">{data.accounts.filter((a) => a.member).length} / {seats}</div><div class="text-muted-foreground text-xs">已分配账号 / 购买席位</div></Card.Content></Card.Root>
	<Card.Root class="gap-1 py-4"><Card.Content class="px-4"><div class="text-muted-foreground text-sm">最近续费</div>
		{#if next}<div class="text-2xl font-semibold">{relative(next.renewsAt)}</div><div class="text-muted-foreground text-xs">{next.plan}{next.price ? ` · ${next.price}` : ''}</div>
		{:else}<div class="text-2xl font-semibold">—</div><div class="text-muted-foreground text-xs">没有登记续费日期</div>{/if}
	</Card.Content></Card.Root>
</div>

{#snippet accountRows(list: typeof data.accounts)}
	<Table.Root>
		<Table.Header><Table.Row><Table.Head class="pl-6">账号</Table.Head><Table.Head>分配给</Table.Head><Table.Head>备注</Table.Head><Table.Head class="w-40"></Table.Head></Table.Row></Table.Header>
		<Table.Body>
			{#each list as a (a.id)}
				{@const holder = member(a.member)}
				<Table.Row>
					<Table.Cell class="pl-6 font-mono text-sm">{a.account}</Table.Cell>
					<Table.Cell>{#if holder}<MemberCell name={holder.name} displayName={holder.displayName} githubId={holder.githubId} sub={false} />{:else}<Badge variant="outline">空闲</Badge>{/if}</Table.Cell>
					<Table.Cell class="text-muted-foreground">{a.note ?? ''}</Table.Cell>
					<Table.Cell class="text-right whitespace-nowrap">
						{#if holder}
							<form method="POST" action="?/release" use:enhance={toastForm('已收回，请提醒成员在本机退出这个账号')} class="inline" onsubmit={(e) => { if (!confirm(`收回 ${a.account}？${holder.displayName} 会失去这个厂商，账号转给下一个在等的人。`)) e.preventDefault(); }}>
								<input type="hidden" name="id" value={a.id} />
								<Button type="submit" variant="ghost" size="sm">收回</Button>
							</form>
						{/if}
						<form method="POST" action="?/deleteAccount" use:enhance={toastForm('已删除')} class="inline" onsubmit={(e) => { if (!confirm(`删除账号 ${a.account}？`)) e.preventDefault(); }}>
							<input type="hidden" name="id" value={a.id} />
							<Button type="submit" variant="ghost" size="sm" class="text-destructive">删除</Button>
						</form>
					</Table.Cell>
				</Table.Row>
			{:else}
				<Table.Row><Table.Cell colspan={4} class="text-muted-foreground py-6 text-center">还没有账号</Table.Cell></Table.Row>
			{/each}
		</Table.Body>
	</Table.Root>
{/snippet}

{#each data.subscriptions as s (s.id)}
	{@const list = accountsOf(s.id)}
	{@const used = list.filter((a) => a.member).length}
	{@const soon = s.renewsAt !== null && s.renewsAt - Date.now() < 7 * 86_400_000}
	<Card.Root>
		<Card.Header>
			<Card.Title class="flex flex-wrap items-center gap-2"><VendorTag id={s.vendor} name={names[s.vendor] ?? s.vendor} /><span class="text-muted-foreground">/</span>{s.plan}</Card.Title>
			<Card.Description class="flex flex-wrap items-center gap-x-4 gap-y-1">
				{#if s.price}<span>{s.price}{s.cycle === 'monthly' ? ' 每月' : ' 每年'}</span>{/if}
				{#if s.renewsAt}<span class="inline-flex items-center gap-1 {soon ? 'font-medium text-amber-600' : ''}"><CalendarClock class="size-3.5" />{date(s.renewsAt)} 续费（{relative(s.renewsAt)}）</span>{/if}
				{#if s.owner}<span>付款人 {member(s.owner)?.displayName ?? s.owner}</span>{/if}
				{#if s.note}<span>{s.note}</span>{/if}
			</Card.Description>
			<Card.Action class="flex items-center gap-2">
				<div class="hidden w-36 sm:block">
					<div class="text-muted-foreground mb-1 text-right text-xs">席位 {used}/{s.seats}</div>
					<Progress value={Math.min(100, (used / s.seats) * 100)} />
				</div>
				<Button variant="ghost" size="icon-sm" onclick={() => startSub(s)} aria-label="编辑订阅"><Pencil /></Button>
				<Button variant="outline" size="sm" onclick={() => startAccount(s)}><UserPlus />添加账号</Button>
			</Card.Action>
		</Card.Header>
		<Card.Content class="px-0">{@render accountRows(list)}</Card.Content>
	</Card.Root>
{/each}

{#if orphans.length > 0}
	<Card.Root>
		<Card.Header><Card.Title>未归入订阅的账号</Card.Title><Card.Description>订阅删除后留下的账号，或早期录入的账号。</Card.Description></Card.Header>
		<Card.Content class="px-0">{@render accountRows(orphans)}</Card.Content>
	</Card.Root>
{/if}

<Dialog.Root bind:open={subOpen}>
	<Dialog.Content class="sm:max-w-lg">
		<form method="POST" action={editing ? '?/updateSubscription' : '?/addSubscription'} use:enhance={toastForm(editing ? '已保存' : (d) => `已添加 ${String(d?.plan ?? '')}`, () => (subOpen = false))} class="grid gap-4">
			<Dialog.Header><Dialog.Title>{editing ? `编辑 ${editing.plan}` : '新增订阅'}</Dialog.Title><Dialog.Description>记录公司买了什么、几个席位、什么时候续费；到期前 7 天在概览提醒。</Dialog.Description></Dialog.Header>
			{#if editing}<input type="hidden" name="id" value={editing.id} />{/if}
			<input type="hidden" name="vendor" value={sub.vendor} />
			<input type="hidden" name="cycle" value={sub.cycle} />
			<input type="hidden" name="owner" value={sub.owner} />
			<div class="grid gap-4 sm:grid-cols-2">
				<Field label="厂商">{#if editing}<Input value={names[sub.vendor]} disabled />{:else}<Choice bind:value={sub.vendor} options={data.vendors.map((v) => ({ value: v.id, label: v.name }))} />{/if}</Field>
				<Field label="套餐" id="s-plan"><Input id="s-plan" name="plan" value={editing?.plan ?? ''} placeholder="Claude Max 5x" required /></Field>
				<Field label="席位数" id="s-seats"><Input id="s-seats" name="seats" type="number" min="1" value={String(editing?.seats ?? 1)} required /></Field>
				<Field label="价格" id="s-price"><Input id="s-price" name="price" value={editing?.price ?? ''} placeholder="$100" /></Field>
				<Field label="计费周期"><Choice bind:value={sub.cycle} options={[{ value: 'monthly', label: '按月' }, { value: 'yearly', label: '按年' }]} /></Field>
				<Field label="下次续费" id="s-date"><Input id="s-date" name="renewsAt" type="date" value={dateInput(editing?.renewsAt)} /></Field>
				<Field label="付款人"><Choice bind:value={sub.owner} placeholder="不指定" options={data.members.filter((m) => m.role === 'admin').map((m) => ({ value: m.name, label: m.displayName }))} /></Field>
				<Field label="备注" id="s-note"><Input id="s-note" name="note" value={editing?.note ?? ''} placeholder="例如 公司信用卡" /></Field>
			</div>
			<Dialog.Footer class="sm:justify-between">
				{#if editing}
					<Button type="submit" formaction="?/deleteSubscription" variant="ghost" class="text-destructive" onclick={(e) => { if (!confirm(`删除订阅 ${editing?.plan}？它的账号会保留，归到“未归入订阅”。`)) e.preventDefault(); }}><Trash />删除</Button>
				{:else}<span></span>{/if}
				<div class="flex gap-2"><Button type="button" variant="outline" onclick={() => (subOpen = false)}>取消</Button><Button type="submit">{editing ? '保存' : '添加'}</Button></div>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={accOpen}>
	<Dialog.Content class="sm:max-w-md">
		<form method="POST" action="?/addAccount" use:enhance={toastForm((d) => (d?.member ? `已添加并分配给 ${member(String(d.member))?.displayName ?? d.member}` : '已添加，现在空闲'), () => (accOpen = false))} class="grid gap-4">
			<Dialog.Header><Dialog.Title>添加账号</Dialog.Title><Dialog.Description>只填登录用的邮箱或用户名，不填密码。</Dialog.Description></Dialog.Header>
			<input type="hidden" name="subscription" value={acc.subscription} />
			<input type="hidden" name="member" value={acc.member} />
			<Field label="订阅"><Choice bind:value={acc.subscription} options={data.subscriptions.map((s) => ({ value: s.id, label: `${names[s.vendor] ?? s.vendor} · ${s.plan}` }))} /></Field>
			<Field label="账号" id="a-account"><Input id="a-account" name="account" placeholder="ai-claude-3@glgwork.com" required /></Field>
			<Field label="备注" id="a-note"><Input id="a-note" name="note" placeholder="可选" /></Field>
			<Field label="分配给" hint="不选则自动分给第一个在等这个厂商账号的成员。">
				<Choice bind:value={acc.member} placeholder="自动" options={data.members.filter((m) => m.status === 'active').map((m) => ({ value: m.name, label: `${m.displayName}（${m.name}）` }))} />
			</Field>
			<Dialog.Footer><Button type="button" variant="outline" onclick={() => (accOpen = false)}>取消</Button><Button type="submit">添加</Button></Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
