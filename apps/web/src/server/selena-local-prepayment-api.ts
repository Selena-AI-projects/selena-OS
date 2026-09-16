import { z } from "zod";
import type { AuthContext } from "../lib/selena-authz";
import { localDraftInput, localRestaurantInput } from "../lib/selena-local-prepayment";

export type LocalOperation = "restaurants" | "orders" | "order" | "reports" | "report" | "blocked";
export type LocalPrepaymentStore = {
	list: (auth: AuthContext, kind: "restaurants" | "orders" | "reports") => Promise<unknown>;
	createRestaurant: (auth: AuthContext, input: z.infer<typeof localRestaurantInput>, key: string) => Promise<unknown>;
	createOrder: (auth: AuthContext, input: z.infer<typeof localDraftInput>, key: string) => Promise<unknown>;
	readOrder: (auth: AuthContext, id: string) => Promise<unknown | null>;
	readReport: (auth: AuthContext, id: string, request: Request) => Promise<Response>;
};
async function body(request: Request) {
	const reader = request.body?.getReader();
	if (!reader) throw new SyntaxError("Missing body");
	const decoder = new TextDecoder();
	let size = 0,
		value = "";
	while (true) {
		const chunk = await reader.read();
		if (chunk.done) break;
		size += chunk.value.byteLength;
		if (size > 32768) {
			await reader.cancel();
			throw new Error("BODY_TOO_LARGE");
		}
		value += decoder.decode(chunk.value, { stream: true });
	}
	return JSON.parse(value + decoder.decode());
}
export function createLocalPrepaymentApi(deps: {
	enabled: () => boolean;
	authenticate: () => Promise<AuthContext>;
	store: LocalPrepaymentStore;
}) {
	return async (request: Request, operation: LocalOperation, id?: string) => {
		const reply = (value: unknown, status = 200) =>
			Response.json(value, {
				status,
				headers: { "Cache-Control": "private, no-store", Vary: "Cookie", "X-Content-Type-Options": "nosniff" },
			});
		try {
			if (!deps.enabled()) return reply({ error: "LOCAL_PREPAYMENT_DISABLED" }, 503);
			if (!["GET", "POST"].includes(request.method)) return reply({ error: "METHOD_NOT_ALLOWED" }, 405);
			const auth = await deps.authenticate();
			if (auth.authType !== "session") return reply({ error: "SESSION_REQUIRED" }, 403);
			// No flag combination can enable a charge, fixture, or provider through this adapter.
			if (operation === "blocked") return reply({ error: "PAYMENT_AND_EXECUTION_DISABLED" }, 403);
			if (request.method === "POST") {
				if (request.headers.get("origin") !== new URL(request.url).origin)
					return reply({ error: "ORIGIN_FORBIDDEN" }, 403);
				if (auth.role !== "owner") return reply({ error: "OWNER_REQUIRED" }, 403);
				if (operation !== "orders" && operation !== "restaurants") return reply({ error: "METHOD_NOT_ALLOWED" }, 405);
				const key = z.string().uuid().parse(request.headers.get("idempotency-key")).toLowerCase();
				const input = await body(request);
				return reply(
					operation === "orders"
						? await deps.store.createOrder(auth, localDraftInput.parse(input), key)
						: await deps.store.createRestaurant(auth, localRestaurantInput.parse(input), key),
					201,
				);
			}
			if (operation === "order") {
				const row = await deps.store.readOrder(auth, z.string().uuid().parse(id));
				return row ? reply(row) : reply({ error: "NOT_FOUND" }, 404);
			}
			if (operation === "report") return await deps.store.readReport(auth, z.string().uuid().parse(id), request);
			return reply(await deps.store.list(auth, operation));
		} catch (error) {
			const message = error instanceof Error ? error.message : "";
			const status =
				error instanceof z.ZodError || error instanceof SyntaxError || message.startsWith("LOCAL_MAPS_")
					? 400
					: message.startsWith("Unauthorized")
						? 401
						: message.startsWith("Forbidden")
							? 403
							: message === "NOT_FOUND"
								? 404
								: message === "IDEMPOTENCY_CONFLICT"
									? 409
									: message === "BODY_TOO_LARGE"
										? 413
										: 503;
			return reply(
				{ error: status === 503 ? "LOCAL_UNAVAILABLE" : status === 409 ? message : "REQUEST_REJECTED" },
				status,
			);
		}
	};
}
