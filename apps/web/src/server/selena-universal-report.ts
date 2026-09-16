import { createHash } from "node:crypto";
import { z } from "zod";

const id = z.string().trim().min(1).max(300);
const coordinate = z.object({ id, latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) });
const item = z.object({
	identity: id,
	name: id,
	rank: z.number().int().positive().max(100),
	kind: z.enum(["ORGANIC", "AD"]),
});
const source = z.object({
	id,
	label: id,
	capturedAt: z.iso.datetime(),
	url: z
		.url()
		.refine((url) => ["https:", "http:"].includes(new URL(url).protocol))
		.optional(),
});
const action = z.object({
	id,
	title: id,
	observationIds: z.array(id).min(1),
	sourceIds: z.array(id).min(1),
	finding: z.string().min(1),
	hypothesis: z.string().min(1),
	work: z.string().min(1),
	factOwner: id,
	implementationOwner: id,
	acceptance: z.string().min(1),
	measurement: z.string().min(1),
});

export const universalReportSchema = z.strictObject({
	version: z.literal(1),
	publicationVersion: z.number().int().positive().optional(),
	publishedAt: z.iso.datetime().optional(),
	organizationId: id,
	projectId: id,
	reportId: id,
	orderId: id.nullable(),
	publication: z.enum(["DRAFT", "PUBLISHED", "REVOKED"]),
	measurementMode: z.enum(["FIXTURE", "PROVIDER"]),
	restaurant: z.object({ identity: id, name: id }),
	queries: z
		.array(z.object({ id, text: id }))
		.min(1)
		.max(15),
	points: z.array(coordinate).min(1).max(25),
	protocol: z.object({
		language: id,
		device: z.enum(["desktop", "mobile"]),
		timezone: id,
		requestedDepth: z.number().int().positive().max(100),
	}),
	observations: z
		.array(
			z.object({
				id,
				queryId: id,
				pointId: id,
				outcome: z.enum(["FOUND", "NOT_FOUND", "PENDING", "UNKNOWN", "INVALID", "CANCELLED"]),
				capturedAt: z.iso.datetime().nullable(),
				sourceId: id.nullable(),
				targetRank: z.number().int().positive().nullable(),
				returnedCount: z.number().int().nonnegative(),
				competitionComplete: z.boolean(),
				items: z.array(item),
			}),
		)
		.max(375),
	sources: z.array(source).max(2000),
	analysis: z.object({ status: z.enum(["PENDING", "REVIEWED"]), actions: z.array(action).max(50) }),
});
export type UniversalReport = z.infer<typeof universalReportSchema>;

function requireUnique(values: string[], code: string) {
	if (new Set(values).size !== values.length) throw new Error(code);
}

