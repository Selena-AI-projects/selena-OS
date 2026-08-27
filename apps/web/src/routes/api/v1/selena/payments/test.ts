import { createFileRoute } from "@tanstack/react-router";
import { db } from "@workspace/lib/db/db";
import { svOrders, svPayments } from "@workspace/lib/db/schema";
import { SELENA_CHECKOUT_METADATA } from "@workspace/selena-visibility-contracts";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { resolveApiKeyAuthContext } from "../../../../../lib/selena-auth-context.server";

const bodySchema = z.object({
	orderId: z.string().uuid(),
	amount: z.number().nonnegative(),
	currency: z.string().length(3),
	providerEventId: z.string().min(1).max(200),
});

export const Route = createFileRoute("/api/v1/selena/payments/test")({
	server: {
		handlers: {
			POST: async ({ request }) => {
				try {
					const auth = await resolveApiKeyAuthContext(request);
					if (!auth.permissions.includes("client:write"))
						return Response.json(
							{ error: "Forbidden", message: "API key lacks client:write permission" },
							{ status: 403 },
						);
					const parsed = bodySchema.safeParse(await request.json());
					if (!parsed.success)
						return Response.json({ error: "Validation Error", message: parsed.error.message }, { status: 400 });
					const [order] = await db
						.select({ id: svOrders.id, orderCap: svOrders.orderCap })
						.from(svOrders)
						.where(and(eq(svOrders.id, parsed.data.orderId), eq(svOrders.organizationId, auth.tenantId)))
						.limit(1);
					if (!order)
						return Response.json(
							{ error: "Not Found", message: "Order is outside AuthContext tenant" },
							{ status: 404 },
						);
					if (parsed.data.amount > Number(order.orderCap))
						return Response.json(
							{ error: "Validation Error", message: "Payment amount exceeds the order cap" },
							{ status: 400 },
						);
					const [payment] = await db
						.insert(svPayments)
						.values({
							organizationId: auth.tenantId,
							orderId: order.id,
							provider: "test",
							providerEventId: parsed.data.providerEventId,
							status: "SUCCEEDED",
							amount: String(parsed.data.amount),
							currency: parsed.data.currency,
						})
						.onConflictDoNothing({ target: [svPayments.provider, svPayments.providerEventId] })
						.returning({
							id: svPayments.id,
							status: svPayments.status,
							provider: svPayments.provider,
							providerEventId: svPayments.providerEventId,
						});
					if (payment)
						await db
							.update(svOrders)
							.set({ status: "APPROVED", paidAt: new Date(), updatedAt: new Date() })
							.where(and(eq(svOrders.id, order.id), eq(svOrders.organizationId, auth.tenantId)));
					return Response.json(
						payment ?? {
							status: "SUCCEEDED",
							provider: "test",
							providerEventId: parsed.data.providerEventId,
							duplicate: true,
							checkoutMetadata: SELENA_CHECKOUT_METADATA,
						},
					);
				} catch (error) {
					return Response.json(
						{ error: "Request Failed", message: error instanceof Error ? error.message : "Test payment failed" },
						{ status: 400 },
					);
				}
			},
		},
	},
});
