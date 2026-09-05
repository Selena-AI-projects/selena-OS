export const CONTENT_PRODUCT_NAME = "Content OS";

export const CONTENT_PRODUCT_DESCRIPTION =
	"Prepare, review and approve evidence-bearing content without enabling external publication.";

export const CONTENT_PRODUCT_ROUTE = "/app/$brand/control-room" as const;

/**
 * The brand slug Content OS opens.
 *
 * It cannot be "selena": the workspace chooser itself is the static route
 * `/app/selena`, and a static segment wins over `$brand`. Navigating to
 * `/app/selena/control-room` therefore matched the chooser, which has no child
 * routes, and answered 404 — a dead entry button that no test could catch,
 * because the route tree is only assembled when the app runs.
 *
 * Every static file under `routes/_authed/app/` reserves its name the same way;
 * the test beside this module asserts that this slug is not one of them.
 */
export const CONTENT_OS_BRAND_SLUG = "selena-content";
