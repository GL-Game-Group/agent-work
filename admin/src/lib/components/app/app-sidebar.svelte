<script lang="ts">
	import { page } from '$app/state';
	import * as Sidebar from '#lib/components/ui/sidebar/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import * as Avatar from '#lib/components/ui/avatar/index.js';
	import { toggleMode } from 'mode-watcher';
	import LayoutDashboard from '@lucide/svelte/icons/layout-dashboard';
	import Boxes from '@lucide/svelte/icons/boxes';
	import KeyRound from '@lucide/svelte/icons/key-round';
	import AudioLines from '@lucide/svelte/icons/audio-lines';
	import CreditCard from '@lucide/svelte/icons/credit-card';
	import Users from '@lucide/svelte/icons/users';
	import MonitorSmartphone from '@lucide/svelte/icons/monitor-smartphone';
	import Waypoints from '@lucide/svelte/icons/waypoints';
	import Package from '@lucide/svelte/icons/package';
	import SlidersHorizontal from '@lucide/svelte/icons/sliders-horizontal';
	import ChartColumn from '@lucide/svelte/icons/chart-column';
	import ScrollText from '@lucide/svelte/icons/scroll-text';
	import ChevronsUpDown from '@lucide/svelte/icons/chevrons-up-down';
	import UserRound from '@lucide/svelte/icons/user-round';
	import SunMoon from '@lucide/svelte/icons/sun-moon';
	import LogOut from '@lucide/svelte/icons/log-out';

	let { viewer, badges }: { viewer: { name: string; displayName: string; githubLogin: string }; badges: { waiting: number } } = $props();
	const waiting = $derived(badges.waiting);
	let logout = $state<HTMLFormElement>();

	const groups = $derived([
		{ label: null, items: [{ href: '/', label: '概览', icon: LayoutDashboard }] },
		{
			label: 'AI 管理',
			items: [
				{ href: '/ai/vendors', label: '厂商与模型', icon: Boxes },
				{ href: '/ai/keys', label: 'API Key', icon: KeyRound },
				{ href: '/ai/subscriptions', label: '订阅与账号', icon: CreditCard },
				{ href: '/ai/voice', label: '语音', icon: AudioLines },
			],
		},
		{
			label: '团队',
			items: [
				{ href: '/members', label: '成员', icon: Users, badge: waiting > 0 ? String(waiting) : null },
				{ href: '/devices', label: '设备', icon: MonitorSmartphone },
				{ href: '/plugins', label: '插件', icon: Package },
			],
		},
		{
			label: '开发',
			items: [
				{ href: '/tunnels', label: '内网穿透', icon: Waypoints },
				{ href: '/settings', label: '系统配置', icon: SlidersHorizontal },
			],
		},
		{
			label: '记录',
			items: [
				{ href: '/usage', label: '用量', icon: ChartColumn },
				{ href: '/audit', label: '审计', icon: ScrollText },
			],
		},
	]);

	const active = (href: string) => (href === '/' ? page.url.pathname === '/' : page.url.pathname.startsWith(href));
</script>

<Sidebar.Root collapsible="icon">
	<Sidebar.Header>
		<Sidebar.Menu>
			<Sidebar.MenuItem>
				<Sidebar.MenuButton size="lg">
					{#snippet child({ props })}
						<a href="/" {...props}>
							<img src="/logo.svg" alt="" class="size-8 shrink-0" />
							<div class="grid flex-1 text-left leading-tight">
								<span class="truncate font-semibold">GL Work</span>
								<span class="text-muted-foreground truncate text-xs">管理后台</span>
							</div>
						</a>
					{/snippet}
				</Sidebar.MenuButton>
			</Sidebar.MenuItem>
		</Sidebar.Menu>
	</Sidebar.Header>
	<Sidebar.Content>
		{#each groups as group (group.label)}
			<Sidebar.Group>
				{#if group.label}<Sidebar.GroupLabel>{group.label}</Sidebar.GroupLabel>{/if}
				<Sidebar.GroupContent>
					<Sidebar.Menu>
						{#each group.items as item (item.href)}
							<Sidebar.MenuItem>
								<Sidebar.MenuButton isActive={active(item.href)} tooltipContent={item.label}>
									{#snippet child({ props })}
										<a href={item.href} {...props}>
											<item.icon />
											<span>{item.label}</span>
										</a>
									{/snippet}
								</Sidebar.MenuButton>
								{#if 'badge' in item && item.badge}<Sidebar.MenuBadge>{item.badge}</Sidebar.MenuBadge>{/if}
							</Sidebar.MenuItem>
						{/each}
					</Sidebar.Menu>
				</Sidebar.GroupContent>
			</Sidebar.Group>
		{/each}
	</Sidebar.Content>
	<Sidebar.Footer>
		<Sidebar.Menu>
			<Sidebar.MenuItem>
				<DropdownMenu.Root>
					<DropdownMenu.Trigger>
						{#snippet child({ props })}
							<Sidebar.MenuButton size="lg" {...props}>
								<Avatar.Root class="size-8 rounded-lg">
									<Avatar.Fallback class="rounded-lg bg-primary/10 text-primary">{viewer.displayName.slice(0, 1)}</Avatar.Fallback>
								</Avatar.Root>
								<div class="grid flex-1 text-left text-sm leading-tight">
									<span class="truncate font-medium">{viewer.displayName}</span>
									<span class="text-muted-foreground truncate text-xs">@{viewer.githubLogin} · 管理员</span>
								</div>
								<ChevronsUpDown class="ml-auto size-4" />
							</Sidebar.MenuButton>
						{/snippet}
					</DropdownMenu.Trigger>
					<DropdownMenu.Content side="top" align="start" class="w-56">
						<DropdownMenu.Item>
							{#snippet child({ props })}<a href="/me" {...props}><UserRound />我的工作台</a>{/snippet}
						</DropdownMenu.Item>
						<DropdownMenu.Item onclick={toggleMode}><SunMoon />切换深浅色</DropdownMenu.Item>
						<DropdownMenu.Separator />
						<DropdownMenu.Item variant="destructive" onclick={() => logout?.requestSubmit()}><LogOut />退出登录</DropdownMenu.Item>
					</DropdownMenu.Content>
				</DropdownMenu.Root>
			</Sidebar.MenuItem>
		</Sidebar.Menu>
	</Sidebar.Footer>
	<Sidebar.Rail />
</Sidebar.Root>
<form bind:this={logout} method="POST" action="/logout" hidden></form>
