import { z } from "zod";

export const LOCAL_GRID_FORMULA_VERSION = "sv-grid-sphere-v1" as const;
export const LOCAL_GRID_EARTH_RADIUS_METERS = 6_371_008.8;
export const LOCAL_GRID_RADIUS_METERS = 3_000 as const;
const UUID_URL_NAMESPACE_HEX = "6ba7b8119dad11d180b400c04fd430c8";

export const sphericalGridSpecV1Schema = z.strictObject({
	formulaVersion: z.literal(LOCAL_GRID_FORMULA_VERSION),
	locationId: z.string().uuid(),
	centerLatitude: z.number().finite().min(-85).max(85),
	centerLongitude: z.number().finite().min(-180).max(180),
	radiusMeters: z.literal(LOCAL_GRID_RADIUS_METERS),
	size: z.union([z.literal(3), z.literal(5)]),
});
export type SphericalGridSpecV1 = z.infer<typeof sphericalGridSpecV1Schema>;

export type SphericalGridPointV1 = {
	id: string;
	pointIndex: number;
	row: number;
	column: number;
	latitude: string;
	longitude: string;
	distanceMeters: number;
	bearingDegrees: number;
	canonical: string;
};

export type SphericalGridV1 = {
	formulaVersion: typeof LOCAL_GRID_FORMULA_VERSION;
	locationId: string;
	centerLatitude: string;
	centerLongitude: string;
	radiusMeters: typeof LOCAL_GRID_RADIUS_METERS;
	size: 3 | 5;
	spacingMeters: number;
	points: SphericalGridPointV1[];
};

export const sphericalGridPointV1Schema = z.strictObject({
	id: z.string().uuid(),
	pointIndex: z.number().int().nonnegative(),
	row: z.number().int().nonnegative(),
	column: z.number().int().nonnegative(),
	latitude: z.string().regex(/^-?\d{1,2}\.\d{6}$/),
	longitude: z.string().regex(/^-?(?:\d{1,2}|1[0-7]\d|180)\.\d{6}$/),
	distanceMeters: z.number().finite().nonnegative(),
	bearingDegrees: z.number().finite().min(-180).lt(180),
	canonical: z.string().min(1),
});

export const sphericalGridV1Schema = z
	.strictObject({
		formulaVersion: z.literal(LOCAL_GRID_FORMULA_VERSION),
		locationId: z.string().uuid(),
		centerLatitude: z.string().regex(/^-?\d{1,2}\.\d{6}$/),
		centerLongitude: z
			.string()
			.regex(/^-?(?:\d{1,2}|1[0-7]\d|180)\.\d{6}$/)
			.refine((value) => Number(value) >= -180 && Number(value) < 180, "GRID_LONGITUDE_NOT_CANONICAL"),
		radiusMeters: z.literal(LOCAL_GRID_RADIUS_METERS),
		size: z.union([z.literal(3), z.literal(5)]),
		spacingMeters: z.number().finite().positive(),
		points: z.array(sphericalGridPointV1Schema),
	})
	.superRefine((grid, issues) => {
		let expected: SphericalGridV1;
		try {
			expected = sphericalGridPointsV1({
				formulaVersion: grid.formulaVersion,
				locationId: grid.locationId,
				centerLatitude: Number(grid.centerLatitude),
				centerLongitude: Number(grid.centerLongitude),
				radiusMeters: grid.radiusMeters,
				size: grid.size,
			});
		} catch {
			issues.addIssue({ code: "custom", message: "GRID_CANONICAL_REGENERATION_FAILED" });
			return;
		}
		if (JSON.stringify(grid) !== JSON.stringify(expected))
			issues.addIssue({ code: "custom", message: "GRID_ORDERED_POINTS_NOT_CANONICAL" });
	});

const degreesToRadians = (value: number): number => (value * Math.PI) / 180;
const radiansToDegrees = (value: number): number => (value * 180) / Math.PI;

function normalizeLongitude(value: number): number {
	const normalized = ((((value + 180) % 360) + 360) % 360) - 180;
	return Object.is(normalized, -0) ? 0 : normalized;
}

