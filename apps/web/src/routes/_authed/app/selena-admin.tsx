import { createFileRoute, notFound, useRouter } from "@tanstack/react-router";
import { Button } from "@workspace/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@workspace/ui/components/card";
import { Input } from "@workspace/ui/components/input";
import { Label } from "@workspace/ui/components/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@workspace/ui/components/table";
import { Textarea } from "@workspace/ui/components/textarea";
import { useCallback, useEffect, useState } from "react";
import {
	approveSelenaOrderFn,
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

const emptyQcForm = { reviewer: "", scope: "", decision: "approved" as "approved" | "rejected", notes: "" };

function SelenaAdminOrders() {
	const orders = Route.useLoaderData();
	const router = useRouter();
	const [locale, setLocale] = useState<AdminLocale>("en");
	const [selectedOrderId, setSelectedOrderId] = useState(orders[0]?.id ?? "");
	const [preflight, setPreflight] = useState<Preflight | null>(null);
	const [preflightPending, setPreflightPending] = useState(false);
	const [pendingAction, setPendingAction] = useState<"approve" | "stop" | "qc" | "">("");
	const [stopReason, setStopReason] = useState("");
	const [qcForm, setQcForm] = useState(emptyQcForm);
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

	const loadPreflight = useCallback(async (orderId: string) => {
		setPreflightPending(true);
		try {
			setPreflight(await getSelenaOrderPreflightFn({ data: { orderId } }));
		} catch (cause) {
			setPreflight(null);
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setPreflightPending(false);
		}
	}, []);

	useEffect(() => {
		if (!selectedOrder) {
			setPreflight(null);
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

	const runAction = async (action: "approve" | "stop" | "qc", operation: () => Promise<string>) => {
		setPendingAction(action);
		setNotice("");
		setError("");
		try {
			setNotice(await operation());
			await router.invalidate();
			if (selectedOrder) await loadPreflight(selectedOrder.id);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
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
							"Preflight, approve, stop and QC. Approving issues run permits only — no measurement is executed from this screen.",
							"Preflight, одобрение, остановка и QC. Одобрение выпускает только разрешения на прогоны — измерение с этого экрана не запускается.",
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
									variant="outline"
									onClick={() => void loadPreflight(selectedOrder.id)}
									disabled={preflightPending}
								>
									{tr(locale, "Re-check", "Проверить снова")}
								</Button>
							</div>
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
