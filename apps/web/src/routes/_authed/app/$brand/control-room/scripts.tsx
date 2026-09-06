import { IconFileText, IconHistory, IconWriting } from "@tabler/icons-react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { Badge } from "@workspace/ui/components/badge";
import { Button } from "@workspace/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@workspace/ui/components/card";
import { useRef, useState, useTransition } from "react";
import { CONTENT_PRODUCT_NAME } from "@/lib/content-product";
import { generateContentScriptFn, getContentCreationFn } from "@/server/content-creation";

export const Route = createFileRoute("/_authed/app/$brand/control-room/scripts")({
	loader: ({ params }) => getContentCreationFn({ data: { brandId: params.brand } }),
	head: () => ({ meta: [{ title: `Scripts · ${CONTENT_PRODUCT_NAME}` }] }),
	component: ScriptsPage,
});

const STAGE_LABELS: Record<string, string> = {
	DRAFT: "Draft",
	IDEA_SELECTED: "Idea selected",
	SCRIPT_DRAFTED: "Script drafted",
	IN_REVIEW: "In review",
	APPROVED: "Approved",
	ARCHIVED: "Archived",
};

function formatMoment(value: string): string {
	return new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function ScriptsPage() {
	const { brand: brandId } = Route.useParams();
	const { items, versionsByItem, canDecide } = Route.useLoaderData();
	const router = useRouter();
	const [pending, startTransition] = useTransition();
	const [notice, setNotice] = useState<{ kind: "success" | "error"; message: string } | null>(null);
	const scriptKey = useRef(crypto.randomUUID());

	function act(action: () => Promise<unknown>, success: string) {
		startTransition(async () => {
			try {
				await action();
				await router.invalidate();
				scriptKey.current = crypto.randomUUID();
				setNotice({ kind: "success", message: success });
			} catch (error) {
				setNotice({
					kind: "error",
					message: error instanceof Error ? error.message : "The request could not be completed",
				});
			}
		});
	}

	return (
		<div className="flex flex-col gap-6 p-4 md:p-6">
			<header className="flex flex-col gap-2">
				<h1 className="font-serif text-2xl">Scripts</h1>
				<p className="max-w-2xl text-muted-foreground text-sm">
					Every revision is a new version, never an edit of the one before it. Each version records the profile, the
					research run and the generation it came from, so a reader can always tell where a line came from.
				</p>
			</header>

			{notice && (
				<p
					role="status"
					className={`rounded-md border px-3 py-2 text-sm ${
						notice.kind === "success"
							? "border-emerald-200 bg-emerald-50 text-emerald-900"
							: "border-red-200 bg-red-50 text-red-900"
					}`}
				>
					{notice.message}
				</p>
			)}

			{items.length === 0 ? (
				<Card>
					<CardHeader>
						<CardTitle>Select an idea first</CardTitle>
						<CardDescription>A script is written for a draft, and a draft starts from a selected idea.</CardDescription>
					</CardHeader>
					<CardContent>
						<Button asChild className="min-h-11" variant="outline">
							<a href={`/app/${brandId}/control-room/ideas`}>Go to Ideas</a>
						</Button>
					</CardContent>
				</Card>
			) : (
				items.map((item) => {
					const versions = versionsByItem[item.id] ?? [];
					const latest = versions[0];
					const document = latest?.structuredBody;
					return (
						<Card key={item.id}>
							<CardHeader>
								<CardTitle className="flex flex-wrap items-center gap-2 text-base">
									<IconFileText aria-hidden="true" className="size-4 shrink-0" />
									<span className="break-words">{item.title}</span>
								</CardTitle>
								<CardDescription className="flex flex-wrap items-center gap-2">
									<Badge variant="outline">{STAGE_LABELS[item.workflowStage] ?? item.workflowStage}</Badge>
									<Badge variant="outline">{versions.length === 1 ? "1 version" : `${versions.length} versions`}</Badge>
								</CardDescription>
							</CardHeader>
							<CardContent className="flex flex-col gap-4 text-sm">
								{document?.script ? (
									<div className="flex flex-col gap-3">
										<p className="break-words font-medium">{document.script.hook}</p>
										{document.script.sections.map((section) => (
											<div key={section.heading} className="flex flex-col gap-1">
												<p className="font-medium">{section.heading}</p>
												<p className="break-words text-muted-foreground">{section.purpose}</p>
												{section.evidenceClaimIds.length > 0 && (
													<p className="break-words text-muted-foreground text-xs">
														Cites {section.evidenceClaimIds.length}{" "}
														{section.evidenceClaimIds.length === 1 ? "evidence claim" : "evidence claims"}
													</p>
												)}
											</div>
										))}
										<div className="flex flex-col gap-1">
											<p className="font-medium">Payoff</p>
											<p className="break-words text-muted-foreground">{document.script.payoff}</p>
										</div>
										<div className="flex flex-col gap-1">
											<p className="font-medium">How this gets checked</p>
											<p className="break-words text-muted-foreground">{document.script.studioValidation}</p>
										</div>
									</div>
								) : (
									<p className="text-muted-foreground">This draft has a concept and its evidence, but no script yet.</p>
								)}

								{canDecide && (
									<div>
										<Button
											className="min-h-11"
											type="button"
											variant={document?.script ? "outline" : "default"}
											disabled={pending}
											onClick={() =>
												act(
													() =>
														generateContentScriptFn({
															data: {
																brandId,
																contentId: item.id,
																idempotencyKey: scriptKey.current,
																revision: Boolean(document?.script),
															},
														}),
													document?.script ? "New revision saved as a version" : "Script drafted",
												)
											}
										>
											<IconWriting aria-hidden="true" />{" "}
											{document?.script ? "Write a new revision" : "Draft the script"}
										</Button>
									</div>
								)}

								<div className="flex flex-col gap-2">
									<p className="flex items-center gap-2 font-medium">
										<IconHistory aria-hidden="true" className="size-4" /> Version history
									</p>
									{versions.map((entry) => (
										<div key={entry.id} className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
											<Badge variant="outline">v{entry.version}</Badge>
											<span className="font-mono">{entry.contentHash.slice(0, 12)}…</span>
											<span>{entry.hashVersion}</span>
											<span>{formatMoment(entry.createdAt)}</span>
											{/* Fixture output and a human revision are different things, and a
											    reader deciding whether to trust a line needs to know which. */}
											<span>{entry.generationRunId ? "generated" : "written by hand"}</span>
										</div>
									))}
								</div>
							</CardContent>
						</Card>
					);
				})
			)}
		</div>
	);
}
