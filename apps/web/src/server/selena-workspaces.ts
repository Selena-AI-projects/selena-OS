import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders, getRequestUrl } from "@tanstack/react-start/server";
import { z } from "zod";
import { requireAuthSession, requireOrgAccess } from "@/lib/auth/helpers";
import { auth } from "@/lib/auth/server";
import { getDeployment } from "@/lib/config/server";

export const listSelenaWorkspaces = createServerFn({ method: "GET" }).handler(async () => {
	const session = await requireAuthSession();
	const organizations = await auth.api.listOrganizations({ headers: getRequestHeaders() });
	return {
		activeOrganizationId: (session.session as { activeOrganizationId?: string | null }).activeOrganizationId ?? null,
		readOnly: getDeployment().features.readOnly,
		organizations: organizations.map(({ id, name }) => ({ id, name })),
	};
});

export const selectSelenaWorkspace = createServerFn({ method: "POST" })
	.validator(z.strictObject({ organizationId: z.string().trim().min(1).max(255) }))
	.handler(async ({ data }) => {
		if (getDeployment().features.readOnly) throw new Error("Workspace switching is disabled in demo mode");
		const headers = getRequestHeaders();
		if (headers.get("origin") !== getRequestUrl().origin) throw new Error("Forbidden: same-origin request required");
		const session = await requireAuthSession();
		await requireOrgAccess(session.user.id, data.organizationId);
		// Use the auth plugin so session cookies and its membership checks stay authoritative.
		// Its organization-management HTTP endpoints remain blocked by deployment policy.
		const selected = await auth.api.setActiveOrganization({
			headers,
			body: { organizationId: data.organizationId },
		});
		if (selected?.id !== data.organizationId) throw new Error("Workspace selection failed");
		return { organizationId: selected.id };
	});