// The database contract stores coordinates at numeric(9,6). Convert the
// number's decimal representation to integer micros before rounding so ties
// follow decimal ROUND_HALF_UP rather than the binary-double `toFixed` rules.
function roundHalfUpCoordinate(value: number): string {
	if (!Number.isFinite(value)) throw new Error("GRID_COORDINATE_NOT_FINITE");
	const negative = value < 0;
	const [coefficient, exponentText = "0"] = Math.abs(value).toString().split("e");
	const exponent = Number(exponentText);
	const [integerPart, fractionPart = ""] = coefficient.split(".");
	const digits = `${integerPart}${fractionPart}`;
	const decimalIndex = integerPart.length + exponent;
	const integer =
		decimalIndex <= 0
			? "0"
			: decimalIndex >= digits.length
				? `${digits}${"0".repeat(decimalIndex - digits.length)}`
				: digits.slice(0, decimalIndex);
	const fraction =
		decimalIndex <= 0
			? `${"0".repeat(-decimalIndex)}${digits}`
			: decimalIndex >= digits.length
				? ""
				: digits.slice(decimalIndex);
	const scale = BigInt(1_000_000);
	const micros = BigInt(integer || "0") * scale + BigInt((fraction.slice(0, 6) || "").padEnd(6, "0") || "0");
	const roundedMicros = (fraction[6] ?? "0") >= "5" ? micros + BigInt(1) : micros;
	const whole = roundedMicros / scale;
	const remainder = (roundedMicros % scale).toString().padStart(6, "0");
	const magnitude = `${whole.toString()}.${remainder}`;
	return negative && magnitude !== "0.000000" ? `-${magnitude}` : magnitude;
}

function canonicalLongitude(value: number): string {
	const rounded = roundHalfUpCoordinate(normalizeLongitude(value));
	return rounded === "180.000000" ? "-180.000000" : rounded;
}

const rotateLeft = (value: number, bits: number): number => ((value << bits) | (value >>> (32 - bits))) >>> 0;

// UUIDv5 uses SHA-1 by definition. Keeping this small digest implementation in
// the shared contract avoids importing node:crypto into browser bundles.
function sha1Bytes(input: Uint8Array): Uint8Array {
	const bitLength = input.length * 8;
	const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
	const padded = new Uint8Array(paddedLength);
	padded.set(input);
	padded[input.length] = 0x80;
	const view = new DataView(padded.buffer);
	view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000), false);
	view.setUint32(paddedLength - 4, bitLength >>> 0, false);

	let h0 = 0x67452301;
	let h1 = 0xefcdab89;
	let h2 = 0x98badcfe;
	let h3 = 0x10325476;
	let h4 = 0xc3d2e1f0;
	const words = new Uint32Array(80);

	for (let offset = 0; offset < paddedLength; offset += 64) {
		for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4, false);
		for (let index = 16; index < 80; index += 1) {
			words[index] = rotateLeft(words[index - 3] ^ words[index - 8] ^ words[index - 14] ^ words[index - 16], 1);
		}

		let a = h0;
		let b = h1;
		let c = h2;
		let d = h3;
		let e = h4;
		for (let index = 0; index < 80; index += 1) {
			let f: number;
			let k: number;
			if (index < 20) {
				f = (b & c) | (~b & d);
				k = 0x5a827999;
			} else if (index < 40) {
				f = b ^ c ^ d;
				k = 0x6ed9eba1;
			} else if (index < 60) {
				f = (b & c) | (b & d) | (c & d);
				k = 0x8f1bbcdc;
			} else {
				f = b ^ c ^ d;
				k = 0xca62c1d6;
			}
			const next = (rotateLeft(a, 5) + f + e + k + words[index]) >>> 0;
			e = d;
			d = c;
			c = rotateLeft(b, 30);
			b = a;
			a = next;
		}
		h0 = (h0 + a) >>> 0;
		h1 = (h1 + b) >>> 0;
		h2 = (h2 + c) >>> 0;
		h3 = (h3 + d) >>> 0;
		h4 = (h4 + e) >>> 0;
	}

	const digest = new Uint8Array(20);
	const digestView = new DataView(digest.buffer);
	for (const [index, value] of [h0, h1, h2, h3, h4].entries()) digestView.setUint32(index * 4, value, false);
	return digest;
}

