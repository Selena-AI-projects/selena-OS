import { Button } from "@workspace/ui/components/button";
import { Input } from "@workspace/ui/components/input";
import { useCallback, useEffect, useRef, useState } from "react";
import type { LocalRestaurant, LocalSavedOrder } from "../lib/selena-local-prepayment";

const base = "/api/v1/selena/local-prepayment";
const field =
	"min-h-11 w-full rounded-md border border-[var(--selena-line)] bg-[var(--selena-surface)] p-3 text-base focus-visible:outline-2 focus-visible:outline-offset-2";
async function api<T>(path: string, options?: RequestInit): Promise<T> {
	const response = await fetch(`${base}/${path}`, { ...options, credentials: "same-origin" });
	if (!response.ok)
		throw new Error(
			response.status === 409
				? "This saved request differs. Reload to review it."
				: response.status === 400
					? "Check the form. Use a full Google Maps place link and distinct queries."
					: response.status === 401
						? "Please sign in again."
						: response.status === 403
							? "Only a workspace owner or administrator can save this."
							: "Local Visibility is temporarily unavailable. Your saved work is retained.",
		);
	return response.json();
}
export function SelenaLocalPrepayment({ workspaceId }: { workspaceId: string }) {
	const [restaurants, setRestaurants] = useState<LocalRestaurant[]>([]);
	const [orders, setOrders] = useState<LocalSavedOrder[]>([]);
	const [reports, setReports] = useState<Array<{ id: string; title: string }>>([]);
	const [selected, setSelected] = useState("");
	const [order, setOrder] = useState<LocalSavedOrder | null>(null);
	const [busy, setBusy] = useState(true),
		[error, setError] = useState("");
	const [adding, setAdding] = useState(false);
	const [queries, setQueries] = useState(""),
		[language, setLanguage] = useState("en"),
		[size, setSize] = useState(3);
	const pending = useRef(false);
	const refresh = useCallback(async () => {
		const [locations, history, publications] = await Promise.all([
			api<LocalRestaurant[]>("restaurants"),
			api<LocalSavedOrder[]>("orders"),
			api<Array<{ id: string; title: string }>>("reports"),
		]);
		setRestaurants(locations);
		setSelected((old) => old || locations[0]?.id || "");
		setOrders(history);
		setReports(publications);
	}, []);
	useEffect(() => {
		let active = true;
		const id = new URLSearchParams(window.location.search).get("order");
		void Promise.all([refresh(), id ? api<LocalSavedOrder>(`orders/${encodeURIComponent(id)}`) : Promise.resolve(null)])
			.then(([, saved]) => {
				if (active) setOrder(saved);
			})
			.catch((e: Error) => {
				if (active) setError(e.message);
			})
			.finally(() => {
				if (active) setBusy(false);
			});
		return () => {
			active = false;
		};
	}, [refresh]);
	async function save<T>(path: string, value: unknown): Promise<T> {
		const body = JSON.stringify(value);
		const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body))))
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");
		const storageKey = `local-prepayment:${workspaceId}:${path}:${hash}`;
		const key = sessionStorage.getItem(storageKey) ?? crypto.randomUUID();
		sessionStorage.setItem(storageKey, key);
		return api<T>(path, {
			method: "POST",
			body,
			headers: { "Content-Type": "application/json", "Idempotency-Key": key },
		});
	}
	async function action(work: () => Promise<void>) {
		if (pending.current) return;
		pending.current = true;
		setBusy(true);
		setError("");
		try {
			await work();
		} catch (e) {
			setError(e instanceof Error ? e.message : "Could not save your request.");
		} finally {
			pending.current = false;
			setBusy(false);
		}
	}
	return (
		<main className="selena-app min-h-screen px-5 py-8">
			<div className="mx-auto max-w-3xl space-y-6">
				<a href="/app/selena" className="selena-text-button inline-flex min-h-11 items-center">
					Back to workspace
				</a>
				<h1 className="selena-heading text-3xl">Local Visibility</h1>
				<p>
					Prepare a one-off Google Maps visibility report for $49. Payments are not yet available. Saving an order does
					not charge you or start measurements.
				</p>
				{busy && <p role="status">Loading…</p>}
				{error && (
					<div role="alert">
						<p>{error}</p>
						<Button className="min-h-11" disabled={busy} onClick={() => void action(refresh)}>
							Try again
						</Button>
					</div>
				)}
				{!order && (
					<>
						<Button className="min-h-11" disabled={busy} onClick={() => setAdding(!adding)}>
							{adding ? "Close restaurant form" : "Add a restaurant"}
						</Button>
						{adding && (
							<form
								className="space-y-4"
								onSubmit={(event) => {
									event.preventDefault();
									const data = new FormData(event.currentTarget);
									void action(async () => {
										const saved = await save<LocalRestaurant>("restaurants", {
											name: data.get("name"),
											mapsUrl: data.get("mapsUrl"),
											countryCode: String(data.get("countryCode")).toUpperCase(),
											latitude: Number(data.get("latitude")),
											longitude: Number(data.get("longitude")),
											confirmed: data.get("confirmed") === "on",
										});
										await refresh();
										setSelected(saved.id);
										setAdding(false);
									});
								}}
							>
								<h2 className="selena-heading text-2xl">Your restaurant</h2>
								<label className="block" htmlFor="local-name">
									Restaurant name
									<Input id="local-name" name="name" required maxLength={160} className={field} />
								</label>
								<label className="block" htmlFor="local-mapsUrl">
									Google Maps place link
									<Input
										id="local-mapsUrl"
										name="mapsUrl"
										type="url"
										required
										className={field}
										placeholder="https://www.google.com/maps?cid=…"
									/>
								</label>
								<p>
									Open the place in Google Maps and copy its full address-bar link, including its place identity. Short
									share links cannot be confirmed here.
								</p>
								<div className="grid gap-4 sm:grid-cols-3">
									<label htmlFor="local-countryCode">
										Country code
										<Input
											id="local-countryCode"
											name="countryCode"
											required
											minLength={2}
											maxLength={2}
											defaultValue="ID"
											className={field}
										/>
									</label>
									<label htmlFor="local-latitude">
										Latitude
										<Input
											id="local-latitude"
											name="latitude"
											type="number"
											required
											step="0.000001"
											min={-85}
											max={85}
											className={field}
										/>
									</label>
									<label htmlFor="local-longitude">
										Longitude
										<Input
											id="local-longitude"
											name="longitude"
											type="number"
											required
											step="0.000001"
											min={-180}
											max={180}
											className={field}
										/>
									</label>
								</div>
								<label className="flex min-h-11 items-center gap-3">
									<input type="checkbox" name="confirmed" required />I confirm this place link and these coordinates
									belong to my restaurant.
								</label>
								<Button type="submit" disabled={busy} className="selena-primary-button min-h-11">
									Save restaurant
								</Button>
							</form>
						)}
						{!adding && (
							<form
								className="space-y-4"
								onSubmit={(event) => {
									event.preventDefault();
									void action(async () => {
										const saved = await save<LocalSavedOrder>("orders", {
											restaurantId: selected,
											queries: queries
												.split("\n")
												.map((q) => q.trim())
												.filter(Boolean),
											language,
											gridSize: size,
										});
										setOrder(saved);
										window.history.replaceState(null, "", `${window.location.pathname}?order=${saved.id}`);
										await refresh();
									});
								}}
							>
								{!busy && !error && !restaurants.length && <p>Add and confirm your restaurant to prepare an order.</p>}
								<label className="block">
									Restaurant
									<select required value={selected} onChange={(e) => setSelected(e.target.value)} className={field}>
										<option value="">Choose restaurant</option>
										{restaurants.map((r) => (
											<option key={r.id} value={r.id}>
												{r.details.name}
											</option>
										))}
									</select>
								</label>
								<label className="block">
									Queries, one per line (up to 15)
									<textarea
										required
										value={queries}
										onChange={(e) => setQueries(e.target.value)}
										rows={4}
										className={field}
									/>
								</label>
								<div className="grid gap-4 sm:grid-cols-2">
									<label htmlFor="local-language">
										Search language
										<Input
											required
											id="local-language"
											value={language}
											onChange={(e) => setLanguage(e.target.value)}
											pattern="[a-z]{2}(-[A-Z]{2})?"
											className={field}
										/>
									</label>
									<label>
										Grid
										<select value={size} onChange={(e) => setSize(Number(e.target.value))} className={field}>
											<option value={3}>3 × 3 · 9 points per query</option>
											<option value={5}>5 × 5 · 25 points per query</option>
										</select>
									</label>
								</div>
								<p>One report · $49 USD · 3 km radius · no recurring subscription.</p>
								<Button type="submit" disabled={busy || !selected} className="selena-primary-button min-h-11">
									Prepare order
								</Button>
							</form>
						)}
					</>
				)}
				{order && (
					<section className="space-y-4" aria-label="Saved order">
						<h2 className="selena-heading text-2xl">Order prepared</h2>
						<p role="status">Your order is saved. Payments will be available later. No measurement has started.</p>
						<p>
							{order.snapshot.restaurant.name} · ${order.snapshot.priceAmount} {order.snapshot.currency}
						</p>
						<p>
							{order.snapshot.queries.length} queries × {order.snapshot.gridSize ** 2} points ={" "}
							{order.snapshot.expectedObservations} planned checks · {order.snapshot.language}
						</p>
						<ul className="list-inside list-disc">
							{order.snapshot.queries.map((q) => (
								<li key={q}>{q}</li>
							))}
						</ul>
						<a href="/selena/local/checkout" className="selena-text-button inline-flex min-h-11 items-center">
							Prepare another order
						</a>
					</section>
				)}
				<section className="space-y-3">
					<h2 className="selena-heading text-2xl">Saved orders</h2>
					{!busy && !error && !orders.length && <p>No orders yet. Prepare one using the form above.</p>}
					<ul>
						{orders.map((o) => (
							<li key={o.id}>
								<a className="selena-text-button inline-flex min-h-11 items-center" href={`?order=${o.id}`}>
									{o.snapshot.restaurant.name} · {o.snapshot.queries.length} queries ·{" "}
									{new Date(o.createdAt).toLocaleDateString()} · Prepared
								</a>
							</li>
						))}
					</ul>
				</section>
				<section className="space-y-3">
					<h2 className="selena-heading text-2xl">Reports</h2>
					{!busy && !error && !reports.length && (
						<p>
							No reports have been assigned to this workspace. Preparing an order does not create measurement results.
						</p>
					)}
					<ul>
						{reports.map((r) => (
							<li key={r.id} className="flex flex-wrap gap-4">
								<a className="selena-text-button inline-flex min-h-11 items-center" href={`${base}/reports/${r.id}`}>
									{r.title}
								</a>
								<a
									className="selena-text-button inline-flex min-h-11 items-center"
									href={`${base}/reports/${r.id}?format=csv`}
								>
									Download CSV
								</a>
								<a
									className="selena-text-button inline-flex min-h-11 items-center"
									href={`${base}/reports/${r.id}?format=print`}
								>
									Print / save PDF
								</a>
							</li>
						))}
					</ul>
				</section>
			</div>
		</main>
	);
}
