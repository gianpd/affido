<script lang="ts">
	import { enhance } from '$app/forms';
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import { Button } from '#lib/components/ui/button';
	import { Input } from '#lib/components/ui/input';
	import * as Field from '#lib/components/ui/field';
	import * as Tabs from '#lib/components/ui/tabs';
	import * as Card from '#lib/components/ui/card';
	import * as Alert from '#lib/components/ui/alert';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	let tab = $state('signin');
	$effect(() => {
		if (form?.intent) tab = form.intent === 'signUp' ? 'signup' : 'signin';
	});
</script>

<svelte:head>
	<title>Sign in — Durable</title>
</svelte:head>

<div class="flex min-h-svh flex-col">
	<header class="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-6">
		<a href="/" class="flex items-center gap-2.5">
			<span
				class="flex size-8 items-center justify-center rounded-lg bg-primary font-display text-xl leading-none text-primary-foreground"
				>d</span
			>
			<span class="font-display text-2xl leading-none">durable</span>
		</a>
		<Button variant="ghost" size="sm" href="/">Back home</Button>
	</header>

	<main class="flex flex-1 items-center justify-center px-6 py-12">
		<div class="w-full max-w-md">
			<div class="mb-8 text-center">
				<h1 class="font-display text-4xl tracking-tight">Welcome back.</h1>
				<p class="mt-2 text-sm text-muted-foreground">
					Sign in to your sandbox, documents and trace history.
				</p>
			</div>

			<Card.Root>
				<Card.Content class="pt-6">
					{#if data.reset}
						<Alert.Root class="mb-6">
							<Alert.Title>Password updated</Alert.Title>
							<Alert.Description
								>Your sessions were closed. Sign in with the new password.</Alert.Description
							>
						</Alert.Root>
					{/if}
					<Tabs.Root bind:value={tab}>
						<Tabs.List class="mb-6 grid w-full grid-cols-2">
							<Tabs.Trigger value="signin">Sign in</Tabs.Trigger>
							<Tabs.Trigger value="signup">Create account</Tabs.Trigger>
						</Tabs.List>

						<Tabs.Content value="signin">
							<form method="post" action="?/signIn" use:enhance class="flex flex-col gap-5">
								<input type="hidden" name="next" value={data.next} />
								<Field.Group>
									<Field.Field>
										<Field.Label for="signin-email">Email</Field.Label>
										<Input
											id="signin-email"
											name="email"
											type="email"
											autocomplete="email"
											placeholder="you@company.com"
											required
										/>
									</Field.Field>
									<Field.Field>
										<Field.Label for="signin-password">Password</Field.Label>
										<Input
											id="signin-password"
											name="password"
											type="password"
											autocomplete="current-password"
											required
										/>
									</Field.Field>
								</Field.Group>
								{#if form?.message && form.intent === 'signIn'}
									<Field.Error>{form.message}</Field.Error>
								{/if}
								<Button type="submit" class="w-full">
									Sign in
									<ArrowRight data-icon="inline-end" />
								</Button>
								<p class="text-center text-xs text-muted-foreground">
									<a class="underline-offset-4 hover:underline" href="/login/forgot">
										Forgot your password?
									</a>
								</p>
							</form>
						</Tabs.Content>

						<Tabs.Content value="signup">
							<form method="post" action="?/signUp" use:enhance class="flex flex-col gap-5">
								<input type="hidden" name="next" value={data.next} />
								<Field.Group>
									<Field.Field>
										<Field.Label for="signup-name">Name</Field.Label>
										<Input
											id="signup-name"
											name="name"
											autocomplete="name"
											placeholder="Ada Lovelace"
											required
										/>
									</Field.Field>
									<Field.Field>
										<Field.Label for="signup-email">Email</Field.Label>
										<Input
											id="signup-email"
											name="email"
											type="email"
											autocomplete="email"
											placeholder="you@company.com"
											required
										/>
									</Field.Field>
									<Field.Field>
										<Field.Label for="signup-password">Password</Field.Label>
										<Input
											id="signup-password"
											name="password"
											type="password"
											autocomplete="new-password"
											minlength={8}
											required
										/>
										<Field.Description>At least 8 characters.</Field.Description>
									</Field.Field>
								</Field.Group>
								{#if form?.message && form.intent === 'signUp'}
									<Field.Error>{form.message}</Field.Error>
								{/if}
								<Button type="submit" class="w-full">
									Create account
									<ArrowRight data-icon="inline-end" />
								</Button>
							</form>
						</Tabs.Content>
					</Tabs.Root>
				</Card.Content>
			</Card.Root>

			<p class="mt-6 text-center text-xs text-muted-foreground">
				Your documents stay in the control-plane database. The agent runs in its own container.
			</p>
		</div>
	</main>
</div>
