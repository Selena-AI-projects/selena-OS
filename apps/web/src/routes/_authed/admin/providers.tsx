import { createFileRoute } from "@tanstack/react-router";
import { Alert, AlertDescription, AlertTitle } from "@workspace/ui/components/alert";
import { Badge } from "@workspace/ui/components/badge";
import { Button } from "@workspace/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@workspace/ui/components/card";
import { Input } from "@workspace/ui/components/input";
import { Label } from "@workspace/ui/components/label";
import { CheckCircle2, KeyRound, Loader2, ShieldCheck, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { getAppName } from "@/lib/route-head";
import {
	getProviderCredentialStatusFn,
	type ManagedPublicProvider,
	saveProviderCredentialFn,
} from "@/server/provider-credentials";

const providerCopy: Record<ManagedPublicProvider, { title: string; description: string; placeholder: string }> = {
	BRIGHT_DATA_SERP: {
		title: "Bright Data SERP",
		description: "Public search evidence used by the recommendation engine.",
		placeholder: "Paste the Bright Data API token",
	},
};

export const Route = createFileRoute("/_authed/admin/providers")({
	head: ({ match }) => {
		const appName = getAppName(match);
		return {
			meta: [
				{ title: `Provider credentials · ${appName}` },
				{ name: "description", content: "Secure provider credential management." },
			],
		};
	},
	loader: () => getProviderCredentialStatusFn(),
	component: ProviderCredentialsPage,
});

function ProviderCredentialsPage() {
	const initial = Route.useLoaderData();
	const [statuses, setStatuses] = useState(
		() =>
			Object.fromEntries(initial.providers.map(({ provider, status }) => [provider, status])) as Record<
				ManagedPublicProvider,
				"PRESENT" | "MISSING" | "OAUTH_REQUIRED"
			>,
	);
	const allPresent = Object.values(statuses).every((status) => status === "PRESENT");

	return (
		<div className="space-y-8">
			<div className="space-y-2">
				<h1 className="text-3xl font-bold tracking-tight">Provider credentials</h1>
				<p className="max-w-3xl text-muted-foreground">
					Enter each credential once. Elmo encrypts it before database storage and never displays the saved value again.
				</p>
			</div>

			{initial.storage !== "READY" ? (
				<Alert variant="destructive">
					<TriangleAlert className="size-4" />
					<AlertTitle>Encrypted storage is unavailable</AlertTitle>
					<AlertDescription>
						Configure a valid ELMO_ENCRYPTION_KEY in the deployment secret manager and restart Elmo before saving
						provider credentials.
					</AlertDescription>
				</Alert>
			) : allPresent ? (
				<Alert>
					<ShieldCheck className="size-4" />
					<AlertTitle>Credential preflight ready</AlertTitle>
					<AlertDescription>
						The Bright Data credential is available. The worker refreshes encrypted credentials within 60 seconds. No
						provider request has been made; a controlled smoke test still requires the owner&apos;s go command.
					</AlertDescription>
				</Alert>
			) : (
				<Alert>
					<KeyRound className="size-4" />
					<AlertTitle>Add the Bright Data credential once</AlertTitle>
					<AlertDescription>
						Saving only updates encrypted storage. It does not contact Bright Data and has no provider cost.
					</AlertDescription>
				</Alert>
			)}

			<div className="max-w-xl">
				{initial.providers.map(({ provider }) => (
					<CredentialCard
						key={provider}
						provider={provider}
						status={statuses[provider]}
						storageReady={initial.storage === "READY"}
						onStored={() => setStatuses((current) => ({ ...current, [provider]: "PRESENT" }))}
					/>
				))}
			</div>

			<p className="text-sm text-muted-foreground">
				Stored credentials are deployment-wide and can only be managed by an Elmo administrator. Connected review and
				social accounts remain optional future modules and are not required for the MVP.
			</p>
		</div>
	);
}

function CredentialCard({
	provider,
	status,
	storageReady,
	onStored,
}: {
	provider: ManagedPublicProvider;
	status: "PRESENT" | "MISSING" | "OAUTH_REQUIRED";
	storageReady: boolean;
	onStored: () => void;
}) {
	const copy = providerCopy[provider];
	const [credential, setCredential] = useState("");
	const [isSaving, setIsSaving] = useState(false);
	const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);
	const helpId = `${provider}-credential-help`;
	const messageId = `${provider}-credential-message`;

	const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (isSaving || !storageReady) return;
		if (credential.trim().length < 8) {
			setMessage({ kind: "error", text: "Enter at least 8 characters." });
			return;
		}
		setIsSaving(true);
		setMessage(null);
		try {
			const result = await saveProviderCredentialFn({ data: { provider, credential } });
			onStored();
			setMessage({
				kind: "success",
				text: result.runtimeRefreshed
					? "Encrypted credential saved. The worker will load it within 60 seconds."
					: "Encrypted credential saved. Runtime refresh will retry automatically within 60 seconds.",
			});
		} catch {
			setMessage({
				kind: "error",
				text: "Credential could not be stored. Check encrypted storage and try again.",
			});
		} finally {
			setCredential("");
			setIsSaving(false);
		}
	};

	return (
		<Card>
			<CardHeader>
				<div className="flex items-start justify-between gap-4">
					<div className="space-y-1.5">
						<CardTitle>{copy.title}</CardTitle>
						<CardDescription>{copy.description}</CardDescription>
					</div>
					<Badge variant={status === "PRESENT" ? "secondary" : "outline"}>
						{status === "PRESENT" ? (
							<span className="flex items-center gap-1.5">
								<CheckCircle2 className="size-3.5" /> Present
							</span>
						) : (
							"Missing"
						)}
					</Badge>
				</div>
			</CardHeader>
			<CardContent>
				<form className="space-y-4" onSubmit={handleSubmit} aria-busy={isSaving}>
					<div className="space-y-2">
						<Label htmlFor={`${provider}-credential`}>
							{status === "PRESENT" ? "Replace credential" : "Credential"}
						</Label>
						<Input
							id={`${provider}-credential`}
							type="password"
							autoComplete="off"
							spellCheck={false}
							aria-describedby={`${helpId}${message ? ` ${messageId}` : ""}`}
							value={credential}
							onChange={(event) => setCredential(event.target.value)}
							placeholder={copy.placeholder}
							disabled={!storageReady || isSaving}
							minLength={8}
							maxLength={4096}
							className="min-h-11"
							required
						/>
						<p id={helpId} className="text-sm text-muted-foreground">
							At least 8 characters. The saved value will never be displayed again.
						</p>
					</div>
					<Button type="submit" className="min-h-11" disabled={!storageReady || isSaving}>
						{isSaving ? (
							<>
								<Loader2 className="size-4 animate-spin" /> Saving…
							</>
						) : status === "PRESENT" ? (
							"Replace securely"
						) : (
							"Save securely"
						)}
					</Button>
					{message && (
						<p
							id={messageId}
							className={message.kind === "error" ? "text-sm text-destructive" : "text-sm text-foreground"}
							role="status"
							aria-live="polite"
						>
							{message.text}
						</p>
					)}
				</form>
			</CardContent>
		</Card>
	);
}
