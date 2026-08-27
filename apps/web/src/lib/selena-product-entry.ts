export const SELENA_LAST_PRODUCT_STORAGE_KEY = "selena-last-product";

export type SelenaProduct = "ai-visibility" | "content-control";

export function parseSelenaProduct(value: string | null): SelenaProduct | null {
	return value === "ai-visibility" || value === "content-control" ? value : null;
}

export function getLastSelenaProduct(): SelenaProduct | null {
	if (typeof window === "undefined") return null;
	return parseSelenaProduct(window.localStorage.getItem(SELENA_LAST_PRODUCT_STORAGE_KEY));
}

export function rememberSelenaProduct(product: SelenaProduct): void {
	if (typeof window === "undefined") return;
	window.localStorage.setItem(SELENA_LAST_PRODUCT_STORAGE_KEY, product);
}
