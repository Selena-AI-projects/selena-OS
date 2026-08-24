import { IconChecklist, IconChartBar, IconPlayerPlay } from "@tabler/icons-react";
import { Button } from "@workspace/ui/components/button";
import { Checkbox } from "@workspace/ui/components/checkbox";
import { useCallback, useEffect, useRef, useState } from "react";
import { decideSelenaScenariosFn, prepareSelenaScenariosFn, startSelenaMeasurementFn } from "@/server/selena-order-desk";
import { getSelenaMeasureFlowFn } from "@/server/selena-measure-flow";

// Steps 2–4 of the four-step client flow (docs/selena-visibility/CLIENT_FLOW.md):
// questions → one launch button → results. Step 1 is the brand profile form
// above this component. No internal vocabulary reaches the screen — the
// customer sees questions, a progress count, and findings.

type FlowLocale = "en" | "ru";
type FlowData = Awaited<ReturnType<typeof getSelenaMeasureFlowFn>>;
type FlowScenario = FlowData["scenarios"][number];

/** Mirrors the catalog; the confirm dialog states the cap before money moves. */
const PLANS = [
	{ id: "visitor-local" as const, price: "$49", nameEn: "Snapshot", nameRu: "Snapshot", systems: 3, repeats: 1, budgetCap: 12 },
	{ id: "full-ai-landscape" as const, price: "$79", nameEn: "Landscape", nameRu: "Landscape", systems: 8, repeats: 1, budgetCap: 28 },
	{ id: "expert-verified" as const, price: "$399", nameEn: "Expert Verified", nameRu: "Expert Verified", systems: 8, repeats: 5, budgetCap: 140 },
];

/** Cycle states that still change on their own, so the screen keeps polling. */
const IN_FLIGHT = ["CREATED", "APPROVED", "QUEUED", "RUNNING", "ANALYZING"];
const POLL_MS = 5000;

function tr(locale: FlowLocale, english: string, russian: string): string {
	return locale === "ru" ? russian : english;
}

/** Never renders a confident number for an unknown: null is stated as such. */
function formatShare(locale: FlowLocale, value: number | null): string {
	return value === null ? tr(locale, "UNKNOWN", "НЕИЗВЕСТНО") : `${Math.round(value * 100)}%`;
}

function progressLabel(locale: FlowLocale, measurement: NonNullable<FlowData["measurement"]>): string {
	const { cycleStatus, orderStatus } = measurement;
	if (cycleStatus === "READY") return tr(locale, "Done", "Готово");
	if (cycleStatus === "STOPPED") return tr(locale, "Stopped", "Остановлен");
	if (cycleStatus === "FAILED") return tr(locale, "Failed — the operator has been notified", "Ошибка — оператор уведомлён");
	if (cycleStatus === "QC_REQUIRED" || cycleStatus === "CARDINALITY_INCIDENT")
		return tr(locale, "Under operator review", "На проверке у оператора");
	if (cycleStatus && IN_FLIGHT.includes(cycleStatus))
		return cycleStatus === "RUNNING" || cycleStatus === "ANALYZING"
			? tr(locale, "Measuring…", "Замер идёт…")
			: tr(locale, "Queued", "В очереди");
	if (orderStatus === "AWAITING_PAYMENT") return tr(locale, "Awaiting payment", "Ждёт оплаты");
	if (orderStatus === "PAID_REVIEW_REQUIRED") return tr(locale, "Awaiting operator confirmation", "Ждёт подтверждения оператора");
	return tr(locale, "Queued", "В очереди");
}

