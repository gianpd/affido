<script lang="ts">
	let { href = '/dashboard', wordmark = true }: { href?: string; wordmark?: boolean } = $props();
</script>

<a {href} class="flex items-center gap-2.5" aria-label="Affido dashboard">
	{#if wordmark}
		<img
			src="/brand/affido-wordmark.png"
			alt="Affido"
			width="512"
			height="208"
			class="h-8 w-auto"
		/>
	{:else}
		<img
			src="/brand/favicon.svg"
			alt=""
			width="32"
			height="32"
			class="size-8"
			aria-hidden="true"
		/>
	{/if}
</a>
