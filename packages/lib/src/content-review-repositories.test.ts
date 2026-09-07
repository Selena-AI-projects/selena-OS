import { describe, expect, it } from "vitest";
import { isEditorialPolicyRefusal } from "./content-review-repositories";

/**
 * The query builder wraps the driver's error, so the policy violation is not on
 * the error a caller catches. A check that reads only the outermost message
 * passes every test where TypeScript refuses first and fails the one case that
 * matters: the database refusing on its own.
 */
describe("recognising an editorial policy refusal", () => {
	it("finds the refusal underneath the query builder's wrapper", () => {
		const wrapped = new Error("Failed query: insert into editorial_approvals ...");
		wrapped.cause = Object.assign(new Error("new row violates row-level security policy for table \"editorial_approvals\""), {
			code: "42501",
		});
		expect(isEditorialPolicyRefusal(wrapped)).toBe(true);
	});

	it("recognises the driver's own error when it is not wrapped", () => {
		expect(isEditorialPolicyRefusal(Object.assign(new Error("insufficient privilege"), { code: "42501" }))).toBe(true);
	});

	it("does not mistake an unrelated failure for a refused decision", () => {
		const wrapped = new Error("Failed query: insert into editorial_approvals ...");
		wrapped.cause = Object.assign(new Error('duplicate key value violates unique constraint'), { code: "23505" });
		expect(isEditorialPolicyRefusal(wrapped)).toBe(false);
		expect(isEditorialPolicyRefusal(new Error("connection terminated"))).toBe(false);
		expect(isEditorialPolicyRefusal(null)).toBe(false);
	});

	it("gives up rather than following a cause chain that points at itself", () => {
		const looping = new Error("Failed query");
		looping.cause = looping;
		expect(isEditorialPolicyRefusal(looping)).toBe(false);
	});
});
