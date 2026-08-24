import { Badge } from "@workspace/ui/components/badge";
import { Button } from "@workspace/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@workspace/ui/components/card";
import { Checkbox } from "@workspace/ui/components/checkbox";
import { Label } from "@workspace/ui/components/label";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	decideSelenaScenariosFn,
	getSelenaOrderDeskFn,
	prepareSelenaScenariosFn,
	startSelenaMeasurementFn,
} from "@/server/selena-order-desk";

// The desk that turns a confirmed brand profile into a running measurement.
// Approving the questions is the judgement; ordering, approving and queueing
// are one act on a decision already made, so they are one button — behind a
// confirmation that states the answer count and the ceiling, because this is
// where money starts moving.

type DeskProject = Awaited<ReturnType<typeof getSelenaOrderDeskFn>>[number];
type DeskScenario = DeskProject["scenarios"][number];
type DeskLocale = "en" | "ru";

/** Kept in step with the catalog plans an operator sells from this desk. */
const PLANS = [
	{ id: "visitor-local" as const, label: "Snapshot · $49/mo", systems: 3, repeats: 1, budgetCap: 12 },
	{ id: "full-ai-landscape" as const, label: "Landscape · $79/mo", systems: 8, repeats: 1, budgetCap: 28 },
	{ id: "expert-verified" as const, label: "Expert Verified · $399", systems: 8, repeats: 5, budgetCap: 140 },
];

function tr(locale: DeskLocale, english: string, russian: string): string {
	return locale === "ru" ? russian : english;
}

function statusTone(status: string): "default" | "secondary" | "outline" {
	if (status === "APPROVED") return "default";
	if (status === "REJECTED") return "outline";
	return "secondary";
}

