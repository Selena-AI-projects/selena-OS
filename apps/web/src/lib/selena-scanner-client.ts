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

/**
 * A scanner that cannot be reached is a scanner that did not store anything.
 * `fetch` reports that as a bare TypeError, which says nothing about which
 * boundary failed; naming it here is what lets a caller tell "not saved" apart
 * from "refused".
 */
async function reachScanner(action: string, input: string, init: RequestInit): Promise<Response> {
	try {
		return await fetch(input, init);
	} catch (error) {
		const detail = error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
		throw new Error(`Private asset scanner ${action} is unreachable${detail ? `: ${detail}` : ""}`);
	}
}

export async function uploadSelenaPrivateAsset(input: AssetUpload): Promise<{ id: string; scanStatus: "QUARANTINED" }> {
	const { url } = getScannerConfig();
	const response = await reachScanner("upload", `${url}/v1/assets`, {
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
	const response = await reachScanner("signed download", `${url}/v1/assets/${input.assetId}/signed-url`, {
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
