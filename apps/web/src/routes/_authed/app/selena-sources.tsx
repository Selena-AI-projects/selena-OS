import { createFileRoute } from "@tanstack/react-router";
import { Badge } from "@workspace/ui/components/badge";
import { Button } from "@workspace/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@workspace/ui/components/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@workspace/ui/components/table";
import { useCallback, useEffect, useState } from "react";
import { getSelenaSourceMapFn, listSelenaSourceProjectsFn } from "@/server/selena-sources";

export const Route = createFileRoute("/_authed/app/selena-sources")({
	loader: () => listSelenaSourceProjectsFn(),
	component: SelenaSourceMap,
});

type SourceMap = Awaited<ReturnType<typeof getSelenaSourceMapFn>>;
type Source = SourceMap["sources"][number];
type Locale = "en" | "ru";

const copy = {
	en: {
		title: "Source Opportunity Map",
		subtitle:
			"Sources cited in the answers of an analysed cycle, and which of them turned up only alongside competitors.",
		disclaimer:
			"The counters count runs, not the contents of a source. Selena did not read these pages: it recorded which sources an answer cited and which brands that answer named.",
		project: "Project",
		gapsOnly: "Citation gaps only",
		all: "All sources",
		empty: "No cycle has been analysed for this project yet, so there is nothing to aggregate.",
		emptyGaps: "No source in this project was cited only alongside competitors.",
		domain: "Source",
		priority: "Priority",
		gap: "Gap",
		withBrand: "Runs naming the brand",
		withCompetitors: "Runs naming a competitor",
		competitors: "Competitors named",
		reach: "Scenarios × engines",
		stability: "Repeat stability",
		seen: "First / last seen",
		evidence: "Evidence runs",
		formula: "Formula",
		none: "—",
	},
	ru: {
		title: "Карта источников",
		subtitle:
			"Источники, процитированные в ответах проанализированного цикла, и те из них, что встречались только рядом с конкурентами.",
		disclaimer:
			"Счётчики считают прогоны, а не содержимое источника. Selena эти страницы не читала: записано, какие источники цитировал ответ и какие бренды он называл.",
		project: "Проект",
		gapsOnly: "Только citation gaps",
		all: "Все источники",
		empty: "По этому проекту ещё не проанализирован ни один цикл — агрегировать нечего.",
		emptyGaps: "Ни один источник проекта не встречался исключительно рядом с конкурентами.",
		domain: "Источник",
		priority: "Приоритет",
		gap: "Gap",
		withBrand: "Прогонов с брендом",
		withCompetitors: "Прогонов с конкурентом",
		competitors: "Названные конкуренты",
		reach: "Сценарии × движки",
		stability: "Стабильность повторов",
		seen: "Впервые / последний раз",
		evidence: "Прогоны-доказательства",
		formula: "Формула",
		none: "—",
	},
} as const;

function priorityVariant(band: string): "default" | "secondary" | "outline" {
	if (band === "HIGH") return "default";
	return band === "MEDIUM" ? "secondary" : "outline";
}

function formatDate(value: string | null): string {
	return value === null ? "—" : new Date(value).toLocaleDateString();
}

function formatShare(value: number | null): string {
	return value === null ? "—" : `${Math.round(value * 100)}%`;
}

