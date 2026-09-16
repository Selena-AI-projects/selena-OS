import { z } from "zod";
import { localCustomerLocationSchema, localIdentityFromMapsUrl } from "./selena-local-customer-location";
import { sphericalGridPointsV1 } from "./selena-local-grid";

export const localRestaurantInput = localCustomerLocationSchema.transform((input) => ({
	...input,
	identity: localIdentityFromMapsUrl(input.mapsUrl),
}));
export const localDraftInput = z
	.strictObject({
		restaurantId: z
			.string()
			.uuid()
			.transform((id) => id.toLowerCase()),
		queries: z.array(z.string().trim().min(1).max(300)).min(1).max(15),
		language: z.string().regex(/^[a-z]{2}(?:-[A-Z]{2})?$/),
		gridSize: z.union([z.literal(3), z.literal(5)]),
	})
	.refine(
		(input) => new Set(input.queries.map((q) => q.normalize("NFKC").toLowerCase())).size === input.queries.length,
		"Duplicate queries are not allowed",
	);

export function localPrepaymentEnabled(env: Record<string, string | undefined>) {
	return env.SELENA_LOCAL_PREPAYMENT_ENABLED === "true";
}

export function prepareLocalOrder(
	input: z.infer<typeof localDraftInput>,
	restaurant: z.infer<typeof localRestaurantInput>,
) {
	const spec = localDraftInput.parse(input);
	const grid = sphericalGridPointsV1({
		formulaVersion: "sv-grid-sphere-v1",
		locationId: spec.restaurantId,
		centerLatitude: restaurant.latitude,
		centerLongitude: restaurant.longitude,
		radiusMeters: 3000,
		size: spec.gridSize,
	});
	return {
		version: 1 as const,
		product: "LOCAL_MAPS_ONE_OFF" as const,
		status: "PREPARED" as const,
		paymentMode: "DISABLED" as const,
		executionMode: "DISABLED" as const,
		priceAmount: "49.00" as const,
		currency: "USD" as const,
		...spec,
		restaurant,
		grid,
		expectedObservations: spec.queries.length * grid.points.length,
	};
}
export type LocalPreparedOrder = ReturnType<typeof prepareLocalOrder>;
export type LocalRestaurant = { id: string; details: z.infer<typeof localRestaurantInput> };
export type LocalSavedOrder = { id: string; createdAt: string; snapshot: LocalPreparedOrder };
