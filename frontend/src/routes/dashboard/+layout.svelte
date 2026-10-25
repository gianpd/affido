<script lang="ts">
	import { page } from '$app/state';
	import Brand from '#lib/components/brand.svelte';
	import * as Sidebar from '#lib/components/ui/sidebar';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu';
	import * as Avatar from '#lib/components/ui/avatar';
	import { Button } from '#lib/components/ui/button';
	import { Separator } from '#lib/components/ui/separator';
	import LayoutDashboard from '@lucide/svelte/icons/layout-dashboard';
	import MessageSquare from '@lucide/svelte/icons/message-square';
	import FileText from '@lucide/svelte/icons/file-text';
	import LibraryBig from '@lucide/svelte/icons/library-big';
	import FolderUp from '@lucide/svelte/icons/folder-up';
	import Store from '@lucide/svelte/icons/store';
	import History from '@lucide/svelte/icons/history';
	import Settings from '@lucide/svelte/icons/settings';
	import LogOut from '@lucide/svelte/icons/log-out';
	import ChevronsUpDown from '@lucide/svelte/icons/chevrons-up-down';
	import Plus from '@lucide/svelte/icons/plus';
	import Sparkles from '@lucide/svelte/icons/sparkles';
	import PanelLeft from '@lucide/svelte/icons/panel-left';
	import type { LayoutData } from './$types';
	import type { LayoutProps } from './$types';

	let { data, children }: { data: LayoutData; children: LayoutProps['children'] } = $props();

	const items = $derived([
		{ title: 'Overview', href: '/dashboard', icon: LayoutDashboard, badge: undefined },
		{ title: 'Chat', href: '/dashboard/chat', icon: MessageSquare, badge: undefined },
		{
			title: 'Documents',
			href: '/dashboard/documents',
			icon: FileText,
			badge: data.counts.documents
		},
		{ title: 'Corpus', href: '/dashboard/corpus', icon: LibraryBig, badge: data.counts.corpora },
		{ title: 'Uploads', href: '/dashboard/uploads', icon: FolderUp, badge: undefined },
		{ title: 'Skills', href: '/dashboard/skills', icon: Store, badge: undefined },
		{ title: 'Traces', href: '/dashboard/traces', icon: History, badge: data.counts.traces },
		{ title: 'AI provider', href: '/dashboard/settings', icon: Settings, badge: undefined }
	]);

	const isActive = (href: string) =>
		href === '/dashboard' ? page.url.pathname === href : page.url.pathname.startsWith(href);

	const initials = $derived(
		data.user.name
			.split(' ')
			.filter(Boolean)
			.slice(0, 2)
			.map((part) => part[0]?.toUpperCase())
			.join('') || 'U'
	);

	let open = $state(true);
</script>

<Sidebar.Provider bind:open>
	<Sidebar.Root collapsible="icon">
		<Sidebar.Header>
			<div
				class="flex items-center justify-between px-1 py-1 group-data-[collapsible=icon]:justify-center"
			>
				<div class="group-data-[collapsible=icon]:hidden">
					<Brand />
				</div>
				<div class="hidden group-data-[collapsible=icon]:block">
					<Brand wordmark={false} />
				</div>
				<span
					class="bg-muted px-2 py-0.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase group-data-[collapsible=icon]:hidden"
				>
					alpha
				</span>
			</div>
		</Sidebar.Header>

		<Sidebar.Content>
			<Sidebar.Group>
				<Sidebar.GroupLabel>Workspace</Sidebar.GroupLabel>
				<Sidebar.GroupContent>
					<Sidebar.Menu>
						{#each items as item (item.href)}
							<Sidebar.MenuItem>
								<Sidebar.MenuButton isActive={isActive(item.href)} tooltipContent={item.title}>
									{#snippet child({ props })}
										<a href={item.href} {...props}>
											<item.icon />
											<span>{item.title}</span>
											{#if item.badge !== undefined}
												<Sidebar.MenuBadge>{item.badge}</Sidebar.MenuBadge>
											{/if}
										</a>
									{/snippet}
								</Sidebar.MenuButton>
							</Sidebar.MenuItem>
						{/each}
					</Sidebar.Menu>
				</Sidebar.GroupContent>
			</Sidebar.Group>

			<Sidebar.Group class="mt-auto">
				<Sidebar.GroupContent>
					<Sidebar.Menu>
						<Sidebar.MenuItem>
							<Button
								href="/dashboard/documents?new=1"
								variant="outline"
								size="sm"
								class="w-full justify-start"
							>
								<Plus data-icon="inline-start" />
								<span class="group-data-[collapsible=icon]:hidden">New document</span>
							</Button>
						</Sidebar.MenuItem>
					</Sidebar.Menu>
				</Sidebar.GroupContent>
			</Sidebar.Group>
		</Sidebar.Content>

		<Sidebar.Footer>
			<DropdownMenu.Root>
				<DropdownMenu.Trigger>
					{#snippet child({ props })}
						<button
							{...props}
							class="flex w-full items-center gap-2 rounded-md p-1.5 text-left transition-colors hover:bg-sidebar-accent"
						>
							<Avatar.Root class="size-8 rounded-lg">
								<Avatar.Image src={data.user.image ?? undefined} alt={data.user.name} />
								<Avatar.Fallback class="rounded-lg text-xs">{initials}</Avatar.Fallback>
							</Avatar.Root>
							<span class="flex min-w-0 flex-1 flex-col group-data-[collapsible=icon]:hidden">
								<span class="truncate text-sm font-medium">{data.user.name}</span>
								<span class="truncate text-xs text-muted-foreground">{data.user.email}</span>
							</span>
							<ChevronsUpDown
								class="size-4 text-muted-foreground group-data-[collapsible=icon]:hidden"
							/>
						</button>
					{/snippet}
				</DropdownMenu.Trigger>
				<DropdownMenu.Content side="top" align="start" class="w-56">
					<DropdownMenu.Label>
						<span class="block truncate font-medium text-foreground">{data.user.name}</span>
						<span class="block truncate">{data.user.email}</span>
					</DropdownMenu.Label>
					<DropdownMenu.Separator />
					<DropdownMenu.Item closeOnSelect={false}>
						<form method="POST" action="/logout" class="w-full">
							<button type="submit" class="flex w-full items-center gap-2 text-left">
								<LogOut class="size-4" />
								Sign out
							</button>
						</form>
					</DropdownMenu.Item>
				</DropdownMenu.Content>
			</DropdownMenu.Root>
		</Sidebar.Footer>
		<Sidebar.Rail />
	</Sidebar.Root>

	<Sidebar.Inset>
		<header
			class="sticky top-0 z-10 flex h-14 items-center gap-3 border-b bg-background/80 px-4 backdrop-blur"
		>
			<Sidebar.Trigger>
				<PanelLeft class="size-4" />
				<span class="sr-only">Toggle sidebar</span>
			</Sidebar.Trigger>
			<Separator orientation="vertical" class="h-5!" />
			<span class="text-sm text-muted-foreground">
				{items.find((item) => isActive(item.href))?.title ?? 'Dashboard'}
			</span>
			<div class="ml-auto flex items-center gap-2">
				<Button variant="ghost" size="sm" href="/dashboard/chat">
					<Sparkles data-icon="inline-start" />
					Ask the agent
				</Button>
			</div>
		</header>
		<main class="flex min-h-0 flex-1 flex-col">
			{@render children()}
		</main>
	</Sidebar.Inset>
</Sidebar.Provider>