function SelenaSourceMap() {
	const projects = Route.useLoaderData();
	const [locale, setLocale] = useState<Locale>("en");
	const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
	const [gapsOnly, setGapsOnly] = useState(false);
	const [map, setMap] = useState<SourceMap | null>(null);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState("");
	const text = copy[locale];

	useEffect(() => {
		const saved = window.localStorage.getItem("selena-workspace-locale");
		setLocale(saved === "ru" || saved === "en" ? saved : navigator.language.startsWith("ru") ? "ru" : "en");
	}, []);

	const load = useCallback(async () => {
		if (!projectId) return;
		setPending(true);
		setError("");
		try {
			setMap(await getSelenaSourceMapFn({ data: { projectId, gapsOnly } }));
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Unable to read the source map");
			setMap(null);
		} finally {
			setPending(false);
		}
	}, [projectId, gapsOnly]);

	useEffect(() => {
		void load();
	}, [load]);

	const sources: Source[] = map?.sources ?? [];

	return (
		<div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-6">
			<header className="flex flex-wrap items-start justify-between gap-4">
				<div>
					<h1 className="font-semibold text-2xl">{text.title}</h1>
					<p className="mt-1 max-w-3xl text-muted-foreground text-sm">{text.subtitle}</p>
				</div>
				<Button variant="outline" size="sm" onClick={() => setLocale(locale === "en" ? "ru" : "en")}>
					{locale === "en" ? "RU" : "EN"}
				</Button>
			</header>

			<Card>
				<CardHeader>
					<CardTitle className="text-base">{text.project}</CardTitle>
					<CardDescription>{text.disclaimer}</CardDescription>
				</CardHeader>
				<CardContent className="flex flex-wrap items-center gap-3">
					<select
						className="h-9 rounded-md border border-input bg-background px-3 text-sm"
						value={projectId}
						onChange={(event) => setProjectId(event.target.value)}
						aria-label={text.project}
					>
						{projects.map((project) => (
							<option key={project.id} value={project.id}>
								{project.name}
							</option>
						))}
					</select>
					<Button variant={gapsOnly ? "default" : "outline"} size="sm" onClick={() => setGapsOnly(!gapsOnly)}>
						{gapsOnly ? text.gapsOnly : text.all}
					</Button>
				</CardContent>
			</Card>

			{error !== "" && (
				<p className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-destructive text-sm">{error}</p>
			)}

			{!pending && sources.length === 0 && error === "" && (
				<p className="rounded-md border border-dashed p-6 text-muted-foreground text-sm">
					{gapsOnly ? text.emptyGaps : text.empty}
				</p>
			)}

			{sources.length > 0 && (
				<div className="overflow-x-auto rounded-md border">
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>{text.domain}</TableHead>
								<TableHead>{text.priority}</TableHead>
								<TableHead className="text-right">{text.withBrand}</TableHead>
								<TableHead className="text-right">{text.withCompetitors}</TableHead>
								<TableHead>{text.competitors}</TableHead>
								<TableHead className="text-right">{text.reach}</TableHead>
								<TableHead className="text-right">{text.stability}</TableHead>
								<TableHead>{text.seen}</TableHead>
								<TableHead className="text-right">{text.evidence}</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{sources.map((source) => (
								<TableRow key={source.id}>
									<TableCell className="font-medium">
										<span className="flex flex-col gap-1">
											<span>{source.domain}</span>
											{source.gapType !== null && (
												<Badge variant="destructive" className="w-fit">
													{text.gap}
												</Badge>
											)}
											<span className="text-muted-foreground text-xs">{source.formulaVersion}</span>
										</span>
									</TableCell>
									<TableCell>
										<Badge variant={priorityVariant(source.priorityBand)}>{source.priorityBand}</Badge>
									</TableCell>
									<TableCell className="text-right tabular-nums">{source.ownedCitationCount}</TableCell>
									<TableCell className="text-right tabular-nums">{source.competitorCitationCount}</TableCell>
									<TableCell className="text-sm">
										{source.competitorNames.length === 0 ? text.none : source.competitorNames.join(", ")}
									</TableCell>
									<TableCell className="text-right tabular-nums">
										{source.scenarioCount} × {source.engineCount}
									</TableCell>
									<TableCell className="text-right tabular-nums">{formatShare(source.repeatStability)}</TableCell>
									<TableCell className="text-sm">
										{formatDate(source.firstSeen)} / {formatDate(source.lastSeen)}
									</TableCell>
									<TableCell className="text-right tabular-nums">{source.evidenceRunIds.length}</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</div>
			)}
		</div>
	);
}