/** Presentation boundary only: callers must resolve session membership and load a scoped immutable publication. */
export function buildUniversalReportView(input: unknown, scope: { organizationId: string; projectId: string }) {
	const report = universalReportSchema.parse(input);
	if (report.organizationId !== scope.organizationId || report.projectId !== scope.projectId)
		throw new Error("REPORT_NOT_FOUND");
	if (report.publication !== "PUBLISHED") throw new Error("REPORT_NOT_PUBLISHED");
	requireUnique(
		report.queries.map((q) => q.id),
		"REPORT_QUERY_DUPLICATE",
	);
	requireUnique(
		report.queries.map((q) => q.text.normalize("NFKC").toLowerCase()),
		"REPORT_QUERY_DUPLICATE",
	);
	requireUnique(
		report.points.map((p) => p.id),
		"REPORT_POINT_DUPLICATE",
	);
	requireUnique(
		report.points.map((p) => `${p.latitude},${p.longitude}`),
		"REPORT_COORDINATE_DUPLICATE",
	);
	requireUnique(
		report.observations.map((o) => o.id),
		"REPORT_OBSERVATION_DUPLICATE",
	);
	requireUnique(
		report.observations.map((o) => JSON.stringify([o.queryId, o.pointId])),
		"REPORT_SLOT_DUPLICATE",
	);
	requireUnique(
		report.sources.map((s) => s.id),
		"REPORT_SOURCE_DUPLICATE",
	);
	const queryIds = new Set(report.queries.map((q) => q.id));
	const pointIds = new Set(report.points.map((p) => p.id));
	const sourceIds = new Set(report.sources.map((s) => s.id));
	for (const observation of report.observations) {
		if (!queryIds.has(observation.queryId) || !pointIds.has(observation.pointId))
			throw new Error("REPORT_SLOT_OUTSIDE_ORDER");
		const valid = ["FOUND", "NOT_FOUND"].includes(observation.outcome);
		if (valid && (!observation.capturedAt || !observation.sourceId || !sourceIds.has(observation.sourceId)))
			throw new Error("REPORT_EVIDENCE_MISSING");
		if (observation.sourceId && !sourceIds.has(observation.sourceId)) throw new Error("REPORT_EVIDENCE_MISSING");
		if (
			observation.outcome === "FOUND"
				? observation.targetRank === null || observation.targetRank > report.protocol.requestedDepth
				: observation.targetRank !== null
		)
			throw new Error("REPORT_RANK_INCONSISTENT");
		if (!valid && observation.items.length) throw new Error("REPORT_UNCONFIRMED_COMPETITION");
		if (
			observation.items.length > observation.returnedCount ||
			(observation.competitionComplete && observation.items.length !== observation.returnedCount)
		)
			throw new Error("REPORT_DEPTH_INCONSISTENT");
		const organic = observation.items.filter((i) => i.kind === "ORGANIC");
		requireUnique(
			organic.map((i) => String(i.rank)),
			"REPORT_ORGANIC_RANK_DUPLICATE",
		);
		requireUnique(
			organic.map((i) => i.identity),
			"REPORT_ORGANIC_IDENTITY_DUPLICATE",
		);
		if (organic.some((i) => i.rank > report.protocol.requestedDepth)) throw new Error("REPORT_RANK_INCONSISTENT");
		const target = organic.find((i) => i.identity === report.restaurant.identity);
		if (target && (observation.outcome !== "FOUND" || target.rank !== observation.targetRank))
			throw new Error("REPORT_TARGET_IDENTITY_MISMATCH");
		if (observation.outcome === "FOUND" && observation.competitionComplete && !target)
			throw new Error("REPORT_TARGET_IDENTITY_MISMATCH");
	}
	const observations = new Map(report.observations.map((o) => [o.id, o]));
	requireUnique(
		report.analysis.actions.map((a) => a.id),
		"REPORT_ACTION_DUPLICATE",
	);
	for (const recommendation of report.analysis.actions) {
		if (report.analysis.status !== "REVIEWED") throw new Error("REPORT_ANALYSIS_NOT_REVIEWED");
		if (
			recommendation.sourceIds.some((s) => !sourceIds.has(s)) ||
			recommendation.observationIds.some(
				(id) => !recommendation.sourceIds.includes(observations.get(id)?.sourceId ?? ""),
			) ||
			recommendation.observationIds.some((o) => !["FOUND", "NOT_FOUND"].includes(observations.get(o)?.outcome ?? ""))
		)
			throw new Error("REPORT_ACTION_EVIDENCE_MISSING");
	}
	const queries = report.queries.map((query) => {
		const rows = report.observations.filter((o) => o.queryId === query.id);
		const found = rows.filter((o) => o.outcome === "FOUND");
		const valid = rows.filter((o) => ["FOUND", "NOT_FOUND"].includes(o.outcome));
		return {
			...query,
			expected: report.points.length,
			received: rows.length,
			valid: valid.length,
			found: found.length,
			top3: found.filter((o) => (o.targetRank ?? Infinity) <= 3).length,
			notFound: rows.filter((o) => o.outcome === "NOT_FOUND").length,
			unresolved: report.points.length - valid.length,
		};
	});
	const competitors = new Map<
		string,
		{ identity: string; name: string; first: number; top3: number; observations: number; ahead: number }
	>();
	for (const observation of report.observations) {
		for (const competitor of observation.items.filter(
			(i) => i.kind === "ORGANIC" && i.identity !== report.restaurant.identity,
		)) {
			const row = competitors.get(competitor.identity) ?? {
				identity: competitor.identity,
				name: competitor.name,
				first: 0,
				top3: 0,
				observations: 0,
				ahead: 0,
			};
			row.first += Number(competitor.rank === 1);
			row.top3 += Number(competitor.rank <= 3);
			row.observations++;
			row.ahead += Number(observation.targetRank !== null && competitor.rank < observation.targetRank);
			competitors.set(row.identity, row);
		}
	}
	const expected = report.points.length * report.queries.length;
	const valid = queries.reduce((n, q) => n + q.valid, 0);
	return {
		report,
		queries,
		competitors: [...competitors.values()].sort(
			(a, b) => b.first - a.first || b.top3 - a.top3 || a.identity.localeCompare(b.identity),
		),
		expected,
		valid,
		unresolved: expected - valid,
		measurementComplete: expected === valid,
		analysisComplete: report.analysis.status === "REVIEWED",
		fixture: report.measurementMode === "FIXTURE",
	};
}

