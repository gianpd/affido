<script lang="ts">
	import { enhance } from '$app/forms';
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import KeyRound from '@lucide/svelte/icons/key-round';
	import { Button } from '#lib/components/ui/button';
	import { Input } from '#lib/components/ui/input';
	import * as Field from '#lib/components/ui/field';
	import * as Card from '#lib/components/ui/card';
	import * as Alert from '#lib/components/ui/alert';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	let saving = $state(false);
	const token = $derived(form?.token ?? data.token);
	const usable = $derived(token !== '' && !data.expired);
</script>

<svelte:head>
	<title>Set a new password — Durable</title>
</svelte:head>

<div class="flex min-h-svh flex-col">
	<header class="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-6">
		<a href="/" class="flex items-center gap-2.5" aria-label="Affido">
			<img
				src="/brand/affido-wordmark.png"
				alt="Affido"
				width="512"
				height="208"
				class="h-8 w-auto"
			/>
		</a>
		<Button variant="ghost" size="sm" href="/login">Back to sign in</Button>
	</header>

	<main class="flex flex-1 items-center justify-center px-6 py-12">
		<div class="w-full max-w-md">
			<div class="mb-8 text-center">
				<h1 class="font-display text-4xl tracking-tight">Set a new password</h1>
				<p class="mt-2 text-sm text-muted-foreground">
					Signing in again is required: this link signs you out everywhere.
				</p>
			</div>

			<Card.Root>
				<Card.Content class="pt-6">
					{#if !usable}
						<Alert.Root variant="destructive">
							<KeyRound class="size-4" />
							<Alert.Title>This link is not usable</Alert.Title>
							<Alert.Description>
								It expired, was already used, or the address was opened without a token.
							</Alert.Description>
						</Alert.Root>
						<Button href="/login/forgot" class="mt-4 w-full">Request a new link</Button>
					{:else}
						<form
							method="post"
							action="?/reset"
							use:enhance={() => {
								saving = true;
								return async ({ update }) => {
									await update();
									saving = false;
								};
							}}
							class="flex flex-col gap-5"
						>
							<input type="hidden" name="token" value={token} />
							<Field.Group>
								<Field.Field>
									<Field.Label for="reset-password">New password</Field.Label>
									<Input
										id="reset-password"
										name="password"
										type="password"
										autocomplete="new-password"
										minlength={8}
										required
									/>
									<Field.Description>At least 8 characters.</Field.Description>
								</Field.Field>
								<Field.Field>
									<Field.Label for="reset-confirm">Repeat it</Field.Label>
									<Input
										id="reset-confirm"
										name="confirm"
										type="password"
										autocomplete="new-password"
										minlength={8}
										required
									/>
								</Field.Field>
							</Field.Group>
							{#if form?.message}
								<Field.Error>{form.message}</Field.Error>
							{/if}
							<Button type="submit" class="w-full" disabled={saving}>
								{saving ? 'Saving…' : 'Save and sign in'}
								<ArrowRight data-icon="inline-end" />
							</Button>
						</form>
					{/if}
				</Card.Content>
			</Card.Root>
		</div>
	</main>
</div>
