import { createServerFn } from "@tanstack/react-start";
import { db } from "@workspace/lib/db/db";
import { svOrders, svPayments } from "@workspace/lib/db/schema";
import { createSelenaRepositories } from "@workspace/lib/selena-visibility-repositories";
import {
	assertPaymentAllowed,
	calculateQuote,
	paymentConfigFromEnv,
	quoteCreateSchema,
	quotePricingSchema,
	SELENA_CHECKOUT_METADATA,
} from "@workspace/selena-visibility-contracts";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { resolveSessionAuthContext } from "../lib/selena-auth-context";

const repositories = /* @__PURE__ */ createSelenaRepositories(db);

export const createSelenaQuoteFn = createServerFn({ method: "POST" })
	.validator(
		z.object({
			projectId: z.string().uuid(),
			lockId: z.string().uuid(),
			scenarioIds: z.array(z.string().uuid()).min(1),
			systems: quoteCreateSchema.shape.systems,
			repeats: z.number().int().min(1).max(100),
			pricing: quotePricingSchema,
		}),
	)
	.handler(async ({ data }) => {
		const context = await resolveSessionAuthContext();
		const quote = calculateQuote(data, data.pricing);
		return repositories.quotes.create(context, {
			projectId: data.projectId,
			lockId: data.lockId,
			status: "ISSUED",
			priceAmount: String(quote.amount),
			currency: quote.currency,
			expectedRuns: quote.expectedRuns,
			expiresAt: new Date(Date.now() + 7 * 86400000),
		});
	});

export const createSelenaOrderFn = createServerFn({ method: "POST" })
	.validator(
		z.object({
			projectId: z.string().uuid(),
			quoteId: z.string().uuid(),
			lockId: z.string().uuid(),
			orderCap: z.number().nonnegative(),
		}),
	)
	.handler(async ({ data }) => {
		const context = await resolveSessionAuthContext();
		return repositories.orders.create(context, {
			projectId: data.projectId,
			quoteId: data.quoteId,
			lockId: data.lockId,
			status: "AWAITING_PAYMENT",
			orderCap: String(data.orderCap),
		});
	});

export const createSelenaTestPaymentFn = createServerFn({ method: "POST" })
	.validator(
		z.object({
			orderId: z.string().uuid(),
			amount: z.number().nonnegative(),
			currency: z.string().length(3),
			providerEventId: z.string().min(1),
		}),
	)
	.handler(async ({ data }) => {
		// The owner kill-switch: no payment path may mutate an order while
		// SELENA_PAYMENTS_ENABLED is unset, regardless of provider.
		assertPaymentAllowed(paymentConfigFromEnv(process.env), "test");
		const context = await resolveSessionAuthContext();
		const [order] = await db
			.select({ id: svOrders.id, orderCap: svOrders.orderCap })
			.from(svOrders)
			.where(and(eq(svOrders.id, data.orderId), eq(svOrders.organizationId, context.tenantId)))
			.limit(1);
		if (!order) throw new Error("Not found: order is outside AuthContext tenant");
		if (data.amount > Number(order.orderCap)) throw new Error("Payment amount exceeds the order cap");
		const [payment] = await db
			.insert(svPayments)
			.values({
				organizationId: context.tenantId,
				orderId: data.orderId,
				provider: "test",
				providerEventId: data.providerEventId,
				status: "SUCCEEDED",
				amount: String(data.amount),
				currency: data.currency,
			})
			.onConflictDoNothing({ target: [svPayments.provider, svPayments.providerEventId] })
			.returning();
		if (payment)
			await db
				.update(svOrders)
				.set({ status: "PAID_REVIEW_REQUIRED", paidAt: new Date(), updatedAt: new Date() })
				.where(and(eq(svOrders.id, data.orderId), eq(svOrders.organizationId, context.tenantId)));
		return (
			payment ?? {
				status: "SUCCEEDED",
				duplicate: true,
				providerEventId: data.providerEventId,
				checkoutMetadata: SELENA_CHECKOUT_METADATA,
			}
		);
	});
