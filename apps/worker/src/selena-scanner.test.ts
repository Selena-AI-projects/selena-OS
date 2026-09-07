import type { IncomingMessage } from "node:http";
import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { parseAssetScope, scanRetrySeconds, scanWithClamAv } from "./selena-scanner";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
	await Promise.all(
		servers
			.splice(0)
			.map(
				(server) =>
					new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
			),
	);
});

async function mockClamAv(reply: string): Promise<{ host: string; port: number }> {
	const server = createServer((socket) => {
		const chunks: Buffer[] = [];
		socket.on("data", (chunk: Buffer) => {
			chunks.push(chunk);
			if (Buffer.concat(chunks).includes(Buffer.from("zINSTREAM\0"))) socket.end(reply);
		});
	});
	servers.push(server);
	await new Promise<void>((resolve, reject) =>
		server.listen(0, "127.0.0.1", (error) => (error ? reject(error) : resolve())),
	);
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Mock ClamAV address unavailable");
	return { host: "127.0.0.1", port: address.port };
}

describe("Selena scanner runtime", () => {
	it("uses ClamAV INSTREAM and accepts an explicit clean result", async () => {
		const clamav = await mockClamAv("stream: OK\n");
		await expect(scanWithClamAv(new Uint8Array([1, 2, 3]), clamav.host, clamav.port)).resolves.toEqual({ clean: true });
	});

	it("treats a malware result as rejected", async () => {
		const clamav = await mockClamAv("stream: Eicar-Test-Signature FOUND\n");
		await expect(scanWithClamAv(new Uint8Array([1, 2, 3]), clamav.host, clamav.port)).resolves.toEqual({
			clean: false,
			reason: "MALWARE_DETECTED",
		});
	});

	it("backs off failed scans without unbounded delays", () => {
		expect(scanRetrySeconds(1)).toBe(30);
		expect(scanRetrySeconds(2)).toBe(60);
		expect(scanRetrySeconds(99)).toBe(900);
	});
});

function requestWith(headers: Record<string, string>): IncomingMessage {
	return { headers } as unknown as IncomingMessage;
}

function assetHeaders(extra: Record<string, string> = {}): Record<string, string> {
	const future = new Date(Date.now() + 86_400_000).toISOString();
	return {
		"x-selena-actor-id": "actor",
		"x-selena-brand-id": "brand",
		"x-selena-content-version-id": "11111111-1111-4111-8111-111111111111",
		"x-selena-consent-expires-at": future,
		"x-selena-filename": "thumb.png",
		"x-selena-organization-id": "org",
		"x-selena-rights-expires-at": future,
		...extra,
	};
}

describe("asset origin", () => {
	it("records imagery a generator produced separately from imagery a person supplied", () => {
		expect(parseAssetScope(requestWith(assetHeaders({ "x-selena-origin": "GENERATED" }))).origin).toBe("GENERATED");
		expect(parseAssetScope(requestWith(assetHeaders({ "x-selena-origin": "UPLOADED" }))).origin).toBe("UPLOADED");
	});

	it("reads a caller that states no origin as an upload rather than relabelling its history", () => {
		expect(parseAssetScope(requestWith(assetHeaders())).origin).toBe("UPLOADED");
	});

	it("refuses an origin outside the two the column admits", () => {
		expect(() => parseAssetScope(requestWith(assetHeaders({ "x-selena-origin": "SCRAPED" })))).toThrow(
			"Asset origin is invalid",
		);
	});
});
