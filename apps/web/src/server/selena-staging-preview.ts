import { createServerFn } from "@tanstack/react-start";
import { isSelenaStagingPreviewEnabled } from "@/lib/selena-staging-preview.server";

export const getSelenaStagingPreviewStateFn = createServerFn({ method: "GET" }).handler(() => ({
	enabled: isSelenaStagingPreviewEnabled(),
}));
