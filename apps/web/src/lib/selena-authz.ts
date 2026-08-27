export type SelenaRole = "owner" | "member" | "viewer";

export type AuthContext = {
	actorId: string;
	tenantId: string;
	role: SelenaRole;
	authType: "session" | "api_key";
	permissions: string[];
};

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
