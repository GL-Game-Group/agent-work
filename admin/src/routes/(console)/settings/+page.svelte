<script lang="ts">
	import { enhance } from '$app/forms';
	import * as Card from '#lib/components/ui/card/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import * as Tabs from '#lib/components/ui/tabs/index.js';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import PageHeader from '#lib/components/app/page-header.svelte';
	import Field from '#lib/components/app/field.svelte';
	import CopyField from '#lib/components/app/copy-field.svelte';
	import Plus from '@lucide/svelte/icons/plus';
	import Lock from '@lucide/svelte/icons/lock';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Trash from '@lucide/svelte/icons/trash-2';
	import ShieldAlert from '@lucide/svelte/icons/shield-alert';
	import { toastForm } from '#lib/form.js';
	import { num, relative } from '#lib/labels.js';

	let { data } = $props();
	type Entry = (typeof data.entries)[number];
	const groups = $derived([...new Set(data.entries.map((e) => e.group ?? '未分组'))]);

	let open = $state(false);
	let editing = $state<Entry | null>(null);
	let secret = $state(false);
	function start(e: Entry | null) {
		editing = e;
		secret = e?.secret ?? false;
		open = true;
	}
</script>

<PageHeader title="系统配置" description="团队共用的公共资源配置（OSS、通知机器人、监控等），由桌面端插件、脚本和工具读取。所有值（包括加密项）都会发给已登录的成员，只放最小权限的凭据。">
	{#snippet actions()}<Button onclick={() => start(null)}><Plus />新增配置</Button>{/snippet}
</PageHeader>

{#if !data.canSeal}
	<Alert.Root><ShieldAlert /><Alert.Title>不能加密保存</Alert.Title><Alert.Description>服务端没有设置 AGENT_WORK_SECRET_KEY，只能保存不加密的配置。</Alert.Description></Alert.Root>
{/if}

<div class="grid gap-4 xl:grid-cols-3">
	<div class="space-y-4 xl:col-span-2">
		{#each groups as group (group)}
			<Card.Root class="gap-0 py-0">
				<Card.Header class="border-b py-3"><Card.Title class="text-sm">{group}</Card.Title></Card.Header>
				<Table.Root>
					<Table.Body>
						{#each data.entries.filter((e) => (e.group ?? '未分组') === group) as e (e.key)}
							<Table.Row>
								<Table.Cell class="w-56 pl-4 font-mono text-sm">{e.key}</Table.Cell>
								<Table.Cell class="max-w-64 truncate font-mono text-xs">{#if e.secret}<Badge variant="secondary"><Lock />已加密</Badge>{:else}{e.value}{/if}</Table.Cell>
								<Table.Cell class="text-muted-foreground text-sm">{e.note ?? ''}</Table.Cell>
								<Table.Cell class="text-muted-foreground text-right text-xs whitespace-nowrap">读取 {num(e.reads)} 次{e.lastReadAt ? `（${relative(e.lastReadAt)}）` : ''}<br />{relative(e.updatedAt)}更新</Table.Cell>
								<Table.Cell class="w-20 text-right whitespace-nowrap">
									<Button variant="ghost" size="icon-sm" onclick={() => start(e)} aria-label="编辑"><Pencil /></Button>
									<form method="POST" action="?/delete" use:enhance={toastForm('已删除')} class="inline" onsubmit={(ev) => { if (!confirm(`删除 ${e.key}？依赖它的工具会读不到。`)) ev.preventDefault(); }}>
										<input type="hidden" name="key" value={e.key} />
										<Button type="submit" variant="ghost" size="icon-sm" class="text-destructive" aria-label="删除"><Trash /></Button>
									</form>
								</Table.Cell>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			</Card.Root>
		{:else}
			<Card.Root><Card.Content class="text-muted-foreground py-8 text-center text-sm">还没有配置</Card.Content></Card.Root>
		{/each}
	</div>

	<Card.Root class="h-fit">
		<Card.Header>
			<Card.Title>读取方式</Card.Title>
			<Card.Description>用成员自己的内部 Key；成员停用或 Key 吊销后立即读不到。</Card.Description>
		</Card.Header>
		<Card.Content>
			<Tabs.Root value="curl">
				<Tabs.List class="w-full"><Tabs.Trigger value="curl">命令行</Tabs.Trigger><Tabs.Trigger value="node">Node.js</Tabs.Trigger><Tabs.Trigger value="plugin">桌面端插件</Tabs.Trigger></Tabs.List>
				<Tabs.Content value="curl" class="space-y-2">
					<CopyField multiline value={`curl -H "Authorization: Bearer $AGENT_WORK_KEY" \\\n  ${data.origin}/agent-work/config/system`} />
					<p class="text-muted-foreground text-xs">只取一个键：<span class="font-mono">/agent-work/config/system/&lt;键&gt;</span></p>
				</Tabs.Content>
				<Tabs.Content value="node">
					<CopyField multiline value={`const res = await fetch('${data.origin}/agent-work/config/system', {\n  headers: { authorization: \`Bearer \${process.env.AGENT_WORK_KEY}\` },\n})\nconst config = await res.json()`} />
				</Tabs.Content>
				<Tabs.Content value="plugin"><p class="text-muted-foreground text-sm">GL Work 登录后自动同步到本机，插件读取接口在内网穿透、插件分发阶段一起提供。</p></Tabs.Content>
			</Tabs.Root>
		</Card.Content>
	</Card.Root>
</div>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-lg">
		<form method="POST" action="?/save" use:enhance={toastForm((d) => `已保存 ${String(d?.key ?? '')}`, () => (open = false))} class="grid gap-4">
			<Dialog.Header><Dialog.Title>{editing ? `编辑 ${editing.key}` : '新增配置'}</Dialog.Title></Dialog.Header>
			<input type="hidden" name="editing" value={editing ? 'true' : 'false'} />
			<div class="grid gap-4 sm:grid-cols-2">
				<Field label="键" id="c-key"><Input id="c-key" name="key" value={editing?.key ?? ''} readonly={!!editing} placeholder="oss.bucket" class="font-mono" required /></Field>
				<Field label="分组" id="c-group"><Input id="c-group" name="group" value={editing?.group ?? groups[0] ?? ''} placeholder="阿里云 OSS" /></Field>
			</div>
			<Field label="值" id="c-value" hint={editing?.secret ? '留空保持原值不变' : undefined}>
				<Textarea id="c-value" name="value" value={editing && !editing.secret ? (editing.value ?? '') : ''} class="font-mono text-xs" placeholder={editing?.secret ? '••••••••' : ''} required={!editing} />
			</Field>
			<div class="flex items-center justify-between rounded-md border p-3">
				<div><Label for="c-secret">加密保存</Label><p class="text-muted-foreground text-xs">后台不再显示原值；工具读取时仍返回明文</p></div>
				<Switch id="c-secret" name="secret" bind:checked={secret} disabled={!data.canSeal} />
			</div>
			<Field label="备注" id="c-note"><Input id="c-note" name="note" value={editing?.note ?? ''} placeholder="例如 只读 RAM 用户" /></Field>
			<Dialog.Footer><Button type="button" variant="outline" onclick={() => (open = false)}>取消</Button><Button type="submit">保存</Button></Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
