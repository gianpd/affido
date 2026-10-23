<script lang="ts">
	import { Badge } from '#lib/components/ui/badge';
	import type { TraceContentPart, TraceEntryDetail, TraceMessage } from '#lib/types';

	/**
	 * One entry's exact stored content, fetched from the sandbox on mount.
	 * `compact` renders the messages without the outer card chrome (used by the graph panel).
	 */
	let { id, compact = false }: { id: number; compact?: boolean } = $props();

	let detail = $state<TraceEntryDetail | undefined>();
	let error = $state<string | undefined>();

	$effect(() => {
		detail = undefined;
		error = undefined;
		fetch(`/api/trace-entry?id=${id}`)
			.then(async (response) => {
				const body = (await response.json()) as TraceEntryDetail & { error?: string };
				if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
				detail = body;
			})
			.catch((cause: unknown) => {
				error = cause instanceof Error ? cause.message : String(cause);
			});
	});

	const messageParts = (content: TraceMessage['content']): TraceContentPart[] =>
		typeof content === 'string' ? [{ type: 'text', text: content }] : content;
</script>

{#if error}
	<p class="text-xs text-destructive">{error}</p>
{:else if !detail}
	<p class="text-xs text-muted-foreground">Reading the stored entry…</p>
{:else}
	<div class={compact ? 'flex flex-col gap-2' : 'mt-2 flex flex-col gap-2'}>
		{#each detail.messages as message, index (index)}
			<div class="rounded-lg border border-border bg-muted/30 p-3">
				<div
					class="flex flex-wrap items-center gap-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase"
				>
					<span>{message.role}</span>
					{#if message.toolName}
						<span class="font-mono normal-case">{message.toolName}</span>
					{/if}
					{#if message.isError}
						<Badge variant="destructive" class="font-normal normal-case">error</Badge>
					{/if}
					{#if message.durationMs !== undefined}
						<span class="font-normal normal-case">{message.durationMs} ms</span>
					{/if}
					{#if message.model}
						<span class="font-mono font-normal normal-case">{message.model}</span>
					{/if}
					{#if message.stopReason && message.stopReason !== 'stop'}
						<Badge variant="secondary" class="font-normal normal-case">
							{message.stopReason}
						</Badge>
					{/if}
				</div>
				{#if message.errorMessage}
					<p class="mt-2 text-xs text-destructive">{message.errorMessage}</p>
				{/if}
				{#each messageParts(message.content) as part, partIndex (partIndex)}
					{#if part.type === 'text'}
						<pre
							class="mt-2 overflow-x-auto text-xs leading-relaxed whitespace-pre-wrap">{part.text}</pre>
					{:else if part.type === 'thinking'}
						<div class="mt-2 rounded-md border border-dashed border-border p-2">
							<span class="text-[11px] font-medium tracking-wide text-muted-foreground uppercase"
								>thinking</span
							>
							<pre
								class="mt-1 overflow-x-auto text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">{part.redacted
									? '[redacted by the provider]'
									: part.thinking}</pre>
						</div>
					{:else if part.type === 'toolCall'}
						<div class="mt-2">
							<span class="text-[11px] font-medium tracking-wide text-muted-foreground uppercase"
								>call {part.name}</span
							>
							<pre class="mt-1 overflow-x-auto text-xs leading-relaxed">{JSON.stringify(
									part.arguments,
									null,
									2
								)}</pre>
							{#if part.argumentsError}
								<p class="mt-1 text-xs text-destructive">{part.argumentsError}</p>
							{/if}
						</div>
					{:else}
						<span class="mt-2 block text-xs text-muted-foreground"
							>[image {part.mimeType}, {part.data.length} base64 chars]</span
						>
					{/if}
				{/each}
				{#if message.sections}
					{#each Object.entries(message.sections) as [name, text] (name)}
						<div class="mt-2 rounded-md border border-dashed border-border p-2">
							<span class="font-mono text-[11px] tracking-wide text-muted-foreground normal-case"
								>section: {name}</span
							>
							<pre class="mt-1 overflow-x-auto text-xs leading-relaxed whitespace-pre-wrap">{text ??
									'(removed)'}</pre>
						</div>
					{/each}
				{/if}
			</div>
		{/each}
		{#if detail.data !== undefined}
			<div class="rounded-lg border border-border p-3">
				<span class="text-[11px] font-medium tracking-wide text-muted-foreground uppercase"
					>data</span
				>
				<pre class="mt-1 overflow-x-auto text-xs leading-relaxed">{JSON.stringify(
						detail.data,
						null,
						2
					)}</pre>
			</div>
		{/if}
	</div>
{/if}
