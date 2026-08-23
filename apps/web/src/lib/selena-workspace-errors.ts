/**
 * Turns the errors the Selena client workspace can surface into something a
 * business owner can act on.
 *
 * Two sources reach the client verbatim and neither is readable: the profile
 * validator serialises its issues as a JSON array, and the website collector
 * throws machine codes (`WEBSITE_DNS_FAILED`, `WEBSITE_HTTP_404`, ...). Both
 * are shown to restaurant owners during a demo, so they get named fields and
 * a next step instead.
 */

export type WorkspaceLocale = "en" | "ru";

type ZodIssue = { code?: string; format?: string; path?: unknown[]; message?: string };

const FIELD_LABELS: Record<string, [string, string]> = {
	brandName: ["Public brand name", "Публичное название бренда"],
	primaryDomain: ["Primary website", "Основной сайт"],
	publicProfiles: ["Public profile links", "Ссылки на публичные профили"],
	competitorSnapshot: ["Competitors", "Конкуренты"],
	scenarioSnapshot: ["Customer questions", "Вопросы клиентов"],
	name: ["Project name", "Название проекта"],
	category: ["Business category", "Категория бизнеса"],
	country: ["Country code", "Код страны"],
	region: ["City or region", "Город или регион"],
	languages: ["Languages", "Языки"],
};

const SUGGEST_MESSAGES: Record<string, [string, string]> = {
	SUGGEST_LLM_NOT_BUDGETED: [
		"Automatic suggestions are switched off here. Add the questions by hand — one per line.",
		"Автоподбор здесь выключен. Добавьте вопросы вручную — по одному в строке.",
	],
	SUGGEST_BUDGET_EXHAUSTED: [
		"This month's suggestion budget is used up. Add the questions by hand, or try again next month.",
		"Месячный лимит автоподбора исчерпан. Добавьте вопросы вручную или попробуйте в следующем месяце.",
	],
};

const WEBSITE_MESSAGES: Record<string, [string, string]> = {
	WEBSITE_DNS_FAILED: [
		"We could not find a site at this address. Check the spelling of the primary website.",
		"По этому адресу сайт не найден. Проверьте написание основного сайта.",
	],
	WEBSITE_PRIVATE_OR_INVALID_URL: [
		"This address is not a public website, so it cannot be reviewed. Use the public address customers open.",
		"Это не публичный адрес, проверить его нельзя. Укажите адрес, который открывают клиенты.",
	],
	WEBSITE_MIME_NOT_ALLOWED: [
		"This address does not return a web page. Point it at the public homepage.",
		"По этому адресу возвращается не веб-страница. Укажите публичную главную страницу.",
	],
	WEBSITE_RESPONSE_TOO_LARGE: [
		"The page is too large to review. Try the homepage instead of a heavy landing page.",
		"Страница слишком большая для проверки. Попробуйте главную вместо тяжёлого лендинга.",
	],
	WEBSITE_REDIRECT_LIMIT: [
		"The address redirects too many times. Enter the final address the browser lands on.",
		"Адрес слишком много раз перенаправляет. Укажите конечный адрес, на котором открывается сайт.",
	],
	WEBSITE_REDIRECT_LOOP: [
		"The address redirects in a loop. Enter the final address the browser lands on.",
		"Адрес перенаправляет по кругу. Укажите конечный адрес, на котором открывается сайт.",
	],
	WEBSITE_CRAWL_POLICY_INVALID: [
		"The review settings are invalid. Please contact Selena Systems.",
		"Настройки проверки некорректны. Свяжитесь с Selena Systems.",
	],
};

function tr(locale: WorkspaceLocale, pair: [string, string]): string {
	return locale === "ru" ? pair[1] : pair[0];
}

function fieldLabel(locale: WorkspaceLocale, path: unknown[] | undefined): string {
	const head = typeof path?.[0] === "string" ? (path[0] as string) : "";
	const label = FIELD_LABELS[head];
	return label ? tr(locale, label) : "";
}

function issueHint(locale: WorkspaceLocale, issue: ZodIssue): string {
	if (issue.format === "url") {
		return tr(locale, [
			"enter the full address, for example https://example.com",
			"укажите полный адрес, например https://example.com",
		]);
	}
	if (issue.code === "too_small" || issue.code === "invalid_type") {
		return tr(locale, ["please fill this in", "заполните это поле"]);
	}
	if (issue.code === "too_big") {
		return tr(locale, ["there are too many values here", "здесь слишком много значений"]);
	}
	return tr(locale, ["please check this value", "проверьте это значение"]);
}

/** Line number is what the customer-questions box is edited by, so name it. */
function issueLocation(locale: WorkspaceLocale, path: unknown[] | undefined): string {
	const index = path?.[1];
	if (typeof index !== "number") return "";
	const head = path?.[0];
	if (head === "scenarioSnapshot") {
		return tr(locale, [` (line ${index + 1})`, ` (строка ${index + 1})`]);
	}
	return tr(locale, [` (entry ${index + 1})`, ` (значение ${index + 1})`]);
}

function parseIssues(message: string): ZodIssue[] | null {
	const trimmed = message.trim();
	if (!trimmed.startsWith("[")) return null;
	try {
		const parsed = JSON.parse(trimmed);
		return Array.isArray(parsed) && parsed.length > 0 ? (parsed as ZodIssue[]) : null;
	} catch {
		return null;
	}
}

/**
 * `fallback` is what to say when the cause carries nothing recognisable —
 * each caller phrases it for the action the customer just took.
 */
export function humanizeSelenaError(cause: unknown, locale: WorkspaceLocale, fallback: string): string {
	const raw = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
	if (!raw.trim()) return fallback;

	const issues = parseIssues(raw);
	if (issues) {
		return issues
			.slice(0, 3)
			.map((issue) => {
				const label = fieldLabel(locale, issue.path);
				const location = issueLocation(locale, issue.path);
				const hint = issueHint(locale, issue);
				return label ? `«${label}»${location}: ${hint}` : hint;
			})
			.join(" ");
	}

	const suggest = SUGGEST_MESSAGES[raw];
	if (suggest) return tr(locale, suggest);

	const website = WEBSITE_MESSAGES[raw];
	if (website) return tr(locale, website);

	const httpStatus = raw.match(/^WEBSITE_HTTP_(\d{3})$/)?.[1];
	if (httpStatus) {
		return locale === "ru"
			? `Сайт ответил кодом ${httpStatus}. Откройте адрес в браузере и проверьте, что страница доступна всем.`
			: `The site answered with status ${httpStatus}. Open the address in a browser and check the page is publicly available.`;
	}

	const name = cause instanceof Error ? cause.name : "";
	if (name === "TimeoutError" || /timeout|aborted/i.test(raw)) {
		return tr(locale, [
			"The site took too long to answer. Try the review again in a minute.",
			"Сайт слишком долго не отвечал. Попробуйте проверку ещё раз через минуту.",
		]);
	}
	if (/fetch failed|network|ENOTFOUND|ECONNREFUSED/i.test(raw)) {
		return tr(locale, [
			"We could not reach the site. Check the address and that it opens in a browser.",
			"Не удалось связаться с сайтом. Проверьте адрес и что он открывается в браузере.",
		]);
	}

	return raw;
}
