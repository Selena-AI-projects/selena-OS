import { z } from "zod";

export const localCustomerLocationSchema = z.strictObject({
	name: z.string().trim().min(1).max(160),
	countryCode: z.string().regex(/^[A-Z]{2}$/),
	mapsUrl: z.string().url().max(3000),
	latitude: z
		.number()
		.finite()
		.min(-85)
		.max(85)
		.transform((v) => Math.round(v * 1_000_000) / 1_000_000),
	longitude: z
		.number()
		.finite()
		.min(-180)
		.max(180)
		.transform((v) => Math.round(v * 1_000_000) / 1_000_000),
	confirmed: z.literal(true),
});
export type LocalCustomerLocationInput = z.infer<typeof localCustomerLocationSchema>;

/** Parse only an explicit stable reference; no redirect, search or provider lookup. */
export function localIdentityFromMapsUrl(value: string): { cid?: string; placeId?: string } {
	const url = new URL(value);
	if (
		url.protocol !== "https:" ||
		!["google.com", "www.google.com", "maps.google.com"].includes(url.hostname) ||
		url.username ||
		url.password
	)
		throw new Error("LOCAL_MAPS_LINK_UNSUPPORTED");
	if (url.hostname !== "maps.google.com" && url.pathname !== "/maps" && !url.pathname.startsWith("/maps/"))
		throw new Error("LOCAL_MAPS_LINK_UNSUPPORTED");
	for (const key of ["cid", "query_place_id", "place_id"])
		if (url.searchParams.getAll(key).length > 1) throw new Error("LOCAL_MAPS_LINK_CONFLICT");
	const cid = url.searchParams.get("cid");
	const queryPlaceId = url.searchParams.get("query_place_id"),
		directPlaceId = url.searchParams.get("place_id");
	if (queryPlaceId && directPlaceId && queryPlaceId !== directPlaceId) throw new Error("LOCAL_MAPS_LINK_CONFLICT");
	const placeId = queryPlaceId ?? directPlaceId;
	if (cid && (!/^[1-9]\d{0,19}$/.test(cid) || BigInt(cid) > BigInt("18446744073709551615")))
		throw new Error("LOCAL_MAPS_LINK_UNSUPPORTED");
	if (placeId && !/^ChI[A-Za-z0-9_-]{10,250}$/.test(placeId)) throw new Error("LOCAL_MAPS_LINK_UNSUPPORTED");
	let path: string;
	try {
		path = decodeURIComponent(url.pathname + url.search);
	} catch {
		throw new Error("LOCAL_MAPS_LINK_UNSUPPORTED");
	}
	const cids = new Set(cid ? [cid] : []),
		places = new Set(placeId ? [placeId] : []);
	for (const feature of path.matchAll(/!1s0x[a-f0-9]+:0x([a-f0-9]{1,16})(?=!|\?|&|$)/gi)) {
		const value = BigInt(`0x${feature[1]}`);
		if (value <= BigInt(0)) throw new Error("LOCAL_MAPS_LINK_UNSUPPORTED");
		cids.add(value.toString());
	}
	for (const place of path.matchAll(/!1s(ChI[A-Za-z0-9_-]{10,250})(?=!|\?|&|$)/g)) places.add(place[1]);
	if (cids.size > 1 || places.size > 1) throw new Error("LOCAL_MAPS_LINK_CONFLICT");
	const resolvedCid = [...cids][0],
		resolvedPlaceId = [...places][0];
	if (resolvedCid || resolvedPlaceId)
		return { ...(resolvedCid ? { cid: resolvedCid } : {}), ...(resolvedPlaceId ? { placeId: resolvedPlaceId } : {}) };
	throw new Error("LOCAL_MAPS_FULL_PLACE_LINK_REQUIRED");
}
