/**
 * Whether a timezone sticks to whole-hour UTC offsets across the queried
 * range. The hourly rollup can assemble local days only when local midnight
 * falls on an hour boundary; fractional-offset zones (India +5:30, Nepal
 * +5:45, Lord Howe's half-hour DST) must fall back to scanning prompt_runs.
 */

export function offsetMinutesAt(timeZone: string, at: Date): number {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone,
		hour12: false,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	}).formatToParts(at);
	const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
	// Intl renders midnight as hour 24 in some locales/options combinations.
	const hour = get("hour") === 24 ? 0 : get("hour");
	const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second"));
	return Math.round((asUtc - at.getTime()) / 60_000);
}

export function usesWholeHourOffsets(timeZone: string, fromDate: string | null, toDate: string | null): boolean {
	const to = toDate ? new Date(`${toDate}T00:00:00Z`) : new Date();
	// An unbounded query still only reaches data the product has, so sampling
	// a generous trailing window is enough — historic sub-minute offsets from
	// the pre-timezone era never intersect prompt_runs.
	const from = fromDate ? new Date(`${fromDate}T00:00:00Z`) : new Date(to.getTime() - 400 * 24 * 60 * 60 * 1000);
	const mid = new Date((from.getTime() + to.getTime()) / 2);
	try {
		return [from, mid, to].every((d) => offsetMinutesAt(timeZone, d) % 60 === 0);
	} catch {
		// Unknown to Intl: use the raw-table path so Postgres stays the single
		// authority on whether the zone name is valid.
		return false;
	}
}
