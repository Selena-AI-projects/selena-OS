// Pure invariants for the RC7 entity hierarchy, kept database-free so the
// repository layer and tests share one source of truth for what a valid
// parent link is.
export type SvEntityConfirmationStatus = "PROPOSED" | "CLIENT_CONFIRMED" | "ANALYST_CONFIRMED" | "REJECTED";

export type EntityParentCandidate = {
	id?: string;
	organizationId: string;
	projectId: string;
	parentEntityId?: string | null;
	parentRelation?: string | null;
};

export type EntityParentRecord = {
	id: string;
	organizationId: string;
	projectId: string;
};

export function validateEntityParent(
	entity: EntityParentCandidate,
	parent: EntityParentRecord | null | undefined,
): void {
	if (!entity.parentEntityId) {
		if (entity.parentRelation) throw new Error("SELENA_ENTITY_RELATION_WITHOUT_PARENT");
		return;
	}
	if (entity.id && entity.parentEntityId === entity.id) throw new Error("SELENA_ENTITY_SELF_PARENT");
	// A parent in another tenant or project reports the same code as a missing
	// one so lookups cannot be used to probe foreign tenants.
	if (!parent || parent.organizationId !== entity.organizationId || parent.projectId !== entity.projectId)
		throw new Error("SELENA_ENTITY_PARENT_FOREIGN");
}

export function detectEntityCycle(
	entities: Array<{ id: string; parentEntityId?: string | null }>,
	candidate: { id: string; parentEntityId?: string | null },
): void {
	if (candidate.parentEntityId && candidate.parentEntityId === candidate.id)
		throw new Error("SELENA_ENTITY_SELF_PARENT");
	const parents = new Map(entities.map((entity) => [entity.id, entity.parentEntityId ?? null]));
	parents.set(candidate.id, candidate.parentEntityId ?? null);
	const seen = new Set<string>([candidate.id]);
	let current = candidate.parentEntityId ?? null;
	while (current) {
		if (seen.has(current)) throw new Error("SELENA_ENTITY_CYCLE");
		seen.add(current);
		current = parents.get(current) ?? null;
	}
}

export function lockEligibleEntities<T extends { confirmationStatus: SvEntityConfirmationStatus }>(
	entities: T[],
): T[] {
	return entities.filter(
		(entity) =>
			entity.confirmationStatus === "CLIENT_CONFIRMED" || entity.confirmationStatus === "ANALYST_CONFIRMED",
	);
}
