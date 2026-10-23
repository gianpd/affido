<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import LibraryBig from '@lucide/svelte/icons/library-big';
	import Plus from '@lucide/svelte/icons/plus';
	import MoreHorizontal from '@lucide/svelte/icons/more-horizontal';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import FileText from '@lucide/svelte/icons/file-text';
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import { Button } from '#lib/components/ui/button';
	import { Input } from '#lib/components/ui/input';
	import { Textarea } from '#lib/components/ui/textarea';
	import * as Card from '#lib/components/ui/card';
	import * as Field from '#lib/components/ui/field';
	import * as Dialog from '#lib/components/ui/dialog';
	import * as AlertDialog from '#lib/components/ui/alert-dialog';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu';
	import * as Alert from '#lib/components/ui/alert';
	import * as Empty from '#lib/components/ui/empty';
	import { formatDate, formatNumber } from '#lib/format';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	let deleteTarget = $state<{ id: string; name: string } | null>(null);
	let submitting = $state(false);

	const closeCreate = (open: boolean) => {
		if (!open && data.newDialog) goto('/dashboard/corpus');
	};
</script>

<svelte:head>
	<title>Corpus — Durable</title>
</svelte:head>

<div class="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-8">
	<div class="flex flex-col justify-between gap-4 md:flex-row md:items-end">
		<div>
			<p class="text-sm text-muted-foreground">Library</p>
			<h1 class="mt-1 font-display text-4xl tracking-tight">Corpus</h1>
			<p class="mt-2 max-w-xl text-sm text-muted-foreground">
				Collections group documents by project, client or topic. A document can belong to more than
				one corpus.
			</p>
		</div>
		<Button href="/dashboard/corpus?new=1">
			<Plus data-icon="inline-start" />
			New corpus
		</Button>
	</div>

	{#if form?.message}
		<Alert.Root variant="destructive">
			<Alert.Title>Could not save</Alert.Title>
			<Alert.Description>{form.message}</Alert.Description>
		</Alert.Root>
	{/if}

	{#if data.corpora.length === 0}
		<Empty.Root class="border">
			<Empty.Header>
				<Empty.Media variant="icon">
					<LibraryBig class="size-5" />
				</Empty.Media>
				<Empty.Title>No corpus yet</Empty.Title>
				<Empty.Description>
					Create a collection, then add documents from the document page or from inside it.
				</Empty.Description>
			</Empty.Header>
			<Empty.Content>
				<Button href="/dashboard/corpus?new=1">
					<Plus data-icon="inline-start" />
					Create a corpus
				</Button>
			</Empty.Content>
		</Empty.Root>
	{:else}
		<div class="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
			{#each data.corpora as corpus (corpus.id)}
				<Card.Root class="group transition-colors hover:border-primary/30">
					<Card.Header class="flex flex-row items-start justify-between gap-2">
						<div class="flex min-w-0 items-start gap-3">
							<div
								class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground"
							>
								<LibraryBig class="size-4" />
							</div>
							<div class="min-w-0">
								<Card.Title class="truncate">
									<a class="hover:text-primary" href="/dashboard/corpus/{corpus.id}"
										>{corpus.name}</a
									>
								</Card.Title>
								<Card.Description class="mt-1 line-clamp-2 min-h-8">
									{corpus.description || 'No description'}
								</Card.Description>
							</div>
						</div>
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
								<DropdownMenu.Item onSelect={() => goto(`/dashboard/corpus/${corpus.id}`)}>
									<ArrowRight class="size-4" />
									Open
								</DropdownMenu.Item>
								<DropdownMenu.Separator />
								<DropdownMenu.Item
									variant="destructive"
									onSelect={() => (deleteTarget = { id: corpus.id, name: corpus.name })}
								>
									<Trash2 class="size-4" />
									Delete
								</DropdownMenu.Item>
							</DropdownMenu.Content>
						</DropdownMenu.Root>
					</Card.Header>
					<Card.Footer class="flex items-center justify-between text-xs text-muted-foreground">
						<span class="flex items-center gap-1.5">
							<FileText class="size-3.5" />
							{formatNumber(corpus.documents)}
							{corpus.documents === 1 ? 'document' : 'documents'}
						</span>
						<span>{formatDate(corpus.updatedAt)}</span>
					</Card.Footer>
				</Card.Root>
			{/each}
		</div>
	{/if}
</div>

<Dialog.Root open={data.newDialog} onOpenChange={closeCreate}>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>New corpus</Dialog.Title>
			<Dialog.Description>
				A corpus is a named set of documents. Add documents after creating it.
			</Dialog.Description>
		</Dialog.Header>
		<form
			method="POST"
			action="?/create"
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
					<Field.Label for="corpus-name">Name</Field.Label>
					<Input id="corpus-name" name="name" placeholder="Client contracts" required />
				</Field.Field>
				<Field.Field>
					<Field.Label for="corpus-description">Description</Field.Label>
					<Textarea id="corpus-description" name="description" rows={3} placeholder="Optional" />
				</Field.Field>
			</Field.Group>
			<Dialog.Footer>
				<Button type="button" variant="outline" href="/dashboard/corpus">Cancel</Button>
				<Button type="submit" disabled={submitting}
					>{submitting ? 'Creating…' : 'Create corpus'}</Button
				>
			</Dialog.Footer>
		</form>
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
			<AlertDialog.Title>Delete corpus?</AlertDialog.Title>
			<AlertDialog.Description>
				“{deleteTarget?.name}” will be removed. Its documents stay in the library.
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
