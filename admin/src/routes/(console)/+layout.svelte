<script lang="ts">
	import * as Sidebar from '#lib/components/ui/sidebar/index.js';
	import { Separator } from '#lib/components/ui/separator/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import AppSidebar from '#lib/components/app/app-sidebar.svelte';
	import { toggleMode } from 'mode-watcher';
	import SunMoon from '@lucide/svelte/icons/sun-moon';

	let { data, children } = $props();
</script>

<svelte:head><title>{data.productName} 管理后台</title></svelte:head>

<Sidebar.Provider>
	<AppSidebar viewer={data.viewer} badges={data.badges} />
	<Sidebar.Inset>
		<header class="bg-background/80 sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b px-4 backdrop-blur">
			<Sidebar.Trigger class="-ml-1" />
			<Separator orientation="vertical" class="mr-1 data-[orientation=vertical]:h-4" />
			<Button variant="ghost" size="icon-sm" class="ml-auto" onclick={toggleMode} aria-label="切换深浅色"><SunMoon /></Button>
		</header>
		<main class="mx-auto w-full max-w-7xl space-y-6 p-4 md:p-6">
			{@render children()}
		</main>
	</Sidebar.Inset>
</Sidebar.Provider>
