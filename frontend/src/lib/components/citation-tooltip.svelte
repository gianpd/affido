<script lang="ts">
	import FileText from '@lucide/svelte/icons/file-text';
	import { Badge } from '#lib/components/ui/badge';
	import type { TooltipPlacement } from '#lib/citation-tooltip.js';
	import type { Citation } from '#lib/types';

	let {
		citation,
		placement,
		el = $bindable(null)
	}: {
		/** The citation the hovered reference points at. */
		citation: Citation;
		/** Viewport position; null until the parent has measured the card. */
		placement: TooltipPlacement | null;
		el?: HTMLDivElement | null;
	} = $props();
</script>

<!-- Hidden until placed, so the parent can measure the card before showing it. -->
<!-- `not-prose` keeps the typography plugin off the card's own markup. -->
<div
	bind:this={el}
	role="tooltip"
	class="not-prose pointer-events-none fixed z-50 w-80 max-w-[calc(100vw-1rem)] overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-md"
	style:visibility={placement ? 'visible' : 'hidden'}
	style:top={placement ? `${placement.top}px` : undefined}
	style:left={placement ? `${placement.left}px` : undefined}
>
	<div class="flex min-w-0 items-center gap-2 border-b border-border px-3 py-2">
		<FileText class="size-3.5 shrink-0 text-muted-foreground" />
		<span class="truncate text-xs font-medium">{citation.title}</span>
		<Badge variant="secondary" class="ml-auto shrink-0 font-normal">v{citation.version}</Badge>
	</div>
	<div class="max-h-44 overflow-y-auto px-3 py-2.5">
		<blockquote
			class="border-l-2 border-primary/40 pl-2.5 text-xs leading-relaxed whitespace-pre-wrap text-foreground/90"
		>
			{citation.quote}
		</blockquote>
	</div>
	<div class="border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">
		{citation.filename} · line {citation.line}
	</div>
</div>
