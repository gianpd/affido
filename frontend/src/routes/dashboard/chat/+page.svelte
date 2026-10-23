<script lang="ts">
	import { Chat } from '@ai-sdk/svelte';
	import { DefaultChatTransport, type UIMessage } from 'ai';
	import { tick } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import ArrowUp from '@lucide/svelte/icons/arrow-up';
	import Square from '@lucide/svelte/icons/square';
	import Sparkles from '@lucide/svelte/icons/sparkles';
	import FileText from '@lucide/svelte/icons/file-text';
	import FolderOpen from '@lucide/svelte/icons/folder-open';
	import Search from '@lucide/svelte/icons/search';
	import History from '@lucide/svelte/icons/history';
	import MessagesSquare from '@lucide/svelte/icons/messages-square';
	import Plus from '@lucide/svelte/icons/plus';
	import ShieldCheck from '@lucide/svelte/icons/shield-check';
	import Download from '@lucide/svelte/icons/download';
	import Markdown from '#lib/components/markdown.svelte';
	import Citations from '#lib/components/citations.svelte';
	import { formatDate, formatBytes } from '#lib/format';
	import { Button } from '#lib/components/ui/button';
	import { Badge } from '#lib/components/ui/badge';
	import { Spinner } from '#lib/components/ui/spinner';
	import { Switch } from '#lib/components/ui/switch';
	import * as AlertDialog from '#lib/components/ui/alert-dialog';
	import * as Dialog from '#lib/components/ui/dialog';
	import * as Empty from '#lib/components/ui/empty';
	import * as InputGroup from '#lib/components/ui/input-group';
	import * as Alert from '#lib/components/ui/alert';
	import type { Citation } from '#lib/types';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// svelte-ignore state_referenced_locally -- Chat takes the initial history once
	const chat = new Chat({
		messages: data.messages as UIMessage[],
		transport: new DefaultChatTransport({ api: '/api/chat' })
	});

	let input = $state('');
	let strictCitations = $state(false);
	let formEl = $state<HTMLFormElement>();
	let scroller = $state<HTMLDivElement>();
	let resetting = $state(false);
	let historyOpen = $state(false);
	let switching = $state(false);
	// Files-used panels, keyed by message id. Default (missing key) is open;
	// activating a numbered ref re-opens its panel before scrolling to the quote.
	let panelsOpen = $state<Record<string, boolean>>({});

	const busy = $derived(chat.status === 'submitted' || chat.status === 'streaming');
	const empty = $derived(chat.messages.length === 0);
	const activeConversationId = $derived(
		data.sandbox.reachable ? data.sandbox.conversationId : null
	);
	const errorMessage = $derived(
		chat.error?.message ?? (data.sandbox.reachable ? null : data.sandbox.error)
	);

	const suggestions = [
		{
			icon: FolderOpen,
			title: 'List workspace files',
			prompt: 'List the files in the workspace and describe what each one contains.'
		},
		{
			icon: FileText,
			title: 'Summarize a document',
			prompt: 'Summarize data.txt in three bullet points.'
		},
		{
			icon: Search,
			title: 'Find a detail',
			prompt: 'Find the renewal date in my documents and quote the exact line.'
		},
		{
			icon: History,
			title: 'Continue the session',
			prompt: 'What did we work on in the previous session?'
		}
	];

	const send = async (text: string) => {
		const prompt = text.trim();
		if (!prompt || busy) return;
		input = '';
		// The toggle is a per-question command (RFC 0006 §5.9): it rides this
		// submission alone, as the `citations` field of POST /prompt. The active
		// conversation rides along too (RFC 0008), so the server can persist the
		// question before asking the sandbox — a failed ask still lands in history.
		await chat
			.sendMessage(
				{ text: prompt },
				{
					body: {
						citations: strictCitations ? 'required' : 'off',
						conversationId: activeConversationId
					}
				}
			)
			.catch(() => undefined);
	};

	const submit = (event: SubmitEvent) => {
		event.preventDefault();
		void send(input);
	};

	const onKeydown = (event: KeyboardEvent) => {
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			formEl?.requestSubmit();
		}
	};

	const stop = () => void chat.stop();

	// Clicking (or keyboard-activating) a numbered reference opens the message's
	// Files-used panel and scrolls the quote row into view; the anchor's default
	// hash jump cannot, when the panel is collapsed.
	const revealCitation = async (messageId: string, citationId: string) => {
		panelsOpen[messageId] = true;
		await tick();
		document
			.getElementById(`cite-${citationId}`)
			?.scrollIntoView({ block: 'center', behavior: 'smooth' });
	};

	// A new session is a separate conversation in the sandbox (RFC 0008): fresh
	// model context, and the old conversation stays in Traces with its chat.
	const startNewSession = async () => {
		if (busy || resetting) return;
		resetting = true;
		try {
			const response = await fetch('/api/chat/new-session', { method: 'POST' });
			const body = (await response.json().catch(() => ({}))) as { error?: string };
			if (!response.ok) throw new Error(body.error ?? 'The sandbox did not start a new session');
			chat.clearError();
			chat.messages = [];
			input = '';
			await invalidateAll();
			toast.success('New session started');
		} catch (error) {
			toast.error(error instanceof Error ? error.message : 'Could not start a new session');
		} finally {
			resetting = false;
		}
	};

	// Resuming a session is the durable inverse of New session (RFC 0008): the
	// sandbox repoints its active conversation, and the view takes the messages
	// the endpoint loaded for the conversation that actually became active.
	const resumeSession = async (conversationId: number) => {
		if (busy || resetting || switching) return;
		if (activeConversationId === conversationId) {
			historyOpen = false;
			return;
		}
		switching = true;
		try {
			const response = await fetch('/api/chat/switch-session', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ conversationId })
			});
			const body = (await response.json().catch(() => ({}))) as {
				messages?: UIMessage[];
				conversationId?: number;
				error?: string;
			};
			if (!response.ok) throw new Error(body.error ?? 'The sandbox did not switch session');
			chat.clearError();
			chat.messages = (body.messages ?? []) as UIMessage[];
			input = '';
			historyOpen = false;
			await invalidateAll();
			toast.success(`Session ${body.conversationId ?? conversationId} resumed`);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : 'Could not resume the session');
		} finally {
			switching = false;
		}
	};

	const textOf = (message: UIMessage): string =>
		message.parts
			.filter((part) => part.type === 'text')
			.map((part) => (part as { text: string }).text)
			.join('');

	type EvidenceData = {
		evidence: 'cited' | 'plain' | 'none';
		evidenceReason: string | null;
		citations: Citation[];
	};

	// The backend's wake-up progress (chat stream `data-waking` parts): present
	// only while the answer has not arrived yet; never persisted, so it cannot
	// survive a reload.
	const wakingOf = (message: UIMessage): number | null => {
		const part = message.parts.find(
			(part): part is { type: 'data-waking'; data: { elapsedMs?: number } } =>
				part.type === 'data-waking'
		);
		return part?.data?.elapsedMs ?? null;
	};

	const citationsOf = (message: UIMessage): EvidenceData | null => {
		const part = message.parts.find(
			(part): part is { type: 'data-citations'; data: EvidenceData } =>
				part.type === 'data-citations'
		);
		return part?.data ?? null;
	};

	type ArtifactItem = { path: string; bytes: number; sha256: string | null; modifiedAt: string };

	// The run's deliverables (RFC 0009 R7): one download button per file, built
	// from the server's envelope, never from a path the model typed.
	const artifactsOf = (message: UIMessage): ArtifactItem[] => {
		const part = message.parts.find(
			(part): part is { type: 'data-artifacts'; data: { artifacts?: ArtifactItem[] } } =>
				part.type === 'data-artifacts'
		);
		return part?.data?.artifacts ?? [];
	};

	const wasStrict = (message: UIMessage): boolean =>
		message.parts.some(
			(part) =>
				part.type === 'data-strict' &&
				(part as { data?: { citations?: boolean } }).data?.citations === true
		);

	// Keep the viewport pinned to the newest message while the stream grows.
	const progress = $derived(
		chat.messages.map((message) => textOf(message).length).reduce((a, b) => a + b, 0)
	);
	$effect(() => {
		void progress;
		void chat.status;
		tick().then(() => {
			scroller?.scrollTo({ top: scroller.scrollHeight });
		});
	});
