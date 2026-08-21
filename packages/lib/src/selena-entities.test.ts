import { describe, expect, it } from "vitest";
import {
	detectEntityCycle,
	lockEligibleEntities,
	validateEntityParent,
} from "./selena-entities";

// RC7 reference fixture: a master brand containing two in-house concepts.
const org = "org-kora";
const project = "project-kora";
const koraFoodHall = {
	id: "entity-kora-food-hall",
	organizationId: org,
	projectId: project,
	entityKind: "MASTER_BRAND",
	parentEntityId: null,
	parentRelation: null,
	confirmationStatus: "CLIENT_CONFIRMED" as const,
	name: "KORA Food Hall",
};
const twoMoonsSpa = {
	id: "entity-two-moons-spa",
	organizationId: org,
	projectId: project,
	entityKind: "CONCEPT",
	parentEntityId: koraFoodHall.id,
	parentRelation: "CONCEPT_WITHIN",
	confirmationStatus: "ANALYST_CONFIRMED" as const,
	name: "Two Moons Spa",
};
const healthyCafe = {
	id: "entity-healthy-cafe",
	organizationId: org,
	projectId: project,
	entityKind: "CONCEPT",
	parentEntityId: koraFoodHall.id,
	parentRelation: "CONCEPT_WITHIN",
	confirmationStatus: "PROPOSED" as const,
	name: "Healthy Cafe",
};
const hierarchy = [koraFoodHall, twoMoonsSpa, healthyCafe];

describe("Selena entity hierarchy invariants", () => {
	it("accepts the master brand with concepts hierarchy", () => {
		expect(() => validateEntityParent(koraFoodHall, null)).not.toThrow();
		expect(() => validateEntityParent(twoMoonsSpa, koraFoodHall)).not.toThrow();
		expect(() => validateEntityParent(healthyCafe, koraFoodHall)).not.toThrow();
		for (const entity of hierarchy) {
			expect(() => detectEntityCycle(hierarchy, entity)).not.toThrow();
		}
	});

	it("rejects a parent from another tenant or project", () => {
		expect(() => validateEntityParent(twoMoonsSpa, undefined)).toThrow("SELENA_ENTITY_PARENT_FOREIGN");
		expect(() => validateEntityParent(twoMoonsSpa, { ...koraFoodHall, organizationId: "org-other" })).toThrow(
			"SELENA_ENTITY_PARENT_FOREIGN",
		);
		expect(() => validateEntityParent(twoMoonsSpa, { ...koraFoodHall, projectId: "project-other" })).toThrow(
			"SELENA_ENTITY_PARENT_FOREIGN",
		);
	});

	it("rejects a parent relation without a parent", () => {
		expect(() =>
			validateEntityParent({ ...healthyCafe, parentEntityId: null, parentRelation: "CONCEPT_WITHIN" }, null),
		).toThrow("SELENA_ENTITY_RELATION_WITHOUT_PARENT");
	});

	it("rejects self-parenting", () => {
		expect(() => validateEntityParent({ ...koraFoodHall, parentEntityId: koraFoodHall.id }, koraFoodHall)).toThrow(
			"SELENA_ENTITY_SELF_PARENT",
		);
		expect(() => detectEntityCycle(hierarchy, { id: koraFoodHall.id, parentEntityId: koraFoodHall.id })).toThrow(
			"SELENA_ENTITY_SELF_PARENT",
		);
	});

	it("rejects the KORA -> Two Moons -> KORA cycle", () => {
		expect(() =>
			detectEntityCycle(hierarchy, { id: koraFoodHall.id, parentEntityId: twoMoonsSpa.id }),
		).toThrow("SELENA_ENTITY_CYCLE");
	});

	it("keeps PROPOSED entities out of lock eligibility", () => {
		expect(lockEligibleEntities(hierarchy).map((entity) => entity.id)).toEqual([koraFoodHall.id, twoMoonsSpa.id]);
		expect(
			lockEligibleEntities([{ ...healthyCafe, confirmationStatus: "REJECTED" as const }]),
		).toEqual([]);
	});
});
