import { type FormEvent, useEffect, useState, useTransition } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import {
	IconAlertTriangle,
	IconFileText,
	IconLockCheck,
	IconPlus,
	IconRefresh,
} from "@tabler/icons-react";
import { Badge } from "@workspace/ui/components/badge";
import { Button } from "@workspace/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@workspace/ui/components/card";
import { Input } from "@workspace/ui/components/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@workspace/ui/components/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@workspace/ui/components/tabs";
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
				{ title: buildTitle("Control Room", { appName, brandName }) },
				{ name: "description", content: "Human-approved content release control plane." },
			],
		};
	},
	component: ControlRoomPage,
});

function formatDate(value: Date | string | null | undefined): string {
	if (!value) return "-";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return "-";
	return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function shortHash(value: string): string {
	return `${value.slice(0, 10)}...${value.slice(-6)}`;
}

function StatusBadge({ value }: { value: string | null }) {
	if (!value) return <Badge variant="outline">Pending</Badge>;
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
			{value.replaceAll("_", " ")}
		</Badge>
	);
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
	const [pending, startTransition] = useTransition();
	const [notice, setNotice] = useState<string | null>(null);
	const [contentTitle, setContentTitle] = useState("");
	const [contentBody, setContentBody] = useState("");
	const [contentCta, setContentCta] = useState("");
	const [contentPolicy, setContentPolicy] = useState("selena-brand-pack/v1");
	const [approvalVersionId, setApprovalVersionId] = useState("");
	const [approvalAccountId, setApprovalAccountId] = useState("");
	const [approvalExpiry, setApprovalExpiry] = useState("");
	const [releaseApprovalId, setReleaseApprovalId] = useState("");
	const [revisionContentId, setRevisionContentId] = useState("");
	const [revisionBody, setRevisionBody] = useState("");
	const [revisionCta, setRevisionCta] = useState("");
	const [revisionPolicy, setRevisionPolicy] = useState("selena-brand-pack/v1");

	useEffect(() => {
		setApprovalVersionId((value) => value || data.versions[0]?.id || "");
		setRevisionContentId((value) => value || data.content[0]?.id || "");
		setApprovalAccountId((value) => value || data.accounts[0]?.id || "");
		setReleaseApprovalId((value) => value || data.approvals.find((approval) => approval.decision === "APPROVED")?.id || "");
	}, [data.accounts, data.approvals, data.content, data.versions]);

	function run(action: () => Promise<unknown>, successMessage: string) {
		startTransition(async () => {
			try {
				await action();
				await router.invalidate();
				setNotice(successMessage);
			} catch (error) {
				setNotice(error instanceof Error ? error.message : "Request failed");
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
			"Content version created",
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
			"New immutable revision created",
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
						expiresAt: new Date(approvalExpiry),
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
					<h1 className="mt-1 text-2xl font-semibold tracking-normal">Control Room</h1>
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

			<Tabs defaultValue="inbox" className="gap-5">
				<div className="overflow-x-auto pb-1">
					<TabsList className="h-10 min-w-max rounded-md">
						<TabsTrigger value="inbox">Inbox</TabsTrigger>
						<TabsTrigger value="content">Content</TabsTrigger>
						<TabsTrigger value="review">Review</TabsTrigger>
						<TabsTrigger value="releases">Releases</TabsTrigger>
						<TabsTrigger value="publications">Publications</TabsTrigger>
						<TabsTrigger value="performance">Performance</TabsTrigger>
						<TabsTrigger value="incidents">Incidents</TabsTrigger>
						<TabsTrigger value="audit">Audit</TabsTrigger>
					</TabsList>
				</div>

				<TabsContent value="inbox">
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
				</TabsContent>

				<TabsContent value="content" className="space-y-5">
					<div className="grid gap-5 xl:grid-cols-2">
						<Card className="rounded-md shadow-none">
							<CardHeader>
								<CardTitle className="text-base">New content</CardTitle>
							</CardHeader>
							<CardContent>
								<form className="grid gap-3" onSubmit={submitContent}>
									<Input
										required
										placeholder="Title"
										value={contentTitle}
										onChange={(event) => setContentTitle(event.target.value)}
									/>
									<Textarea
										required
										placeholder="LinkedIn post"
										value={contentBody}
										onChange={(event) => setContentBody(event.target.value)}
									/>
									<Input
										required
										type="url"
										placeholder="CTA URL"
										value={contentCta}
										onChange={(event) => setContentCta(event.target.value)}
									/>
									<Input
										required
										placeholder="Policy version"
										value={contentPolicy}
										onChange={(event) => setContentPolicy(event.target.value)}
									/>
									<Button disabled={pending} type="submit">
										<IconPlus />
										Create version
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
									<Textarea
										required
										placeholder="Revised LinkedIn post"
										value={revisionBody}
										onChange={(event) => setRevisionBody(event.target.value)}
									/>
									<Input
										required
										type="url"
										placeholder="CTA URL"
										value={revisionCta}
										onChange={(event) => setRevisionCta(event.target.value)}
									/>
									<Input
										required
										placeholder="Policy version"
										value={revisionPolicy}
										onChange={(event) => setRevisionPolicy(event.target.value)}
									/>
									<Button disabled={pending} variant="outline" type="submit">
										<IconFileText />
										Create revision
									</Button>
								</form>
							</CardContent>
						</Card>
					</div>
					<div className="grid gap-5 xl:grid-cols-2">
						<Card className="rounded-md shadow-none">
							<CardHeader>
								<CardTitle className="text-base">LinkedIn connection</CardTitle>
							</CardHeader>
							<CardContent>
								<p className="text-sm text-muted-foreground">
									No account can be allowlisted until the isolated Postiz contract is verified by the Release Gateway.
								</p>
							</CardContent>
						</Card>
						<Card className="rounded-md shadow-none">
							<CardHeader>
								<CardTitle className="text-base">Asset intake</CardTitle>
							</CardHeader>
							<CardContent>
								<p className="text-sm text-muted-foreground">
									Private Storage, byte hashing, and malware scanning are not connected. Manual asset metadata is disabled.
								</p>
							</CardContent>
						</Card>
					</div>
					<Card className="rounded-md shadow-none">
						<CardHeader>
							<CardTitle className="text-base">Immutable versions</CardTitle>
						</CardHeader>
						<CardContent>
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>Version</TableHead>
										<TableHead>Hash</TableHead>
										<TableHead>Policy</TableHead>
										<TableHead>Created</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{data.versions.length === 0 ? (
										<EmptyRows columns={4} label="No versions" />
									) : (
										data.versions.map((item) => (
											<TableRow key={item.id}>
												<TableCell>v{item.version}</TableCell>
												<TableCell className="font-mono text-xs">{shortHash(item.contentHash)}</TableCell>
												<TableCell>{item.policyVersion}</TableCell>
												<TableCell>{formatDate(item.createdAt)}</TableCell>
											</TableRow>
										))
									)}
								</TableBody>
							</Table>
						</CardContent>
					</Card>
				</TabsContent>

				<TabsContent value="review" className="space-y-5">
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
											v{item.version} {shortHash(item.contentHash)}
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
											{item.providerAccountRef}
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
										<TableHead>Decision</TableHead>
										<TableHead>Content hash</TableHead>
										<TableHead>Expiry</TableHead>
										<TableHead>Action</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{data.approvals.length === 0 ? (
										<EmptyRows columns={4} label="No approval records" />
									) : (
										data.approvals.map((item) => (
											<TableRow key={item.id}>
												<TableCell>
													<StatusBadge value={item.decision} />
												</TableCell>
												<TableCell className="font-mono text-xs">{shortHash(item.contentHash)}</TableCell>
												<TableCell>{formatDate(item.expiresAt)}</TableCell>
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
				</TabsContent>

					<TabsContent value="releases" className="space-y-5">
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
														{shortHash(approval.contentHash)}
													</option>
												))}
										</select>
										<Button disabled={pending || !releaseApprovalId} type="submit">
											Queue
										</Button>
									</form>
								</CardContent>
							</Card>
							<Card className="rounded-md shadow-none">
							<CardHeader>
								<CardTitle className="text-base">Release Gateway</CardTitle>
							</CardHeader>
							<CardContent>
								<p className="text-sm text-muted-foreground">
									No manifest can be signed or dispatched until the separate Gateway is deployed.
								</p>
							</CardContent>
						</Card>
						<Card className="rounded-md border-destructive/30 shadow-none">
							<CardHeader>
								<CardTitle className="text-base">Release stop</CardTitle>
							</CardHeader>
							<CardContent>
								<Button
									disabled={pending}
									variant="destructive"
									onClick={() =>
										run(
											() =>
												setReleaseKillSwitchFn({
													data: { brandId, scope: "BRAND", enabled: true, reason: "Stopped from Control Room" },
												}),
											"Brand release stop enabled",
										)
									}
								>
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
											<TableHead>Status</TableHead>
											<TableHead>Platform</TableHead>
											<TableHead>Outbox</TableHead>
											<TableHead>Created</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{data.releaseIntents.length === 0 ? (
											<EmptyRows columns={4} label="No release intents" />
										) : (
											data.releaseIntents.map((intent) => {
												const outbox = data.outboxEvents.find((event) => event.releaseIntentId === intent.id);
												return (
													<TableRow key={intent.id}>
														<TableCell>
															<StatusBadge value={intent.status} />
														</TableCell>
														<TableCell>{intent.platform}</TableCell>
														<TableCell>
															<StatusBadge value={outbox?.status ?? null} />
														</TableCell>
														<TableCell>{formatDate(intent.createdAt)}</TableCell>
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
							<CardTitle className="text-base">Gateway manifests</CardTitle>
						</CardHeader>
						<CardContent>
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>Status</TableHead>
										<TableHead>Platform</TableHead>
										<TableHead>Manifest hash</TableHead>
										<TableHead>Expiry</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{data.manifests.length === 0 ? (
										<EmptyRows columns={4} label="No Gateway manifests" />
									) : (
										data.manifests.map((item) => (
											<TableRow key={item.id}>
												<TableCell>
													<StatusBadge value={item.status} />
												</TableCell>
												<TableCell>{item.platform}</TableCell>
												<TableCell className="font-mono text-xs">{shortHash(item.manifestHash)}</TableCell>
												<TableCell>{formatDate(item.expiresAt)}</TableCell>
											</TableRow>
										))
									)}
								</TableBody>
							</Table>
						</CardContent>
					</Card>
				</TabsContent>

				<TabsContent value="publications">
					<Card className="rounded-md shadow-none">
						<CardHeader>
							<CardTitle className="text-base">Platform delivery</CardTitle>
						</CardHeader>
						<CardContent>
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>Status</TableHead>
										<TableHead>Platform</TableHead>
										<TableHead>Platform object</TableHead>
										<TableHead>Updated</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{data.publications.length === 0 ? (
										<EmptyRows columns={4} label="No publication attempts" />
									) : (
										data.publications.map((item) => (
											<TableRow key={item.id}>
												<TableCell>
													<StatusBadge value={item.status} />
												</TableCell>
												<TableCell>{item.platform}</TableCell>
												<TableCell className="font-mono text-xs">{item.platformObjectId ?? "-"}</TableCell>
												<TableCell>{formatDate(item.updatedAt)}</TableCell>
											</TableRow>
										))
									)}
								</TableBody>
							</Table>
						</CardContent>
					</Card>
				</TabsContent>

				<TabsContent value="performance">
					<Card className="rounded-md shadow-none">
						<CardHeader>
							<CardTitle className="text-base">Source snapshots</CardTitle>
						</CardHeader>
						<CardContent>
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>Quality</TableHead>
										<TableHead>Observed</TableHead>
										<TableHead>Data cutoff</TableHead>
										<TableHead>Definition</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{data.metrics.length === 0 ? (
										<EmptyRows columns={4} label="No platform snapshots" />
									) : (
										data.metrics.map((item) => (
											<TableRow key={item.id}>
												<TableCell>
													<StatusBadge value={item.quality} />
												</TableCell>
												<TableCell>{formatDate(item.observedAt)}</TableCell>
												<TableCell>{formatDate(item.dataCutoffAt)}</TableCell>
												<TableCell>{item.definitionVersion}</TableCell>
											</TableRow>
										))
									)}
								</TableBody>
							</Table>
						</CardContent>
					</Card>
				</TabsContent>

				<TabsContent value="incidents">
					<Card className="rounded-md shadow-none">
						<CardHeader>
							<CardTitle className="text-base">Incidents</CardTitle>
						</CardHeader>
						<CardContent>
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>Severity</TableHead>
										<TableHead>Code</TableHead>
										<TableHead>Summary</TableHead>
										<TableHead>Status</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{data.incidents.length === 0 ? (
										<EmptyRows columns={4} label="No incidents" />
									) : (
										data.incidents.map((item) => (
											<TableRow key={item.id}>
												<TableCell>{item.severity}</TableCell>
												<TableCell className="font-mono text-xs">{item.code}</TableCell>
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
				</TabsContent>

				<TabsContent value="audit">
					<Card className="rounded-md shadow-none">
						<CardHeader>
							<CardTitle className="text-base">Append-only audit trail</CardTitle>
						</CardHeader>
						<CardContent>
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>Action</TableHead>
										<TableHead>Actor</TableHead>
										<TableHead>Aggregate</TableHead>
										<TableHead>Event hash</TableHead>
										<TableHead>Time</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{data.audits.length === 0 ? (
										<EmptyRows columns={5} label="No audit events" />
									) : (
										data.audits.map((item) => (
											<TableRow key={item.id}>
												<TableCell>{item.action}</TableCell>
												<TableCell className="font-mono text-xs">{item.actorId}</TableCell>
												<TableCell>{item.aggregateType}</TableCell>
												<TableCell className="font-mono text-xs">{shortHash(item.eventHash)}</TableCell>
												<TableCell>{formatDate(item.createdAt)}</TableCell>
											</TableRow>
										))
									)}
								</TableBody>
							</Table>
						</CardContent>
					</Card>
				</TabsContent>
			</Tabs>
		</div>
	);
}
