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

export type ContentBrandChoice = { id: string; name: string };

/**
 * Which brand Content OS opens for a workspace that has more than one.
 *
 * A remembered choice outranks the default so that returning to the cabinet
 * lands on the queue the reviewer was working in; a brand that has since been
 * removed, or belongs to another workspace, is not honoured, because opening
 * it would end in the bare 404 `getContentOsBrandFn` exists to prevent.
 */
export function resolveContentBrand(brands: ContentBrandChoice[], remembered: string | null): string | null {
	if (remembered && brands.some((brand) => brand.id === remembered)) return remembered;
	return brands[0]?.id ?? null;
}
