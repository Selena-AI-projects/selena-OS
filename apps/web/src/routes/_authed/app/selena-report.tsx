/**
 * /app/selena-report — the customer-facing grader report, one screen for both
 * paid plans: the plan only decides which sections have data. Layout follows
 * docs/selena-visibility/REPORT_DESIGN_SPEC.md and the approved mockup; every
 * empty group renders UNKNOWN, never zero, and no composite score exists.
 */
import { Link, createFileRoute } from "@tanstack/react-router";
import { Button } from "@workspace/ui/components/button";
import { useEffect, useState } from "react";
import { z } from "zod";
import { getSelenaWorkspaceFn } from "../../../server/selena-client";
import { type CycleCompareResult, getSelenaCycleCompareFn } from "../../../server/selena-cycle-compare";
import { type GraderReportView, getSelenaGraderReportFn } from "../../../server/selena-grader-report";
import { getSelenaRunDetailFn } from "../../../server/selena-run-explorer";

export const Route = createFileRoute("/_authed/app/selena-report")({
	validateSearch: z.object({ project: z.string().uuid().optional() }),
	loader: () => getSelenaWorkspaceFn(),
	component: SelenaReportPage,
});

type ReportLocale = "en" | "ru";

function tr(locale: ReportLocale, english: string, russian: string): string {
	return locale === "ru" ? russian : english;
}

/** Null never becomes a number: an empty group is stated as UNKNOWN. */
function pct(locale: ReportLocale, value: number | null): string {
	return value === null ? tr(locale, "UNKNOWN", "НЕИЗВЕСТНО") : `${Math.round(value * 100)}%`;
}

const SYSTEM_LABELS: Record<string, string> = {
	"anthropic/claude-haiku-4.5": "Claude",
	"deepseek/deepseek-v3.2": "DeepSeek",
	"qwen/qwen3.5-9b": "Qwen",
	"mistralai/mistral-small-2603": "Mistral",
	"x-ai/grok-4.5": "Grok",
};

function systemLabel(locale: ReportLocale, systemId: string): string {
	if (systemId === "unattributed") return tr(locale, "System not recorded", "Система не записана");
	return SYSTEM_LABELS[systemId] ?? systemId;
}

const PLAN_LABELS: Record<string, string> = {
	"visitor-local": "Snapshot · $49",
	"full-ai-landscape": "Landscape · $79",
	"expert-verified": "Expert Verified · $399",
};

/** Validated against the light surface (CVD-checked); "others" is a labeled neutral. */
const DONUT_COLORS = ["#b25c1f", "#0a8a66", "#d99a00", "#3d6fbf"];
const DONUT_OTHER = "#cdc3b4";

function Ring({ fraction, label, caption }: { fraction: number | null; label: string; caption: string }) {
	const circumference = 2 * Math.PI * 54;
	const filled = fraction === null ? 0 : Math.max(0, Math.min(1, fraction)) * circumference;
	return (
		<div className="flex items-center gap-3">
			<svg width="72" height="72" viewBox="0 0 120 120" role="img" aria-label={`${label} — ${caption}`}>
				<circle cx="60" cy="60" r="54" fill="none" stroke="#ece4d7" strokeWidth="11" />
				{filled > 0 && (
					<circle
						cx="60"
						cy="60"
						r="54"
						fill="none"
						stroke="#b25c1f"
						strokeWidth="11"
						strokeLinecap="round"
						strokeDasharray={`${filled} ${circumference}`}
						transform="rotate(-90 60 60)"
					/>
				)}
			</svg>
			<div>
				<div className="text-xl font-semibold tabular-nums text-[#181614]">{label}</div>
				<div className="text-xs text-[#6e6258]">{caption}</div>
			</div>
		</div>
	);
}

function SectionCard({ children }: { children: React.ReactNode }) {
	return <section className="selena-section">{children}</section>;
}

function SectionTitle({ title, lead }: { title: string; lead?: string }) {
	return (
		<div>
			<h2 className="selena-heading text-2xl">{title}</h2>
			{lead && <p className="mt-2 max-w-2xl text-sm leading-6 text-[#6e6258]">{lead}</p>}
		</div>
	);
}

