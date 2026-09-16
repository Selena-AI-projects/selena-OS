import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { SelenaLocalPrepayment } from "@/components/selena-local-prepayment";
import { localPrepaymentEnabled } from "@/lib/selena-local-prepayment";
import { listSelenaWorkspaces, selectSelenaWorkspace } from "@/server/selena-workspaces";

const context = createServerFn({ method: "GET" }).handler(async () => {
	const { resolveSessionAuthContext } = await import("@/lib/selena-auth-context.server");
	const auth = await resolveSessionAuthContext();
	return {
		enabled: localPrepaymentEnabled(process.env),
		workspaceId: auth.tenantId,
		workspaces: await listSelenaWorkspaces(),
	};
});
export const Route = createFileRoute("/_authed/selena/local/checkout")({
	loader: () => context(),
	component: LocalCheckout,
});
function LocalCheckout() {
	const data = Route.useLoaderData();
	const [selected, setSelected] = useState(data.workspaceId);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState("");
	return data.enabled ? (
		<>
			{data.workspaces.organizations.length > 1 && (
				<section aria-label="Workspace selection" className="selena-app px-5 pt-6">
					<div className="mx-auto flex max-w-3xl flex-wrap items-end gap-3">
						<label htmlFor="local-workspace">Workspace</label>
						<select
							id="local-workspace"
							value={selected}
							disabled={pending || data.workspaces.readOnly}
							onChange={(event) => setSelected(event.target.value)}
							className="min-h-11 max-w-full rounded-md border border-[var(--selena-line)] bg-[var(--selena-surface)] p-3"
						>
							{data.workspaces.organizations.map((workspace) => (
								<option key={workspace.id} value={workspace.id}>
									{workspace.name}
								</option>
							))}
						</select>
						<button
							type="button"
							className="selena-text-button min-h-11"
							disabled={pending || data.workspaces.readOnly}
							onClick={async () => {
								setPending(true);
								setError("");
								try {
									await selectSelenaWorkspace({ data: { organizationId: selected } });
									window.location.assign("/selena/local/checkout");
								} catch {
									setError("Could not switch workspace. Please try again.");
									setPending(false);
								}
							}}
						>
							{pending ? "Switching…" : "Switch workspace"}
						</button>
						{error && <p role="alert">{error}</p>}
					</div>
				</section>
			)}
			<SelenaLocalPrepayment key={data.workspaceId} workspaceId={data.workspaceId} />
		</>
	) : (
		<main className="selena-app min-h-screen p-8">
			<h1 className="selena-heading text-3xl">Local Visibility</h1>
			<p>This service is not yet available in this workspace.</p>
			<a className="selena-text-button inline-flex min-h-11 items-center" href="/app/selena">
				Back to workspace
			</a>
		</main>
	);
}
