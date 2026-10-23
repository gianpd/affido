<script lang="ts">
	import { enhance } from '$app/forms';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import MailCheck from '@lucide/svelte/icons/mail-check';
	import { Button } from '#lib/components/ui/button';
	import { Input } from '#lib/components/ui/input';
	import * as Field from '#lib/components/ui/field';
	import * as Card from '#lib/components/ui/card';
	import * as Alert from '#lib/components/ui/alert';
	import type { ActionData } from './$types';

	let { form }: { form: ActionData } = $props();

	let sending = $state(false);
</script>

<svelte:head>
	<title>Reset password — Durable</title>
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
				<h1 class="font-display text-4xl tracking-tight">Forgot your password?</h1>
				<p class="mt-2 text-sm text-muted-foreground">
					Enter your email and we create a single-use reset link.
				</p>
			</div>

			<Card.Root>
				<Card.Content class="pt-6">
					<form
						method="post"
						action="?/request"
						use:enhance={() => {
							sending = true;
							return async ({ update }) => {
								await update();
								sending = false;
							};
						}}
						class="flex flex-col gap-5"
					>
						<Field.Group>
							<Field.Field>
								<Field.Label for="forgot-email">Email</Field.Label>
								<Input
									id="forgot-email"
									name="email"
									type="email"
									autocomplete="email"
									placeholder="you@company.com"
									value={form?.email ?? ''}
									required
								/>
							</Field.Field>
						</Field.Group>
						{#if form?.message}
							<Field.Error>{form.message}</Field.Error>
						{/if}
						<Button type="submit" class="w-full" disabled={sending}>
							{sending ? 'Creating the link…' : 'Create reset link'}
							<ArrowRight data-icon="inline-end" />
						</Button>
					</form>

					{#if form?.sent}
						<Alert.Root class="mt-6">
							<MailCheck class="size-4" />
							<Alert.Title>If that address has an account, a reset link now exists</Alert.Title>
							<Alert.Description>
								{#if form.link}
									<p>
										This deployment hands the link to the page instead of emailing it. It works once
										and expires in an hour.
									</p>
									<Button href={form.link} class="mt-3 w-full">Open the reset link</Button>
								{:else}
									<p>
										The link was written to the app server log (<code>docker compose logs</code> or
										the terminal running <code>pnpm dev</code>). It works once and expires in an
										hour.
									</p>
								{/if}
							</Alert.Description>
						</Alert.Root>
					{/if}
				</Card.Content>
			</Card.Root>

			<p class="mt-6 flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
				<ArrowLeft class="size-3.5" />
				<a class="underline-offset-4 hover:underline" href="/login">Sign in instead</a>
			</p>
		</div>
	</main>
</div>
