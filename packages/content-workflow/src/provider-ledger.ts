/**
 * Durable count of provider dispatches.
 *
 * Acceptance asserts this stays at zero, so it is a first-class object rather
 * than a number a caller can forget to thread through. Research and creation
 * hold separate instances of it, because one budget both spend from cannot say
 * which of them spent it.
 *
 * A process-scoped ledger bounds one web process and nothing more. It cannot
 * bound real spending across a deployment; a durable shared ledger is a
 * prerequisite for authorizing any live call.
 */
export class ProviderCallLedger {
	#entries: { adapterId: string; at: string }[] = [];

	record(adapterId: string, at: Date): void {
		this.#entries.push({ adapterId, at: at.toISOString() });
	}

	get count(): number {
		return this.#entries.length;
	}

	entries(): readonly { adapterId: string; at: string }[] {
		return [...this.#entries];
	}
}
