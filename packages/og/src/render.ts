import { DEFAULT_APP_NAME, ELMO_BRAND_COLOR } from "@workspace/config/constants";
import { createElement } from "react";

export const ACCENT_COLORS = ["#8f5c34", "#b9825b", "#181614", "#e6ddd1"];
export const DEFAULT_TAGLINE = "Evidence for AI visibility";
export const DEFAULT_DESCRIPTION = "Measure how AI systems represent your brand and turn evidence into an action plan.";

export interface OgImageOptions {
	appName: string;
	title?: string;
	description?: string;
	accentColors?: string[];
	iconDataUri?: string;
}

export function renderOgImage({ appName, title, description, accentColors, iconDataUri }: OgImageOptions) {
	const isDefaultBrand = appName === DEFAULT_APP_NAME;
	const brandColor = isDefaultBrand ? ELMO_BRAND_COLOR : (accentColors?.[0] ?? "#1e293b");
	const desc = description || DEFAULT_DESCRIPTION;
	const watermarkColor = isDefaultBrand ? "rgba(143,92,52,0.08)" : "rgba(0,0,0,0.03)";
	const gradientColors = isDefaultBrand
		? ACCENT_COLORS
		: accentColors && accentColors.length >= 2
			? accentColors.slice(0, 4)
			: [brandColor, brandColor];

	return createElement(
		"div",
		{
			style: {
				display: "flex",
				width: "100%",
				height: "100%",
				position: "relative",
				overflow: "hidden",
				backgroundColor: isDefaultBrand ? "#f7f2ea" : "#ffffff",
			},
		},
		isDefaultBrand
			? createElement(
					"div",
					{
						style: {
							position: "absolute",
							fontFamily: "Geist Sans",
							fontSize: 520,
							fontWeight: 500,
							color: watermarkColor,
							lineHeight: 1,
							right: -60,
							top: -60,
						},
					},
					"S",
				)
			: null,
		createElement(
			"div",
			{
				style: {
					display: "flex",
					flexDirection: "column",
					justifyContent: "center",
					height: "100%",
					paddingLeft: 80,
					paddingRight: 80,
				},
			},
			isDefaultBrand
				? createElement(
						"div",
						{
							style: {
								fontFamily: "Geist Sans",
								fontSize: 84,
								fontWeight: 500,
								color: ELMO_BRAND_COLOR,
								lineHeight: 1,
								marginBottom: 40,
							},
						},
						DEFAULT_APP_NAME,
					)
				: iconDataUri
					? createElement("img", {
							src: iconDataUri,
							width: 120,
							height: 120,
							style: { marginBottom: 28, objectFit: "contain" },
						})
					: null,
			createElement(
				"div",
				{
					style: {
						fontFamily: "Geist Sans",
						fontSize: 80,
						fontWeight: 500,
						color: isDefaultBrand ? "#181614" : "#1e293b",
						lineHeight: 1.2,
						marginBottom: 28,
					},
				},
				isDefaultBrand ? title || DEFAULT_TAGLINE : appName,
			),
			createElement(
				"div",
				{
					style: {
						fontFamily: "Geist Sans",
						fontSize: 44,
						color: isDefaultBrand ? "#6e6258" : "#64748b",
						textWrap: "balance",
					},
				},
				desc,
			),
		),
		createElement("div", {
			style: {
				display: "flex",
				position: "absolute",
				bottom: 0,
				left: 0,
				width: "100%",
				height: 6,
				backgroundImage: `linear-gradient(to right, ${gradientColors.join(", ")})`,
			},
		}),
	);
}