const escapeHtml = (value: unknown) =>
	String(value ?? "").replace(
		/[&<>"']/g,
		(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
	);
const labels = {
	FOUND: "Найден",
	NOT_FOUND: "Не найден в полученном ответе",
	PENDING: "Ожидается",
	UNKNOWN: "Результат не подтверждён",
	INVALID: "Проверка не прошла валидацию",
	CANCELLED: "Отменено",
};

function coordinatePlot(report: UniversalReport, queryId: string) {
	const center = report.points.reduce((n, p) => n + p.latitude, 0) / report.points.length;
	const xs = report.points.map((p) => p.longitude * Math.cos((center * Math.PI) / 180)),
		ys = report.points.map((p) => p.latitude);
	const minX = Math.min(...xs),
		maxY = Math.max(...ys),
		span = Math.max(Math.max(...xs) - minX, maxY - Math.min(...ys), 0.000001);
	const observations = new Map(report.observations.filter((o) => o.queryId === queryId).map((o) => [o.pointId, o]));
	return `<svg viewBox="0 0 480 480" role="img" aria-label="Схема точек по координатам, север сверху" class="coordinate-plot">${report.points
		.map((p, i) => {
			const o = observations.get(p.id);
			const x = 40 + (400 * (xs[i] - minX)) / span,
				y = 40 + (400 * (maxY - p.latitude)) / span;
			return `<g><title>P${i + 1}: ${escapeHtml(o ? labels[o.outcome] : "Ожидается")}</title><circle cx="${x}" cy="${y}" r="21" fill="#fffdf8" stroke="#b9825b"/><text x="${x}" y="${y + 5}" text-anchor="middle" fill="#181614">${o?.targetRank ?? (o?.outcome === "NOT_FOUND" ? "—" : "?")}</text><text x="${x}" y="${y + 36}" text-anchor="middle" fill="#181614" font-size="12">P${i + 1}</text></g>`;
		})
		.join("")}</svg>`;
}

export function renderUniversalReport(view: ReturnType<typeof buildUniversalReportView>) {
	const { report } = view;
	const queryName = new Map(report.queries.map((q) => [q.id, q.text]));
	const point = new Map(report.points.map((p) => [p.id, p]));
	const pointLabel = new Map(report.points.map((p, i) => [p.id, `P${i + 1}`]));
	const body = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(report.restaurant.name)} — отчёт Google Maps</title><style>body{margin:0;background:#f7f2ea;color:#181614;font:16px/1.6 system-ui,sans-serif}main{max-width:1080px;margin:auto;padding:28px 20px}h1,h2{font-family:Georgia,serif;line-height:1.2}h1{font-size:36px}h2{margin-top:36px;font-size:28px}table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #e6ddd1;text-align:left;padding:12px;vertical-align:top}.scroll{overflow:auto}summary{cursor:pointer;min-height:44px;padding:10px 0}details{border-top:1px solid #e6ddd1;margin:12px 0}p{max-width:75ch}h1,h2,td,summary,li{overflow-wrap:anywhere}a{color:#8f5c34}li{margin:8px 0}:focus-visible{outline:3px solid #8f5c34;outline-offset:3px}.notice{background:#fffdf8;padding:16px}small{font-size:14px}.coordinate-plot{max-width:480px;width:100%;height:auto}nav a{display:inline-block;min-height:44px;padding:8px;margin-right:12px;box-sizing:border-box}@media(max-width:600px){h1{font-size:30px}}@media print{details{break-inside:avoid}nav{display:none}}</style></head><body><main><p>Selena Systems · Google Maps</p><h1>${escapeHtml(report.restaurant.name)}</h1><p>Версия ${report.publicationVersion ?? 1}${report.publishedAt ? ` · Опубликовано UTC: ${escapeHtml(report.publishedAt)}` : ""}</p><nav aria-label="Выгрузка отчёта"><a href="${report.orderId ? `/selena/local/checkout?order=${encodeURIComponent(report.orderId)}` : "/selena/local/checkout"}">${report.orderId ? "К заказу" : "К кабинету"}</a><a href="/api/v1/selena/local-prepayment/reports/${encodeURIComponent(report.reportId)}?format=csv">Скачать CSV</a><a href="/api/v1/selena/local-prepayment/reports/${encodeURIComponent(report.reportId)}?format=print">Версия для печати / PDF</a></nav>${view.fixture ? '<p class="notice"><b>Демонстрационные данные. Это не реальный замер и не доказательство видимости ресторана.</b></p>' : ""}<p>Язык запроса: ${escapeHtml(report.protocol.language)}. Устройство: ${escapeHtml(report.protocol.device)}. Часовой пояс заказа: ${escapeHtml(report.protocol.timezone)}.</p><h2>Где мы сейчас</h2><p>Подтверждено ${view.valid} из ${view.expected} проверок. ${view.measurementComplete ? "Все запланированные проверки подтверждены." : `Остаются неподтверждёнными ${view.unresolved}; они не считаются отсутствием ресторана.`}</p><p>Одна проверка — один запрос из одной координаты. Это не число гостей, показов или бронирований.</p><div class="scroll"><table><thead><tr><th>Запрос</th><th>Подтверждено</th><th>Найден</th><th>Первая тройка</th><th>Не подтверждено</th></tr></thead><tbody>${view.queries.map((q) => `<tr><td>${escapeHtml(q.text)}</td><td>${q.valid}/${q.expected}</td><td>${q.found}</td><td>${q.top3}</td><td>${q.unresolved}</td></tr>`).join("")}</tbody></table></div><h2>Конкуренты в сохранённой выдаче</h2><p>Сравнение ограничено сохранёнными нерекламными результатами. Неполные списки не доказывают отсутствие конкурента; рекламные места исключены из этой таблицы. Когда ваш ресторан не найден, относительная позиция конкурента неизвестна.</p><div class="scroll"><table><thead><tr><th>Ресторан</th><th>Первых мест</th><th>В первой тройке</th><th>Выше вашего ресторана</th></tr></thead><tbody>${view.competitors.map((c) => `<tr><td>${escapeHtml(c.name)}</td><td>${c.first}</td><td>${c.top3}</td><td>${c.ahead}</td></tr>`).join("")}</tbody></table></div><h2>Каждая проверка</h2>${report.observations
		.map((o) => {
			const p = point.get(o.pointId);
			return `<details><summary>${escapeHtml(queryName.get(o.queryId))} · ${escapeHtml(pointLabel.get(o.pointId))} · ${labels[o.outcome]}${o.targetRank === null ? "" : `, место ${o.targetRank}`}</summary><p>Координаты: ${p?.latitude}, ${p?.longitude}. Время UTC: ${escapeHtml(o.capturedAt ?? "не подтверждено")}.</p><p>Запрошенная глубина ${report.protocol.requestedDepth}; получено ${o.returnedCount}; список конкурентов ${o.competitionComplete ? "полный для этого ответа" : "неполный"}.</p><ol>${o.items.map((i) => `<li>${i.kind === "AD" ? "Реклама" : `Органическое место ${i.rank}`}: ${escapeHtml(i.name)}</li>`).join("")}</ol><small>Источник: ${escapeHtml(o.sourceId ?? "ожидается")}</small></details>`;
		})
		.join(
			"",
		)}${report.queries.map((q) => `<h2>${escapeHtml(q.text)}</h2>${coordinatePlot(report, q.id)}`).join("")}<h2>Что делать дальше</h2>${view.analysisComplete ? (report.analysis.actions.length ? report.analysis.actions.map((a) => `<article><h3>${escapeHtml(a.title)}</h3><p><b>Наблюдение:</b> ${escapeHtml(a.finding)}</p><p><b>Гипотеза, не установленная причина:</b> ${escapeHtml(a.hypothesis)}</p><p><b>Работа:</b> ${escapeHtml(a.work)}</p><p><b>Кто подтверждает факты:</b> ${escapeHtml(a.factOwner)}. <b>Кто выполняет:</b> ${escapeHtml(a.implementationOwner)}.</p><p><b>Приёмка:</b> ${escapeHtml(a.acceptance)}</p><p><b>Повторная проверка:</b> ${escapeHtml(a.measurement)}</p><small>Наблюдения: ${a.observationIds.map(escapeHtml).join(", ")}; источники: ${a.sourceIds.map(escapeHtml).join(", ")}.</small></article>`).join("") : "<p>Обзор завершён; подтверждённых оснований для изменений не зафиксировано.</p>") : '<p class="notice">Измерения и экспертные рекомендации — разные этапы. Анализ ещё не проверен; готовые рекомендации здесь не заявлены.</p>'}<h2>Направления отдельного исследования</h2><p>География, отзывы, карточка Maps, сайт и бронирование, внешние упоминания, история и реклама. Проверка причин по этим семи направлениям не входит в факт получения позиций; непроверенное не означает отсутствующее.</p><h2>Источники</h2><ul>${report.sources.map((s) => `<li>${escapeHtml(s.id)} · ${escapeHtml(s.label)} · ${escapeHtml(s.capturedAt)}${s.url ? ` · <a href="${escapeHtml(s.url)}" rel="noopener noreferrer" target="_blank">Открыть источник</a>` : ""}</li>`).join("")}</ul><p>Каких гостей и каких бронирований вы хотели бы видеть больше? Приоритеты и реальные условия ресторана определяют дальнейший план. Этот отчёт не гарантирует позицию в выдаче.</p></main></body></html>`;
	return body;
}

export function universalReportCsv(view: ReturnType<typeof buildUniversalReportView>) {
	const cell = (v: unknown) => {
		let s = v == null ? "" : String(v);
		if (typeof v === "string" && /^[\s]*[=+@-]/.test(s)) s = `'${s}`;
		return `"${s.replaceAll('"', '""')}"`;
	};
	const queries = new Map(view.report.queries.map((q) => [q.id, q.text]));
	const points = new Map(view.report.points.map((p) => [p.id, p]));
	return [
		[
			"Mode",
			"Query",
			"Point",
			"Outcome",
			"Organic rank",
			"Evidence",
			"Latitude",
			"Longitude",
			"Captured UTC",
			"Requested depth",
			"Returned count",
			"Competition complete",
			"Organic and advertising items",
			"Analysis status",
		],
		...view.report.observations.map((o) => [
			view.report.measurementMode,
			queries.get(o.queryId),
			o.pointId,
			o.outcome,
			o.targetRank,
			o.sourceId,
			points.get(o.pointId)?.latitude,
			points.get(o.pointId)?.longitude,
			o.capturedAt,
			view.report.protocol.requestedDepth,
			o.returnedCount,
			o.competitionComplete,
			JSON.stringify(o.items),
			view.report.analysis.status,
		]),
	]
		.map((r) => r.map(cell).join(","))
		.join("\r\n");
}

