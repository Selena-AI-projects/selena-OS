import { describe, it, expect } from "vitest";
import { offsetMinutesAt, usesWholeHourOffsets } from "@/lib/timezone-offsets";

describe("offsetMinutesAt", () => {
	it("reads a fixed whole-hour offset", () => {
		expect(offsetMinutesAt("UTC", new Date("2026-06-01T12:00:00Z"))).toBe(0);
		expect(offsetMinutesAt("Asia/Makassar", new Date("2026-06-01T12:00:00Z"))).toBe(8 * 60);
	});

	it("reads a fractional offset", () => {
		expect(offsetMinutesAt("Asia/Kolkata", new Date("2026-06-01T12:00:00Z"))).toBe(5 * 60 + 30);
		expect(offsetMinutesAt("Asia/Kathmandu", new Date("2026-06-01T12:00:00Z"))).toBe(5 * 60 + 45);
	});

	it("follows DST", () => {
		expect(offsetMinutesAt("Europe/Berlin", new Date("2026-01-15T12:00:00Z"))).toBe(60);
		expect(offsetMinutesAt("Europe/Berlin", new Date("2026-07-15T12:00:00Z"))).toBe(120);
	});
});

describe("usesWholeHourOffsets", () => {
	it("accepts whole-hour zones, including across a DST change", () => {
		expect(usesWholeHourOffsets("UTC", "2026-01-01", "2026-12-31")).toBe(true);
		expect(usesWholeHourOffsets("Europe/Berlin", "2026-03-01", "2026-04-30")).toBe(true);
		expect(usesWholeHourOffsets("America/New_York", null, null)).toBe(true);
	});

	it("rejects fractional-offset zones", () => {
		expect(usesWholeHourOffsets("Asia/Kolkata", "2026-01-01", "2026-01-31")).toBe(false);
		expect(usesWholeHourOffsets("Australia/Lord_Howe", "2026-01-01", "2026-12-31")).toBe(false);
	});

	it("rejects unknown zone names instead of throwing", () => {
		expect(usesWholeHourOffsets("Not/A_Zone", "2026-01-01", "2026-01-31")).toBe(false);
	});
});
