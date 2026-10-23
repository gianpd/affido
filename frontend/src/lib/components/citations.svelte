<script lang="ts">
	import BookCheck from '@lucide/svelte/icons/book-check';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import FileText from '@lucide/svelte/icons/file-text';
	import { Badge } from '#lib/components/ui/badge';
	import * as Collapsible from '#lib/components/ui/collapsible';
	import type { Citation } from '#lib/types';

	let {
		citations,
		open = true,
		onOpenChange
	}: {
		citations: Citation[];
		/** Controlled open state: the chat re-opens the panel when a numbered ref is activated. */
		open?: boolean;
		onOpenChange?: (open: boolean) => void;
	} = $props();

	// One row per citation, grouped by document; the RFC's "Files used" panel.
	const byDoc = $derived(
		Object.entries(
			citations.reduce<Record<string, Citation[]>>((groups, citation) => {
				const list = groups[citation.docId] ?? [];
				list.push(citation);
				return { ...groups, [citation.docId]: list };
			}, {})
		)
	);
</script>

<Collapsible.Root
	{open}
	{onOpenChange}
	class="mt-1 overflow-hidden rounded-xl border border-border bg-card"
>
	<Collapsible.Trigger
		class="group flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/50"
		aria-label="Toggle the files-used panel"
	>
		<BookCheck class="size-3.5 text-muted-foreground" />
		<span class="text-xs font-medium text-muted-foreground">
			Files used · {byDoc.length}
			{byDoc.length === 1 ? 'document' : 'documents'}
		</span>
		<ChevronDown
			class="ml-auto size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 group-data-[state=closed]:-rotate-90"
		/>
	</Collapsible.Trigger>
	<Collapsible.Content>
		<div class="flex flex-col divide-y divide-border border-t border-border">
			{#each byDoc as [docId, docCitations] (docId)}
				<div class="flex flex-col gap-2 px-3 py-2.5">
					<div class="flex min-w-0 items-center gap-2">
						<FileText class="size-3.5 shrink-0 text-muted-foreground" />
						<span class="truncate text-sm font-medium">{docCitations[0]?.title}</span>
						<Badge variant="secondary" class="font-normal">v{docCitations[0]?.version}</Badge>
						<a
							href="/dashboard/documents?doc={docId}#L{docCitations[0]?.line}"
							class="ml-auto shrink-0 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
						>
							{docCitations[0]?.filename}
						</a>
					</div>
					{#each docCitations as citation (citation.citationId)}
						<div
							id="cite-{citation.citationId}"
							class="flex flex-col gap-0.5 rounded-lg bg-muted/50 px-2.5 py-2"
						>
							<blockquote
								class="border-l-2 border-primary/40 pl-2 text-xs whitespace-pre-wrap text-foreground/90"
							>
								{citation.quote}
							</blockquote>
							<span class="text-[11px] text-muted-foreground">
								line {citation.line} · {citation.status}
							</span>
						</div>
					{/each}
				</div>
			{/each}
		</div>
	</Collapsible.Content>
</Collapsible.Root>
