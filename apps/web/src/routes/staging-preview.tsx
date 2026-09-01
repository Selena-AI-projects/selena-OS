import {
	IconAlertTriangle,
	IconChartBar,
	IconCheck,
	IconClipboardCheck,
	IconFileText,
	IconInbox,
	IconLink,
	IconListDetails,
	IconRocket,
	IconSearch,
	IconShieldCheck,
	IconSitemap,
	IconSpeakerphone,
	IconTarget,
	IconTimeline,
} from "@tabler/icons-react";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { Button } from "@workspace/ui/components/button";
import { type ReactNode, useState } from "react";
import { SelenaWordmark } from "@/components/selena-wordmark";
import { CONTENT_PRODUCT_NAME } from "@/lib/content-product";
import { getSelenaStagingPreviewStateFn } from "@/server/selena-staging-preview";

export const Route = createFileRoute("/staging-preview")({
	loader: async () => {
		const state = await getSelenaStagingPreviewStateFn();
		if (!state.enabled) throw redirect({ to: "/auth/login" });
		return state;
	},
	component: SelenaStagingPreview,
});

type Product = "visibility" | "control";

const visibilityItems = [
	{ label: "Overview", icon: IconChartBar },
	{ label: "Visibility", icon: IconSearch },
	{ label: "Share of Voice", icon: IconSpeakerphone },
	{ label: "Query Fan-Out", icon: IconSitemap },
	{ label: "Citations", icon: IconLink },
	{ label: "Opportunities", icon: IconTarget },
];

const controlItems = [
	{ label: "Inbox", icon: IconInbox },
	{ label: "Content", icon: IconFileText },
	{ label: "Review", icon: IconShieldCheck },
	{ label: "Releases", icon: IconTimeline },
	{ label: "Publications", icon: IconSpeakerphone },
	{ label: "Performance", icon: IconChartBar },
	{ label: "Incidents", icon: IconAlertTriangle },
	{ label: "Audit", icon: IconListDetails },
];

function SelenaStagingPreview() {
	const [product, setProduct] = useState<Product>("control");
	const [activeItem, setActiveItem] = useState("Inbox");
	const navItems = product === "control" ? controlItems : visibilityItems;

	const chooseProduct = (next: Product) => {
		setProduct(next);
		setActiveItem(next === "control" ? "Inbox" : "Overview");
	};

	return (
		<main className="min-h-screen bg-[#f7f5f1] text-[#181614]">
			<header className="border-b border-[#dfdbd2] bg-[#fbfaf7]">
				<div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
					<SelenaWordmark className="h-7 w-auto shrink-0" />
					<div className="flex items-center gap-2 text-sm text-[#6f695f]">
						<span className="size-2 rounded-full bg-[#bd7c4a]" aria-hidden="true" />
						<span>Staging preview</span>
					</div>
				</div>
			</header>

			<div className="mx-auto grid min-h-[calc(100vh-57px)] max-w-7xl lg:grid-cols-[232px_minmax(0,1fr)]">
				<aside className="border-b border-[#dfdbd2] bg-[#fbfaf7] p-4 lg:border-r lg:border-b-0">
					<fieldset className="mb-6 grid grid-cols-2 gap-1 rounded-md border border-[#dfdbd2] bg-[#f0ede7] p-1">
						<legend className="sr-only">Product</legend>
						<ProductButton active={product === "visibility"} onClick={() => chooseProduct("visibility")}>
							AI Visibility
						</ProductButton>
						<ProductButton active={product === "control"} onClick={() => chooseProduct("control")}>
							{CONTENT_PRODUCT_NAME}
						</ProductButton>
					</fieldset>

					<nav aria-label={product === "control" ? `${CONTENT_PRODUCT_NAME} navigation` : "AI Visibility navigation"}>
						<p className="mb-2 px-2 text-xs font-medium uppercase text-[#6f695f]">
							{product === "control" ? CONTENT_PRODUCT_NAME : "AI Visibility"}
						</p>
						<div className="space-y-1">
							{navItems.map(({ label, icon: Icon }) => (
								<button
									key={label}
									type="button"
									onClick={() => setActiveItem(label)}
									className={`flex min-h-11 w-full items-center gap-3 rounded-md px-3 text-left text-sm transition-colors ${
										activeItem === label ? "bg-[#181614] text-[#fbfaf7]" : "text-[#514b43] hover:bg-[#f0ede7]"
									}`}
								>
									<Icon className="size-4 shrink-0" />
									<span className="min-w-0 truncate">{label}</span>
								</button>
							))}
						</div>
					</nav>
				</aside>

				<section className="min-w-0 px-4 py-7 sm:px-6 lg:px-10">
					<div className="mb-8 flex flex-wrap items-start justify-between gap-4 border-b border-[#dfdbd2] pb-6">
						<div>
							<p className="mb-1 text-sm text-[#6f695f]">
								{product === "control" ? CONTENT_PRODUCT_NAME : "Selena Systems"}
							</p>
							<h1 className="text-2xl font-semibold">{activeItem}</h1>
						</div>
						<Button variant="outline" disabled title="Preview mode does not create or change data">
							<IconClipboardCheck className="size-4" />
							Changes disabled
						</Button>
					</div>

					{product === "control" ? (
						<ControlRoomPreview activeItem={activeItem} />
					) : (
						<VisibilityPreview activeItem={activeItem} />
					)}

					<div className="mt-10 border-t border-[#dfdbd2] pt-5 text-sm text-[#6f695f]">
						Preview data only. Nothing here is saved, approved, queued, or published.{" "}
						<Link to="/auth/login" className="font-medium text-[#181614] underline underline-offset-4">
							Sign in to work with real data
						</Link>
					</div>
				</section>
			</div>
		</main>
	);
}

