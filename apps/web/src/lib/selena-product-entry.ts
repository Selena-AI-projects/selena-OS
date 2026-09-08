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

export const SELENA_LAST_CONTENT_BRAND_STORAGE_KEY = "selena-last-content-brand";

export function getLastContentBrand(): string | null {
	if (typeof window === "undefined") return null;
	return window.localStorage.getItem(SELENA_LAST_CONTENT_BRAND_STORAGE_KEY);
}

export function rememberContentBrand(brandId: string): void {
	if (typeof window === "undefined") return;
	window.localStorage.setItem(SELENA_LAST_CONTENT_BRAND_STORAGE_KEY, brandId);
}

/**
 * Forget which product was last opened, so the next visit to the entry asks
 * again instead of sending the visitor straight back where they came from.
 */
export function forgetSelenaProduct(): void {
	if (typeof window === "undefined") return;
	window.localStorage.removeItem(SELENA_LAST_PRODUCT_STORAGE_KEY);
}
