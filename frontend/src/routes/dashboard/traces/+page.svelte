<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import History from '@lucide/svelte/icons/history';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import MoreHorizontal from '@lucide/svelte/icons/more-horizontal';
	import Coins from '@lucide/svelte/icons/coins';
	import ShieldCheck from '@lucide/svelte/icons/shield-check';
	import Cpu from '@lucide/svelte/icons/cpu';
	import Layers from '@lucide/svelte/icons/layers';
	import { Button } from '#lib/components/ui/button';
	import { Badge } from '#lib/components/ui/badge';
	import * as Card from '#lib/components/ui/card';
	import * as Table from '#lib/components/ui/table';
	import * as Alert from '#lib/components/ui/alert';
	import * as Empty from '#lib/components/ui/empty';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu';
	import { formatCost, formatDate, formatNumber, shortId } from '#lib/format';
	import { captureOrdinals } from '#lib/trace-graph';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	let capturing = $state(false);
	let forgetForm = $state<HTMLFormElement>();

	const forget = (id: string) => {
		const input = forgetForm?.querySelector<HTMLInputElement>('input[name="id"]');
		if (!input) return;
		input.value = id;
		forgetForm?.requestSubmit();
	};

	// Sessions are newest-first; per conversation, label each capture with its
	// position in that conversation's capture history (1 = newest).
	const ordinals = $derived(captureOrdinals(data.sessions));

	const stats = $derived([
		{ label: 'Captures', value: formatNumber(data.sessions.length), icon: Layers },
		{ label: 'Conversations', value: formatNumber(data.conversations), icon: History },
		{ label: 'Tokens', value: formatNumber(data.totals.tokens), icon: Cpu },
		{ label: 'Cost', value: formatCost(data.totals.cost), icon: Coins }
	]);
</script>

<svelte:head>
	<title>Traces — Durable</title>
</svelte:head>

