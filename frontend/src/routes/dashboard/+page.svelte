<script lang="ts">
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import ArrowUp from '@lucide/svelte/icons/arrow-up';
	import FileText from '@lucide/svelte/icons/file-text';
	import LibraryBig from '@lucide/svelte/icons/library-big';
	import History from '@lucide/svelte/icons/history';
	import Coins from '@lucide/svelte/icons/coins';
	import { Button } from '#lib/components/ui/button';
	import { Badge } from '#lib/components/ui/badge';
	import * as Card from '#lib/components/ui/card';
	import * as Empty from '#lib/components/ui/empty';
	import * as Table from '#lib/components/ui/table';
	import { formatBytes, formatCost, formatDate, formatNumber, shortId } from '#lib/format';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const stats = $derived([
		{
			label: 'Documents',
			value: formatNumber(data.stats.documents),
			detail: formatBytes(data.stats.bytes),
			icon: FileText
		},
		{
			label: 'Corpus',
			value: formatNumber(data.stats.corpora),
			detail: 'collections',
			icon: LibraryBig
		},
		{
			label: 'Trace sessions',
			value: formatNumber(data.stats.sessions),
			detail: 'captured',
			icon: History
		},
		{
			label: 'Tokens',
			value: formatNumber(data.stats.tokens),
			detail: formatCost(data.stats.cost),
			icon: Coins
		}
	]);

	const suggestions = ['Summarize data.txt', 'List the workspace files', 'What changed today?'];
</script>

<svelte:head>
	<title>Overview — Durable</title>
</svelte:head>

<div class="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-8">
	<div class="flex flex-col justify-between gap-4 md:flex-row md:items-end">
		<div>
			<p class="text-sm text-muted-foreground">Workspace</p>
			<h1 class="mt-1 font-display text-4xl tracking-tight">Overview</h1>
			<p class="mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">
				Everything your agent can see: documents, corpus collections and the durable trace of each
				conversation.
			</p>
		</div>
		<Button href="/dashboard/chat">
			Ask the agent
			<ArrowRight data-icon="inline-end" />
		</Button>
	</div>

	<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
		{#each stats as stat (stat.label)}
			<Card.Root>
				<Card.Content class="flex flex-row items-start justify-between gap-3">
					<div class="flex flex-col gap-1">
						<span class="text-xs font-medium tracking-wide text-muted-foreground uppercase"
							>{stat.label}</span
						>
						<span class="text-2xl font-semibold tracking-tight">{stat.value}</span>
						<span class="text-xs text-muted-foreground">{stat.detail}</span>
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

	<Card.Root class="border-primary/20 bg-accent/40">
		<Card.Content class="flex flex-col gap-4">
			<div class="flex flex-col gap-1">
				<Card.Title class="font-display text-2xl">What do you want to know?</Card.Title>
				<Card.Description>
					The agent runs in its own container with a durable workspace and resumes the same
					conversation after a pause.
				</Card.Description>
			</div>
			<a
				href="/dashboard/chat"
				class="flex items-center gap-3 rounded-xl border border-border bg-card p-2 pl-4 transition-colors hover:border-primary/40"
			>
				<span class="flex-1 truncate text-sm text-muted-foreground">Ask about your documents…</span>
				<span
					class="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground"
				>
					<ArrowUp class="size-4" />
				</span>
			</a>
			<div class="flex flex-wrap gap-2">
				{#each suggestions as suggestion (suggestion)}
					<a href="/dashboard/chat">
						<Badge variant="secondary" class="font-normal">{suggestion}</Badge>
					</a>
				{/each}
			</div>
		</Card.Content>
	</Card.Root>

	<div class="grid gap-4 lg:grid-cols-2">
		<Card.Root>
			<Card.Header class="flex flex-row items-center justify-between">
				<div>
					<Card.Title>Recent documents</Card.Title>
					<Card.Description>Text files the agent can be pointed at.</Card.Description>
				</div>
				<Button variant="ghost" size="sm" href="/dashboard/documents">View all</Button>
			</Card.Header>
			<Card.Content>
				{#if data.documents.length === 0}
					<Empty.Root class="p-8">
						<Empty.Header>
							<Empty.Media variant="icon">
								<FileText class="size-5" />
							</Empty.Media>
							<Empty.Title>No documents yet</Empty.Title>
							<Empty.Description>Add a text document to start a corpus.</Empty.Description>
						</Empty.Header>
						<Empty.Content>
							<Button size="sm" href="/dashboard/documents?new=1">Add document</Button>
						</Empty.Content>
					</Empty.Root>
				{:else}
					<Table.Root>
						<Table.Header>
							<Table.Row>
								<Table.Head>Title</Table.Head>
								<Table.Head>Corpus</Table.Head>
								<Table.Head class="text-right">Size</Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#each data.documents as doc (doc.id)}
								<Table.Row>
									<Table.Cell>
										<a
											class="font-medium hover:text-primary"
											href="/dashboard/documents?doc={doc.id}">{doc.title}</a
										>
									</Table.Cell>
									<Table.Cell>
										{#if doc.corpora.length === 0}
											<span class="text-xs text-muted-foreground">—</span>
										{:else}
											<div class="flex flex-wrap gap-1">
												{#each doc.corpora.slice(0, 2) as corpus (corpus.id)}
													<Badge variant="outline" class="font-normal">{corpus.name}</Badge>
												{/each}
											</div>
										{/if}
									</Table.Cell>
									<Table.Cell class="text-right text-xs text-muted-foreground"
										>{formatBytes(doc.size)}</Table.Cell
									>
								</Table.Row>
							{/each}
						</Table.Body>
					</Table.Root>
				{/if}
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Header class="flex flex-row items-center justify-between">
				<div>
					<Card.Title>Recent traces</Card.Title>
					<Card.Description>The latest snapshot of each sandbox conversation.</Card.Description>
				</div>
				<Button variant="ghost" size="sm" href="/dashboard/traces">View all</Button>
			</Card.Header>
			<Card.Content>
				{#if data.sessions.length === 0}
					<Empty.Root class="p-8">
						<Empty.Header>
							<Empty.Media variant="icon">
								<History class="size-5" />
							</Empty.Media>
							<Empty.Title>No traces yet</Empty.Title>
							<Empty.Description>Send a prompt and the first trace is captured.</Empty.Description>
						</Empty.Header>
						<Empty.Content>
							<Button size="sm" href="/dashboard/chat">Open chat</Button>
						</Empty.Content>
					</Empty.Root>
				{:else}
					<div class="flex flex-col divide-y">
						{#each data.sessions as session (session.id)}
							<a
								href="/dashboard/traces/{session.id}"
								class="flex items-center justify-between gap-3 rounded-md px-2 py-3 transition-colors hover:bg-muted/50"
							>
								<div class="flex min-w-0 flex-col gap-0.5">
									<span class="text-sm font-medium">Conversation {session.conversationId}</span>
									<span class="truncate text-xs text-muted-foreground">
										{shortId(session.agent, 18)} · {formatDate(session.capturedAt)}
									</span>
								</div>
								<div class="flex shrink-0 items-center gap-2">
									<Badge variant={session.paused ? 'secondary' : 'outline'} class="font-normal">
										{session.paused ? 'paused' : 'active'}
									</Badge>
									<span class="text-xs text-muted-foreground">{session.entries} entries</span>
								</div>
							</a>
						{/each}
					</div>
				{/if}
			</Card.Content>
		</Card.Root>
	</div>
</div>
