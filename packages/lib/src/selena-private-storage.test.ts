import { describe, expect, it, vi } from "vitest";
import {
	createSelenaStorageKey,
	detectSelenaAssetMimeType,
	MAX_SELENA_ASSET_BYTES,
	SupabasePrivateStorage,
	validateSelenaAsset,
} from "./selena-private-storage";

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

describe("Selena private asset storage", () => {
	it("accepts only an allowed MIME type with matching magic bytes", () => {
		const asset = validateSelenaAsset({ bytes: png, mimeType: "image/png" });
		expect(asset.detectedMimeType).toBe("image/png");
		expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/);
		expect(detectSelenaAssetMimeType(png)).toBe("image/png");
	});

	it("rejects spoofed types, unsupported bytes, and oversized files", () => {
		expect(() => validateSelenaAsset({ bytes: png, mimeType: "image/jpeg" })).toThrow("does not match");
		expect(() =>
			validateSelenaAsset({ bytes: new Uint8Array([0x3c, 0x73, 0x76, 0x67]), mimeType: "image/png" }),
		).toThrow("not a supported image");
		expect(() =>
			validateSelenaAsset({ bytes: new Uint8Array(MAX_SELENA_ASSET_BYTES + 1), mimeType: "image/png" }),
		).toThrow("10 MiB");
	});

	it("uses opaque tenant-scoped immutable object paths", () => {
		const key = createSelenaStorageKey({
			assetId: "a3d711e7-3c9f-4cb0-a077-fcb97edce6a9",
			brandId: "brand/unsafe",
			contentVersionId: "b3d711e7-3c9f-4cb0-a077-fcb97edce6a9",
			organizationId: "organization/unsafe",
			mimeType: "image/png",
		});
		expect(key).toMatch(
			/^originals\/[a-f0-9]{24}\/b3d711e7-3c9f-4cb0-a077-fcb97edce6a9\/a3d711e7-3c9f-4cb0-a077-fcb97edce6a9\.png$/,
		);
		expect(key).not.toContain("unsafe");
	});

	it("creates a private bucket and never requests an upsert", async () => {
		const fetchFn = vi
			.fn()
			.mockResolvedValueOnce(new Response("{}", { status: 201 }))
			.mockResolvedValueOnce(new Response("{}", { status: 200, headers: { etag: "version-1" } }));
		const storage = new SupabasePrivateStorage(
			{ apiUrl: "https://project.supabase.co", serviceKey: "test-only" },
			fetchFn,
		);
		await storage.ensurePrivateBucket();
		await storage.uploadImmutable({ bytes: png, key: "originals/example.png", mimeType: "image/png" });
		expect(fetchFn.mock.calls[0]?.[1]).toMatchObject({ method: "POST" });
		expect(fetchFn.mock.calls[1]?.[1]).toMatchObject({ headers: expect.objectContaining({ "x-upsert": "false" }) });
	});

	it("limits signed downloads and does not expose provider response text", async () => {
		const storage = new SupabasePrivateStorage(
			{ apiUrl: "https://project.supabase.co", serviceKey: "test-only" },
			vi.fn().mockResolvedValue(new Response("credential details", { status: 500 })),
		);
		await expect(storage.createSignedDownloadUrl("originals/example.png", 0)).rejects.toThrow("between 1 and 3600");
		await expect(storage.createSignedDownloadUrl("originals/example.png", 60)).rejects.toThrow("status 500");
	});

	it("keeps the Storage API prefix when resolving a signed download", async () => {
		const storage = new SupabasePrivateStorage(
			{ apiUrl: "https://project.supabase.co", serviceKey: "test-only" },
			vi
				.fn()
				.mockResolvedValue(
					new Response(JSON.stringify({ signedURL: "/object/sign/selena-quarantine/item?token=x" }), { status: 200 }),
				),
		);
		await expect(storage.createSignedDownloadUrl("originals/example.png", 60)).resolves.toBe(
			"https://project.supabase.co/storage/v1/object/sign/selena-quarantine/item?token=x",
		);
	});
});
