export const CONTENT_PRODUCT_NAME = "Content OS";

export const CONTENT_PRODUCT_DESCRIPTION =
	"Prepare, review and approve evidence-bearing content without enabling external publication.";

export const CONTENT_PRODUCT_ROUTE = "/app/$brand/control-room" as const;

/**
 * Content OS opens `/app/$brand/control-room`, and `$brand` is a brand **id**
 * looked up in the database — not a slug and not a name. So the entry cannot
 * hold a constant at all: it has to carry the id of a brand the signed-in user
 * actually has, and send them to create one when they have none.
 *
 * Two things went wrong here in turn, and both answered 404, which is why the
 * first fix looked right and changed nothing. The chooser is the static route
 * `/app/selena`, so `/app/selena/control-room` matched the chooser, which has
 * no children. Pointing it at another literal moved the refusal one step
 * later, into the brand loader, which throws notFound for an id it cannot
 * resolve. Only a real brand id gets past both.
 */
export const BRAND_CREATION_ROUTE = "/app/new" as const;
