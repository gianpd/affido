<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import KeyRound from '@lucide/svelte/icons/key-round';
	import BadgeCheck from '@lucide/svelte/icons/badge-check';
	import ShieldAlert from '@lucide/svelte/icons/shield-alert';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { Button } from '#lib/components/ui/button';
	import { Input } from '#lib/components/ui/input';
	import { Badge } from '#lib/components/ui/badge';
	import { Spinner } from '#lib/components/ui/spinner';
	import { Switch } from '#lib/components/ui/switch';
	import * as Field from '#lib/components/ui/field';
	import * as Select from '#lib/components/ui/select';
	import * as Alert from '#lib/components/ui/alert';
	import * as Card from '#lib/components/ui/card';
	import * as Table from '#lib/components/ui/table';
	import type { PageData } from './$types';
	import type { StoredProviderKey } from '#lib/server/providers';

	let { data }: { data: PageData } = $props();

	// The form state: provider, model, optional key and custom endpoint. It
	// intentionally captures the initial value of `data` (a form the user then
	// edits); the key lives in this component's memory only until submit — never
	// persisted client-side (no storage, no echo) — and the input clears after.
	// svelte-ignore state_referenced_locally
	let providerId = $state(data.config.selection?.provider ?? 'faux');
	// svelte-ignore state_referenced_locally
	let modelId = $state(data.config.selection?.modelId ?? 'faux-1');
	let apiKey = $state('');
	// svelte-ignore state_referenced_locally
	let baseUrl = $state(data.config.keys.find((k) => k.provider === providerId)?.baseUrl ?? '');
	let validate = $state(true);
	let saving = $state(false);
	let revoking = $state<string | null>(null);

	const CUSTOM = 'custom';
	const FAUX = 'faux';
	const providerOptions = $derived(
		[
			{ id: FAUX, name: 'Faux (default, no key)' },
			...data.catalog.providers.map((p) => ({ id: p.id, name: p.name })),
			{ id: CUSTOM, name: 'Custom OpenAI-compatible endpoint' }
		].sort((a, b) => (a.id === FAUX ? -1 : b.id === FAUX ? 1 : a.name.localeCompare(b.name)))
	);
	const entry = $derived(data.catalog.providers.find((p) => p.id === providerId));
	const models = $derived(entry?.models ?? []);
	const isCustom = $derived(providerId === CUSTOM);
	const isFaux = $derived(providerId === FAUX);
	const selection = $derived(data.config.selection);

	// Keep the model select coherent when the provider changes (Svelte 5 runes:
	// an $effect adjusting state derived from another select's value).
	$effect(() => {
		if (isCustom || isFaux) return;
		if (models.length > 0 && !models.some((m) => m.id === modelId)) {
			modelId = models[0]?.id ?? '';
		}
	});

	const save = async () => {
		if (saving) return;
		if (isCustom && baseUrl.trim() === '') {
			toast.error('A custom endpoint needs its base URL.');
			return;
		}
		if (
			!isCustom &&
			!isFaux &&
			apiKey === '' &&
			!data.config.keys.some((k) => k.provider === providerId)
		) {
			toast.error('Enter the API key for this provider first.');
			return;
		}
		saving = true;
		try {
			const response = await fetch('/api/providers/config', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					provider: providerId,
					modelId,
					...(apiKey === '' ? {} : { apiKey }),
					...(isCustom ? { baseUrl: baseUrl.trim() } : {}),
					...(isFaux || apiKey === '' ? {} : { validate })
				})
			});
			const body = (await response.json().catch(() => ({}))) as {
				error?: string;
				message?: string;
			};
			if (!response.ok)
				throw new Error(body.message ?? body.error ?? 'The provider was not saved.');
			apiKey = '';
			await invalidateAll();
			toast.success('Provider configuration saved');
		} catch (error) {
			toast.error(error instanceof Error ? error.message : 'The provider was not saved.');
		} finally {
			saving = false;
		}
	};

	const revoke = async (key: StoredProviderKey) => {
		if (revoking !== null) return;
		revoking = key.provider;
		try {
			const response = await fetch(
				`/api/providers/config?provider=${encodeURIComponent(key.provider)}`,
				{
					method: 'DELETE'
				}
			);
			if (!response.ok) {
				const body = (await response.json().catch(() => ({}))) as { message?: string };
				throw new Error(body.message ?? 'The key was not removed.');
			}
			await invalidateAll();
			toast.success(`${key.provider} key removed`);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : 'The key was not removed.');
		} finally {
			revoking = null;
		}
	};
</script>

