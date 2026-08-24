/**
 * /app/selena-order - the customer asks for a paid measurement plan.
 *
 * There is no online checkout yet, so this page collects a request — project,
 * plan, contact — and a promo code stands in for payment: a valid code (env
 * SELENA_PROMO_CODES) makes the request free of charge. The operator sees
 * every request on the admin desk and builds the actual order there; nothing
 * on this page touches quotes, orders or the queue.
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import { Button } from "@workspace/ui/components/button";
import { Input } from "@workspace/ui/components/input";
import { Label } from "@workspace/ui/components/label";
import { Textarea } from "@workspace/ui/components/textarea";
import { useEffect, useState } from "react";
import { z } from "zod";
import { humanizeSelenaError } from "@/lib/selena-workspace-errors";
import { createSelenaOrderRequestFn } from "@/server/selena-order-requests";
import { getSelenaWorkspaceFn } from "../../../server/selena-client";

export const Route = createFileRoute("/_authed/app/selena-order")({
	validateSearch: z.object({
		plan: z.enum(["snapshot", "landscape"]).optional(),
		project: z.string().uuid().optional(),
	}),
	loader: () => getSelenaWorkspaceFn(),
	component: SelenaOrderPage,
});

type OrderLocale = "en" | "ru";

const PLAN_OPTIONS = [
	{
		search: "snapshot" as const,
		planId: "visitor-local" as const,
		title: "Visitor View · Snapshot",
		price: "$49",
		systems: "ChatGPT · Gemini · Perplexity",
		en: "What customers see in live AI answer surfaces.",
		ru: "Что клиенты видят в пользовательских AI-сервисах.",
	},
	{
		search: "landscape" as const,
		planId: "full-ai-landscape" as const,
		title: "Visitor + API View · Landscape",
		price: "$79",
		systems: "ChatGPT · Gemini · Perplexity · Claude · DeepSeek · Qwen · Mistral · Grok",
		en: "The visitor check plus a model-knowledge baseline.",
		ru: "Проверка глазами посетителя плюс базовая проверка знаний моделей.",
	},
];

function tr(locale: OrderLocale, english: string, russian: string): string {
	return locale === "ru" ? russian : english;
}

function SelenaOrderPage() {
	const { projects } = Route.useLoaderData();
	const search = Route.useSearch();
	const [locale, setLocale] = useState<OrderLocale>("en");
	const [projectId, setProjectId] = useState(search.project ?? projects[0]?.project.id ?? "");
	const [planSearch, setPlanSearch] = useState<"snapshot" | "landscape">(search.plan ?? "snapshot");
	const [contactName, setContactName] = useState("");
	const [contactChannel, setContactChannel] = useState("");
	const [comment, setComment] = useState("");
	const [promoCode, setPromoCode] = useState("");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState("");
	const [result, setResult] = useState<{ promoApplied: boolean } | null>(null);

	useEffect(() => {
		const saved = window.localStorage.getItem("selena-workspace-locale");
		setLocale(saved === "ru" || saved === "en" ? saved : navigator.language.startsWith("ru") ? "ru" : "en");
	}, []);

	const plan = PLAN_OPTIONS.find((option) => option.search === planSearch) ?? PLAN_OPTIONS[0];

	const submit = async (event: React.FormEvent) => {
		event.preventDefault();
		setPending(true);
		setError("");
		try {
			const created = await createSelenaOrderRequestFn({
				data: {
					projectId,
					planId: plan.planId,
					contactName,
					contactChannel,
					comment: comment.trim() ? comment.trim() : undefined,
					promoCode: promoCode.trim() ? promoCode.trim() : undefined,
				},
			});
			setResult({ promoApplied: created.promoApplied });
		} catch (cause) {
			setError(
				humanizeSelenaError(
					cause,
					locale,
					tr(
						locale,
						"We could not send the request. Check the fields and try again.",
						"Не удалось отправить заявку. Проверьте поля и попробуйте ещё раз.",
					),
				),
			);
		} finally {
			setPending(false);
		}
	};

	if (result) {
		return (
			<main className="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-12">
				<section className="selena-section">
					<h1 className="selena-heading text-3xl">{tr(locale, "Request received", "Заявка принята")}</h1>
					{result.promoApplied ? (
						<p className="mt-4 text-sm leading-6 text-[#3d362e]">
							{tr(
								locale,
								"Your promo code was accepted — this measurement is free of charge, no payment needed. We will prepare the questions and start the measurement; the results will appear in your cabinet, in the Measurement section.",
								"Промокод принят — этот замер для вас бесплатный, оплата не требуется. Мы подготовим вопросы и запустим замер; результаты появятся в вашем кабинете в разделе «Замер».",
							)}
						</p>
					) : (
						<p className="mt-4 text-sm leading-6 text-[#3d362e]">
							{tr(
								locale,
								"Online payment is not available yet, so we will contact you at the address you left to arrange the payment and start the measurement.",
								"Онлайн-оплаты пока нет, поэтому мы свяжемся с вами по указанному контакту, чтобы договориться об оплате и запустить замер.",
							)}
						</p>
					)}
					<div className="mt-6">
						<Link to="/app/selena" className="text-sm underline">
							{tr(locale, "Back to the cabinet", "Вернуться в кабинет")}
						</Link>
					</div>
				</section>
			</main>
		);
	}

	return (
		<main className="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-12">
			<section className="selena-section">
				<h1 className="selena-heading text-3xl">{tr(locale, "Order an AI measurement", "Заказ AI-замера")}</h1>
				<p className="mt-2 text-sm leading-6 text-[#6e6258]">
					{tr(
						locale,
						"Choose a plan and leave a contact. A measurement starts only after the questions are approved — nothing runs from this form by itself.",
						"Выберите тариф и оставьте контакт. Замер запускается только после утверждения вопросов — сама по себе эта форма ничего не запускает.",
					)}
				</p>

				<form onSubmit={submit} className="mt-6 flex flex-col gap-5">
					<div className="space-y-2">
						<Label htmlFor="order-project">{tr(locale, "Project", "Проект")}</Label>
						<select
							id="order-project"
							className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
							value={projectId}
							onChange={(event) => setProjectId(event.target.value)}
							required
						>
							{projects.map((item) => (
								<option key={item.project.id} value={item.project.id}>
									{item.project.name}
								</option>
							))}
						</select>
					</div>

					<fieldset className="space-y-3">
						<legend className="text-sm font-medium">{tr(locale, "Plan", "Тариф")}</legend>
						{PLAN_OPTIONS.map((option) => (
							<label
								key={option.search}
								className={`flex cursor-pointer flex-col gap-1 rounded-lg border p-4 ${
									option.search === planSearch ? "border-[#3d362e] bg-[#fffdf8]" : "border-[#e5dbcd]"
								}`}
							>
								<span className="flex items-center justify-between gap-3">
									<span className="flex items-center gap-3">
										<input
											type="radio"
											name="plan"
											value={option.search}
											checked={option.search === planSearch}
											onChange={() => setPlanSearch(option.search)}
										/>
										<span className="font-medium">{option.title}</span>
									</span>
									<span className="font-semibold">
										{option.price}
										{tr(locale, "/mo", "/мес")}
									</span>
								</span>
								<span className="text-xs uppercase tracking-wide text-[#6e6258]">{option.systems}</span>
								<span className="text-sm text-[#6e6258]">{tr(locale, option.en, option.ru)}</span>
							</label>
						))}
					</fieldset>

					<div className="grid gap-4 sm:grid-cols-2">
						<div className="space-y-2">
							<Label htmlFor="order-name">{tr(locale, "Your name", "Ваше имя")}</Label>
							<Input
								id="order-name"
								value={contactName}
								onChange={(event) => setContactName(event.target.value)}
								required
								maxLength={200}
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="order-contact">{tr(locale, "How to reach you", "Как с вами связаться")}</Label>
							<Input
								id="order-contact"
								value={contactChannel}
								onChange={(event) => setContactChannel(event.target.value)}
								placeholder={tr(locale, "WhatsApp, Telegram or email", "WhatsApp, Telegram или email")}
								required
								maxLength={300}
							/>
						</div>
					</div>

					<div className="space-y-2">
						<Label htmlFor="order-comment">{tr(locale, "Comment (optional)", "Комментарий (необязательно)")}</Label>
						<Textarea
							id="order-comment"
							value={comment}
							onChange={(event) => setComment(event.target.value)}
							rows={3}
							maxLength={2000}
						/>
					</div>

					<div className="space-y-2">
						<Label htmlFor="order-promo">{tr(locale, "Promo code (optional)", "Промокод (необязательно)")}</Label>
						<Input
							id="order-promo"
							value={promoCode}
							onChange={(event) => setPromoCode(event.target.value)}
							maxLength={100}
						/>
						<p className="text-xs text-[#6e6258]">
							{tr(
								locale,
								"A valid promo code makes this measurement free of charge.",
								"Действующий промокод делает этот замер бесплатным.",
							)}
						</p>
					</div>

					{error && <p className="text-sm text-[#9a5f14]">{error}</p>}

					<div className="flex flex-wrap items-center gap-4">
						<Button type="submit" className="selena-primary-button min-h-11" disabled={pending || !projectId}>
							{pending ? tr(locale, "Sending…", "Отправляем…") : tr(locale, "Send the request", "Отправить заявку")}
						</Button>
						<Link to="/app/selena" className="text-sm underline">
							{tr(locale, "Back to the cabinet", "Вернуться в кабинет")}
						</Link>
					</div>
				</form>
			</section>
		</main>
	);
}
