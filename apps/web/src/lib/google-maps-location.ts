export type GoogleMapsLocationSnapshot = {
	url: string;
	placeName: string | null;
	latitude: number | null;
	longitude: number | null;
	/** Google's stable listing identifier (CID), decimal string. */
	cid: string | null;
};

export type GoogleMapsLocationResult =
	| { isValid: true; location: GoogleMapsLocationSnapshot }
	| { isValid: false; error: string };

/**
 * Parse an owner-pasted Google Maps link into a stored snapshot without any
 * network call: the catalog lock keeps Google Places out of the MVP, so the
 * link itself is the input and everything we keep must be readable from it.
 * The snapshot pins the exact listing (name, pin coordinates, CID) so mention
 * analysis can tell this business apart from same-named ones and scenario
 * suggestions can be scoped to the real location.
 *
 * Share links (maps.app.goo.gl, goo.gl/maps) are accepted as-is: they cannot
 * be expanded offline, so their snapshot carries only the URL.
 */
export function parseGoogleMapsLocation(input: string): GoogleMapsLocationResult {
	const trimmed = input.trim();
	if (!trimmed) return { isValid: false, error: "Google Maps link is required" };
	const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
	let url: URL;
	try {
		url = new URL(candidate);
	} catch {
		return { isValid: false, error: "Please enter a valid Google Maps link" };
	}
	// The value is stored and later fetched by collectors; never keep credentials.
	url.username = "";
	url.password = "";
	const hostname = url.hostname.toLowerCase();

	if (hostname === "maps.app.goo.gl" || (hostname === "goo.gl" && url.pathname.startsWith("/maps"))) {
		if (url.pathname === "/" || url.pathname === "/maps" || url.pathname === "/maps/")
			return { isValid: false, error: "The share link is missing its place code" };
		return {
			isValid: true,
			location: { url: url.toString(), placeName: null, latitude: null, longitude: null, cid: null },
		};
	}

	const isGoogleHost = /^(?:www\.|maps\.)?google\.[a-z]{2,3}(?:\.[a-z]{2})?$/.test(hostname);
	const isMapsPath = url.pathname === "/maps" || url.pathname.startsWith("/maps/");
	const hasCid = /^\d+$/.test(url.searchParams.get("cid") ?? "");
	if (!isGoogleHost || !(isMapsPath || hostname.startsWith("maps.") || hasCid))
		return { isValid: false, error: "The link does not look like a Google Maps place link" };

	return {
		isValid: true,
		location: {
			url: url.toString(),
			placeName: extractPlaceName(url.pathname),
			...extractCoordinates(url),
			cid: extractCid(url),
		},
	};
}

/** Narrow a stored jsonb value back into the snapshot shape, field by field. */
export function readStoredGoogleMapsLocation(value: unknown): GoogleMapsLocationSnapshot | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const row = value as Record<string, unknown>;
	if (typeof row.url !== "string" || !row.url) return null;
	return {
		url: row.url,
		placeName: typeof row.placeName === "string" ? row.placeName : null,
		latitude: typeof row.latitude === "number" && Number.isFinite(row.latitude) ? row.latitude : null,
		longitude: typeof row.longitude === "number" && Number.isFinite(row.longitude) ? row.longitude : null,
		cid: typeof row.cid === "string" ? row.cid : null,
	};
}

function extractPlaceName(pathname: string): string | null {
	const segment = pathname.match(/\/maps\/place\/([^/]+)/)?.[1];
	if (!segment) return null;
	// Google writes spaces as "+" and real plus signs as %2B, so the order matters.
	const spaced = segment.replace(/\+/g, " ");
	try {
		return decodeURIComponent(spaced) || null;
	} catch {
		return spaced || null;
	}
}

function extractCoordinates(url: URL): { latitude: number | null; longitude: number | null } {
	// The !3d/!4d pair in the data blob is the listing's pin; @lat,lng is only
	// the viewport center, kept as a fallback. With several pins the last pair
	// belongs to the selected place.
	const pins = [...url.href.matchAll(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/g)];
	const pin = pins.at(-1) ?? url.pathname.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
	if (!pin) return { latitude: null, longitude: null };
	const latitude = Number.parseFloat(pin[1] ?? "");
	const longitude = Number.parseFloat(pin[2] ?? "");
	if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180)
		return { latitude: null, longitude: null };
	return { latitude, longitude };
}

function extractCid(url: URL): string | null {
	const direct = url.searchParams.get("cid");
	if (direct && /^\d+$/.test(direct)) return direct;
	// Feature ids appear as 0x<fid>:0x<cid> in the ftid param or the data blob.
	const hex = (url.searchParams.get("ftid") ?? url.href).match(/0x[0-9a-f]+:0x([0-9a-f]+)/i)?.[1];
	if (!hex) return null;
	try {
		const cid = BigInt(`0x${hex}`);
		return cid > 0n ? cid.toString() : null;
	} catch {
		return null;
	}
}
