<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import FolderUp from '@lucide/svelte/icons/folder-up';
	import Folder from '@lucide/svelte/icons/folder';
	import FileText from '@lucide/svelte/icons/file-text';
	import FolderPlus from '@lucide/svelte/icons/folder-plus';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import FileDown from '@lucide/svelte/icons/file-down';
	import { Button } from '#lib/components/ui/button';
	import { Input } from '#lib/components/ui/input';
	import * as Field from '#lib/components/ui/field';
	import * as Dialog from '#lib/components/ui/dialog';
	import * as AlertDialog from '#lib/components/ui/alert-dialog';
	import * as Alert from '#lib/components/ui/alert';
	import * as Empty from '#lib/components/ui/empty';
	import * as Table from '#lib/components/ui/table';
	import { formatBytes, formatNumber } from '#lib/format';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// webkitdirectory is not in the HTML types; the picker is configured at the
	// DOM level and stays unnamed so its files never enter the form by basename.
	let dirInput = $state<HTMLInputElement>();
	$effect(() => {
		dirInput?.setAttribute('webkitdirectory', '');
		dirInput?.setAttribute('directory', '');
	});

	let submitting = $state(false);
	let folderSubmitting = $state(false);
	let pickError = $state<string | null>(null);
	let deleteTarget = $state<string | null>(null);
	let deleteArtifactTarget = $state<string | null>(null);

	const files = $derived((data.tree?.entries ?? []).filter((entry) => entry.kind === 'file'));
	const totalBytes = $derived(files.reduce((total, entry) => total + (entry.bytes ?? 0), 0));
	const artifactFiles = $derived(
		(data.artifacts?.entries ?? []).filter((entry) => entry.kind === 'file')
	);
	const artifactBytes = $derived(
		artifactFiles.reduce((total, entry) => total + (entry.bytes ?? 0), 0)
	);
	const nameOf = (path: string): string => path.split('/').at(-1) ?? path;
	const downloadHref = (path: string): string => `/api/artifact?path=${encodeURIComponent(path)}`;

	const closeDialog = (open: boolean) => {
		if (!open && data.dialog) {
			goto('/dashboard/uploads');
			pickError = null;
		}
	};
</script>

<svelte:head>
	<title>Uploads — Durable</title>
</svelte:head>

