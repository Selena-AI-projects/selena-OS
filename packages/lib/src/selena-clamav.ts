export type ClamAvScanResult = { clean: true } | { clean: false; reason: "MALWARE_DETECTED" };

/**
 * ClamAV returns a short line after an INSTREAM scan. Keep the provider's
 * signature out of logs and database records: it can reveal sensitive file
 * characteristics without adding value to a Selena user.
 */
export function parseClamAvScanReply(reply: string): ClamAvScanResult {
	const normalized = reply.trim();
	if (/\bOK$/.test(normalized)) return { clean: true };
	if (/\bFOUND$/.test(normalized)) return { clean: false, reason: "MALWARE_DETECTED" };
	throw new Error("ClamAV returned an invalid scan result");
}
