// The audit rules in the customer's words, shared by every screen that
// renders a stored action plan — old plans saved before these texts existed
// get the human wording too, because mapping happens at display time.

type RuleLocale = "en" | "ru";

/**
 * Every audit rule in the customer's words: what it is and how to fix it.
 * The rule id stays visible as a small tag for traceability, never as the title.
 */
export const RULE_HELP: Record<string, { en: [string, string]; ru: [string, string] }> = {
	"WEB-001": {
		en: ["Give the page a title that names the brand and the offer", "Put who you are and what you offer into the <title> tag, e.g. “KORA Food Hall — food hall in Ubud”."],
		ru: ["Дайте странице заголовок с названием бренда и сутью предложения", "В теге <title> напишите, кто вы и что предлагаете: «KORA Food Hall — фуд-холл в Убуде». Это первое, что читают и поисковики, и AI."],
	},
	"WEB-002": {
		en: ["Write a short description of the offer", "A one-to-two sentence meta description: what the place is and who it is for."],
		ru: ["Напишите короткое описание предложения", "Мета-описание в 1–2 предложения: что это за место и для кого."],
	},
	"WEB-003": {
		en: ["State an explicit robots policy", "Add a meta robots tag or robots.txt entry so it is visible that reading is allowed on purpose."],
		ru: ["Пропишите явные правила для роботов", "Добавьте meta robots или запись в robots.txt — чтобы было видно, что чтение сайта разрешено сознательно."],
	},
	"WEB-004": {
		en: ["Declare the page's canonical address", "The canonical tag names the one true URL, so duplicates don't split your identity."],
		ru: ["Укажите каноническую ссылку страницы", "Тег canonical говорит, какой адрес считать основным, — дубли перестают путать системы."],
	},
	"WEB-005": {
		en: ["Declare language alternates where the site has them", "If EN and RU versions exist, link them with hreflang; if not, skip this."],
		ru: ["Разметьте языковые версии, если они есть", "Если есть EN- и RU-версии — свяжите их hreflang. Если версий нет, пункт можно пропустить."],
	},
	"WEB-006": {
		en: ["Organise the page with descriptive headings", "One H1 with the name, H2/H3 for sections — that is how machines read the structure."],
		ru: ["Организуйте страницу заголовками H1–H3", "Один H1 с названием, разделы — H2/H3: так AI понимает структуру страницы."],
	},
	"WEB-007": {
		en: ["Publish the offer as readable text, not only images", "What you sell, where and for how much — as text. Text inside pictures is not reliably read."],
		ru: ["Опубликуйте предложение читаемым текстом", "Что вы предлагаете, где и почём — текстом, не картинками: текст с картинок AI не считывает надёжно."],
	},
	"WEB-008": {
		en: ["Link the service, location and contact pages to each other", "Plain links between pages let crawlers find everything."],
		ru: ["Свяжите страницы услуг, локации и контактов ссылками", "Обычные ссылки со страницы на страницу — чтобы краулеры нашли всё."],
	},
	"WEB-009": {
		en: ["Describe the business in structured data", "JSON-LD with the organization, address and hours gives machines the same facts the page states. On its own it does not move AI answers."],
		ru: ["Опишите бизнес структурированной разметкой", "JSON-LD с типом заведения, адресом и часами даёт машинам те же факты, что видят люди. Сама по себе разметка ответы AI не двигает."],
	},
	"WEB-010": {
		en: ["Review the structured data already on the page", "If microdata exists, validate it; adding it from scratch is optional."],
		ru: ["Проверьте существующую микроразметку", "Если микроразметка уже есть — проверьте её валидность; добавлять с нуля не обязательно."],
	},
	"WEB-011": {
		en: ["Publish a clear way to get in touch", "Phone, address or a form — as visible text."],
		ru: ["Опубликуйте понятный способ связаться", "Телефон, адрес или форма — текстом, на видном месте."],
	},
	"WEB-012": {
		en: ["Describe the services, menu or booking in readable text", "A page with the menu/services and the area is exactly what answers cite."],
		ru: ["Опишите услуги, меню и локацию текстом", "Страница с меню/услугами и районом — ровно то, что цитируют в ответах."],
	},
	"WEB-013": {
		en: ["Describe the important images in alt text", "Alt text on the key photos: what is on them."],
		ru: ["Подпишите важные изображения", "Alt-текст к ключевым фото: что на них изображено."],
	},
	"WEB-014": {
		en: ["Serve a robots.txt that can be checked again later", "The file must open and stay stable."],
		ru: ["Держите robots.txt доступным", "Файл должен открываться и не меняться незаметно."],
	},
	"WEB-015": {
		en: ["Link the Google Maps listing from the site", "Your place's share link ties the site to the Maps card."],
		ru: ["Поставьте на сайт ссылку на вашу точку в Google Maps", "Ссылка «Поделиться» вашей точки связывает сайт с карточкой на Картах."],
	},
	"WEB-016": {
		en: ["Put the business address in structured data", "An address field in JSON-LD makes the location machine-readable."],
		ru: ["Добавьте адрес в структурированную разметку", "Поле address в JSON-LD — чтобы локация читалась машинами."],
	},
	"WEB-017": {
		en: ["Use the exact Google Maps listing name on the site", "The name on the site and on Maps should match letter for letter."],
		ru: ["Используйте на сайте точное название из Google Maps", "Название на сайте и в Картах должно совпадать буква в букву."],
	},
	"WEB-018": {
		en: ["Let the answer engines' crawlers read the site", "Check robots.txt: ChatGPT/Perplexity/Google AI search bots must not be blocked if you want to appear in answers."],
		ru: ["Разрешите краулерам AI-поисковиков читать сайт", "Проверьте robots.txt: боты ChatGPT, Perplexity и Google AI не должны быть запрещены, если вы хотите попадать в ответы."],
	},
	"WEB-019": {
		en: ["Let assistants open the site when a customer asks", "Do not block user-fetch bots — that is a customer telling an assistant “open their site”."],
		ru: ["Разрешите ассистентам открывать сайт по просьбе клиента", "Не блокируйте user-fetch ботов: это клиент просит ассистента «открой их сайт»."],
	},
	"WEB-020": {
		en: ["Stop the page asking engines to ignore or not quote it", "noindex/nosnippet tell systems to skip the page — remove them unless that is deliberate."],
		ru: ["Уберите запреты на показ и цитирование", "noindex/nosnippet просят системы игнорировать страницу — снимите, если это не сознательное решение."],
	},
	"WEB-021": {
		en: ["Confirm that excluding the site from model training is deliberate", "A training opt-out is a valid choice, but it shapes what models know about you."],
		ru: ["Подтвердите, что запрет на обучение моделей — осознанный", "Запрет на использование в обучении — допустимый выбор, но он влияет на то, что модели о вас «знают»."],
	},
};

export const PRIORITY_LABELS: Record<string, [string, string]> = {
	NOW: ["Now", "Сейчас"],
	NEXT: ["Next", "Дальше"],
	LATER: ["Later", "Позже"],
};

export function ruleTitle(locale: RuleLocale, ruleId: string, fallback: string): string {
	const help = RULE_HELP[ruleId];
	return help ? (locale === "ru" ? help.ru[0] : help.en[0]) : fallback;
}

export function ruleHow(locale: RuleLocale, ruleId: string, fallback: string): string {
	const help = RULE_HELP[ruleId];
	return help ? (locale === "ru" ? help.ru[1] : help.en[1]) : fallback;
}

