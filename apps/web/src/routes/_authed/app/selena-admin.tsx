import { createFileRoute, notFound, useRouter } from "@tanstack/react-router";
import { Button } from "@workspace/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@workspace/ui/components/card";
import { Input } from "@workspace/ui/components/input";
import { Label } from "@workspace/ui/components/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@workspace/ui/components/table";
import { Textarea } from "@workspace/ui/components/textarea";
import { useCallback, useEffect, useState } from "react";
import { SelenaOrderDesk } from "@/components/selena-order-desk";
import { humanizeSelenaAdminError } from "@/lib/selena-workspace-errors";
import { analyzeSelenaOrderFn } from "@/server/selena-order-analysis";
import {
	approveSelenaOrderFn,
	enqueueSelenaOrderRunsFn,
	getSelenaAdminAccessFn,
	getSelenaAdminOrderQueueFn,
	getSelenaOrderPreflightFn,
	recordSelenaQcFn,
	stopSelenaOrderFn,
} from "@/server/selena-admin-orders";

export const Route = createFileRoute("/_authed/app/selena-admin")({
	beforeLoad: async () => {
		const { isAdmin } = await getSelenaAdminAccessFn();
		if (!isAdmin) throw notFound();
	},
	loader: () => getSelenaAdminOrderQueueFn(),
	component: SelenaAdminOrders,
});

type QueueOrder = Awaited<ReturnType<typeof getSelenaAdminOrderQueueFn>>[number];
type Preflight = Awaited<ReturnType<typeof getSelenaOrderPreflightFn>>;
type AdminLocale = "en" | "ru";
type AdminAction = "approve" | "enqueue" | "stop" | "qc" | "analyze";

const emptyQcForm = { reviewer: "", scope: "", decision: "approved" as "approved" | "rejected", notes: "" };