<div class="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-8">
	<div class="flex flex-col justify-between gap-4 md:flex-row md:items-end">
		<div>
			<p class="text-sm text-muted-foreground">Workspace</p>
			<h1 class="mt-1 font-display text-4xl tracking-tight">Uploads</h1>
			<p class="mt-2 max-w-xl text-sm text-muted-foreground">
				Directory trees your agent reads as workspace files, under <code>uploads/</code>. The
				structure is yours: every file keeps its path, folders and subfolders included.
			</p>
		</div>
		<div class="flex gap-2">
			<Button variant="outline" href="/dashboard/uploads?new=folder">
				<FolderPlus data-icon="inline-start" />
				New folder
			</Button>
			<Button href="/dashboard/uploads?new=dir">
				<FolderUp data-icon="inline-start" />
				Upload directory
			</Button>
		</div>
	</div>

	{#if form?.message}
		<Alert.Root variant="destructive">
			<Alert.Title>Could not save</Alert.Title>
			<Alert.Description>{form.message}</Alert.Description>
		</Alert.Root>
	{/if}

	{#if data.unavailable}
		<Alert.Root variant="destructive">
			<Alert.Title>The sandbox is not reachable</Alert.Title>
			<Alert.Description>{data.unavailable}</Alert.Description>
		</Alert.Root>
	{:else if data.tree && data.tree.entries.length === 0}
		<Empty.Root class="border">
			<Empty.Header>
				<Empty.Media variant="icon">
					<FolderUp class="size-5" />
				</Empty.Media>
				<Empty.Title>Nothing shared yet</Empty.Title>
				<Empty.Description>
					Upload a directory — a skill, a project folder — and the agent reads it at
					<code>uploads/&lt;your path&gt;</code>. Up to {data.maxDirFiles} files, {data.maxDirTotalLabel}
					in total.
				</Empty.Description>
			</Empty.Header>
			<Empty.Content>
				<Button href="/dashboard/uploads?new=dir">
					<FolderUp data-icon="inline-start" />
					Upload the first directory
				</Button>
			</Empty.Content>
		</Empty.Root>
	{:else if data.tree}
		<div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
			<p class="text-xs text-muted-foreground">
				{formatNumber(files.length)} files · {formatBytes(totalBytes)} under uploads/
			</p>
			{#if data.tree.truncated}
				<p class="text-xs text-muted-foreground">
					Showing the first {formatNumber(data.tree.entries.length)} entries.
				</p>
			{/if}
		</div>
		<div class="overflow-hidden rounded-xl border border-border">
			<Table.Root>
				<Table.Header>
					<Table.Row>
						<Table.Head>Path</Table.Head>
						<Table.Head class="text-right">Size</Table.Head>
						<Table.Head class="w-10"></Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each data.tree.entries as entry (entry.path)}
						<Table.Row>
							<Table.Cell>
								<span
									class="flex items-center gap-2.5"
									style={`padding-left: ${(entry.path.split('/').length - 1) * 1.25}rem`}
								>
									{#if entry.kind === 'dir'}
										<Folder class="size-4 shrink-0 text-muted-foreground" />
										<span class="font-medium">{nameOf(entry.path)}</span>
									{:else}
										<FileText class="size-4 shrink-0 text-muted-foreground/60" />
										<span class="font-mono text-xs">{nameOf(entry.path)}</span>
									{/if}
								</span>
							</Table.Cell>
							<Table.Cell class="text-right text-xs text-muted-foreground">
								{entry.kind === 'file' ? formatBytes(entry.bytes ?? 0) : '—'}
							</Table.Cell>
							<Table.Cell>
								{#if !entry.path.includes('/')}
									<Button
										variant="ghost"
										size="icon-sm"
										onclick={() => (deleteTarget = entry.path)}
									>
										<Trash2 />
										<span class="sr-only">Delete {entry.path}</span>
									</Button>
								{/if}
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		</div>
	{/if}

	{#if data.artifacts}
		<div class="mt-10 flex flex-col gap-3">
			<div class="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
				<div>
					<h2 class="font-display text-2xl tracking-tight">Artifacts</h2>
					<p class="mt-1 max-w-xl text-sm text-muted-foreground">
						Files the agent produces for you land under <code>artifacts/</code> — ask for a document and
						download it here, or straight from the chat.
					</p>
				</div>
				<p class="text-xs text-muted-foreground">
					{formatNumber(artifactFiles.length)} files · {formatBytes(artifactBytes)}
				</p>
			</div>
			{#if data.artifacts.entries.length === 0}
				<p
					class="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground"
				>
					Nothing yet. Install a skill from
					<a href="/dashboard/skills" class="underline underline-offset-4">Skills</a> and ask for a
					document, e.g. <code>/md-to-docx make a proposal</code>.
				</p>
			{:else}
				<div class="overflow-hidden rounded-xl border border-border">
					<Table.Root>
						<Table.Header>
							<Table.Row>
								<Table.Head>Path</Table.Head>
								<Table.Head class="text-right">Size</Table.Head>
								<Table.Head class="w-24"></Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#each data.artifacts.entries as entry (entry.path)}
								<Table.Row>
									<Table.Cell>
										<span
											class="flex items-center gap-2.5"
											style={`padding-left: ${(entry.path.split('/').length - 1) * 1.25}rem`}
										>
											{#if entry.kind === 'dir'}
												<Folder class="size-4 shrink-0 text-muted-foreground" />
												<span class="font-medium">{nameOf(entry.path)}</span>
											{:else}
												<FileText class="size-4 shrink-0 text-muted-foreground/60" />
												<span class="font-mono text-xs">{nameOf(entry.path)}</span>
											{/if}
										</span>
									</Table.Cell>
									<Table.Cell class="text-right text-xs text-muted-foreground">
										{entry.kind === 'file' ? formatBytes(entry.bytes ?? 0) : '—'}
									</Table.Cell>
									<Table.Cell>
										{#if entry.kind === 'file'}
											<Button variant="ghost" size="icon-sm" href={downloadHref(entry.path)}>
												<FileDown />
												<span class="sr-only">Download {entry.path}</span>
											</Button>
										{/if}
										<Button
											variant="ghost"
											size="icon-sm"
											onclick={() => (deleteArtifactTarget = entry.path)}
										>
											<Trash2 />
											<span class="sr-only">Delete {entry.path}</span>
										</Button>
									</Table.Cell>
								</Table.Row>
							{/each}
						</Table.Body>
					</Table.Root>
				</div>
			{/if}
		</div>
	{/if}
</div>

<Dialog.Root open={data.dialog === 'folder'} onOpenChange={closeDialog}>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>New folder</Dialog.Title>
			<Dialog.Description>
				Create the directory now, upload into it later. Subfolders come with the files themselves.
			</Dialog.Description>
		</Dialog.Header>
		<form
			method="POST"
			action="?/create"
			use:enhance={() => {
				folderSubmitting = true;
				return async ({ update }) => {
					await update();
					folderSubmitting = false;
				};
			}}
			class="flex flex-col gap-5"
		>
			<Field.Group>
				<Field.Field>
					<Field.Label for="folder-path">Path</Field.Label>
					<Input id="folder-path" name="path" placeholder="md-to-docx/references" required />
					<Field.Description
						>It lands at <code>uploads/&lt;path&gt;</code> in your agent's workspace.</Field.Description
					>
				</Field.Field>
			</Field.Group>
			<Dialog.Footer>
				<Button type="button" variant="outline" href="/dashboard/uploads">Cancel</Button>
				<Button type="submit" disabled={folderSubmitting}
					>{folderSubmitting ? 'Creating…' : 'Create folder'}</Button
				>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root open={data.dialog === 'dir'} onOpenChange={closeDialog}>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>Share a directory</Dialog.Title>
			<Dialog.Description>
				The tree goes straight to your agent's workspace under <code>uploads/</code>, paths intact.
				Up to {data.maxDirFiles} files, {data.maxUploadLabel} each, {data.maxDirTotalLabel} in total.
			</Dialog.Description>
		</Dialog.Header>
		<form
			method="POST"
			action="?/upload"
			enctype="multipart/form-data"
			use:enhance={({ formData, cancel }) => {
				pickError = null;
				const picked = dirInput?.files;
				if (!picked || picked.length === 0) {
					pickError = 'Choose a directory first.';
					cancel();
					return async ({ update }) => {
						await update({ reset: false });
					};
				}
				const pickedFiles = Array.from(picked);
				// The browser knows each file's path inside the picked directory; the
				// form itself would only carry basenames, so the paths ride along here.
				formData.append(
					'paths',
					JSON.stringify(pickedFiles.map((file) => file.webkitRelativePath || file.name))
				);
				for (const file of pickedFiles) formData.append('files', file);
				submitting = true;
				return async ({ update }) => {
					await update();
					submitting = false;
				};
			}}
			class="flex flex-col gap-5"
		>
			{#if pickError}
				<p class="text-sm text-destructive">{pickError}</p>
			{/if}
			<Field.Group>
				<Field.Field>
					<Field.Label for="dir-upload">Directory</Field.Label>
					<div
						class="flex items-center gap-3 rounded-lg border border-dashed border-border bg-muted/40 p-3"
					>
						<FolderUp class="size-4 shrink-0 text-muted-foreground" />
						<input
							id="dir-upload"
							bind:this={dirInput}
							type="file"
							multiple
							class="w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-transparent file:text-sm file:font-medium"
						/>
					</div>
					<Field.Description
						>Each file keeps its path: <code>md-to-docx/references/style-guide.md</code> lands exactly
						there. Uploading again overwrites the same paths.</Field.Description
					>
				</Field.Field>
			</Field.Group>
			<Dialog.Footer>
				<Button type="button" variant="outline" href="/dashboard/uploads">Cancel</Button>
				<Button type="submit" disabled={submitting}>
					{submitting ? 'Uploading…' : 'Upload directory'}
				</Button>
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
			<AlertDialog.Title>Delete “{deleteTarget ?? ''}”?</AlertDialog.Title>
			<AlertDialog.Description>
				The whole subtree under <code>uploads/{deleteTarget ?? ''}</code> disappears from the workspace.
				This cannot be undone.
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<form method="POST" action="?/delete" use:enhance>
				<input type="hidden" name="path" value={deleteTarget ?? ''} />
				<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
				<Button type="submit" variant="destructive">Delete</Button>
			</form>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>

<AlertDialog.Root
	open={deleteArtifactTarget !== null}
	onOpenChange={(open) => {
		if (!open) deleteArtifactTarget = null;
	}}
>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Delete “{deleteArtifactTarget ?? ''}”?</AlertDialog.Title>
			<AlertDialog.Description>
				The file or subtree under <code>artifacts/{deleteArtifactTarget ?? ''}</code> disappears from
				the workspace. This cannot be undone.
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<form method="POST" action="?/deleteArtifact" use:enhance>
				<input type="hidden" name="path" value={deleteArtifactTarget ?? ''} />
				<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
				<Button type="submit" variant="destructive">Delete</Button>
			</form>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
