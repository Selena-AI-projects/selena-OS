import {
	IconAlertTriangle,
	IconBuilding,
	IconBuildings,
	IconChartBar,
	IconChevronDown,
	IconCpu,
	IconCreditCard,
	IconDashboard,
	IconFileText,
	IconKey,
	IconLink,
	IconListDetails,
	IconPlugConnected,
	IconReport,
	IconShieldCheck,
	IconSitemap,
	IconSpeakerphone,
	IconTable,
	IconTarget,
	IconTimeline,
	IconTool,
	IconUsers,
} from "@tabler/icons-react";
import { Link, useLocation, useParams, useRouteContext } from "@tanstack/react-router";
import type { ClientConfig } from "@workspace/config/types";
import type { BrandWithPrompts } from "@workspace/lib/db/schema";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu";
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	useSidebar,
} from "@workspace/ui/components/sidebar";
import type * as React from "react";
import { DemoModePill } from "@/components/demo-mode-pill";
import { Logo } from "@/components/logo";
import { NavAppInfo } from "@/components/nav-app-info";
import { type NavGroup, NavMain } from "@/components/nav-main";
import { NavUser } from "@/components/nav-user";
import { CONTENT_PRODUCT_NAME } from "@/lib/content-product";
import { rememberSelenaProduct } from "@/lib/selena-product-entry";

/**
 * How much of the app the shell around this page can reach:
 *  - "brand":   a brand's own pages, plus admin for those who have it
 *  - "admin":   the admin section only (there is no brand in scope)
 *  - "account": nothing — the page is a gate the user has to clear first, so the
 *               only things worth offering are who they are and how to leave
 */
export type SidebarScope = "brand" | "admin" | "account";

interface AppSidebarProps extends React.ComponentProps<typeof Sidebar> {
	isAdmin?: boolean;
	hasReportAccess?: boolean;
	scope?: SidebarScope;
	/** Brand data from route loader — avoids a separate client-side fetch */
	brand?: BrandWithPrompts | null;
}

function ProductSwitcher() {
	const { brand } = useParams({ strict: false }) as { brand?: string };
	const { pathname } = useLocation();
	const { setOpenMobile } = useSidebar();
	const inControlRoom = pathname.includes("/control-room");
	const activeProduct = inControlRoom ? CONTENT_PRODUCT_NAME : "AI Visibility";

	if (!brand) return null;

	return (
		<SidebarMenu>
			<SidebarMenuItem>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<SidebarMenuButton size="lg" tooltip="Switch product">
							{inControlRoom ? <IconShieldCheck /> : <IconChartBar />}
							<span>{activeProduct}</span>
							<IconChevronDown className="ml-auto size-4" />
						</SidebarMenuButton>
					</DropdownMenuTrigger>
					<DropdownMenuContent
						className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
						side="right"
						align="start"
						sideOffset={8}
					>
						<DropdownMenuLabel>Products</DropdownMenuLabel>
						<DropdownMenuSeparator />
						<DropdownMenuGroup>
							<DropdownMenuItem asChild className="cursor-pointer">
								<Link
									to="/app/$brand"
									params={{ brand }}
									onClick={() => {
										if (brand === "selena") rememberSelenaProduct("ai-visibility");
										setOpenMobile(false);
									}}
								>
									<IconChartBar />
									AI Visibility
								</Link>
							</DropdownMenuItem>
							<DropdownMenuItem asChild className="cursor-pointer">
								<Link
									to="/app/$brand/control-room"
									params={{ brand }}
									onClick={() => {
										if (brand === "selena") rememberSelenaProduct("content-control");
										setOpenMobile(false);
									}}
								>
									<IconShieldCheck />
									{CONTENT_PRODUCT_NAME}
								</Link>
							</DropdownMenuItem>
						</DropdownMenuGroup>
					</DropdownMenuContent>
				</DropdownMenu>
			</SidebarMenuItem>
		</SidebarMenu>
	);
}

