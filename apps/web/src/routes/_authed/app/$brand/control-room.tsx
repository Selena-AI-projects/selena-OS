import { type FormEvent, useEffect, useState, useTransition } from "react";
import { createFileRoute, useLocation, useRouter } from "@tanstack/react-router";
import { IconAlertTriangle, IconFileText, IconLockCheck, IconPlus, IconRefresh } from "@tabler/icons-react";
import { Badge } from "@workspace/ui/components/badge";
import { Button } from "@workspace/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@workspace/ui/components/card";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@workspace/ui/components/dialog";
import { Input } from "@workspace/ui/components/input";
import { Label } from "@workspace/ui/components/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@workspace/ui/components/table";
import { Textarea } from "@workspace/ui/components/textarea";
import { buildTitle, getAppName, getBrandName } from "@/lib/route-head";
import {
	approveContentVersionFn,
	createContentVersionFn,
	createControlRoomContentFn,
	getControlRoomWorkspaceFn,
	queueReleaseIntentFn,
	revokeApprovalFn,
	setReleaseKillSwitchFn,
} from "@/server/selena-control-room";

export const Route = createFileRoute("/_authed/app/$brand/control-room")({
	loader: ({ params }) => getControlRoomWorkspaceFn({ data: { brandId: params.brand } }),
	head: ({ matches, match }) => {
		const appName = getAppName(match);
		const brandName = getBrandName(matches);
		return {
			meta: [
				{ title: buildTitle("Content Control", { appName, brandName }) },
				{ name: "description", content: "Human-approved content release control plane." },
			],
		};
	},
	errorComponent: ({ error, reset }) => <ControlRoomLoadError error={error} reset={reset} />,
	component: ControlRoomPage,
});

const CONTROL_ROOM_SECTIONS = [
	"inbox",
	"content",
	"review",
	"releases",
	"publications",
	"performance",
	"incidents",
	"audit",
] as const;

type ControlRoomSection = (typeof CONTROL_ROOM_SECTIONS)[number];

function isControlRoomSection(value: string): value is ControlRoomSection {
	return CONTROL_ROOM_SECTIONS.some((section) => section === value);
}

function sectionFromHash(hash: string): ControlRoomSection {
	const section = hash.replace(/^#/, "");
	return isControlRoomSection(section) ? section : "inbox";
}

function ControlRoomLoadError({ error, reset }: { error: unknown; reset: () => void }) {
	const message = error instanceof Error ? error.message : "";
	const correlationId = message.match(/Reference:\s*([0-9a-f-]{36})/i)?.[1] ?? "unavailable";

	return (
		<div className="mx-auto flex min-h-[40vh] w-full max-w-xl items-center">
			<Card className="w-full rounded-md shadow-none">
				<CardHeader>
					<div className="flex items-center gap-2 text-destructive">
						<IconAlertTriangle aria-hidden="true" />
						<CardTitle className="text-base">Control Room is temporarily unavailable</CardTitle>
					</div>
				</CardHeader>
				<CardContent className="space-y-4 text-sm text-muted-foreground">
					<p>
						No content was changed or released. Retry the request; if it continues, provide this reference to support.
					</p>
					<p className="font-mono text-xs text-foreground">Reference: {correlationId}</p>
					<Button onClick={reset} type="button">
						<IconRefresh />
						Retry
					</Button>
				</CardContent>
			</Card>
		</div>
	);
}

function formatDate(value: Date | string | null | undefined): string {
	if (!value) return "-";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return "-";
	return date.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });
}

