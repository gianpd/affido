<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import FileText from '@lucide/svelte/icons/file-text';
	import Plus from '@lucide/svelte/icons/plus';
	import Search from '@lucide/svelte/icons/search';
	import MoreHorizontal from '@lucide/svelte/icons/more-horizontal';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import Eye from '@lucide/svelte/icons/eye';
	import Upload from '@lucide/svelte/icons/upload';
	import { Button } from '#lib/components/ui/button';
	import { Input } from '#lib/components/ui/input';
	import { Badge } from '#lib/components/ui/badge';
	import { Textarea } from '#lib/components/ui/textarea';
	import * as Field from '#lib/components/ui/field';
	import * as Dialog from '#lib/components/ui/dialog';
	import * as AlertDialog from '#lib/components/ui/alert-dialog';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu';
	import * as Select from '#lib/components/ui/select';
	import * as Table from '#lib/components/ui/table';
	import * as Alert from '#lib/components/ui/alert';
	import * as Empty from '#lib/components/ui/empty';
	import { Separator } from '#lib/components/ui/separator';
	import { formatBytes, formatDate, formatNumber } from '#lib/format';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	let previewEl = $state<HTMLDivElement>();

	/** The preview renders one numbered row per line, so a citation's `line` is an anchor. */
	function previewLines(text: string): { number: number; text: string }[] {
		return text.split('\n').map((line, index) => ({ number: index + 1, text: line }));
	}

	// A citation link opens the dialog scrolled to its line (#L<line>).
	$effect(() => {
		void data.selected?.id;
		void previewEl;
		const hash = typeof window !== 'undefined' ? window.location.hash : '';
		const match = /^#L(\d+)$/.exec(hash);
		if (match === null || previewEl === undefined) return;
		const target = document.getElementById(`L${match[1]}`);
		target?.scrollIntoView({ block: 'center' });
	});

	let query = $state('');
	let corpusId = $state('none');
	let deleteTarget = $state<{ id: string; title: string } | null>(null);
	let submitting = $state(false);

	const filtered = $derived(
		data.documents.filter((doc) => {
			if (!query.trim()) return true;
			const haystack = `${doc.title} ${doc.corpora.map((c) => c.name).join(' ')}`.toLowerCase();
			return haystack.includes(query.trim().toLowerCase());
		})
	);

	const closeCreate = (open: boolean) => {
		if (!open && data.newDialog) goto('/dashboard/documents');
	};

	const closeView = (open: boolean) => {
		if (!open && data.selected) goto('/dashboard/documents');
	};
</script>

<svelte:head>
	<title>Documents — Durable</title>
</svelte:head>