export function AppSidebar({
	isAdmin = false,
	hasReportAccess = false,
	scope = "brand",
	brand: _brand,
	...props
}: AppSidebarProps) {
	const { setOpenMobile } = useSidebar();
	const { pathname } = useLocation();
	const context = useRouteContext({ strict: false }) as { clientConfig?: ClientConfig };
	const isControlRoom = scope === "brand" && pathname.includes("/control-room");
	// Reports are disabled entirely in cloud; hide the nav entry there.
	const reportsEnabled = context.clientConfig?.features.reportGeneration ?? true;

	// A gate page offers no destinations: every link would either 404 or bounce
	// the user straight back to the gate.
	const showAdminSection = scope !== "account" && (isAdmin || (hasReportAccess && reportsEnabled));

	const groups: NavGroup[] = [];

	// Dashboard section - only show if we have a brand context
	if (scope === "brand" && isControlRoom) {
		groups.push({
			label: CONTENT_PRODUCT_NAME,
			items: [
				{ title: "Inbox", url: "/control-room", icon: IconListDetails, hash: "inbox" },
				{ title: "Content", url: "/control-room", icon: IconFileText, hash: "content" },
				{ title: "Review", url: "/control-room", icon: IconShieldCheck, hash: "review" },
				{ title: "Releases", url: "/control-room", icon: IconTimeline, hash: "releases" },
				{ title: "Publications", url: "/control-room", icon: IconSpeakerphone, hash: "publications" },
				{ title: "Performance", url: "/control-room", icon: IconChartBar, hash: "performance" },
				{ title: "Incidents", url: "/control-room", icon: IconAlertTriangle, hash: "incidents" },
				{ title: "Audit", url: "/control-room", icon: IconListDetails, hash: "audit" },
				...(context.clientConfig?.growthEngineStage1Enabled
					? [{ title: "Sources", url: "/control-room", icon: IconPlugConnected, hash: "sources" }]
					: []),
			],
		});
	} else if (scope === "brand") {
		const dashboardItems = [
			{
				title: "Overview",
				url: "/",
				icon: IconDashboard,
			},
			{
				title: "Visibility",
				url: "/visibility",
				icon: IconChartBar,
			},
			{
				title: "Share of Voice",
				url: "/share-of-voice",
				icon: IconSpeakerphone,
			},
			{
				title: "Query Fan-Out",
				url: "/query-fan-out",
				icon: IconSitemap,
			},
			{
				title: "Citations",
				url: "/citations",
				icon: IconLink,
			},
			{
				title: "Opportunities",
				url: "/opportunities",
				icon: IconTarget,
			},
		];

		groups.push({
			label: "AI Visibility",
			items: dashboardItems,
		});

		groups.push({
			label: "Settings",
			items: [
				{
					title: "Brand",
					url: "/settings/brand",
					icon: IconBuilding,
				},
				{
					title: "Competitors",
					url: "/settings/competitors",
					icon: IconBuildings,
				},
				{
					title: "Prompts",
					url: "/settings/prompts",
					icon: IconListDetails,
				},
				{
					title: "LLMs",
					url: "/settings/llms",
					icon: IconCpu,
				},
				...(context.clientConfig?.features.teamInvites
					? [{ title: "Team", url: "/settings/members", icon: IconUsers }]
					: []),
				...(context.clientConfig?.features.billing
					? [{ title: "Billing", url: "/settings/billing", icon: IconCreditCard }]
					: []),
			],
		});
	}

	// Admin section
	if (showAdminSection && !isControlRoom) {
		const reportsItem = {
			title: "Reports",
			url: "/reports",
			icon: IconReport,
			absolute: true,
		};
		const adminItems = isAdmin
			? [
					{
						title: "Brands",
						url: "/admin",
						icon: IconTable,
						absolute: true,
					},
					...(reportsEnabled ? [reportsItem] : []),
					{
						title: "Workflows",
						url: "/admin/workflows",
						icon: IconTimeline,
						absolute: true,
					},
					{
						title: "Tools",
						url: "/admin/tools",
						icon: IconTool,
						absolute: true,
					},
					{
						title: "Providers",
						url: "/admin/providers",
						icon: IconKey,
						absolute: true,
					},
				]
			: [reportsItem];

		groups.push({
			label: "Admin",
			items: adminItems,
		});
	}

	const brandmark = (
		<>
			<Logo iconClassName="!size-5" />
			<div className="ml-auto group-data-[collapsible=icon]:hidden">
				<DemoModePill />
			</div>
		</>
	);

	return (
		<Sidebar variant="inset" {...props}>
			<SidebarHeader>
				<SidebarMenu>
					<SidebarMenuItem>
						{/* On a gate page the mark still says whose product this is, but it
						    leads nowhere — /app would redirect right back here. */}
						{scope === "account" ? (
							<div className="flex items-center gap-2 p-2">{brandmark}</div>
						) : (
							<SidebarMenuButton size="lg" asChild>
								<Link to="/app" onClick={() => setOpenMobile(false)}>
									{brandmark}
								</Link>
							</SidebarMenuButton>
						)}
					</SidebarMenuItem>
				</SidebarMenu>
				{scope === "brand" && <ProductSwitcher />}
			</SidebarHeader>
			<SidebarContent>
				<NavMain groups={groups} />
			</SidebarContent>
			<SidebarFooter>
				<NavUser canSwitchBrand={scope !== "account"} />
				<NavAppInfo />
			</SidebarFooter>
		</Sidebar>
	);
}