function StatusBadge({ value }: { value: string | null }) {
	if (!value) return <Badge variant="outline">Pending</Badge>;
	const label = (
		{
			APPROVED: "Approved",
			BLOCKED: "Stopped",
			COMPLETE: "Complete",
			CONFIRMED: "Confirmed",
			DRY_RUN: "Test only",
			FAILED: "Needs attention",
			OPEN: "Open",
			PENDING: "Waiting safely",
			QUARANTINED: "Needs attention",
			QUEUED: "Queued",
			READY: "Ready",
			RECONCILE_REQUIRED: "Needs review",
			REJECTED: "Not approved",
			REVOKED: "Revoked",
		} as Record<string, string>
	)[value] ?? value.replaceAll("_", " ");
	const tone =
		value === "APPROVED" || value === "READY" || value === "CONFIRMED" || value === "COMPLETE"
			? "border-emerald-300 bg-emerald-50 text-emerald-800"
			: value === "REJECTED" || value === "REVOKED" || value === "FAILED" || value === "BLOCKED"
				? "border-rose-300 bg-rose-50 text-rose-800"
				: value === "QUARANTINED" || value === "RECONCILE_REQUIRED" || value === "OPEN"
					? "border-amber-300 bg-amber-50 text-amber-800"
					: "border-border bg-muted text-muted-foreground";
	return (
		<Badge variant="outline" className={tone}>
			{label}
		</Badge>
	);
}

function displayChannel(account: { platform: string; providerAccountRef: string }): string {
	if (account.platform === "linkedin_page_dry_run") return "LinkedIn test — nothing will be published";
	if (account.platform === "linkedin_page") return account.providerAccountRef || "LinkedIn Page";
	return account.providerAccountRef || account.platform.replaceAll("_", " ");
}

function displayAuditAction(action: string): string {
	const labels: Record<string, string> = {
		"approval.granted": "Material approved",
		"approval.revoked": "Approval revoked",
		"staging.demo_content_created": "Test material created",
		"staging.linkedin_dry_run_prepared": "LinkedIn test prepared",
		"content.version_created": "Material updated",
		"release.intent_queued": "Release queued",
		"release.kill_switch_enabled": "Publishing stopped",
	};
	return labels[action] ?? "Control Room activity";
}

function EmptyRows({ columns, label }: { columns: number; label: string }) {
	return (
		<TableRow>
			<TableCell colSpan={columns} className="h-28 text-center text-muted-foreground">
				{label}
			</TableCell>
		</TableRow>
	);
}

