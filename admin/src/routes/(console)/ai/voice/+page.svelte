<script lang="ts">
	import { enhance, type SubmitFunction } from '$app/forms';
	import * as Card from '#lib/components/ui/card/index.js';
	import * as Tabs from '#lib/components/ui/tabs/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
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
	import LibraryBig from '@lucide/svelte/icons/library-big';
	import { toast } from 'svelte-sonner';
	import { toastForm, toastResult } from '#lib/form.js';
	import { relative } from '#lib/labels.js';

	let { data } = $props();
	type VoiceRow = (typeof data.voices)[number];

	let tab = $state('qwen-voice');
	const vendorName = (id: string) => data.vendors.find((v) => v.id === id)?.name ?? id;
	const matches = (v: VoiceRow, text: string) => `${v.id} ${v.name} ${v.description ?? ''} ${v.languages ?? ''}`.toLowerCase().includes(text.toLowerCase());
	// 音色库: the voices added (启用 shows them on members' phones, 停用 hides them for now).
	let query = $state('');
	const libraryOf = (vendor: string) => data.voices.filter((v) => v.vendor === vendor && v.state !== 'available' && matches(v, query));
	const addedOf = (vendor: string) => data.voices.filter((v) => v.vendor === vendor && v.state !== 'available');
	const shownOf = (vendor: string) => data.voices.filter((v) => v.vendor === vendor && v.state === 'enabled').length;

	// 官方音色库 (a dialog): the vendor's official list, filtered, to add from.
	// The vendors write languages every which way (中文, 美式英语, 方言：粤语, 上海, 中文（四川话）…): six buckets by keyword.
	const LANGUAGES: { value: string; label: string; test: RegExp }[] = [
		{ value: 'zh', label: '中文', test: /中文|普通话/u },
		// 中文（四川话） counts, 中文（普通话） does not.
		{ value: 'dialect', label: '方言', test: /方言|粤语|闽南|（(?!普通话)[^）]*话）|台湾|(?:^|[、，,\s])(?:上海|北京|天津|南京|河南|四川|陕西|东北|重庆|湖南)/u },
		{ value: 'en', label: '英语', test: /英语/u },
		{ value: 'ja', label: '日语', test: /日语/u },
		{ value: 'ko', label: '韩语', test: /韩语/u },
		{ value: 'other', label: '其他外语', test: /法语|德语|俄语|意大利语|西班牙语|西语|葡萄牙语|印尼语|泰语|越南语|菲律宾语|阿拉伯语|马来语|土耳其语|语种/u }
	];
	let pickerOpen = $state(false);
	let pickerVendor = $state('qwen-voice');
	let pickQuery = $state('');
	let pickGender = $state('all');
	let pickLanguage = $state('all');
	let pickFamily = $state('all');
	function openPicker(vendor: string) {
		pickerVendor = vendor;
		pickQuery = '';
		pickGender = 'all';
		pickLanguage = 'all';
		pickFamily = 'all';
		pickerOpen = true;
	}
	const familiesOf = (vendor: string) => [...new Set(data.voices.filter((v) => v.vendor === vendor).map((v) => v.family ?? ''))].filter((f) => f !== '');
	const officialOf = (vendor: string) => {
		const language = LANGUAGES.find((l) => l.value === pickLanguage);
		return data.voices.filter((v) => v.vendor === vendor && matches(v, pickQuery) &&
			(pickGender === 'all' || v.gender === pickGender) &&
			(language === undefined || language.test.test(v.languages ?? '')) &&
			(pickFamily === 'all' || v.family === pickFamily));
	};
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
		const after = toastResult((d) => `读到 ${String(d?.voices ?? 0)} 个音色${Number(d?.added ?? 0) > 0 ? `，新增 ${String(d?.added)} 个，在官方音色库里，需要的点“添加”` : ''}`);
		return async (opts) => {
			await after(opts);
			refreshing = null;
		};
	};
	const GENDER: Record<string, string> = { female: '女', male: '男' };

	/** The four things a vendor can offer, as the phone lists them (实时 first). */
	const OPTIONS = [
		{
			flag: 'asr', model: 'asrModel', label: '实时识别', description: '按住说话时边说边出字（手机上叫“实时”）',
			hint: { dashscope: '如 qwen3-asr-flash-realtime', volcengine: '流式识别的资源 ID，如 volc.seedasr.sauc.duration' }
		},
		{
			flag: 'asrFile', model: 'asrFileModel', label: '识别', description: '说完后整段识别（手机上叫“识别”，暂未接入）',
			hint: { dashscope: '如 qwen3-asr-flash', volcengine: '录音文件识别极速版的资源 ID，如 volc.bigasr.auc_turbo' }
		},
		{
			flag: 'ttsStream', model: 'ttsStreamModel', label: '实时播报', description: '边合成边播放，开口更快（手机上叫“实时”）',
			hint: { dashscope: '如 qwen3-tts-flash-realtime；手机列出这个模型支持的音色', volcengine: 'seed-tts-2.0 或 seed-tts-1.0（双向流式）' }
		},
		{
			flag: 'tts', model: 'ttsModel', label: '播报', description: '整段合成后播放（手机上叫“语音”）',
			hint: { dashscope: '如 qwen3-tts-flash；手机只列出这个模型支持的音色', volcengine: 'seed-tts-2.0 或 seed-tts-1.0；手机只列出对应系列的音色' }
		}
	] as const;
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
						{#each OPTIONS as o (o.flag)}
							<div class="space-y-2 rounded-md border p-3">
								<div class="flex items-center justify-between gap-4">
									<div><Label for="{o.flag}-{v.id}">{o.label}</Label><p class="text-muted-foreground text-xs">{o.description}</p></div>
									<Switch id="{o.flag}-{v.id}" name={o.flag} checked={s[o.flag]} />
								</div>
								<Field label="模型" id="{o.model}-{v.id}" hint={o.hint[v.protocol === 'dashscope' ? 'dashscope' : 'volcengine']}>
									<Input id="{o.model}-{v.id}" name={o.model} value={s[o.model]} class="font-mono" />
								</Field>
							</div>
						{/each}
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
{#snippet playButton(r: VoiceRow)}
	<Button variant="ghost" size="icon-sm" onclick={() => play(r)} aria-label="试听 {r.name}" title={r.sampleUrl ? '官方试听' : '用已录入的 Key 现场合成一句'}>
		{#if loading === r.id}<Loader class="animate-spin" />{:else if playing === r.id}<Square />{:else}<Play />{/if}
	</Button>
{/snippet}
{#snippet stateButton(r: VoiceRow, state: 'enabled' | 'disabled' | 'available', verb: string, variant: 'default' | 'outline' | 'ghost')}
	<form method="POST" action="?/voice" use:enhance={change(verb)}>
		<input type="hidden" name="vendor" value={r.vendor} />
		<input type="hidden" name="id" value={r.id} />
		<input type="hidden" name="state" value={state} />
		<Button type="submit" size="sm" {variant} disabled={changing !== null} data-action="voice-{verb}" class={verb === '删除' ? 'text-destructive' : ''}>{verb}</Button>
	</form>
{/snippet}

<Card.Root class="mt-4">
	<Card.Header>
		<Card.Title>音色库</Card.Title>
		<Card.Description>成员在手机上可选的音色：启用的出现在手机上，停用的暂时隐藏，删除的回到官方音色库。千问播放官方试听；火山没有官方试听，用已录入的 Key 现场合成一句（合成过的会缓存）。</Card.Description>
		<Card.Action><Button onclick={() => openPicker(tab)} data-action="open-official"><LibraryBig />打开官方音色库</Button></Card.Action>
	</Card.Header>
	<Card.Content>
		<Tabs.Root bind:value={tab} onValueChange={() => (query = '')}>
			<Tabs.List>
				{#each data.vendors as v (v.id)}
					<Tabs.Trigger value={v.id}>{v.name}（启用 {shownOf(v.id)} / 共 {addedOf(v.id).length}）</Tabs.Trigger>
				{/each}
			</Tabs.List>
			{#each data.vendors as v (v.id)}
				{@const rows = libraryOf(v.id)}
				<Tabs.Content value={v.id} class="space-y-3 pt-2" data-voice-section="library">
					{#if addedOf(v.id).length > 0}
						<div class="relative max-w-sm">
							<Search class="text-muted-foreground absolute top-2.5 left-2.5 size-4" />
							<Input bind:value={query} placeholder="筛选名称、描述、语种" class="pl-8" />
						</div>
					{/if}
					{#if rows.length > 0}
						<div class="max-h-[32rem] overflow-y-auto rounded-md border">
							<Table.Root>
								<Table.Header>
									<Table.Row>
										<Table.Head>音色</Table.Head>
										<Table.Head>描述</Table.Head>
										<Table.Head class="w-20">状态</Table.Head>
										<Table.Head class="w-40">操作</Table.Head>
										<Table.Head class="w-16">试听</Table.Head>
									</Table.Row>
								</Table.Header>
								<Table.Body>
									{#each rows as r (r.id)}
										<Table.Row data-voice={r.id}>
											<Table.Cell>{@render voiceCell(r)}</Table.Cell>
											<Table.Cell class="text-muted-foreground max-w-80 text-xs whitespace-normal">{r.description ?? ''}<div class="truncate opacity-70" title={r.languages ?? ''}>{r.languages ?? ''}</div></Table.Cell>
											<Table.Cell>
												{#if r.state === 'enabled'}<Badge variant="secondary">启用</Badge>{:else}<Badge variant="outline" class="text-muted-foreground">停用</Badge>{/if}
											</Table.Cell>
											<Table.Cell>
												<div class="flex gap-1">
													{#if r.state === 'enabled'}{@render stateButton(r, 'disabled', '停用', 'outline')}{:else}{@render stateButton(r, 'enabled', '启用', 'default')}{/if}
													{@render stateButton(r, 'available', '删除', 'ghost')}
												</div>
											</Table.Cell>
											<Table.Cell>{@render playButton(r)}</Table.Cell>
										</Table.Row>
									{/each}
								</Table.Body>
							</Table.Root>
						</div>
					{:else}
						<p class="text-muted-foreground rounded-md border p-6 text-center text-sm">{addedOf(v.id).length === 0 ? `${v.name}的音色库是空的：点右上角“打开官方音色库”添加` : '没有匹配的音色'}</p>
					{/if}
				</Tabs.Content>
			{/each}
		</Tabs.Root>
	</Card.Content>
</Card.Root>

<Dialog.Root bind:open={pickerOpen}>
	<Dialog.Content class="sm:max-w-4xl" data-voice-section="official">
		{@const v = data.vendors.find((x) => x.id === pickerVendor)}
		{@const rows = officialOf(pickerVendor)}
		<Dialog.Header>
			<Dialog.Title>官方音色库</Dialog.Title>
			<Dialog.Description>点“添加”放进音色库（立即对成员启用）。{v?.catalogAt ? `官方列表${relative(v.catalogAt)}更新。` : '还没有读取过官方列表。'}</Dialog.Description>
		</Dialog.Header>
		<div class="flex flex-wrap items-center gap-2">
			<Choice bind:value={pickerVendor} class="w-32" options={data.vendors.map((x) => ({ value: x.id, label: x.name }))} />
			<div class="relative min-w-40 flex-1">
				<Search class="text-muted-foreground absolute top-2.5 left-2.5 size-4" />
				<Input bind:value={pickQuery} placeholder="搜索名称、描述" class="pl-8" />
			</div>
			<Choice bind:value={pickGender} class="w-24" options={[{ value: 'all', label: '全部性别' }, { value: 'female', label: '女' }, { value: 'male', label: '男' }]} />
			<Choice bind:value={pickLanguage} class="w-28" options={[{ value: 'all', label: '全部语言' }, ...LANGUAGES.map((l) => ({ value: l.value, label: l.label }))]} />
			{#if familiesOf(pickerVendor).length > 1}
				<Choice bind:value={pickFamily} class="w-56" options={[{ value: 'all', label: '全部系列' }, ...familiesOf(pickerVendor).map((f) => ({ value: f, label: f }))]} />
			{/if}
			<form method="POST" action="?/refresh" use:enhance={refresh}>
				<input type="hidden" name="vendor" value={pickerVendor} />
				<Button type="submit" variant="outline" disabled={refreshing !== null} title="重新读取 {vendorName(pickerVendor)} 的官方音色列表"><RefreshCw class={refreshing === pickerVendor ? 'animate-spin' : ''} />从官方更新</Button>
			</form>
		</div>
		{#if rows.length > 0}
			<div class="text-muted-foreground text-xs">共 {rows.length} 个</div>
			<div class="max-h-[60vh] divide-y overflow-y-auto rounded-md border">
				{#each rows as r (r.id)}
					<div class="flex items-center gap-3 px-3 py-2" data-voice={r.id}>
						<div class="min-w-0 flex-1">
							<div class="truncate text-sm font-medium">{r.name}{#if r.gender}<span class="text-muted-foreground ml-1 text-xs">{GENDER[r.gender]}</span>{/if}<span class="text-muted-foreground ml-2 font-mono text-xs font-normal">{r.id}</span></div>
							<div class="text-muted-foreground truncate text-xs" title="{r.description ?? ''} · {r.languages ?? ''}">{r.description ?? ''}{r.description && r.languages ? ' · ' : ''}{r.languages ?? ''}</div>
						</div>
						{@render playButton(r)}
						<div class="w-20 text-right">
							{#if r.state === 'available'}{@render stateButton(r, 'enabled', '添加', 'outline')}{:else}<span class="text-muted-foreground text-xs">已在音色库</span>{/if}
						</div>
					</div>
				{/each}
			</div>
		{:else}
			<p class="text-muted-foreground rounded-md border p-6 text-center text-sm">{data.voices.some((x) => x.vendor === pickerVendor) ? '没有匹配的音色' : '点“从官方更新”读取官方音色列表'}</p>
		{/if}
	</Dialog.Content>
</Dialog.Root>

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