function uuidV5Url(canonical: string): string {
	const namespaceBytes = UUID_URL_NAMESPACE_HEX.match(/../g);
	if (namespaceBytes === null) throw new Error("LOCAL_GRID_UUID_NAMESPACE_INVALID");
	const nameBytes = new TextEncoder().encode(canonical);
	const input = new Uint8Array(16 + nameBytes.length);
	input.set(namespaceBytes.map((value) => Number.parseInt(value, 16)));
	input.set(nameBytes, 16);
	const bytes = Array.from(sha1Bytes(input).slice(0, 16));
	bytes[6] = (bytes[6] & 0x0f) | 0x50;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = bytes.map((value) => value.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function sphericalGridPointsV1(input: SphericalGridSpecV1): SphericalGridV1 {
	if (Number.isFinite(input.centerLatitude) && Math.abs(input.centerLatitude) > 85)
		throw new Error("GRID_POLAR_REGION_UNSUPPORTED");
	const spec = sphericalGridSpecV1Schema.parse(input);
	const locationId = spec.locationId.toLowerCase();
	const centerLatitude = roundHalfUpCoordinate(spec.centerLatitude);
	const normalizedCenterLongitude = normalizeLongitude(spec.centerLongitude);
	const centerLongitude = canonicalLongitude(normalizedCenterLongitude);
	const half = (spec.size - 1) / 2;
	const spacingMeters = spec.radiusMeters / (Math.SQRT2 * half);
	// Geodesy consumes the same six-decimal canonical center that participates
	// in point identity; equivalent inputs therefore cannot diverge in IDs.
	const latitude1 = degreesToRadians(Number(centerLatitude));
	const longitude1 = degreesToRadians(Number(centerLongitude));
	const points: SphericalGridPointV1[] = [];
	const coordinateKeys = new Set<string>();

	for (let row = 0; row < spec.size; row += 1) {
		for (let column = 0; column < spec.size; column += 1) {
			const north = (half - row) * spacingMeters;
			const east = (column - half) * spacingMeters;
			const distanceMeters = Math.hypot(north, east);
			const bearingRadians = Math.atan2(east, north);
			const angularDistance = distanceMeters / LOCAL_GRID_EARTH_RADIUS_METERS;
			const latitude2 = Math.asin(
				Math.sin(latitude1) * Math.cos(angularDistance) +
					Math.cos(latitude1) * Math.sin(angularDistance) * Math.cos(bearingRadians),
			);
			const longitude2 =
				longitude1 +
				Math.atan2(
					Math.sin(bearingRadians) * Math.sin(angularDistance) * Math.cos(latitude1),
					Math.cos(angularDistance) - Math.sin(latitude1) * Math.sin(latitude2),
				);
			const latitudeDegrees = radiansToDegrees(latitude2);
			if (Math.abs(latitudeDegrees) > 85) throw new Error("GRID_POLAR_REGION_UNSUPPORTED");
			const latitude = roundHalfUpCoordinate(latitudeDegrees);
			const longitude = canonicalLongitude(radiansToDegrees(longitude2));
			const coordinateKey = `${latitude}|${longitude}`;
			if (coordinateKeys.has(coordinateKey)) throw new Error("LOCAL_GRID_DUPLICATE_ROUNDED_COORDINATE");
			coordinateKeys.add(coordinateKey);
			const canonical = [
				spec.formulaVersion,
				locationId,
				centerLatitude,
				centerLongitude,
				String(spec.radiusMeters),
				String(spec.size),
				String(row),
				String(column),
				latitude,
				longitude,
			].join("|");
			points.push({
				id: uuidV5Url(canonical),
				pointIndex: row * spec.size + column,
				row,
				column,
				latitude,
				longitude,
				distanceMeters,
				bearingDegrees: normalizeLongitude(radiansToDegrees(bearingRadians)),
				canonical,
			});
		}
	}

	return {
		formulaVersion: spec.formulaVersion,
		locationId,
		centerLatitude,
		centerLongitude,
		radiusMeters: spec.radiusMeters,
		size: spec.size,
		spacingMeters,
		points,
	};
}