function ControlRoomPage() {
	const { brand: brandId } = Route.useParams();
	const data = Route.useLoaderData();
	const router = useRouter();
	const { hash } = useLocation();
	const activeSection = sectionFromHash(hash);
	const [pending, startTransition] = useTransition();
	const [notice, setNotice] = useState<string | null>(null);
	const [contentTitle, setContentTitle] = useState("");
	const [contentBody, setContentBody] = useState("");
	const [contentCta, setContentCta] = useState("");
	const contentPolicy = "selena-brand-pack/v1";
	const [approvalVersionId, setApprovalVersionId] = useState("");
	const [approvalAccountId, setApprovalAccountId] = useState("");
	const [approvalExpiry, setApprovalExpiry] = useState("");
	const [releaseApprovalId, setReleaseApprovalId] = useState("");
	const [revisionContentId, setRevisionContentId] = useState("");
	const [revisionBody, setRevisionBody] = useState("");
	const [revisionCta, setRevisionCta] = useState("");
	const revisionPolicy = "selena-brand-pack/v1";
	const [stopBrandOpen, setStopBrandOpen] = useState(false);
	const [stopBrandConfirmation, setStopBrandConfirmation] = useState("");
	const contentById = new Map(data.content.map((item) => [item.id, item]));
	const versionById = new Map(data.versions.map((item) => [item.id, item]));
	const accountById = new Map(data.accounts.map((item) => [item.id, item]));
	const manifestById = new Map(data.manifests.map((item) => [item.id, item]));
	const materialName = (versionId: string) =>
		contentById.get(versionById.get(versionId)?.contentId ?? "")?.title ?? "Material";
	const channelName = (accountId: string) => {
		const account = accountById.get(accountId);
		return account ? displayChannel(account) : "Channel unavailable";
	};

	useEffect(() => {
		setApprovalVersionId((value) => value || data.versions[0]?.id || "");
		setRevisionContentId((value) => value || data.content[0]?.id || "");
		setApprovalAccountId((value) => value || data.accounts[0]?.id || "");
		setReleaseApprovalId(
			(value) => value || data.approvals.find((approval) => approval.decision === "APPROVED")?.id || "",
		);
	}, [data.accounts, data.approvals, data.content, data.versions]);

	function run(action: () => Promise<unknown>, successMessage: string) {
		startTransition(async () => {
			try {
				await action();
				await router.invalidate();
				setNotice(successMessage);
			} catch {
				setNotice("The request could not be completed. Retry the action; no content was released.");
			}
		});
	}

	function submitContent(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		run(
			() =>
				createControlRoomContentFn({
					data: {
						brandId,
						title: contentTitle,
						body: contentBody,
						ctaUrl: contentCta,
						policyVersion: contentPolicy,
					},
				}),
			"Material created",
		);
	}

	function submitRevision(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		run(
			() =>
				createContentVersionFn({
					data: {
						brandId,
						contentId: revisionContentId,
						body: revisionBody,
						ctaUrl: revisionCta,
						policyVersion: revisionPolicy,
					},
				}),
			"New material version saved",
		);
	}

	function submitApproval(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		run(
			() =>
				approveContentVersionFn({
					data: {
						brandId,
						contentVersionId: approvalVersionId,
						channelAccountId: approvalAccountId,
						expiresAt: new Date(approvalExpiry).toISOString(),
					},
				}),
			"Human approval recorded",
		);
	}

	function submitReleaseIntent(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		run(
			() => queueReleaseIntentFn({ data: { brandId, approvalId: releaseApprovalId } }),
			"Release intent queued for future durable dispatch",
		);
	}

	return (
		<div className="mx-auto flex w-full max-w-[1440px] flex-col gap-5">
			<div className="flex flex-wrap items-end justify-between gap-3">
				<div>
					<p className="text-xs font-medium tracking-[0.14em] text-muted-foreground uppercase">Selena OS</p>
					<h1 className="mt-1 text-2xl font-semibold tracking-normal">Content Control</h1>
				</div>
				<div className="flex items-center gap-2">
					{data.killSwitches.length > 0 && <StatusBadge value="BLOCKED" />}
					<Badge variant="outline">{data.role}</Badge>
					<Button
						variant="outline"
						size="icon"
						title="Refresh Control Room"
						onClick={() => run(() => router.invalidate(), "Control Room refreshed")}
					>
						<IconRefresh />
					</Button>
				</div>
			</div>

			{notice && <p className="border-l-2 border-primary bg-muted/40 px-3 py-2 text-sm">{notice}</p>}

			<div className="space-y-5">

				{activeSection === "inbox" && (
					<Card className="rounded-md shadow-none">
						<CardHeader>
							<CardTitle className="text-base">Review queue</CardTitle>
						</CardHeader>
						<CardContent>
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>Content</TableHead>
										<TableHead>Version</TableHead>
										<TableHead>Asset</TableHead>
										<TableHead>Decision</TableHead>
										<TableHead>Created</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{data.reviewQueue.length === 0 ? (
										<EmptyRows columns={5} label="No content versions" />
									) : (
										data.reviewQueue.map((item) => (
											<TableRow key={item.id}>
												<TableCell className="font-medium">{item.title}</TableCell>
												<TableCell>v{item.version}</TableCell>
												<TableCell>{item.assetCount}</TableCell>
												<TableCell>
													<StatusBadge value={item.latestDecision} />
												</TableCell>
												<TableCell>{formatDate(item.createdAt)}</TableCell>
											</TableRow>
										))
									)}
								</TableBody>
							</Table>
						</CardContent>
					</Card>
				)}

				{activeSection === "content" && <div className="space-y-5">
					<div className="grid gap-5 xl:grid-cols-2">
						<Card className="rounded-md shadow-none">
							<CardHeader>
								<CardTitle className="text-base">New content</CardTitle>
							</CardHeader>
							<CardContent>
								<form className="grid gap-3" onSubmit={submitContent}>
									<Label className="grid gap-2">
										Material name
										<Input
											required
											placeholder="For example, September company update"
											value={contentTitle}
											onChange={(event) => setContentTitle(event.target.value)}
										/>
									</Label>
									<Label className="grid gap-2">
										Post copy
										<Textarea
											required
											placeholder="Write the material for LinkedIn"
											value={contentBody}
											onChange={(event) => setContentBody(event.target.value)}
										/>
									</Label>
									<Label className="grid gap-2">
										Link people will open
										<Input
											required
											type="url"
											placeholder="https://example.com"
											value={contentCta}
											onChange={(event) => setContentCta(event.target.value)}
										/>
									</Label>
									<Button disabled={pending} type="submit">
										<IconPlus />
										Create material
									</Button>
								</form>
							</CardContent>
						</Card>
						<Card className="rounded-md shadow-none">
							<CardHeader>
								<CardTitle className="text-base">New revision</CardTitle>
							</CardHeader>
							<CardContent>
								<form className="grid gap-3" onSubmit={submitRevision}>
									<Label className="grid gap-2">
										Material
									<select
										required
										className="border-input h-9 rounded-md border bg-transparent px-3 text-sm"
										value={revisionContentId}
										onChange={(event) => setRevisionContentId(event.target.value)}
									>
										<option value="" disabled>
											Select content
										</option>
										{data.content.map((item) => (
											<option value={item.id} key={item.id}>
												{item.title}
											</option>
										))}
									</select>
									</Label>
									<Label className="grid gap-2">
										Updated post copy
										<Textarea
											required
											placeholder="Write the revised material for LinkedIn"
											value={revisionBody}
											onChange={(event) => setRevisionBody(event.target.value)}
										/>
									</Label>
									<Label className="grid gap-2">
										Link people will open
										<Input
											required
											type="url"
											placeholder="https://example.com"
											value={revisionCta}
											onChange={(event) => setRevisionCta(event.target.value)}
										/>
									</Label>
									<Button disabled={pending} variant="outline" type="submit">
										<IconFileText />
										Save new version
									</Button>
								</form>
							</CardContent>
						</Card>
					</div>
					<div className="grid gap-5 xl:grid-cols-2">
						<Card className="rounded-md shadow-none">
							<CardHeader>
								<CardTitle className="text-base">LinkedIn</CardTitle>
							</CardHeader>
							<CardContent>
								<div className="flex flex-wrap items-center gap-2">
									<StatusBadge
										value={
											data.accounts.some((account) => account.platform === "linkedin_page_dry_run")
												? "READY"
												: "PENDING"
										}
									/>
									<Badge variant="outline">Nothing will be published</Badge>
								</div>
								<p className="mt-3 text-sm text-muted-foreground">
									This test checks the approval journey only. No LinkedIn account is connected and nothing can be published.
								</p>
							</CardContent>
						</Card>
						<Card className="rounded-md shadow-none">
							<CardHeader>
								<CardTitle className="text-base">Media</CardTitle>
							</CardHeader>
							<CardContent>
								<p className="text-sm text-muted-foreground">
									This test material is text-only. Media upload will become available after private storage and safety
									checks are connected.
								</p>
							</CardContent>
						</Card>
					</div>
					<Card className="rounded-md shadow-none">
						<CardHeader>
							<CardTitle className="text-base">Material history</CardTitle>
						</CardHeader>
						<CardContent>
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>Material</TableHead>
										<TableHead>Version</TableHead>
										<TableHead>Evidence valid until</TableHead>
										<TableHead>Created</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{data.versions.length === 0 ? (
										<EmptyRows columns={4} label="No material versions" />
									) : (
										data.versions.map((item) => (
											<TableRow key={item.id}>
												<TableCell className="font-medium">{materialName(item.id)}</TableCell>
												<TableCell>Version {item.version}</TableCell>
												<TableCell>{formatDate(item.evidenceExpiresAt)}</TableCell>
												<TableCell>{formatDate(item.createdAt)}</TableCell>
											</TableRow>
										))
									)}
								</TableBody>
							</Table>
						</CardContent>
					</Card>
				</div>}

				{activeSection === "review" && <div className="space-y-5">
					<Card className="rounded-md shadow-none">
						<CardHeader>
							<CardTitle className="text-base">Human approval</CardTitle>
						</CardHeader>
						<CardContent>
							<form className="grid gap-3 md:grid-cols-[1fr_1fr_1fr_auto]" onSubmit={submitApproval}>
								<select
									required
									className="border-input h-9 rounded-md border bg-transparent px-3 text-sm"
									value={approvalVersionId}
									onChange={(event) => setApprovalVersionId(event.target.value)}
								>
									<option value="" disabled>
										Content version
									</option>
									{data.versions.map((item) => (
										<option value={item.id} key={item.id}>
											{materialName(item.id)} · Version {item.version}
										</option>
									))}
								</select>
								<select
									required
									className="border-input h-9 rounded-md border bg-transparent px-3 text-sm"
									value={approvalAccountId}
									onChange={(event) => setApprovalAccountId(event.target.value)}
								>
									<option value="" disabled>
										LinkedIn account
									</option>
									{data.accounts.map((item) => (
										<option value={item.id} key={item.id}>
											{displayChannel(item)}
										</option>
									))}
								</select>
								<Input
									required
									type="datetime-local"
									value={approvalExpiry}
									onChange={(event) => setApprovalExpiry(event.target.value)}
								/>
								<Button disabled={pending} type="submit">
									<IconLockCheck />
									Approve
								</Button>
							</form>
						</CardContent>
					</Card>
					<Card className="rounded-md shadow-none">
						<CardHeader>
							<CardTitle className="text-base">Approval records</CardTitle>
						</CardHeader>
						<CardContent>
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>Material</TableHead>
										<TableHead>Channel</TableHead>
										<TableHead>Valid until</TableHead>
										<TableHead>Status</TableHead>
										<TableHead>Action</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{data.approvals.length === 0 ? (
										<EmptyRows columns={5} label="No approvals yet" />
									) : (
										data.approvals.map((item) => (
											<TableRow key={item.id}>
												<TableCell className="font-medium">{materialName(item.contentVersionId)}</TableCell>
												<TableCell>{channelName(item.channelAccountId)}</TableCell>
												<TableCell>{formatDate(item.expiresAt)}</TableCell>
												<TableCell>
													<StatusBadge value={item.decision} />
												</TableCell>
												<TableCell>
													{item.decision === "APPROVED" ? (
														<Button
															size="sm"
															variant="outline"
															disabled={pending}
															onClick={() =>
																run(
																	() =>
																		revokeApprovalFn({
																			data: { brandId, approvalId: item.id, reason: "Revoked from Control Room" },
																		}),
																	"Approval revoked",
																)
															}
														>
															Revoke
														</Button>
													) : (
														"-"
													)}
												</TableCell>
											</TableRow>
										))
									)}
								</TableBody>
							</Table>
						</CardContent>
					</Card>
				</div>}

				{activeSection === "releases" && <div className="space-y-5">
					<div className="grid gap-5 xl:grid-cols-[1fr_1fr_auto]">
						<Card className="rounded-md shadow-none">
							<CardHeader>
								<CardTitle className="text-base">Release queue</CardTitle>
							</CardHeader>
							<CardContent>
								<form className="flex flex-wrap gap-2" onSubmit={submitReleaseIntent}>
									<select
										required
										className="border-input h-9 min-w-0 flex-1 rounded-md border bg-transparent px-3 text-sm"
										value={releaseApprovalId}
										onChange={(event) => setReleaseApprovalId(event.target.value)}
									>
										<option value="" disabled>
											Approved version
										</option>
										{data.approvals
											.filter((approval) => approval.decision === "APPROVED")
											.map((approval) => (
												<option value={approval.id} key={approval.id}>
													{materialName(approval.contentVersionId)} - {channelName(approval.channelAccountId)}
												</option>
											))}
									</select>
									<Button disabled={pending || !releaseApprovalId} type="submit">
										{data.stagingMvp ? "Queue dry run" : "Queue"}
									</Button>
								</form>
							</CardContent>
						</Card>
						<Card className="rounded-md shadow-none">
							<CardHeader>
							<CardTitle className="text-base">Publishing safety</CardTitle>
							</CardHeader>
							<CardContent>
								<p className="text-sm text-muted-foreground">
									{data.stagingMvp
										? "This test stops after a queued internal record. It cannot send or publish anything."
										: "Publishing stays unavailable until the separate safety service is deployed."}
								</p>
							</CardContent>
						</Card>
						<Card className="rounded-md border-destructive/30 shadow-none">
							<CardHeader>
							<CardTitle className="text-base">Stop publishing</CardTitle>
							</CardHeader>
							<CardContent>
								<p className="mb-3 text-sm text-muted-foreground">Pause every future release for this brand.</p>
								<Button disabled={pending} variant="destructive" onClick={() => setStopBrandOpen(true)}>
									<IconAlertTriangle />
									Stop brand
								</Button>
							</CardContent>
						</Card>
					</div>
					<Card className="rounded-md shadow-none">
						<CardHeader>
							<CardTitle className="text-base">Release intents</CardTitle>
						</CardHeader>
						<CardContent>
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>Material</TableHead>
										<TableHead>Channel</TableHead>
										<TableHead>Scheduled</TableHead>
										<TableHead>Status</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{data.releaseIntents.length === 0 ? (
										<EmptyRows columns={4} label="No releases are queued" />
									) : (
										data.releaseIntents.map((intent) => {
											const outbox = data.outboxEvents.find((event) => event.releaseIntentId === intent.id);
											return (
												<TableRow key={intent.id}>
													<TableCell className="font-medium">{materialName(intent.contentVersionId)}</TableCell>
													<TableCell>{channelName(intent.channelAccountId)}</TableCell>
													<TableCell>{formatDate(intent.notBefore)}</TableCell>
													<TableCell className="space-x-2">
														<StatusBadge value={intent.status} />
														{outbox && <StatusBadge value={outbox.status} />}
													</TableCell>
												</TableRow>
											);
										})
									)}
								</TableBody>
							</Table>
						</CardContent>
					</Card>
					<Card className="rounded-md shadow-none">
						<CardHeader>
							<CardTitle className="text-base">Release checks</CardTitle>
						</CardHeader>
						<CardContent>
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>Material</TableHead>
										<TableHead>Channel</TableHead>
										<TableHead>Valid until</TableHead>
										<TableHead>Status</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{data.manifests.length === 0 ? (
										<EmptyRows columns={4} label="No release checks yet" />
									) : (
										data.manifests.map((item) => (
											<TableRow key={item.id}>
												<TableCell className="font-medium">{materialName(item.contentVersionId)}</TableCell>
												<TableCell>{channelName(item.channelAccountId)}</TableCell>
												<TableCell>{formatDate(item.expiresAt)}</TableCell>
												<TableCell>
													<StatusBadge value={item.status} />
												</TableCell>
											</TableRow>
										))
									)}
								</TableBody>
							</Table>
						</CardContent>
					</Card>
				</div>}

				{activeSection === "publications" && (
					<Card className="rounded-md shadow-none">
						<CardHeader>
							<CardTitle className="text-base">Publishing activity</CardTitle>
						</CardHeader>
						<CardContent>
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>Material</TableHead>
										<TableHead>Channel</TableHead>
										<TableHead>Latest update</TableHead>
										<TableHead>Status</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{data.publications.length === 0 ? (
										<EmptyRows columns={4} label="Nothing has been published" />
									) : (
										data.publications.map((item) => (
											<TableRow key={item.id}>
												<TableCell className="font-medium">
													{materialName(manifestById.get(item.releaseManifestId)?.contentVersionId ?? "")}
												</TableCell>
												<TableCell>{channelName(item.channelAccountId)}</TableCell>
												<TableCell>{formatDate(item.updatedAt)}</TableCell>
												<TableCell>
													<StatusBadge value={item.status} />
												</TableCell>
											</TableRow>
										))
									)}
								</TableBody>
							</Table>
						</CardContent>
					</Card>
				)}

				{activeSection === "performance" && (
					<Card className="rounded-md shadow-none">
						<CardHeader>
							<CardTitle className="text-base">Performance data</CardTitle>
						</CardHeader>
						<CardContent>
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>Data quality</TableHead>
										<TableHead>Observed</TableHead>
										<TableHead>Available through</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{data.metrics.length === 0 ? (
										<EmptyRows columns={3} label="No performance data yet" />
									) : (
										data.metrics.map((item) => (
											<TableRow key={item.id}>
												<TableCell>
													<StatusBadge value={item.quality} />
												</TableCell>
												<TableCell>{formatDate(item.observedAt)}</TableCell>
												<TableCell>{formatDate(item.dataCutoffAt)}</TableCell>
											</TableRow>
										))
									)}
								</TableBody>
							</Table>
						</CardContent>
					</Card>
				)}

				{activeSection === "incidents" && (
					<Card className="rounded-md shadow-none">
						<CardHeader>
							<CardTitle className="text-base">Incidents</CardTitle>
						</CardHeader>
						<CardContent>
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>Severity</TableHead>
										<TableHead>What happened</TableHead>
										<TableHead>Status</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{data.incidents.length === 0 ? (
										<EmptyRows columns={3} label="No incidents" />
									) : (
										data.incidents.map((item) => (
											<TableRow key={item.id}>
												<TableCell>{item.severity}</TableCell>
												<TableCell>{item.summary}</TableCell>
												<TableCell>
													<StatusBadge value={item.status} />
												</TableCell>
											</TableRow>
										))
									)}
								</TableBody>
							</Table>
						</CardContent>
					</Card>
				)}

				{activeSection === "audit" && (
					<Card className="rounded-md shadow-none">
						<CardHeader>
							<CardTitle className="text-base">Activity log</CardTitle>
						</CardHeader>
						<CardContent>
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>What happened</TableHead>
										<TableHead>Time</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{data.audits.length === 0 ? (
										<EmptyRows columns={2} label="No activity yet" />
									) : (
										data.audits.map((item) => (
											<TableRow key={item.id}>
												<TableCell>{displayAuditAction(item.action)}</TableCell>
												<TableCell>{formatDate(item.createdAt)}</TableCell>
											</TableRow>
										))
									)}
								</TableBody>
							</Table>
						</CardContent>
					</Card>
				)}
			</div>

			<Dialog
				open={stopBrandOpen}
				onOpenChange={(open) => {
					setStopBrandOpen(open);
					if (!open) setStopBrandConfirmation("");
				}}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Stop every future release?</DialogTitle>
						<DialogDescription>
							This pauses all future releases for this brand. Materials and approvals are not deleted, but nothing can
							be sent until an authorized operator clears the stop.
						</DialogDescription>
					</DialogHeader>
					<Label className="grid gap-2">
						Type STOP to confirm
						<Input
							value={stopBrandConfirmation}
							onChange={(event) => setStopBrandConfirmation(event.target.value)}
							placeholder="STOP"
						/>
					</Label>
					<DialogFooter>
						<Button variant="outline" onClick={() => setStopBrandOpen(false)}>
							Cancel
						</Button>
						<Button
							disabled={pending || stopBrandConfirmation !== "STOP"}
							variant="destructive"
							onClick={() => {
								run(
									() =>
										setReleaseKillSwitchFn({
											data: { brandId, scope: "BRAND", enabled: true, reason: "Stopped from Control Room" },
										}),
									"Publishing stopped for this brand",
								);
								setStopBrandOpen(false);
								setStopBrandConfirmation("");
							}}
						>
							Stop publishing
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