<div class="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-8">
	<div class="flex flex-col justify-between gap-4 md:flex-row md:items-end">
		<div>
			<p class="text-sm text-muted-foreground">Library</p>
			<h1 class="mt-1 font-display text-4xl tracking-tight">Documents</h1>
			<p class="mt-2 max-w-xl text-sm text-muted-foreground">
				Text documents the agent can reference. Upload a file or paste text, then group documents
				into corpus collections.
			</p>
		</div>
		<Button href="/dashboard/documents?new=1">
			<Plus data-icon="inline-start" />
			Add document
		</Button>
	</div>

	{#if form?.message}
		<Alert.Root variant="destructive">
			<Alert.Title>Could not save</Alert.Title>
			<Alert.Description>{form.message}</Alert.Description>
		</Alert.Root>
	{/if}

	<div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
		<div class="relative w-full sm:max-w-xs">
			<Search
				class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
			/>
			<Input bind:value={query} placeholder="Search documents…" class="pl-8" />
		</div>
		<p class="text-xs text-muted-foreground">
			{formatNumber(data.documents.length)} documents ·
			{formatBytes(data.documents.reduce((total, doc) => total + doc.size, 0))}
		</p>
	</div>

	{#if data.documents.length === 0}
		<Empty.Root class="border">
			<Empty.Header>
				<Empty.Media variant="icon">
					<FileText class="size-5" />
				</Empty.Media>
				<Empty.Title>No documents yet</Empty.Title>
				<Empty.Description>
					Add a contract, notes or a data file. Text only, up to {data.maxUploadLabel}.
				</Empty.Description>
			</Empty.Header>
			<Empty.Content>
				<Button href="/dashboard/documents?new=1">
					<Plus data-icon="inline-start" />
					Add the first document
				</Button>
			</Empty.Content>
		</Empty.Root>
	{:else}
		<div class="overflow-hidden rounded-xl border border-border">
			<Table.Root>
				<Table.Header>
					<Table.Row>
						<Table.Head>Document</Table.Head>
						<Table.Head>Corpus</Table.Head>
						<Table.Head class="text-right">Size</Table.Head>
						<Table.Head class="hidden md:table-cell">Updated</Table.Head>
						<Table.Head class="w-10"></Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each filtered as doc (doc.id)}
						<Table.Row>
							<Table.Cell>
								<a
									href="/dashboard/documents?doc={doc.id}"
									class="flex items-center gap-2.5 font-medium hover:text-primary"
								>
									<span
										class="flex size-8 items-center justify-center rounded-md bg-muted text-muted-foreground"
									>
										<FileText class="size-4" />
									</span>
									<span class="truncate">{doc.title}</span>
								</a>
							</Table.Cell>
							<Table.Cell>
								{#if doc.corpora.length === 0}
									<span class="text-xs text-muted-foreground">Unfiled</span>
								{:else}
									<div class="flex flex-wrap gap-1">
										{#each doc.corpora as corpus (corpus.id)}
											<a href="/dashboard/corpus/{corpus.id}">
												<Badge variant="outline" class="font-normal">{corpus.name}</Badge>
											</a>
										{/each}
									</div>
								{/if}
							</Table.Cell>
							<Table.Cell class="text-right text-xs text-muted-foreground"
								>{formatBytes(doc.size)}</Table.Cell
							>
							<Table.Cell class="hidden text-xs text-muted-foreground md:table-cell"
								>{formatDate(doc.updatedAt)}</Table.Cell
							>
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
										<DropdownMenu.Item onSelect={() => goto(`/dashboard/documents?doc=${doc.id}`)}>
											<Eye class="size-4" />
											View
										</DropdownMenu.Item>
										<DropdownMenu.Separator />
										<DropdownMenu.Item
											variant="destructive"
											onSelect={() => (deleteTarget = { id: doc.id, title: doc.title })}
										>
											<Trash2 class="size-4" />
											Delete
										</DropdownMenu.Item>
									</DropdownMenu.Content>
								</DropdownMenu.Root>
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		</div>
		{#if filtered.length === 0}
			<p class="py-8 text-center text-sm text-muted-foreground">No document matches “{query}”.</p>
		{/if}
	{/if}
</div>

<Dialog.Root open={data.newDialog} onOpenChange={closeCreate}>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>Add a document</Dialog.Title>
			<Dialog.Description>
				The bytes go straight to your agent's sandbox workspace. The control plane keeps only the
				metadata, the hashes and the ingestion history.
			</Dialog.Description>
		</Dialog.Header>
		<form
			method="POST"
			action="?/create"
			enctype="multipart/form-data"
			use:enhance={() => {
				submitting = true;
				return async ({ update }) => {
					await update();
					submitting = false;
				};
			}}
			class="flex flex-col gap-5"
		>
			<Field.Group>
				<Field.Field>
					<Field.Label for="doc-title">Title</Field.Label>
					<Input id="doc-title" name="title" placeholder="Service agreement" required />
				</Field.Field>
				<Field.Field>
					<Field.Label for="doc-corpus">Corpus</Field.Label>
					<Select.Root name="corpusId" type="single" bind:value={corpusId}>
						<Select.Trigger class="w-full">
							<Select.Value placeholder="Unfiled" />
						</Select.Trigger>
						<Select.Content>
							<Select.Item value="none">Unfiled</Select.Item>
							{#each data.corpora as corpus (corpus.id)}
								<Select.Item value={corpus.id}>{corpus.name}</Select.Item>
							{/each}
						</Select.Content>
					</Select.Root>
				</Field.Field>
				<Field.Field>
					<Field.Label for="doc-content">Paste text</Field.Label>
					<Textarea
						id="doc-content"
						name="content"
						rows={8}
						placeholder="Paste the document text here…"
					/>
					<Field.Description
						>Or upload a text file below. A file wins over pasted text.</Field.Description
					>
				</Field.Field>
				<Field.Field>
					<Field.Label for="doc-file">Upload file</Field.Label>
					<div
						class="flex items-center gap-3 rounded-lg border border-dashed border-border bg-muted/40 p-3"
					>
						<Upload class="size-4 text-muted-foreground" />
						<Input
							id="doc-file"
							name="file"
							type="file"
							accept=".txt,.md,.markdown,.csv,.json,.yaml,.yml,.log,.xml,.html,.htm,text/*"
							class="border-0 bg-transparent shadow-none"
						/>
					</div>
					<Field.Description
						>Text, Markdown, CSV, JSON, YAML, XML. Max {data.maxUploadLabel}.</Field.Description
					>
				</Field.Field>
			</Field.Group>
			<Dialog.Footer>
				<Button type="button" variant="outline" href="/dashboard/documents">Cancel</Button>
				<Button type="submit" disabled={submitting}
					>{submitting ? 'Saving…' : 'Save document'}</Button
				>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root open={Boolean(data.selected)} onOpenChange={closeView}>
	<Dialog.Content class="sm:max-w-2xl">
		{#if data.selected}
			<Dialog.Header>
				<Dialog.Title>{data.selected.title}</Dialog.Title>
				<Dialog.Description class="flex flex-wrap items-center gap-2">
					<Badge variant="secondary" class="font-normal">{data.selected.mimeType}</Badge>
					{#if data.selected.ingestStatus === 'raw_only'}
						<Badge variant="outline" class="font-normal">bytes staged, not parsed</Badge>
					{/if}
					<span>{formatBytes(data.selected.size)}</span>
					<span>·</span>
					<span>updated {formatDate(data.selected.updatedAt)}</span>
				</Dialog.Description>
			</Dialog.Header>
			<Separator />
			{#if data.selected.preview && 'text' in data.selected.preview}
				<div
					bind:this={previewEl}
					class="max-h-[50vh] overflow-auto rounded-lg bg-muted/40 p-4 text-xs leading-relaxed"
				>
					{#each previewLines(data.selected.preview.text) as line (line.number)}
						<div id="L{line.number}" class="flex gap-3 whitespace-pre-wrap">
							<span class="w-8 shrink-0 text-right text-muted-foreground/70 select-none"
								>{line.number}</span
							>
							<span>{line.text}</span>
						</div>
					{/each}
				</div>
			{:else}
				<p
					class="rounded-lg border border-dashed border-border bg-muted/40 p-4 text-xs text-muted-foreground"
				>
					{#if data.selected.preview?.unavailable === 'binary'}
						This file is not text, so there is no preview. The agent reads the stored bytes from its
						workspace.
					{:else if data.selected.preview?.unavailable === 'reingest'}
						This document was created before the sandbox stored uploads. It has no bytes on record
						and must be re-uploaded.
					{:else}
						The agent sandbox is not reachable, so the bytes cannot be read right now. The metadata
						below still stands.
					{/if}
				</p>
			{/if}
			{#if data.selected.sourceSha256}
				<p class="font-mono text-[11px] break-all text-muted-foreground">
					source sha256 {data.selected.sourceSha256}
				</p>
			{/if}
			<Dialog.Footer>
				<form method="POST" action="?/delete">
					<input type="hidden" name="id" value={data.selected.id} />
					<Button type="submit" variant="destructive">Delete document</Button>
				</form>
				<Button variant="outline" href="/dashboard/documents">Close</Button>
			</Dialog.Footer>
		{/if}
	</Dialog.Content>
</Dialog.Root>

<AlertDialog.Root
	open={deleteTarget !== null}
	onOpenChange={(open) => {
		if (!open) deleteTarget = null;
	}}
>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Delete document?</AlertDialog.Title>
			<AlertDialog.Description>
				“{deleteTarget?.title}” will be removed from every corpus. This cannot be undone.
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<form method="POST" action="?/delete" use:enhance>
				<input type="hidden" name="id" value={deleteTarget?.id ?? ''} />
				<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
				<Button type="submit" variant="destructive">Delete</Button>
			</form>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
