<script lang="ts">
	import { browser } from '$app/env';
	import { renderMarkdown } from '#lib/markdown.js';
	import { placeTooltip, type TooltipPlacement } from '#lib/citation-tooltip.js';
	import { cn } from '#lib/utils.js';
	import CitationTooltip from './citation-tooltip.svelte';
	import type { Citation } from '#lib/types';

	let {
		content,
		citations,
		onCitationClick,
		class: className
	}: {
		content: string;
		/** The message's citations (RFC 0006 R6); the numbered refs resolve against these. */
		citations?: readonly Citation[];
		/** Called when a numbered ref is activated (click or Enter); the chat opens the panel on it. */
		onCitationClick?: (citationId: string) => void;
		class?: string;
	} = $props();

	const citationIds = $derived(citations?.map((citation) => citation.citationId));
	const byId = $derived(new Map(citations?.map((citation) => [citation.citationId, citation])));
	const html = $derived(renderMarkdown(content, { citations: citationIds }));

	// The numbered refs live inside `{@html}` markdown, so the hover card rides
	// delegated pointer/focus events on the container instead of one trigger
	// component per ref. Hover-capable pointers only: touch gets the click path.
	const canHover = browser && window.matchMedia('(hover: hover)').matches;

	let hover = $state<{ citation: Citation; anchor: HTMLElement } | null>(null);
	let containerEl = $state<HTMLDivElement | null>(null);
	let cardEl = $state<HTMLDivElement | null>(null);
	let placement = $state<TooltipPlacement | null>(null);

	const refAnchor = (target: EventTarget | null): HTMLElement | null => {
		if (target instanceof Element) {
			const anchor = target.closest('a[data-citation]');
			if (anchor instanceof HTMLElement) return anchor;
		}
		return null;
	};

	const show = (anchor: HTMLElement) => {
		const citation = byId.get(anchor.dataset.citation ?? '');
		// Reset first: the card then re-measures hidden instead of flashing at the
		// previous reference's position when the pointer moves between refs.
		placement = null;
		hover = citation ? { citation, anchor } : null;
	};

	const onmouseover = (event: MouseEvent) => {
		if (!canHover) return;
		const anchor = refAnchor(event.target);
		if (anchor) show(anchor);
		else hover = null;
	};

	const onmouseout = (event: MouseEvent) => {
		const to = event.relatedTarget;
		if (!(to instanceof Node) || !containerEl?.contains(to)) hover = null;
	};

	const onfocusin = (event: FocusEvent) => {
		const anchor = refAnchor(event.target);
		if (anchor) show(anchor);
	};

	// The refs are real anchors (keyboard Enter fires click), so the delegated
	// click replaces the hash jump with the caller's citation activation.
	const onclick = (event: MouseEvent) => {
		const anchor = refAnchor(event.target);
		if (!anchor) return;
		event.preventDefault();
		onCitationClick?.(anchor.dataset.citation ?? '');
	};

	// Measure the hidden card, then place it above the anchor — or below it,
	// when it would not fit (RFC 0006 §5.7 hover preview).
	$effect(() => {
		if (!hover || !cardEl) return;
		if (!hover.anchor.isConnected) {
			hover = null; // re-rendered markdown detached the hovered ref
			return;
		}
		const a = hover.anchor.getBoundingClientRect();
		const card = cardEl.getBoundingClientRect();
		placement = placeTooltip(
			{ top: a.top, bottom: a.bottom, centerX: a.left + a.width / 2 },
			{ width: card.width, height: card.height },
			{ width: window.innerWidth, height: window.innerHeight }
		);
	});
</script>

<svelte:window onresize={() => (hover = null)} onscrollcapture={() => (hover = null)} />

<!-- The container only delegates: the interactive elements are the real anchors, keyboard-focusable natively. -->
<!-- In runes mode a multi-code svelte-ignore applies its first code only, hence one comment per code. -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_mouse_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	bind:this={containerEl}
	class={cn(
		'prose prose-sm max-w-none text-foreground dark:prose-invert prose-headings:font-display prose-headings:tracking-tight prose-p:leading-relaxed prose-a:text-primary prose-a:underline-offset-4 prose-code:rounded prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:font-normal prose-code:before:content-none prose-code:after:content-none prose-pre:rounded-xl prose-pre:border prose-pre:bg-muted prose-pre:text-foreground prose-ol:pl-5 prose-ul:pl-5 prose-li:my-0.5 prose-table:text-sm',
		className
	)}
	{onmouseover}
	{onmouseout}
	{onfocusin}
	onfocusout={() => (hover = null)}
	{onclick}
>
	<!-- markdown-it runs with html:false, so raw HTML is escaped; the only added -->
	<!-- markup is the citation superscript renderCitationRefs builds from hex ids. -->
	<!-- eslint-disable-next-line svelte/no-at-html-tags -->
	{@html html}
	{#if hover}
		<CitationTooltip citation={hover.citation} {placement} bind:el={cardEl} />
	{/if}
</div>

<style>
	/* The numbered refs come from rendered markdown, so the selector cannot be
	   scoped; a wider hit area makes the hover card easy to reach from the text. */
	:global(sup.citation-ref > a) {
		padding: 0 0.15em;
		font-weight: 600;
		text-decoration: none;
	}
</style>