function SelenaReportPage() {
	const { projects } = Route.useLoaderData();
	const search = Route.useSearch();
	const [locale, setLocale] = useState<ReportLocale>("en");
	const projectId = search.project ?? projects[0]?.project.id ?? "";
	const [view, setView] = useState<GraderReportView | null>(null);
	const [compare, setCompare] = useState<CycleCompareResult | null>(null);
	const [failed, setFailed] = useState(false);
	const [answers, setAnswers] = useState<Record<string, { loading: boolean; text: string | null }>>({});

	useEffect(() => {
		const saved = window.localStorage.getItem("selena-workspace-locale");
		setLocale(saved === "ru" || saved === "en" ? saved : navigator.language.startsWith("ru") ? "ru" : "en");
	}, []);

	useEffect(() => {
		if (!projectId) return;
		let cancelled = false;
		setView(null);
		setFailed(false);
		getSelenaGraderReportFn({ data: { projectId } })
			.then((data) => {
				if (!cancelled) setView(data);
			})
			.catch(() => {
				if (!cancelled) setFailed(true);
			});
		getSelenaCycleCompareFn({ data: { projectId } })
			.then((data) => {
				if (!cancelled) setCompare(data);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [projectId]);

	const openAnswer = async (runId: string) => {
		if (answers[runId]) {
			setAnswers((current) => {
				const next = { ...current };
				delete next[runId];
				return next;
			});
			return;
		}
		setAnswers((current) => ({ ...current, [runId]: { loading: true, text: null } }));
		try {
			const detail = await getSelenaRunDetailFn({ data: { runId } });
			const text =
				detail.answer.state === "present"
					? detail.answer.text
					: detail.answer.state === "deleted"
						? tr(locale, "The answer text passed its retention window and was deleted; the findings above remain.", "Текст ответа удалён по сроку хранения; извлечённые факты сохранены.")
						: tr(locale, "No answer text was stored for this run.", "Текст ответа для этого прогона не сохранялся.");
			setAnswers((current) => ({ ...current, [runId]: { loading: false, text } }));
		} catch {
			setAnswers((current) => ({
				...current,
				[runId]: { loading: false, text: tr(locale, "Could not load the answer.", "Не удалось загрузить ответ.") },
			}));
		}
	};

	const report = view?.report ?? null;
	const visitorSystems = report?.systems.filter((system) => system.channel === "VISITOR") ?? [];
	const apiSystems = report?.systems.filter((system) => system.channel === "API") ?? [];
	const rosterTotal = report?.roster.reduce((total, entry) => total + entry.answersMentioned, 0) ?? 0;
	const planLabel = view?.planId ? (PLAN_LABELS[view.planId] ?? view.planId) : null;

	return (
		<div className="selena-app min-h-screen bg-[#f7f2ea] pb-16 text-[#181614]">
			<header className="bg-[#221f1b] text-[#f2e9df] print:hidden">
				<div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-5 py-3">
					<Link to="/app/selena" className="text-sm underline underline-offset-4">
						← {tr(locale, "Back to cabinet", "Назад в кабинет")}
					</Link>
					<Button type="button" className="bg-[#8f5c34] text-[#fff7ee] hover:bg-[#7c4e2b]" onClick={() => window.print()}>
						{tr(locale, "Download report (PDF)", "Скачать отчёт (PDF)")}
					</Button>
				</div>
			</header>

			<section className="relative overflow-hidden bg-[#221f1b] text-[#f2e9df]">
				<div className="pointer-events-none absolute -top-24 -right-16 h-72 w-72 rounded-full border border-[#b9825b59]" />
				<div className="mx-auto max-w-5xl px-5 pb-12 pt-10">
					<p className="text-xs font-bold uppercase tracking-[0.18em] text-[#b9825b]">
						{tr(locale, "AI visibility report", "Отчёт о видимости в AI")}
						{planLabel ? ` · ${planLabel}` : ""}
					</p>
					<h1 className="selena-heading mt-3 text-4xl text-[#faf5ec]">{view?.inputs?.brandName || view?.project.name || "…"}</h1>
					<p className="mt-3 max-w-2xl text-sm text-[#cfc4b6]">
						{[view?.project.region, view?.project.country].filter(Boolean).join(", ")}
					</p>
					<div className="mt-4 flex flex-wrap gap-2 text-xs">
						{view?.cycle && (
							<span className="rounded-full border border-[#b9825b66] px-3 py-1.5 tabular-nums">
								{tr(
									locale,
									`${view.cycle.completedRuns} of ${view.cycle.expectedRuns} answers checked`,
									`проверено ответов: ${view.cycle.completedRuns} из ${view.cycle.expectedRuns}`,
								)}
							</span>
						)}
						{report && (
							<span className="rounded-full border border-[#b9825b66] px-3 py-1.5 tabular-nums">
								{tr(
									locale,
									`${report.methodology.questions} question(s) you approved`,
									`вопросов, утверждённых вами: ${report.methodology.questions}`,
								)}
							</span>
						)}
						{view?.measuredAt && (
							<span className="rounded-full border border-[#b9825b66] px-3 py-1.5">
								{tr(locale, "Measured", "Замер")}: {new Date(view.measuredAt).toLocaleDateString(locale === "ru" ? "ru-RU" : "en-US")}
							</span>
						)}
					</div>
				</div>
			</section>

			<main className="mx-auto mt-7 flex max-w-5xl flex-col gap-6 px-5">
				{failed && (
					<SectionCard>
						<p className="text-sm text-[#9a5f14]">{tr(locale, "Could not load the report.", "Не удалось загрузить отчёт.")}</p>
					</SectionCard>
				)}
				{!failed && view === null && (
					<SectionCard>
						<p className="text-sm text-[#6e6258]">{tr(locale, "Loading the report…", "Загружаем отчёт…")}</p>
					</SectionCard>
				)}

				{view?.inputs && (
					<SectionCard>
						<SectionTitle
							title={tr(locale, "What you provided", "Что вы ввели")}
							lead={tr(
								locale,
								"Three fields are enough to start. Instagram and a Google Maps link are optional and help the check find exactly your business.",
								"Для запуска хватает трёх полей. Instagram и ссылка на Google Maps — по желанию: с ними проверка точнее находит именно ваше заведение.",
							)}
						/>
						<div className="mt-4 grid gap-3 sm:grid-cols-3">
							<div className="rounded-xl border border-[#e6ddd1] bg-[#fffdf8] px-4 py-2.5">
								<p className="text-[0.68rem] font-bold uppercase tracking-wider text-[#6e6258]">{tr(locale, "Name", "Название")}</p>
								<p className="mt-0.5 font-semibold">{view.inputs.brandName}</p>
							</div>
							<div className="rounded-xl border border-[#e6ddd1] bg-[#fffdf8] px-4 py-2.5">
								<p className="text-[0.68rem] font-bold uppercase tracking-wider text-[#6e6258]">{tr(locale, "Website", "Сайт")}</p>
								<p className="mt-0.5 font-semibold">{view.inputs.primaryDomain}</p>
							</div>
							<div className="rounded-xl border border-[#e6ddd1] bg-[#fffdf8] px-4 py-2.5">
								<p className="text-[0.68rem] font-bold uppercase tracking-wider text-[#6e6258]">{tr(locale, "Location", "Локация")}</p>
								<p className="mt-0.5 font-semibold">{[view.project.region, view.project.country].filter(Boolean).join(", ") || "—"}</p>
							</div>
						</div>
						{view.inputs.publicProfiles.length > 0 && (
							<div className="mt-3 flex flex-wrap gap-2">
								{view.inputs.publicProfiles.map((url) => (
									<span key={url} className="rounded-full border border-[#cdbdac] bg-[#fffdf8] px-3.5 py-1.5 text-xs text-[#3d362e]">
										✓ {url}
									</span>
								))}
							</div>
						)}
					</SectionCard>
				)}

				{view && !report && !failed && (
					<SectionCard>
						<SectionTitle title={tr(locale, "No measurement yet", "Замер ещё не выполнялся")} />
						<p className="mt-3 text-sm text-[#6e6258]">
							{tr(
								locale,
								"Order a measurement to fill this report with observed data.",
								"Закажите замер — и этот отчёт наполнится наблюдёнными данными.",
							)}
						</p>
						<Link to="/app/selena-order" search={{ project: projectId }} className="mt-4 inline-block print:hidden">
							<Button type="button">{tr(locale, "Order a measurement", "Заказать замер")}</Button>
						</Link>
					</SectionCard>
				)}

				{report && (
					<>
						<SectionCard>
							<SectionTitle
								title={tr(locale, "How this was measured", "Как проверялось")}
								lead={tr(
									locale,
									"Printed from the actual measurement configuration: how many questions, how many repeats, and which method asked each question.",
									"Печатается из фактической конфигурации замера: сколько вопросов, сколько повторов и каким способом задан каждый вопрос.",
								)}
							/>
							<div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
								{[
									[String(report.methodology.questions), tr(locale, "questions · approved by you", "вопросов · утверждены вами")],
									[
										String(report.methodology.visitorSystems + report.methodology.apiSystems),
										report.methodology.apiSystems > 0
											? tr(
													locale,
													`AI systems: ${report.methodology.visitorSystems} Visitor + ${report.methodology.apiSystems} API`,
													`AI-систем: ${report.methodology.visitorSystems} Visitor + ${report.methodology.apiSystems} API`,
												)
											: tr(locale, "AI systems · Visitor View", "AI-систем · Visitor View"),
									],
									[`×${report.methodology.repeats}`, tr(locale, "repeat(s) per question per system", "повторов на вопрос в системе")],
									[
										String(report.methodology.answersExpected),
										tr(locale, "answers in this cycle", "ответов в этом замере"),
									],
								].map(([value, caption]) => (
									<div key={caption} className="rounded-xl border border-[#e6ddd1] bg-[#fffdf8] px-4 py-3">
										<p className="selena-heading text-2xl tabular-nums">{value}</p>
										<p className="text-xs text-[#6e6258]">{caption}</p>
									</div>
								))}
							</div>
							<div className="mt-4 grid gap-3">
								<div className="flex items-start gap-3 rounded-xl border border-[#e6ddd1] bg-[#fffdf8] p-4 text-sm">
									<span className="shrink-0 rounded-full bg-[#efe3d7] px-3 py-1 text-[0.7rem] font-bold tracking-wide text-[#8f5c34]">VISITOR VIEW</span>
									<p>
										{tr(
											locale,
											"Through a live visitor's eyes: the question is asked in the user-facing service, the way a real customer sees it.",
											"Глазами живого посетителя: вопрос задаётся в пользовательском сервисе — так, как его видит реальный клиент.",
										)}
									</p>
								</div>
								<div className="flex items-start gap-3 rounded-xl border border-[#e6ddd1] bg-[#fffdf8] p-4 text-sm">
									<span className="shrink-0 rounded-full bg-[#e8e4dc] px-3 py-1 text-[0.7rem] font-bold tracking-wide text-[#6e6258]">API VIEW</span>
									<p>
										{tr(
											locale,
											"The model's own knowledge: the question goes straight to the model over the API — no web search, no hints.",
											"Внутреннее знание модели: вопрос задаётся модели напрямую через API — без веб-поиска и без подсказок.",
										)}
									</p>
								</div>
							</div>
							{report.methodology.answersMissing > 0 && (
								<p className="mt-3 text-xs text-[#9a5f14]">
									{tr(
										locale,
										`${report.methodology.answersMissing} run(s) have no analyzable answer yet (queued or failed); they are counted as missing, not as zeros.`,
										`Прогонов без разобранного ответа: ${report.methodology.answersMissing} (в очереди или с ошибкой) — они считаются отсутствующими, а не нулями.`,
									)}
								</p>
							)}
						</SectionCard>

						{[
							{ list: visitorSystems, title: tr(locale, "How AI systems see you — Visitor View", "Как вас видят AI-системы — Visitor View") },
							{ list: apiSystems, title: tr(locale, "What models know on their own — API View", "Внутреннее знание моделей — API View") },
						]
							.filter((group) => group.list.length > 0)
							.map((group) => (
								<SectionCard key={group.title}>
									<SectionTitle
										title={group.title}
										lead={tr(
											locale,
											"Brand-name questions and category questions are counted separately and never merged into one score.",
											"Вопросы с названием бренда и вопросы про категорию считаются раздельно и никогда не сводятся в один балл.",
										)}
									/>
									<div className="mt-4 overflow-x-auto">
										<table className="w-full min-w-[680px] border-collapse text-sm">
											<thead>
												<tr>
													<th className="w-44 pb-3 text-left text-xs font-semibold text-[#6e6258]" aria-label={tr(locale, "Metric", "Метрика")} />
													{group.list.map((system) => (
														<th key={system.systemId} className="pb-3 pr-4 text-left align-top">
															<span className="selena-heading text-lg">{systemLabel(locale, system.systemId)}</span>
															<span className="block text-[0.7rem] font-medium text-[#6e6258]">
																{system.channel === "VISITOR"
																	? tr(locale, "Visitor View", "Visitor View · глазами посетителя")
																	: tr(locale, "API View", "API View · знание модели")}
															</span>
														</th>
													))}
												</tr>
											</thead>
											<tbody>
												<tr className="border-t border-[#e6ddd1]">
													<td className="py-3 pr-3 text-xs font-semibold text-[#6e6258]">{tr(locale, "Brand mentioned", "Бренд упомянут")}</td>
													{group.list.map((system) => (
														<td key={system.systemId} className="py-3 pr-4">
															<Ring
																fraction={system.answersAnalyzed === 0 ? null : system.brandMentioned / system.answersAnalyzed}
																label={
																	system.answersAnalyzed === 0
																		? tr(locale, "UNKNOWN", "НЕИЗВЕСТНО")
																		: tr(locale, `${system.brandMentioned} of ${system.answersAnalyzed}`, `${system.brandMentioned} из ${system.answersAnalyzed}`)
																}
																caption={
																	system.answersAnalyzed === 0
																		? tr(locale, "no analyzed answers yet", "разобранных ответов пока нет")
																		: tr(locale, "answers name you", "ответов называют вас")
																}
															/>
														</td>
													))}
												</tr>
												<tr className="border-t border-[#e6ddd1]">
													<td className="py-3 pr-3 text-xs font-semibold text-[#6e6258]">
														{tr(locale, "Category questions (no brand name)", "Вопросы про категорию (без названия бренда)")}
													</td>
													{group.list.map((system) => (
														<td key={system.systemId} className="py-3 pr-4 tabular-nums">
															{system.category.answers === 0
																? tr(locale, "UNKNOWN", "НЕИЗВЕСТНО")
																: tr(locale, `${system.category.mentioned} of ${system.category.answers}`, `${system.category.mentioned} из ${system.category.answers}`)}
														</td>
													))}
												</tr>
												<tr className="border-t border-[#e6ddd1]">
													<td className="py-3 pr-3 text-xs font-semibold text-[#6e6258]">{tr(locale, "Questions naming the brand", "Вопросы с названием бренда")}</td>
													{group.list.map((system) => (
														<td key={system.systemId} className="py-3 pr-4 tabular-nums">
															{system.branded.answers === 0
																? tr(locale, "UNKNOWN", "НЕИЗВЕСТНО")
																: tr(locale, `${system.branded.mentioned} of ${system.branded.answers}`, `${system.branded.mentioned} из ${system.branded.answers}`)}
														</td>
													))}
												</tr>
												<tr className="border-t border-[#e6ddd1]">
													<td className="py-3 pr-3 text-xs font-semibold text-[#6e6258]">{tr(locale, "Share of voice", "Доля голоса")}</td>
													{group.list.map((system) => (
														<td key={system.systemId} className="py-3 pr-4 font-semibold tabular-nums">
															{pct(locale, system.shareOfVoice)}
														</td>
													))}
												</tr>
												<tr className="border-t border-[#e6ddd1]">
													<td className="py-3 pr-3 text-xs font-semibold text-[#6e6258]">{tr(locale, "Average position in the list", "Средняя позиция в списке")}</td>
													{group.list.map((system) => (
														<td key={system.systemId} className="py-3 pr-4 font-semibold tabular-nums">
															{system.averageOrder === null ? tr(locale, "UNKNOWN", "НЕИЗВЕСТНО") : system.averageOrder.toFixed(1)}
														</td>
													))}
												</tr>
											</tbody>
										</table>
									</div>
								</SectionCard>
							))}

						<SectionCard>
							<SectionTitle
								title={tr(locale, "Who occupies the answers", "Кто занимает ответы")}
								lead={tr(
									locale,
									"How often each tracked business appeared in the analyzed answers — you plus every competitor from your profile. Observed from the answers, not a market rating.",
									"Как часто каждое отслеживаемое заведение звучало в разобранных ответах — вы плюс все конкуренты из вашего профиля. Это наблюдение из ответов, а не рейтинг рынка.",
								)}
							/>
							{rosterTotal === 0 ? (
								<p className="mt-4 text-sm font-semibold text-[#9a5f14]">
									{tr(
										locale,
										"UNKNOWN — none of the tracked businesses were named in the analyzed answers.",
										"НЕИЗВЕСТНО — ни одно из отслеживаемых заведений не прозвучало в разобранных ответах.",
									)}
								</p>
							) : (
								<div className="mt-5 flex flex-wrap items-center gap-8">
									<svg width="190" height="190" viewBox="0 0 200 200" role="img" aria-label={tr(locale, "Share of appearances among tracked businesses", "Доля попаданий среди отслеживаемых заведений")}>
										<g transform="rotate(-90 100 100)">
											{(() => {
												const circumference = 2 * Math.PI * 80;
												const top = report.roster.slice(0, 5);
												const rest = report.roster.slice(5).reduce((total, entry) => total + entry.answersMentioned, 0);
												const segments = [
													...top.map((entry, index) => ({
														value: entry.answersMentioned,
														color: entry.isBrand ? DONUT_COLORS[0] : DONUT_COLORS[(index % (DONUT_COLORS.length - 1)) + 1],
													})),
													{ value: rest, color: DONUT_OTHER },
												].filter((segment) => segment.value > 0);
												let offset = 0;
												return segments.map((segment, index) => {
													const length = (segment.value / rosterTotal) * circumference;
													const element = (
														// eslint-disable-next-line react/no-array-index-key
														<circle
															key={index}
															cx="100"
															cy="100"
															r="80"
															fill="none"
															stroke={segment.color}
															strokeWidth="26"
															strokeDasharray={`${Math.max(length - 2, 0.5)} ${circumference}`}
															strokeDashoffset={-offset}
														/>
													);
													offset += length;
													return element;
												});
											})()}
										</g>
										<text x="100" y="94" textAnchor="middle" fontSize="24" fontWeight="650" fill="#181614">
											{pct(locale, report.roster[0] ? report.roster[0].answersMentioned / rosterTotal : null)}
										</text>
										<text x="100" y="114" textAnchor="middle" fontSize="11" fill="#6e6258">
											{tr(locale, "your brand", "ваш бренд")}
										</text>
									</svg>
									<div className="min-w-60 flex-1">
										<div className="grid grid-cols-[1fr_auto_auto] gap-x-5 gap-y-0 text-[0.7rem] font-bold uppercase tracking-wider text-[#6e6258]">
											<span>{tr(locale, "Business", "Заведение")}</span>
											<span>{tr(locale, "Named in answers", "Назван в ответах")}</span>
											<span>{tr(locale, "Avg. position", "Средняя позиция")}</span>
										</div>
										{report.roster.map((entry, index) => (
											<div key={entry.name} className="grid grid-cols-[1fr_auto_auto] items-baseline gap-x-5 border-t border-[#e6ddd1] py-2 text-sm first:border-t-0">
												<span className={entry.isBrand ? "font-bold text-[#8f5c34]" : "font-medium"}>
													<span
														className="mr-2 inline-block h-2.5 w-2.5 rounded-sm align-baseline"
														style={{
															background:
																entry.isBrand
																	? DONUT_COLORS[0]
																	: index < 5
																		? DONUT_COLORS[(index % (DONUT_COLORS.length - 1)) + 1]
																		: DONUT_OTHER,
														}}
													/>
													{entry.name}
													{entry.isBrand ? ` — ${tr(locale, "you", "вы")}` : ""}
												</span>
												<span className="tabular-nums">
													{tr(locale, `${entry.answersMentioned} of ${report.methodology.answersAnalyzed}`, `${entry.answersMentioned} из ${report.methodology.answersAnalyzed}`)}
												</span>
												<span className="tabular-nums">
													{entry.averageOrder === null ? (
														<span className="font-semibold text-[#9a5f14]">{tr(locale, "UNKNOWN", "НЕИЗВЕСТНО")}</span>
													) : (
														entry.averageOrder.toFixed(1)
													)}
												</span>
											</div>
										))}
									</div>
								</div>
							)}
						</SectionCard>

						<SectionCard>
							<SectionTitle
								title={tr(locale, "Where you are absent and competitors are not", "Где вас нет, а конкуренты есть")}
								lead={tr(
									locale,
									"Answers that named a competitor and not you — with the sources each answer leaned on. Every row opens into the full answer text.",
									"Ответы, где назван конкурент, а вы — нет, и на какие источники ответ ссылался. Каждая строка открывается до полного текста ответа.",
								)}
							/>
							{report.gaps.length === 0 ? (
								<p className="mt-4 text-sm text-[#6e6258]">
									{report.methodology.answersAnalyzed === 0
										? tr(locale, "UNKNOWN — no analyzed answers yet.", "НЕИЗВЕСТНО — разобранных ответов пока нет.")
										: tr(locale, "No such answers: wherever a competitor was named, you were named too.", "Таких ответов нет: везде, где назван конкурент, названы и вы.")}
								</p>
							) : (
								<div className="mt-4 flex flex-col">
									{report.gaps.map((gap) => (
										<div key={gap.runId} className="border-t border-[#e6ddd1] py-3 first:border-t-0">
											<div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 text-sm">
												<div className="min-w-56 flex-1">
													<p className="font-medium">{gap.scenarioText || tr(locale, "(question text unavailable)", "(текст вопроса недоступен)")}</p>
													<p className="text-xs text-[#6e6258]">
														{systemLabel(locale, gap.systemId)} · {gap.channel === "VISITOR" ? "Visitor View" : "API View"} ·{" "}
														<span className="rounded-full bg-[#f6e7d8] px-2 py-0.5 font-bold text-[#9a5f14]">{tr(locale, "you are not named", "вы не названы")}</span>
													</p>
												</div>
												<div className="text-sm">
													<p>{gap.competitorsShown.join(", ")}</p>
													<p className="text-xs text-[#6e6258]">
														{gap.citedDomains.length > 0 ? gap.citedDomains.join(" · ") : tr(locale, "no sources cited", "источники не указаны")}
													</p>
												</div>
												<button
													type="button"
													className="text-sm text-[#8f5c34] underline underline-offset-4 print:hidden"
													onClick={() => void openAnswer(gap.runId)}
												>
													{answers[gap.runId] ? tr(locale, "Hide answer", "Скрыть ответ") : tr(locale, "Open answer →", "Открыть ответ →")}
												</button>
											</div>
											{answers[gap.runId] && (
												<div className="mt-2 rounded-xl border border-[#e6ddd1] bg-[#fffdf8] p-4 text-sm leading-6 whitespace-pre-wrap">
													{answers[gap.runId].loading ? tr(locale, "Loading…", "Загружаем…") : answers[gap.runId].text}
												</div>
											)}
										</div>
									))}
								</div>
							)}
						</SectionCard>

						<SectionCard>
							<SectionTitle
								title={tr(locale, "Where AI takes its data from", "Откуда AI берёт данные")}
								lead={tr(
									locale,
									"Sources the answers cited. “Without you” counts answers that cited the source, named a competitor, and did not name you — an observed fact, not a promised mechanism.",
									"Источники, которые ответы цитировали. «Без вас» — ответы, где источник процитирован, конкурент назван, а вы — нет. Это наблюдаемый факт, а не обещанный механизм.",
								)}
							/>
							{report.overall.citationGap.length === 0 ? (
								<p className="mt-4 text-sm text-[#6e6258]">
									{tr(locale, "The analyzed answers cited no sources.", "В разобранных ответах источники не встречались.")}
								</p>
							) : (
								<div className="mt-4">
									{report.overall.citationGap.slice(0, 8).map((entry) => (
										<div key={entry.domain} className="grid grid-cols-[1fr_auto] items-baseline gap-x-5 border-t border-[#e6ddd1] py-2.5 text-sm first:border-t-0">
											<span className="font-semibold">
												{entry.domain}
												{entry.ownedByBrand && <span className="ml-2 text-xs font-bold text-[#2e6b46]">{tr(locale, "your site", "ваш сайт")}</span>}
											</span>
											<span className="tabular-nums text-[#3d362e]">
												{tr(locale, `cited ${entry.timesCited}×`, `цитируется ${entry.timesCited}`)}
												{entry.timesCitedWithoutBrand > 0 && (
													<span className="font-semibold text-[#8f5c34]">
														{" "}
														· {tr(locale, `without you ${entry.timesCitedWithoutBrand}×`, `без вас ${entry.timesCitedWithoutBrand}`)}
													</span>
												)}
											</span>
										</div>
									))}
								</div>
							)}
						</SectionCard>

						{report.recommendations.length > 0 && (
							<SectionCard>
								<div className="flex flex-wrap items-start justify-between gap-3">
									<SectionTitle
										title={tr(locale, "What to do next", "Что делать дальше")}
										lead={tr(
											locale,
											"Each recommendation is derived from a specific observation in this report and shows its “why”.",
											"Каждая рекомендация выведена из конкретного наблюдения этого отчёта и показывает своё «почему».",
										)}
									/>
									<span className="rounded-full bg-[#e9f2ea] px-3 py-1.5 text-xs font-semibold text-[#2e6b46]">
										{tr(locale, "included in your plan", "входит в ваш тариф")}
									</span>
								</div>
								<div className="mt-4 grid gap-3">
									{report.recommendations.map((rec, index) => {
										const body =
											rec.kind === "SOURCE_PRESENCE"
												? {
														action: tr(locale, `Strengthen your presence on ${rec.domain}.`, `Усильте присутствие на ${rec.domain}.`),
														why: tr(
															locale,
															`Cited in ${rec.timesCited} answer(s), ${rec.timesCitedWithoutBrand} of them without you.`,
															`Процитирован в ${rec.timesCited} ответах, из них без вас — ${rec.timesCitedWithoutBrand}.`,
														),
													}
												: rec.kind === "CATEGORY_CONTENT"
													? {
															action: tr(
																locale,
																`Create pages answering the category questions, e.g.: ${rec.exampleQuestions.join("; ")}.`,
																`Сделайте на сайте страницы под категорийные вопросы, например: ${rec.exampleQuestions.join("; ")}.`,
															),
															why: tr(
																locale,
																`You are absent in ${rec.missedAnswers} of ${rec.categoryAnswers} category answers.`,
																`Вы не названы в ${rec.missedAnswers} из ${rec.categoryAnswers} категорийных ответов.`,
															),
														}
													: {
															action: tr(locale, `Make your own site (${rec.domain}) worth citing.`, `Сделайте свой сайт (${rec.domain}) источником, который цитируют.`),
															why: tr(
																locale,
																`Your site is cited ${rec.timesCited}×, while ${rec.topExternalDomain} is cited ${rec.topExternalCited}×.`,
																`Ваш сайт процитирован ${rec.timesCited} раз, а ${rec.topExternalDomain} — ${rec.topExternalCited}.`,
															),
														};
										return (
											<div key={`${rec.kind}-${index === 0 ? "a" : index}`} className="flex items-start gap-3.5 rounded-xl border border-[#e6ddd1] bg-[#fffdf8] p-4 text-sm">
												<span className="selena-heading flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#efe3d7] text-[#8f5c34]">{index + 1}</span>
												<div>
													<p className="font-semibold">{body.action}</p>
													<p className="mt-1 text-xs text-[#6e6258]">
														{tr(locale, "Why", "Почему")}: {body.why}
													</p>
												</div>
											</div>
										);
									})}
								</div>
								<p className="mt-4 max-w-3xl text-xs italic text-[#6e6258]">
									{tr(
										locale,
										"Recommendations come from this measurement's facts. Acting on them does not guarantee appearing in answers — AI systems change on their own; a repeat measurement shows what moved.",
										"Рекомендации — из фактов этого замера. Их выполнение не гарантирует попадание в ответы: AI-системы меняются сами. Повторный замер покажет, что изменилось.",
									)}
								</p>
							</SectionCard>
						)}

						<SectionCard>
							<SectionTitle
								title={tr(locale, "The questions we asked", "Вопросы, которые мы задали")}
								lead={tr(
									locale,
									"Every question below was approved by you before the measurement ran — nothing is asked without your check mark.",
									"Каждый вопрос ниже вы утвердили до запуска замера — без вашей галочки ничего не спрашивается.",
								)}
							/>
							<div className="mt-4">
								{report.questions.map((question) => (
									<div key={question.scenarioId} className="flex items-baseline gap-3 border-t border-[#e6ddd1] py-2.5 text-sm first:border-t-0">
										<span className="w-8 shrink-0 text-[0.68rem] font-bold uppercase text-[#6e6258]">{question.language}</span>
										<span className="flex-1">{question.text}</span>
										<span className="shrink-0 text-xs text-[#6e6258]">
											{question.branded ? tr(locale, "names the brand", "с названием бренда") : tr(locale, "category question", "про категорию")}
										</span>
									</div>
								))}
							</div>
						</SectionCard>

						<SectionCard>
							<SectionTitle title={tr(locale, "Why these numbers can be trusted", "Почему этим цифрам можно верить")} />
							<div className="mt-4 grid gap-3 sm:grid-cols-2">
								{[
									[
										tr(locale, "Every number opens into an answer", "Каждая цифра открывается до ответа"),
										tr(locale, "“Open answer” shows the full text the AI system gave. Nothing is paraphrased.", "«Открыть ответ» показывает полный текст, который дала AI-система. Ничего не пересказано."),
									],
									[
										tr(locale, "Empty means UNKNOWN", "Пусто — значит НЕИЗВЕСТНО"),
										tr(locale, "Where there is no data we say UNKNOWN instead of drawing a zero or a percent.", "Там, где данных нет, мы пишем НЕИЗВЕСТНО, а не рисуем ноль или процент."),
									],
									[
										tr(locale, "No composite score", "Никакого «общего балла»"),
										tr(locale, "One score hides the point: you can be absent from category answers with perfect branded ones. Groups stay separate.", "Один балл прячет главное: вас может не быть в категорийных ответах при идеальных брендовых. Группы показываются раздельно."),
									],
									[
										tr(locale, "You approve the questions", "Вопросы утверждаете вы"),
										tr(locale, "The measurement asks only questions you saw and approved.", "Замер задаёт только те вопросы, которые вы видели и одобрили."),
									],
								].map(([heading, body]) => (
									<div key={heading} className="rounded-xl border border-[#e6ddd1] bg-[#fffdf8] p-4 text-sm">
										<p className="font-semibold">{heading}</p>
										<p className="mt-1 text-[#3d362e]">{body}</p>
									</div>
								))}
							</div>
							<p className="mt-4 max-w-3xl text-xs italic text-[#6e6258]">
								{tr(
									locale,
									"Answers are retained for 13 months so a year-over-year comparison stays possible. Changes in AI answers are never guaranteed and depend on the systems themselves.",
									"Ответы хранятся 13 месяцев — чтобы через год сравнить «год к году». Изменения в ответах AI не гарантируются и зависят от самих систем.",
								)}
							</p>
						</SectionCard>

						<SectionCard>
							<SectionTitle
								title={tr(locale, "Cycle-to-cycle dynamics", "Динамика по циклам")}
								lead={tr(
									locale,
									"What changed between the two most recent measurements — observations, never causes.",
									"Что изменилось между двумя последними замерами — наблюдения, никогда не причины.",
								)}
							/>
							{!compare || !compare.comparable ? (
								<p className="mt-4 text-sm font-semibold text-[#9a5f14]">
									{tr(
										locale,
										"UNKNOWN — there is nothing to compare after the first measurement; dynamics appear from the second cycle.",
										"НЕИЗВЕСТНО — после первого замера сравнивать не с чем; динамика появится со второго цикла.",
									)}
								</p>
							) : (
								<div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
									{[
										["MENTION_APPEARED", tr(locale, "answers where you appeared", "ответов, где вы появились")],
										["MENTION_DISAPPEARED", tr(locale, "answers where you disappeared", "ответов, где вы исчезли")],
										["POSITION_SHIFTED", tr(locale, "position shifts", "сдвигов позиции")],
										["SOURCE_APPEARED", tr(locale, "new sources", "новых источников")],
									].map(([type, caption]) => (
										<div key={type} className="rounded-xl border border-[#e6ddd1] bg-[#fffdf8] px-4 py-3">
											<p className="selena-heading text-2xl tabular-nums">{compare.report.changes.filter((change) => change.type === type).length}</p>
											<p className="text-xs text-[#6e6258]">{caption}</p>
										</div>
									))}
								</div>
							)}
						</SectionCard>

						<section className="relative overflow-hidden rounded-2xl bg-[#221f1b] p-8 text-[#f2e9df] print:hidden">
							<div className="pointer-events-none absolute -right-20 -bottom-24 h-64 w-64 rounded-full border border-[#b9825b4d]" />
							{view?.planId === "visitor-local" ? (
								<>
									<h2 className="selena-heading text-2xl text-[#faf5ec]">{tr(locale, "This report is a starting point", "Этот отчёт — отправная точка")}</h2>
									<p className="mt-2 max-w-2xl text-sm text-[#cfc4b6]">
										{tr(
											locale,
											"Landscape ($79) adds five model-knowledge systems — Claude, DeepSeek, Qwen, Mistral, Grok — and cycle-to-cycle dynamics.",
											"Landscape ($79) добавляет 5 систем внутреннего знания — Claude, DeepSeek, Qwen, Mistral, Grok — и динамику от цикла к циклу.",
										)}
									</p>
									<Link to="/app/selena-order" search={{ project: projectId, plan: "landscape" }} className="mt-5 inline-block">
										<Button type="button" className="bg-[#8f5c34] text-[#fff7ee] hover:bg-[#7c4e2b]">
											{tr(locale, "Move to Landscape · $79", "Перейти на Landscape · $79")}
										</Button>
									</Link>
								</>
							) : (
								<>
									<h2 className="selena-heading text-2xl text-[#faf5ec]">{tr(locale, "Need stability and a human eye?", "Нужна устойчивость и взгляд человека?")}</h2>
									<p className="mt-2 max-w-2xl text-sm text-[#cfc4b6]">
										{tr(
											locale,
											"Expert Verified ($399) repeats the whole measurement ×5 for stability, and a human verifies the recommendations. Ask us through the order page.",
											"Expert Verified ($399) повторяет весь замер ×5 для устойчивости, а рекомендации проверяет человек. Запросите через страницу заказа.",
										)}
									</p>
									<Link to="/app/selena-order" search={{ project: projectId }} className="mt-5 inline-block">
										<Button type="button" className="bg-[#8f5c34] text-[#fff7ee] hover:bg-[#7c4e2b]">
											{tr(locale, "Open the order page", "Открыть страницу заказа")}
										</Button>
									</Link>
								</>
							)}
						</section>
					</>
				)}
			</main>
		</div>
	);
}
