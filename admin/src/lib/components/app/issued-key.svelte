<script lang="ts">
	import * as Alert from '#lib/components/ui/alert/index.js';
	import CopyField from './copy-field.svelte';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';

	let { token, gateway }: { token: string; gateway: string } = $props();
</script>

<div class="min-w-0 space-y-4">
	<Alert.Root class="border-amber-500/50 text-amber-700 dark:text-amber-400">
		<TriangleAlert />
		<Alert.Title>只显示这一次</Alert.Title>
		<Alert.Description>关闭后无法再查看，丢失了就吊销重新生成。</Alert.Description>
	</Alert.Root>
	<CopyField value={token} />
	<div class="space-y-2 text-sm">
		<div class="font-medium">在 Claude Code 里用公司的 DeepSeek</div>
		<CopyField multiline value={`export ANTHROPIC_BASE_URL=${gateway}/deepseek\nexport ANTHROPIC_AUTH_TOKEN=${token}`} />
		<div class="font-medium">读取系统配置</div>
		<CopyField multiline value={`curl -H "Authorization: Bearer ${token}" \\\n  ${gateway.replace('/llm', '/config/system')}`} />
	</div>
</div>
