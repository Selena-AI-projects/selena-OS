import { IconAlertTriangle, IconPhoto, IconShieldCheck, IconUpload } from "@tabler/icons-react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { Badge } from "@workspace/ui/components/badge";
import { Button } from "@workspace/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@workspace/ui/components/card";
import { Input } from "@workspace/ui/components/input";
import { Label } from "@workspace/ui/components/label";
import { useState, useTransition } from "react";
import { CONTENT_PRODUCT_NAME } from "@/lib/content-product";
import { getContentThumbnailsFn } from "@/server/content-thumbnails";

export const Route = createFileRoute("/_authed/app/$brand/control-room/thumbnails")({
	loader: ({ params }) => getContentThumbnailsFn({ data: { brandId: params.brand } }),
	head: () => ({ meta: [{ title: `Thumbnails · ${CONTENT_PRODUCT_NAME}` }] }),
	component: ThumbnailsPage,
});

const SCAN_LABELS: Record<string, string> = {
	QUARANTINED: "Waiting to be scanned",
	SCANNING: "Being scanned",
	CLEAN: "Scanned clean",
	REJECTED: "Refused by the scanner",
};

const BLOCKER_LABELS: Record<string, string> = {
	NO_PROFILE_LINEAGE: "This version does not name the profile it was written against",
	EVIDENCE_REQUIRED: "The brand's policy requires evidence and this version carries none",
	ASSET_NOT_CLEAN: "An image on this version has not been scanned clean",
	ASSET_OUT_OF_VERSION: "An image belongs to a different version",
	ASSET_RIGHTS_EXPIRED: "The rights recorded for an image have run out",
	ASSET_CONSENT_EXPIRED: "The consent recorded for an image has run out",
};

