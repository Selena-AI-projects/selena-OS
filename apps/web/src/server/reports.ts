/**
 * Server functions for report operations.
 * Replaces apps/web/src/app/api/reports/route.ts
 */
import { createServerFn } from "@tanstack/react-start";
import { db } from "@workspace/lib/db/db";
import { type NewReport, reports } from "@workspace/lib/db/schema";
import { cleanOnboardingUrl } from "@workspace/lib/onboarding";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { hasReportAccess, isAdmin, listUserOrganizations, requireAuthSession } from "@/lib/auth/helpers";
import { sendReportJob } from "@/lib/job-scheduler";

/**
 * DS-P0-15: reports are scoped to the caller's organization. The session's
 * active organization wins; without one, the user's first membership does —
 * the same resolution the Selena auth context uses.
 */
async function requireReportAccess(): Promise<{ organizationId: string }> {
	const session = await requireAuthSession();
	if (!hasReportAccess(session)) throw new Error("Access denied. Report generator access required.");
	const activeOrg = (session.session as { activeOrganizationId?: string | null }).activeOrganizationId;
	const memberships = await listUserOrganizations(session.user.id);
	const membership = activeOrg ? memberships.find((org) => org.id === activeOrg) : memberships[0];
	if (!membership) throw new Error("Forbidden: no organization membership");
	return { organizationId: membership.id };
}

/**
 * Legacy rows (organization_id NULL) predate scoping and have no recoverable
 * owner; they stay behind an explicit admin-only path, never the customer one.
 */
async function requireAdminForLegacyReports() {
	const session = await requireAuthSession();
	if (!isAdmin(session)) throw new Error("Access denied. Admin access required.");
}

/**
 * Get all reports
 */
export const getReportsFn = createServerFn({ method: "GET" }).handler(async () => {
	const { organizationId } = await requireReportAccess();

	return db
		.select({
			id: reports.id,
			brandName: reports.brandName,
			brandWebsite: reports.brandWebsite,
			status: reports.status,
			createdAt: reports.createdAt,
			completedAt: reports.completedAt,
			updatedAt: reports.updatedAt,
		})
		.from(reports)
		.where(eq(reports.organizationId, organizationId))
		.orderBy(desc(reports.createdAt));
});

/** Admin-only read of unattributed legacy rows — deliberately not the customer path. */
export const getLegacyReportsFn = createServerFn({ method: "GET" }).handler(async () => {
	await requireAdminForLegacyReports();
	return db
		.select({
			id: reports.id,
			brandName: reports.brandName,
			brandWebsite: reports.brandWebsite,
			status: reports.status,
			createdAt: reports.createdAt,
		})
		.from(reports)
		.where(isNull(reports.organizationId))
		.orderBy(desc(reports.createdAt));
});

/**
 * Get a single report by ID (includes rawOutput for rendering)
 */
export const getReportByIdFn = createServerFn({ method: "GET" })
	.validator(z.object({ reportId: z.string() }))
	.handler(async ({ data }) => {
		const { organizationId } = await requireReportAccess();

		const result = await db
			.select()
			.from(reports)
			.where(and(eq(reports.id, data.reportId), eq(reports.organizationId, organizationId)))
			.limit(1);
		if (result.length === 0) throw new Error("Report not found");
		const report = result[0];
		return { ...report, rawOutput: report.rawOutput as {} | null };
	});

/**
 * Create a new report and queue generation job
 */
export const createReportFn = createServerFn({ method: "POST" })
	.validator(
		z.object({
			brandName: z.string().min(1),
			// The report worker fetches this page, so reject anything it can't
			// fetch (non-http(s) schemes) here rather than after the row exists.
			brandWebsite: z
				.string()
				.min(1)
				.refine((website) => cleanOnboardingUrl(website) !== "", "Enter a valid domain or http(s) website URL"),
			manualPrompts: z.string().optional(),
		}),
	)
	.handler(async ({ data }) => {
		const { organizationId } = await requireReportAccess();

		// Parse manual prompts
		const parsedManualPrompts: string[] = [];
		if (data.manualPrompts?.trim()) {
			parsedManualPrompts.push(
				...data.manualPrompts
					.split("\n")
					.map((line) => line.trim())
					.filter((line) => line.length > 0),
			);
		}

		// Create report
		const newReport: NewReport = {
			brandName: data.brandName.trim(),
			// Full path is kept — it's what the analysis reads — but credentials
			// are stripped before the URL is stored or handed to any fetcher.
			brandWebsite: cleanOnboardingUrl(data.brandWebsite),
			organizationId,
			status: "pending",
		};

		const result = await db.insert(reports).values(newReport).returning();
		const createdReport = result[0];
		if (!createdReport) throw new Error("Failed to create report");

		// Queue job
		try {
			const success = await sendReportJob(
				createdReport.id,
				createdReport.brandName,
				createdReport.brandWebsite,
				parsedManualPrompts.length > 0 ? parsedManualPrompts : undefined,
			);
			if (!success) throw new Error("Failed to send report job");
		} catch (error) {
			await db.update(reports).set({ status: "failed", updatedAt: new Date() }).where(eq(reports.id, createdReport.id));
			throw new Error("Failed to queue report generation");
		}

		return { ...createdReport, rawOutput: createdReport.rawOutput as {} | null };
	});
