<script lang="ts">
	import { enhance } from '$app/forms';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import FileText from '@lucide/svelte/icons/file-text';
	import Plus from '@lucide/svelte/icons/plus';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import X from '@lucide/svelte/icons/x';
	import { Button } from '#lib/components/ui/button';
	import { Badge } from '#lib/components/ui/badge';
	import * as Card from '#lib/components/ui/card';
	import * as Field from '#lib/components/ui/field';
	import * as Select from '#lib/components/ui/select';
	import * as Table from '#lib/components/ui/table';
	import * as Alert from '#lib/components/ui/alert';
	import * as Empty from '#lib/components/ui/empty';
	import * as AlertDialog from '#lib/components/ui/alert-dialog';
	import { Separator } from '#lib/components/ui/separator';
	import { formatBytes, formatDate } from '#lib/format';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
	let documentId = $state('');
	let confirmDelete = $state(false);
</script>

<svelte:head>
	<title>{data.corpus.name} — Durable</title>
</svelte:head>

<div class="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-8">
	<a
		href="/dashboard/corpus"
		class="flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
	>
		<ArrowLeft class="size-4" />
		All corpus
	</a>

	<div class="flex flex-col justify-between gap-4 md:flex-row md:items-end">
		<div class="min-w-0">
			<div class="flex items-center gap-3">
				<h1 class="truncate font-display text-4xl tracking-tight">{data.corpus.name}</h1>
				<Badge variant="secondary" class="font-normal">
					{data.documents.length}
					{data.documents.length === 1 ? 'document' : 'documents'}
				</Badge>
			</div>
			<p class="mt-2 max-w-2xl text-sm text-muted-foreground">
				{data.corpus.description || 'No description yet.'}
			</p>
		</div>
		<Button variant="outline" onclick={() => (confirmDelete = true)}>
			<Trash2 data-icon="inline-start" />
			Delete corpus
		</Button>
	</div>

	{#if form?.message}
		<Alert.Root variant="destructive">
			<Alert.Title>Could not update the corpus</Alert.Title>
			<Alert.Description>{form.message}</Alert.Description>
		</Alert.Root>
	{/if}

	<Card.Root>
		<Card.Header>
			<Card.Title>Add a document</Card.Title>
			<Card.Description
				>Pick a document from the library that is not in this corpus yet.</Card.Description
			>
		</Card.Header>
		<Card.Content>
			{#if data.available.length === 0}
				<p class="text-sm text-muted-foreground">
					Every document is already in this corpus. Create another one in
					<a class="text-primary hover:underline" href="/dashboard/documents?new=1">Documents</a>.
				</p>
			{:else}
				<form
					method="POST"
					action="?/add"
					use:enhance
					class="flex flex-col gap-3 sm:flex-row sm:items-end"
				>
					<Field.Field class="flex-1">
						<Field.Label for="corpus-document">Document</Field.Label>
						<Select.Root name="documentId" type="single" bind:value={documentId}>
							<Select.Trigger class="w-full">
								<Select.Value placeholder="Choose a document" />
							</Select.Trigger>
							<Select.Content>
								{#each data.available as doc (doc.id)}
									<Select.Item value={doc.id}>{doc.title}</Select.Item>
								{/each}
							</Select.Content>
						</Select.Root>
					</Field.Field>
					<Button type="submit" disabled={!documentId}>
						<Plus data-icon="inline-start" />
						Add
					</Button>
				</form>
			{/if}
		</Card.Content>
	</Card.Root>

	<Separator />

	{#if data.documents.length === 0}
		<Empty.Root class="border">
			<Empty.Header>
				<Empty.Media variant="icon">
					<FileText class="size-5" />
				</Empty.Media>
				<Empty.Title>This corpus is empty</Empty.Title>
				<Empty.Description>Add a document above to start the collection.</Empty.Description>
			</Empty.Header>
		</Empty.Root>
	{:else}
		<div class="overflow-hidden rounded-xl border border-border">
			<Table.Root>
				<Table.Header>
					<Table.Row>
						<Table.Head>Document</Table.Head>
						<Table.Head class="text-right">Size</Table.Head>
						<Table.Head class="hidden md:table-cell">Added</Table.Head>
						<Table.Head class="w-10"></Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each data.documents as doc (doc.id)}
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
							<Table.Cell class="text-right text-xs text-muted-foreground"
								>{formatBytes(doc.size)}</Table.Cell
							>
							<Table.Cell class="hidden text-xs text-muted-foreground md:table-cell"
								>{formatDate(doc.addedAt)}</Table.Cell
							>
							<Table.Cell>
								<form method="POST" action="?/remove" use:enhance>
									<input type="hidden" name="documentId" value={doc.id} />
									<Button type="submit" variant="ghost" size="icon-sm">
										<X />
										<span class="sr-only">Remove from corpus</span>
									</Button>
								</form>
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		</div>
	{/if}
</div>

<AlertDialog.Root bind:open={confirmDelete}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Delete this corpus?</AlertDialog.Title>
			<AlertDialog.Description>
				The collection is removed. Its documents stay in the library.
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<form method="POST" action="?/delete">
				<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
				<Button type="submit" variant="destructive">Delete corpus</Button>
			</form>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
