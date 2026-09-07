import { describe, expect, it } from "vitest";
import { contentVersionHash, contentWorkflowV2Hash } from "./selena-control-room";

const v1Input = {
	body: "A verified launch update.",
	ctaUrl: "https://selena.example/brief",
	claims: [],
	evidence: [],
	disclosure: { paid: false },
	policyVersion: "brand-pack/v1",
};

const v2Input: Parameters<typeof contentWorkflowV2Hash>[0] = {
	contentKind: "YOUTUBE_VIDEO",
	contentChannelId: "channel-1",
	structuredBody: { format: "youtube.video/v1", title: "A title" },
	ctaUrl: "https://selena.example/brief",
	claims: [],
	evidenceSnapshot: [{ id: "claim-1", claim: "Observed once." }],
	disclosure: { paid: false },
	policyVersion: "brand-pack/v1",
	projectProfileVersionId: "20000000-0000-4000-8000-000000000001",
	projectProfileHash: "f".repeat(64),
	researchRunId: "20000000-0000-4000-8000-000000000002",
	generationRunId: null,
};

describe("content version hashing", () => {
	/**
	 * A stored V1 hash is a historical fact about what somebody approved. This
	 * pins the exact digest rather than a property of it: a change to the V1
	 * canonicalization, its field set or its ordering would silently invalidate
	 * every approval already recorded, and a property test would not notice.
	 */
	it("keeps the V1 digest byte-for-byte stable", () => {
		expect(contentVersionHash(v1Input)).toBe("ab8885900a8a34bdc034717ecbed44403e974ef63a1735272407e5b707fdc803");
	});

	/**
	 * The V2 digest is pinned the same way V1 is. Asserting only that it is stable
	 * and sensitive would not notice a change to the canonicalization or to the
	 * evidence snapshot's ordering — and an editorial decision is bound to this
	 * digest, so moving it silently would unbind every decision already recorded.
	 */
	it("keeps the V2 digest byte-for-byte stable", () => {
		expect(contentWorkflowV2Hash(v2Input)).toBe("a3273143f5a099886e5ee4c593316269f674a551da5f17cae3b9c52729461195");
	});

	it("gives structured content a different digest from V1 over the same text", () => {
		expect(contentWorkflowV2Hash(v2Input)).not.toBe(contentVersionHash(v1Input));
	});

	it("is stable for the same V2 inputs", () => {
		expect(contentWorkflowV2Hash(v2Input)).toBe(contentWorkflowV2Hash({ ...v2Input }));
	});

	// Each of these is a distinct version even when the words are identical, so
	// each must move the digest. A lineage field that did not would let two
	// different provenances share one approval.
	const lineageChanges: [string, Partial<typeof v2Input>][] = [
		["content kind", { contentKind: "GENERIC_POST" }],
		["channel", { contentChannelId: "channel-2" }],
		["structured body", { structuredBody: { format: "youtube.video/v1", title: "Another title" } }],
		["cta", { ctaUrl: "https://selena.example/other" }],
		["evidence snapshot", { evidenceSnapshot: [{ id: "claim-1", claim: "Observed twice." }] }],
		["disclosure", { disclosure: { paid: true } }],
		["policy version", { policyVersion: "brand-pack/v2" }],
		["profile version", { projectProfileVersionId: "20000000-0000-4000-8000-000000000009" }],
		["profile hash", { projectProfileHash: "a".repeat(64) }],
		["research run", { researchRunId: "20000000-0000-4000-8000-000000000009" }],
		["generation run", { generationRunId: "20000000-0000-4000-8000-000000000003" }],
	];

	for (const [label, change] of lineageChanges) {
		it(`changes the V2 digest when the ${label} changes`, () => {
			expect(contentWorkflowV2Hash({ ...v2Input, ...change })).not.toBe(contentWorkflowV2Hash(v2Input));
		});
	}
});
