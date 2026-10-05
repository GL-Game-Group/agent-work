<script lang="ts">
	import * as Select from '#lib/components/ui/select/index.js';

	let { value = $bindable(), options, placeholder = '请选择', id, class: className = 'w-full' }: {
		value: string;
		options: { value: string; label: string; disabled?: boolean }[];
		placeholder?: string;
		id?: string;
		class?: string;
	} = $props();
	const current = $derived(options.find((o) => o.value === value)?.label);
</script>

<Select.Root type="single" bind:value>
	<Select.Trigger {id} class={className}>{current ?? placeholder}</Select.Trigger>
	<Select.Content>
		{#each options as option (option.value)}
			<Select.Item value={option.value} label={option.label} disabled={option.disabled}>{option.label}</Select.Item>
		{/each}
	</Select.Content>
</Select.Root>
