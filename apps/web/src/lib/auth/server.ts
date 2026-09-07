/**
 * Auth instance for the web app.
 *
 * Created once at module scope using the shared factory from @workspace/lib,
 * with deployment-specific options injected based on DEPLOYMENT_MODE.
 *
 * This is the single source of truth for the server-side auth object.
 * All server functions, middleware, and route handlers import from here.
 */
import { getCloudAuthOptions } from "@workspace/cloud/auth-hooks";
import { type CreateAuthOptions, createAuth } from "@workspace/lib/auth/server";
import { countUsers, hasOrganization, hasPendingInvitation, provisionLocalOrg } from "@workspace/lib/db/provisioning";
import { getWhitelabelAuthOptions } from "@workspace/whitelabel/auth-hooks";
import { getSelenaStagingGoogleSignInOptions } from "../selena-staging-google-auth.server";

/**
 * Local mode hooks: an install belongs to whoever bootstraps it, and
 * grows only by invitation. The `before` hook admits the first account
 * unconditionally and every later one only if an owner has already
 * invited that address; the `after` hook creates the organization and
 * admin membership for the bootstrapping account alone, because an
 * invited colleague gets their membership — at the role they were
 * invited with — when they accept.
 *
 * Also applies to direct POST /api/auth/sign-up/email calls — the hooks
 * fire regardless of whether signup is triggered from our UI or a curl.
 * That is what keeps an uninvited address out: there is no registration
 * surface to disable, only this check.
 */
function getLocalAuthOptions(): CreateAuthOptions {
	const stagingGoogleSignIn = getSelenaStagingGoogleSignInOptions();

	return {
		databaseHooks: {
			user: {
				create: {
					before: async (user) => {
						if ((await countUsers()) === 0) return;
						if (await hasPendingInvitation(user.email)) return;
						throw new Error("This instance is already bootstrapped. Ask its owner for an invitation.");
					},
					after: async (user) => {
						if (await hasOrganization()) return;
						await provisionLocalOrg({ userId: user.id });
					},
				},
			},
		},
		...(stagingGoogleSignIn ?? {}),
	};
}

function getDeploymentAuthOptions(): CreateAuthOptions | undefined {
	switch (process.env.DEPLOYMENT_MODE) {
		case "whitelabel":
			return getWhitelabelAuthOptions();
		case "demo":
			// Signup is disabled. Demo deployments reuse a database previously
			// bootstrapped in local mode; visitors can only sign in as that
			// pre-existing user.
			return { disableSignUp: true };
		case "cloud": {
			// Full cloud auth stack (email verification, Google OAuth, Resend
			// transactional email, team invitations, disposable-domain blocking,
			// invite-only allowlist, and umbrella-org provisioning). The cloud
			// package owns the entire hook chain — this case is a single call.
			return getCloudAuthOptions();
		}
		default:
			return getLocalAuthOptions();
	}
}

export const auth = createAuth(getDeploymentAuthOptions());
