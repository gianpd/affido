<script lang="ts">
	import { Badge, type BadgeVariant } from '#lib/components/ui/badge';
	import * as Table from '#lib/components/ui/table';
	import type { CitationRunJudge, JudgeAttempt, JudgeOutcome, JudgePairVerdict } from '#lib/types';

	/**
	 * The stored coherence-judge trace of one citation run (RFC 0017 §6, record
	 * keeping per RFC 0020 §4.1). `judge` is null when the layer never ran: no
	 * OpenRouter credential backed the run, or the mode was off.
	 *
	 * The counts and the per-pair table describe the attempt that published;
	 * one row per attempt carries its outcome badge and its named error causes,
	 * so a reviewer can see what the judge said about the answer that shipped
	 * and what happened to the attempts that did not.
	 */
	let { judge }: { judge?: CitationRunJudge | null } = $props();

	const attempts = $derived(judge?.attempts ?? []);
	const published = $derived(judge?.published ?? null);
	const lastAttemptNo = $derived(
		attempts.length > 0 ? (attempts[attempts.length - 1]?.attempt ?? 0) : 0
	);
	let selectedNo = $state<number | null>(null);
	const current = $derived(
		selectedNo === null
			? (published ?? attempts[attempts.length - 1] ?? null)
			: (attempts.find((attempt) => attempt.attempt === selectedNo) ?? null)
	);
	const isPublishedAttempt = $derived(
		current !== null && published !== null && current.attempt === published.attempt
	);
	const verdicts = $derived(isPublishedAttempt ? (judge?.verdicts ?? []) : []);

	const variantOf = (verdict: JudgePairVerdict['verdict']): BadgeVariant =>
		verdict === 'supported' ? 'default' : verdict === 'contradicted' ? 'destructive' : 'outline';

	const outcomeVariant = (outcome: JudgeOutcome): BadgeVariant =>
		outcome === 'published'
			? 'default'
			: outcome === 'incoherent_citation'
				? 'destructive'
				: 'outline';

	const outcomeLabel: Record<JudgeOutcome, string> = {
		published: 'published',
		incoherent_citation: 'incoherent citation',
		judge_error_unverified: 'unverified (judge error)',
		judge_budget_exhausted: 'budget exhausted'
	};

	const causeSummary = (attempt: JudgeAttempt): string =>
		Object.entries(attempt.errorCauses)
			.map(([cause, count]) => `${count}× ${cause}`)
			.join(', ');

	const mergedCauses = $derived(
		Object.entries(
			(judge?.attempts ?? []).reduce<Record<string, number>>((causes, attempt) => {
				for (const [cause, count] of Object.entries(attempt.errorCauses)) {
					causes[cause] = (causes[cause] ?? 0) + (count ?? 0);
				}
				return causes;
			}, {})
		)
			.map(([cause, count]) => `${count}× ${cause}`)
			.join(', ')
	);
</script>

