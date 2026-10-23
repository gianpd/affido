<script lang="ts">
	import * as Tooltip from '#lib/components/ui/tooltip';
	import { Toaster } from '#lib/components/ui/sonner';
	import './layout.css';
	import favicon from '#lib/assets/favicon.svg';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<meta
		name="description"
		content="Durable agent sandboxes with documents, corpus collections and full session traces."
	/>
</svelte:head>

<Tooltip.Provider>
	{@render children()}
</Tooltip.Provider>
<Toaster position="top-center" richColors />
