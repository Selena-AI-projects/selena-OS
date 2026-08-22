// This package deliberately depends on nothing but zod, so @types/node is not
// available here. contextHash needs exactly one runtime built-in — sha256 via
// createHash — declared minimally instead of pulling in full node typings.
declare module "node:crypto" {
	export function createHash(algorithm: "sha256"): {
		update(data: string): { digest(encoding: "hex"): string };
	};
}