<div class="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6">
	<header class="flex flex-col gap-1">
		<h1 class="text-2xl font-semibold tracking-tight">AI provider</h1>
		<p class="text-sm text-muted-foreground">
			Bring your own key: it is stored encrypted by the control plane, delivered to your sandbox on
			demand, and never written to the sandbox environment or disk.
		</p>
	</header>

	{#if data.error !== null}
		<Alert.Root variant="destructive">
			<Alert.Title>Control plane unavailable</Alert.Title>
			<Alert.Description>{data.error}</Alert.Description>
		</Alert.Root>
	{/if}

	{#if selection !== null}
		<Card.Root>
			<Card.Header>
				<Card.Title>Active model</Card.Title>
				<Card.Description>
					Applied to your sandbox on its next request; existing chats keep their history.
				</Card.Description>
			</Card.Header>
			<Card.Content class="flex flex-wrap items-center gap-2">
				<Badge variant="secondary">{selection.provider}</Badge>
				<Badge variant="outline">{selection.modelId}</Badge>
				{#if data.config.keys.find((k) => k.provider === selection.provider)}
					{@const key = data.config.keys.find((k) => k.provider === selection.provider)}
					<span class="font-mono text-xs text-muted-foreground">key {key?.fingerprint}</span>
					{#if key?.verified}
						<Badge class="gap-1"><BadgeCheck class="size-3" /> verified</Badge>
					{:else}
						<Badge variant="outline" class="gap-1">
							<ShieldAlert class="size-3" /> unverified
						</Badge>
					{/if}
				{/if}
			</Card.Content>
		</Card.Root>
	{/if}

	<Card.Root>
		<Card.Header>
			<Card.Title>Configure</Card.Title>
			<Card.Description>
				One key per provider; the selection is the model new replies use.
			</Card.Description>
		</Card.Header>
		<Card.Content class="flex flex-col gap-4">
			<Field.Field>
				<Field.Label for="provider">Provider</Field.Label>
				<Select.Root name="provider" type="single" bind:value={providerId}>
					<Select.Trigger id="provider" class="w-full">
						<Select.Value placeholder="Choose a provider" />
					</Select.Trigger>
					<Select.Content>
						{#each providerOptions as option (option.id)}
							<Select.Item value={option.id}>{option.name}</Select.Item>
						{/each}
					</Select.Content>
				</Select.Root>
				<Field.Description>
					{#if entry?.baseUrl}
						<span class="font-mono text-xs">{entry.baseUrl}</span>
					{:else if isCustom}
						Any OpenAI-compatible chat-completions endpoint.
					{:else}
						The bundled deterministic provider; no key, no network.
					{/if}
				</Field.Description>
			</Field.Field>

			{#if isCustom}
				<Field.Field>
					<Field.Label for="base-url">Base URL</Field.Label>
					<Input id="base-url" bind:value={baseUrl} placeholder="https://api.example.com/v1" />
					<Field.Description
						>https only; must be reachable from the control plane.</Field.Description
					>
				</Field.Field>
				<Field.Field>
					<Field.Label for="model-id">Model id</Field.Label>
					<Input id="model-id" bind:value={modelId} placeholder="my-model" />
				</Field.Field>
			{:else if isFaux}
				<Field.Field>
					<Field.Label for="model">Model</Field.Label>
					<Input id="model" value="faux-1" disabled />
				</Field.Field>
			{:else}
				<Field.Field>
					<Field.Label for="model">Model</Field.Label>
					<Select.Root name="modelId" type="single" bind:value={modelId}>
						<Select.Trigger id="model" class="w-full">
							<Select.Value placeholder="Choose a model" />
						</Select.Trigger>
						<Select.Content>
							{#each models as model (model.id)}
								<Select.Item value={model.id}>{model.name}</Select.Item>
							{/each}
						</Select.Content>
					</Select.Root>
				</Field.Field>
			{/if}

			{#if !isFaux}
				<Field.Field>
					<Field.Label for="api-key">API key</Field.Label>
					<Input
						id="api-key"
						type="password"
						autocomplete="off"
						bind:value={apiKey}
						placeholder={data.config.keys.some((k) => k.provider === providerId)
							? 'Leave empty to keep the stored key'
							: 'sk-…'}
					/>
					<Field.Description>
						Only the fingerprint of the stored key is ever shown back.
					</Field.Description>
				</Field.Field>
				<label class="flex items-center gap-2 text-sm" for="validate">
					<Switch id="validate" bind:checked={validate} />
					Verify the key against the provider before saving
				</label>
			{/if}

			<div>
				<Button onclick={save} disabled={saving}>
					{#if saving}
						<Spinner class="size-4" />
					{:else}
						<KeyRound class="size-4" />
					{/if}
					Save configuration
				</Button>
			</div>
		</Card.Content>
	</Card.Root>

	<Card.Root>
		<Card.Header>
			<Card.Title>Stored keys</Card.Title>
			<Card.Description>
				Encrypted at rest; removing a key also clears the selection if it pointed at it.
			</Card.Description>
		</Card.Header>
		<Card.Content>
			{#if data.config.keys.length === 0}
				<p class="text-sm text-muted-foreground">No keys stored yet.</p>
			{:else}
				<Table.Root>
					<Table.Header>
						<Table.Row>
							<Table.Head>Provider</Table.Head>
							<Table.Head>Fingerprint</Table.Head>
							<Table.Head>Status</Table.Head>
							<Table.Head class="w-16"></Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each data.config.keys as key (key.provider)}
							<Table.Row>
								<Table.Cell>{key.provider}</Table.Cell>
								<Table.Cell class="font-mono text-xs">{key.fingerprint}</Table.Cell>
								<Table.Cell>
									{#if key.verified}
										<Badge class="gap-1"><BadgeCheck class="size-3" /> verified</Badge>
									{:else}
										<Badge variant="outline" class="gap-1">
											<ShieldAlert class="size-3" /> unverified
										</Badge>
									{/if}
								</Table.Cell>
								<Table.Cell>
									<Button
										variant="ghost"
										size="icon"
										title="Remove key"
										disabled={revoking !== null}
										onclick={() => revoke(key)}
									>
										{#if revoking === key.provider}
											<Spinner class="size-4" />
										{:else}
											<Trash2 class="size-4" />
										{/if}
									</Button>
								</Table.Cell>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			{/if}
		</Card.Content>
	</Card.Root>

	<Alert.Root>
		<Alert.Title>Where the key lives</Alert.Title>
		<Alert.Description>
			The key is encrypted in the control-plane database and delivered to your sandbox's memory only
			while it runs. It never appears in the sandbox environment, files, or logs — anything the
			sandbox's own tools can read is your key alone.
		</Alert.Description>
	</Alert.Root>
</div>
