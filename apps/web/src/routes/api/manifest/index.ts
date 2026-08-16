/**
 * /api/manifest - Dynamic Web App Manifest
 *
 * Generates a manifest.json tailored to the current deployment mode:
 *   - Whitelabel: single 128×128 icon from the configured icon URL
 *   - Local/Demo (Selena): static SVG icon committed to public/icons/
 *
 * Branding values (name, theme color, etc.) are read from server config
 * so they stay in sync with the rest of the app.
 */
import { createFileRoute } from "@tanstack/react-router";
import { DEFAULT_APP_ICON, ELMO_BACKGROUND_COLOR, ELMO_THEME_COLOR } from "@workspace/config/constants";
import { getDeployment } from "@/lib/config/server";

interface ManifestIcon {
	src: string;
	sizes: string;
	type: string;
	purpose?: string;
}

function buildManifest(): object {
	const deployment = getDeployment();
	const { branding } = deployment;
	const hasCustomIcon = branding.icon !== DEFAULT_APP_ICON;

	let icons: ManifestIcon[];

	if (hasCustomIcon) {
		icons = [
			{
				src: branding.icon,
				sizes: "128x128",
				type: "image/png",
			},
		];
	} else {
		// Selena-only asset — never reference it from the whitelabel branch.
		icons = [
			{
				src: "/icons/selena-icon.svg",
				sizes: "any",
				type: "image/svg+xml",
			},
			{
				src: "/icons/selena-icon.svg",
				sizes: "any",
				type: "image/svg+xml",
				purpose: "maskable",
			},
		];
	}

	const themeColor = hasCustomIcon ? "#000000" : ELMO_THEME_COLOR;

	return {
		short_name: branding.name,
		name: `${branding.name} — AI Visibility`,
		icons,
		start_url: "/app/selena",
		scope: "/app/",
		display: "standalone",
		theme_color: themeColor,
		background_color: ELMO_BACKGROUND_COLOR,
	};
}

export const Route = createFileRoute("/api/manifest/")({
	server: {
		handlers: {
			GET: () => {
				const manifest = buildManifest();
				return new Response(JSON.stringify(manifest, null, 2), {
					headers: {
						"Content-Type": "application/manifest+json",
						"Cache-Control": "public, max-age=3600",
					},
				});
			},
		},
	},
});