/** No endpoint is registered until the server adapter supplies persisted, tenant-scoped publications. */
export function createUniversalReportHandler(dependencies: {
	authenticate: () => Promise<{ authType: "session"; organizationId: string; projectId: string }>;
	loadPublication: (scope: { organizationId: string; projectId: string }, reportId: string) => Promise<unknown | null>;
}) {
	return async (request: Request, reportId: string) => {
		const privateHeaders = {
			"Cache-Control": "private, no-store",
			Vary: "Cookie",
			"X-Content-Type-Options": "nosniff",
			"Referrer-Policy": "no-referrer",
		};
		try {
			const scope = await dependencies.authenticate();
			if (scope.authType !== "session")
				return new Response("Sign in required", { status: 401, headers: privateHeaders });
			const input = await dependencies.loadPublication(scope, reportId);
			if (!input) return new Response("Report not found", { status: 404, headers: privateHeaders });
			const view = buildUniversalReportView(input, scope);
			if (view.report.reportId !== reportId) throw new Error("REPORT_NOT_FOUND");
			const evidenceId = new URL(request.url).searchParams.get("evidence");
			if (evidenceId) {
				const observation = view.report.observations.find((o) => o.id === evidenceId);
				if (!observation) return new Response("Evidence not found", { status: 404, headers: privateHeaders });
				return Response.json(
					{
						measurementMode: view.report.measurementMode,
						observation,
						source: view.report.sources.find((s) => s.id === observation.sourceId) ?? null,
					},
					{ headers: privateHeaders },
				);
			}
			const csv = new URL(request.url).searchParams.get("format") === "csv";
			let body = csv ? universalReportCsv(view) : renderUniversalReport(view);
			if (new URL(request.url).searchParams.get("format") === "print")
				body = body.replaceAll("<details>", "<details open>");
			const style = /<style>([\s\S]*?)<\/style>/.exec(body)?.[1] ?? "";
			return new Response(body, {
				headers: {
					...privateHeaders,
					"Content-Type": csv ? "text/csv; charset=utf-8" : "text/html; charset=utf-8",
					"Content-Disposition": `${csv ? "attachment" : "inline"}; filename="local-visibility-report.${csv ? "csv" : "html"}"`,
					"Content-Security-Policy": `default-src 'none'; style-src 'sha256-${createHash("sha256").update(style).digest("base64")}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; sandbox allow-popups allow-downloads`,
				},
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : "";
			const status = message.startsWith("Unauthorized")
				? 401
				: message.startsWith("Forbidden")
					? 403
					: ["REPORT_NOT_FOUND", "REPORT_NOT_PUBLISHED"].includes(message)
						? 404
						: 503;
			return new Response(status === 503 ? "Report validation or retrieval failed" : "Report unavailable", {
				status,
				headers: privateHeaders,
			});
		}
	};
}
