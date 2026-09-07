type AssetUpload = {
	actorId: string;
	brandId: string;
	bytes: Uint8Array;
	consentExpiresAt: string;
	contentVersionId: string;
	filename: string;
	mimeType: string;
	organizationId: string;
	origin?: "UPLOADED" | "GENERATED";
	rightsExpiresAt: string;
};

function getScannerConfig(): { token: string; url: string } {
	const url = process.env.SELENA_SCANNER_URL;
	const token = process.env.SELENA_SCANNER_INTERNAL_TOKEN;
	if (!url || !token) throw new Error("Private asset scanning is not configured for this environment");
	return { url: url.replace(/\/$/, ""), token };
}

function scannerHeaders(input: { actorId: string; brandId: string; organizationId: string }): HeadersInit {
	const { token } = getScannerConfig();
	return {
		authorization: `Bearer ${token}`,
		"x-selena-actor-id": input.actorId,
		"x-selena-brand-id": input.brandId,
		"x-selena-organization-id": input.organizationId,
	};
}

function scannerError(action: string, response: Response): Error {
	return new Error(`Private asset scanner ${action} failed with status ${response.status}`);
}

export async function uploadSelenaPrivateAsset(input: AssetUpload): Promise<{ id: string; scanStatus: "QUARANTINED" }> {
	const { url } = getScannerConfig();
	const response = await fetch(`${url}/v1/assets`, {
		method: "POST",
		headers: {
			...scannerHeaders(input),
			"content-type": input.mimeType,
			"x-selena-content-version-id": input.contentVersionId,
			"x-selena-consent-expires-at": input.consentExpiresAt,
			"x-selena-filename": input.filename,
			...(input.origin ? { "x-selena-origin": input.origin } : {}),
			"x-selena-rights-expires-at": input.rightsExpiresAt,
		},
		body: Buffer.from(input.bytes),
	});
	if (!response.ok) throw scannerError("upload", response);
	const body = (await response.json()) as { id?: unknown; scanStatus?: unknown };
	if (typeof body.id !== "string" || body.scanStatus !== "QUARANTINED")
		throw new Error("Private asset scanner returned an invalid upload response");
	return { id: body.id, scanStatus: body.scanStatus };
}

export async function createSelenaPrivateAssetDownloadUrl(input: {
	actorId: string;
	assetId: string;
	brandId: string;
	organizationId: string;
}): Promise<{ expiresInSeconds: number; signedUrl: string }> {
	const { url } = getScannerConfig();
	const response = await fetch(`${url}/v1/assets/${input.assetId}/signed-url`, {
		method: "POST",
		headers: scannerHeaders(input),
	});
	if (!response.ok) throw scannerError("signed download", response);
	const body = (await response.json()) as { expiresInSeconds?: unknown; signedUrl?: unknown };
	if (typeof body.signedUrl !== "string" || body.expiresInSeconds !== 300) {
		throw new Error("Private asset scanner returned an invalid signed download response");
	}
	return { signedUrl: body.signedUrl, expiresInSeconds: body.expiresInSeconds };
}
