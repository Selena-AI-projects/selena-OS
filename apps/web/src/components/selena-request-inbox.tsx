import { Badge } from "@workspace/ui/components/badge";
import { Button } from "@workspace/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@workspace/ui/components/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@workspace/ui/components/table";
import { useCallback, useEffect, useState } from "react";
import {
	listSelenaOrderRequestsFn,
	type OrderRequestRow,
	updateSelenaOrderRequestStatusFn,
} from "@/server/selena-order-requests";

// Plan requests customers left in the cabinet. They are leads: the operator
// still builds the order on the desk above, so a request never starts work by
// itself. A request marked "free by promo" was let through without payment.

type InboxLocale = "en" | "ru";

function tr(locale: InboxLocale, english: string, russian: string): string {
	return locale === "ru" ? russian : english;
}

const PLAN_LABELS: Record<string, string> = {
	"visitor-local": "Snapshot · $49",
	"full-ai-landscape": "Landscape · $79",
};

export function SelenaRequestInbox({ locale }: { locale: InboxLocale }) {
	const [requests, setRequests] = useState<OrderRequestRow[] | null>(null);
	const [pendingId, setPendingId] = useState("");
	const [error, setError] = useState("");

	const load = useCallback(async () => {
		try {
			setRequests(await listSelenaOrderRequestsFn());
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Could not load the requests");
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	const setStatus = async (requestId: string, status: "IN_PROGRESS" | "CLOSED") => {
		setPendingId(requestId);
		setError("");
		try {
			await updateSelenaOrderRequestStatusFn({ data: { requestId, status } });
			await load();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Could not update the request");
		} finally {
			setPendingId("");
		}
	};

	return (
		<Card>
			<CardHeader>
				<CardTitle>{tr(locale, "Plan requests", "Заявки на тариф")}</CardTitle>
				<CardDescription>
					{tr(
						locale,
						"What customers asked for from the cabinet. A request is a lead — build the order above once the payment (or a promo code) is settled.",
						"Что клиенты запросили из кабинета. Заявка — это обращение: оформляйте заказ выше, когда оплата (или промокод) улажена.",
					)}
				</CardDescription>
			</CardHeader>
			<CardContent>
				{error && <p className="mb-4 text-sm text-destructive">{error}</p>}
				{requests === null ? (
					<p className="text-sm text-muted-foreground">{tr(locale, "Loading…", "Загружаем…")}</p>
				) : requests.length === 0 ? (
					<p className="text-sm text-muted-foreground">
						{tr(locale, "No plan requests yet.", "Заявок на тариф пока нет.")}
					</p>
				) : (
					<div className="overflow-x-auto">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>{tr(locale, "Project", "Проект")}</TableHead>
									<TableHead>{tr(locale, "Plan", "Тариф")}</TableHead>
									<TableHead>{tr(locale, "Contact", "Контакт")}</TableHead>
									<TableHead>{tr(locale, "Payment", "Оплата")}</TableHead>
									<TableHead>{tr(locale, "Status", "Статус")}</TableHead>
									<TableHead />
								</TableRow>
							</TableHeader>
							<TableBody>
								{requests.map((request) => (
									<TableRow key={request.id}>
										<TableCell className="font-medium">
											{request.projectName}
											{request.comment && (
												<span className="mt-1 block text-xs text-muted-foreground">{request.comment}</span>
											)}
										</TableCell>
										<TableCell>{PLAN_LABELS[request.planId] ?? request.planId}</TableCell>
										<TableCell>
											{request.contactName}
											<span className="block text-xs text-muted-foreground">{request.contactChannel}</span>
										</TableCell>
										<TableCell>
											{request.promoApplied ? (
												<Badge>{tr(locale, `Free · ${request.promoCode}`, `Бесплатно · ${request.promoCode}`)}</Badge>
											) : (
												<span className="text-xs text-muted-foreground">
													{tr(locale, "To be arranged", "Нужно согласовать")}
												</span>
											)}
										</TableCell>
										<TableCell>
											<span className="rounded-full border px-2 py-0.5 text-xs">{request.status}</span>
										</TableCell>
										<TableCell className="text-right">
											<div className="flex justify-end gap-2">
												{request.status !== "IN_PROGRESS" && request.status !== "CLOSED" && (
													<Button
														type="button"
														size="sm"
														variant="outline"
														disabled={pendingId === request.id}
														onClick={() => void setStatus(request.id, "IN_PROGRESS")}
													>
														{tr(locale, "In progress", "В работу")}
													</Button>
												)}
												{request.status !== "CLOSED" && (
													<Button
														type="button"
														size="sm"
														variant="outline"
														disabled={pendingId === request.id}
														onClick={() => void setStatus(request.id, "CLOSED")}
													>
														{tr(locale, "Close", "Закрыть")}
													</Button>
												)}
											</div>
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</div>
				)}
			</CardContent>
		</Card>
	);
}
