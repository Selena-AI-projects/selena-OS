import { createHash } from "node:crypto";
import { createServerOnlyFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { db } from "@workspace/lib/db/db";
import { member, organization, svApiKeys } from "@workspace/lib/db/schema";
import { and, eq, gt, isNull, or } from "drizzle-orm";

export type SelenaRole = "owner" | "member" | "viewer";
export type AuthContext = {
	actorId: string;
	tenantId: string;
	role: SelenaRole;
	authType: "session" | "api_key";
	permissions: string[];
};

const currentRequestHeaders = createServerOnlyFn(() => getRequestHeaders());

function normalizeRole(role: string): SelenaRole {
	if (role === "owner" || role === "admin") return "owner";
	if (role === "viewer") return "viewer";
	return "member";
}

function hashApiKey(value: string): Buffer {
	return createHash("sha256").update(value).digest();
}

export async function resolveSessionAuthContext(): Promise<AuthContext> {
	const { auth } = await import("./auth/server");
	const session = await auth.api.getSession({ headers: currentRequestHeaders() });
	if (!session) throw new Error("Unauthorized: authenticated session required");
	const activeOrg = (session.session as { activeOrganizationId?: string | null }).activeOrganizationId;
	const rows = await db
		.select({ tenantId: member.organizationId, role: member.role })
		.from(member)
		.innerJoin(organization, eq(member.organizationId, organization.id))
		.where(eq(member.userId, session.user.id));
	const membership = activeOrg ? rows.find((row) => row.tenantId === activeOrg) : rows[0];
	if (!membership) throw new Error("Forbidden: no organization membership");
	return {
		actorId: session.user.id,
		tenantId: membership.tenantId,
		role: normalizeRole(membership.role),
		authType: "session",
		permissions: ["client:read", "client:write"],
	};
}

export async function resolveApiKeyAuthContext(request: Request): Promise<AuthContext> {
	const raw = request.headers.get("authorization")?.replace(/^Bearer\s+/, "");
	if (!raw) throw new Error("Unauthorized: API key required");
	const digest = hashApiKey(raw);
	const rows = await db
		.select()
		.from(svApiKeys)
		.where(
			and(
				eq(svApiKeys.keyHash, digest.toString("hex")),
				isNull(svApiKeys.revokedAt),
				or(isNull(svApiKeys.expiresAt), gt(svApiKeys.expiresAt, new Date())),
			),
		)
		.limit(1);
	const key = rows[0];
	if (!key) throw new Error("Unauthorized: invalid or expired API key");
	return {
		actorId: `api-key:${key.id}`,
		tenantId: key.organizationId,
		role: "owner",
		authType: "api_key",
		permissions: key.permissions,
	};
}

export function assertTenantContext(context: AuthContext, requestedTenantId?: string): void {
	if (requestedTenantId && requestedTenantId !== context.tenantId)
		throw new Error("Forbidden: tenant_id is controlled by AuthContext");
}

export function canWrite(context: AuthContext): boolean {
	return (
		(context.role === "owner" || context.role === "member") &&
		(context.authType === "session" || context.permissions.includes("client:write"))
	);
}