function formatMoment(value: string): string {
	return new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function inOneYear(): string {
	const date = new Date();
	date.setFullYear(date.getFullYear() + 1);
	return date.toISOString().slice(0, 10);
}

function ThumbnailsPage() {
	const { brand: brandId } = Route.useParams();
	const { drafts, canAttach } = Route.useLoaderData();
	const router = useRouter();
	const [pending, startTransition] = useTransition();
	const [notice, setNotice] = useState<{ kind: "success" | "error"; message: string } | null>(null);

	function attach(versionId: string, form: HTMLFormElement) {
		const body = new FormData(form);
		body.set("brandId", brandId);
		body.set("contentVersionId", versionId);
		startTransition(async () => {
			try {
				const response = await fetch("/api/v1/selena/control-room/thumbnails", { method: "POST", body });
				const result = (await response.json()) as { code?: string; error?: string };
				if (!response.ok) {
					// BLOCKED_STORAGE is the one answer that means nothing was saved. The
					// page says so in those words rather than leaving a reader to guess
					// whether a retry would duplicate the image.
					setNotice({
						kind: "error",
						message:
							result.code === "BLOCKED_STORAGE"
								? "The image was not saved. Private storage or the scanner is unavailable, so nothing was written — try again once it is back."
								: (result.error ?? "The image could not be attached"),
					});
					return;
				}
				form.reset();
				await router.invalidate();
				setNotice({
					kind: "success",
					message: "Image stored privately and queued for scanning. It joins the review bundle once it is scanned clean.",
				});
			} catch {
				setNotice({ kind: "error", message: "The image could not be attached" });
			}
		});
	}

	return (
		<div className="flex flex-col gap-6 p-4 md:p-6">
			<header className="flex flex-col gap-2">
				<h1 className="font-serif text-2xl">Thumbnails</h1>
				<p className="max-w-2xl text-muted-foreground text-sm">
					Images are stored privately and scanned before anyone reviews them. Only an image scanned clean, still inside
					its recorded rights and consent, joins the bundle a reviewer decides on.
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

			{drafts.length === 0 ? (
				<Card>
					<CardHeader>
						<CardTitle>Write a script first</CardTitle>
						<CardDescription>A thumbnail is attached to a content version, and a version starts with a script.</CardDescription>
					</CardHeader>
					<CardContent>
						<Button asChild className="min-h-11" variant="outline">
							<a href={`/app/${brandId}/control-room/scripts`}>Go to Scripts</a>
						</Button>
					</CardContent>
				</Card>
			) : (
				drafts.map((draft) => (
					<Card key={draft.versionId}>
						<CardHeader>
							<CardTitle className="flex flex-wrap items-center gap-2 text-base">
								<IconPhoto aria-hidden="true" className="size-4 shrink-0" />
								<span className="break-words">{draft.title}</span>
							</CardTitle>
							<CardDescription className="flex flex-wrap items-center gap-2">
								<Badge variant="outline">v{draft.version}</Badge>
								<span className="font-mono text-xs">{draft.binding.contentHash.slice(0, 12)}…</span>
								<Badge variant="outline">
									{draft.assets.length === 1 ? "1 image" : `${draft.assets.length} images`}
								</Badge>
							</CardDescription>
						</CardHeader>
						<CardContent className="flex flex-col gap-4 text-sm">
							{draft.blockers.length > 0 && (
								<div className="flex flex-col gap-1 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900">
									<p className="flex items-center gap-2 font-medium">
										<IconAlertTriangle aria-hidden="true" className="size-4" /> Not ready for review
									</p>
									{draft.blockers.map((blocker) => (
										<p key={blocker}>{BLOCKER_LABELS[blocker] ?? blocker}</p>
									))}
								</div>
							)}

							{draft.assets.length === 0 ? (
								<p className="text-muted-foreground">No image is attached to this version yet.</p>
							) : (
								<ul className="flex flex-col gap-2">
									{draft.assets.map((asset) => (
										<li key={asset.id} className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2">
											<Badge variant={asset.scanStatus === "CLEAN" ? "default" : "outline"}>
												{SCAN_LABELS[asset.scanStatus] ?? asset.scanStatus}
											</Badge>
											{/* Rights and consent questions differ by who produced the image,
											    and only one of the two has a person who can answer them. */}
											<Badge variant="outline">{asset.origin === "GENERATED" ? "Generated" : "Uploaded"}</Badge>
											<span className="font-mono text-muted-foreground text-xs">{asset.sha256.slice(0, 12)}…</span>
											<span className="text-muted-foreground text-xs">{asset.mimeType}</span>
											<span className="text-muted-foreground text-xs">
												{asset.rightsExpiresAt ? `rights to ${formatMoment(asset.rightsExpiresAt)}` : "no rights limit recorded"}
											</span>
											<span className="text-muted-foreground text-xs">
												{asset.consentExpiresAt
													? `consent to ${formatMoment(asset.consentExpiresAt)}`
													: "no consent limit recorded"}
											</span>
										</li>
									))}
								</ul>
							)}

							<div className="flex flex-col gap-1">
								<p className="flex items-center gap-2 font-medium">
									<IconShieldCheck aria-hidden="true" className="size-4" /> Review bundle
								</p>
								<p className="break-all font-mono text-muted-foreground text-xs">{draft.binding.assetBundleHash}</p>
								<p className="text-muted-foreground text-xs">
									{draft.bundleMembers.length === 0
										? "No scanned-clean image is in the bundle yet."
										: `${draft.bundleMembers.length} scanned-clean ${draft.bundleMembers.length === 1 ? "image" : "images"} in the bundle.`}
								</p>
							</div>

							{canAttach && (
								<form
									className="flex flex-col gap-3 rounded-md border p-3"
									onSubmit={(event) => {
										event.preventDefault();
										attach(draft.versionId, event.currentTarget);
									}}
								>
									<div className="flex flex-col gap-1">
										<Label htmlFor={`file-${draft.versionId}`}>Image</Label>
										<Input
											id={`file-${draft.versionId}`}
											name="file"
											type="file"
											required
											accept="image/jpeg,image/png,image/webp"
										/>
									</div>
									<div className="flex flex-col gap-1">
										<Label htmlFor={`origin-${draft.versionId}`}>Where it came from</Label>
										<select
											id={`origin-${draft.versionId}`}
											name="origin"
											defaultValue="UPLOADED"
											className="min-h-11 rounded-md border bg-transparent px-3 text-sm"
										>
											<option value="UPLOADED">A person supplied it</option>
											<option value="GENERATED">A generator produced it</option>
										</select>
									</div>
									<div className="flex flex-col gap-1">
										<Label htmlFor={`rights-${draft.versionId}`}>Rights recorded until</Label>
										<Input
											id={`rights-${draft.versionId}`}
											name="rightsExpiresAt"
											type="date"
											required
											defaultValue={inOneYear()}
										/>
									</div>
									<div className="flex flex-col gap-1">
										<Label htmlFor={`consent-${draft.versionId}`}>Consent recorded until</Label>
										<Input
											id={`consent-${draft.versionId}`}
											name="consentExpiresAt"
											type="date"
											required
											defaultValue={inOneYear()}
										/>
									</div>
									<div>
										<Button className="min-h-11" type="submit" disabled={pending}>
											<IconUpload aria-hidden="true" /> Attach image
										</Button>
									</div>
								</form>
							)}
						</CardContent>
					</Card>
				))
			)}
		</div>
	);
}
