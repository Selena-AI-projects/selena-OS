import { IconCheck, IconLock, IconPhotoUp, IconPlayerPause, IconX } from "@tabler/icons-react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { Badge } from "@workspace/ui/components/badge";
import { Button } from "@workspace/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@workspace/ui/components/card";
import { Input } from "@workspace/ui/components/input";
import { Label } from "@workspace/ui/components/label";
import { Textarea } from "@workspace/ui/components/textarea";
import { type FormEvent, useState, useTransition } from "react";
import { CONTENT_PRODUCT_NAME } from "@/lib/content-product";
import { decideEditorialFn, getContentReviewFn } from "@/server/content-review";

export const Route = createFileRoute("/_authed/app/$brand/control-room/editorial")({
	loader: ({ params }) => getContentReviewFn({ data: { brandId: params.brand } }),
	head: () => ({ meta: [{ title: `Editorial review · ${CONTENT_PRODUCT_NAME}` }] }),
	component: EditorialReviewPage,
});

const SCAN_BADGES: Record<string, string> = {
	CLEAN: "border-emerald-300 bg-emerald-50 text-emerald-800",
	QUARANTINED: "border-amber-300 bg-amber-50 text-amber-800",
	SCANNING: "border-amber-300 bg-amber-50 text-amber-800",
	REJECTED: "border-red-300 bg-red-50 text-red-800",
};

