import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { CANONICAL_PUBLIC_READINESS_PAYLOAD } from "../lib/selena-canonical-readiness";

/** Compatibility export with no collection, persistence, jobs or provider access. */
export const runSelenaPublicScanFn = createServerFn({ method: "POST" })
	.validator(z.object({ website: z.string().trim().min(1).max(2048) }))
	.handler(() => CANONICAL_PUBLIC_READINESS_PAYLOAD);