function SelenaAdminOrders() {
	const orders = Route.useLoaderData();
	const router = useRouter();
	const [locale, setLocale] = useState<AdminLocale>("en");
	const [selectedOrderId, setSelectedOrderId] = useState(orders[0]?.id ?? "");
	const [preflight, setPreflight] = useState<Preflight | null>(null);
	const [preflightPending, setPreflightPending] = useState(false);
	const [pendingAction, setPendingAction] = useState<AdminAction | "">("");
	// Sticks until the next action: a refused enqueue must not read as a run
	// that started somewhere the operator cannot see.
	const [measurementDisabled, setMeasurementDisabled] = useState(false);
	const [stopReason, setStopReason] = useState("");
	const [qcForm, setQcForm] = useState(emptyQcForm);
	const [analysis, setAnalysis] = useState<Awaited<ReturnType<typeof analyzeSelenaOrderFn>> | null>(null);
	const [notice, setNotice] = useState("");
	const [error, setError] = useState("");
	// One key per order and action, so retrying after a failed request replays
	// the first attempt instead of acting twice.
	const [actionKeys] = useState(() => new Map<string, string>());

	const selectedOrder = orders.find((order) => order.id === selectedOrderId) ?? orders[0] ?? null;

	useEffect(() => {
		const saved = window.localStorage.getItem("selena-workspace-locale");
		setLocale(saved === "ru" || saved === "en" ? saved : navigator.language.startsWith("ru") ? "ru" : "en");
	}, []);

	const loadPreflight = useCallback(
		async (orderId: string) => {
			setPreflightPending(true);
			try {
				setPreflight(await getSelenaOrderPreflightFn({ data: { orderId } }));
			} catch (cause) {
				setPreflight(null);
				setError(humanizeSelenaAdminError(cause, locale, "Preflight failed"));
			} finally {
				setPreflightPending(false);
			}
		},
		[locale],
	);

	useEffect(() => {
		if (!selectedOrder) {
			setPreflight(null);
			setAnalysis(null);
			return;
		}
		void loadPreflight(selectedOrder.id);
	}, [selectedOrder, loadPreflight]);

	const idempotencyKey = (action: string, orderId: string) => {
		const mapKey = `${action}:${orderId}`;
		const existing = actionKeys.get(mapKey);
		if (existing) return existing;
		const created = crypto.randomUUID();
		actionKeys.set(mapKey, created);
		return created;
	};

	const runAction = async (action: AdminAction, operation: () => Promise<string>) => {
		setPendingAction(action);
		setNotice("");
		setError("");
		setMeasurementDisabled(false);
		try {
			setNotice(await operation());
			await router.invalidate();
			if (selectedOrder) await loadPreflight(selectedOrder.id);
		} catch (cause) {
			setError(humanizeSelenaAdminError(cause, locale, tr(locale, "Action failed", "Действие не выполнено")));
		} finally {
			setPendingAction("");
		}
	};

	const approve = () => {
		if (!selectedOrder) return;
		void runAction("approve", async () => {
			const result = await approveSelenaOrderFn({
				data: { orderId: selectedOrder.id, idempotencyKey: idempotencyKey("approve", selectedOrder.id) },
			});
			return tr(
				locale,
				`Approved. ${result.created} run permits issued of ${result.expected}; order is ${result.status}.`,
				`Заказ одобрен. Выпущено разрешений: ${result.created} из ${result.expected}; статус заказа: ${result.status}.`,
			);
		});
	};

	const enqueue = () => {
		if (!selectedOrder) return;
		void runAction("enqueue", async () => {
			const result = await enqueueSelenaOrderRunsFn({
				data: { orderId: selectedOrder.id, idempotencyKey: idempotencyKey("enqueue", selectedOrder.id) },
			});
			if (result.reason === "SELENA_MEASUREMENT_DISABLED") {
				setMeasurementDisabled(true);
				return tr(locale, "Nothing was queued.", "В очередь ничего не поставлено.");
			}
			const duplicates =
				result.duplicates > 0
					? tr(locale, ` ${result.duplicates} were already queued.`, ` Уже стояли в очереди: ${result.duplicates}.`)
					: "";
			return tr(
				locale,
				`Queued ${result.enqueued} run(s); ${result.skipped} permit(s) skipped as consumed or expired.${duplicates}`,
				`Поставлено в очередь прогонов: ${result.enqueued}; пропущено разрешений (потрачены или истекли): ${result.skipped}.${duplicates}`,
			);
		});
	};

	const stop = () => {
		if (!selectedOrder) return;
		void runAction("stop", async () => {
			const result = await stopSelenaOrderFn({
				data: {
					orderId: selectedOrder.id,
					reason: stopReason.trim() || undefined,
					idempotencyKey: idempotencyKey("stop", selectedOrder.id),
				},
			});
			setStopReason("");
			return tr(
				locale,
				`Order stopped. Cycles moved to STOPPED: ${result.stoppedCycles}.`,
				`Заказ остановлен. Циклов переведено в STOPPED: ${result.stoppedCycles}.`,
			);
		});
	};

	const submitQc = (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (!selectedOrder) return;
		void runAction("qc", async () => {
			const record = await recordSelenaQcFn({
				data: {
					orderId: selectedOrder.id,
					cycleId: selectedOrder.cycles[0]?.id,
					reviewer: qcForm.reviewer.trim() || undefined,
					scope: qcForm.scope.trim(),
					decision: qcForm.decision,
					notes: qcForm.notes.trim() || undefined,
				},
			});
			setQcForm(emptyQcForm);
			return tr(locale, `QC recorded: ${record.decision}.`, `QC записан: ${record.decision}.`);
		});
	};

	return (
		<div className="flex flex-col gap-6 p-4 md:p-6">
			<header className="flex flex-wrap items-start justify-between gap-4">
				<div>
					<h1 className="text-2xl font-semibold">{tr(locale, "Order operations", "Работа с заказами")}</h1>
					<p className="mt-2 max-w-2xl text-sm text-muted-foreground">
						{tr(
							locale,
							"Preflight, approve, queue, stop and QC. Approving issues run permits; queueing hands them to the worker — no measurement is executed from this screen.",
							"Preflight, одобрение, постановка в очередь, остановка и QC. Одобрение выпускает разрешения на прогоны, постановка в очередь передаёт их воркеру — измерение с этого экрана не запускается.",
						)}
					</p>
				</div>
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={() => {
						const next = locale === "ru" ? "en" : "ru";
						setLocale(next);
						window.localStorage.setItem("selena-workspace-locale", next);
					}}
				>
					{locale === "ru" ? "EN" : "RU"}
				</Button>
			</header>

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
			{measurementDisabled && (
				<p className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
					{tr(
						locale,
						"Execution is off: SELENA_MEASUREMENT_ENABLED is not enabled. No job was queued and no run has started.",
						"Исполнение выключено: SELENA_MEASUREMENT_ENABLED не включён. Ни одна джоба не поставлена в очередь, прогон не начался.",
					)}
				</p>
			)}

			<SelenaOrderDesk locale={locale} onOrderCreated={() => void router.invalidate()} />

			<Card>
				<CardHeader>
					<CardTitle>{tr(locale, "Order queue", "Очередь заказов")}</CardTitle>
					<CardDescription>
						{tr(
							locale,
							"Orders in the review, dispatch and QC stages of your workspace.",
							"Заказы вашего пространства на стадиях проверки, диспетчеризации и QC.",
						)}
					</CardDescription>
				</CardHeader>
				<CardContent>
					{orders.length === 0 ? (
						<p className="text-sm text-muted-foreground">
							{tr(locale, "No orders are waiting for an operator.", "Нет заказов, ожидающих оператора.")}
						</p>
					) : (
						<div className="overflow-x-auto">
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>{tr(locale, "Project", "Проект")}</TableHead>
										<TableHead>{tr(locale, "Status", "Статус")}</TableHead>
										<TableHead className="text-right">{tr(locale, "Expected runs", "Ожидаемые прогоны")}</TableHead>
										<TableHead className="text-right">{tr(locale, "Order cap", "Лимит заказа")}</TableHead>
										<TableHead>{tr(locale, "Cycle", "Цикл")}</TableHead>
										<TableHead>{tr(locale, "Latest QC", "Последний QC")}</TableHead>
										<TableHead />
									</TableRow>
								</TableHeader>
								<TableBody>
									{orders.map((order) => (
										<TableRow key={order.id} data-state={order.id === selectedOrder?.id ? "selected" : undefined}>
											<TableCell className="font-medium">{order.projectName}</TableCell>
											<TableCell>
												<span className="rounded-full border px-2 py-0.5 text-xs">{order.status}</span>
											</TableCell>
											<TableCell className="text-right tabular-nums">{order.lockExpectedRuns}</TableCell>
											<TableCell className="text-right tabular-nums">
												{order.orderCap} {order.currency}
											</TableCell>
											<TableCell className="text-xs text-muted-foreground">{cycleSummary(order)}</TableCell>
											<TableCell className="text-xs text-muted-foreground">
												{order.latestQc ? order.latestQc.decision : tr(locale, "none", "нет")}
											</TableCell>
											<TableCell className="text-right">
												<Button type="button" variant="outline" size="sm" onClick={() => setSelectedOrderId(order.id)}>
													{tr(locale, "Select", "Выбрать")}
												</Button>
											</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						</div>
					)}
				</CardContent>
			</Card>

			{selectedOrder && (
				<div className="grid gap-6 lg:grid-cols-2">
					<Card>
						<CardHeader>
							<CardTitle>{tr(locale, "Preflight", "Preflight")}</CardTitle>
							<CardDescription>
								{selectedOrder.projectName} · {selectedOrder.status}
							</CardDescription>
						</CardHeader>
						<CardContent className="space-y-4">
							{preflightPending && (
								<p className="text-sm text-muted-foreground">{tr(locale, "Checking…", "Проверяем…")}</p>
							)}
							{preflight && (
								<>
									<p className="text-sm">
										{preflight.ok
											? tr(locale, "All checks pass.", "Все проверки пройдены.")
											: tr(
													locale,
													`Blocked by ${preflight.blockers.length} check(s).`,
													`Блокировано проверками: ${preflight.blockers.length}.`,
												)}
									</p>
									<ul className="space-y-2">
										{preflight.checks.map((check) => (
											<li key={check.code} className="flex gap-3 text-sm">
												<span aria-hidden="true" className={check.ok ? "text-emerald-600" : "text-destructive"}>
													{check.ok ? "✓" : "✗"}
												</span>
												<span>
													<span className="font-medium">{checkLabel(check.code, locale)}</span>
													<span className="ml-2 font-mono text-xs text-muted-foreground">{check.code}</span>
													{check.details && Object.keys(check.details).length > 0 && (
														<span className="block text-xs text-muted-foreground">
															{Object.entries(check.details)
																.map(([key, value]) => `${key}: ${String(value)}`)
																.join(" · ")}
														</span>
													)}
												</span>
											</li>
										))}
									</ul>
									<dl className="grid grid-cols-2 gap-2 border-t pt-4 text-sm">
										<dt className="text-muted-foreground">{tr(locale, "Expected runs", "Ожидаемые прогоны")}</dt>
										<dd className="text-right tabular-nums">{preflight.expectedRuns}</dd>
										<dt className="text-muted-foreground">{tr(locale, "Worst case", "Худший случай")}</dt>
										<dd className="text-right tabular-nums">
											{preflight.worstCaseCost.amount} {preflight.worstCaseCost.currency} (
											{tr(locale, "estimated", "оценка")})
										</dd>
									</dl>
								</>
							)}
							<div className="flex flex-wrap items-center gap-3 border-t pt-4">
								<Button
									type="button"
									onClick={approve}
									disabled={!preflight?.ok || pendingAction !== "" || preflightPending}
								>
									{pendingAction === "approve"
										? tr(locale, "Approving…", "Одобряем…")
										: tr(locale, "Approve run", "Одобрить прогон")}
								</Button>
								<Button
									type="button"
									variant="secondary"
									onClick={enqueue}
									disabled={selectedOrder.status !== "QUEUED" || pendingAction !== ""}
								>
									{pendingAction === "enqueue"
										? tr(locale, "Queueing…", "Ставим в очередь…")
										: tr(locale, "Queue runs", "Поставить прогоны в очередь")}
								</Button>
								<Button
									type="button"
									variant="outline"
									onClick={() => void loadPreflight(selectedOrder.id)}
									disabled={preflightPending}
								>
									{tr(locale, "Re-check", "Проверить снова")}
								</Button>
								<Button
									type="button"
									variant="outline"
									disabled={pendingAction !== ""}
									onClick={() =>
										void (async () => {
											setPendingAction("analyze");
											setError("");
											setNotice("");
											try {
												setAnalysis(await analyzeSelenaOrderFn({ data: { orderId: selectedOrder.id } }));
											} catch (cause) {
												setAnalysis(null);
												setError(
													humanizeSelenaAdminError(cause, locale, tr(locale, "Analysis failed", "Анализ не выполнен")),
												);
											} finally {
												setPendingAction("");
											}
										})()
									}
								>
									{pendingAction === "analyze"
										? tr(locale, "Reading answers…", "Читаем ответы…")
										: tr(locale, "Read the answers", "Разобрать ответы")}
								</Button>
							</div>

							{/* Repeated beside the buttons on purpose: the page banner sits a
							    screen away, so a refused action reads as a dead button. */}
							{(notice || error || measurementDisabled) && (
								<div className="space-y-2">
									{notice && (
										<p className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
											{notice}
										</p>
									)}
									{error && (
										<p className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
											{error}
										</p>
									)}
									{measurementDisabled && (
										<p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
											{tr(
												locale,
												"Execution is off on this service: set SELENA_MEASUREMENT_ENABLED=true on both web and worker. Nothing was queued.",
												"Исполнение выключено на этом сервисе: поставьте SELENA_MEASUREMENT_ENABLED=true и на web, и на worker. В очередь ничего не поставлено.",
											)}
										</p>
									)}
								</div>
							)}

							{analysis && (
								<div className="space-y-4 border-t pt-4 text-sm">
									<p className="text-muted-foreground">
										{tr(
											locale,
											`Read ${analysis.analyzed} answer(s); ${analysis.reused} reused past findings; ${analysis.withoutAnswer} had nothing to read.`,
											`Разобрано ответов: ${analysis.analyzed}; взято из прежних находок: ${analysis.reused}; без текста: ${analysis.withoutAnswer}.`,
										)}
									</p>
									<dl className="grid gap-4 sm:grid-cols-3">
										<div>
											<dt className="text-xs text-muted-foreground">
												{tr(locale, "Answers naming the brand", "Ответов с упоминанием бренда")}
											</dt>
											<dd className="text-lg font-semibold">
												{formatShare(analysis.summary.brandMentionRate, locale)}
											</dd>
										</div>
										<div>
											<dt className="text-xs text-muted-foreground">{tr(locale, "Share of voice", "Доля голоса")}</dt>
											<dd className="text-lg font-semibold">
												{formatShare(analysis.summary.brandShareOfVoice, locale)}
											</dd>
										</div>
										<div>
											<dt className="text-xs text-muted-foreground">
												{tr(locale, "Average standing", "Средняя позиция")}
											</dt>
											<dd className="text-lg font-semibold">
												{analysis.summary.brandAverageOrder === null
													? tr(locale, "UNKNOWN", "НЕИЗВЕСТНО")
													: analysis.summary.brandAverageOrder.toFixed(2)}
											</dd>
										</div>
									</dl>
									{analysis.summary.competitors.length > 0 && (
										<div>
											<p className="font-medium">{tr(locale, "Named instead", "Названы вместо вас")}</p>
											<ul className="mt-2 space-y-1 text-muted-foreground">
												{analysis.summary.competitors.slice(0, 8).map((competitor) => (
													<li key={competitor.name}>
														{competitor.name} — {competitor.answersMentioned} {tr(locale, "answer(s)", "ответ(ов)")},{" "}
														{tr(locale, "avg standing", "средняя позиция")} {competitor.averageOrder.toFixed(2)}
													</li>
												))}
											</ul>
										</div>
									)}
									{analysis.summary.citationGap.length > 0 && (
										<div>
											<p className="font-medium">{tr(locale, "Citation gap", "Разрыв по источникам")}</p>
											<p className="text-xs text-muted-foreground">
												{tr(
													locale,
													"Sources the answers leaned on, ranked by how often the brand was absent from them.",
													"Источники, на которые опирались ответы, по числу случаев, где бренда в них не было.",
												)}
											</p>
											<ul className="mt-2 space-y-1 text-muted-foreground">
												{analysis.summary.citationGap.slice(0, 10).map((entry) => (
													<li key={entry.domain}>
														{entry.domain} — {tr(locale, "cited", "цитирований")} {entry.timesCited},{" "}
														{tr(locale, "without the brand", "без бренда")} {entry.timesCitedWithoutBrand}
														{entry.ownedByBrand ? tr(locale, " (own site)", " (свой сайт)") : ""}
													</li>
												))}
											</ul>
										</div>
									)}
								</div>
							)}
							{selectedOrder.status !== "QUEUED" && (
								<p className="text-xs text-muted-foreground">
									{tr(
										locale,
										"Runs can only be queued once the order is QUEUED, which approval does.",
										"Прогоны можно поставить в очередь только когда заказ в статусе QUEUED — в него переводит одобрение.",
									)}
								</p>
							)}
							{preflight && !preflight.ok && (
								<p className="text-xs text-muted-foreground">
									{tr(
										locale,
										"Approve stays disabled until every check passes.",
										"Кнопка одобрения остаётся выключенной, пока не пройдены все проверки.",
									)}
								</p>
							)}
						</CardContent>
					</Card>

					<div className="space-y-6">
						<Card>
							<CardHeader>
								<CardTitle>{tr(locale, "Stop order", "Остановить заказ")}</CardTitle>
								<CardDescription>
									{tr(
										locale,
										"Cancels the order and marks its cycles STOPPED.",
										"Отменяет заказ и переводит его циклы в STOPPED.",
									)}
								</CardDescription>
							</CardHeader>
							<CardContent className="space-y-3">
								<Label htmlFor="stop-reason">{tr(locale, "Reason (optional)", "Причина (необязательно)")}</Label>
								<Input
									id="stop-reason"
									value={stopReason}
									onChange={(event) => setStopReason(event.target.value)}
									maxLength={500}
								/>
								<Button type="button" variant="destructive" onClick={stop} disabled={pendingAction !== ""}>
									{pendingAction === "stop" ? tr(locale, "Stopping…", "Останавливаем…") : tr(locale, "Stop", "Стоп")}
								</Button>
							</CardContent>
						</Card>

						<Card>
							<CardHeader>
								<CardTitle>{tr(locale, "QC decision", "Решение QC")}</CardTitle>
								<CardDescription>
									{tr(
										locale,
										"The latest record per order is what publication gates read.",
										"Публикация опирается на последнюю запись QC по заказу.",
									)}
								</CardDescription>
							</CardHeader>
							<CardContent>
								<form className="space-y-3" onSubmit={submitQc}>
									<div className="space-y-1">
										<Label htmlFor="qc-reviewer">{tr(locale, "Reviewer", "Проверяющий")}</Label>
										<Input
											id="qc-reviewer"
											value={qcForm.reviewer}
											onChange={(event) => setQcForm({ ...qcForm, reviewer: event.target.value })}
											placeholder={tr(locale, "Defaults to you", "По умолчанию — вы")}
											maxLength={200}
										/>
									</div>
									<div className="space-y-1">
										<Label htmlFor="qc-scope">{tr(locale, "Scope", "Объём проверки")}</Label>
										<Input
											id="qc-scope"
											required
											value={qcForm.scope}
											onChange={(event) => setQcForm({ ...qcForm, scope: event.target.value })}
											maxLength={500}
										/>
									</div>
									<div className="space-y-1">
										<Label htmlFor="qc-decision">{tr(locale, "Decision", "Решение")}</Label>
										<select
											id="qc-decision"
											className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
											value={qcForm.decision}
											onChange={(event) =>
												setQcForm({ ...qcForm, decision: event.target.value as "approved" | "rejected" })
											}
										>
											<option value="approved">{tr(locale, "approved", "approved — принято")}</option>
											<option value="rejected">{tr(locale, "rejected", "rejected — отклонено")}</option>
										</select>
									</div>
									<div className="space-y-1">
										<Label htmlFor="qc-notes">{tr(locale, "Notes", "Заметки")}</Label>
										<Textarea
											id="qc-notes"
											value={qcForm.notes}
											onChange={(event) => setQcForm({ ...qcForm, notes: event.target.value })}
											maxLength={2000}
											rows={3}
										/>
									</div>
									<Button type="submit" disabled={pendingAction !== ""}>
										{pendingAction === "qc"
											? tr(locale, "Recording…", "Записываем…")
											: tr(locale, "Record QC", "Записать QC")}
									</Button>
								</form>
							</CardContent>
						</Card>
					</div>
				</div>
			)}
		</div>
	);
}

/** An empty measurement reports UNKNOWN; a zero here would claim knowledge. */
function formatShare(value: number | null, locale: AdminLocale): string {
	if (value === null) return tr(locale, "UNKNOWN", "НЕИЗВЕСТНО");
	return `${Math.round(value * 100)}%`;
}

function cycleSummary(order: QueueOrder): string {
	const cycle = order.cycles[0];
	if (!cycle) return "—";
	return `${cycle.status} ${cycle.completedRuns}/${cycle.expectedRuns}`;
}

function checkLabel(code: string, locale: AdminLocale): string {
	const labels: Record<string, [string, string]> = {
		ORDER_STATUS_PAID_REVIEW_REQUIRED: ["Order is awaiting review", "Заказ ожидает проверки"],
		LOCK_PRESENT: ["Configuration lock exists", "Конфигурация зафиксирована"],
		LOCK_SCOPE_PRESENT: ["Lock carries a measurement scope", "В фиксации есть объём измерения"],
		EXPECTED_RUNS_MATCH: ["Expected runs match the scope", "Ожидаемые прогоны совпадают с объёмом"],
		NO_ACTIVE_PERMITS: ["No run permits in flight", "Нет активных разрешений на прогоны"],
		NO_ACTIVE_JOBS: ["No runs in flight", "Нет незавершённых прогонов"],
		MAINTENANCE_IDLE: ["Recurring maintenance is idle", "Регулярное обслуживание не активно"],
		WITHIN_ORDER_CAP: ["Worst case fits the order cap", "Худший случай не превышает лимит заказа"],
		WITHIN_PROVIDER_BUDGET: ["Worst case fits the provider budget", "Худший случай не превышает бюджет провайдера"],
		PAYMENT_RECORDED: ["Payment is recorded", "Платёж зафиксирован"],
	};
	const label = labels[code];
	return label ? tr(locale, label[0], label[1]) : code;
}

function tr(locale: AdminLocale, english: string, russian: string): string {
	return locale === "ru" ? russian : english;
}
