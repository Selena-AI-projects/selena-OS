import { z } from "zod";

export const READINESS_SCORING_MODEL_VERSION = "public-readiness-v1" as const;
export const readinessComponentSchema = z.object({ id: z.string(), label: z.string(), score: z.number().int().min(0).max(100), weight: z.number().min(0).max(1), status: z.enum(["weighted", "diagnostic_only"]) });
export type ReadinessComponent = z.infer<typeof readinessComponentSchema>;
export const readinessFindingSchema = z.object({ id: z.string(), severity: z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"]), pageUrl: z.string().url(), blockId: z.string().nullable(), ruleId: z.string(), ruleVersion: z.string(), statement: z.string(), evidence: z.string(), generatedFixId: z.string().nullable() });
export type ReadinessFinding = z.infer<typeof readinessFindingSchema>;
export const readinessResultSchema = z.object({ score: z.number().int().min(0).max(100), scoringModelVersion: z.literal(READINESS_SCORING_MODEL_VERSION), components: z.array(readinessComponentSchema), findings: z.array(readinessFindingSchema), pagesScanned: z.number().int().min(1).max(5), paidProviderCalls: z.literal(0), visibilityClaim: z.literal("Readiness is technical/content readiness, not observed AI visibility or a ChatGPT recommendation.") });
export type ReadinessResult = z.infer<typeof readinessResultSchema>;

type ReadinessInput = { pageUrl: string; status: number; robots: string | null; canonical: string | null; headings: string[]; visibleText: string; jsonLd: unknown[]; contacts: string[]; services: string[]; metadata: Record<string, string>; internalLinks: string[] };
const present = (value: unknown) => Array.isArray(value) ? value.length > 0 : typeof value === "string" ? value.trim().length > 0 && value !== "UNKNOWN" : Boolean(value);
const finding = (pageUrl: string, ruleId: string, severity: ReadinessFinding["severity"], statement: string, evidence: string): ReadinessFinding => ({ id: `${ruleId}:${pageUrl}`, severity, pageUrl, blockId: null, ruleId, ruleVersion: READINESS_SCORING_MODEL_VERSION, statement, evidence, generatedFixId: null });

export function scorePublicReadiness(input: ReadinessInput): ReadinessResult {
	const technical = input.status >= 200 && input.status < 400 ? 100 : 0;
	const crawler = input.robots === null ? 35 : 100;
	const structured = present(input.jsonLd) ? 100 : 25;
	const entity = present(input.metadata.title) && present(input.metadata.description) ? 100 : 40;
	const citability = input.headings.length > 0 && input.visibleText.length >= 160 ? 100 : 45;
	const content = input.visibleText.length >= 500 && input.services.length > 0 ? 100 : 40;
	const business = input.contacts.length > 0 ? 100 : 35;
	const conversion = input.internalLinks.length > 0 ? 100 : 30;
	const components: ReadinessComponent[] = [
		{ id: "technical-accessibility", label: "Technical accessibility", score: technical, weight: 0.15, status: "weighted" },
		{ id: "ai-crawler-access", label: "AI crawler accessibility", score: crawler, weight: 0.15, status: "weighted" },
		{ id: "structured-data", label: "Structured data", score: structured, weight: 0.12, status: "weighted" },
		{ id: "entity-clarity", label: "Entity clarity", score: entity, weight: 0.12, status: "weighted" },
		{ id: "citability", label: "Citability", score: citability, weight: 0.16, status: "weighted" },
		{ id: "content-readiness", label: "Content readiness", score: content, weight: 0.12, status: "weighted" },
		{ id: "business-consistency", label: "Business information consistency", score: business, weight: 0.10, status: "weighted" },
		{ id: "conversion-readiness", label: "Conversion readiness", score: conversion, weight: 0.08, status: "weighted" },
		{ id: "llms-txt", label: "llms.txt", score: input.robots?.includes("llms.txt") ? 100 : 0, weight: 0, status: "diagnostic_only" },
	];
	const findings: ReadinessFinding[] = [];
	if (technical === 0) findings.push(finding(input.pageUrl, "READINESS-TECH-001", "CRITICAL", "The page is not accessible with a successful HTTP response.", `HTTP ${input.status}`));
	if (input.robots === null) findings.push(finding(input.pageUrl, "READINESS-CRAWL-001", "HIGH", "robots.txt could not be verified for crawler guidance.", "robots evidence unavailable"));
	if (!present(input.jsonLd)) findings.push(finding(input.pageUrl, "READINESS-SCHEMA-001", "MEDIUM", "No structured data was detected on the page.", "JSON-LD and microdata were empty"));
	if (!present(input.metadata.title)) findings.push(finding(input.pageUrl, "READINESS-ENTITY-001", "HIGH", "The page has no detectable title for entity clarity.", "title missing"));
	if (input.headings.length === 0) findings.push(finding(input.pageUrl, "READINESS-CITABILITY-001", "HIGH", "No heading structure was detected for answer extraction.", "headings empty"));
	if (input.contacts.length === 0) findings.push(finding(input.pageUrl, "READINESS-BUSINESS-001", "MEDIUM", "No public contact signal was detected.", "contact evidence empty"));
	const score = Math.round(components.filter((item) => item.status === "weighted").reduce((sum, item) => sum + item.score * item.weight, 0));
	return readinessResultSchema.parse({ score, scoringModelVersion: READINESS_SCORING_MODEL_VERSION, components, findings, pagesScanned: 1, paidProviderCalls: 0, visibilityClaim: "Readiness is technical/content readiness, not observed AI visibility or a ChatGPT recommendation." });
}
