<script lang="ts">
	import { Badge } from '#lib/components/ui/badge';
	import * as Dialog from '#lib/components/ui/dialog';
	import TraceEntryDetail from '#lib/components/trace-entry-detail.svelte';
	import { formatNumber } from '#lib/format';
	import type {
		TraceContentPart,
		TraceEntryDetail as TraceEntryDetailData,
		TraceMessage
	} from '#lib/types';
	import {
		CONTEXT_W,
		NODE_W,
		NODE_H,
		VERB_LABEL,
		VERB_STROKE,
		buildDecisionGraph,
		clip,
		summarizeDecisions,
		type GraphEdge,
		type GraphNode,
		type Verb
	} from '#lib/trace-graph';
	import type { TraceReport } from '#lib/types';

	/**
	 * The decision graph of one captured trace: entries as nodes in swimlanes
	 * (user / agent / tools / context), semantic edges as verbs (prompt, call,
	 * ran, failed, observed, answer). Built entirely from the stored snapshot;
	 * clicking a node fetches the exact stored content from the sandbox.
	 */

	let { report }: { report: TraceReport } = $props();

	const graph = $derived(buildDecisionGraph(report));
	const summary = $derived(summarizeDecisions(report));

	let selectedKey = $state<string | undefined>(undefined);
	// Node details open in a modal; closing it clears the selection (and the
	// edge highlighting that comes with it).
	let modalOpen = $state(false);
	const select = (key: string) => {
		selectedKey = key;
		modalOpen = true;
	};
	const selected = $derived(selectedKey === undefined ? undefined : graph.byKey.get(selectedKey));
	const selectedEntry = $derived(
		selected === undefined
			? undefined
			: report.entries.items.find((item) => item.id === selected.entryId)
	);

	// Tool nodes open the pair in one panel: the assistant entry that carries the
	// call's params and the tool-result entry that carries the outcome.
	const toolView = $derived.by(() => {
		if (selected === undefined || selected.lane !== 'tool') return undefined;
		return {
			node: selected,
			callEntryId: selected.isDecision ? selected.entryId : selected.callEntryId,
			resultEntryId: selected.isDecision ? selected.resultEntryId : selected.entryId
		};
	});

	let details = $state<Record<number, TraceEntryDetailData | undefined>>({});
	let fetchErrors = $state<Record<number, string | undefined>>({});

	const fetchDetail = (id: number) => {
		if (details[id] !== undefined || fetchErrors[id] !== undefined) return;
		fetch(`/api/trace-entry?id=${id}`)
			.then(async (response) => {
				const body = (await response.json()) as TraceEntryDetailData & { error?: string };
				if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
				details[id] = body;
			})
			.catch((cause: unknown) => {
				fetchErrors[id] = cause instanceof Error ? cause.message : String(cause);
			});
	};

	$effect(() => {
		if (toolView === undefined) return;
		if (toolView.callEntryId !== undefined) fetchDetail(toolView.callEntryId);
		if (toolView.resultEntryId !== undefined) fetchDetail(toolView.resultEntryId);
	});

	const messageParts = (content: TraceMessage['content']): TraceContentPart[] =>
		typeof content === 'string' ? [{ type: 'text', text: content }] : content;

	/** The exact toolCall part of the paired call, matched by toolCallId, then by position and name. */
	const callArguments = (
		view: { node: GraphNode; callEntryId?: number; resultEntryId?: number },
		cache: Record<number, TraceEntryDetailData | undefined>
	): { name: string; arguments: Record<string, unknown> } | undefined => {
		if (view.callEntryId === undefined) return undefined;
		const assistant = cache[view.callEntryId];
		if (assistant === undefined) return undefined;
		const callId = cache[view.resultEntryId ?? -1]?.messages.find(
			(message) => message.role === 'toolResult'
		)?.toolCallId;
		for (const message of assistant.messages) {
			if (message.role !== 'assistant') continue;
			const calls = messageParts(message.content).filter(
				(part): part is Extract<TraceContentPart, { type: 'toolCall' }> => part.type === 'toolCall'
			);
			const byId = callId === undefined ? undefined : calls.find((part) => part.id === callId);
			const pick =
				byId ??
				(view.node.callIndex !== undefined ? calls[view.node.callIndex] : undefined) ??
				calls.find((part) => part.name === view.node.title);
			if (pick !== undefined)
				return { name: pick.name, arguments: pick.arguments as Record<string, unknown> };
		}
		return undefined;
	};

	/** The result's text content and outcome, from the paired tool-result entry. */
	const resultContent = (
		view: { node: GraphNode; callEntryId?: number; resultEntryId?: number },
		cache: Record<number, TraceEntryDetailData | undefined>
	): { text: string; isError: boolean; durationMs?: number } | undefined => {
		if (view.resultEntryId === undefined) return undefined;
		const detail = cache[view.resultEntryId];
		if (detail === undefined) return undefined;
		for (const message of detail.messages) {
			if (message.role !== 'toolResult') continue;
			return {
				text: messageParts(message.content)
					.map((part) => (part.type === 'text' ? part.text : ''))
					.join('\n')
					.trim(),
				isError: message.isError === true,
				durationMs: message.durationMs
			};
		}
		return undefined;
	};

	const touch = (edge: GraphEdge): boolean =>
		selectedKey !== undefined && (edge.from === selectedKey || edge.to === selectedKey);

	const nodeClass = (node: GraphNode): string => {
		if (selectedKey === node.key) return 'stroke-primary stroke-2';
		if (node.isContextCut) return 'stroke-muted-foreground/60';
		if (node.isError) return 'stroke-red-400';
		if (node.isDecision) return 'stroke-amber-500/70';
		if (node.isFinal) return 'stroke-teal-500/70';
		return 'stroke-border';
	};
