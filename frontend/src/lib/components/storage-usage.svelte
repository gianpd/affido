<script lang="ts">
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import HardDrive from '@lucide/svelte/icons/hard-drive';
	import { Button } from '#lib/components/ui/button';
	import { Badge } from '#lib/components/ui/badge';
	import * as Alert from '#lib/components/ui/alert';
	import { formatBytes, formatDate } from '#lib/format';
	import {
		hostIsBinding,
		pieSlice,
		storageAlert,
		storageUsedColor,
		storageUsedFraction
	} from '#lib/storage';
	import type { StorageReport } from '#lib/types';

	/** RFC 0022: one container, one pie chart of the agent's disk quota. The
	 * snapshot is server-loaded; Refresh re-reads it on demand. Deliberately no
	 * polling: a repeating probe would keep an idle sandbox awake. */
	let { report }: { report: StorageReport | null } = $props();

	let override = $state<StorageReport | null>(null);
	let refreshing = $state(false);
	let refreshError = $state<string | null>(null);

	const shown = $derived(override ?? report);
	const fraction = $derived(shown === null ? 0 : storageUsedFraction(shown));
	const alert = $derived(shown === null ? null : storageAlert(shown));
	const usedColor = $derived(shown === null ? 'var(--chart-1)' : storageUsedColor(shown));
	const availableColor = 'var(--muted)';

	const refresh = async () => {
		if (refreshing) return;
		refreshing = true;
		refreshError = null;
		try {
			const response = await fetch('/api/storage');
			const body = (await response.json().catch(() => ({}))) as StorageReport & { error?: string };
			if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
			override = body;
		} catch (error) {
			refreshError = error instanceof Error ? error.message : String(error);
		} finally {
			refreshing = false;
		}
	};
</script>

<div class="flex flex-col gap-4 border border-border bg-card p-5">
	<div class="flex flex-wrap items-center justify-between gap-3">
		<div class="flex items-center gap-2">
			<HardDrive class="size-4 text-muted-foreground" />
			<h2 class="font-display text-lg">Agent storage</h2>
			{#if shown}
				<Badge
					variant={shown.state === 'ok'
						? 'outline'
						: shown.state === 'warning'
							? 'secondary'
							: 'destructive'}
					class="font-normal"
				>
					{shown.state}
				</Badge>
			{/if}
		</div>
		<Button variant="ghost" size="sm" onclick={refresh} disabled={refreshing}>
			<RefreshCw data-icon="inline-start" class={refreshing ? 'animate-spin' : ''} />
			{refreshing ? 'Refreshing…' : 'Refresh'}
		</Button>
	</div>

	{#if refreshError}
		<p class="text-xs text-destructive">Could not refresh: {refreshError}</p>
	{/if}

	{#if shown === null}
		<p class="text-sm text-muted-foreground">
			Storage usage is unavailable. The sandbox may be stopped; refresh to resolve it.
		</p>
	{:else}
		<div class="flex flex-wrap items-center gap-6">
			<svg
				class="size-40 shrink-0"
				viewBox="-1.05 -1.05 2.1 2.1"
				role="img"
				aria-label={`${Math.round(shown.usedPercent)}% of the agent quota used`}
			>
				{#if fraction <= 0.00001}
					<circle cx="0" cy="0" r="1" fill={availableColor} />
				{:else if fraction >= 0.99999}
					<circle cx="0" cy="0" r="1" fill={usedColor} />
				{:else}
					<path d={pieSlice(0, fraction)} fill={usedColor} />
					<path d={pieSlice(fraction, 1)} fill={availableColor} />
				{/if}
				<circle cx="0" cy="0" r="1" fill="none" stroke="var(--border)" stroke-width="0.03" />
			</svg>

			<div class="flex flex-col gap-2 text-sm">
				<div>
					<p class="text-xs font-medium tracking-wide text-muted-foreground uppercase">Available</p>
					<p class="font-display text-2xl">{formatBytes(shown.availableBytes)}</p>
				</div>
				<div class="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
					<span class="flex items-center gap-1.5">
						<span class="size-2 border border-border" style:background={usedColor}></span>
						Used {formatBytes(shown.usedBytes)} ({Math.round(shown.usedPercent)}%)
					</span>
					<span class="flex items-center gap-1.5">
						<span class="size-2 border border-border" style:background={availableColor}></span>
						Quota {formatBytes(shown.quotaBytes)}
					</span>
				</div>
				<p class="text-xs text-muted-foreground">Measured {formatDate(shown.checkedAt)}</p>
			</div>
		</div>

		{#if shown.partial}
			<p class="text-xs text-muted-foreground">
				The scan hit its entry cap: used bytes are a lower bound.
			</p>
		{/if}
		{#if hostIsBinding(shown)}
			<p class="text-xs text-muted-foreground">
				The host disk is the binding limit: {formatBytes(shown.hostFreeBytes ?? 0)} free on the volume's
				filesystem.
			</p>
		{/if}
		{#if alert}
			<Alert.Root variant={shown.state === 'warning' ? 'default' : 'destructive'}>
				<Alert.Title>{alert.title}</Alert.Title>
				<Alert.Description>{alert.description}</Alert.Description>
			</Alert.Root>
		{/if}
	{/if}
</div>
