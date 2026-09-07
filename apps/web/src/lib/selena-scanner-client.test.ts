import { createServer } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { uploadSelenaPrivateAsset } from "./selena-scanner-client";

/** A port that was listening a moment ago and is closed now: the shape of an outage. */
async function closedPort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("no port");
	await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	return address.port;
}

afterEach(() => vi.unstubAllEnvs());

describe("reaching the private asset scanner", () => {
	it("names the scanner when the connection is refused, so nothing is mistaken for saved", async () => {
		const port = await closedPort();
		vi.stubEnv("SELENA_SCANNER_URL", `http://127.0.0.1:${port}`);
		vi.stubEnv("SELENA_SCANNER_INTERNAL_TOKEN", "test-token");
		await expect(
			uploadSelenaPrivateAsset({
				actorId: "actor",
				brandId: "brand",
				bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
				consentExpiresAt: "2030-01-01T00:00:00.000Z",
				contentVersionId: "11111111-1111-4111-8111-111111111111",
				filename: "thumb.png",
				mimeType: "image/png",
				organizationId: "org",
				origin: "UPLOADED",
				rightsExpiresAt: "2030-01-01T00:00:00.000Z",
			}),
		).rejects.toThrow(/^Private asset scanner upload is unreachable/);
	});
});
