import { createServerFn } from "@tanstack/react-start";
import {
	getPublicProviderCredentialStatus,
	type PublicProviderCredentialStatus,
} from "@workspace/lib/public-provider-gates";
import { EncryptionKeyError, getKeyring, refreshCredentialOverlay, storeCredential } from "@workspace/lib/secrets";
import { z } from "zod";
import { isAdmin, requireAuthSession } from "@/lib/auth/helpers";

export const MANAGED_PUBLIC_PROVIDERS = ["BRIGHT_DATA_SERP"] as const;
export type ManagedPublicProvider = (typeof MANAGED_PUBLIC_PROVIDERS)[number];
export type CredentialStorageStatus = "READY" | "MISSING" | "INVALID";

const providerSchema = z.enum(MANAGED_PUBLIC_PROVIDERS);
const credentialByProvider = {
	BRIGHT_DATA_SERP: "BRIGHTDATA_API_TOKEN",
} as const satisfies Record<ManagedPublicProvider, "BRIGHTDATA_API_TOKEN">;

async function requireAdmin(): Promise<void> {
	const session = await requireAuthSession();
	if (!isAdmin(session)) throw new Error("Unauthorized: Admin access required");
}

function getStorageStatus(): CredentialStorageStatus {
	try {
		return getKeyring() ? "READY" : "MISSING";
	} catch (error) {
		if (error instanceof EncryptionKeyError) return "INVALID";
		throw error;
	}
}

export type ProviderCredentialStatusResponse = {
	storage: CredentialStorageStatus;
	providers: Array<{
		provider: ManagedPublicProvider;
		status: PublicProviderCredentialStatus;
	}>;
};

export const getProviderCredentialStatusFn = createServerFn({ method: "GET" }).handler(
	async (): Promise<ProviderCredentialStatusResponse> => {
		await requireAdmin();
		const storage = getStorageStatus();
		if (storage === "READY") {
			try {
				await refreshCredentialOverlay();
			} catch {
				throw new Error("Credential status is temporarily unavailable");
			}
		}

		return {
			storage,
			providers: MANAGED_PUBLIC_PROVIDERS.map((provider) => ({
				provider,
				status: getPublicProviderCredentialStatus(provider),
			})),
		};
	},
);

export const saveProviderCredentialFn = createServerFn({ method: "POST" })
	.validator(
		z.object({
			provider: providerSchema,
			credential: z.string().trim().min(8).max(4096),
		}),
	)
	.handler(
		async ({ data }): Promise<{ provider: ManagedPublicProvider; status: "PRESENT"; runtimeRefreshed: boolean }> => {
			await requireAdmin();
			if (getStorageStatus() !== "READY") {
				throw new Error("Encrypted credential storage is not configured");
			}

			try {
				const { runtimeRefreshed } = await storeCredential(credentialByProvider[data.provider], data.credential);
				return { provider: data.provider, status: "PRESENT", runtimeRefreshed };
			} catch (error) {
				if (error instanceof EncryptionKeyError) {
					throw new Error("Encrypted credential storage is not configured");
				}
				throw new Error("Credential could not be stored");
			}
		},
	);
