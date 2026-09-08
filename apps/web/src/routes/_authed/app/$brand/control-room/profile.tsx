import { IconCheck, IconCirclePlus, IconLock, IconPlayerPause, IconRefresh, IconTrash } from "@tabler/icons-react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import type { FactState } from "@workspace/content-workflow/profile";
import { Badge } from "@workspace/ui/components/badge";
import { Button } from "@workspace/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@workspace/ui/components/card";
import { Input } from "@workspace/ui/components/input";
import { Label } from "@workspace/ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@workspace/ui/components/select";
import { Textarea } from "@workspace/ui/components/textarea";
import { useRef, useState, useTransition } from "react";
import { CONTENT_PRODUCT_NAME } from "@/lib/content-product";
import {
	createContentProfileVersionFn,
	decideContentProfileFn,
	ensureDraftYouTubeChannelFn,
	getContentProfileFn,
} from "@/server/content-profile";

export const Route = createFileRoute("/_authed/app/$brand/control-room/profile")({
	loader: ({ params }) => getContentProfileFn({ data: { brandId: params.brand } }),
	head: () => ({ meta: [{ title: `Project profile · ${CONTENT_PRODUCT_NAME}` }] }),
	component: ProjectProfilePage,
});

function splitLines(value: string): string[] {
	return value
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

type FactDraft = {
	localId: number;
	id: string;
	statement: string;
	state: FactState;
	sourceRefs: string;
};

const FACT_STATES: { value: FactState; label: string; requirement: string }[] = [
	{ value: "UNKNOWN", label: "Unknown", requirement: "Not eligible for factual claims" },
	{ value: "VERIFIED", label: "Verified", requirement: "Requires at least one source URL" },
	{ value: "DISPUTED", label: "Disputed", requirement: "Excluded from factual claims" },
	{ value: "PROHIBITED", label: "Prohibited", requirement: "Must not have source URLs" },
];

function blankFact(localId: number): FactDraft {
	return { localId, id: "", statement: "", state: "UNKNOWN", sourceRefs: "" };
}

function ProjectProfilePage() {
	const { brand: brandId } = Route.useParams();
	const { current, versions, canDecide } = Route.useLoaderData();
	const latestDraft = versions.find((entry) => entry.decision === null) ?? null;
	const router = useRouter();
	const [pending, startTransition] = useTransition();
	const [languages, setLanguages] = useState("en");
	const [audience, setAudience] = useState("");
	const [audienceNeeds, setAudienceNeeds] = useState("");
	const [audienceSecondary, setAudienceSecondary] = useState("");
	const [voice, setVoice] = useState("");
	const [ctaRules, setCtaRules] = useState("");
	const [visualRules, setVisualRules] = useState("");
	const [claimRules, setClaimRules] = useState("Only use confirmed sources for factual claims.");
	const nextFactId = useRef(1);
	const [facts, setFacts] = useState<FactDraft[]>([blankFact(0)]);
	const [sourceRefs, setSourceRefs] = useState("");
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

	function saveDraft() {
		const languageValues = splitLines(languages);
		if (languageValues.length === 0 || !audience.trim() || !voice.trim()) {
			setNotice({ kind: "error", message: "Add at least one language, a primary audience and one voice trait." });
			return;
		}
		const enteredFacts = facts.filter(
			(fact) => fact.id.trim() || fact.statement.trim() || fact.sourceRefs.trim() || fact.state !== "UNKNOWN",
		);
		if (enteredFacts.some((fact) => !fact.id.trim() || !fact.statement.trim())) {
			setNotice({ kind: "error", message: "Every fact needs both a key and a statement." });
			return;
		}
		if (enteredFacts.some((fact) => fact.state === "VERIFIED" && splitLines(fact.sourceRefs).length === 0)) {
			setNotice({ kind: "error", message: "Every Verified fact needs at least one source URL." });
			return;
		}
		if (enteredFacts.some((fact) => fact.state === "PROHIBITED" && splitLines(fact.sourceRefs).length > 0)) {
			setNotice({ kind: "error", message: "A Prohibited fact cannot have source URLs." });
			return;
		}
		const normalizedFacts = enteredFacts.map((fact) => ({
			id: fact.id.trim(),
			statement: fact.statement.trim(),
			state: fact.state,
			sourceRefs: splitLines(fact.sourceRefs),
		}));
		const allSourceRefs = [...splitLines(sourceRefs), ...normalizedFacts.flatMap((fact) => fact.sourceRefs)].filter(
			(uri, index, values) => values.indexOf(uri) === index,
		);
		run(
			() =>
				createContentProfileVersionFn({
					data: {
						brandId,
						profile: {
							languages: languageValues,
							audience: {
								primary: audience.trim(),
								secondary: splitLines(audienceSecondary),
								needs: splitLines(audienceNeeds),
							},
							voice: { traits: splitLines(voice), examples: [], exclusions: [] },
							ctaRules: splitLines(ctaRules),
							visualRules: { palette: [], imagery: splitLines(visualRules), avoid: [] },
							claimRules: { requireSources: true, allowedStates: ["VERIFIED"] },
							facts: normalizedFacts,
							sourceRefs: allSourceRefs.map((uri) => ({ uri })),
						},
					},
				}),
			"Draft profile saved as a new immutable version",
		);
	}

	return (
		<div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
			<div>
				<h1 className="text-2xl font-semibold tracking-normal">Project profile</h1>
				<p className="mt-1 max-w-2xl text-sm text-muted-foreground">
					Define the facts, voice and constraints that every future Content OS research and creation run must use.
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

			<Card className="rounded-md shadow-none">
				<CardHeader>
					<CardTitle>New profile version</CardTitle>
					<CardDescription>
						Saving creates an immutable draft. No provider is called and nothing is published.
					</CardDescription>
				</CardHeader>
				<CardContent className="grid gap-5 md:grid-cols-2">
					<div className="space-y-2">
						<Label htmlFor="profile-languages">Languages</Label>
						<Textarea
							id="profile-languages"
							value={languages}
							onChange={(event) => setLanguages(event.target.value)}
							placeholder="One BCP-47 language per line, e.g. en"
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor="profile-audience">Primary audience</Label>
						<Input
							className="min-h-11"
							id="profile-audience"
							value={audience}
							onChange={(event) => setAudience(event.target.value)}
							placeholder="Who this project serves"
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor="profile-audience-needs">Topics to cover</Label>
						<Textarea
							id="profile-audience-needs"
							value={audienceNeeds}
							onChange={(event) => setAudienceNeeds(event.target.value)}
							placeholder="One subject per line, e.g. where to eat in Canggu"
						/>
						<p className="text-xs text-muted-foreground">
							Research runs on these, in this order. Without them a run falls back to the brand name.
						</p>
					</div>
					<div className="space-y-2">
						<Label htmlFor="profile-audience-secondary">Secondary audiences</Label>
						<Textarea
							id="profile-audience-secondary"
							value={audienceSecondary}
							onChange={(event) => setAudienceSecondary(event.target.value)}
							placeholder="One audience per line"
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor="profile-voice">Voice traits</Label>
						<Textarea
							id="profile-voice"
							value={voice}
							onChange={(event) => setVoice(event.target.value)}
							placeholder="One trait per line, e.g. warm"
						/>
						<p className="text-xs text-muted-foreground">
							How this brand sounds, not what it covers. Traits never become research topics.
						</p>
					</div>
					<div className="space-y-2">
						<Label htmlFor="profile-cta">CTA rules</Label>
						<Textarea
							id="profile-cta"
							value={ctaRules}
							onChange={(event) => setCtaRules(event.target.value)}
							placeholder="One rule per line"
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor="profile-visual">Visual rules</Label>
						<Textarea
							id="profile-visual"
							value={visualRules}
							onChange={(event) => setVisualRules(event.target.value)}
							placeholder="Imagery and visual direction"
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor="profile-claims">Claim policy</Label>
						<Textarea
							id="profile-claims"
							value={claimRules}
							onChange={(event) => setClaimRules(event.target.value)}
							disabled
						/>
					</div>
					<div className="space-y-3 md:col-span-2">
						<div>
							<p className="text-sm font-medium">Project facts</p>
							<p className="mt-1 text-xs text-muted-foreground">
								Set the evidence state for each fact. Only Verified facts with a source can enter future factual claims.
							</p>
						</div>
						{facts.map((fact, index) => {
							const selectedState = FACT_STATES.find((option) => option.value === fact.state);
							return (
								<div className="grid gap-3 rounded-md border p-3 md:grid-cols-2" key={fact.localId}>
									<div className="space-y-2">
										<Label htmlFor={`profile-fact-${fact.localId}-key`}>Fact key</Label>
										<Input
											className="min-h-11"
											id={`profile-fact-${fact.localId}-key`}
											value={fact.id}
											onChange={(event) =>
												setFacts((current) =>
													current.map((entry) =>
														entry.localId === fact.localId ? { ...entry, id: event.target.value } : entry,
													),
												)
											}
											placeholder="e.g. opening-location"
										/>
									</div>
									<div className="space-y-2">
										<Label htmlFor={`profile-fact-${fact.localId}-state`}>Evidence state</Label>
										<Select
											value={fact.state}
											onValueChange={(value: FactState) =>
												setFacts((current) =>
													current.map((entry) =>
														entry.localId === fact.localId
															? { ...entry, state: value, sourceRefs: value === "PROHIBITED" ? "" : entry.sourceRefs }
															: entry,
													),
												)
											}
										>
											<SelectTrigger className="min-h-11 w-full" id={`profile-fact-${fact.localId}-state`}>
												<SelectValue />
											</SelectTrigger>
											<SelectContent>
												{FACT_STATES.map((option) => (
													<SelectItem className="min-h-11" key={option.value} value={option.value}>
														{option.label}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
										<p className="text-xs text-muted-foreground">{selectedState?.requirement}</p>
									</div>
									<div className="space-y-2 md:col-span-2">
										<Label htmlFor={`profile-fact-${fact.localId}-statement`}>Fact statement</Label>
										<Textarea
											id={`profile-fact-${fact.localId}-statement`}
											value={fact.statement}
											onChange={(event) =>
												setFacts((current) =>
													current.map((entry) =>
														entry.localId === fact.localId ? { ...entry, statement: event.target.value } : entry,
													),
												)
											}
											placeholder="A factual statement about this project"
										/>
									</div>
									<div className="space-y-2 md:col-span-2">
										<Label htmlFor={`profile-fact-${fact.localId}-sources`}>Fact source URLs</Label>
										<Textarea
											disabled={fact.state === "PROHIBITED"}
											id={`profile-fact-${fact.localId}-sources`}
											value={fact.sourceRefs}
											onChange={(event) =>
												setFacts((current) =>
													current.map((entry) =>
														entry.localId === fact.localId ? { ...entry, sourceRefs: event.target.value } : entry,
													),
												)
											}
											placeholder="One source URL per line"
										/>
									</div>
									{facts.length > 1 && (
										<div className="md:col-span-2">
											<Button
												className="min-h-11"
												type="button"
												onClick={() => setFacts((current) => current.filter((entry) => entry.localId !== fact.localId))}
												variant="ghost"
											>
												<IconTrash aria-hidden="true" /> Remove fact {index + 1}
											</Button>
										</div>
									)}
								</div>
							);
						})}
						<Button
							className="min-h-11"
							type="button"
							onClick={() => {
								const localId = nextFactId.current;
								nextFactId.current += 1;
								setFacts((current) => [...current, blankFact(localId)]);
							}}
							variant="outline"
						>
							<IconCirclePlus aria-hidden="true" /> Add another fact
						</Button>
					</div>
					<div className="space-y-2 md:col-span-2">
						<Label htmlFor="profile-sources">Source references</Label>
						<Textarea
							id="profile-sources"
							value={sourceRefs}
							onChange={(event) => setSourceRefs(event.target.value)}
							placeholder="https://example.com/source, one URL per line"
						/>
					</div>
					<div className="md:col-span-2">
						<Button className="min-h-11" type="button" onClick={saveDraft} disabled={pending}>
							<IconCirclePlus aria-hidden="true" />
							{pending ? "Saving…" : "Save draft version"}
						</Button>
					</div>
				</CardContent>
			</Card>

			<Card className="rounded-md shadow-none">
				<CardHeader>
					<CardTitle>Current confirmed profile</CardTitle>
					<CardDescription>
						Only a confirmed, non-revoked version can feed future research and creation.
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-4">
					{current ? (
						<div className="flex flex-wrap items-center gap-2 text-sm">
							<Badge variant="outline">Version {current.version.version}</Badge>
							<Badge variant="outline" className="font-mono">
								{current.version.profileHash.slice(0, 12)}…
							</Badge>
							{current.decision?.decision === "CONFIRMED" ? (
								<Badge className="border-emerald-300 bg-emerald-50 text-emerald-800">
									<IconCheck aria-hidden="true" /> Confirmed
								</Badge>
							) : (
								<Badge variant="outline">Draft — owner confirmation required</Badge>
							)}
						</div>
					) : (
						<p className="text-sm text-muted-foreground">
							No confirmed profile yet. Save a draft, then confirm it as the interactive owner.
						</p>
					)}
					{versions.length > 0 && (
						<div className="space-y-2 border-t pt-4">
							<p className="text-sm font-medium">Version history</p>
							{versions.map((entry) => (
								<div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground" key={entry.version.id}>
									<span>v{entry.version.version}</span>
									<span className="font-mono">{entry.version.profileHash.slice(0, 12)}…</span>
									<span>{entry.decision?.decision ?? "DRAFT"}</span>
								</div>
							))}
						</div>
					)}
					<div className="flex flex-wrap gap-2">
						{canDecide && current && current.decision?.decision === "CONFIRMED" && (
							<Button
								className="min-h-11"
								type="button"
								disabled={pending}
								onClick={() =>
									run(
										() =>
											decideContentProfileFn({
												data: {
													brandId,
													profileVersionId: current.version.id,
													decision: "REVOKED",
													reason: "Owner requested a replacement profile",
												},
											}),
										"Profile revoked",
									)
								}
								variant="outline"
							>
								<IconPlayerPause aria-hidden="true" /> Revoke current
							</Button>
						)}
						{canDecide && latestDraft && (
							<Button
								className="min-h-11"
								type="button"
								disabled={pending}
								onClick={() =>
									run(
										() =>
											decideContentProfileFn({
												data: { brandId, profileVersionId: latestDraft.version.id, decision: "CONFIRMED" },
											}),
										"Profile confirmed",
									)
								}
							>
								<IconCheck aria-hidden="true" /> Confirm draft as owner
							</Button>
						)}
						<Button
							className="min-h-11"
							type="button"
							disabled={pending}
							onClick={() =>
								run(() => ensureDraftYouTubeChannelFn({ data: { brandId } }), "Draft-only YouTube target added")
							}
							variant="outline"
						>
							<IconLock aria-hidden="true" /> Add draft-only YouTube target
						</Button>
					</div>
					<p className="text-xs text-muted-foreground">
						YouTube: Draft-only. No account connected. Publishing is unavailable.
					</p>
					<p className="text-xs text-muted-foreground">
						New facts start as Unknown. A factual claim becomes eligible only after it is marked Verified and linked to
						a source. Disputed and Prohibited facts never enter creation context.
					</p>
				</CardContent>
			</Card>

			<Card className="rounded-md border-dashed shadow-none">
				<CardContent className="flex items-start gap-3 pt-6 text-sm text-muted-foreground">
					<IconRefresh className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
					<p>
						Confirmation is owner-only and append-only. Members can prepare drafts; they cannot confirm or revoke
						profile versions.
					</p>
				</CardContent>
			</Card>
		</div>
	);
}
