import { useRef } from "react";

/**
 * One idempotency key per target, held across renders.
 *
 * A double-submitted generation has to return the run that already exists
 * rather than fork a second one, which is what a key held across renders buys.
 * The server refuses a key presented for a different request, so a single key
 * shared by every target on the page has a dead end: if rotation is ever
 * skipped — an invalidation that throws, a response lost after the server
 * committed — the next action on a *different* target is refused, and only a
 * reload clears it. Keying by target confines a stale key to the one target it
 * was used for.
 */
export function useIdempotencyKeys() {
	const keys = useRef(new Map<string, string>());

	function keyFor(target: string): string {
		const existing = keys.current.get(target);
		if (existing) return existing;
		const created = crypto.randomUUID();
		keys.current.set(target, created);
		return created;
	}

	function rotate(target: string): void {
		keys.current.delete(target);
	}

	return { keyFor, rotate };
}
