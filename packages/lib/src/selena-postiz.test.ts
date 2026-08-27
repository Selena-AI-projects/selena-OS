import { describe, expect, it, vi } from "vitest";
import { createPostizAdapter, type PostizApiError } from "./selena-postiz";

const configuration = {
	allowedIntegrationId: "linkedin-page-only",
	expectedOrganizationId: "selena-systems",
	token: "postiz-test-token",
};

describe("Postiz Release Gateway adapter", () => {
	it("allows only the configured LinkedIn Page and never forms an immediate publish request", async () => {
		const fetchFn = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify([
						{
							id: "linkedin-page-only",
							identifier: "linkedin-page",
							organizationId: "selena-systems",
							status: "ACTIVE",
						},
					]),
					{ status: 200 },
				),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify([{ postId: "post-1", integration: "linkedin-page-only" }]), { status: 200 }),
			);
		const adapter = createPostizAdapter(configuration, fetchFn);
		await expect(adapter.connectionStatus()).resolves.toMatchObject({ state: "CONNECTED" });
		await expect(
			adapter.scheduleLinkedInPagePost({
				content: "Scheduled update",
				integrationId: "linkedin-page-only",
				media: [],
				scheduledFor: "2030-01-01T12:00:00.000Z",
			}),
		).resolves.toEqual({ integrationId: "linkedin-page-only", postId: "post-1" });
		const [, request] = fetchFn.mock.calls[1] ?? [];
		expect(String(request?.body)).toContain('"type":"schedule"');
		expect(String(request?.body)).toContain('"__type":"linkedin-page"');
		expect(String(request?.body)).not.toContain('"type":"now"');
	});

	it("rejects a destination outside the Gateway allowlist before a network request", async () => {
		const fetchFn = vi.fn<typeof fetch>();
		const adapter = createPostizAdapter(configuration, fetchFn);
		await expect(
			adapter.scheduleLinkedInPagePost({
				content: "No",
				integrationId: "another-page",
				media: [],
				scheduledFor: "2030-01-01T12:00:00.000Z",
			}),
		).rejects.toThrow("not allowlisted");
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it("does not disclose a credential when Postiz rejects a request", async () => {
		const adapter = createPostizAdapter(
			configuration,
			vi.fn<typeof fetch>().mockResolvedValue(new Response("denied", { status: 401 })),
		);
		await expect(adapter.listDestinations()).rejects.toEqual(
			expect.objectContaining({ name: "PostizApiError", status: 401 } satisfies Partial<PostizApiError>),
		);
		await expect(adapter.listDestinations()).rejects.not.toThrow(configuration.token);
	});
});
