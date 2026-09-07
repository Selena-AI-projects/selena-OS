import { describe, expect, it } from "vitest";
import { describeThumbnailAttachFailure } from "./thumbnail-attach.server";

describe("attaching a thumbnail", () => {
	it("says the image was not saved when private storage or the scanner cannot be reached", () => {
		for (const message of [
			"Private asset scanning is not configured for this environment",
			"Private asset scanner upload failed with status 502",
			// A refused connection: the scanner never answered at all.
			"Private asset scanner upload is unreachable: connect ECONNREFUSED 127.0.0.1:8081",
		]) {
			const failure = describeThumbnailAttachFailure(new Error(message));
			expect(failure.code).toBe("BLOCKED_STORAGE");
			expect(failure.message).toContain("not saved");
		}
	});

	it("does not report a storage outage as a bad request", () => {
		expect(describeThumbnailAttachFailure(new Error("Private asset scanner upload failed with status 500")).status).toBe(
			503,
		);
	});

	it("keeps a cross-brand version out of reach without naming it", () => {
		const failure = describeThumbnailAttachFailure(new Error("Content version is not available for this brand"));
		expect(failure.status).toBe(403);
		expect(failure.code).toBe("NOT_FOUND");
	});

	it("refuses an unauthenticated caller before anything is stored", () => {
		expect(describeThumbnailAttachFailure(new Error("Unauthorized: authenticated session required")).status).toBe(401);
	});

	it("reports a rejected image as a bad request rather than a storage outage", () => {
		const failure = describeThumbnailAttachFailure(new Error("Asset type does not match its file bytes"));
		expect(failure.code).toBe("INVALID_INPUT");
		expect(failure.status).toBe(400);
	});
});
