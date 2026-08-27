import { describe, expect, it } from "vitest";
import { parseClamAvScanReply } from "./selena-clamav";

describe("ClamAV result parsing", () => {
	it("recognizes clean results", () => {
		expect(parseClamAvScanReply("stream: OK\n")).toEqual({ clean: true });
	});

	it("recognizes infected results without retaining the signature", () => {
		expect(parseClamAvScanReply("stream: Eicar-Test-Signature FOUND\n")).toEqual({
			clean: false,
			reason: "MALWARE_DETECTED",
		});
	});

	it("rejects malformed scanner responses", () => {
		expect(() => parseClamAvScanReply("scanner unavailable")).toThrow("invalid scan result");
	});
});
