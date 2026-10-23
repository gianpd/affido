<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { enhance } from '$app/forms';
	import { toast } from 'svelte-sonner';
	import Store from '@lucide/svelte/icons/store';
	import Check from '@lucide/svelte/icons/check';
	import PackageCheck from '@lucide/svelte/icons/package-check';
	import ShieldCheck from '@lucide/svelte/icons/shield-check';
	import ShieldAlert from '@lucide/svelte/icons/shield-alert';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import Download from '@lucide/svelte/icons/download';
	import { Button } from '#lib/components/ui/button';
	import { Badge } from '#lib/components/ui/badge';
	import { Spinner } from '#lib/components/ui/spinner';
	import * as Alert from '#lib/components/ui/alert';
	import * as Empty from '#lib/components/ui/empty';
	import * as AlertDialog from '#lib/components/ui/alert-dialog';
	import { formatBytes, formatNumber } from '#lib/format';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	type VerifyReport = { skill: string; ok: boolean; files: { path: string; status: string }[] };

	// Per-skill client state: which install/verify is running and the last verdict.
	let busy = $state<string | null>(null);
	let verdict = $state<Record<string, VerifyReport>>({});
	let uninstallTarget = $state<string | null>(null);

	const installedOf = (name: string) => data.installed.find((skill) => skill.name === name);

	const install = async (name: string) => {
		if (busy !== null) return;
		busy = name;
		try {
			const response = await fetch('/api/marketplace/install', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ name })
			});
			const body = (await response.json().catch(() => ({}))) as {
				verify?: VerifyReport;
				message?: string;
				error?: string;
			};
			if (!response.ok || !body.verify) {
				throw new Error(body.message ?? body.error ?? 'The install did not complete.');
			}
			verdict[name] = body.verify;
			await invalidateAll();
			toast.success(
				body.verify.ok ? `${name} installed and verified` : `${name} installed, verification failed`
			);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : 'The install did not complete.');
		} finally {
			busy = null;
		}
	};

	const verify = async (name: string) => {
		if (busy !== null) return;
		busy = name;
		try {
			const response = await fetch('/api/marketplace/verify', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ name })
			});
			const body = (await response.json().catch(() => ({}))) as VerifyReport & { message?: string };
			if (!response.ok || !Array.isArray(body.files)) {
				throw new Error(body.message ?? 'Verification did not complete.');
			}
			verdict[name] = body;
			toast[body.ok ? 'success' : 'error'](
				body.ok ? `${name}: all files match` : `${name}: verification failed`
			);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : 'Verification did not complete.');
		} finally {
			busy = null;
		}
	};
</script>

<svelte:head>
	<title>Skills — Durable</title>
</svelte:head>