function EditorialReviewPage() {
	const { brand: brandId } = Route.useParams();
	const { canDecide, items } = Route.useLoaderData();
	const router = useRouter();
	const [pending, startTransition] = useTransition();
	const [reasons, setReasons] = useState<Record<string, string>>({});
	const [notice, setNotice] = useState<{ kind: "success" | "error"; message: string } | null>(null);

	function run(action: () => Promise<unknown>, success: string) {
		startTransition(async () => {
			try {
				await action();
				await router.invalidate();
				setNotice({ kind: "success", message: success });
			} catch (error) {
				setNotice({
					kind: "error",
					message: error instanceof Error ? error.message : "The request could not be completed",
				});
			}
		});
	}

	function decide(contentVersionId: string, decision: "APPROVED" | "CHANGES_REQUESTED" | "REJECTED") {
		const reason = reasons[contentVersionId]?.trim();
		if (decision !== "APPROVED" && !reason) {
			setNotice({ kind: "error", message: "Requesting changes or rejecting requires a reason." });
			return;
		}
		run(
			() =>
				decideEditorialFn({
					data: { brandId, contentVersionId, decision, reason: decision === "APPROVED" ? undefined : reason },
				}),
			decision === "APPROVED" ? "Version approved editorially" : "Decision recorded",
		);
	}

	function uploadThumbnail(event: FormEvent<HTMLFormElement>, contentVersionId: string) {
		event.preventDefault();
		const form = event.currentTarget;
		const formData = new FormData(form);
		formData.set("brandId", brandId);
		formData.set("contentVersionId", contentVersionId);
		run(async () => {
			const response = await fetch("/api/v1/selena/control-room/assets", {
				method: "POST",
				body: formData,
				credentials: "include",
			});
			if (!response.ok) {
				const body = (await response.json().catch(() => null)) as { error?: string } | null;
				throw new Error(body?.error ?? `Upload failed with status ${response.status}`);
			}
			form.reset();
		}, "Thumbnail uploaded. It stays quarantined until the scanner marks it CLEAN.");
	}

	return (
		<div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
			<div>
				<h1 className="text-2xl font-semibold tracking-normal">Editorial review</h1>
				<p className="mt-1 max-w-2xl text-sm text-muted-foreground">
					A human decision about the latest version of each draft. Approval binds the exact content, profile, evidence
					and asset hashes — and grants no publishing authority.
				</p>
			</div>

			{notice && (
				<p
					aria-live="polite"
					className={
						notice.kind === "error"
							? "rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
							: "rounded-md border bg-muted px-3 py-2 text-sm text-foreground"
					}
					role={notice.kind === "error" ? "alert" : "status"}
				>
					{notice.message}
				</p>
			)}

			{items.length === 0 && (
				<Card className="rounded-md border-dashed shadow-none">
					<CardContent className="pt-6 text-sm text-muted-foreground">
						Nothing to review yet. Select an idea and draft a script first — the draft appears here.
					</CardContent>
				</Card>
			)}

			{items.map((item) => (
				<Card className="rounded-md shadow-none" key={item.id}>
					<CardHeader>
						<CardTitle className="flex flex-wrap items-center gap-2">
							{item.title}
							<Badge variant="outline">v{item.latestVersion.version}</Badge>
							<Badge variant="outline">{item.workflowStage}</Badge>
						</CardTitle>
						<CardDescription>
							<span className="font-mono">{item.latestVersion.contentHash.slice(0, 12)}…</span> ·{" "}
							{item.latestVersion.formatVersion}
						</CardDescription>
					</CardHeader>
					<CardContent className="space-y-4">
						<div className="space-y-2">
							<p className="text-sm font-medium">Thumbnail assets</p>
							{item.assets.length === 0 && (
								<p className="text-xs text-muted-foreground">
									No assets attached. A version can be approved without a thumbnail; a dirty one can never ride along.
								</p>
							)}
							{item.assets.map((asset) => (
								<div className="flex flex-wrap items-center gap-2 text-xs" key={asset.id}>
									<Badge className={SCAN_BADGES[asset.scanStatus] ?? ""} variant="outline">
										{asset.scanStatus}
									</Badge>
									<span>{asset.originalFilename}</span>
									<span className="font-mono text-muted-foreground">{asset.sha256.slice(0, 12)}…</span>
								</div>
							))}
							<form
								className="grid gap-3 rounded-md border p-3 md:grid-cols-3"
								onSubmit={(event) => uploadThumbnail(event, item.latestVersion.id)}
							>
								<div className="space-y-2">
									<Label htmlFor={`asset-file-${item.id}`}>Image (jpeg/png/webp, ≤10 MB)</Label>
									<Input className="min-h-11" id={`asset-file-${item.id}`} name="file" type="file" required />
								</div>
								<div className="space-y-2">
									<Label htmlFor={`asset-rights-${item.id}`}>Rights valid until</Label>
									<Input
										className="min-h-11"
										id={`asset-rights-${item.id}`}
										name="rightsExpiresAt"
										type="date"
										required
									/>
								</div>
								<div className="space-y-2">
									<Label htmlFor={`asset-consent-${item.id}`}>Consent valid until</Label>
									<Input
										className="min-h-11"
										id={`asset-consent-${item.id}`}
										name="consentExpiresAt"
										type="date"
										required
									/>
								</div>
								<div className="md:col-span-3">
									<Button className="min-h-11" disabled={pending} type="submit" variant="outline">
										<IconPhotoUp aria-hidden="true" /> Upload thumbnail
									</Button>
								</div>
							</form>
						</div>

						<div className="space-y-2 border-t pt-4">
							<Label htmlFor={`reason-${item.latestVersion.id}`}>Reason (required unless approving)</Label>
							<Textarea
								id={`reason-${item.latestVersion.id}`}
								onChange={(event) =>
									setReasons((current) => ({ ...current, [item.latestVersion.id]: event.target.value }))
								}
								placeholder="What must change, or why this is rejected"
								value={reasons[item.latestVersion.id] ?? ""}
							/>
							<div className="flex flex-wrap gap-2">
								{canDecide && (
									<Button
										className="min-h-11"
										disabled={pending}
										onClick={() => decide(item.latestVersion.id, "APPROVED")}
										type="button"
									>
										<IconCheck aria-hidden="true" /> Approve as owner
									</Button>
								)}
								<Button
									className="min-h-11"
									disabled={pending}
									onClick={() => decide(item.latestVersion.id, "CHANGES_REQUESTED")}
									type="button"
									variant="outline"
								>
									<IconPlayerPause aria-hidden="true" /> Request changes
								</Button>
								<Button
									className="min-h-11"
									disabled={pending}
									onClick={() => decide(item.latestVersion.id, "REJECTED")}
									type="button"
									variant="outline"
								>
									<IconX aria-hidden="true" /> Reject
								</Button>
							</div>
							{!canDecide && (
								<p className="text-xs text-muted-foreground">
									<IconLock aria-hidden="true" className="mr-1 inline size-3" />
									Approving requires an interactive owner session. Members can request changes or reject with a reason.
								</p>
							)}
						</div>

						{item.decisions.length > 0 && (
							<div className="space-y-1 border-t pt-4">
								<p className="text-sm font-medium">Decision history (append-only)</p>
								{item.decisions.map((decision) => (
									<p className="text-xs text-muted-foreground" key={decision.id}>
										{decision.decision}
										{decision.reason ? ` — ${decision.reason}` : ""} · {decision.decidedBy} ·{" "}
										{new Date(decision.createdAt).toLocaleString()}
									</p>
								))}
							</div>
						)}

						<p className="text-xs text-muted-foreground">
							Editorial approval is not a release approval: publishing stays unavailable until Stage 3.
						</p>
					</CardContent>
				</Card>
			))}
		</div>
	);
}
