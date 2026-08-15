import { type AuthContext, resolveApiKeyAuthContext } from "./selena-auth-context";

export type SelenaApiContext = { request: Request; auth: AuthContext };

export function createSelenaApiHandler(handler: (context: SelenaApiContext) => Promise<Response | object>) {
	return async ({ request }: { request: Request }): Promise<Response> => {
		try {
			const auth = await resolveApiKeyAuthContext(request);
			const result = await handler({ request, auth });
			return result instanceof Response ? result : Response.json(result);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unexpected error";
			const status = message.startsWith("Unauthorized") ? 401 : message.startsWith("Forbidden") ? 403 : 500;
			return Response.json(
				{
					error: status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : "Internal Server Error",
					message: status === 500 ? "An unexpected error occurred" : message,
				},
				{ status },
			);
		}
	};
}
