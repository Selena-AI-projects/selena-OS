import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright";
import { createServer } from "vite";
import { type LocalRestaurant, type LocalSavedOrder, prepareLocalOrder } from "../src/lib/selena-local-prepayment";
import { createLocalPrepaymentApi, type LocalOperation } from "../src/server/selena-local-prepayment-api";

const root = fileURLToPath(new URL("../", import.meta.url));
const scratch = await mkdtemp(path.join(root, ".local-prepayment-browser-"));
const artifacts = fileURLToPath(new URL("../../../docs/local-visibility/", import.meta.url));
await mkdir(artifacts, { recursive: true });
const restaurants: LocalRestaurant[] = [],
	orders: LocalSavedOrder[] = [];
const auth = {
	tenantId: "browser-fixture",
	actorId: "owner-fixture",
	authType: "session" as const,
	role: "owner" as const,
	permissions: [],
};
const handler = createLocalPrepaymentApi({
	enabled: () => true,
	authenticate: async () => auth,
	store: {
		list: async (_, kind) => (kind === "restaurants" ? restaurants : kind === "orders" ? orders : []),
		createRestaurant: async (_, input) => {
			const row = { id: "10000000-0000-4000-8000-000000000001", details: input };
			restaurants.push(row);
			return row;
		},
		createOrder: async (_, input) => {
			const row = {
				id: "20000000-0000-4000-8000-000000000002",
				snapshot: prepareLocalOrder(input, restaurants[0].details),
				createdAt: new Date().toISOString(),
			};
			orders.push(row);
			return row;
		},
		readOrder: async (_, id) => orders.find((row) => row.id === id) ?? null,
		readReport: async () => new Response("Not found", { status: 404 }),
	},
});
await writeFile(
	path.join(scratch, "index.html"),
	'<html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/main.tsx"></script></body></html>',
);
await writeFile(
	path.join(scratch, "main.tsx"),
	'import React from "react"; import {createRoot} from "react-dom/client"; import {SelenaLocalPrepayment} from "../src/components/selena-local-prepayment"; import "../src/styles.css"; createRoot(document.getElementById("root")!).render(<SelenaLocalPrepayment workspaceId="browser-fixture"/>);',
);
const server = await createServer({
	configFile: false,
	root: scratch,
	envDir: scratch,
	plugins: [
		react(),
		tailwindcss(),
		{
			name: "local-prepayment-fixture-api",
			configureServer(vite) {
				vite.middlewares.use(async (req, res, next) => {
					if (!req.url?.startsWith("/api/v1/selena/local-prepayment/")) return next();
					try {
						const parts = req.url.split("local-prepayment/")[1].split("/");
						const op: LocalOperation = parts.includes("start")
							? "blocked"
							: parts[0] === "orders" && parts[1]
								? "order"
								: (parts[0] as LocalOperation);
						const chunks: Buffer[] = [];
						for await (const chunk of req) chunks.push(Buffer.from(chunk));
						const response = await handler(
							new Request(`http://127.0.0.1:56649${req.url}`, {
								method: req.method,
								headers: new Headers(
									Object.entries(req.headers).flatMap(([key, value]) =>
										typeof value === "string" ? [[key, value]] : [],
									),
								),
								...(req.method === "POST" ? { body: Buffer.concat(chunks).toString() } : {}),
							}),
							op,
							parts[1],
						);
						res.statusCode = response.status;
						response.headers.forEach((value, key) => {
							res.setHeader(key, value);
						});
						res.end(await response.text());
					} catch {
						res.statusCode = 500;
						res.end("Fixture error");
					}
				});
			},
		},
	],
	server: { host: "127.0.0.1", port: 56649, strictPort: true, fs: { allow: [path.resolve(root, "../..")] } },
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
	await server.listen();
	browser = await chromium.launch({ headless: true, channel: "chrome" });
	const page = await browser.newPage();
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.route("**/*", (route) =>
		new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort(),
	);
	await page.goto("http://127.0.0.1:56649");
	await page.getByRole("button", { name: "Add a restaurant" }).click();
	await page.getByLabel("Restaurant name", { exact: true }).fill("Fixture restaurant");
	await page.getByLabel("Google Maps place link").fill("https://www.google.com/maps?cid=123");
	await page.getByLabel("Latitude", { exact: true }).fill("-8.8");
	await page.getByLabel("Longitude", { exact: true }).fill("115.1");
	await page.getByRole("checkbox").check();
	await page.getByRole("button", { name: "Save restaurant" }).click();
	await page.getByLabel("Queries, one per line (up to 15)").fill("Dinner\nLunch");
	await page.getByLabel("Grid").selectOption("5");
	await page.getByRole("button", { name: "Prepare order", exact: true }).click();
	await page.getByRole("heading", { name: "Order prepared" }).waitFor();
	await page.reload();
	await page.getByRole("heading", { name: "Order prepared" }).waitFor();
	assert.equal(orders.length, 1);
	assert.equal(orders[0].snapshot.expectedObservations, 50);
	for (const width of [390, 768, 1280]) {
		await page.setViewportSize({ width, height: 1000 });
		assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
		await page.screenshot({ path: path.join(artifacts, `prepayment-fixture-${width}.png`), fullPage: true });
	}
	assert.equal(await page.getByRole("button", { name: /pay|start|execute/i }).count(), 0);
	assert.equal(
		await page.evaluate(
			async () => (await fetch("/api/v1/selena/local-prepayment/orders/x/start", { method: "POST" })).status,
		),
		403,
	);
	assert.deepEqual(errors, []);
	console.log(
		"PASS: FIXTURE browser uses real component/API; restaurant -> 2 queries x 25 points -> saved order -> reload; no overflow at 390/768/1280; no payment/start controls; API start refused; no page errors. This does not verify hosted login or production data.",
	);
} finally {
	await browser?.close();
	await server.close();
	await rm(scratch, { recursive: true, force: true });
}