<div class="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-8">
	<div>
		<p class="text-sm text-muted-foreground">Marketplace</p>
		<h1 class="mt-1 font-display text-4xl tracking-tight">Skills</h1>
		<p class="mt-2 max-w-2xl text-sm text-muted-foreground">
			Platform-curated skills install into your sandbox workspace at
			<code>skills/&lt;name&gt;</code> and survive pause, restart, and reprovision. Invoke one in
			chat with <code>/name</code> — or just ask in plain language.
		</p>
	</div>

	{#if form?.message}
		<Alert.Root variant="destructive">
			<Alert.Title>Could not save</Alert.Title>
			<Alert.Description>{form.message}</Alert.Description>
		</Alert.Root>
	{/if}

	{#if data.catalog.length === 0}
		<Empty.Root class="border">
			<Empty.Header>
				<Empty.Media variant="icon">
					<Store class="size-5" />
				</Empty.Media>
				<Empty.Title>The catalog is empty</Empty.Title>
				<Empty.Description>
					Skills are bundled with the platform under <code>marketplace/skills/</code>.
				</Empty.Description>
			</Empty.Header>
		</Empty.Root>
	{:else}
		<div class="grid gap-4 md:grid-cols-2">
			{#each data.catalog as skill (skill.name)}
				{@const installed = installedOf(skill.name)}
				{@const report = verdict[skill.name] ?? null}
				<div class="flex flex-col gap-4 rounded-xl border border-border bg-card p-5">
					<div class="flex items-start justify-between gap-3">
						<div class="min-w-0">
							<div class="flex items-center gap-2">
								<span
									class="flex size-9 items-center justify-center rounded-lg bg-accent text-accent-foreground"
								>
									<PackageCheck class="size-4" />
								</span>
								<div class="min-w-0">
									<h2 class="truncate font-medium">{skill.name}</h2>
									<p class="text-xs text-muted-foreground">v{skill.version}</p>
								</div>
							</div>
							<p class="mt-3 text-sm text-muted-foreground">{skill.description}</p>
						</div>
						{#if installed}
							<Badge variant="secondary" class="gap-1 font-normal">
								<Check class="size-3" />
								Installed{installed.version ? ` v${installed.version}` : ''}
							</Badge>
						{/if}
					</div>

					<div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
						<span
							>{formatNumber(skill.files.length)} files · {formatBytes(
								skill.files.reduce((total, file) => total + file.bytes, 0)
							)}</span
						>
						{#each skill.requires as library (library)}
							<Badge variant="outline" class="font-normal">needs {library}</Badge>
						{/each}
						{#if installed?.verified === 'ok'}
							<Badge variant="outline" class="gap-1 font-normal text-emerald-600">
								<ShieldCheck class="size-3" />
								verified
							</Badge>
						{:else if installed?.verified === 'mismatch'}
							<Badge variant="outline" class="gap-1 font-normal text-destructive">
								<ShieldAlert class="size-3" />
								modified
							</Badge>
						{/if}
					</div>

					{#if report}
						<div class="rounded-lg border border-border p-3 text-xs">
							{#if report.ok}
								<p class="flex items-center gap-1.5 font-medium text-emerald-600">
									<ShieldCheck class="size-3.5" /> All {report.files.length} files match the catalog.
								</p>
							{:else}
								<p class="flex items-center gap-1.5 font-medium text-destructive">
									<ShieldAlert class="size-3.5" /> Verification failed:
								</p>
								<ul class="mt-1 list-inside list-disc text-muted-foreground">
									{#each report.files.filter((file) => file.status !== 'ok') as file (file.path)}
										<li><code>{file.path}</code> — {file.status}</li>
									{/each}
								</ul>
								<p class="mt-1 text-muted-foreground">Install again to rewrite the files.</p>
							{/if}
						</div>
					{/if}

					<div class="mt-auto flex flex-wrap items-center gap-2">
						<Button size="sm" onclick={() => install(skill.name)} disabled={busy !== null}>
							{#if busy === skill.name}
								<Spinner class="size-3.5" />
								Installing…
							{:else}
								<Download data-icon="inline-start" />
								{installed ? 'Reinstall' : 'Install'}
							{/if}
						</Button>
						{#if installed}
							<Button
								size="sm"
								variant="outline"
								onclick={() => verify(skill.name)}
								disabled={busy !== null}
							>
								{#if busy === skill.name}
									<Spinner class="size-3.5" />
								{:else}
									<RefreshCw data-icon="inline-start" />
								{/if}
								Verify
							</Button>
							<Button
								size="sm"
								variant="ghost"
								onclick={() => (uninstallTarget = skill.name)}
								disabled={busy !== null}
							>
								<Trash2 data-icon="inline-start" />
								Uninstall
							</Button>
						{/if}
					</div>
				</div>
			{/each}
		</div>

		{#if data.installed.length > data.catalog.length}
			<p class="text-xs text-muted-foreground">
				{data.installed
					.filter((skill) => !data.catalog.some((entry) => entry.name === skill.name))
					.map((skill) => `${skill.name} (${skill.provenance})`)
					.join(', ')}
				{data.installed.length - data.catalog.length === 1 ? 'is' : 'are'} installed from your own uploads,
				not from this catalog — invocable the same way.
			</p>
		{/if}
	{/if}
</div>

<AlertDialog.Root
	open={uninstallTarget !== null}
	onOpenChange={(open) => {
		if (!open) uninstallTarget = null;
	}}
>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Uninstall “{uninstallTarget ?? ''}”?</AlertDialog.Title>
			<AlertDialog.Description>
				The whole subtree under <code>skills/{uninstallTarget ?? ''}</code> disappears from the workspace.
				Chat history that used it stays; reinstalling restores the catalog copy.
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<form
				method="POST"
				action="?/uninstall"
				use:enhance={() => {
					return async ({ update }) => {
						await update();
						uninstallTarget = null;
					};
				}}
			>
				<input type="hidden" name="name" value={uninstallTarget ?? ''} />
				<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
				<Button type="submit" variant="destructive">Uninstall</Button>
			</form>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
