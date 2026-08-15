import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@workspace/ui/components/button";
import { Input } from "@workspace/ui/components/input";
import { useCallback, useEffect, useState } from "react";
import { createSelenaProjectFn, listSelenaProjectsFn } from "../../../server/selena-client";
import { createSelenaOrderFn, createSelenaQuoteFn, createSelenaTestPaymentFn } from "../../../server/selena-commerce";
import { getSelenaDashboardFn } from "../../../server/selena-dashboard";
import { confirmSelenaProfileFn } from "../../../server/selena-onboarding";
import { collectSelenaWebsiteFn } from "../../../server/selena-website-collector";

export const Route = createFileRoute("/_authed/app/selena")({ component: SelenaConsole });

function SelenaConsole() {
	const [projects, setProjects] = useState<Array<{ id: string; name: string; category: string; country: string }>>([]);
	const [form, setForm] = useState({ name: "", category: "", country: "", region: "", languages: "en" });
	const [error, setError] = useState("");
	const [pending, setPending] = useState(false);
	const [cycleId, setCycleId] = useState("");
	const [dashboard, setDashboard] = useState<Awaited<ReturnType<typeof getSelenaDashboardFn>>>(null);
	const [commerce, setCommerce] = useState({
		projectId: "",
		lockId: "",
		scenarioIds: "",
		orderId: "",
		quoteId: "",
		quoteAmount: 0,
	});
	const [commerceMessage, setCommerceMessage] = useState("");
	const [websiteMessage, setWebsiteMessage] = useState("");
	const [profile, setProfile] = useState({
		brandName: "",
		primaryDomain: "",
		publicProfiles: "",
		competitors: "",
		scenarios: "",
	});
	const reload = useCallback(
		() =>
			listSelenaProjectsFn()
				.then(setProjects)
				.catch((cause) => setError(cause instanceof Error ? cause.message : "Unable to load projects")),
		[],
	);
	useEffect(() => {
		void reload();
	}, [reload]);
	const submit = async (event: React.FormEvent) => {
		event.preventDefault();
		setPending(true);
		setError("");
		try {
			await createSelenaProjectFn({
				data: {
					...form,
					languages: form.languages
						.split(",")
						.map((item) => item.trim())
						.filter(Boolean),
				},
			});
			setForm({ name: "", category: "", country: "", region: "", languages: "en" });
			await reload();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Unable to create project");
		} finally {
			setPending(false);
		}
	};
	const confirmProfile = async (projectId: string) => {
		setPending(true);
		setError("");
		try {
			await confirmSelenaProfileFn({
				data: {
					projectId,
					brandName: profile.brandName,
					primaryDomain: profile.primaryDomain,
					publicProfiles: profile.publicProfiles
						.split(",")
						.map((url) => url.trim())
						.filter(Boolean)
						.map((url) => ({ platform: "public", url })),
					competitorSnapshot: profile.competitors
						.split(",")
						.map((name) => name.trim())
						.filter(Boolean)
						.map((name) => ({ name, domains: [] })),
					scenarioSnapshot: profile.scenarios
						.split("\n")
						.map((text) => text.trim())
						.filter(Boolean)
						.map((text) => ({ text, language: "en", intentType: "discovery" })),
				},
			});
			setError("");
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Unable to confirm profile");
		} finally {
			setPending(false);
		}
	};
	const loadDashboard = async (event: React.FormEvent) => {
		event.preventDefault();
		setPending(true);
		setError("");
		try {
			setDashboard(await getSelenaDashboardFn({ data: { cycleId } }));
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Unable to load dashboard");
		} finally {
			setPending(false);
		}
	};
	const createQuote = async () => {
		setPending(true);
		setCommerceMessage("");
		try {
			const quote = await createSelenaQuoteFn({
				data: {
					projectId: commerce.projectId,
					lockId: commerce.lockId,
					scenarioIds: commerce.scenarioIds
						.split(",")
						.map((id) => id.trim())
						.filter(Boolean),
					systems: [{ id: "elmo", channel: "API" }],
					repeats: 1,
					pricing: { baseAmount: 0, perRunAmount: 0, qcAmount: 0, marginRate: 0, currency: "USD" },
				},
			});
			setCommerce({ ...commerce, quoteId: quote.id, quoteAmount: Number(quote.priceAmount) });
			setCommerceMessage(`Quote ${quote.id} created: ${quote.priceAmount} ${quote.currency}`);
		} catch (cause) {
			setCommerceMessage(cause instanceof Error ? cause.message : "Unable to create quote");
		} finally {
			setPending(false);
		}
	};
	const createOrder = async () => {
		setPending(true);
		setCommerceMessage("");
		try {
			const order = await createSelenaOrderFn({
				data: {
					projectId: commerce.projectId,
					quoteId: commerce.quoteId,
					lockId: commerce.lockId,
					orderCap: commerce.quoteAmount,
				},
			});
			setCommerce({ ...commerce, orderId: order.id });
			setCommerceMessage(`Order ${order.id} awaiting test payment`);
		} catch (cause) {
			setCommerceMessage(cause instanceof Error ? cause.message : "Unable to create order");
		} finally {
			setPending(false);
		}
	};
	const payTestOrder = async () => {
		setPending(true);
		setCommerceMessage("");
		try {
			const eventId = `selena-ui-test-${crypto.randomUUID()}`;
			await createSelenaTestPaymentFn({
				data: { orderId: commerce.orderId, amount: 0, currency: "USD", providerEventId: eventId },
			});
			setCommerceMessage("Test payment succeeded; no real payment provider was contacted.");
		} catch (cause) {
			setCommerceMessage(cause instanceof Error ? cause.message : "Unable to create test payment");
		} finally {
			setPending(false);
		}
	};
	const collectWebsite = async (projectId: string) => {
		setPending(true);
		setWebsiteMessage("");
		try {
			const result = await collectSelenaWebsiteFn({ data: { projectId } });
			setWebsiteMessage(
				`Website snapshot ${result.snapshot.id} stored; ${result.actionPlan.findings.length} WEB findings.`,
			);
		} catch (cause) {
			setWebsiteMessage(cause instanceof Error ? cause.message : "Unable to collect website");
		} finally {
			setPending(false);
		}
	};
	return (
		<main className="mx-auto flex max-w-4xl flex-col gap-8 px-6 py-12">
			<div>
				<p className="text-sm font-medium text-muted-foreground">Selena client workspace</p>
				<h1 className="mt-2 text-3xl font-semibold">Projects</h1>
				<p className="mt-2 text-muted-foreground">
					Create a project, confirm its public profile and scenarios, then request a quote.
				</p>
			</div>
			<form onSubmit={submit} className="grid gap-3 rounded-lg border p-5 sm:grid-cols-2">
				<Input
					required
					placeholder="Project name"
					value={form.name}
					onChange={(event) => setForm({ ...form, name: event.target.value })}
				/>
				<Input
					required
					placeholder="Category"
					value={form.category}
					onChange={(event) => setForm({ ...form, category: event.target.value })}
				/>
				<Input
					required
					placeholder="Country"
					value={form.country}
					onChange={(event) => setForm({ ...form, country: event.target.value })}
				/>
				<Input
					placeholder="Region"
					value={form.region}
					onChange={(event) => setForm({ ...form, region: event.target.value })}
				/>
				<Input
					placeholder="Languages, comma separated"
					value={form.languages}
					onChange={(event) => setForm({ ...form, languages: event.target.value })}
				/>
				<Button type="submit" disabled={pending}>
					{pending ? "Creating…" : "Create project"}
				</Button>
			</form>
			<section className="grid gap-3 rounded-lg border p-5">
				<h2 className="font-medium">Confirm brand and scenarios</h2>
				<Input
					placeholder="Confirmed brand name"
					value={profile.brandName}
					onChange={(event) => setProfile({ ...profile, brandName: event.target.value })}
				/>
				<Input
					placeholder="Primary public domain (https://…)"
					value={profile.primaryDomain}
					onChange={(event) => setProfile({ ...profile, primaryDomain: event.target.value })}
				/>
				<Input
					placeholder="Public profile URLs, comma separated"
					value={profile.publicProfiles}
					onChange={(event) => setProfile({ ...profile, publicProfiles: event.target.value })}
				/>
				<Input
					placeholder="Competitors, comma separated"
					value={profile.competitors}
					onChange={(event) => setProfile({ ...profile, competitors: event.target.value })}
				/>
				<textarea
					className="min-h-24 rounded-md border bg-background px-3 py-2 text-sm"
					placeholder="Approved scenarios, one per line"
					value={profile.scenarios}
					onChange={(event) => setProfile({ ...profile, scenarios: event.target.value })}
				/>
				{error && (
					<p role="alert" className="text-sm text-destructive">
						{error}
					</p>
				)}
				{projects.map((project) => (
					<Button
						key={project.id}
						type="button"
						variant="secondary"
						disabled={pending || !profile.brandName || !profile.primaryDomain || !profile.scenarios}
						onClick={() => void confirmProfile(project.id)}
					>
						Confirm for {project.name}
					</Button>
				))}
			</section>
			<section className="grid gap-3 rounded-lg border p-5">
				<h2 className="font-medium">Quote, order and test payment</h2>
				<p className="text-sm text-muted-foreground">Use IDs from the approved configuration. Test mode only.</p>
				<Input
					placeholder="Project ID"
					value={commerce.projectId}
					onChange={(event) => setCommerce({ ...commerce, projectId: event.target.value })}
				/>
				<Input
					placeholder="Configuration lock ID"
					value={commerce.lockId}
					onChange={(event) => setCommerce({ ...commerce, lockId: event.target.value })}
				/>
				<Input
					placeholder="Scenario IDs, comma separated"
					value={commerce.scenarioIds}
					onChange={(event) => setCommerce({ ...commerce, scenarioIds: event.target.value })}
				/>
				<div className="flex flex-wrap gap-2">
					<Button
						type="button"
						disabled={pending || !commerce.projectId || !commerce.lockId || !commerce.scenarioIds}
						onClick={() => void createQuote()}
					>
						Create quote
					</Button>
					<Button
						type="button"
						variant="secondary"
						disabled={pending || !commerce.quoteId}
						onClick={() => void createOrder()}
					>
						Create order
					</Button>
					<Button
						type="button"
						variant="secondary"
						disabled={pending || !commerce.orderId}
						onClick={() => void payTestOrder()}
					>
						Pay in test mode
					</Button>
				</div>
				{commerceMessage && (
					<p role="status" className="text-sm text-muted-foreground">
						{commerceMessage}
					</p>
				)}
			</section>
			<section className="grid gap-3">
				{projects.map((project) => (
					<article key={project.id} className="rounded-lg border p-4">
						<h2 className="font-medium">{project.name}</h2>
						<p className="text-sm text-muted-foreground">
							{project.category} · {project.country}
						</p>
						<Button
							type="button"
							variant="secondary"
							disabled={pending}
							onClick={() => void collectWebsite(project.id)}
						>
							Collect confirmed website
						</Button>
					</article>
				))}
				{projects.length === 0 && <p className="text-sm text-muted-foreground">No Selena projects yet.</p>}
				{websiteMessage && (
					<p role="status" className="text-sm text-muted-foreground">
						{websiteMessage}
					</p>
				)}
			</section>
			<section className="grid gap-3 rounded-lg border p-5">
				<h2 className="font-medium">Cycle dashboard</h2>
				<form onSubmit={loadDashboard} className="flex flex-col gap-3 sm:flex-row">
					<Input required placeholder="Cycle ID" value={cycleId} onChange={(event) => setCycleId(event.target.value)} />
					<Button type="submit" disabled={pending}>
						{pending ? "Loading…" : "Load dashboard"}
					</Button>
				</form>
				{dashboard ? (
					<div className="grid gap-2 text-sm">
						<p>Cycle status: {dashboard.cycle.status}</p>
						<p>Findings: {dashboard.findings.length}</p>
						<p>Recommendations: {dashboard.recommendations.length}</p>
						<p className="text-muted-foreground">Exports: CSV · PDF · XLSX</p>
					</div>
				) : (
					<p className="text-sm text-muted-foreground">
						Enter a cycle ID to view tenant-scoped findings and recommendations.
					</p>
				)}
			</section>
		</main>
	);
}
