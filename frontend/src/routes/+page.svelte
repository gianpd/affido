<script lang="ts">
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import ArrowUp from '@lucide/svelte/icons/arrow-up';
	import FileText from '@lucide/svelte/icons/file-text';
	import History from '@lucide/svelte/icons/history';
	import ShieldCheck from '@lucide/svelte/icons/shield-check';
	import Sparkles from '@lucide/svelte/icons/sparkles';
	import { Button } from '#lib/components/ui/button';
	import { Badge } from '#lib/components/ui/badge';
	import * as Card from '#lib/components/ui/card';

	const prompts = [
		'Summarize data.txt',
		'Which files changed today?',
		'Find the renewal date in the contract'
	];

	const features = [
		{
			icon: ShieldCheck,
			title: 'One sandbox per user',
			body: 'The manager provisions an isolated container, workspace volume and session database the first time a user asks anything.'
		},
		{
			icon: History,
			title: 'Durable by default',
			body: 'Sessions resume after idle pauses, container stops and restarts. The conversation is checkpointed, not replayed.'
		},
		{
			icon: FileText,
			title: 'Documents and corpus',
			body: 'Keep text documents in collections, then point the agent at a corpus instead of pasting context into every prompt.'
		}
	];
</script>

<svelte:head>
	<title>Durable — agent sandboxes with durable traces</title>
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
		<nav class="hidden items-center gap-6 text-sm text-muted-foreground md:flex">
			<a class="transition-colors hover:text-foreground" href="#features">Product</a>
			<a class="transition-colors hover:text-foreground" href="/login">Chat</a>
			<a class="transition-colors hover:text-foreground" href="/login">Traces</a>
		</nav>
		<div class="flex items-center gap-2">
			<Button variant="ghost" size="sm" href="/login">Sign in</Button>
			<Button size="sm" href="/login">
				Get started
				<ArrowRight data-icon="inline-end" />
			</Button>
		</div>
	</header>

	<main class="flex-1">
		<section class="mx-auto max-w-6xl px-6 pt-16 pb-20 md:pt-24">
			<div class="mx-auto flex max-w-3xl flex-col items-center text-center">
				<Badge variant="secondary" class="mb-6 gap-1.5 px-3 py-1 font-normal">
					<Sparkles class="text-primary" />
					Pi-durable containers · RFC 0003
				</Badge>
				<h1 class="font-display text-5xl leading-[0.95] tracking-tight md:text-7xl">
					Ask your documents.<br />
					<span class="text-primary">Trace every step.</span>
				</h1>
				<p class="mt-6 max-w-xl text-base leading-relaxed text-muted-foreground md:text-lg">
					A durable agent sandbox per user. Chat with it, keep documents and corpus collections, and
					inspect every entry, task and submission it produced.
				</p>

				<a
					href="/login"
					class="mt-10 flex w-full max-w-2xl items-center gap-3 rounded-2xl border border-border bg-card p-2 pl-4 text-left shadow-sm transition-colors hover:border-primary/40"
				>
					<Sparkles class="size-4 shrink-0 text-muted-foreground" />
					<span class="flex-1 truncate text-sm text-muted-foreground"
						>Ask your agent about a document…</span
					>
					<span
						class="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground"
					>
						<ArrowUp class="size-4" />
					</span>
				</a>

				<div class="mt-4 flex flex-wrap justify-center gap-2">
					{#each prompts as prompt (prompt)}
						<a
							href="/login"
							class="border border-border bg-background px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
						>
							{prompt}
						</a>
					{/each}
				</div>
			</div>
		</section>

		<section id="features" class="border-y border-border bg-muted/30">
			<div class="mx-auto grid max-w-6xl gap-4 px-6 py-16 md:grid-cols-3">
				{#each features as feature (feature.title)}
					<Card.Root class="bg-card/70">
						<Card.Header>
							<div
								class="mb-3 flex size-10 items-center justify-center rounded-xl bg-accent text-accent-foreground"
							>
								<feature.icon class="size-5" />
							</div>
							<Card.Title class="font-display text-xl">{feature.title}</Card.Title>
							<Card.Description class="leading-relaxed">{feature.body}</Card.Description>
						</Card.Header>
					</Card.Root>
				{/each}
			</div>
		</section>

		<section class="mx-auto flex max-w-6xl flex-col items-center px-6 py-20 text-center">
			<h2 class="font-display text-4xl tracking-tight md:text-5xl">Start with one prompt.</h2>
			<p class="mt-3 max-w-lg text-muted-foreground">
				Sign in, create a corpus, and watch the first entries land in the trace.
			</p>
			<Button size="lg" class="mt-7" href="/login">
				Open the dashboard
				<ArrowRight data-icon="inline-end" />
			</Button>
		</section>
	</main>

	<footer class="border-t border-border text-muted-foreground">
		<div
			class="mx-auto flex max-w-6xl flex-col gap-2 px-6 py-6 text-xs sm:flex-row sm:items-center sm:justify-between"
		>
			<span>Durable agent containers. Data stays in your control plane.</span>
			<span>built on @earendil-works/pi-durable · SvelteKit · AI SDK</span>
		</div>
	</footer>
</div>