function ProductButton({ active, children, onClick }: { active: boolean; children: ReactNode; onClick: () => void }) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-pressed={active}
			className={`min-h-9 rounded px-2 text-xs font-medium ${active ? "bg-[#fbfaf7] text-[#181614] shadow-sm" : "text-[#6f695f]"}`}
		>
			{children}
		</button>
	);
}

function ControlRoomPreview({ activeItem }: { activeItem: string }) {
	if (activeItem === "Inbox") {
		return (
			<PreviewTable
				headings={["Material", "Channel", "Scheduled", "Status"]}
				rows={[
					["Responsible AI visibility", "LinkedIn Page", "Not scheduled", "Ready for review"],
					["August visibility report", "LinkedIn Page", "Not scheduled", "Draft"],
				]}
			/>
		);
	}

	if (activeItem === "Review") {
		return (
			<PreviewNotice
				icon={IconShieldCheck}
				title="One material is ready for review"
				detail="Approval is disabled in preview mode."
			/>
		);
	}

	if (activeItem === "Releases" || activeItem === "Publications") {
		return (
			<PreviewNotice
				icon={IconRocket}
				title="No publication activity"
				detail="Preview mode never creates release intents or external calls."
			/>
		);
	}

	return (
		<PreviewNotice icon={IconFileText} title={`${activeItem} preview`} detail="This view uses fixture data only." />
	);
}

function VisibilityPreview({ activeItem }: { activeItem: string }) {
	if (activeItem === "Overview") {
		return (
			<div className="grid gap-px overflow-hidden border border-[#dfdbd2] bg-[#dfdbd2] sm:grid-cols-3">
				<Metric label="Tracked prompts" value="12" />
				<Metric label="Mention rate" value="Preview" />
				<Metric label="Latest capture" value="Not run" />
			</div>
		);
	}

	return (
		<PreviewNotice
			icon={IconChartBar}
			title={`${activeItem} preview`}
			detail="Measurement results are not fetched in a public preview."
		/>
	);
}

function PreviewTable({ headings, rows }: { headings: string[]; rows: string[][] }) {
	return (
		<div className="overflow-x-auto border border-[#dfdbd2] bg-[#fbfaf7]">
			<table className="w-full min-w-[41.25rem] text-left text-sm">
				<thead className="border-b border-[#dfdbd2] bg-[#f0ede7] text-[#6f695f]">
					<tr>
						{headings.map((heading) => (
							<th key={heading} className="px-4 py-3 font-medium">
								{heading}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{rows.map((row) => (
						<tr key={row[0]} className="border-b border-[#dfdbd2] last:border-b-0">
							{headings.map((heading, index) => {
								const cell = row[index] ?? "";
								return (
									<td key={heading} className="px-4 py-4 text-[#514b43]">
										{index === row.length - 1 ? <Status>{cell}</Status> : cell}
									</td>
								);
							})}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

function PreviewNotice({ icon: Icon, title, detail }: { icon: typeof IconFileText; title: string; detail: string }) {
	return (
		<div className="border-y border-[#dfdbd2] py-10">
			<Icon className="mb-4 size-6 text-[#bd7c4a]" />
			<h2 className="text-lg font-semibold">{title}</h2>
			<p className="mt-2 max-w-xl text-sm leading-6 text-[#6f695f]">{detail}</p>
		</div>
	);
}

function Metric({ label, value }: { label: string; value: string }) {
	return (
		<div className="bg-[#fbfaf7] px-5 py-6">
			<p className="text-sm text-[#6f695f]">{label}</p>
			<p className="mt-2 text-xl font-semibold">{value}</p>
		</div>
	);
}

function Status({ children }: { children: ReactNode }) {
	return (
		<span className="inline-flex items-center gap-1.5 text-[#514b43]">
			<IconCheck className="size-4 text-[#4d7c62]" />
			{children}
		</span>
	);
}
