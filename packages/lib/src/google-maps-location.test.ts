import { describe, expect, it } from "vitest";
import { isGoogleMapsLink, parseGoogleMapsLocation } from "./google-maps-location";

describe("parseGoogleMapsLocation", () => {
	it("reads name, pin coordinates and CID from a full place link", () => {
		const result = parseGoogleMapsLocation(
			"https://www.google.com/maps/place/Kora+Food+Hall/@-8.6478,115.1385,17z/data=!3m1!4b1!4m6!3m5!1s0x2dd23c0000000001:0x1f4a9c3b2d5e6f7a!8m2!3d-8.6481234!4d115.1392345!16s%2Fg%2F11abc",
		);
		expect(result).toMatchObject({
			isValid: true,
			location: {
				placeName: "Kora Food Hall",
				latitude: -8.6481234,
				longitude: 115.1392345,
				cid: BigInt("0x1f4a9c3b2d5e6f7a").toString(),
			},
		});
	});

	it("decodes escaped characters and keeps real plus signs in the place name", () => {
		const result = parseGoogleMapsLocation("https://www.google.com/maps/place/Caf%C3%A9+B%2BB/@-8.65,115.13,17z");
		expect(result.isValid && result.location.placeName).toBe("Café B+B");
	});

	it("falls back to the viewport center when the link has no pin", () => {
		const result = parseGoogleMapsLocation("https://www.google.com/maps/place/Somewhere/@-8.65,115.13,17z");
		expect(result.isValid && result.location.latitude).toBe(-8.65);
		expect(result.isValid && result.location.longitude).toBe(115.13);
	});

	it("accepts a maps.google.com link with a decimal cid", () => {
		const result = parseGoogleMapsLocation("https://maps.google.com/?cid=12345678901234567890");
		expect(result.isValid && result.location.cid).toBe("12345678901234567890");
	});

	it("accepts a share link but stores only the URL", () => {
		const result = parseGoogleMapsLocation("https://maps.app.goo.gl/AbCdEf123");
		expect(result).toMatchObject({
			isValid: true,
			location: { url: "https://maps.app.goo.gl/AbCdEf123", placeName: null, latitude: null, longitude: null },
		});
	});

	it("completes a missing scheme", () => {
		const result = parseGoogleMapsLocation("maps.app.goo.gl/AbCdEf123");
		expect(result.isValid && result.location.url).toBe("https://maps.app.goo.gl/AbCdEf123");
	});

	it("accepts a country-domain maps link", () => {
		const result = parseGoogleMapsLocation("https://www.google.co.uk/maps/place/Some+Pub/@51.5,-0.12,17z");
		expect(result.isValid && result.location.placeName).toBe("Some Pub");
	});

	it("drops credentials from the stored URL", () => {
		const result = parseGoogleMapsLocation("https://user:secret@www.google.com/maps/place/Spot/@1,2,17z");
		expect(result.isValid && result.location.url).not.toContain("secret");
	});

	it("rejects a link that is not Google Maps", () => {
		expect(parseGoogleMapsLocation("https://instagram.com/somebrand").isValid).toBe(false);
		expect(parseGoogleMapsLocation("https://google.com/search?q=cafe").isValid).toBe(false);
		expect(parseGoogleMapsLocation("https://evil.com/maps/place/Fake").isValid).toBe(false);
	});

	it("rejects an empty share link and empty input", () => {
		expect(parseGoogleMapsLocation("https://maps.app.goo.gl/").isValid).toBe(false);
		expect(parseGoogleMapsLocation("   ").isValid).toBe(false);
	});

	it("discards out-of-range coordinates instead of storing garbage", () => {
		const result = parseGoogleMapsLocation("https://www.google.com/maps/place/Spot/data=!3d123.0!4d456.0");
		expect(result.isValid && result.location.latitude).toBe(null);
		expect(result.isValid && result.location.longitude).toBe(null);
	});
});

describe("isGoogleMapsLink", () => {
	it("recognizes listing and share links", () => {
		expect(isGoogleMapsLink("https://www.google.com/maps/place/Kora+Food+Hall/@-8.64,115.13,17z")).toBe(true);
		expect(isGoogleMapsLink("https://maps.google.com/?cid=123")).toBe(true);
		expect(isGoogleMapsLink("https://maps.app.goo.gl/AbCdEf123")).toBe(true);
		expect(isGoogleMapsLink("https://goo.gl/maps/AbCdEf123")).toBe(true);
	});

	it("rejects other links, relative paths and non-http schemes", () => {
		expect(isGoogleMapsLink("https://www.google.com/search?q=maps")).toBe(false);
		expect(isGoogleMapsLink("https://instagram.com/somebrand")).toBe(false);
		expect(isGoogleMapsLink("/maps/place/Local")).toBe(false);
		expect(isGoogleMapsLink("javascript:alert(1)")).toBe(false);
	});
});
