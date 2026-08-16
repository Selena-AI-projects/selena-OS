import { useRouteContext } from "@tanstack/react-router";
import { DEFAULT_APP_ICON, DEFAULT_APP_NAME } from "@workspace/config/constants";
import type { ClientConfig } from "@workspace/config/types";
import { cn } from "@workspace/ui/lib/utils";
import type { ComponentPropsWithoutRef } from "react";
import { SelenaWordmark } from "@/components/selena-wordmark";

interface LogoProps extends ComponentPropsWithoutRef<"div"> {
	iconClassName?: string;
	textClassName?: string;
}

export function Logo({ className, iconClassName, textClassName, ...props }: LogoProps) {
	const context = useRouteContext({ strict: false }) as { clientConfig?: ClientConfig };
	const branding = context.clientConfig?.branding;

	if (
		!branding?.icon ||
		!branding?.name ||
		(branding.icon === DEFAULT_APP_ICON && branding.name === DEFAULT_APP_NAME)
	) {
		return (
			<div {...props} className={cn("flex items-center gap-2", className)}>
				<SelenaWordmark className={textClassName} />
			</div>
		);
	}

	return (
		<div {...props} className={cn("flex items-center gap-2", className)}>
			{branding?.icon && (
				<img
					src={branding.icon}
					alt={`${branding.name} logo`}
					className={cn("size-5", iconClassName)}
					fetchPriority="low"
				/>
			)}
			<span className={cn("text-base font-semibold", textClassName)}>{branding?.name}</span>
		</div>
	);
}
