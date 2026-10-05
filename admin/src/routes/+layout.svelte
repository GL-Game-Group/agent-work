<script lang="ts">
	import './layout.css';
	import { ModeWatcher } from 'mode-watcher';
	import { Toaster } from '#lib/components/ui/sonner/index.js';
	import * as Tooltip from '#lib/components/ui/tooltip/index.js';

	let { children } = $props();
</script>

<svelte:head>
	<link rel="icon" href="/logo.svg" />
	<title>GL Work 管理后台</title>
</svelte:head>

<ModeWatcher />
<Toaster richColors position="bottom-right" />
<Tooltip.Provider delayDuration={200}>
	{@render children()}
</Tooltip.Provider>
