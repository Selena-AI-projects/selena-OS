import type { CreationErrorCode } from "@workspace/content-workflow/creation";

export type ThumbnailAttachFailure = { code: CreationErrorCode; message: string; status: number };

/**
 * What a failed attach tells the caller.
 *
 * The one distinction that has to survive is `BLOCKED_STORAGE`: it means the
 * image reached neither private storage nor the scanner, so nothing was saved
 * and a retry is not a duplicate. Folding it into a generic error would leave a
 * caller unable to tell "we could not store this" from "we stored it and it is
 * being scanned", which is the difference the scanner-bypass stop condition
 * exists to protect.
 */
export function describeThumbnailAttachFailure(error: unknown): ThumbnailAttachFailure {
	const message = error instanceof Error ? error.message : "The thumbnail could not be attached";
	if (message.startsWith("Unauthorized")) {
		return { code: "INVALID_INPUT", message: "Sign in before attaching a thumbnail", status: 401 };
	}
	if (message.startsWith("Forbidden") || message.includes("not available for this brand")) {
		return { code: "NOT_FOUND", message: "That content version is not available to this brand", status: 403 };
	}
	// Storage and the scanner are one boundary from a caller's point of view:
	// either the image reached private storage and a scan is pending, or it did
	// not. Missing configuration and an unreachable service both mean the latter.
	if (message.includes("not configured") || message.includes("Private asset scanner")) {
		return {
			code: "BLOCKED_STORAGE",
			message: "The thumbnail was not saved: private storage or scanning is unavailable",
			status: 503,
		};
	}
	return { code: "INVALID_INPUT", message, status: 400 };
}
