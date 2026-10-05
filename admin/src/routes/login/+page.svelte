<script lang="ts">
	import * as Card from '#lib/components/ui/card/index.js';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import CircleAlert from '@lucide/svelte/icons/circle-alert';
	import Loader from '@lucide/svelte/icons/loader-circle';

	let { data } = $props();
	let busy = $state(false);

	const REASONS: Record<string, { title: string; body: (login: string | null) => string }> = {
		'not-member': { title: '没有访问权限', body: (login) => `GitHub 账号 ${login ?? ''} 还没有开通，请联系管理员。` },
		disabled: { title: '账号已停用', body: (login) => `GitHub 账号 ${login ?? ''} 对应的成员已停用，请联系管理员。` },
		'not-in-org': { title: '没有访问权限', body: () => `需要先加入 GitHub 组织 ${data.org ?? ''}，并在授权时允许读取组织成员身份。` },
		cancelled: { title: '已取消授权', body: () => '没有完成 GitHub 授权，可以重新登录。' },
		github: { title: '无法完成登录', body: () => 'GitHub 暂时无法确认你的身份，请稍后重试。' }
	};
	const reason = $derived(data.error ? (REASONS[data.error] ?? { title: '登录失败', body: () => '请重新登录。' }) : null);
</script>

<svelte:head><title>登录 · {data.productName}</title></svelte:head>

<div class="bg-muted/40 flex min-h-svh flex-col items-center justify-center gap-6 p-4">
	<div class="flex items-center gap-2.5">
		<img src="/logo.svg" alt="" class="size-9" />
		<span class="text-xl font-semibold">{data.productName}</span>
	</div>
	<Card.Root class="w-full max-w-sm">
		<Card.Header class="text-center">
			<Card.Title class="text-xl">登录</Card.Title>
			<Card.Description>使用公司 GitHub 账号登录。管理员进入管理后台，成员进入我的工作台。</Card.Description>
		</Card.Header>
		<Card.Content class="space-y-4">
			{#if reason}
				<Alert.Root variant="destructive">
					<CircleAlert />
					<Alert.Title>{reason.title}</Alert.Title>
					<Alert.Description>{reason.body(data.login)}</Alert.Description>
				</Alert.Root>
			{/if}
			<Button class="w-full" size="lg" href={data.start} data-sveltekit-reload onclick={() => (busy = true)}>
				{#if busy}<Loader class="animate-spin" />正在跳转到 GitHub…
				{:else}
					<svg viewBox="0 0 16 16" class="size-4 fill-current" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" /></svg>
					使用 GitHub 登录
				{/if}
			</Button>
			{#if data.org}<p class="text-muted-foreground text-center text-xs">需要是 GitHub 组织 {data.org} 的成员，并由管理员开通。</p>{/if}
		</Card.Content>
	</Card.Root>
</div>
