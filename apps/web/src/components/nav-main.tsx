import type { Icon } from "@tabler/icons-react";

import {
	SidebarGroup,
	SidebarGroupLabel,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	useSidebar,
} from "@workspace/ui/components/sidebar";
import { Link, useLocation, useParams } from "@tanstack/react-router";

export interface NavItem {
	title: string;
	url: string;
	icon?: Icon;
	absolute?: boolean;
	hash?: string;
}

export interface NavGroup {
	label: string;
	items: NavItem[];
}

export function NavMain({ groups }: { groups: NavGroup[] }) {
	const params = useParams({ strict: false }) as { brand?: string };
	const brandId = params.brand;
	const { setOpenMobile } = useSidebar();
	const location = useLocation();
	const pathname = location.pathname;

	const getHref = (url: string, absolute?: boolean) => {
		return absolute ? url : `/app/${brandId}${url}`;
	};

	const isActive = (url: string, absolute?: boolean, hash?: string) => {
		const href = getHref(url, absolute);
		if (hash) {
			return pathname === href && (location.hash === `#${hash}` || (hash === "inbox" && !location.hash));
		}
		if (href === `/app/${brandId}` || href === `/app/${brandId}/`) {
			return pathname === `/app/${brandId}` || pathname === `/app/${brandId}/`;
		}
		return pathname.startsWith(href);
	};

	return (
		<>
			{groups.map((group) => (
				<SidebarGroup key={group.label}>
					<SidebarGroupLabel>{group.label}</SidebarGroupLabel>
					<SidebarMenu>
						{group.items.map((item) => (
							<SidebarMenuItem key={item.title}>
								<SidebarMenuButton
									asChild
									tooltip={item.title}
									isActive={isActive(item.url, item.absolute, item.hash)}
								>
									<Link to={getHref(item.url, item.absolute)} hash={item.hash} onClick={() => setOpenMobile(false)}>
										{item.icon && <item.icon />}
										<span>{item.title}</span>
									</Link>
								</SidebarMenuButton>
							</SidebarMenuItem>
						))}
					</SidebarMenu>
				</SidebarGroup>
			))}
		</>
	);
}