export function SelenaOrderDesk({ locale, onOrderCreated }: { locale: DeskLocale; onOrderCreated: () => void }) {
	const [projects, setProjects] = useState<DeskProject[] | null>(null);
	const [projectId, setProjectId] = useState("");
	const [planId, setPlanId] = useState<(typeof PLANS)[number]["id"]>("visitor-local");
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [pending, setPending] = useState("");
	const [notice, setNotice] = useState("");
	const [error, setError] = useState("");
	// One key per attempt, so a retry after a failed request cannot bill twice.
	const [draftKey, setDraftKey] = useState(() => crypto.randomUUID());

	const load = useCallback(async () => {
		try {
			const desk = await getSelenaOrderDeskFn();
			setProjects(desk);
			setProjectId((current) => current || desk[0]?.id || "");
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Could not load the order desk");
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	const project = projects?.find((item) => item.id === projectId) ?? null;
	const plan = PLANS.find((item) => item.id === planId) ?? PLANS[0];

	useEffect(() => {
		// Approved scenarios are the default selection: the common case is
		// ordering exactly what was approved, not re-picking it by hand.
		setSelected(new Set(project?.scenarios.filter((s) => s.status === "APPROVED").map((s) => s.id) ?? []));
	}, [project]);

	const expectedRuns = useMemo(() => selected.size * plan.systems * plan.repeats, [selected, plan]);

	const run = async (label: string, action: () => Promise<string>) => {
		setPending(label);
		setError("");
		setNotice("");
		try {
			setNotice(await action());
			await load();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Action failed");
		} finally {
			setPending("");
		}
	};

	const toggle = (scenarioId: string) =>
		setSelected((current) => {
			const next = new Set(current);
			if (next.has(scenarioId)) next.delete(scenarioId);
			else next.add(scenarioId);
			return next;
		});

	const selectedApproved = (project?.scenarios ?? []).filter(
		(scenario) => selected.has(scenario.id) && scenario.status === "APPROVED",
	);

	return (
		<Card>
			<CardHeader>
				<CardTitle>{tr(locale, "Order a measurement", "Заказать замер")}</CardTitle>
				<CardDescription>
					{tr(
						locale,
						"Promote the confirmed profile questions into scenarios, approve the ones worth measuring, then order and start the measurement in one confirmed action. The order and its progress appear in the queue below.",
						"Перенесите вопросы подтверждённого профиля в сценарии, утвердите те, что стоит измерять, и одним подтверждённым действием оформите заказ и запустите замер. Заказ и его прогресс появятся в очереди ниже.",
					)}
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-5">
				{notice && (
					<p className="rounded-md border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
						{notice}
					</p>
				)}
				{error && (
					<p className="rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
						{error}
					</p>
				)}

				{projects === null ? (
					<p className="text-sm text-muted-foreground">{tr(locale, "Loading projects…", "Загружаем проекты…")}</p>
				) : projects.length === 0 ? (
					<p className="text-sm text-muted-foreground">
						{tr(locale, "No projects in this workspace yet.", "В этом пространстве ещё нет проектов.")}
					</p>
				) : (
					<>
						<div className="grid gap-4 sm:grid-cols-2">
							<div className="space-y-2">
								<Label htmlFor="desk-project">{tr(locale, "Project", "Проект")}</Label>
								<select
									id="desk-project"
									className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
									value={projectId}
									onChange={(event) => setProjectId(event.target.value)}
								>
									{projects.map((item) => (
										<option key={item.id} value={item.id}>
											{item.name}
										</option>
									))}
								</select>
							</div>
							<div className="space-y-2">
								<Label htmlFor="desk-plan">{tr(locale, "Plan", "Тариф")}</Label>
								<select
									id="desk-plan"
									className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
									value={planId}
									onChange={(event) => setPlanId(event.target.value as typeof planId)}
								>
									{PLANS.map((item) => (
										<option key={item.id} value={item.id}>
											{item.label}
										</option>
									))}
								</select>
							</div>
						</div>

						{project && (
							<div className="rounded-md border bg-muted/40 px-4 py-3 text-sm">
								<p className="font-medium">
									{project.brandName ?? project.name}
									{project.primaryDomain ? ` · ${project.primaryDomain}` : ""}
								</p>
								<p className="mt-1 text-muted-foreground">
									{project.profileConfirmedAt
										? tr(
												locale,
												`Profile confirmed · ${project.profileQuestions} question(s) on file · ${project.scenarios.length} scenario(s) prepared`,
												`Профиль подтверждён · вопросов в профиле: ${project.profileQuestions} · подготовлено сценариев: ${project.scenarios.length}`,
											)
										: tr(
												locale,
												"The customer has not confirmed a brand profile yet.",
												"Клиент ещё не подтвердил профиль бренда.",
											)}
								</p>
							</div>
						)}

						<div className="flex flex-wrap gap-3">
							<Button
								type="button"
								variant="outline"
								size="sm"
								disabled={!project?.profileConfirmedAt || pending !== ""}
								onClick={() =>
									run("prepare", async () => {
										const result = await prepareSelenaScenariosFn({ data: { projectId } });
										return tr(
											locale,
											`Prepared ${result.added} new scenario(s); ${result.total} on file.`,
											`Подготовлено новых сценариев: ${result.added}; всего: ${result.total}.`,
										);
									})
								}
							>
								{pending === "prepare"
									? tr(locale, "Preparing…", "Готовим…")
									: tr(locale, "Prepare scenarios from profile", "Подготовить сценарии из профиля")}
							</Button>
							<Button
								type="button"
								variant="outline"
								size="sm"
								disabled={selected.size === 0 || pending !== ""}
								onClick={() =>
									run("approve", async () => {
										const result = await decideSelenaScenariosFn({
											data: { projectId, scenarioIds: [...selected], decision: "APPROVED" },
										});
										return tr(
											locale,
											`Approved ${result.updated} scenario(s).`,
											`Утверждено сценариев: ${result.updated}.`,
										);
									})
								}
							>
								{tr(locale, "Approve selected", "Утвердить выбранные")}
							</Button>
							<Button
								type="button"
								variant="ghost"
								size="sm"
								disabled={selected.size === 0 || pending !== ""}
								onClick={() =>
									run("reject", async () => {
										const result = await decideSelenaScenariosFn({
											data: { projectId, scenarioIds: [...selected], decision: "REJECTED" },
										});
										return tr(
											locale,
											`Rejected ${result.updated} scenario(s).`,
											`Отклонено сценариев: ${result.updated}.`,
										);
									})
								}
							>
								{tr(locale, "Reject selected", "Отклонить выбранные")}
							</Button>
						</div>

						{project && project.scenarios.length > 0 && (
							<ul className="divide-y rounded-md border">
								{project.scenarios.map((scenario: DeskScenario) => (
									<li key={scenario.id} className="flex items-start gap-3 px-4 py-3">
										<Checkbox
											id={`scenario-${scenario.id}`}
											checked={selected.has(scenario.id)}
											onCheckedChange={() => toggle(scenario.id)}
											className="mt-1"
										/>
										<label htmlFor={`scenario-${scenario.id}`} className="flex-1 cursor-pointer text-sm">
											{scenario.text}
											<span className="ml-2 text-xs uppercase text-muted-foreground">{scenario.language}</span>
										</label>
										<Badge variant={statusTone(scenario.status)}>{scenario.status}</Badge>
									</li>
								))}
							</ul>
						)}

						<div className="flex flex-wrap items-center justify-between gap-4 rounded-md border bg-muted/40 px-4 py-3">
							<p className="text-sm">
								{tr(
									locale,
									`${selectedApproved.length} approved scenario(s) × ${plan.systems} system(s) × ${plan.repeats} repeat(s) = `,
									`Утверждённых сценариев: ${selectedApproved.length} × систем: ${plan.systems} × повторов: ${plan.repeats} = `,
								)}
								<strong>{selectedApproved.length * plan.systems * plan.repeats}</strong>{" "}
								{tr(locale, "planned answers", "запланированных ответов")}
								{selectedApproved.length !== selected.size && (
									<span className="ml-2 text-muted-foreground">
										{tr(
											locale,
											"(unapproved selections are excluded)",
											"(неутверждённые из выбранных не учитываются)",
										)}
									</span>
								)}
							</p>
							<Button
								type="button"
								disabled={selectedApproved.length === 0 || pending !== "" || expectedRuns === 0}
								onClick={() => {
									// The one place money starts moving, so the count and the
									// ceiling are stated before it does.
									const confirmed = window.confirm(
										tr(
											locale,
											`This orders and starts a measurement: ${expectedRuns} answers from AI providers, capped at $${plan.budgetCap}. Continue?`,
											`Это оформит заказ и запустит замер: ${expectedRuns} ответов от AI-провайдеров, потолок $${plan.budgetCap}. Продолжить?`,
										),
									);
									if (!confirmed) return;
									void run("order", async () => {
										const result = await startSelenaMeasurementFn({
											data: {
												projectId,
												planId,
												scenarioIds: selectedApproved.map((scenario) => scenario.id),
												idempotencyKey: draftKey,
											},
										});
										setDraftKey(crypto.randomUUID());
										onOrderCreated();
										if (result.stoppedAt === "payment")
											return tr(
												locale,
												"The order was created but the payment was not recorded, so nothing was started.",
												"Заказ создан, но платёж не зафиксирован — запуск не производился.",
											);
										if (result.stoppedAt === "execution")
											return tr(
												locale,
												"Ordered and approved, but execution is off: set SELENA_MEASUREMENT_ENABLED=true on web and worker. Nothing was queued.",
												"Заказ оформлен и одобрен, но исполнение выключено: поставьте SELENA_MEASUREMENT_ENABLED=true на web и worker. В очередь ничего не поставлено.",
											);
										return tr(
											locale,
											`Started: ${result.expectedRuns} answers ordered, ${result.approved?.permits ?? 0} permits issued, ${result.queued?.enqueued ?? 0} runs queued. Watch the count in the queue below.`,
											`Запущено: заказано ответов ${result.expectedRuns}, выпущено разрешений ${result.approved?.permits ?? 0}, поставлено в очередь ${result.queued?.enqueued ?? 0}. Следите за счётчиком в очереди ниже.`,
										);
									});
								}}
							>
								{pending === "order"
									? tr(locale, "Starting…", "Запускаем…")
									: tr(locale, "Order and start the measurement", "Заказать и запустить замер")}
							</Button>
						</div>
					</>
				)}
			</CardContent>
		</Card>
	);
}