export function SelenaMeasureFlow({
	locale,
	projectId,
	profileConfirmed,
}: {
	locale: FlowLocale;
	projectId: string;
	profileConfirmed: boolean;
}) {
	const [data, setData] = useState<FlowData | null>(null);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [planId, setPlanId] = useState<(typeof PLANS)[number]["id"]>("visitor-local");
	const [pending, setPending] = useState("");
	const [notice, setNotice] = useState("");
	const [error, setError] = useState("");
	// One key per attempt, so a retry after a failed request cannot bill twice.
	const [draftKey, setDraftKey] = useState(() => crypto.randomUUID());
	// The full analysis re-reads every answer; ask for it once, not per tick.
	const summaryRequested = useRef(false);

	const load = useCallback(
		async (withSummary = false) => {
			try {
				const result = await getSelenaMeasureFlowFn({
					data: withSummary ? { projectId, withSummary: true } : { projectId },
				});
				setData(result);
				setSelected(new Set(result.scenarios.filter((s) => s.status === "APPROVED").map((s) => s.id)));
			} catch (cause) {
				setError(cause instanceof Error ? cause.message : tr(locale, "Could not load", "Не удалось загрузить"));
			}
		},
		[projectId, locale],
	);

	useEffect(() => {
		summaryRequested.current = false;
		setData(null);
		setNotice("");
		setError("");
		void load();
	}, [load]);

	useEffect(() => {
		const measurement = data?.measurement;
		if (!measurement) return;
		const finished = measurement.expectedRuns > 0 && measurement.completedRuns >= measurement.expectedRuns;
		if (finished && !data.summary && !summaryRequested.current) {
			summaryRequested.current = true;
			void load(true);
			return;
		}
		if (finished || !measurement.cycleStatus || !IN_FLIGHT.includes(measurement.cycleStatus)) return;
		const timer = setTimeout(() => void load(), POLL_MS);
		return () => clearTimeout(timer);
	}, [data, load]);

	const run = async (label: string, action: () => Promise<string>) => {
		setPending(label);
		setError("");
		setNotice("");
		try {
			setNotice(await action());
			await load();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : tr(locale, "Action failed", "Действие не выполнено"));
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

	const scenarios = (data?.scenarios ?? []).filter((s: FlowScenario) => s.status !== "REJECTED");
	const approved = scenarios.filter((s) => s.status === "APPROVED");
	const plan = PLANS.find((item) => item.id === planId) ?? PLANS[0];
	const expectedRuns = approved.length * plan.systems * plan.repeats;
	const measurement = data?.measurement ?? null;
	const summary = data?.summary?.summary ?? null;

	return (
		<section className="selena-section" aria-labelledby="measure-flow-title">
			<div className="flex gap-4">
				<div className="selena-icon-disc">
					<IconChecklist className="size-5" />
				</div>
				<div className="min-w-0 flex-1">
					<h2 id="measure-flow-title" className="selena-heading text-2xl">
						{tr(locale, "AI visibility measurement", "Замер видимости в AI")}
					</h2>
					<p className="mt-2 text-sm leading-6 text-[#6e6258]">
						{tr(
							locale,
							"Approve the questions, start the measurement, read the results — all on this page.",
							"Утвердите вопросы, запустите замер и читайте результаты — всё на этой странице.",
						)}
					</p>
				</div>
			</div>

			<ol className="mt-5 flex flex-wrap gap-x-6 gap-y-2 text-xs font-semibold text-[#6e6258]">
				{[
					{ n: 1, label: tr(locale, "Business", "Бизнес"), done: profileConfirmed },
					{ n: 2, label: tr(locale, "Questions", "Вопросы"), done: approved.length > 0 },
					{ n: 3, label: tr(locale, "Run", "Замер"), done: measurement !== null },
					{
						n: 4,
						label: tr(locale, "Results", "Результаты"),
						done: summary !== null || measurement?.cycleStatus === "READY",
					},
				].map((step) => (
					<li key={step.n} className={step.done ? "text-[#2f6b3a]" : undefined}>
						{step.n}. {step.label}
						{step.done ? " ✓" : ""}
					</li>
				))}
			</ol>

			{notice && (
				<p className="mt-4 rounded-md border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
					{notice}
				</p>
			)}
			{error && (
				<p className="mt-4 rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
					{error}
				</p>
			)}

			{/* Step 2 — questions */}
			<div className="mt-6 border-t border-[#e6ddd1] pt-5">
				<h3 className="text-sm font-semibold text-[#181614]">
					{tr(locale, "Step 2 · The questions customers ask", "Шаг 2 · Вопросы, которые задают клиенты")}
				</h3>
				{!profileConfirmed ? (
					<p className="mt-3 text-sm text-[#9a5f14]">
						{tr(
							locale,
							"Confirm the brand profile above first — the questions are built from it.",
							"Сначала подтвердите профиль бренда выше — вопросы строятся из него.",
						)}
					</p>
				) : (
					<>
						<div className="mt-3 flex flex-wrap gap-3">
							<Button
								type="button"
								variant="outline"
								size="sm"
								className="border-[#cdbdac] bg-[#fffdf8]"
								disabled={pending !== ""}
								onClick={() =>
									run("prepare", async () => {
										const result = await prepareSelenaScenariosFn({ data: { projectId } });
										return tr(
											locale,
											`Added ${result.added} new question(s); ${result.total} total.`,
											`Добавлено новых вопросов: ${result.added}; всего: ${result.total}.`,
										);
									})
								}
							>
								{pending === "prepare"
									? tr(locale, "Preparing…", "Готовим…")
									: tr(locale, "Suggest questions from my profile", "Подобрать вопросы из профиля")}
							</Button>
							<Button
								type="button"
								size="sm"
								disabled={selected.size === 0 || pending !== ""}
								onClick={() =>
									run("approve", async () => {
										const result = await decideSelenaScenariosFn({
											data: { projectId, scenarioIds: [...selected], decision: "APPROVED" },
										});
										return tr(
											locale,
											`Approved ${result.updated} question(s).`,
											`Утверждено вопросов: ${result.updated}.`,
										);
									})
								}
							>
								{pending === "approve"
									? tr(locale, "Approving…", "Утверждаем…")
									: tr(locale, "Approve checked questions", "Утвердить отмеченные вопросы")}
							</Button>
						</div>
						{scenarios.length > 0 ? (
							<ul className="mt-4 divide-y divide-[#e6ddd1] rounded-xl border border-[#e6ddd1]">
								{scenarios.map((scenario) => (
									<li key={scenario.id} className="flex items-start gap-3 px-4 py-3">
										<Checkbox
											id={`flow-scenario-${scenario.id}`}
											checked={selected.has(scenario.id)}
											onCheckedChange={() => toggle(scenario.id)}
											className="mt-1"
										/>
										<label htmlFor={`flow-scenario-${scenario.id}`} className="flex-1 cursor-pointer text-sm">
											{scenario.text}
											<span className="ml-2 text-xs uppercase text-[#6e6258]">{scenario.language}</span>
										</label>
										{scenario.status === "APPROVED" && (
											<span className="text-xs font-semibold text-[#2f6b3a]">{tr(locale, "Approved", "Утверждён")}</span>
										)}
									</li>
								))}
							</ul>
						) : (
							<p className="mt-3 text-sm text-[#6e6258]">
								{tr(
									locale,
									"No questions yet — press the button above and we will suggest them from your profile.",
									"Вопросов пока нет — нажмите кнопку выше, и мы подберём их из вашего профиля.",
								)}
							</p>
						)}
					</>
				)}
			</div>

			{/* Step 3 — one launch button */}
			<div className="mt-6 border-t border-[#e6ddd1] pt-5">
				<h3 className="flex items-center gap-2 text-sm font-semibold text-[#181614]">
					<IconPlayerPlay className="size-4" />
					{tr(locale, "Step 3 · Start the measurement", "Шаг 3 · Запустить замер")}
				</h3>
				<fieldset className="mt-3 grid gap-3 sm:grid-cols-3">
					<legend className="sr-only">{tr(locale, "Plan", "Тариф")}</legend>
					{PLANS.map((item) => (
						<label
							key={item.id}
							className={`cursor-pointer rounded-xl border px-4 py-3 text-sm ${
								planId === item.id ? "border-[#8f5c34] bg-[#fffdf8]" : "border-[#e6ddd1]"
							}`}
						>
							<input
								type="radio"
								name="flow-plan"
								value={item.id}
								checked={planId === item.id}
								onChange={() => setPlanId(item.id)}
								className="sr-only"
							/>
							<span className="font-semibold text-[#181614]">
								{tr(locale, item.nameEn, item.nameRu)} · {item.price}
							</span>
							<span className="mt-1 block text-xs text-[#6e6258]">
								{tr(
									locale,
									`${item.systems} AI system(s) × ${item.repeats} repeat(s)`,
									`Систем AI: ${item.systems} × повторов: ${item.repeats}`,
								)}
							</span>
						</label>
					))}
				</fieldset>
				<div className="mt-4 flex flex-wrap items-center justify-between gap-4">
					<p className="text-sm text-[#6e6258]">
						{tr(
							locale,
							`${approved.length} approved question(s) × ${plan.systems} system(s) × ${plan.repeats} repeat(s) = `,
							`Утверждённых вопросов: ${approved.length} × систем: ${plan.systems} × повторов: ${plan.repeats} = `,
						)}
						<strong className="text-[#181614]">{expectedRuns}</strong> {tr(locale, "answers", "ответов")}
					</p>
					{data?.canStart ? (
						<Button
							type="button"
							disabled={approved.length === 0 || expectedRuns === 0 || pending !== ""}
							onClick={() => {
								// The one place money starts moving, so the count and the
								// ceiling are stated before it does.
								const confirmed = window.confirm(
									tr(
										locale,
										`This starts a measurement: ${expectedRuns} answers from AI providers, capped at $${plan.budgetCap}. Continue?`,
										`Это запустит замер: ${expectedRuns} ответов от AI-провайдеров, потолок $${plan.budgetCap}. Продолжить?`,
									),
								);
								if (!confirmed) return;
								void run("start", async () => {
									const result = await startSelenaMeasurementFn({
										data: {
											projectId,
											planId,
											scenarioIds: approved.map((scenario) => scenario.id),
											idempotencyKey: draftKey,
										},
									});
									setDraftKey(crypto.randomUUID());
									summaryRequested.current = false;
									if (result.stoppedAt === "payment")
										return tr(
											locale,
											"The order was created but the payment was not recorded, so nothing was started.",
											"Заказ создан, но платёж не зафиксирован — запуск не производился.",
										);
									if (result.stoppedAt === "execution")
										return tr(
											locale,
											"Ordered, but execution is switched off on the server. Nothing was started.",
											"Заказ оформлен, но исполнение выключено на сервере. Запуск не производился.",
										);
									return tr(
										locale,
										`Started: ${result.expectedRuns} answers are being collected. Watch the progress below.`,
										`Запущено: собираем ${result.expectedRuns} ответов. Следите за прогрессом ниже.`,
									);
								});
							}}
						>
							{pending === "start"
								? tr(locale, "Starting…", "Запускаем…")
								: tr(locale, "Start the measurement", "Запустить замер")}
						</Button>
					) : (
						<p className="text-sm text-[#9a5f14]">
							{tr(
								locale,
								"The operator starts the measurement after payment — you will see the progress here.",
								"Замер запускает оператор после оплаты — прогресс появится здесь.",
							)}
						</p>
					)}
				</div>
			</div>

			{/* Step 4 — results */}
			<div className="mt-6 border-t border-[#e6ddd1] pt-5">
				<h3 className="flex items-center gap-2 text-sm font-semibold text-[#181614]">
					<IconChartBar className="size-4" />
					{tr(locale, "Step 4 · Results", "Шаг 4 · Результаты")}
				</h3>
				{!measurement ? (
					<p className="mt-3 text-sm text-[#6e6258]">
						{tr(locale, "No measurement has run yet.", "Замер ещё не запускался.")}
					</p>
				) : (
					<>
						<p className="mt-3 text-sm text-[#6e6258]">
							{progressLabel(locale, measurement)}
							{measurement.expectedRuns > 0 && (
								<>
									{" · "}
									{tr(
										locale,
										`${measurement.completedRuns} of ${measurement.expectedRuns} answers checked`,
										`проверено ответов: ${measurement.completedRuns} из ${measurement.expectedRuns}`,
									)}
								</>
							)}
						</p>
						{summary && (
							<div className="mt-4 space-y-5">
								<dl className="grid gap-5 border-y border-[#e6ddd1] py-5 sm:grid-cols-4">
									<div>
										<dt className="text-xs font-medium text-[#6e6258]">
											{tr(locale, "Answers analyzed", "Проанализировано ответов")}
										</dt>
										<dd className="mt-1 text-2xl font-semibold text-[#181614]">{summary.answersAnalyzed}</dd>
									</div>
									<div>
										<dt className="text-xs font-medium text-[#6e6258]">
											{tr(locale, "Brand mentioned", "Бренд упомянут")}
										</dt>
										<dd className="mt-1 text-2xl font-semibold text-[#181614]">
											{formatShare(locale, summary.brandMentionRate)}
										</dd>
									</div>
									<div>
										<dt className="text-xs font-medium text-[#6e6258]">
											{tr(locale, "Share of voice", "Доля голоса")}
										</dt>
										<dd className="mt-1 text-2xl font-semibold text-[#181614]">
											{formatShare(locale, summary.brandShareOfVoice)}
										</dd>
									</div>
									<div>
										<dt className="text-xs font-medium text-[#6e6258]">
											{tr(locale, "Average position", "Средняя позиция")}
										</dt>
										<dd className="mt-1 text-2xl font-semibold text-[#181614]">
											{summary.brandAverageOrder === null
												? tr(locale, "UNKNOWN", "НЕИЗВЕСТНО")
												: summary.brandAverageOrder.toFixed(1)}
										</dd>
									</div>
								</dl>
								{summary.competitors.length > 0 && (
									<div>
										<h4 className="text-sm font-semibold text-[#181614]">
											{tr(locale, "Competitors in the answers", "Конкуренты в ответах")}
										</h4>
										<ul className="mt-2 divide-y divide-[#e6ddd1]">
											{summary.competitors.slice(0, 5).map((competitor) => (
												<li key={competitor.name} className="flex items-baseline justify-between gap-4 py-2 text-sm">
													<span className="font-medium text-[#181614]">{competitor.name}</span>
													<span className="text-[#6e6258]">
														{tr(
															locale,
															`in ${competitor.answersMentioned} answer(s) · avg. position ${competitor.averageOrder.toFixed(1)}`,
															`в ответах: ${competitor.answersMentioned} · средняя позиция ${competitor.averageOrder.toFixed(1)}`,
														)}
													</span>
												</li>
											))}
										</ul>
									</div>
								)}
								{summary.citationGap.length > 0 && (
									<div>
										<h4 className="text-sm font-semibold text-[#181614]">
											{tr(locale, "Sources the AI answers rely on", "Источники, на которые опираются ответы AI")}
										</h4>
										<p className="mt-1 text-xs text-[#6e6258]">
											{tr(
												locale,
												"“Without you” counts answers that cited the source, named a competitor, and did not name you.",
												"«Без вас» — ответы, где источник цитировался, конкурент назван, а вы — нет.",
											)}
										</p>
										<ul className="mt-2 divide-y divide-[#e6ddd1]">
											{summary.citationGap.slice(0, 5).map((entry) => (
												<li key={entry.domain} className="flex items-baseline justify-between gap-4 py-2 text-sm">
													<span className="font-medium text-[#181614]">
														{entry.domain}
														{entry.ownedByBrand && (
															<span className="ml-2 text-xs text-[#2f6b3a]">{tr(locale, "your site", "ваш сайт")}</span>
														)}
													</span>
													<span className="text-[#6e6258]">
														{tr(
															locale,
															`cited ${entry.timesCited}× · without you ${entry.timesCitedWithoutBrand}×`,
															`цитируется ${entry.timesCited} раз · без вас ${entry.timesCitedWithoutBrand}`,
														)}
													</span>
												</li>
											))}
										</ul>
									</div>
								)}
							</div>
						)}
					</>
				)}
			</div>
		</section>
	);
}