</script>

<svelte:head>
	<title>Chat — Durable</title>
</svelte:head>

<div class="flex h-[calc(100svh-3.5rem)] min-h-0 flex-col">
	<div class="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 pt-6">
		<div class="flex items-center justify-between gap-3">
			<div class="flex items-center gap-2">
				{#if data.sandbox.reachable}
					<span
						class="size-2 rounded-full {data.sandbox.paused ? 'bg-muted-foreground' : 'bg-primary'}"
					></span>
					<span class="text-xs text-muted-foreground">
						{data.sandbox.paused ? 'Sandbox paused' : 'Sandbox ready'}
						· conversation {data.sandbox.conversationId ?? 'new'}
					</span>
				{:else}
					<span class="size-2 rounded-full bg-destructive"></span>
					<span class="text-xs text-muted-foreground">Sandbox offline</span>
				{/if}
			</div>
			<div class="flex items-center gap-2">
				<Dialog.Root bind:open={historyOpen}>
					<Dialog.Trigger>
						{#snippet child({ props })}
							<Button
								{...props}
								variant="outline"
								size="sm"
								disabled={!data.sandbox.reachable || busy || resetting || switching}
							>
								<MessagesSquare data-icon="inline-start" />
								History
							</Button>
						{/snippet}
					</Dialog.Trigger>
					<Dialog.Content class="sm:max-w-lg">
						<Dialog.Header>
							<Dialog.Title>Session history</Dialog.Title>
							<Dialog.Description>
								Every session is kept. Resuming one switches the agent back to that conversation,
								with its full context — nothing is merged or deleted.
							</Dialog.Description>
						</Dialog.Header>
						<div class="-mx-1 max-h-[60vh] space-y-1 overflow-y-auto px-1">
							{#each data.sessions as session (session.conversationId)}
								{@const current = activeConversationId === session.conversationId}
								<Button
									variant="ghost"
									onclick={() => resumeSession(session.conversationId)}
									disabled={switching || (!current && busy) || resetting}
									class="h-auto w-full items-start justify-start gap-3 p-3 text-left whitespace-normal"
								>
									<span
										class="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"
									>
										{#if switching && !current}
											<Spinner class="size-4" />
										{:else}
											<MessagesSquare class="size-4" />
										{/if}
									</span>
									<span class="flex min-w-0 flex-1 flex-col gap-0.5">
										<span class="truncate text-sm font-medium">
											{session.title || 'Empty session'}
										</span>
										<span class="text-xs font-normal text-muted-foreground">
											Session {session.conversationId} · {session.messages}
											{session.messages === 1 ? 'message' : 'messages'} ·
											{session.lastAt ? formatDate(session.lastAt) : 'no activity yet'}
										</span>
									</span>
									{#if current}
										<Badge variant="secondary" class="shrink-0 font-normal">Current</Badge>
									{/if}
								</Button>
							{/each}
						</div>
					</Dialog.Content>
				</Dialog.Root>
				<AlertDialog.Root>
					<AlertDialog.Trigger>
						{#snippet child({ props })}
							<Button
								{...props}
								variant="outline"
								size="sm"
								disabled={!data.sandbox.reachable || busy || resetting}
							>
								<Plus data-icon="inline-start" />
								New session
							</Button>
						{/snippet}
					</AlertDialog.Trigger>
					<AlertDialog.Content>
						<AlertDialog.Header>
							<AlertDialog.Title>Start a new session?</AlertDialog.Title>
							<AlertDialog.Description>
								The agent starts a separate conversation for a new topic, with no memory of this
								one. The current conversation stays in Traces with its entries and usage, and this
								chat is cleared from the view.
							</AlertDialog.Description>
						</AlertDialog.Header>
						<AlertDialog.Footer>
							<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
							<AlertDialog.Action variant="destructive" onclick={startNewSession}>
								Start new session
							</AlertDialog.Action>
						</AlertDialog.Footer>
					</AlertDialog.Content>
				</AlertDialog.Root>
				<Button variant="ghost" size="sm" href="/dashboard/traces">
					<History data-icon="inline-start" />
					Traces
				</Button>
			</div>
		</div>

		<div bind:this={scroller} class="min-h-0 flex-1 overflow-y-auto pb-6">
			{#if empty}
				<Empty.Root class="p-0 pt-10 pb-6 md:pt-16">
					<Empty.Header>
						<Empty.Media
							variant="icon"
							class="size-12 rounded-2xl bg-accent text-accent-foreground"
						>
							<Sparkles class="size-6" />
						</Empty.Media>
						<Empty.Title class="font-display text-4xl tracking-tight md:text-5xl">
							What are we looking into?
						</Empty.Title>
						<Empty.Description class="max-w-md">
							Ask about a document, list the workspace, or continue the conversation. The agent
							resumes the same durable session after a pause.
						</Empty.Description>
					</Empty.Header>
					<Empty.Content class="mt-4 grid max-w-none gap-2 sm:grid-cols-2">
						{#each suggestions as suggestion (suggestion.title)}
							<Button
								variant="outline"
								onclick={() => send(suggestion.prompt)}
								class="h-auto w-full items-start justify-start gap-3 p-3 text-left whitespace-normal"
							>
								<span
									class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"
								>
									<suggestion.icon class="size-4" />
								</span>
								<span class="flex min-w-0 flex-col gap-0.5">
									<span class="text-sm font-medium">{suggestion.title}</span>
									<span class="line-clamp-2 text-xs font-normal text-muted-foreground">
										{suggestion.prompt}
									</span>
								</span>
							</Button>
						{/each}
					</Empty.Content>
				</Empty.Root>
			{:else}
				<div class="flex flex-col gap-6 pt-2">
					{#each chat.messages as message (message.id)}
						{#if message.role === 'user'}
							<div class="flex flex-col items-end gap-1">
								{#if wasStrict(message)}
									<Badge variant="outline" class="gap-1 font-normal text-muted-foreground">
										<ShieldCheck class="size-3" />
										Strict citations
									</Badge>
								{/if}
								<div
									class="max-w-[85%] rounded-2xl rounded-br-md bg-secondary px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap"
								>
									{textOf(message)}
								</div>
							</div>
						{:else}
							{@const evidence = citationsOf(message)}
							<div class="flex gap-3">
								<span
									class="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary font-display text-base leading-none text-primary-foreground"
									>d</span
								>
								<div class="flex min-w-0 flex-1 flex-col gap-2">
									<span class="text-xs font-medium text-muted-foreground">Durable</span>
									<div class="min-w-0 flex-1 text-sm leading-relaxed">
										{#if textOf(message)}
											<Markdown
												content={textOf(message)}
												citations={evidence?.citations}
												onCitationClick={(citationId) =>
													void revealCitation(message.id, citationId)}
											/>
										{:else if wakingOf(message) !== null}
											<div class="flex items-center gap-2 text-muted-foreground">
												<Spinner class="text-muted-foreground" />
												<span>
													Waking the agent in its sandbox… {Math.round(
														(wakingOf(message) ?? 0) / 1000
													)}s
												</span>
											</div>
										{:else}
											<Spinner class="text-muted-foreground" />
										{/if}
									</div>
									{#if artifactsOf(message).length > 0}
										<div class="flex flex-wrap gap-2">
											{#each artifactsOf(message) as artifact (artifact.path)}
												<Button
													variant="outline"
													size="sm"
													href={`/api/artifact?path=${encodeURIComponent(artifact.path)}`}
													class="h-auto gap-2 py-1.5 font-mono text-xs"
												>
													<Download data-icon="inline-start" />
													{artifact.path}
													<span class="font-sans text-[11px] text-muted-foreground">
														{formatBytes(artifact.bytes)}
													</span>
												</Button>
											{/each}
										</div>
									{/if}
									{#if evidence?.evidence === 'cited'}
										<Citations
											citations={evidence.citations}
											open={panelsOpen[message.id] ?? true}
											onOpenChange={(next) => (panelsOpen[message.id] = next)}
										/>
									{:else if evidence?.evidence === 'plain'}
										<Badge variant="outline" class="w-fit font-normal text-muted-foreground">
											No document evidence — agent reply without citations
										</Badge>
									{:else if evidence?.evidence === 'none'}
										<Badge variant="destructive" class="w-fit font-normal">
											Strict run ended unpublished{evidence.evidenceReason
												? `: ${evidence.evidenceReason}`
												: ''}
										</Badge>
									{/if}
								</div>
							</div>
						{/if}
					{/each}

					{#if chat.status === 'submitted'}
						<div class="flex items-center gap-3">
							<span
								class="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary font-display text-base leading-none text-primary-foreground"
								>d</span
							>
							<div class="flex items-center gap-2 text-sm text-muted-foreground">
								<Spinner />
								Agent is working in its sandbox…
							</div>
						</div>
					{/if}
				</div>
			{/if}
		</div>

		{#if errorMessage}
			<Alert.Root variant="destructive">
				<Alert.Title>Agent request failed</Alert.Title>
				<Alert.Description>{errorMessage}</Alert.Description>
			</Alert.Root>
		{/if}

		<div class="sticky bottom-0 bg-background pb-4">
			<form bind:this={formEl} onsubmit={submit}>
				<InputGroup.Root class="rounded-2xl border border-border bg-card shadow-sm">
					<InputGroup.Textarea
						bind:value={input}
						onkeydown={onKeydown}
						rows={1}
						placeholder="Ask your agent…"
						class="max-h-40 min-h-11 px-4 py-3 text-sm"
						disabled={!data.sandbox.reachable}
					/>
					<InputGroup.Addon align="inline-end" class="pr-2">
						{#if busy}
							<InputGroup.Button size="icon-sm" onclick={stop} aria-label="Stop generating">
								<Square class="size-3.5" />
							</InputGroup.Button>
						{:else}
							<InputGroup.Button
								size="icon-sm"
								type="submit"
								class="rounded-lg bg-primary text-primary-foreground hover:bg-primary/80"
								disabled={input.trim() === '' || !data.sandbox.reachable}
								aria-label="Send message"
							>
								<ArrowUp class="size-4" />
							</InputGroup.Button>
						{/if}
					</InputGroup.Addon>
				</InputGroup.Root>
			</form>
			<div class="mt-2 flex items-center justify-between gap-3 px-1">
				<label
					class="flex cursor-pointer items-center gap-2 text-[11px] text-muted-foreground select-none"
					title="Every non-heading line of the answer must carry a server-verified citation; the sandbox enforces it"
				>
					<Switch bind:checked={strictCitations} size="sm" aria-label="Strict citations mode" />
					<span class={strictCitations ? 'font-medium text-foreground' : ''}>Strict citations</span>
				</label>
				<span class="text-[11px] text-muted-foreground"
					>Enter to send · Shift+Enter for a new line</span
				>
				<span class="flex items-center gap-1.5 text-[11px] text-muted-foreground">
					<Badge variant="outline" class="font-normal">
						{data.sandbox.reachable ? `${data.sandbox.entries} entries` : 'offline'}
					</Badge>
				</span>
			</div>
		</div>
	</div>
</div>
