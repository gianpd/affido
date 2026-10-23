<script lang="ts">
	let { href = '/dashboard', wordmark = true }: { href?: string; wordmark?: boolean } = $props();
</script>

<a {href} class="flex items-center gap-2.5">
	<span
		class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary font-display text-xl leading-none text-primary-foreground"
		>d</span
	>
	{#if wordmark}
		<span class="font-display text-xl leading-none">durable</span>
	{/if}
</a>