</script>

<div class="flex flex-col gap-4">
	<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
		{#each [{ label: 'Turns', value: formatNumber(summary.turns) }, { label: 'Tool decisions', value: formatNumber(summary.decisionTurns) }, { label: 'Tool calls', value: formatNumber(summary.calls) }, { label: 'Errors', value: formatNumber(summary.errors) }, { label: 'Avg calls/decision', value: summary.avgCallsPerDecision.toFixed(1) }] as stat (stat.label)}
			<div class="rounded-lg border border-border p-3">
				<span class="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
					{stat.label}
				</span>
				<p class="mt-0.5 text-lg font-semibold tracking-tight">{stat.value}</p>
			</div>
		{/each}
	</div>

	{#if summary.ranking.length > 0}
		<div
			class="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-lg border border-border p-3 text-xs"
		>
			<span class="font-medium tracking-wide text-muted-foreground uppercase">Tool usage</span>
			{#each summary.ranking as tool (tool.tool)}
				<span class="flex items-center gap-1.5">
					<span class="font-mono">{tool.tool}</span>
					<Badge variant="secondary" class="font-normal">{tool.calls}</Badge>
					{#if tool.errors > 0}
						<Badge variant="destructive" class="font-normal">{tool.errors} err</Badge>
					{/if}
				</span>
			{/each}
		</div>
	{/if}

	<div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
		{#each Object.entries(VERB_LABEL) as [verb, label] (verb)}
			<span class="flex items-center gap-1.5">
				<svg width="22" height="6" aria-hidden="true">
					<line x1="0" y1="3" x2="22" y2="3" class="{VERB_STROKE[verb as Verb]} stroke-2"></line>
				</svg>
				{label}
			</span>
		{/each}
		<span class="ml-auto">
			{#if graph.truncatedBy > 0}
				showing the newest {graph.total - graph.truncatedBy} of {graph.total} entries
			{:else if report.entries.hasMore}
				snapshot page only — older entries exist in the conversation
			{/if}
		</span>
	</div>

	<div class="overflow-auto rounded-xl border border-border bg-muted/10">
		<svg
			width={graph.width + 40}
			height={graph.height}
			class="block"
			role="img"
			aria-label="Agent decision graph"
		>
			{#each graph.bands as band (band.y)}
				<rect
					x="0"
					y={band.y}
					width={graph.width + 40}
					height={band.height}
					class={band.turn % 2 === 0 ? 'fill-muted/20' : 'fill-transparent'}
				></rect>
			{/each}

			{#each Object.entries(graph.lanes) as [lane, x] (lane)}
				<text
					{x}
					y="14"
					class="fill-muted-foreground text-[10px] font-medium tracking-widest uppercase"
				>
					{lane}
				</text>
				<line
					x1={x + (lane === 'context' ? CONTEXT_W + 20 : NODE_W + 20)}
					y1="22"
					x2={x + (lane === 'context' ? CONTEXT_W + 20 : NODE_W + 20)}
					y2={graph.height - 8}
					class="stroke-border"
					stroke-dasharray="2 6"
				></line>
			{/each}

			{#each graph.edges as edge (edge.key)}
				{@const from = graph.byKey.get(edge.from)}
				{@const to = graph.byKey.get(edge.to)}
				{#if from && to}
					{@const sameRow = Math.abs(from.y - to.y) < 2}
					{@const x1 = sameRow ? from.x + NODE_W : from.x + NODE_W / 2}
					{@const y1 = sameRow ? from.y + NODE_H / 2 : from.y + NODE_H}
					{@const x2 = sameRow ? to.x : to.x + NODE_W / 2}
					{@const y2 = sameRow ? to.y + NODE_H / 2 : to.y}
					{@const mx = (x1 + x2) / 2}
					{@const my = (y1 + y2) / 2}
					<path
						d={sameRow
							? `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`
							: `M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}`}
						fill="none"
						class="{VERB_STROKE[edge.verb]} {touch(edge)
							? 'stroke-[2.5]'
							: 'stroke-1.5'} {selectedKey !== undefined && !touch(edge) ? 'opacity-30' : ''}"
					>
						<title>{VERB_LABEL[edge.verb]}: {from.title} → {to.title}</title>
					</path>
					{#if sameRow || touch(edge)}
						<circle
							cx={x2}
							cy={y2}
							r="2.5"
							class="{VERB_STROKE[edge.verb]} fill-background stroke-2"
						></circle>
					{/if}
				{/if}
			{/each}

			{#each graph.nodes as node (node.key)}
				<g
					class="cursor-pointer"
					role="button"
					tabindex="0"
					aria-label="{node.lane} node {node.title}"
					onclick={() => select(node.key)}
					onkeydown={(event) => {
						if (event.key === 'Enter' || event.key === ' ') {
							event.preventDefault();
							select(node.key);
						}
					}}
				>
					<rect
						x={node.x}
						y={node.y}
						width={node.lane === 'context' ? CONTEXT_W : NODE_W}
						height={NODE_H}
						rx="8"
						class="fill-background {nodeClass(node)}"
						stroke-width="1.5"
						stroke-dasharray={node.isContextCut ? '4 3' : undefined}
					></rect>
					<text x={node.x + 10} y={node.y + 17} class="fill-foreground text-[11px] font-medium">
						{clip(node.title, node.lane === 'context' ? 26 : 20)}
					</text>
					<text x={node.x + 10} y={node.y + 32} class="fill-muted-foreground text-[10px]">
						{node.sub}
					</text>
					<title>entry #{node.entryId} · {node.title} · {node.sub}</title>
				</g>
			{/each}
		</svg>
	</div>

	<Dialog.Root
		open={modalOpen && selected !== undefined}
		onOpenChange={(open) => {
			modalOpen = open;
			if (!open) selectedKey = undefined;
		}}
	>
		<Dialog.Content class="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
			{#if selected && selectedEntry && toolView}
				{@const call = callArguments(toolView, details)}
				{@const result = resultContent(toolView, details)}
				<Dialog.Header>
					<Dialog.Title class="flex flex-wrap items-center gap-2 font-mono"
						>{toolView.node.title}
						{#if toolView.resultEntryId !== undefined}
							{#if result?.isError ?? toolView.node.isError}
								<Badge variant="destructive" class="font-normal">error</Badge>
							{:else}
								<Badge class="font-normal">ran</Badge>
							{/if}
						{/if}
						{#if result?.durationMs !== undefined || (toolView.resultEntryId === undefined && selectedEntry.durationMs !== undefined)}
							<span class="text-xs font-normal text-muted-foreground"
								>{result?.durationMs ?? selectedEntry.durationMs} ms</span
							>
						{/if}
					</Dialog.Title>
					<Dialog.Description>
						call entry #{toolView.callEntryId ?? '—'} → result entry #{toolView.resultEntryId ??
							'—'}
					</Dialog.Description>
				</Dialog.Header>
				<div class="grid gap-3 lg:grid-cols-2">
					<div class="flex flex-col gap-2">
						<span class="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
							Call parameters
						</span>
						{#if toolView.callEntryId === undefined}
							<p class="text-xs text-muted-foreground">No paired call entry (old snapshot).</p>
						{:else if fetchErrors[toolView.callEntryId]}
							<p class="text-xs text-destructive">{fetchErrors[toolView.callEntryId]}</p>
						{:else if !call}
							<p class="text-xs text-muted-foreground">Reading the call…</p>
						{:else}
							<pre
								class="max-h-[40vh] overflow-auto rounded-lg border border-border bg-muted/30 p-3 text-xs leading-relaxed">{JSON.stringify(
									call.arguments,
									null,
									2
								)}</pre>
						{/if}
					</div>
					<div class="flex flex-col gap-2">
						<span class="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
							Result
						</span>
						{#if toolView.resultEntryId === undefined}
							<p class="text-xs text-muted-foreground">
								No result entry in this snapshot (call still open or truncated).
							</p>
						{:else if fetchErrors[toolView.resultEntryId]}
							<p class="text-xs text-destructive">{fetchErrors[toolView.resultEntryId]}</p>
						{:else if !result}
							<p class="text-xs text-muted-foreground">Reading the result…</p>
						{:else}
							<pre
								class="max-h-[40vh] overflow-auto rounded-lg border border-border bg-muted/30 p-3 text-xs leading-relaxed whitespace-pre-wrap">{result.text ||
									'(empty result)'}</pre>
						{/if}
					</div>
				</div>
			{:else if selected && selectedEntry}
				<Dialog.Header>
					<Dialog.Title>entry #{selected.entryId} · {selectedEntry.kind}</Dialog.Title>
					<Dialog.Description class="max-w-xl truncate">{selectedEntry.summary}</Dialog.Description>
				</Dialog.Header>
				<TraceEntryDetail id={selected.entryId} compact />
			{/if}
		</Dialog.Content>
	</Dialog.Root>

	<p class="text-xs text-muted-foreground">
		Click a node to open its details in a modal: tool nodes show the call parameters next to the
		result; other nodes show the exact stored messages (thinking, tool-call arguments included).
	</p>
</div>
