<script lang="ts">
	import { enhance, type SubmitFunction } from '$app/forms';
	import * as Card from '#lib/components/ui/card/index.js';
	import * as Tabs from '#lib/components/ui/tabs/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import PageHeader from '#lib/components/app/page-header.svelte';
	import Field from '#lib/components/app/field.svelte';
	import Choice from '#lib/components/app/choice.svelte';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import Play from '@lucide/svelte/icons/play';
	import Square from '@lucide/svelte/icons/square';
	import Search from '@lucide/svelte/icons/search';
	import Loader from '@lucide/svelte/icons/loader-circle';
	import { toast } from 'svelte-sonner';
	import { toastForm, toastResult } from '#lib/form.js';
	import { relative } from '#lib/labels.js';

	let { data } = $props();
	type VoiceRow = (typeof data.voices)[number];

	let tab = $state('qwen-voice');
	let query = $state('');
	let family = $state('all');
	const familiesOf = (vendor: string) => [...new Set(data.voices.filter((v) => v.vendor === vendor).map((v) => v.family ?? ''))].filter((f) => f !== '');
	const rowsOf = (vendor: string) =>
		data.voices.filter((v) => v.vendor === vendor && (family === 'all' || v.family === family) &&
			`${v.id} ${v.name} ${v.description ?? ''} ${v.languages ?? ''}`.toLowerCase().includes(query.toLowerCase()));
	// 已添加: what members can pick (启用) or have had hidden for now (停用).
	const addedOf = (vendor: string) => data.voices.filter((v) => v.vendor === vendor && v.state !== 'available');
	const shownOf = (vendor: string) => data.voices.filter((v) => v.vendor === vendor && v.state === 'enabled').length;
	// The row whose 添加 / 停用 / 启用 is on its way: one at a time.
	let changing = $state<string | null>(null);
	const change = (verb: string): SubmitFunction => ({ formData }) => {
		changing = `${String(formData.get('vendor'))}/${String(formData.get('id'))}`;
		const after = toastResult(`已${verb}`);
		return async (opts) => {
			await after(opts);
			changing = null;
		};
	};

	// Samples, from the console itself: one plays at a time.
	let playing = $state<string | null>(null);
	let loading = $state<string | null>(null);
	let audio: HTMLAudioElement | null = null;
	async function play(v: VoiceRow) {
		audio?.pause();
		if (playing === v.id || loading === v.id) { playing = null; loading = null; return; }
		const url = `/ai/voice/sample?vendor=${encodeURIComponent(v.vendor)}&voice=${encodeURIComponent(v.id)}`;
		loading = v.id;
		try {
			const response = await fetch(url);
			if (!response.ok) throw new Error((await response.json().catch(() => null))?.message ?? '试听失败');
			const blob = await response.blob();
			if (loading !== v.id) return;
			audio = new Audio(URL.createObjectURL(blob));
			audio.onended = () => (playing = null);
			await audio.play();
			playing = v.id;
		} catch (cause) {
			toast.error(cause instanceof Error ? cause.message : '试听失败');
			playing = null;
		} finally {
			if (loading === v.id) loading = null;
		}
	}

	let refreshing = $state<string | null>(null);
	const refresh: SubmitFunction = ({ formData }) => {
		refreshing = String(formData.get('vendor'));
		const after = toastResult((d) => `读到 ${String(d?.voices ?? 0)} 个音色${Number(d?.added ?? 0) > 0 ? `，新增 ${String(d?.added)} 个（默认不开放）` : ''}`);
		return async (opts) => {
			await after(opts);
			refreshing = null;
		};
	};
	const GENDER: Record<string, string> = { female: '女', male: '男' };
</script>

<PageHeader title="语音" description="手机端的语音输入（语音转文字）和播报（文字转语音）。手机直接连厂商：千问由公司服务用成员的 Key 换一个几分钟就过期的临时令牌给手机，Key 不离开服务端；火山没有临时令牌，手机拿到的就是单独给 GL Work 建的 API Key，到期后重新取。成员的 Key 在“API Key”里录入并分配（建议用独立 Key，便于在厂商控制台分人核算）。">
</PageHeader>

