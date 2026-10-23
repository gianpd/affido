<script lang="ts">
	import { enhance } from '$app/forms';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import History from '@lucide/svelte/icons/history';
	import ListTree from '@lucide/svelte/icons/list-tree';
	import Coins from '@lucide/svelte/icons/coins';
	import Layers from '@lucide/svelte/icons/layers';
	import { Button } from '#lib/components/ui/button';
	import { Badge } from '#lib/components/ui/badge';
	import * as Card from '#lib/components/ui/card';
	import * as Table from '#lib/components/ui/table';
	import * as Tabs from '#lib/components/ui/tabs';
	import * as Alert from '#lib/components/ui/alert';
	import * as Empty from '#lib/components/ui/empty';
	import * as Collapsible from '#lib/components/ui/collapsible';
	import { Separator } from '#lib/components/ui/separator';
	import TraceGraph from '#lib/components/trace-graph.svelte';
	import TraceEntryDetail from '#lib/components/trace-entry-detail.svelte';
	import ChevronLeft from '@lucide/svelte/icons/chevron-left';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import Waypoints from '@lucide/svelte/icons/waypoints';
	import { formatCost, formatDate, formatNumber } from '#lib/format';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	let refreshing = $state(false);
	const report = $derived(data.report);

	// Per-entry expansion: the report only carries a 160-character summary, so the
	// stored messages are fetched one entry at a time when a row is opened.
	let rows = $state<Record<number, boolean | undefined>>({});

	const toggle = (id: number) => {
		rows[id] = !(rows[id] ?? false);
	};

	const stats = $derived([
		{ label: 'Entries', value: formatNumber(report.entries.returned), icon: ListTree },
		{ label: 'Tokens', value: formatNumber(report.usage.totalTokens), icon: Layers },
		{ label: 'Cost', value: formatCost(report.usage.cost), icon: Coins },
		{
			label: 'Live work',
			value: `${report.tasks.length + report.submissions.length}`,
			icon: History
		}
	]);
</script>

<svelte:head>
	<title>Conversation {data.session.conversationId} — Durable</title>
</svelte:head>

