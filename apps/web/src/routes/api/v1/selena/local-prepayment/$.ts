import { createFileRoute } from "@tanstack/react-router";
import { localPrepaymentEnabled } from "@/lib/selena-local-prepayment";
import { createLocalPrepaymentApi, type LocalOperation } from "@/server/selena-local-prepayment-api";

async function handle({ request }: { request: Request }) {
	const path = new URL(request.url).pathname.split("/local-prepayment/")[1]?.split("/").filter(Boolean) ?? [];
	let operation: LocalOperation;
	if (["pay", "payment", "test-payment", "start", "retry", "execute"].some((part) => path.includes(part)))
		operation = "blocked";
	else if (path.length === 1 && ["restaurants", "orders", "reports"].includes(path[0]))
		operation = path[0] as "restaurants" | "orders" | "reports";
	else if (path.length === 2 && path[0] === "orders") operation = "order";
	else if (path.length === 2 && path[0] === "reports") operation = "report";
	else return new Response("Not found", { status: 404 });
	// Load database adapters only when this independently gated module is enabled.
	if (!localPrepaymentEnabled(process.env)) return new Response("Local Visibility is unavailable", { status: 503 });
	const { selenaWebDb } = await import("@workspace/lib/db/db");
	const { resolveSessionAuthContext } = await import("@/lib/selena-auth-context.server");
	const { createLocalPrepaymentStore } = await import("@/server/selena-local-prepayment-store");
	return createLocalPrepaymentApi({
		enabled: () => localPrepaymentEnabled(process.env),
		authenticate: resolveSessionAuthContext,
		store: createLocalPrepaymentStore(selenaWebDb),
	})(request, operation, path[1]);
}
export const Route = createFileRoute("/api/v1/selena/local-prepayment/$")({
	server: { handlers: { GET: handle, POST: handle } },
});
