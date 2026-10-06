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
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import PageHeader from '#lib/components/app/page-header.svelte';
	import Field from '#lib/components/app/field.svelte';
	import Choice from '#lib/components/app/choice.svelte';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import Play from '@lucide/svelte/icons/play';
	import Square from '@lucide/svelte/icons/square';
	import Search from '@lucide/svelte/icons/search';
	import { toastForm, toastResult } from '#lib/form.js';
	import { relative } from '#lib/labels.js';

	let { data } = $props();
	type VoiceRow = (typeof data.voices)[number];

	// Which voices members see, per vendor, as edited here until saved.
	// Reset from the server's list whenever it reloads (after a save or an update from the vendors).
	let chosen = $derived<Record<string, string[]>>(
		Object.fromEntries(data.vendors.map((v) => [v.id, data.voices.filter((x) => x.vendor === v.id && x.enabled).map((x) => x.id)]))
	);
	let tab = $state('qwen-voice');
	let query = $state('');
	let family = $state('all');
	const familiesOf = (vendor: string) => [...new Set(data.voices.filter((v) => v.vendor === vendor).map((v) => v.family ?? ''))].filter((f) => f !== '');
	const rowsOf = (vendor: string) =>
		data.voices.filter((v) => v.vendor === vendor && (family === 'all' || v.family === family) &&
			`${v.id} ${v.name} ${v.description ?? ''} ${v.languages ?? ''}`.toLowerCase().includes(query.toLowerCase()));
	function toggle(vendor: string, id: string, on: boolean) {
		const list = chosen[vendor] ?? [];
		chosen[vendor] = on ? [...new Set([...list, id])] : list.filter((x) => x !== id);
	}
	function setAll(vendor: string, rows: VoiceRow[], on: boolean) {
		const ids = new Set(rows.map((r) => r.id));
		const list = (chosen[vendor] ?? []).filter((x) => !ids.has(x));
		chosen[vendor] = on ? [...list, ...ids] : list;
	}

	// Samples: one plays at a time.
	let playing = $state<string | null>(null);
	let audio: HTMLAudioElement | null = null;
	function play(v: VoiceRow) {
		audio?.pause();
		if (playing === v.id || !v.sampleUrl) { playing = null; return; }
		audio = new Audio(v.sampleUrl);
		audio.onended = () => (playing = null);
		void audio.play();
		playing = v.id;
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

<PageHeader title="语音" description="手机端的语音输入（语音转文字）和播报（文字转语音）。手机直接连厂商：公司服务用成员的 Key 换一个几分钟就过期的临时令牌给手机，Key 不离开服务端。成员的 Key 在“API Key”里录入并分配（建议用独立 Key，便于在厂商控制台分人核算）。">
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
						<Field label="识别模型" id="asrm-{v.id}" hint={v.protocol === 'dashscope' ? '实时识别模型，如 qwen3-asr-flash-realtime' : '流式识别的资源 ID，如 volc.bigasr.sauc.duration'}>
							<Input id="asrm-{v.id}" name="asrModel" value={s.asrModel} class="font-mono" />
						</Field>
						<div class="flex items-center justify-between gap-4">
							<div><Label for="tts-{v.id}">播报</Label><p class="text-muted-foreground text-xs">Agent 回复完成后朗读，成员在手机上选音色</p></div>
							<Switch id="tts-{v.id}" name="tts" checked={s.tts} />
						</div>
						<Field label="合成模型" id="ttsm-{v.id}" hint={v.protocol === 'dashscope' ? '如 qwen3-tts-flash-realtime；手机只列出这个模型支持的音色' : 'seed-tts-2.0 或 seed-tts-1.0；手机只列出对应系列的音色'}>
							<Input id="ttsm-{v.id}" name="ttsModel" value={s.ttsModel} class="font-mono" />
						</Field>
						<div class="flex justify-end"><Button type="submit" size="sm">保存</Button></div>
					</form>
				{/if}
			</Card.Content>
		</Card.Root>
	{/each}
</div>

<Card.Root class="mt-4">
	<Card.Header>
		<Card.Title>音色</Card.Title>
		<Card.Description>从两家官方的音色列表读取。勾选的音色才会出现在成员手机上；千问有官方试听，火山没有，成员在手机上试听时现场合成一句。</Card.Description>
	</Card.Header>
	<Card.Content>
		<Tabs.Root bind:value={tab} onValueChange={() => { query = ''; family = 'all'; }}>
			<Tabs.List>
				{#each data.vendors as v (v.id)}
					<Tabs.Trigger value={v.id}>{v.name}（{(chosen[v.id] ?? []).length}/{data.voices.filter((x) => x.vendor === v.id).length}）</Tabs.Trigger>
				{/each}
			</Tabs.List>
			{#each data.vendors as v (v.id)}
				{@const rows = rowsOf(v.id)}
				<Tabs.Content value={v.id} class="space-y-3 pt-2">
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
					{#if rows.length > 0}
						<div class="max-h-[32rem] overflow-y-auto rounded-md border">
							<Table.Root>
								<Table.Header>
									<Table.Row>
										<Table.Head class="w-10"><Checkbox checked={rows.every((r) => (chosen[v.id] ?? []).includes(r.id))} onCheckedChange={(on) => setAll(v.id, rows, on === true)} aria-label="全选" /></Table.Head>
										<Table.Head>音色</Table.Head>
										<Table.Head>描述</Table.Head>
										<Table.Head>语种</Table.Head>
										<Table.Head class="w-16">试听</Table.Head>
									</Table.Row>
								</Table.Header>
								<Table.Body>
									{#each rows as r (r.id)}
										<Table.Row>
											<Table.Cell><Checkbox checked={(chosen[v.id] ?? []).includes(r.id)} onCheckedChange={(on) => toggle(v.id, r.id, on === true)} aria-label={r.name} /></Table.Cell>
											<Table.Cell>
												<div class="font-medium">{r.name}{#if r.gender}<span class="text-muted-foreground ml-1 text-xs">{GENDER[r.gender]}</span>{/if}</div>
												<div class="text-muted-foreground font-mono text-xs">{r.id}</div>
											</Table.Cell>
											<Table.Cell class="text-muted-foreground max-w-64 text-xs whitespace-normal">{r.description ?? ''}{#if family === 'all' && r.family}<div class="opacity-70">{r.family}</div>{/if}</Table.Cell>
											<Table.Cell class="text-muted-foreground max-w-48 truncate text-xs" title={r.languages ?? ''}>{r.languages ?? ''}</Table.Cell>
											<Table.Cell>
												{#if r.sampleUrl}
													<Button variant="ghost" size="icon-sm" onclick={() => play(r)} aria-label="试听 {r.name}">{#if playing === r.id}<Square />{:else}<Play />{/if}</Button>
												{:else}<span class="text-muted-foreground text-xs">—</span>{/if}
											</Table.Cell>
										</Table.Row>
									{/each}
								</Table.Body>
							</Table.Root>
						</div>
						<form method="POST" action="?/voices" use:enhance={toastForm((d) => `已开放 ${String(d?.count ?? 0)} 个音色`)} class="flex items-center justify-end gap-3">
							<input type="hidden" name="vendor" value={v.id} />
							<input type="hidden" name="ids" value={JSON.stringify(chosen[v.id] ?? [])} />
							<span class="text-muted-foreground text-sm">已勾选 {(chosen[v.id] ?? []).length} 个</span>
							<Button type="submit">保存音色</Button>
						</form>
					{:else}
						<p class="text-muted-foreground p-6 text-center text-sm">{data.voices.some((x) => x.vendor === v.id) ? '没有匹配的音色' : '点“从官方更新”读取音色列表'}</p>
					{/if}
				</Tabs.Content>
			{/each}
		</Tabs.Root>
	</Card.Content>
</Card.Root>

<div class="mt-4 grid gap-4 lg:grid-cols-2">
	<Card.Root>
		<Card.Header>
			<Card.Title>临时令牌</Card.Title>
			<Card.Description>手机每次用语音前换取，过期前自动续。限制的是换令牌的次数，实际用量在厂商控制台按各人的 Key 查看。</Card.Description>
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
		<Card.Header><Card.Title>最近 24 小时</Card.Title><Card.Description>谁换取了多少次令牌</Card.Description></Card.Header>
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