<div class="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-8">
	<div class="flex flex-col justify-between gap-4 md:flex-row md:items-end">
		<div>
			<p class="text-sm text-muted-foreground">Observability</p>
			<h1 class="mt-1 font-display text-4xl tracking-tight">Traces</h1>
			<p class="mt-2 max-w-xl text-sm text-muted-foreground">
				Every capture of every conversation is kept: entries, live tasks, queued submissions and
				folded usage, snapshotted at the moment it was taken. Open a capture to read it entry by
				entry or as a decision graph.
			</p>
		</div>
		<form
			method="POST"
			action="?/capture"
			use:enhance={() => {
				capturing = true;
				return async ({ update }) => {
					await update();
					capturing = false;
				};
			}}
		>
			<Button type="submit" disabled={capturing}>
				<RefreshCw data-icon="inline-start" class={capturing ? 'animate-spin' : ''} />
				{capturing ? 'Capturing…' : 'Capture current trace'}
			</Button>
		</form>
	</div>

	{#if form?.message}
		<Alert.Root variant="destructive">
			<Alert.Title>Could not capture the trace</Alert.Title>
			<Alert.Description>{form.message}</Alert.Description>
		</Alert.Root>
	{/if}

	{#if data.citations && data.citations.runs.length > 0}
		<Card.Root>
			<Card.Header>
				<Card.Title class="flex items-center gap-2">
					<ShieldCheck class="size-4" />
					Citations
					<Badge variant="secondary" class="font-normal">
						{data.citations.exactReplies}/{data.citations.gatedReplies} exact
					</Badge>
				</Card.Title>
				<Card.Description>
					Server-verified citation exactness per strict run, measured from the trace alone (RFC
					0006).
				</Card.Description>
			</Card.Header>
			<Card.Content>
				<div class="overflow-hidden rounded-lg border">
					<Table.Root>
						<Table.Header>
							<Table.Row>
								<Table.Head>Run</Table.Head>
								<Table.Head>Question</Table.Head>
								<Table.Head>Exit</Table.Head>
								<Table.Head>Exact</Table.Head>
								<Table.Head>Friction</Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#each data.citations.runs.slice(0, 10) as run (run.runId)}
								<Table.Row>
									<Table.Cell class="font-mono text-xs">{run.runId.slice(0, 18)}</Table.Cell>
									<Table.Cell class="max-w-[220px] truncate text-xs" title={run.prompt}>
										{run.prompt || '—'}
									</Table.Cell>
									<Table.Cell>
										{#if run.published}
											<Badge class="font-normal">cited</Badge>
										{:else if run.plain}
											<Badge variant="outline" class="font-normal">plain</Badge>
										{:else}
											<Badge variant="destructive" class="font-normal">none</Badge>
										{/if}
									</Table.Cell>
									<Table.Cell>{run.exact ? 'yes' : 'no'}</Table.Cell>
									<Table.Cell class="text-xs text-muted-foreground">
										{Object.entries({ ...run.annotateRejected, ...run.publishRejected })
											.map(([reason, count]) => `${reason} ×${count}`)
											.join(', ') || '—'}
									</Table.Cell>
								</Table.Row>
							{/each}
						</Table.Body>
					</Table.Root>
				</div>
			</Card.Content>
		</Card.Root>
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

	{#if data.sessions.length === 0}
		<Empty.Root class="border">
			<Empty.Header>
				<Empty.Media variant="icon">
					<History class="size-5" />
				</Empty.Media>
				<Empty.Title>No trace captured yet</Empty.Title>
				<Empty.Description>
					Send a prompt from the chat, or capture the current sandbox trace now. The agent must be
					running.
				</Empty.Description>
			</Empty.Header>
			<Empty.Content class="flex gap-2">
				<Button href="/dashboard/chat">Open chat</Button>
				<Button variant="outline" href="/dashboard/traces">Refresh</Button>
			</Empty.Content>
		</Empty.Root>
	{:else}
		<div class="overflow-hidden rounded-xl border border-border">
			<Table.Root>
				<Table.Header>
					<Table.Row>
						<Table.Head>Session</Table.Head>
						<Table.Head>Status</Table.Head>
						<Table.Head class="text-right">Entries</Table.Head>
						<Table.Head class="text-right">Tokens</Table.Head>
						<Table.Head class="text-right">Cost</Table.Head>
						<Table.Head class="hidden lg:table-cell">Captured</Table.Head>
						<Table.Head class="w-10"></Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each data.sessions as session (session.id)}
						<Table.Row>
							<Table.Cell>
								<a
									class="flex items-center gap-2.5 font-medium hover:text-primary"
									href="/dashboard/traces/{session.id}"
								>
									<span
										class="flex size-8 items-center justify-center rounded-md bg-muted text-muted-foreground"
									>
										<History class="size-4" />
									</span>
									<span class="flex flex-col">
										<span class="flex items-center gap-1.5">
											Conversation {session.conversationId}
											<Badge variant="secondary" class="font-normal">
												capture {ordinals[session.id]}
											</Badge>
										</span>
										<span class="text-xs text-muted-foreground">{shortId(session.agent, 22)}</span>
									</span>
								</a>
							</Table.Cell>
							<Table.Cell>
								<Badge variant={session.paused ? 'secondary' : 'outline'} class="font-normal">
									{session.paused ? 'paused' : 'active'}
								</Badge>
							</Table.Cell>
							<Table.Cell class="text-right text-xs">{formatNumber(session.entries)}</Table.Cell>
							<Table.Cell class="text-right text-xs">{formatNumber(session.tokens)}</Table.Cell>
							<Table.Cell class="text-right text-xs">{formatCost(session.cost)}</Table.Cell>
							<Table.Cell class="hidden text-xs text-muted-foreground lg:table-cell">
								{formatDate(session.capturedAt)}
							</Table.Cell>
							<Table.Cell>
								<DropdownMenu.Root>
									<DropdownMenu.Trigger>
										{#snippet child({ props })}
											<Button {...props} variant="ghost" size="icon-sm">
												<MoreHorizontal />
												<span class="sr-only">Actions</span>
											</Button>
										{/snippet}
									</DropdownMenu.Trigger>
									<DropdownMenu.Content align="end">
										<DropdownMenu.Item onSelect={() => goto(`/dashboard/traces/${session.id}`)}>
											<ArrowRight class="size-4" />
											Open
										</DropdownMenu.Item>
										<DropdownMenu.Separator />
										<DropdownMenu.Item variant="destructive" onSelect={() => forget(session.id)}>
											<Trash2 class="size-4" />
											Forget snapshot
										</DropdownMenu.Item>
									</DropdownMenu.Content>
								</DropdownMenu.Root>
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		</div>
	{/if}
</div>

<form method="POST" action="?/delete" bind:this={forgetForm} class="hidden">
	<input type="hidden" name="id" />
</form>