<div class="grid gap-4 lg:grid-cols-2">
	{#each data.vendors as v (v.id)}
		{@const s = data.settings.vendors[v.id]}
		<Card.Root>
			<Card.Header>
				<Card.Title class="flex items-center gap-2">{v.name}<Badge variant="outline" class="font-normal">{v.protocol === 'dashscope' ? '阿里云百炼' : '火山引擎'}</Badge></Card.Title>
				<Card.Description>
					{v.activeKeys} 个可用 Key，{v.members.length} 人已分配{#if v.waiting.length > 0}，<span class="text-amber-600">{v.waiting.join('、')} 等 Key</span>{/if}
				</Card.Description>
				<Card.Action><Button variant="ghost" size="sm" href="/ai/keys">Key 管理</Button></Card.Action>
			</Card.Header>
			<Card.Content>
				{#if s}
					<form method="POST" action="?/vendor" use:enhance={toastForm('已保存，手机下次打开设置时生效')} class="space-y-4">
						<input type="hidden" name="id" value={v.id} />
						<div class="flex items-center justify-between gap-4">
							<div><Label for="asr-{v.id}">语音输入</Label><p class="text-muted-foreground text-xs">按住说话时实时识别成文字</p></div>
							<Switch id="asr-{v.id}" name="asr" checked={s.asr} />
						</div>
						<Field label="识别模型" id="asrm-{v.id}" hint={v.protocol === 'dashscope' ? '实时识别模型，如 qwen3-asr-flash-realtime' : '流式识别的资源 ID，如 volc.seedasr.sauc.duration'}>
							<Input id="asrm-{v.id}" name="asrModel" value={s.asrModel} class="font-mono" />
						</Field>
						<div class="flex items-center justify-between gap-4">
							<div><Label for="tts-{v.id}">播报</Label><p class="text-muted-foreground text-xs">Agent 回复完成后朗读，成员在手机上选音色</p></div>
							<Switch id="tts-{v.id}" name="tts" checked={s.tts} />
						</div>
						<Field label="合成模型" id="ttsm-{v.id}" hint={v.protocol === 'dashscope' ? '如 qwen3-tts-flash；手机只列出这个模型支持的音色' : 'seed-tts-2.0 或 seed-tts-1.0；手机只列出对应系列的音色'}>
							<Input id="ttsm-{v.id}" name="ttsModel" value={s.ttsModel} class="font-mono" />
						</Field>
						<div class="flex justify-end"><Button type="submit" size="sm">保存</Button></div>
					</form>
				{/if}
			</Card.Content>
		</Card.Root>
	{/each}
</div>

{#snippet voiceCell(r: VoiceRow)}
	<div class="font-medium">{r.name}{#if r.gender}<span class="text-muted-foreground ml-1 text-xs">{GENDER[r.gender]}</span>{/if}</div>
	<div class="text-muted-foreground font-mono text-xs">{r.id}</div>
{/snippet}
{#snippet aboutCells(r: VoiceRow)}
	<Table.Cell class="text-muted-foreground max-w-64 text-xs whitespace-normal">{r.description ?? ''}{#if family === 'all' && r.family}<div class="opacity-70">{r.family}</div>{/if}</Table.Cell>
	<Table.Cell class="text-muted-foreground max-w-48 truncate text-xs" title={r.languages ?? ''}>{r.languages ?? ''}</Table.Cell>
{/snippet}
{#snippet playCell(r: VoiceRow)}
	<Table.Cell>
		<Button variant="ghost" size="icon-sm" onclick={() => play(r)} aria-label="试听 {r.name}" title={r.sampleUrl ? '官方试听' : '用已录入的 Key 现场合成一句'}>
			{#if loading === r.id}<Loader class="animate-spin" />{:else if playing === r.id}<Square />{:else}<Play />{/if}
		</Button>
	</Table.Cell>
{/snippet}
{#snippet stateButton(r: VoiceRow, state: 'enabled' | 'disabled', verb: string, variant: 'default' | 'outline')}
	<form method="POST" action="?/voice" use:enhance={change(verb)}>
		<input type="hidden" name="vendor" value={r.vendor} />
		<input type="hidden" name="id" value={r.id} />
		<input type="hidden" name="state" value={state} />
		<Button type="submit" size="sm" {variant} disabled={changing !== null} data-action="voice-{verb}">{verb}</Button>
	</form>
{/snippet}

<Card.Root class="mt-4">
	<Card.Header>
		<Card.Title>音色</Card.Title>
		<Card.Description>从两家官方的音色列表读取。在“官方音色”里点“添加”，音色就出现在成员手机上；已添加的可以停用（成员暂时看不到），停用的可以重新启用。千问播放官方试听；火山没有官方试听，用已录入的 Key 现场合成一句（合成过的会缓存）。</Card.Description>
	</Card.Header>
	<Card.Content>
		<Tabs.Root bind:value={tab} onValueChange={() => { query = ''; family = 'all'; }}>
			<Tabs.List>
				{#each data.vendors as v (v.id)}
					<Tabs.Trigger value={v.id}>{v.name}（启用 {shownOf(v.id)} / 已添加 {addedOf(v.id).length}）</Tabs.Trigger>
				{/each}
			</Tabs.List>
			{#each data.vendors as v (v.id)}
				{@const rows = rowsOf(v.id)}
				{@const added = rows.filter((r) => r.state !== 'available')}
				<Tabs.Content value={v.id} class="space-y-4 pt-2">
					<div class="flex flex-wrap items-center gap-2">
						<div class="relative min-w-48 flex-1">
							<Search class="text-muted-foreground absolute top-2.5 left-2.5 size-4" />
							<Input bind:value={query} placeholder="筛选名称、描述、语种" class="pl-8" />
						</div>
						{#if familiesOf(v.id).length > 1}
							<Choice bind:value={family} class="w-64" options={[{ value: 'all', label: '全部系列' }, ...familiesOf(v.id).map((f) => ({ value: f, label: f }))]} />
						{/if}
						<form method="POST" action="?/refresh" use:enhance={refresh}>
							<input type="hidden" name="vendor" value={v.id} />
							<Button type="submit" variant="outline" disabled={refreshing !== null}><RefreshCw class={refreshing === v.id ? 'animate-spin' : ''} />从官方更新</Button>
						</form>
						<span class="text-muted-foreground text-xs">{v.catalogAt ? `${relative(v.catalogAt)}更新` : '还没有读取过'}</span>
					</div>
					{#if data.voices.some((x) => x.vendor === v.id)}
						<section class="space-y-2" data-voice-section="added">
							<h3 class="text-sm font-medium">已添加（{addedOf(v.id).length}）<span class="text-muted-foreground ml-2 text-xs font-normal">启用的出现在成员手机上</span></h3>
							{#if added.length > 0}
								<div class="max-h-[24rem] overflow-y-auto rounded-md border">
									<Table.Root>
										<Table.Header>
											<Table.Row>
												<Table.Head>音色</Table.Head>
												<Table.Head>描述</Table.Head>
												<Table.Head>语种</Table.Head>
												<Table.Head class="w-20">状态</Table.Head>
												<Table.Head class="w-20">操作</Table.Head>
												<Table.Head class="w-16">试听</Table.Head>
											</Table.Row>
										</Table.Header>
										<Table.Body>
											{#each added as r (r.id)}
												<Table.Row data-voice={r.id}>
													<Table.Cell>{@render voiceCell(r)}</Table.Cell>
													{@render aboutCells(r)}
													<Table.Cell>
														{#if r.state === 'enabled'}<Badge variant="secondary">启用</Badge>{:else}<Badge variant="outline" class="text-muted-foreground">停用</Badge>{/if}
													</Table.Cell>
													<Table.Cell>
														{#if r.state === 'enabled'}{@render stateButton(r, 'disabled', '停用', 'outline')}{:else}{@render stateButton(r, 'enabled', '启用', 'default')}{/if}
													</Table.Cell>
													{@render playCell(r)}
												</Table.Row>
											{/each}
										</Table.Body>
									</Table.Root>
								</div>
							{:else}
								<p class="text-muted-foreground rounded-md border p-4 text-center text-sm">{addedOf(v.id).length === 0 ? '还没有添加音色：在下面的官方音色里点“添加”' : '没有匹配的已添加音色'}</p>
							{/if}
						</section>
						<section class="space-y-2" data-voice-section="official">
							<h3 class="text-sm font-medium">官方音色（{rows.length}）</h3>
							{#if rows.length > 0}
								<div class="max-h-[32rem] overflow-y-auto rounded-md border">
									<Table.Root>
										<Table.Header>
											<Table.Row>
												<Table.Head>音色</Table.Head>
												<Table.Head>描述</Table.Head>
												<Table.Head>语种</Table.Head>
												<Table.Head class="w-20">操作</Table.Head>
												<Table.Head class="w-16">试听</Table.Head>
											</Table.Row>
										</Table.Header>
										<Table.Body>
											{#each rows as r (r.id)}
												<Table.Row data-voice={r.id}>
													<Table.Cell>{@render voiceCell(r)}</Table.Cell>
													{@render aboutCells(r)}
													<Table.Cell>
														{#if r.state === 'available'}{@render stateButton(r, 'enabled', '添加', 'outline')}{:else}<span class="text-muted-foreground text-xs">已添加</span>{/if}
													</Table.Cell>
													{@render playCell(r)}
												</Table.Row>
											{/each}
										</Table.Body>
									</Table.Root>
								</div>
							{:else}
								<p class="text-muted-foreground rounded-md border p-4 text-center text-sm">没有匹配的音色</p>
							{/if}
						</section>
					{:else}
						<p class="text-muted-foreground p-6 text-center text-sm">点“从官方更新”读取音色列表</p>
					{/if}
				</Tabs.Content>
			{/each}
		</Tabs.Root>
	</Card.Content>
</Card.Root>

<div class="mt-4 grid gap-4 lg:grid-cols-2">
	<Card.Root>
		<Card.Header>
			<Card.Title>手机凭据</Card.Title>
			<Card.Description>手机用语音前来取（千问是临时令牌，火山是 API Key），到期前自动续；有效期也是换 Key、停用成员生效所需的最长时间。限制的是取的次数，实际用量在厂商控制台按各人的 Key 查看。</Card.Description>
		</Card.Header>
		<Card.Content>
			<form method="POST" action="?/tokens" use:enhance={toastForm('已保存')} class="flex flex-wrap items-end gap-4">
				<Field label="有效期（秒）" id="t-ttl" hint="60–1800"><Input id="t-ttl" name="tokenTtlSeconds" type="number" min="60" max="1800" value={data.settings.tokenTtlSeconds} class="w-32" /></Field>
				<Field label="每人每小时最多换取" id="t-hour" hint="所有厂商合计"><Input id="t-hour" name="tokensPerHour" type="number" min="1" max="1000" value={data.settings.tokensPerHour} class="w-32" /></Field>
				<Button type="submit">保存</Button>
			</form>
		</Card.Content>
	</Card.Root>
	<Card.Root>
		<Card.Header><Card.Title>最近 24 小时</Card.Title><Card.Description>谁取了多少次凭据</Card.Description></Card.Header>
		<Card.Content>
			{#if data.tokens.length > 0}
				<Table.Root>
					<Table.Header><Table.Row><Table.Head>成员</Table.Head><Table.Head>厂商</Table.Head><Table.Head class="text-right">次数</Table.Head></Table.Row></Table.Header>
					<Table.Body>
						{#each data.tokens as t (`${t.member}/${t.vendor}`)}
							<Table.Row><Table.Cell>{t.member}</Table.Cell><Table.Cell>{data.vendors.find((v) => v.id === t.vendor)?.name ?? t.vendor}</Table.Cell><Table.Cell class="text-right tabular-nums">{t.count}</Table.Cell></Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			{:else}
				<p class="text-muted-foreground text-sm">还没有人用过</p>
			{/if}
		</Card.Content>
	</Card.Root>
</div>
