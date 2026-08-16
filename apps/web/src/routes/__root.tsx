/// <reference types="vite/client" />

import { TanStackDevtools } from "@tanstack/react-devtools";
import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, HeadContent, Outlet, ScriptOnce, Scripts } from "@tanstack/react-router";
import { DEFAULT_APP_ICON, DEFAULT_APP_NAME } from "@workspace/config/constants";
import type { MissingEnvVar } from "@workspace/config/env";
import type { DeploymentMode } from "@workspace/config/types";
import { useEffect } from "react";
import MissingEnvPage from "@/components/missing-env-page";
import queryDevtools from "@/integrations/tanstack-query/devtools";
import { initPostHog } from "@/lib/posthog";
import { NotFound } from "@/router-default-components";
import { getClientConfig, getEnvValidationStateFn, type PublicClientConfig } from "@/server/config";
import appCss from "../styles.css?url";

interface RouterContext {
	queryClient: QueryClient;
	clientConfig: PublicClientConfig;
	envValidation: {
		mode: DeploymentMode;
		missing: MissingEnvVar[];
		isValid: boolean;
	};
}

// Client-side cache for config data — avoids HTTP round-trips on every SPA navigation.
// Server-side (SSR) always fetches fresh (cachedRootData is reset per request).
let cachedRootData: {
	clientConfig: PublicClientConfig;
	envValidation: { mode: DeploymentMode; missing: MissingEnvVar[]; isValid: boolean };
} | null = typeof window === "undefined" ? null : null;

export const Route = createRootRouteWithContext<RouterContext>()({
	notFoundComponent: NotFound,
	beforeLoad: async () => {
		if (cachedRootData) return cachedRootData;
		const [clientConfig, envValidation] = await Promise.all([getClientConfig(), getEnvValidationStateFn()]);
		cachedRootData = { clientConfig, envValidation };
		return cachedRootData;
	},
	head: ({ match }) => {
		const branding = match.context?.clientConfig?.branding;
		const analytics = match.context?.clientConfig?.analytics;
		const scripts = [];
		if (analytics?.clarityProjectId) {
			scripts.push({
				src: `https://www.clarity.ms/tag/${analytics.clarityProjectId}`,
				async: true,
			});
		}
		if (analytics?.plausibleDomain) {
			scripts.push({
				src: "/api/plausible/js/script",
				defer: true,
				"data-domain": analytics.plausibleDomain,
				"data-api": "/api/plausible/event",
			});
		}

		const hasCustomIcon = Boolean(branding?.icon && branding.icon !== DEFAULT_APP_ICON);
		const appName = branding?.name || DEFAULT_APP_NAME;
		const themeColor = hasCustomIcon ? "#000000" : "#181614";
		const appUrl = branding?.url ? branding.url.replace(/\/$/, "") : undefined;

		const title = `${appName} — AI Visibility`;
		const description = "Measure how AI systems represent your brand and turn evidence into a practical action plan.";
		// Don't pass `title` to /api/og — the renderer already shows the brand,
		// so a "Brand - AI Visibility" title
		// title would render redundantly. Pages that override og:image can supply
		// a page-specific title via the query param.
		const ogImageParams = new URLSearchParams({ description });
		const ogImagePath = `/api/og?${ogImageParams.toString()}`;
		const ogImage = appUrl ? `${appUrl}${ogImagePath}` : ogImagePath;
		// og:logo is non-standard but used by some unfurlers (LinkedIn). Falls back
		// to the absolute branding icon URL when available.
		const ogLogo = (() => {
			if (!branding?.icon) return undefined;
			if (branding.icon.startsWith("http")) return branding.icon;
			return appUrl ? `${appUrl}${branding.icon}` : undefined;
		})();

		return {
			meta: [
				{ title },
				{ name: "description", content: description },
				{ charSet: "utf-8" },
				{ name: "viewport", content: "width=device-width, initial-scale=1" },
				{ name: "theme-color", content: themeColor },
				{ name: "apple-mobile-web-app-title", content: appName },
				{ property: "og:site_name", content: appName },
				{ property: "og:locale", content: "en_US" },
				{ property: "og:title", content: title },
				{ property: "og:description", content: description },
				{ property: "og:image", content: ogImage },
				{ property: "og:image:width", content: "1200" },
				{ property: "og:image:height", content: "630" },
				{ property: "og:type", content: "website" },
				...(appUrl ? [{ property: "og:url", content: appUrl }] : []),
				...(ogLogo ? [{ property: "og:logo", content: ogLogo }] : []),
				{ name: "twitter:card", content: "summary_large_image" },
				{ name: "twitter:title", content: title },
				{ name: "twitter:description", content: description },
				{ name: "twitter:image", content: ogImage },
			],
			links: [
				{ rel: "stylesheet", href: appCss },
				{ rel: "manifest", href: "/api/manifest" },
				// Whitelabel uses its own icon URL for both favicon and iOS touch;
				// the Selena default uses the committed SVG mark.
				...(hasCustomIcon && branding?.icon
					? [
							{ rel: "icon", type: "image/png", href: branding.icon },
							{ rel: "apple-touch-icon", href: branding.icon },
						]
					: [
							// Icons live under /icons/ so the default and whitelabel
							// branches stay isolated.
							{ rel: "icon", type: "image/svg+xml", href: "/icons/selena-icon.svg" },
							{ rel: "apple-touch-icon", href: "/icons/selena-icon.svg" },
						]),
			],
			scripts,
		};
	},
	component: RootComponent,
});

function RootComponent() {
	const { envValidation, clientConfig } = Route.useRouteContext();
	const clarityProjectId = clientConfig?.analytics?.clarityProjectId;

	useEffect(() => {
		const key = clientConfig?.analytics?.posthogKey;
		if (key) initPostHog(key);
	}, [clientConfig?.analytics?.posthogKey]);

	const clarityQueueScript = `window.clarity=window.clarity||function(){(window.clarity.q=window.clarity.q||[]).push(arguments)};`;

	if (!envValidation.isValid) {
		return (
			<html lang="en">
				<head>
					<HeadContent />
				</head>
				<body className="font-sans antialiased">
					<MissingEnvPage mode={envValidation.mode} missing={envValidation.missing} />
					<Scripts />
				</body>
			</html>
		);
	}

	return (
		<html lang="en">
			<head>
				{clarityProjectId && <ScriptOnce>{clarityQueueScript}</ScriptOnce>}
				<HeadContent />
			</head>
			<body className="font-sans antialiased">
				<Outlet />
				<TanStackDevtools plugins={[queryDevtools]} />
				<Scripts />
			</body>
		</html>
	);
}