{#if !judge}
	<p class="text-xs text-muted-foreground">
		No judge verdicts: the coherence layer did not run for this citation run. It is available only
		while OpenRouter backs the run, a key is delivered, and the judge mode is not off.
	</p>
{:else}
	<div class="flex flex-col gap-3">
		<div class="flex flex-wrap items-center gap-2 text-xs">
			<Badge variant="secondary" class="font-normal">mode: {judge.mode}</Badge>
			{#if current !== null}
				<Badge variant={outcomeVariant(current.outcome)} class="font-normal">
					attempt {current.attempt} of {lastAttemptNo} · {outcomeLabel[current.outcome]}
				</Badge>
			{/if}
			{#if isPublishedAttempt}
				<Badge variant="default" class="font-normal">{judge.supported} supported</Badge>
				<Badge variant="outline" class="font-normal">{judge.unsupported} unsupported</Badge>
				<Badge variant={judge.contradicted > 0 ? 'destructive' : 'outline'} class="font-normal">
					{judge.contradicted} contradicted
				</Badge>
			{/if}
			{#if current !== null && current.legacy}
				<Badge variant="secondary" class="font-normal">legacy trace</Badge>
			{/if}
			{#if current?.latencyMs}
				<span class="text-muted-foreground">
					p50 {Math.round(current.latencyMs.p50)} ms · p95 {Math.round(current.latencyMs.p95)} ms · max
					{Math.round(current.latencyMs.max)} ms
				</span>
			{/if}
			{#if current !== null && current.truncated > 0}
				<span class="text-muted-foreground">{current.truncated} truncated</span>
			{/if}
			{#if current !== null && current.errors > 0}
				<span class="text-destructive">
					{current.errors} error{current.errors === 1 ? '' : 's'}: {causeSummary(current) ||
						'unknown cause'}
				</span>
			{/if}
			{#if judge.judgeRejections > 0}
				<span class="text-destructive">{judge.judgeRejections} rejected</span>
			{/if}
		</div>

		{#if attempts.length > 0}
			<div class="flex flex-wrap items-center gap-1">
				<span class="mr-1 text-xs text-muted-foreground">attempts:</span>
				{#each attempts as attempt (attempt.attempt)}
					<button
						type="button"
						class="rounded-md border px-2 py-0.5 font-mono text-xs transition-colors hover:bg-accent {current?.attempt ===
						attempt.attempt
							? 'bg-accent text-accent-foreground'
							: 'text-muted-foreground'}"
						onclick={() => (selectedNo = attempt.attempt)}
					>
						#{attempt.attempt}
						<span class="font-sans text-[10px]">{outcomeLabel[attempt.outcome]}</span>
					</button>
				{/each}
			</div>
		{/if}

		{#if current !== null && !isPublishedAttempt}
			<p class="text-xs text-muted-foreground">
				Attempt #{current.attempt} answered {current.pairs} pair{current.pairs === 1 ? '' : 's'} across
				{current.lines} line{current.lines === 1 ? '' : 's'} before {outcomeLabel[current.outcome]};
				per-pair verdicts are kept for the attempt that published.
			</p>
		{:else if verdicts.length === 0}
			<p class="text-xs text-muted-foreground">
				{judge.judgeVerdicts > 0
					? 'The aggregate is recorded, but this sandbox image did not return the per-pair verdicts.'
					: 'No pairs were judged: no publish reached the coherence layer.'}
			</p>
		{:else}
			<div class="overflow-hidden rounded-lg border">
				<Table.Root>
					<Table.Header>
						<Table.Row>
							<Table.Head class="w-16">Line</Table.Head>
							<Table.Head>Citation</Table.Head>
							<Table.Head class="w-32">Verdict</Table.Head>
							<Table.Head class="w-20 text-right" title="The endpoint's confidence in its verdict"
								>Score</Table.Head
							>
							<Table.Head
								class="w-20 text-right"
								title="probabilities.supported, the label probability">P(sup)</Table.Head
							>
							<Table.Head
								class="w-20 text-right"
								title="Best supported − best non-supported of the line">Margin</Table.Head
							>
							<Table.Head class="w-24 text-right">Latency</Table.Head>
							<Table.Head class="w-24">Truncated</Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each verdicts as verdict, index (`${verdict.citationId}-${index}`)}
							<Table.Row>
								<Table.Cell class="font-mono text-xs">{verdict.line}</Table.Cell>
								<Table.Cell class="font-mono text-xs">
									{verdict.citationId}
									{#if verdict.cached}
										<Badge variant="secondary" class="ml-1 font-normal">cached</Badge>
									{/if}
								</Table.Cell>
								<Table.Cell>
									<Badge variant={variantOf(verdict.verdict)} class="font-normal">
										{verdict.verdict}
									</Badge>
								</Table.Cell>
								<Table.Cell class="text-right text-xs">{verdict.score.toFixed(2)}</Table.Cell>
								<Table.Cell class="text-right text-xs">
									{verdict.probabilities ? verdict.probabilities.supported.toFixed(2) : '—'}
								</Table.Cell>
								<Table.Cell class="text-right text-xs">
									{verdict.margin !== undefined ? verdict.margin.toFixed(2) : '—'}
								</Table.Cell>
								<Table.Cell class="text-right text-xs">
									{verdict.cached ? 'cached' : `${Math.round(verdict.ms)} ms`}
								</Table.Cell>
								<Table.Cell class="text-xs text-muted-foreground">
									{verdict.truncated ? 'yes' : '—'}
								</Table.Cell>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			</div>
		{/if}

		{#if mergedCauses}
			<p class="text-xs text-muted-foreground">
				<span class="text-destructive">Judge errors across attempts:</span>
				{mergedCauses}
			</p>
		{/if}
	</div>
{/if}
