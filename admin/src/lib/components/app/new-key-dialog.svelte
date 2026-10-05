<script lang="ts">
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import Field from './field.svelte';
	import CopyField from './copy-field.svelte';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import { toast } from 'svelte-sonner';
	import { db, log } from '#lib/mock/data.svelte.js';

	let { open = $bindable(false), member }: { open: boolean; member: string } = $props();
	let label = $state('');
	let issued = $state<string | null>(null);

	$effect(() => {
		if (open) { label = ''; issued = null; }
	});

	function issue() {
		if (!label) return toast.error('请填写用途');
		const secret = `awk_${Array.from(crypto.getRandomValues(new Uint8Array(20)), (b) => b.toString(16).padStart(2, '0')).join('')}`;
		db.internalKeys.unshift({ id: `ik_${Date.now()}`, member, label, prefix: `${secret.slice(0, 8)}…${secret.slice(-4)}`, createdAt: Date.now(), lastUsedAt: null, status: 'active' });
		db.devices.push({ id: `d_${Date.now()}`, member, kind: 'internal-key', label, detail: `${secret.slice(0, 8)}…${secret.slice(-4)}`, ip: '—', online: false, lastSeenAt: Date.now(), createdAt: Date.now() });
		log('生成内部 Key', label, member);
		issued = secret;
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-xl">
		<Dialog.Header>
			<Dialog.Title>{issued ? '内部 Key 已生成' : '生成内部 Key'}</Dialog.Title>
			<Dialog.Description>内部 Key 是成员个人的公司网关凭据：能调用自己已开通的 API 厂商、读取系统配置、连接内网穿透。</Dialog.Description>
		</Dialog.Header>
		{#if issued}
			<div class="min-w-0 space-y-4">
				<Alert.Root class="border-amber-500/50 text-amber-700 dark:text-amber-400">
					<TriangleAlert />
					<Alert.Title>只显示这一次</Alert.Title>
					<Alert.Description>关闭后无法再查看，丢失了就吊销重新生成。</Alert.Description>
				</Alert.Root>
				<CopyField value={issued} />
				<div class="space-y-2 text-sm">
					<div class="font-medium">在 Claude Code 里用公司的 DeepSeek</div>
					<CopyField multiline value={`export ANTHROPIC_BASE_URL=https://agent.glgwork.com/agent-work/llm/deepseek\nexport ANTHROPIC_AUTH_TOKEN=${issued}`} />
				</div>
			</div>
			<Dialog.Footer><Button onclick={() => (open = false)}>我已保存</Button></Dialog.Footer>
		{:else}
			<Field label="用途" id="ik-label" hint="方便以后认出它，例如“Claude Code”“CI 脚本”“内网穿透”">
				<Input id="ik-label" bind:value={label} placeholder="Claude Code" />
			</Field>
			<Dialog.Footer>
				<Button variant="outline" onclick={() => (open = false)}>取消</Button>
				<Button onclick={issue}>生成</Button>
			</Dialog.Footer>
		{/if}
	</Dialog.Content>
</Dialog.Root>
