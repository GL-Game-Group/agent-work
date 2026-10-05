<script lang="ts">
	import Laptop from '@lucide/svelte/icons/laptop';
	import Globe from '@lucide/svelte/icons/globe';
	import KeySquare from '@lucide/svelte/icons/key-square';
	import Smartphone from '@lucide/svelte/icons/smartphone';

	let { kind, class: className = 'size-4' }: { kind: string; class?: string } = $props();
	const Icon = $derived(kind === 'browser' ? Globe : kind === 'key' || kind === 'internal-key' ? KeySquare : kind === 'phone' ? Smartphone : Laptop);
</script>

<Icon class={className} />