<div class="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-8">
	<a
		href="/dashboard/traces"
		class="flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
	>
		<ArrowLeft class="size-4" />
		All traces
	</a>

	<div class="flex flex-col justify-between gap-4 md:flex-row md:items-end">
		<div class="min-w-0">
			<div class="flex flex-wrap items-center gap-3">
				<h1 class="truncate font-display text-4xl tracking-tight">
					Conversation {data.session.conversationId}
				</h1>
				<Badge variant={data.session.paused ? 'secondary' : 'outline'} class="font-normal">
					{data.session.paused ? 'paused at capture' : 'active at capture'}
				</Badge>
			</div>
			<p class="mt-2 text-sm text-muted-foreground">
				Agent <span class="font-mono text-xs">{data.session.agent}</span> · captured
				{formatDate(data.session.capturedAt)}
			</p>
			{#if data.snapshotCount > 1}
				<div class="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
					<span
						>Capture {data.snapshotCount - data.snapshotIndex}/{data.snapshotCount} of this conversation</span
					>
					{#if data.olderSnapshot}
						<a
							href="/dashboard/traces/{data.olderSnapshot.id}"
							class="flex items-center gap-1 transition-colors hover:text-foreground"
						>
							<ChevronLeft class="size-3.5" />
							older ({formatDate(data.olderSnapshot.capturedAt)})
						</a>
					{/if}
					{#if data.newerSnapshot}
						<a
							href="/dashboard/traces/{data.newerSnapshot.id}"
							class="flex items-center gap-1 transition-colors hover:text-foreground"
						>
							newer ({formatDate(data.newerSnapshot.capturedAt)})
							<ChevronRight class="size-3.5" />
						</a>
					{/if}
				</div>
			{/if}
		</div>
		<div class="flex flex-wrap gap-2">
			<form
				method="POST"
				action="?/refresh"
				use:enhance={() => {
					refreshing = true;
					return async ({ update }) => {
						await update();
						refreshing = false;
					};
				}}
			>
				<Button type="submit" disabled={refreshing}>
					<RefreshCw data-icon="inline-start" class={refreshing ? 'animate-spin' : ''} />
					{refreshing ? 'Refreshing…' : 'Refresh from sandbox'}
				</Button>
			</form>
			<form method="POST" action="?/delete">
				<Button type="submit" variant="outline">
					<Trash2 data-icon="inline-start" />
					Forget snapshot
				</Button>
			</form>
		</div>
	</div>

	{#if form?.message}
		<Alert.Root variant="destructive">
			<Alert.Title>Could not refresh the trace</Alert.Title>
			<Alert.Description>{form.message}</Alert.Description>
		</Alert.Root>
	{/if}

	<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
		{#each stats as stat (stat.label)}
			<Card.Root>
				<Card.Content class="flex flex-row items-center justify-between">
					<div class="flex flex-col gap-1">
						<span class="text-xs font-medium tracking-wide text-muted-foreground uppercase"
							>{stat.label}</span
						>
						<span class="text-2xl font-semibold tracking-tight">{stat.value}</span>
					</div>
					<div
						class="flex size-9 items-center justify-center rounded-lg bg-accent text-accent-foreground"
					>
						<stat.icon class="size-4" />
					</div>
				</Card.Content>
			</Card.Root>
		{/each}
	</div>

	<div class="flex flex-wrap items-center gap-x-6 gap-y-1 text-xs text-muted-foreground">
		<span>Input tokens: {formatNumber(report.usage.input)}</span>
		<span>Output tokens: {formatNumber(report.usage.output)}</span>
		<span>Page has more: {report.entries.hasMore ? 'yes' : 'no'}</span>
		<span>Conversation {report.conversationId}</span>
	</div>

	<Separator />

	<Tabs.Root value="graph">
		<Tabs.List>
			<Tabs.Trigger value="graph">
				<Waypoints data-icon="inline-start" />
				Decision graph
			</Tabs.Trigger>
			<Tabs.Trigger value="entries">Entries ({report.entries.returned})</Tabs.Trigger>
			<Tabs.Trigger value="tasks">Tasks ({report.tasks.length})</Tabs.Trigger>
			<Tabs.Trigger value="submissions">Submissions ({report.submissions.length})</Tabs.Trigger>
			<Tabs.Trigger value="raw">Raw report</Tabs.Trigger>
		</Tabs.List>

		<Tabs.Content value="graph" class="pt-4">
			<TraceGraph {report} />
		</Tabs.Content>

		<Tabs.Content value="entries" class="pt-4">
			{#if report.entries.items.length === 0}
				<Empty.Root class="border">
					<Empty.Header>
						<Empty.Media variant="icon">
							<History class="size-5" />
						</Empty.Media>
						<Empty.Title>No entries in this page</Empty.Title>
						<Empty.Description>
							Send a prompt first. Entries are the durable record of the conversation.
						</Empty.Description>
					</Empty.Header>
				</Empty.Root>
			{:else}
				<div class="overflow-hidden rounded-xl border border-border">
					<Table.Root>
						<Table.Header>
							<Table.Row>
								<Table.Head class="w-14">#</Table.Head>
								<Table.Head class="w-44">Kind</Table.Head>
								<Table.Head class="w-52">Time</Table.Head>
								<Table.Head>Summary</Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#each report.entries.items as entry (entry.id)}
								<Table.Row class="align-top">
									<Table.Cell class="font-mono text-xs text-muted-foreground">{entry.id}</Table.Cell
									>
									<Table.Cell>
										<Badge variant="outline" class="font-mono text-[11px] font-normal"
											>{entry.kind}</Badge
										>
									</Table.Cell>
									<Table.Cell class="text-xs text-muted-foreground"
										>{formatDate(entry.at)}</Table.Cell
									>
									<Table.Cell class="max-w-0">
										<p class="text-xs leading-relaxed whitespace-pre-wrap">{entry.summary}</p>
										<Button
											variant="ghost"
											size="xs"
											class="mt-1 text-muted-foreground"
											aria-expanded={rows[entry.id] ?? false}
											onclick={() => toggle(entry.id)}
										>
											{rows[entry.id] ? 'Hide exact content' : 'Show exact content'}
										</Button>
										{#if rows[entry.id]}
											<TraceEntryDetail id={entry.id} />
										{/if}
									</Table.Cell>
								</Table.Row>
							{/each}
						</Table.Body>
					</Table.Root>
				</div>
			{/if}
		</Tabs.Content>

		<Tabs.Content value="tasks" class="pt-4">
			{#if report.tasks.length === 0}
				<Empty.Root class="border">
					<Empty.Header>
						<Empty.Media variant="icon">
							<ListTree class="size-5" />
						</Empty.Media>
						<Empty.Title>No live tasks</Empty.Title>
						<Empty.Description>Settled work is visible in the entries tab.</Empty.Description>
					</Empty.Header>
				</Empty.Root>
			{:else}
				<div class="overflow-hidden rounded-xl border border-border">
					<Table.Root>
						<Table.Header>
							<Table.Row>
								<Table.Head>ID</Table.Head>
								<Table.Head>Kind</Table.Head>
								<Table.Head>Status</Table.Head>
								<Table.Head>Background</Table.Head>
								<Table.Head>Started</Table.Head>
								<Table.Head>Ended</Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#each report.tasks as task (task.id)}
								<Table.Row>
									<Table.Cell class="font-mono text-xs">{task.id}</Table.Cell>
									<Table.Cell class="text-xs">{task.kind}</Table.Cell>
									<Table.Cell
										><Badge variant="secondary" class="font-normal">{task.status}</Badge
										></Table.Cell
									>
									<Table.Cell class="text-xs">{task.background ? 'yes' : 'no'}</Table.Cell>
									<Table.Cell class="text-xs">{formatDate(task.startedAt)}</Table.Cell>
									<Table.Cell class="text-xs">{formatDate(task.endedAt)}</Table.Cell>
								</Table.Row>
							{/each}
						</Table.Body>
					</Table.Root>
				</div>
			{/if}
		</Tabs.Content>

		<Tabs.Content value="submissions" class="pt-4">
			{#if report.submissions.length === 0}
				<Empty.Root class="border">
					<Empty.Header>
						<Empty.Media variant="icon">
							<Layers class="size-5" />
						</Empty.Media>
						<Empty.Title>No queued or placed submissions</Empty.Title>
						<Empty.Description>
							Resolved submissions appear as entries; this list is live work only.
						</Empty.Description>
					</Empty.Header>
				</Empty.Root>
			{:else}
				<div class="overflow-hidden rounded-xl border border-border">
					<Table.Root>
						<Table.Header>
							<Table.Row>
								<Table.Head>ID</Table.Head>
								<Table.Head>Request</Table.Head>
								<Table.Head>Status</Table.Head>
								<Table.Head>Entry</Table.Head>
								<Table.Head>Answer</Table.Head>
								<Table.Head>Reason</Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#each report.submissions as submission (submission.id)}
								<Table.Row>
									<Table.Cell class="font-mono text-xs">{submission.id}</Table.Cell>
									<Table.Cell class="max-w-32 truncate font-mono text-xs"
										>{submission.requestId ?? '—'}</Table.Cell
									>
									<Table.Cell
										><Badge variant="secondary" class="font-normal">{submission.status}</Badge
										></Table.Cell
									>
									<Table.Cell class="font-mono text-xs">{submission.entry ?? '—'}</Table.Cell>
									<Table.Cell class="font-mono text-xs">{submission.answer ?? '—'}</Table.Cell>
									<Table.Cell class="text-xs">{submission.reason ?? '—'}</Table.Cell>
								</Table.Row>
							{/each}
						</Table.Body>
					</Table.Root>
				</div>
			{/if}
		</Tabs.Content>

		<Tabs.Content value="raw" class="pt-4">
			<Collapsible.Root open>
				<Collapsible.Trigger
					class="mb-2 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
				>
					Toggle raw JSON
				</Collapsible.Trigger>
				<Collapsible.Content>
					<pre
						class="max-h-[60vh] overflow-auto rounded-xl bg-muted/40 p-4 text-xs leading-relaxed">{JSON.stringify(
							report,
							null,
							2
						)}</pre>
				</Collapsible.Content>
			</Collapsible.Root>
		</Tabs.Content>
	</Tabs.Root>
</div>
